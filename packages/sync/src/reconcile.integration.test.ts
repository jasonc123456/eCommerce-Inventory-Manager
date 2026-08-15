import { operatorOrigin } from '@eim/pilot';
import { businesses, connections, inventoryConflicts, providerItems, users } from '@eim/db';
import {
  activateMapping,
  approveMapping,
  createCanonicalItem,
  createLocation,
  postMovements,
  proposeMapping,
} from '@eim/inventory';
import { FakeChannelAdapter } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { reconcile, resolveConflict } from './reconcile';
import { readTarget, refreshTargetsForItem } from './targets';

/**
 * Reconciliation and conflicts (sections 12, 15).
 *
 * The line being held: a channel value that disagrees with ours is evidence,
 * never a correction. These tests exist mostly to prove the negative — that a
 * reconciliation run which finds a surprising number does not quietly make the
 * ledger agree with it.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

interface Fixture {
  readonly businessId: string;
  readonly connectionId: string;
  readonly canonicalItemId: string;
  readonly locationId: string;
  readonly mappingId: string;
  readonly externalId: string;
  readonly userId: string;
}

async function seed(onHand = 10): Promise<Fixture> {
  const slug = `rec-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Operator' })
    .returning({ id: users.id });

  const businessId = business!.id;
  const userId = user!.id;

  const [connection] = await harness.db
    .insert(connections)
    .values({
      businessId,
      provider: 'ebay',
      environment: 'sandbox',
      externalAccountId: `acct-${slug}`,
      displayName: 'Test seller',
      status: 'active',
    })
    .returning({ id: connections.id });

  const connectionId = connection!.id;
  const location = await createLocation(harness.db, { businessId, code: 'MAIN', name: 'Main' });
  const locationId = location.outcome === 'created' ? location.locationId : '';
  const item = await createCanonicalItem(harness.db, { businessId, sku: slug, name: 'Widget' });
  const canonicalItemId = item.outcome === 'created' ? item.canonicalItemId : '';

  const externalId = `listing-${slug}`;
  const [providerItem] = await harness.db
    .insert(providerItems)
    .values({
      businessId,
      connectionId,
      externalId,
      title: 'Widget',
      kind: 'listing',
      inventoryEligible: true,
      quantity: 0,
    })
    .returning({ id: providerItems.id });

  const proposed = await proposeMapping(harness.db, {
    businessId,
    connectionId,
    canonicalItemId,
    providerItemId: providerItem!.id,
    locationIds: [locationId],
    createdByUserId: userId,
  });
  const mappingId = proposed.outcome === 'proposed' ? proposed.mappingId : '';

  await approveMapping(harness.db, { businessId, mappingId, approvedByUserId: userId });
  await activateMapping(harness.db, { businessId, mappingId, actorUserId: userId });

  await harness.db.transaction(async (tx) => {
    await postMovements(tx, {
      businessId,
      actorUserId: userId,
      movements: [{ canonicalItemId, locationId, kind: 'receipt', quantityDelta: onHand }],
    });
    await refreshTargetsForItem(tx, {
      businessId,
      canonicalItemId,
      reason: 'receipt',
      origin: operatorOrigin('manual'),
    });
  });

  return { businessId, connectionId, canonicalItemId, locationId, mappingId, externalId, userId };
}

/** A channel holding a given quantity for the mapped listing. */
function channelSaying(fixture: Fixture, quantity: number): FakeChannelAdapter {
  return new FakeChannelAdapter({
    provider: 'ebay',
    initialQuantities: new Map([[fixture.externalId, quantity]]),
  });
}

function deps(fake: FakeChannelAdapter) {
  return { adapterFor: () => Promise.resolve(fake) };
}

async function onHandOf(fixture: Fixture): Promise<number> {
  const rows = await harness.db.execute<{ on_hand: number }>(sql`
    select on_hand from location_balances
     where business_id = ${fixture.businessId}::uuid
       and canonical_item_id = ${fixture.canonicalItemId}::uuid
  `);

  return rows.rows[0]?.on_hand ?? 0;
}

async function openConflicts(fixture: Fixture) {
  return harness.db
    .select()
    .from(inventoryConflicts)
    .where(eq(inventoryConflicts.businessId, fixture.businessId));
}

