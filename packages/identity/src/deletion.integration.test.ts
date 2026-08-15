import { createHasher } from '@eim/crypto';
import { businesses, connections, memberships, users } from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDeletionService, DELETION_CONFIRMATION_TTL_MS } from './deletion';
import { createMembershipService } from './memberships';

/**
 * Deleting a business, against a real database (sections 5, 13, 19).
 *
 * The properties worth proving here are all refusals, and each is a way the
 * two-step confirmation could be made pointless: a non-owner reaching it, a
 * link outliving the ownership that justified it, a link working twice, or the
 * credentials surviving the shop.
 */

let harness: TestDatabase;
const hasher = createHasher('d'.repeat(48));
const service = createDeletionService(hasher);
const membershipService = createMembershipService(hasher);

beforeAll(async () => {
  harness = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await harness.drop();
});

let sequence = 0;

async function createUser(): Promise<string> {
  sequence += 1;
  const [user] = await harness.db
    .insert(users)
    .values({ email: `del-${String(sequence)}@example.invalid` })
    .returning({ id: users.id });

  return user!.id;
}

interface Fixture {
  readonly businessId: string;
  readonly ownerId: string;
  readonly name: string;
}

async function seed(): Promise<Fixture> {
  const ownerId = await createUser();
  sequence += 1;
  const name = `Deletable ${String(sequence)}`;

  const created = await membershipService.createBusiness(harness.db, {
    name,
    ownerUserId: ownerId,
  });

  if (created.outcome !== 'created') {
    throw new Error('expected the business to be created');
  }

  return { businessId: created.businessId, ownerId, name };
}

/** A connection with a stored secret, so erasure has something to erase. */
async function withCredentials(fixture: Fixture): Promise<string> {
  const [connection] = await harness.db
    .insert(connections)
    .values({
      businessId: fixture.businessId,
      provider: 'ebay',
      environment: 'production',
      externalAccountId: `acct-${String((sequence += 1))}`,
      displayName: 'Seller',
      status: 'active',
    })
    .returning({ id: connections.id });

  await harness.db.execute(sql`
    insert into connection_secrets
      (business_id, connection_id, secret_type, ciphertext, key_version)
    values (${fixture.businessId}::uuid, ${connection!.id}::uuid, 'ebay_refresh_token',
            'pretend-ciphertext', 1)
  `);

  return connection!.id;
}

async function addOwner(fixture: Fixture): Promise<string> {
  const userId = await createUser();

  await harness.db
    .insert(memberships)
    .values({ businessId: fixture.businessId, userId, role: 'owner', status: 'active' });

  return userId;
}

async function addManager(fixture: Fixture): Promise<string> {
  const userId = await createUser();

  await harness.db
    .insert(memberships)
    .values({ businessId: fixture.businessId, userId, role: 'manager', status: 'active' });

  return userId;
}

describe('requesting a deletion', () => {
  it('refuses anybody who is not an owner', async () => {
    const fixture = await seed();
    const manager = await addManager(fixture);

    const result = await service.request(harness.db, {
      businessId: fixture.businessId,
      actorUserId: manager,
      typedName: fixture.name,
    });

    // Not the `delete_business` permission — ownership. A manager granted that
    // permission would pass a permission check and must still fail this one.
    expect(result.outcome).toBe('not_an_owner');
  });

  it('refuses a name that does not match', async () => {
    const fixture = await seed();

    const result = await service.request(harness.db, {
      businessId: fixture.businessId,
      actorUserId: fixture.ownerId,
      typedName: 'something else',
    });

    expect(result.outcome).toBe('name_mismatch');
  });

  it('accepts the name whatever case it was typed in', async () => {
    const fixture = await seed();

    const result = await service.request(harness.db, {
      businessId: fixture.businessId,
      actorUserId: fixture.ownerId,
      typedName: `  ${fixture.name.toUpperCase()}  `,
    });

    // The point is proving they read which business they are on, not testing
    // their typing.
    expect(result.outcome).toBe('requested');
  });

  it('allows only one outstanding request at a time', async () => {
    const fixture = await seed();

    const first = await service.request(harness.db, {
      businessId: fixture.businessId,
      actorUserId: fixture.ownerId,
      typedName: fixture.name,
    });
    const second = await service.request(harness.db, {
      businessId: fixture.businessId,
      actorUserId: fixture.ownerId,
      typedName: fixture.name,
    });

    expect(first.outcome).toBe('requested');
    // Otherwise cancelling the request you remember leaves the ones you forgot
    // still working.
    expect(second.outcome).toBe('already_requested');
  });

  it('stores a hash, never the link', async () => {
    const fixture = await seed();

    const result = await service.request(harness.db, {
      businessId: fixture.businessId,
      actorUserId: fixture.ownerId,
      typedName: fixture.name,
    });

    if (result.outcome !== 'requested') {
      throw new Error('expected a request');
    }

    const rows = await harness.db.execute<{ token_hash: string }>(sql`
      select token_hash from business_deletion_requests
       where business_id = ${fixture.businessId}::uuid
    `);

    expect(rows.rows[0]?.token_hash).not.toBe(result.token);
    expect(rows.rows[0]?.token_hash).toBe(hasher.hash('business_deletion', result.token));
  });
});

