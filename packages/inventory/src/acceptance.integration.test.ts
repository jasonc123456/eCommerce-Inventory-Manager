import {
  businesses,
  channelMappings,
  connections,
  inventoryLedger,
  locationBalances,
  providerItems,
  users,
} from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { activateMapping, resolveWriteTarget, writableMappingsForItem } from './activation';
import { applyAdjustment, reverseEntry, transferStock } from './adjustments';
import { createCanonicalItem } from './items';
import { approveRecipe, declareKit, draftRecipe, kitCapacity } from './kits';
import { postMovements } from './ledger';
import { createLocation } from './locations';
import { approveMapping, archiveMapping, proposeMapping } from './mappings';
import { fulfillReservation, releaseReservation, reserve } from './reservations';
import { updateSettings } from './settings';

/**
 * The M3 exit gate (section 36).
 *
 * Section 36 asks for two things from this milestone: that ledger, property, and
 * concurrency invariants pass, and that no provider write can occur without an
 * eligible approved mapping.
 *
 * The property half lives in `@eim/domain`, where the arithmetic can be tested
 * against thousands of generated cases without a database. What is here is what
 * only a real PostgreSQL can settle.
 *
 * The central claim is the first one below: after any sequence of operations,
 * the materialized balance equals the sum of the ledger entries that produced
 * it. Everything else in this system reads the balance, so if that identity ever
 * fails, every number on every screen is wrong and the ledger — the thing meant
 * to explain them — no longer does.
 *
 * The second claim is checked by enumeration rather than by inspection: a
 * mapping is walked through every state it can occupy, and the write gate is
 * asked at each. A mapping that is writable at any point before it has been both
 * approved and activated would fail here.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

interface World {
  readonly businessId: string;
  readonly connectionId: string;
  readonly userId: string;
  readonly itemIds: readonly string[];
  readonly locationIds: readonly string[];
  readonly providerItemIds: readonly string[];
  readonly slug: string;
}

async function world(items = 3, locationCount = 2): Promise<World> {
  const slug = `gate-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Operator' })
    .returning({ id: users.id });
  const businessId = business!.id;

  const [connection] = await harness.db
    .insert(connections)
    .values({
      businessId,
      provider: 'woocommerce',
      environment: 'production',
      externalAccountId: `https://${slug}.example`,
      displayName: slug,
      status: 'active',
      connectedAt: new Date(),
    })
    .returning({ id: connections.id });
  const connectionId = connection!.id;

  const locationIds: string[] = [];
  for (let index = 0; index < locationCount; index += 1) {
    const created = await createLocation(harness.db, {
      businessId,
      code: `L${String(index)}`,
      name: `Location ${String(index)}`,
      priority: index * 10,
    });

    locationIds.push(created.outcome === 'created' ? created.locationId : '');
  }

  const itemIds: string[] = [];
  const providerItemIds: string[] = [];
  for (let index = 0; index < items; index += 1) {
    const created = await createCanonicalItem(harness.db, {
      businessId,
      sku: `${slug}-${String(index)}`,
      name: `Item ${String(index)}`,
    });

    itemIds.push(created.outcome === 'created' ? created.canonicalItemId : '');

    const [providerItem] = await harness.db
      .insert(providerItems)
      .values({
        businessId,
        connectionId,
        externalId: `${slug}-p${String(index)}`,
        kind: 'product',
        inventoryEligible: true,
      })
      .returning({ id: providerItems.id });

    providerItemIds.push(providerItem!.id);
  }

  await updateSettings(harness.db, { businessId, defaultSafetyStock: 0 });

  return {
    businessId,
    connectionId,
    userId: user!.id,
    itemIds,
    locationIds,
    providerItemIds,
    slug,
  };
}

/**
 * The ledger identity: every materialized balance is the sum of its entries.
 *
 * Checked over the whole business rather than one row, so an operation that
 * updated the wrong balance is caught as well as one that updated none.
 */
