import { createTestDatabase, refuses, type TestDatabase } from '@eim/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { migrate } from './migrate';
import { loadMigrations } from './migrations';
import {
  businesses,
  canonicalItems,
  inventoryLedger,
  locationBalances,
  locations,
  memberships,
  users,
} from './index';

/**
 * Proof that the database enforces what section 17 says it enforces.
 *
 * Most assertions here are of the form "this write must be impossible", and
 * each one corresponds to a rule the application also implements. That overlap
 * is deliberate: section 17 says application validation improves error messages
 * but never substitutes for a database constraint. These tests exercise the
 * layer that has no bugs to route around, which is the layer that still holds
 * when a future refactor forgets the application check.
 *
 * `refuses` returns the reason a write was rejected, walking Drizzle's error
 * wrapper down to the constraint name. Asserting on the wrapper instead would
 * pass for any failure at all, including a typo in the query.
 *
 * This runs only against a real PostgreSQL 18. There is no fake fallback.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await harness.drop();
});

/** A business with an owner, one location, and one item. */
async function seed(slug: string): Promise<{
  businessId: string;
  userId: string;
  locationId: string;
  itemId: string;
}> {
  const { db } = harness;

  const [business] = await db
    .insert(businesses)
    .values({ name: `Business ${slug}`, slug })
    .returning({ id: businesses.id });
  const [user] = await db
    .insert(users)
    .values({ email: `${slug}@example.invalid` })
    .returning({ id: users.id });

  await db
    .insert(memberships)
    .values({ businessId: business!.id, userId: user!.id, role: 'owner' });

  const [location] = await db
    .insert(locations)
    .values({ businessId: business!.id, code: 'MAIN', name: 'Main warehouse' })
    .returning({ id: locations.id });
  const [item] = await db
    .insert(canonicalItems)
    .values({ businessId: business!.id, sku: `SKU-${slug}`, name: 'Widget' })
    .returning({ id: canonicalItems.id });

  return {
    businessId: business!.id,
    userId: user!.id,
    locationId: location!.id,
    itemId: item!.id,
  };
}

describe('migrations', () => {
  it('records what it applied', async () => {
    const result = await harness.pool.query<{ version: number; name: string }>(
      'select version, name from eim_schema_migrations order by version',
    );

    expect(result.rows[0]).toMatchObject({ version: 1, name: '0001_foundation.sql' });
  });

  it('creates the ledger chronological index as BRIN', async () => {
    // Section 17 suggests BRIN for large append-only chronological tables.
    // Creating it as a B-tree by accident is invisible until the table is big
    // enough for the difference to hurt, which is far too late to notice.
    const result = await harness.pool.query<{ amname: string }>(
      `select am.amname
         from pg_class idx
         join pg_am am on am.oid = idx.relam
        where idx.relname = 'inventory_ledger_recorded_at_brin'`,
    );

    expect(result.rows[0]?.amname).toBe('brin');
  });

  it('is safe to run twice at once', async () => {
    // Section 23 starts the web and worker containers together, each depending
    // on the migration task. The advisory lock is what stops two runners from
    // both applying the same migration.
    const [first, second] = await Promise.all([migrate(harness.pool), migrate(harness.pool)]);

    expect(first.applied).toHaveLength(0);
    expect(second.applied).toHaveLength(0);
    expect(first.schemaVersion).toBe(second.schemaVersion);

    // Every migration recorded exactly once, no matter how many runners raced.
    const counted = await harness.pool.query<{ total: string }>(
      'select count(*)::text as total from eim_schema_migrations',
    );
    expect(counted.rows[0]?.total).toBe(String(loadMigrations().length));
  });
});