describe('confirming a deletion', () => {
  async function request(fixture: Fixture): Promise<string> {
    const result = await service.request(harness.db, {
      businessId: fixture.businessId,
      actorUserId: fixture.ownerId,
      typedName: fixture.name,
    });

    if (result.outcome !== 'requested') {
      throw new Error('expected a request');
    }

    return result.token;
  }

  it('soft-deletes the business and erases its credentials', async () => {
    const fixture = await seed();
    const connectionId = await withCredentials(fixture);
    const token = await request(fixture);

    const confirmed = await service.confirm(harness.db, {
      token,
      actorUserId: fixture.ownerId,
    });

    expect(confirmed.outcome).toBe('deleted');
    expect(confirmed.outcome === 'deleted' ? confirmed.secretsErased : 0).toBe(1);

    // D-056: the records stay, marked deleted...
    const [business] = await harness.db
      .select({ status: businesses.status, deletedAt: businesses.deletedAt })
      .from(businesses)
      .where(eq(businesses.id, fixture.businessId));

    expect(business?.status).toBe('deleted');
    expect(business?.deletedAt).not.toBeNull();

    // ...and the credentials do not. A deleted business's stored refresh token
    // is a live credential with nobody left to notice it being used.
    const secrets = await harness.db.execute(sql`
      select 1 from connection_secrets where business_id = ${fixture.businessId}::uuid
    `);
    expect(secrets.rows).toHaveLength(0);

    const [connection] = await harness.db
      .select({ status: connections.status })
      .from(connections)
      .where(eq(connections.id, connectionId));

    expect(connection?.status).toBe('disconnected');
  });

  it('takes it out of every switcher', async () => {
    const fixture = await seed();
    const token = await request(fixture);

    await service.confirm(harness.db, { token, actorUserId: fixture.ownerId });

    const reachable = await membershipService.listBusinessesFor(harness.db, fixture.ownerId);

    expect(reachable.map((entry) => entry.businessId)).not.toContain(fixture.businessId);
  });

  it('works exactly once', async () => {
    const fixture = await seed();
    const token = await request(fixture);

    const first = await service.confirm(harness.db, { token, actorUserId: fixture.ownerId });
    const second = await service.confirm(harness.db, { token, actorUserId: fixture.ownerId });

    expect(first.outcome).toBe('deleted');
    expect(second.outcome).toBe('settled');
  });

  it('refuses a link held by somebody who has stopped being an owner', async () => {
    const fixture = await seed();
    const second = await addOwner(fixture);
    const token = await request(fixture);

    // Demoted in the hour between asking and clicking. The link is still in
    // their inbox and must stop working — which is the entire reason this is a
    // second authorization rather than a second click.
    await harness.db
      .update(memberships)
      .set({ role: 'viewer' })
      .where(
        and(
          eq(memberships.businessId, fixture.businessId),
          eq(memberships.userId, fixture.ownerId),
        ),
      );

    const denied = await service.confirm(harness.db, { token, actorUserId: fixture.ownerId });
    expect(denied.outcome).toBe('not_an_owner');

    // The other owner can still use it, because the request is about the
    // business rather than about who happened to type the name.
    const allowed = await service.confirm(harness.db, { token, actorUserId: second });
    expect(allowed.outcome).toBe('deleted');
  });

  it('refuses an expired link', async () => {
    const fixture = await seed();
    const token = await request(fixture);

    const result = await service.confirm(harness.db, {
      token,
      actorUserId: fixture.ownerId,
      now: new Date(Date.now() + DELETION_CONFIRMATION_TTL_MS + 1000),
    });

    expect(result.outcome).toBe('expired');
  });

  it('refuses a token that was never issued', async () => {
    const result = await service.confirm(harness.db, {
      token: 'not-a-real-token',
      actorUserId: await createUser(),
    });

    expect(result.outcome).toBe('invalid');
  });
});

describe('cancelling', () => {
  it('lets a manager stop a request they did not expect', async () => {
    const fixture = await seed();
    const manager = await addManager(fixture);

    const requested = await service.request(harness.db, {
      businessId: fixture.businessId,
      actorUserId: fixture.ownerId,
      typedName: fixture.name,
    });

    if (requested.outcome !== 'requested') {
      throw new Error('expected a request');
    }

    // Cancelling is the safe direction, so it deliberately does not need
    // ownership: somebody who sees a deletion they did not expect should be
    // able to stop it without first being promoted.
    expect(await service.cancel(harness.db, fixture.businessId, manager)).toBe(true);

    const afterwards = await service.confirm(harness.db, {
      token: requested.token,
      actorUserId: fixture.ownerId,
    });

    expect(afterwards.outcome).toBe('settled');
  });

  it('frees the business for a fresh request', async () => {
    const fixture = await seed();

    await service.request(harness.db, {
      businessId: fixture.businessId,
      actorUserId: fixture.ownerId,
      typedName: fixture.name,
    });
    await service.cancel(harness.db, fixture.businessId, fixture.ownerId);

    const again = await service.request(harness.db, {
      businessId: fixture.businessId,
      actorUserId: fixture.ownerId,
      typedName: fixture.name,
    });

    expect(again.outcome).toBe('requested');
  });

  it('reports nothing to cancel rather than pretending', async () => {
    const fixture = await seed();

    expect(await service.cancel(harness.db, fixture.businessId, fixture.ownerId)).toBe(false);
  });
});
