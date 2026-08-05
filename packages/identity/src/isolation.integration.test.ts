import { authorize } from '@eim/authz';
import { readBusinessAuditEvents, readInstallationAuditEvents, recordAuditEvent } from '@eim/audit';
import { createHasher } from '@eim/crypto';
import {
  businesses,
  canonicalItems,
  locations,
  memberships,
  permissionGrantLocations,
  permissionGrants,
  users,
} from '@eim/db';
import { createTestDatabase, refuses, type TestDatabase } from '@eim/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMembershipService } from './memberships';
import { createSessionService } from './sessions';

/**
 * The cross-business isolation suite (section 36).
 *
 * The other half of M1's exit gate, and the one invariant this whole milestone
 * exists to establish: "Access to one business never grants access to another"
 * (section 5).
 *
 * The suite is organised by the layer that would have to fail for isolation to
 * break, because they fail independently and each needs its own proof:
 *
 *   the schema        composite foreign keys that make the wrong row unwritable
 *   the services      queries scoped so the wrong row is never returned
 *   authorization     a subject that carries no authority outside its business
 *   the audit trail   one tenant's history never visible to another
 *
 * Every test here is written from the attacker's side: a real identifier from
 * one business presented to an operation in another. That is the shape the bug
 * takes when it happens, and asserting "the right answer for the right inputs"
 * would not catch a single one of them.
 */

let harness: TestDatabase;
const membershipService = createMembershipService(createHasher('i'.repeat(48)));
const sessions = createSessionService(createHasher('i'.repeat(48)));

beforeAll(async () => {
  harness = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await harness.drop();
});

let sequence = 0;

interface Tenant {
  readonly businessId: string;
  readonly ownerId: string;
  readonly memberId: string;
  readonly membershipId: string;
  readonly locationId: string;
  readonly itemId: string;
}

/**
 * A complete, self-contained business.
 *
 * Two of these are set up for most tests, and the assertions are always about
 * one reaching into the other.
 */
async function tenant(label: string): Promise<Tenant> {
  sequence += 1;
  const suffix = `${label}-${String(sequence)}`;

  const [owner] = await harness.db
    .insert(users)
    .values({ email: `owner-${suffix}@example.invalid` })
    .returning({ id: users.id });

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: `Business ${suffix}`, slug: `iso-${suffix}` })
    .returning({ id: businesses.id });

  await harness.db
    .insert(memberships)
    .values({ businessId: business!.id, userId: owner!.id, role: 'owner' });

  const invited = await membershipService.invite(harness.db, {
    businessId: business!.id,
    email: `member-${suffix}@example.invalid`,
    role: 'manager',
  });

  if (invited.outcome !== 'invited') {
    throw new Error('expected an invitation');
  }

  const accepted = await membershipService.acceptInvitation(harness.db, invited.token);

  if (accepted.outcome !== 'accepted') {
    throw new Error('expected acceptance');
  }

  const [location] = await harness.db
    .insert(locations)
    .values({ businessId: business!.id, code: `LOC-${suffix}`, name: `Location ${suffix}` })
    .returning({ id: locations.id });

  const [item] = await harness.db
    .insert(canonicalItems)
    .values({ businessId: business!.id, sku: `SKU-${suffix}`, name: `Item ${suffix}` })
    .returning({ id: canonicalItems.id });

  return {
    businessId: business!.id,
    ownerId: owner!.id,
    memberId: accepted.userId,
    membershipId: accepted.membershipId,
    locationId: location!.id,
    itemId: item!.id,
  };
}

describe('the schema refuses cross-business rows', () => {
  it('will not attach a grant to a membership in another business', async () => {
    const mine = await tenant('a');
    const theirs = await tenant('b');

    const reason = await refuses(() =>
      harness.db.insert(permissionGrants).values({
        businessId: mine.businessId,
        membershipId: theirs.membershipId,
        // A permission no role template grants, so the composite foreign key is
        // what refuses this and not the unique constraint on an existing row.
        permission: 'delete_business',
      }),
    );

    expect(reason).toMatch(/permission_grants_membership_fkey/);
  });

  it('will not scope a grant to a location in another business', async () => {
    const mine = await tenant('a');
    const theirs = await tenant('b');

    const [grant] = await harness.db
      .insert(permissionGrants)
      .values({
        businessId: mine.businessId,
        membershipId: mine.membershipId,
        permission: 'view_orders',
        scopeKind: 'locations',
      })
      .returning({ id: permissionGrants.id });

    const reason = await refuses(() =>
      harness.db.insert(permissionGrantLocations).values({
        businessId: mine.businessId,
        grantId: grant!.id,
        locationId: theirs.locationId,
      }),
    );

    expect(reason).toMatch(/permission_grant_locations_location_fkey/);
  });

  it('will not put another business item on our inventory rows', async () => {
    // The composite key from 0001, re-proven here because M1's grants depend on
    // the same technique and the two must not drift.
    const mine = await tenant('a');
    const theirs = await tenant('b');

    const reason = await refuses(() =>
      harness.db.execute(
        `insert into location_balances (business_id, canonical_item_id, location_id, on_hand)
         values ('${mine.businessId}', '${theirs.itemId}', '${mine.locationId}', 1)`,
      ),
    );

    expect(reason).toMatch(/location_balances_item_fkey/);
  });
});