describe('scoped uniqueness', () => {
  it('rejects a duplicate SKU within one business', async () => {
    const { businessId } = await seed('dup-sku');

    const reason = await refuses(() =>
      harness.db
        .insert(canonicalItems)
        .values({ businessId, sku: 'SKU-dup-sku', name: 'Another widget' }),
    );

    expect(reason).toMatch(/canonical_items_sku_unique/);
  });

  it('compares SKUs case-insensitively', async () => {
    const { businessId } = await seed('case-sku');

    const reason = await refuses(() =>
      harness.db
        .insert(canonicalItems)
        .values({ businessId, sku: 'sku-CASE-SKU', name: 'Same thing, shouting' }),
    );

    expect(reason).toMatch(/canonical_items_sku_unique/);
  });

  it('allows the same SKU in a different business', async () => {
    // Merchant identifiers are unique within their scope, never globally. Two
    // businesses sharing one installation must not collide.
    await seed('scope-a');
    const second = await seed('scope-b');

    await expect(
      harness.db
        .insert(canonicalItems)
        .values({ businessId: second.businessId, sku: 'SKU-scope-a', name: 'Unrelated' }),
    ).resolves.toBeDefined();
  });

  it('frees a SKU once the item is soft-deleted', async () => {
    // Section 17 soft-deletes catalog entities so history keeps a stable
    // reference. The partial index is what stops that from permanently burning
    // the merchant's SKU.
    const { businessId, itemId } = await seed('reuse-sku');

    await harness.db
      .update(canonicalItems)
      .set({ deletedAt: new Date() })
      .where(eq(canonicalItems.id, itemId));

    await expect(
      harness.db
        .insert(canonicalItems)
        .values({ businessId, sku: 'SKU-reuse-sku', name: 'Replacement' }),
    ).resolves.toBeDefined();
  });
});

describe('composite ownership', () => {
  it('refuses a balance that mixes two businesses', async () => {
    // The point of the composite foreign key. Even with a valid item id and a
    // valid location id, the pair cannot be joined across a business boundary,
    // so an authorization bug cannot produce a cross-tenant row.
    const first = await seed('cross-a');
    const second = await seed('cross-b');

    const reason = await refuses(() =>
      harness.db.insert(locationBalances).values({
        businessId: first.businessId,
        canonicalItemId: first.itemId,
        locationId: second.locationId,
        onHand: 5,
      }),
    );

    expect(reason).toMatch(/location_balances_location_fkey/);
  });

  it('accepts a balance whose item and location share a business', async () => {
    const { businessId, itemId, locationId } = await seed('same-business');

    await expect(
      harness.db
        .insert(locationBalances)
        .values({ businessId, canonicalItemId: itemId, locationId, onHand: 5 }),
    ).resolves.toBeDefined();
  });
});

describe('quantity checks', () => {
  it('rejects negative stock', async () => {
    // Section 8: availability is never negative. A shortage is its own recorded
    // quantity, not a negative balance.
    const { businessId, itemId, locationId } = await seed('negative');

    const reason = await refuses(() =>
      harness.db
        .insert(locationBalances)
        .values({ businessId, canonicalItemId: itemId, locationId, onHand: -1 }),
    );

    expect(reason).toMatch(/location_balances_on_hand_nonnegative/);
  });

  it('rejects reserving more than is on hand', async () => {
    // This is the oversell the whole system exists to prevent, expressed as a
    // constraint rather than as a hope about application ordering.
    const { businessId, itemId, locationId } = await seed('over-reserve');

    const reason = await refuses(() =>
      harness.db
        .insert(locationBalances)
        .values({ businessId, canonicalItemId: itemId, locationId, onHand: 3, reserved: 4 }),
    );

    expect(reason).toMatch(/location_balances_reserved_within_on_hand/);
  });

  it('rejects an update that would make reserved exceed on hand', async () => {
    const { businessId, itemId, locationId } = await seed('shrink');

    await harness.db
      .insert(locationBalances)
      .values({ businessId, canonicalItemId: itemId, locationId, onHand: 10, reserved: 8 });

    const reason = await refuses(() =>
      harness.db
        .update(locationBalances)
        .set({ onHand: 5 })
        .where(
          and(
            eq(locationBalances.businessId, businessId),
            eq(locationBalances.canonicalItemId, itemId),
          ),
        ),
    );

    expect(reason).toMatch(/location_balances_reserved_within_on_hand/);
  });
});