describe('reconcile', () => {
  it('records a clean run as evidence that nothing was wrong', async () => {
    // A clean report is worth as much as a dirty one when somebody asks what
    // happened last Tuesday.
    const fixture = await seed();
    const fake = channelSaying(fixture, 9);

    const result = await reconcile(
      harness.db,
      { businessId: fixture.businessId, trigger: 'scheduled', dryRun: false },
      deps(fake),
    );

    expect(result).toMatchObject({ examined: 1, matched: 1, discrepancies: 0 });
    expect(result.findings[0]?.finding).toBe('match');
  });

  it('repairs a channel that is merely showing our previous write', async () => {
    const fixture = await seed();

    // Convince the target it wrote 9, then move the ledger so 5 is wanted.
    const fake = channelSaying(fixture, 9);
    await harness.db.execute(sql`
      update channel_targets
         set written_version = target_version, written_quantity = 9, state = 'converged'
       where mapping_id = ${fixture.mappingId}::uuid
    `);
    await harness.db.transaction(async (tx) => {
      await postMovements(tx, {
        businessId: fixture.businessId,
        movements: [
          {
            canonicalItemId: fixture.canonicalItemId,
            locationId: fixture.locationId,
            kind: 'shipment',
            quantityDelta: -4,
          },
        ],
      });
      await refreshTargetsForItem(tx, {
        businessId: fixture.businessId,
        canonicalItemId: fixture.canonicalItemId,
        reason: 'sale',
        origin: operatorOrigin('manual'),
      });
    });

    const result = await reconcile(
      harness.db,
      { businessId: fixture.businessId, trigger: 'scheduled', dryRun: false },
      deps(fake),
    );

    expect(result.findings[0]).toMatchObject({ finding: 'stale_write', proposedAction: 'write' });
    expect(result.repaired).toBe(1);
    expect(await openConflicts(fixture)).toHaveLength(0);
  });

  it('opens a conflict for a number nobody wrote, and changes no stock', async () => {
    // The whole point. Section 15: "do not adopt the channel value into physical
    // inventory automatically."
    const fixture = await seed();
    const fake = channelSaying(fixture, 44);

    const result = await reconcile(
      harness.db,
      { businessId: fixture.businessId, trigger: 'scheduled', dryRun: false },
      deps(fake),
    );

    expect(result.findings[0]).toMatchObject({ finding: 'drift', proposedAction: 'conflict' });
    expect(result.conflictsOpened).toBe(1);
    expect(await onHandOf(fixture)).toBe(10);

    const conflicts = await openConflicts(fixture);
    expect(conflicts[0]).toMatchObject({
      kind: 'quantity_drift',
      status: 'open',
      expectedQuantity: 9,
      observedQuantity: 44,
    });
  });

  it('leaves a channel that is offering less than we would, alone', async () => {
    // Section 15: "if the observed channel quantity is already lower than the
    // safe target, leave it unchanged while the mapping is paused." Nothing is
    // being oversold, so there is nothing urgent to correct.
    const fixture = await seed();
    const fake = channelSaying(fixture, 2);

    await reconcile(
      harness.db,
      { businessId: fixture.businessId, trigger: 'scheduled', dryRun: false },
      deps(fake),
    );

    expect(fake.writes).toHaveLength(0);
    expect((await readTarget(harness.db, fixture.mappingId))?.state).toBe('blocked');
  });

  it('proposes without doing anything, when asked for a dry run', async () => {
    const fixture = await seed();
    const fake = channelSaying(fixture, 44);

    const result = await reconcile(
      harness.db,
      { businessId: fixture.businessId, trigger: 'manual', dryRun: true },
      deps(fake),
    );

    expect(result.findings[0]?.proposedAction).toBe('conflict');
    expect(result.conflictsOpened).toBe(0);
    expect(await openConflicts(fixture)).toHaveLength(0);
    expect((await readTarget(harness.db, fixture.mappingId))?.state).not.toBe('blocked');
  });

  it('does not queue a second decision for a drift it keeps re-detecting', async () => {
    const fixture = await seed();
    const fake = channelSaying(fixture, 44);

    for (let pass = 0; pass < 3; pass += 1) {
      await reconcile(
        harness.db,
        { businessId: fixture.businessId, trigger: 'scheduled', dryRun: false },
        deps(fake),
      );
    }

    expect(await openConflicts(fixture)).toHaveLength(1);
  });

  it('records a provider it could not reach without concluding anything', async () => {
    const fixture = await seed();
    const fake = channelSaying(fixture, 9).failNext({
      status: 'unavailable',
      message: 'the provider is unavailable',
    });

    const result = await reconcile(
      harness.db,
      { businessId: fixture.businessId, trigger: 'scheduled', dryRun: false },
      deps(fake),
    );

    expect(result.findings[0]?.finding).toBe('unreachable');
    expect(await openConflicts(fixture)).toHaveLength(0);
  });
});