describe('the services never return another business rows', () => {
  it('gives no authorization subject in a business the user does not belong to', async () => {
    const mine = await tenant('a');
    const theirs = await tenant('b');

    expect(
      await membershipService.loadSubject(harness.db, mine.businessId, mine.memberId),
    ).not.toBeNull();
    expect(
      await membershipService.loadSubject(harness.db, theirs.businessId, mine.memberId),
    ).toBeNull();
  });

  it('lists only the businesses the user actually belongs to', async () => {
    const mine = await tenant('a');
    await tenant('b');

    const listed = await membershipService.listBusinessesFor(harness.db, mine.memberId);

    expect(listed.map((row) => row.businessId)).toEqual([mine.businessId]);
  });

  it('refuses to switch a session to a business the user cannot reach', async () => {
    const mine = await tenant('a');
    const theirs = await tenant('b');
    const { session } = await sessions.create(harness.db, { userId: mine.memberId });

    expect(await sessions.switchBusiness(harness.db, session.id, theirs.businessId)).toBe(false);
    expect(await sessions.switchBusiness(harness.db, session.id, mine.businessId)).toBe(true);
  });

  it('refuses to switch to a business whose membership has been suspended', async () => {
    const mine = await tenant('a');
    const { session } = await sessions.create(harness.db, { userId: mine.memberId });

    await membershipService.suspend(harness.db, mine.membershipId);

    expect(await sessions.switchBusiness(harness.db, session.id, mine.businessId)).toBe(false);
  });
});

describe('authorization carries no authority across a boundary', () => {
  it('does not let an owner of one business act in another', async () => {
    // The sharpest case: maximum authority, wrong tenant, and the answer is
    // still nothing at all rather than a reduced set.
    const mine = await tenant('a');
    const theirs = await tenant('b');

    const here = await membershipService.loadSubject(harness.db, mine.businessId, mine.ownerId);
    const there = await membershipService.loadSubject(harness.db, theirs.businessId, mine.ownerId);

    expect(here?.isOwner).toBe(true);
    expect(authorize(here!, 'delete_business').allowed).toBe(true);
    expect(there).toBeNull();
  });

  it('keeps two roles for the same person in two businesses apart', async () => {
    const strong = await tenant('a');
    const weak = await tenant('b');

    const [person] = await harness.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, strong.memberId));

    // The same person joins the second business as a viewer. Their manager
    // grants in the first must not follow them.
    const invited = await membershipService.invite(harness.db, {
      businessId: weak.businessId,
      email: person!.email,
      role: 'viewer',
    });

    if (invited.outcome !== 'invited') {
      throw new Error('expected an invitation');
    }

    await membershipService.acceptInvitation(harness.db, invited.token);

    const asManager = await membershipService.loadSubject(
      harness.db,
      strong.businessId,
      strong.memberId,
    );
    const asViewer = await membershipService.loadSubject(
      harness.db,
      weak.businessId,
      strong.memberId,
    );

    expect(authorize(asManager!, 'approve_mappings').allowed).toBe(true);
    expect(authorize(asViewer!, 'approve_mappings').allowed).toBe(false);
    expect(authorize(asViewer!, 'view_catalog').allowed).toBe(true);
  });

  it('does not honour a location-scoped grant against another business locations', async () => {
    const mine = await tenant('a');
    const theirs = await tenant('b');

    await membershipService.setGrants(harness.db, mine.businessId, mine.membershipId, [
      { permission: 'view_orders', scope: { kind: 'locations', locationIds: [mine.locationId] } },
    ]);

    const subject = await membershipService.loadSubject(harness.db, mine.businessId, mine.memberId);

    expect(authorize(subject!, 'view_orders', { locationIds: [mine.locationId] }).allowed).toBe(
      true,
    );
    expect(authorize(subject!, 'view_orders', { locationIds: [theirs.locationId] }).allowed).toBe(
      false,
    );
    // An order spanning both is not partly visible.
    expect(
      authorize(subject!, 'view_orders', {
        locationIds: [mine.locationId, theirs.locationId],
      }).allowed,
    ).toBe(false);
  });

  it('withdraws everything the moment a membership is removed', async () => {
    const mine = await tenant('a');

    await membershipService.remove(harness.db, mine.membershipId);

    expect(
      await membershipService.loadSubject(harness.db, mine.businessId, mine.memberId),
    ).toBeNull();
    expect(
      await harness.db
        .select()
        .from(permissionGrants)
        .where(eq(permissionGrants.membershipId, mine.membershipId)),
    ).toHaveLength(0);
  });

  it('leaves the other business untouched when one membership is removed', async () => {
    const first = await tenant('a');
    const second = await tenant('b');

    const [person] = await harness.db
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, first.memberId));

    const invited = await membershipService.invite(harness.db, {
      businessId: second.businessId,
      email: person!.email,
      role: 'operator',
    });

    if (invited.outcome !== 'invited') {
      throw new Error('expected an invitation');
    }

    await membershipService.acceptInvitation(harness.db, invited.token);
    await membershipService.remove(harness.db, first.membershipId);

    expect(
      await membershipService.loadSubject(harness.db, first.businessId, first.memberId),
    ).toBeNull();
    expect(
      await membershipService.loadSubject(harness.db, second.businessId, first.memberId),
    ).not.toBeNull();
  });
});