describe('append-only ledger', () => {
  it('accepts an entry', async () => {
    const { businessId, itemId, locationId, userId } = await seed('ledger-insert');

    await expect(
      harness.db.insert(inventoryLedger).values({
        businessId,
        canonicalItemId: itemId,
        locationId,
        kind: 'receipt',
        quantityDelta: 12,
        actorUserId: userId,
        reason: 'initial stock count',
      }),
    ).resolves.toBeDefined();
  });

  it('refuses to update a committed entry', async () => {
    // Section 17: never edit a committed inventory event to correct stock. An
    // UPDATE here would leave no evidence the original figure existed.
    const { businessId, itemId, locationId } = await seed('ledger-update');

    const [entry] = await harness.db
      .insert(inventoryLedger)
      .values({
        businessId,
        canonicalItemId: itemId,
        locationId,
        kind: 'receipt',
        quantityDelta: 4,
      })
      .returning({ id: inventoryLedger.id });

    const reason = await refuses(() =>
      harness.db
        .update(inventoryLedger)
        .set({ quantityDelta: 5 })
        .where(eq(inventoryLedger.id, entry!.id)),
    );

    expect(reason).toMatch(/append-only/);
  });

  it('refuses to delete a committed entry', async () => {
    const { businessId, itemId, locationId } = await seed('ledger-delete');

    const [entry] = await harness.db
      .insert(inventoryLedger)
      .values({
        businessId,
        canonicalItemId: itemId,
        locationId,
        kind: 'receipt',
        quantityDelta: 4,
      })
      .returning({ id: inventoryLedger.id });

    const reason = await refuses(() =>
      harness.db.delete(inventoryLedger).where(eq(inventoryLedger.id, entry!.id)),
    );

    expect(reason).toMatch(/append-only/);
  });

  it('records a correction as a linked reversal', async () => {
    // The supported way to correct a mistake: the original stays, the reversal
    // points at it, and the timeline explains itself afterwards.
    const { businessId, itemId, locationId } = await seed('ledger-reversal');

    const [original] = await harness.db
      .insert(inventoryLedger)
      .values({
        businessId,
        canonicalItemId: itemId,
        locationId,
        kind: 'receipt',
        quantityDelta: 10,
      })
      .returning({ id: inventoryLedger.id });

    await harness.db.insert(inventoryLedger).values({
      businessId,
      canonicalItemId: itemId,
      locationId,
      kind: 'reversal',
      quantityDelta: -10,
      reversalOfId: original!.id,
      reason: 'miscounted at receipt',
    });

    const entries = await harness.db
      .select()
      .from(inventoryLedger)
      .where(eq(inventoryLedger.businessId, businessId));

    expect(entries).toHaveLength(2);
    expect(entries.reduce((total, entry) => total + entry.quantityDelta, 0)).toBe(0);
  });

  it('rejects a zero-quantity entry', async () => {
    const { businessId, itemId, locationId } = await seed('ledger-zero');

    const reason = await refuses(() =>
      harness.db.insert(inventoryLedger).values({
        businessId,
        canonicalItemId: itemId,
        locationId,
        kind: 'adjustment',
        quantityDelta: 0,
      }),
    );

    expect(reason).toMatch(/inventory_ledger_delta_nonzero/);
  });

  it('rejects a non-reversal that names an entry it reverses', async () => {
    const { businessId, itemId, locationId } = await seed('ledger-mislabelled');

    const [original] = await harness.db
      .insert(inventoryLedger)
      .values({
        businessId,
        canonicalItemId: itemId,
        locationId,
        kind: 'receipt',
        quantityDelta: 3,
      })
      .returning({ id: inventoryLedger.id });

    const reason = await refuses(() =>
      harness.db.insert(inventoryLedger).values({
        businessId,
        canonicalItemId: itemId,
        locationId,
        kind: 'adjustment',
        quantityDelta: -3,
        reversalOfId: original!.id,
      }),
    );

    expect(reason).toMatch(/inventory_ledger_reversal_consistent/);
  });
});