async function ledgerAgreesWithBalances(businessId: string): Promise<void> {
  const rows = await harness.db.execute<{
    canonical_item_id: string;
    location_id: string;
    on_hand: number;
    ledger_total: number;
  }>(sql`
    select b.canonical_item_id,
           b.location_id,
           b.on_hand,
           coalesce(sum(l.quantity_delta), 0)::int as ledger_total
      from location_balances b
      left join inventory_ledger l
        on l.business_id = b.business_id
       and l.canonical_item_id = b.canonical_item_id
       and l.location_id = b.location_id
     where b.business_id = ${businessId}
     group by b.canonical_item_id, b.location_id, b.on_hand
  `);

  for (const row of rows.rows) {
    expect({ where: row.location_id, onHand: row.on_hand }).toEqual({
      where: row.location_id,
      onHand: row.ledger_total,
    });
  }
}

async function balancesAreSane(businessId: string): Promise<void> {
  const rows = await harness.db
    .select({
      onHand: locationBalances.onHand,
      reserved: locationBalances.reserved,
      locationId: locationBalances.locationId,
    })
    .from(locationBalances)
    .where(eq(locationBalances.businessId, businessId));

  for (const row of rows) {
    // Section 8: physical and available inventory never become negative, and a
    // shortage is recorded separately rather than as negative stock.
    expect(row.onHand).toBeGreaterThanOrEqual(0);
    expect(row.reserved).toBeGreaterThanOrEqual(0);
    expect(row.reserved).toBeLessThanOrEqual(row.onHand);
  }
}

