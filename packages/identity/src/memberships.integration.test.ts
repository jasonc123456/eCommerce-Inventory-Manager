import { authorize } from '@eim/authz';
import { createHasher } from '@eim/crypto';
import { businesses, invitations, locations, memberships, permissionGrants, users } from '@eim/db';
import { createTestDatabase, refuses, type TestDatabase } from '@eim/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMembershipService, domainAllowed } from './memberships';

/**
 * Membership, invitations, and grants against a real database.
 *
 * The cross-business assertions here are the ones the M1 exit gate turns on:
 * every one of them is a case where an authorization bug in the application
 * would be caught by the schema, or where the schema alone is not enough and the
 * service has to get it right.
 */

let harness: TestDatabase;
const service = createMembershipService(createHasher('m'.repeat(48)));

beforeAll(async () => {
  harness = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await harness.drop();
});

let sequence = 0;

async function createUser(email?: string): Promise<string> {
  sequence += 1;
  const [user] = await harness.db
    .insert(users)
    .values({ email: email ?? `member-${String(sequence)}@example.invalid` })
    .returning({ id: users.id });

  return user!.id;
}

async function createBusiness(options: { allowedEmailDomains?: string[] } = {}): Promise<{
  businessId: string;
  ownerId: string;
}> {
  sequence += 1;
  const ownerId = await createUser();

  const [business] = await harness.db
    .insert(businesses)
    .values({
      name: `Business ${String(sequence)}`,
      slug: `member-${String(sequence)}`,
      allowedEmailDomains: options.allowedEmailDomains ?? [],
    })
    .returning({ id: businesses.id });

  await harness.db
    .insert(memberships)
    .values({ businessId: business!.id, userId: ownerId, role: 'owner' });

  return { businessId: business!.id, ownerId };
}

async function inviteAndAccept(
  businessId: string,
  email: string,
  role: 'manager' | 'operator' | 'viewer' = 'operator',
): Promise<{ userId: string; membershipId: string }> {
  const invited = await service.invite(harness.db, { businessId, email, role });

  if (invited.outcome !== 'invited') {
    throw new Error(`expected an invitation, got ${invited.outcome}`);
  }

  const accepted = await service.acceptInvitation(harness.db, invited.token);

  if (accepted.outcome !== 'accepted') {
    throw new Error(`expected acceptance, got ${accepted.outcome}`);
  }

  return { userId: accepted.userId, membershipId: accepted.membershipId };
}

describe('domainAllowed', () => {
  it('permits anything when no restriction is configured', () => {
    // Empty must stay distinguishable from "restricted to nothing", or a
    // business that configured no domains could invite nobody.
    expect(domainAllowed('a@example.invalid', [])).toBe(true);
  });

  it('permits only the listed domains, case-insensitively', () => {
    expect(domainAllowed('a@acme.invalid', ['Acme.Invalid'])).toBe(true);
    expect(domainAllowed('a@other.invalid', ['acme.invalid'])).toBe(false);
  });

  it('does not treat a subdomain as the domain', () => {
    expect(domainAllowed('a@evil.acme.invalid', ['acme.invalid'])).toBe(false);
  });
});