describe('resolveConflict', () => {
  async function openOne(fixture: Fixture): Promise<string> {
    await reconcile(
      harness.db,
      { businessId: fixture.businessId, trigger: 'scheduled', dryRun: false },
      deps(channelSaying(fixture, 44)),
    );

    const [conflict] = await openConflicts(fixture);

    // The reconciler links the mapping; the item comes from it, and the
    // adoption path needs one to adjust.
    await harness.db
      .update(inventoryConflicts)
      .set({ canonicalItemId: fixture.canonicalItemId })
      .where(eq(inventoryConflicts.id, conflict!.id));

    return conflict!.id;
  }

  it('refuses a resolution with no reason', async () => {
    const fixture = await seed();
    const conflictId = await openOne(fixture);

    expect(
      await resolveConflict(harness.db, {
        businessId: fixture.businessId,
        conflictId,
        resolution: 'overwrite_channel',
        reason: '   ',
        actorUserId: fixture.userId,
      }),
    ).toMatchObject({ outcome: 'invalid' });
  });

  it('closes a conflict by overwriting the channel, changing no stock', async () => {
    const fixture = await seed();
    const conflictId = await openOne(fixture);

    expect(
      await resolveConflict(harness.db, {
        businessId: fixture.businessId,
        conflictId,
        resolution: 'overwrite_channel',
        reason: 'the listing was edited in the eBay app by mistake',
        actorUserId: fixture.userId,
      }),
    ).toEqual({ outcome: 'resolved' });

    expect(await onHandOf(fixture)).toBe(10);
    expect((await readTarget(harness.db, fixture.mappingId))?.state).toBe('pending');
  });

  it('adopts a counted quantity through the ledger, never behind it', async () => {
    // Section 8 has no path by which stock changes without an entry explaining
    // it, and "an authorized person accepted the channel's count" is exactly the
    // explanation somebody will want six weeks later.
    const fixture = await seed();
    const conflictId = await openOne(fixture);

    const result = await resolveConflict(harness.db, {
      businessId: fixture.businessId,
      conflictId,
      resolution: 'adopt_external',
      reason: 'counted the shelf; thirty-five more than we thought',
      actorUserId: fixture.userId,
      locationId: fixture.locationId,
      quantityDelta: 35,
    });

    expect(result).toEqual({ outcome: 'resolved' });
    expect(await onHandOf(fixture)).toBe(45);

    const entries = await harness.db.execute<{ kind: string; reason: string }>(sql`
      select kind, reason from inventory_ledger
       where business_id = ${fixture.businessId}::uuid and kind = 'reconciliation'
    `);
    expect(entries.rows[0]?.reason).toContain('counted the shelf');
  });

  it('will not adopt a quantity without saying where it went', async () => {
    const fixture = await seed();
    const conflictId = await openOne(fixture);

    expect(
      await resolveConflict(harness.db, {
        businessId: fixture.businessId,
        conflictId,
        resolution: 'adopt_external',
        reason: 'counted the shelf',
        actorUserId: fixture.userId,
      }),
    ).toMatchObject({ outcome: 'invalid' });
  });

  it('refuses to close the same conflict twice', async () => {
    const fixture = await seed();
    const conflictId = await openOne(fixture);
    const close = async () =>
      resolveConflict(harness.db, {
        businessId: fixture.businessId,
        conflictId,
        resolution: 'repaired',
        reason: 'fixed at the store',
        actorUserId: fixture.userId,
      });

    await close();

    expect(await close()).toEqual({ outcome: 'already_resolved' });
  });

  it('refuses to store a resolved conflict that explains nothing', async () => {
    // The database backstop behind section 12's "an unresolved mismatch cannot
    // be dismissed". Even a caller that forgets the rule cannot store the row.
    const fixture = await seed();
    const conflictId = await openOne(fixture);

    await expect(
      harness.db.execute(
        sql`update inventory_conflicts set status = 'resolved' where id = ${conflictId}::uuid`,
      ),
    ).rejects.toSatisfy((error: unknown) =>
      JSON.stringify(error).includes('inventory_conflicts_resolution_complete'),
    );
  });
});