describe('the ledger identity', () => {
  it('holds after a long mixed sequence of operations', async () => {
    const state = await world();
    const [first, second] = state.itemIds;
    const [main, spare] = state.locationIds;

    await harness.db.transaction(async (tx) => {
      await postMovements(tx, {
        businessId: state.businessId,
        movements: state.itemIds.flatMap((canonicalItemId) =>
          state.locationIds.map((locationId) => ({
            canonicalItemId,
            locationId,
            kind: 'receipt' as const,
            quantityDelta: 25,
          })),
        ),
      });
    });

    const adjusted = await applyAdjustment(harness.db, {
      businessId: state.businessId,
      canonicalItemId: first!,
      locationId: main!,
      change: { mode: 'absolute', quantity: 30 },
      reason: 'stock count',
      actorUserId: state.userId,
    });

    await transferStock(harness.db, {
      businessId: state.businessId,
      canonicalItemId: first!,
      fromLocationId: main!,
      toLocationId: spare!,
      quantity: 7,
    });

    await reverseEntry(harness.db, {
      businessId: state.businessId,
      entryId: adjusted.outcome === 'adjusted' ? adjusted.entryId : '',
      reason: 'counted the wrong shelf',
    });

    const reserved = await reserve(harness.db, {
      businessId: state.businessId,
      connectionId: state.connectionId,
      externalOrderId: 'o-1',
      externalLineId: 'l-1',
      canonicalItemId: second!,
      quantity: 6,
    });

    await fulfillReservation(harness.db, {
      businessId: state.businessId,
      reservationId: reserved.outcome === 'reserved' ? reserved.reservation.reservationId : '',
    });

    const cancelled = await reserve(harness.db, {
      businessId: state.businessId,
      connectionId: state.connectionId,
      externalOrderId: 'o-2',
      externalLineId: 'l-1',
      canonicalItemId: second!,
      quantity: 4,
    });

    await releaseReservation(harness.db, {
      businessId: state.businessId,
      reservationId: cancelled.outcome === 'reserved' ? cancelled.reservation.reservationId : '',
      reason: 'customer cancelled',
    });

    await ledgerAgreesWithBalances(state.businessId);
    await balancesAreSane(state.businessId);
  });

  it('holds when a refused operation is rolled back', async () => {
    // The interesting half: an operation that fails must leave no trace at all,
    // or the identity holds only for the operations that happened to succeed.
    const state = await world(1, 2);
    const [item] = state.itemIds;
    const [main, spare] = state.locationIds;

    await harness.db.transaction(async (tx) => {
      await postMovements(tx, {
        businessId: state.businessId,
        movements: [
          { canonicalItemId: item!, locationId: main!, kind: 'receipt', quantityDelta: 3 },
        ],
      });
    });

    await expect(
      transferStock(harness.db, {
        businessId: state.businessId,
        canonicalItemId: item!,
        fromLocationId: main!,
        toLocationId: spare!,
        quantity: 99,
      }),
    ).resolves.toMatchObject({ outcome: 'insufficient' });

    await ledgerAgreesWithBalances(state.businessId);
    await balancesAreSane(state.businessId);
  });

  it('holds under concurrent operations on the same shelf', async () => {
    // Section 12 serializes canonical mutations through row locks. Twenty
    // interleaved operations either commit whole or not at all, and the identity
    // is the thing that would notice if one committed half.
    const state = await world(1, 2);
    const [item] = state.itemIds;
    const [main, spare] = state.locationIds;

    await harness.db.transaction(async (tx) => {
      await postMovements(tx, {
        businessId: state.businessId,
        movements: [
          { canonicalItemId: item!, locationId: main!, kind: 'receipt', quantityDelta: 200 },
        ],
      });
    });

    await Promise.all(
      Array.from({ length: 20 }, async (_unused, index) => {
        if (index % 3 === 0) {
          return transferStock(harness.db, {
            businessId: state.businessId,
            canonicalItemId: item!,
            fromLocationId: main!,
            toLocationId: spare!,
            quantity: 3,
          });
        }
        if (index % 3 === 1) {
          return applyAdjustment(harness.db, {
            businessId: state.businessId,
            canonicalItemId: item!,
            locationId: main!,
            change: { mode: 'delta', quantityDelta: -2 },
            reason: 'breakage',
          });
        }

        return reserve(harness.db, {
          businessId: state.businessId,
          connectionId: state.connectionId,
          externalOrderId: `race-${String(index)}`,
          externalLineId: 'l-1',
          canonicalItemId: item!,
          quantity: 4,
        });
      }),
    );

    await ledgerAgreesWithBalances(state.businessId);
    await balancesAreSane(state.businessId);
  });

  it('never lets concurrent orders reserve more than exists', async () => {
    const state = await world(1, 1);
    const [item] = state.itemIds;
    const [main] = state.locationIds;

    await harness.db.transaction(async (tx) => {
      await postMovements(tx, {
        businessId: state.businessId,
        movements: [
          { canonicalItemId: item!, locationId: main!, kind: 'receipt', quantityDelta: 10 },
        ],
      });
    });

    const results = await Promise.all(
      Array.from({ length: 12 }, async (_unused, index) =>
        reserve(harness.db, {
          businessId: state.businessId,
          connectionId: state.connectionId,
          externalOrderId: `crowd-${String(index)}`,
          externalLineId: 'l-1',
          canonicalItemId: item!,
          quantity: 3,
        }),
      ),
    );

    const allocated = results.reduce(
      (total, result) => total + (result.outcome === 'reserved' ? result.reservation.allocated : 0),
      0,
    );

    // Twelve orders for three units each against ten units. Whatever the
    // interleaving, exactly ten units are promised in total: three orders are
    // filled, a fourth is partly filled and carries a shortage of two, and the
    // rest are recorded with a shortage of three. Section 11 records every valid
    // order either way — none of them fails.
    expect(allocated).toBe(10);
    expect(results.every((result) => result.outcome === 'reserved')).toBe(true);
    await balancesAreSane(state.businessId);
  });
});