describe('inviting', () => {
  it('issues a single-use token and stores only its hash', async () => {
    const { businessId, ownerId } = await createBusiness();

    const result = await service.invite(harness.db, {
      businessId,
      email: 'Newcomer@Example.Invalid',
      role: 'viewer',
      invitedByUserId: ownerId,
    });

    expect(result.outcome).toBe('invited');

    const [row] = await harness.db
      .select()
      .from(invitations)
      .where(eq(invitations.businessId, businessId));

    expect(row!.email).toBe('newcomer@example.invalid');
    expect(row!.tokenHash).not.toBe(result.outcome === 'invited' && result.token);
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBe(72 * 60 * 60_000);
  });

  it('refuses an address outside the approved domains', async () => {
    const { businessId } = await createBusiness({ allowedEmailDomains: ['acme.invalid'] });

    expect(
      await service.invite(harness.db, {
        businessId,
        email: 'outsider@example.invalid',
        role: 'viewer',
      }),
    ).toEqual({ outcome: 'domain_not_allowed' });
  });

  it('refuses somebody who is already a member', async () => {
    const { businessId } = await createBusiness();
    await inviteAndAccept(businessId, 'existing@example.invalid');

    expect(
      await service.invite(harness.db, {
        businessId,
        email: 'existing@example.invalid',
        role: 'viewer',
      }),
    ).toEqual({ outcome: 'already_a_member' });
  });

  it('refuses a second outstanding invitation rather than raising', async () => {
    // Two owners inviting the same person at once is a real case, and the
    // second one losing is the correct outcome, not an error page.
    const { businessId } = await createBusiness();

    await service.invite(harness.db, {
      businessId,
      email: 'twice@example.invalid',
      role: 'viewer',
    });

    expect(
      await service.invite(harness.db, {
        businessId,
        email: 'twice@example.invalid',
        role: 'viewer',
      }),
    ).toEqual({ outcome: 'already_invited' });
  });

  it('lets two businesses invite the same person independently', async () => {
    const first = await createBusiness();
    const second = await createBusiness();

    const a = await service.invite(harness.db, {
      businessId: first.businessId,
      email: 'shared@example.invalid',
      role: 'viewer',
    });
    const b = await service.invite(harness.db, {
      businessId: second.businessId,
      email: 'shared@example.invalid',
      role: 'viewer',
    });

    expect(a.outcome).toBe('invited');
    expect(b.outcome).toBe('invited');
  });
});

describe('accepting', () => {
  it('creates the account, the membership, and the proposed grants', async () => {
    const { businessId } = await createBusiness();
    const { membershipId, userId } = await inviteAndAccept(
      businessId,
      'accepted@example.invalid',
      'operator',
    );

    const grants = await harness.db
      .select()
      .from(permissionGrants)
      .where(eq(permissionGrants.membershipId, membershipId));

    expect(grants.length).toBeGreaterThan(0);
    expect(grants.map((row) => row.permission)).toContain('adjust_inventory');
    // Operator does not approve mappings by default.
    expect(grants.map((row) => row.permission)).not.toContain('approve_mappings');

    const subject = await service.loadSubject(harness.db, businessId, userId);
    expect(subject).not.toBeNull();
    expect(authorize(subject!, 'adjust_inventory').allowed).toBe(true);
    expect(authorize(subject!, 'approve_mappings').allowed).toBe(false);
  });

  it('reuses an existing account rather than creating a second', async () => {
    const existingId = await createUser('returning@example.invalid');
    const { businessId } = await createBusiness();

    const accepted = await inviteAndAccept(businessId, 'returning@example.invalid');

    expect(accepted.userId).toBe(existingId);
  });

  it('refuses a signed-in user who is not the addressee', async () => {
    // Forwarded mail is ordinary, so this is not hypothetical.
    const { businessId } = await createBusiness();
    const invited = await service.invite(harness.db, {
      businessId,
      email: 'intended@example.invalid',
      role: 'viewer',
    });

    const someoneElse = await createUser();

    expect(
      await service.acceptInvitation(
        harness.db,
        invited.outcome === 'invited' ? invited.token : '',
        {
          userId: someoneElse,
        },
      ),
    ).toEqual({ outcome: 'wrong_recipient' });
  });

  it('refuses an expired, cancelled, or already-accepted invitation alike', async () => {
    const { businessId, ownerId } = await createBusiness();

    const expired = await service.invite(harness.db, {
      businessId,
      email: 'expired@example.invalid',
      role: 'viewer',
    });
    const cancelled = await service.invite(harness.db, {
      businessId,
      email: 'cancelled@example.invalid',
      role: 'viewer',
    });

    if (expired.outcome !== 'invited' || cancelled.outcome !== 'invited') {
      throw new Error('expected invitations');
    }

    await service.cancelInvitation(harness.db, cancelled.invitationId, ownerId);

    const later = new Date(Date.now() + 73 * 60 * 60_000);

    expect(await service.acceptInvitation(harness.db, expired.token, { now: later })).toEqual({
      outcome: 'invalid',
    });
    expect(await service.acceptInvitation(harness.db, cancelled.token)).toEqual({
      outcome: 'invalid',
    });
    expect(await service.acceptInvitation(harness.db, 'forged')).toEqual({ outcome: 'invalid' });
  });

  it('lets only one of two simultaneous acceptances create a membership', async () => {
    const { businessId } = await createBusiness();
    const invited = await service.invite(harness.db, {
      businessId,
      email: 'race@example.invalid',
      role: 'viewer',
    });

    if (invited.outcome !== 'invited') {
      throw new Error('expected an invitation');
    }

    const results = await Promise.allSettled([
      service.acceptInvitation(harness.db, invited.token),
      service.acceptInvitation(harness.db, invited.token),
    ]);

    const accepted = results.filter(
      (result) => result.status === 'fulfilled' && result.value.outcome === 'accepted',
    );

    expect(accepted).toHaveLength(1);
  });
});