describe('the audit trail is tenant-scoped', () => {
  it('never returns one business events to another', async () => {
    const mine = await tenant('a');
    const theirs = await tenant('b');

    await recordAuditEvent(harness.db, {
      action: 'member.invited',
      result: 'success',
      actor: { userId: mine.ownerId, kind: 'user' },
      businessId: mine.businessId,
    });

    expect(await readBusinessAuditEvents(harness.db, mine.businessId)).toHaveLength(1);
    expect(await readBusinessAuditEvents(harness.db, theirs.businessId)).toHaveLength(0);
  });

  it('never mixes business events into the installation surface', async () => {
    // An administrator holding view_installation_audit must not be handed every
    // tenant's history as a side effect of a different permission.
    const mine = await tenant('a');

    await recordAuditEvent(harness.db, {
      action: 'business.settings_changed',
      result: 'success',
      actor: { userId: mine.ownerId, kind: 'user' },
      businessId: mine.businessId,
    });

    const installation = await readInstallationAuditEvents(harness.db);

    expect(installation.every((row) => row.businessId === null)).toBe(true);
  });
});

describe('invitations are tenant-scoped', () => {
  it('lets two businesses invite the same person independently', async () => {
    const first = await tenant('a');
    const second = await tenant('b');
    const email = `shared-${String((sequence += 1))}@example.invalid`;

    expect(
      (
        await membershipService.invite(harness.db, {
          businessId: first.businessId,
          email,
          role: 'viewer',
        })
      ).outcome,
    ).toBe('invited');
    expect(
      (
        await membershipService.invite(harness.db, {
          businessId: second.businessId,
          email,
          role: 'viewer',
        })
      ).outcome,
    ).toBe('invited');
  });

  it('grants membership only in the business that issued the invitation', async () => {
    const first = await tenant('a');
    const second = await tenant('b');
    const email = `scoped-${String((sequence += 1))}@example.invalid`;

    const invited = await membershipService.invite(harness.db, {
      businessId: first.businessId,
      email,
      role: 'manager',
    });

    if (invited.outcome !== 'invited') {
      throw new Error('expected an invitation');
    }

    const accepted = await membershipService.acceptInvitation(harness.db, invited.token);

    if (accepted.outcome !== 'accepted') {
      throw new Error('expected acceptance');
    }

    expect(accepted.businessId).toBe(first.businessId);
    expect(
      await membershipService.loadSubject(harness.db, second.businessId, accepted.userId),
    ).toBeNull();
  });
});

describe('the final-owner invariant holds per business', () => {
  it('refuses to leave a business without one, and does not consult another', async () => {
    const mine = await tenant('a');
    await tenant('b');

    const [ownerMembership] = await harness.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(eq(memberships.businessId, mine.businessId), eq(memberships.userId, mine.ownerId)),
      );

    // Another business having owners is not a reason this one may lose its
    // last: the trigger counts within the affected business only.
    const reason = await refuses(() => membershipService.remove(harness.db, ownerMembership!.id));

    expect(reason).toMatch(/must retain at least one owner/);
  });
});