describe('kits cannot manufacture stock', () => {
  it('holds the identity while a kit is sold', async () => {
    const state = await world(3, 1);
    const [kitId, boltId, plateId] = state.itemIds;
    const [main] = state.locationIds;

    await declareKit(harness.db, { businessId: state.businessId, canonicalItemId: kitId! });

    const drafted = await draftRecipe(harness.db, {
      businessId: state.businessId,
      kitCanonicalItemId: kitId!,
      components: [
        { canonicalItemId: boltId!, requiredQuantity: 2 },
        { canonicalItemId: plateId!, requiredQuantity: 1 },
      ],
    });
    await approveRecipe(harness.db, {
      businessId: state.businessId,
      recipeId: drafted.outcome === 'drafted' ? drafted.recipeId : '',
      approvedByUserId: state.userId,
    });

    await harness.db.transaction(async (tx) => {
      await postMovements(tx, {
        businessId: state.businessId,
        movements: [
          { canonicalItemId: boltId!, locationId: main!, kind: 'receipt', quantityDelta: 20 },
          { canonicalItemId: plateId!, locationId: main!, kind: 'receipt', quantityDelta: 20 },
        ],
      });
    });

    const sold = await reserve(harness.db, {
      businessId: state.businessId,
      connectionId: state.connectionId,
      externalOrderId: 'kit-order',
      externalLineId: 'l-1',
      canonicalItemId: kitId!,
      quantity: 4,
    });

    await fulfillReservation(harness.db, {
      businessId: state.businessId,
      reservationId: sold.outcome === 'reserved' ? sold.reservation.reservationId : '',
    });

    // Eight bolts and four plates left the shelf; the kit itself never held any.
    const kitEntries = await harness.db
      .select({ id: inventoryLedger.id })
      .from(inventoryLedger)
      .where(eq(inventoryLedger.canonicalItemId, kitId!));

    expect(kitEntries).toEqual([]);
    await ledgerAgreesWithBalances(state.businessId);
    await balancesAreSane(state.businessId);

    await expect(
      kitCapacity(harness.db, {
        businessId: state.businessId,
        kitCanonicalItemId: kitId!,
      }),
    ).resolves.toMatchObject({ capacity: { capacity: 6 } });
  });
});

describe('no provider write without an eligible approved mapping', () => {
  /** Every state a mapping can be in, and whether the gate permits a write. */
  async function gateAt(world: World, mappingId: string): Promise<string> {
    const resolved = await resolveWriteTarget(harness.db, {
      businessId: world.businessId,
      mappingId,
    });

    return resolved.outcome === 'writable' ? 'writable' : resolved.outcome;
  }

  it('refuses at every state before activation, and after it is undone', async () => {
    const state = await world(1, 1);
    const [item] = state.itemIds;
    const [providerItemId] = state.providerItemIds;
    const seen: string[] = [];

    const proposed = await proposeMapping(harness.db, {
      businessId: state.businessId,
      connectionId: state.connectionId,
      providerItemId: providerItemId!,
      canonicalItemId: item!,
      locationIds: [state.locationIds[0] ?? ''],
    });
    const mappingId = proposed.outcome === 'proposed' ? proposed.mappingId : '';

    seen.push(await gateAt(state, mappingId));

    await approveMapping(harness.db, { businessId: state.businessId, mappingId });
    seen.push(await gateAt(state, mappingId));

    await activateMapping(harness.db, {
      businessId: state.businessId,
      mappingId,
      initialization: { from: 'canonical' },
    });
    seen.push(await gateAt(state, mappingId));

    await archiveMapping(harness.db, { businessId: state.businessId, mappingId });
    seen.push(await gateAt(state, mappingId));

    // Writable exactly once, and only after both approval and activation.
    expect(seen).toEqual(['not_active', 'not_active', 'writable', 'not_active']);
  });

  it('cannot be reached by writing the status directly', async () => {
    // The gate checks eligibility and presence at write time rather than
    // trusting what was true at activation, so forcing the row to 'active' is
    // not enough to make an ineligible entity writable.
    const state = await world(1, 1);
    const proposed = await proposeMapping(harness.db, {
      businessId: state.businessId,
      connectionId: state.connectionId,
      providerItemId: state.providerItemIds[0] ?? '',
      canonicalItemId: state.itemIds[0] ?? '',
      locationIds: [state.locationIds[0] ?? ''],
    });
    const mappingId = proposed.outcome === 'proposed' ? proposed.mappingId : '';

    await harness.db
      .update(channelMappings)
      .set({ status: 'active', approvedAt: new Date(), activatedAt: new Date() })
      .where(eq(channelMappings.id, mappingId));
    await harness.db
      .update(providerItems)
      .set({ inventoryEligible: false, ineligibleReason: 'stock management is off' })
      .where(eq(providerItems.id, state.providerItemIds[0] ?? ''));

    await expect(gateAt(state, mappingId)).resolves.toBe('ineligible');
  });

  it('refuses when the channel entity has disappeared', async () => {
    const state = await world(1, 1);
    const proposed = await proposeMapping(harness.db, {
      businessId: state.businessId,
      connectionId: state.connectionId,
      providerItemId: state.providerItemIds[0] ?? '',
      canonicalItemId: state.itemIds[0] ?? '',
      locationIds: [state.locationIds[0] ?? ''],
    });
    const mappingId = proposed.outcome === 'proposed' ? proposed.mappingId : '';

    await approveMapping(harness.db, { businessId: state.businessId, mappingId });
    await activateMapping(harness.db, {
      businessId: state.businessId,
      mappingId,
      initialization: { from: 'canonical' },
    });
    await harness.db
      .update(providerItems)
      .set({ missingSince: new Date() })
      .where(eq(providerItems.id, state.providerItemIds[0] ?? ''));

    await expect(gateAt(state, mappingId)).resolves.toBe('missing');
  });

  it('never lists an unwritable mapping among the writable ones', async () => {
    // The bulk path and the single path must agree, or a projection run would
    // write to something the gate would have refused one at a time.
    const state = await world(1, 1);
    const canonicalItemId = state.itemIds[0] ?? '';

    for (const [index, providerItemId] of state.providerItemIds.entries()) {
      const proposed = await proposeMapping(harness.db, {
        businessId: state.businessId,
        connectionId: state.connectionId,
        providerItemId,
        canonicalItemId,
        locationIds: [state.locationIds[0] ?? ''],
      });
      const mappingId = proposed.outcome === 'proposed' ? proposed.mappingId : '';

      if (index === 0) {
        await approveMapping(harness.db, { businessId: state.businessId, mappingId });
        await activateMapping(harness.db, {
          businessId: state.businessId,
          mappingId,
          initialization: { from: 'canonical' },
        });
      }
    }

    const targets = await writableMappingsForItem(harness.db, {
      businessId: state.businessId,
      canonicalItemId,
    });

    for (const target of targets) {
      await expect(gateAt(state, target.mappingId)).resolves.toBe('writable');
    }

    expect(targets).toHaveLength(1);
  });

  it('does not answer for another business', async () => {
    const owner = await world(1, 1);
    const stranger = await world(1, 1);

    const proposed = await proposeMapping(harness.db, {
      businessId: owner.businessId,
      connectionId: owner.connectionId,
      providerItemId: owner.providerItemIds[0] ?? '',
      canonicalItemId: owner.itemIds[0] ?? '',
      locationIds: [owner.locationIds[0] ?? ''],
    });
    const mappingId = proposed.outcome === 'proposed' ? proposed.mappingId : '';

    await approveMapping(harness.db, { businessId: owner.businessId, mappingId });
    await activateMapping(harness.db, {
      businessId: owner.businessId,
      mappingId,
      initialization: { from: 'canonical' },
    });

    await expect(gateAt(stranger, mappingId)).resolves.toBe('no_mapping');
    await expect(
      writableMappingsForItem(harness.db, {
        businessId: stranger.businessId,
        canonicalItemId: owner.itemIds[0] ?? '',
      }),
    ).resolves.toEqual([]);
  });
});