describe('grants', () => {
  it('gives an owner everything without holding a single grant row', async () => {
    // Section 5 gives owners every permission implicitly, so materializing them
    // would create a second source of truth that a bug could delete from.
    const { businessId, ownerId } = await createBusiness();

    const subject = await service.loadSubject(harness.db, businessId, ownerId);

    expect(subject).toMatchObject({ isOwner: true, grants: [] });
    expect(authorize(subject!, 'delete_business').allowed).toBe(true);
    expect(authorize(subject!, 'manage_members').reason).toBe('owner');
  });

  it('narrows a permission to named locations', async () => {
    const { businessId } = await createBusiness();
    const { membershipId, userId } = await inviteAndAccept(businessId, 'scoped@example.invalid');

    const [warehouse] = await harness.db
      .insert(locations)
      .values({ businessId, code: 'WH1', name: 'Warehouse one' })
      .returning({ id: locations.id });
    const [shop] = await harness.db
      .insert(locations)
      .values({ businessId, code: 'SH1', name: 'Shop one' })
      .returning({ id: locations.id });

    await service.setGrants(harness.db, businessId, membershipId, [
      { permission: 'view_orders', scope: { kind: 'locations', locationIds: [warehouse!.id] } },
    ]);

    const subject = await service.loadSubject(harness.db, businessId, userId);

    expect(authorize(subject!, 'view_orders', { locationIds: [warehouse!.id] }).allowed).toBe(true);
    expect(authorize(subject!, 'view_orders', { locationIds: [shop!.id] }).allowed).toBe(false);
    // An order spanning a location the holder cannot see is not partly visible.
    expect(
      authorize(subject!, 'view_orders', { locationIds: [warehouse!.id, shop!.id] }).allowed,
    ).toBe(false);
  });

  it('replaces the whole set rather than adding to it', async () => {
    const { businessId } = await createBusiness();
    const { membershipId, userId } = await inviteAndAccept(businessId, 'replaced@example.invalid');

    await service.setGrants(harness.db, businessId, membershipId, [
      { permission: 'view_inventory' },
    ]);

    const subject = await service.loadSubject(harness.db, businessId, userId);

    expect(authorize(subject!, 'view_inventory').allowed).toBe(true);
    expect(authorize(subject!, 'adjust_inventory').allowed).toBe(false);
  });

  it('re-applies the template when the role changes', async () => {
    const { businessId } = await createBusiness();
    const { membershipId, userId } = await inviteAndAccept(
      businessId,
      'promoted@example.invalid',
      'viewer',
    );

    expect(
      authorize((await service.loadSubject(harness.db, businessId, userId))!, 'approve_mappings')
        .allowed,
    ).toBe(false);

    await service.changeRole(harness.db, businessId, membershipId, 'manager');

    expect(
      authorize((await service.loadSubject(harness.db, businessId, userId))!, 'approve_mappings')
        .allowed,
    ).toBe(true);
  });

  it('cannot be given a location in another business', async () => {
    // The composite foreign key, which holds whatever the application believes.
    const mine = await createBusiness();
    const theirs = await createBusiness();
    const { membershipId } = await inviteAndAccept(mine.businessId, 'cross@example.invalid');

    const [foreign] = await harness.db
      .insert(locations)
      .values({ businessId: theirs.businessId, code: 'FGN', name: 'Theirs' })
      .returning({ id: locations.id });

    const reason = await refuses(() =>
      service.setGrants(harness.db, mine.businessId, membershipId, [
        { permission: 'view_orders', scope: { kind: 'locations', locationIds: [foreign!.id] } },
      ]),
    );

    expect(reason).toMatch(/permission_grant_locations_location_fkey/);
  });
});