describe('final owner protection', () => {
  it('refuses to demote the last owner', async () => {
    // Losing the last owner locks a business out of its own settings with no
    // in-application way back in, so the database refuses rather than trusting
    // every future code path to remember.
    const { businessId } = await seed('last-owner');

    const reason = await refuses(() =>
      harness.db
        .update(memberships)
        .set({ role: 'manager' })
        .where(eq(memberships.businessId, businessId)),
    );

    expect(reason).toMatch(/must retain at least one owner/);
  });

  it('refuses to delete the last owner', async () => {
    const { businessId } = await seed('delete-owner');

    const reason = await refuses(() =>
      harness.db.delete(memberships).where(eq(memberships.businessId, businessId)),
    );

    expect(reason).toMatch(/must retain at least one owner/);
  });

  it('allows a handover inside one transaction', async () => {
    // This is why the trigger is deferred to commit rather than checked per
    // statement. Promoting the successor and demoting the incumbent is a single
    // legitimate act, and a per-statement check would reject whichever half ran
    // first, depending on the order somebody happened to write them.
    const { businessId, userId } = await seed('handover');

    const [successor] = await harness.db
      .insert(users)
      .values({ email: 'successor@example.invalid' })
      .returning({ id: users.id });

    await harness.db.transaction(async (tx) => {
      await tx
        .update(memberships)
        .set({ role: 'manager' })
        .where(and(eq(memberships.businessId, businessId), eq(memberships.userId, userId)));
      await tx.insert(memberships).values({ businessId, userId: successor!.id, role: 'owner' });
    });

    const owners = await harness.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.businessId, businessId), eq(memberships.role, 'owner')));

    expect(owners).toHaveLength(1);
    expect(owners[0]?.userId).toBe(successor!.id);
  });

  it('rolls back a handover that leaves no owner', async () => {
    const { businessId, userId } = await seed('failed-handover');

    const [successor] = await harness.db
      .insert(users)
      .values({ email: 'failed-successor@example.invalid' })
      .returning({ id: users.id });

    const reason = await refuses(() =>
      harness.db.transaction(async (tx) => {
        await tx
          .update(memberships)
          .set({ role: 'manager' })
          .where(and(eq(memberships.businessId, businessId), eq(memberships.userId, userId)));
        // Forgetting to promote anybody. Deferred to commit, so this fails at
        // COMMIT rather than at the statement above.
        await tx.insert(memberships).values({ businessId, userId: successor!.id, role: 'viewer' });
      }),
    );

    expect(reason).toMatch(/must retain at least one owner/);

    const stillOwner = await harness.db
      .select()
      .from(memberships)
      .where(and(eq(memberships.businessId, businessId), eq(memberships.role, 'owner')));
    expect(stillOwner).toHaveLength(1);
  });
});

describe('metadata triggers', () => {
  it('advances updated_at without the application asking', async () => {
    const { businessId } = await seed('touch');

    const [before] = await harness.db
      .select({ updatedAt: businesses.updatedAt })
      .from(businesses)
      .where(eq(businesses.id, businessId));

    // now() is transaction-scoped in PostgreSQL, so an update in the same
    // transaction would produce an identical timestamp and prove nothing.
    await harness.pool.query('select pg_sleep(0.01)');
    await harness.db
      .update(businesses)
      .set({ name: 'Renamed' })
      .where(eq(businesses.id, businessId));

    const [after] = await harness.db
      .select({ updatedAt: businesses.updatedAt })
      .from(businesses)
      .where(eq(businesses.id, businessId));

    expect(after!.updatedAt.getTime()).toBeGreaterThan(before!.updatedAt.getTime());
  });

  it('ignores an updated_at the caller supplies, which is the point', async () => {
    const { businessId } = await seed('touch-override');

    await harness.db
      .update(businesses)
      .set({ name: 'Renamed again', updatedAt: new Date('2000-01-01T00:00:00Z') })
      .where(eq(businesses.id, businessId));

    const [row] = await harness.db
      .select({ updatedAt: businesses.updatedAt })
      .from(businesses)
      .where(eq(businesses.id, businessId));

    expect(row!.updatedAt.getFullYear()).toBeGreaterThan(2000);
  });
});

describe('business timezone', () => {
  it('defaults to UTC and accepts an override (D-136)', async () => {
    const { businessId } = await seed('timezone');

    const [defaulted] = await harness.db
      .select({ timezone: businesses.timezone })
      .from(businesses)
      .where(eq(businesses.id, businessId));
    expect(defaulted!.timezone).toBe('UTC');

    await harness.db
      .update(businesses)
      .set({ timezone: 'Australia/Sydney' })
      .where(eq(businesses.id, businessId));

    // Confirms the value is one PostgreSQL itself recognizes, so quiet hours
    // and the nightly window cannot be configured against a name that silently
    // resolves to nothing.
    const known = await harness.db
      .select({ total: sql<string>`count(*)::text` })
      .from(sql`pg_timezone_names`)
      .where(sql`name = 'Australia/Sydney'`);
    expect(known[0]?.total).toBe('1');
  });
});