describe('cross-business isolation', () => {
  it('keeps the stock of one business unmovable from another', async () => {
    const owner = await world(1, 2);
    const stranger = await world(1, 2);

    await harness.db.transaction(async (tx) => {
      await postMovements(tx, {
        businessId: owner.businessId,
        movements: [
          {
            canonicalItemId: owner.itemIds[0] ?? '',
            locationId: owner.locationIds[0] ?? '',
            kind: 'receipt',
            quantityDelta: 50,
          },
        ],
      });
    });

    await expect(
      applyAdjustment(harness.db, {
        businessId: stranger.businessId,
        canonicalItemId: owner.itemIds[0] ?? '',
        locationId: owner.locationIds[0] ?? '',
        change: { mode: 'absolute', quantity: 0 },
        reason: 'not mine to zero',
      }),
    ).resolves.not.toMatchObject({ outcome: 'adjusted' });

    const [balance] = await harness.db
      .select({ onHand: locationBalances.onHand })
      .from(locationBalances)
      .where(
        and(
          eq(locationBalances.businessId, owner.businessId),
          eq(locationBalances.canonicalItemId, owner.itemIds[0] ?? ''),
        ),
      );

    expect(balance?.onHand).toBe(50);
    await ledgerAgreesWithBalances(owner.businessId);
  });
});