describe('cross-business isolation', () => {
  it('gives a member of one business no subject in another', async () => {
    const mine = await createBusiness();
    const theirs = await createBusiness();
    const { userId } = await inviteAndAccept(mine.businessId, 'isolated@example.invalid');

    expect(await service.loadSubject(harness.db, mine.businessId, userId)).not.toBeNull();
    expect(await service.loadSubject(harness.db, theirs.businessId, userId)).toBeNull();
  });

  it('does not carry a grant across for the same person in two businesses', async () => {
    const managerHere = await createBusiness();
    const viewerThere = await createBusiness();

    const first = await inviteAndAccept(managerHere.businessId, 'two@example.invalid', 'manager');
    await inviteAndAccept(viewerThere.businessId, 'two@example.invalid', 'viewer');

    const here = await service.loadSubject(harness.db, managerHere.businessId, first.userId);
    const there = await service.loadSubject(harness.db, viewerThere.businessId, first.userId);

    expect(authorize(here!, 'approve_mappings').allowed).toBe(true);
    expect(authorize(there!, 'approve_mappings').allowed).toBe(false);
  });

  it('lists only the businesses the user actually belongs to', async () => {
    const mine = await createBusiness();
    await createBusiness();
    const { userId } = await inviteAndAccept(mine.businessId, 'listed@example.invalid');

    const listed = await service.listBusinessesFor(harness.db, userId);

    expect(listed.map((row) => row.businessId)).toEqual([mine.businessId]);
  });
});

describe('suspension and removal', () => {
  it('withdraws authorization immediately without touching other businesses', async () => {
    const suspended = await createBusiness();
    const other = await createBusiness();
    const here = await inviteAndAccept(suspended.businessId, 'sus@example.invalid');
    await inviteAndAccept(other.businessId, 'sus@example.invalid');

    await service.suspend(harness.db, here.membershipId);

    expect(await service.loadSubject(harness.db, suspended.businessId, here.userId)).toBeNull();
    expect(await service.loadSubject(harness.db, other.businessId, here.userId)).not.toBeNull();
  });

  it('restores it on reinstatement', async () => {
    const { businessId } = await createBusiness();
    const { membershipId, userId } = await inviteAndAccept(businessId, 'back@example.invalid');

    await service.suspend(harness.db, membershipId);
    await service.reinstate(harness.db, membershipId);

    expect(await service.loadSubject(harness.db, businessId, userId)).not.toBeNull();
  });

  it('takes the grants with the membership', async () => {
    const { businessId } = await createBusiness();
    const { membershipId, userId } = await inviteAndAccept(businessId, 'gone@example.invalid');

    await service.remove(harness.db, membershipId);

    expect(
      await harness.db
        .select()
        .from(permissionGrants)
        .where(eq(permissionGrants.membershipId, membershipId)),
    ).toHaveLength(0);
    expect(await service.loadSubject(harness.db, businessId, userId)).toBeNull();
  });

  it('refuses to remove the final owner', async () => {
    const { businessId, ownerId } = await createBusiness();

    const [membership] = await harness.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.businessId, businessId), eq(memberships.userId, ownerId)));

    const reason = await refuses(() => service.remove(harness.db, membership!.id));

    expect(reason).toMatch(/must retain at least one owner/);
  });

  it('permits an ownership handover inside one transaction', async () => {
    const { businessId, ownerId } = await createBusiness();
    const successor = await inviteAndAccept(businessId, 'successor@example.invalid');

    const [outgoing] = await harness.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.businessId, businessId), eq(memberships.userId, ownerId)));

    await expect(
      harness.db.transaction(async (tx) => {
        await tx
          .update(memberships)
          .set({ role: 'owner' })
          .where(eq(memberships.id, successor.membershipId));
        await tx.delete(memberships).where(eq(memberships.id, outgoing!.id));
      }),
    ).resolves.toBeUndefined();

    const subject = await service.loadSubject(harness.db, businessId, successor.userId);
    expect(subject?.isOwner).toBe(true);
  });
});
