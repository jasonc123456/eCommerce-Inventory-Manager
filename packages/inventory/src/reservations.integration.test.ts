import { businesses, connections, inventoryLedger, locationBalances, users } from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCanonicalItem } from './items';
import { approveRecipe, declareKit, draftRecipe } from './kits';
import { postMovements, readTimeline } from './ledger';
import { createLocation } from './locations';
import {
  fulfillReservation,
  openReservationsForItem,
  previewModeSwitch,
  readReservation,
  releaseReservation,
  reserve,
  switchConsumptionMode,
} from './reservations';
import { updateSettings } from './settings';

/**
 * Reservations, allocations, and shortages (sections 9, 10, 11, 12).
 *
 * The allocation arithmetic is unit-tested in `@eim/domain`. What is tested here
 * is what only a database can settle: that reserved units really do leave
 * availability, that a cancellation puts them back where they came from, and
 * that a redelivered order line does not decrement twice.
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
  readonly otherLocationId: string;
  readonly userId: string;
  readonly slug: string;
}

async function seed(): Promise<Fixture> {
  const slug = `res-${String((counter += 1))}`;

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

  const main = await createLocation(harness.db, {
    businessId,
    code: 'MAIN',
    name: 'Main',
    priority: 10,
  });
  const spare = await createLocation(harness.db, {
    businessId,
    code: 'SPARE',
    name: 'Spare',
    priority: 20,
  });
  const item = await createCanonicalItem(harness.db, { businessId, sku: slug, name: 'Widget' });

  // Safety stock off by default in these fixtures: the interaction is tested in
  // its own case rather than muddying every arithmetic assertion.
  await updateSettings(harness.db, { businessId, defaultSafetyStock: 0 });

  return {
    businessId,
    slug,
    userId: user!.id,
    connectionId: connection!.id,
    locationId: main.outcome === 'created' ? main.locationId : '',
    otherLocationId: spare.outcome === 'created' ? spare.locationId : '',
    canonicalItemId: item.outcome === 'created' ? item.canonicalItemId : '',
  };
}

async function stock(
  ref: Fixture,
  quantity: number,
  locationId = ref.locationId,
  canonicalItemId = ref.canonicalItemId,
): Promise<void> {
  await harness.db.transaction(async (tx) => {
    await postMovements(tx, {
      businessId: ref.businessId,
      movements: [{ canonicalItemId, locationId, kind: 'receipt', quantityDelta: quantity }],
    });
  });
}

async function balance(
  ref: Fixture,
  locationId = ref.locationId,
  canonicalItemId = ref.canonicalItemId,
): Promise<{ onHand: number; reserved: number } | undefined> {
  const [row] = await harness.db
    .select({ onHand: locationBalances.onHand, reserved: locationBalances.reserved })
    .from(locationBalances)
    .where(
      and(
        eq(locationBalances.businessId, ref.businessId),
        eq(locationBalances.canonicalItemId, canonicalItemId),
        eq(locationBalances.locationId, locationId),
      ),
    );

  return row;
}

function line(
  ref: Fixture,
  overrides: Partial<Parameters<typeof reserve>[1]> = {},
): Parameters<typeof reserve>[1] {
  return {
    businessId: ref.businessId,
    connectionId: ref.connectionId,
    externalOrderId: 'order-1',
    externalLineId: 'line-1',
    canonicalItemId: ref.canonicalItemId,
    quantity: 1,
    ...overrides,
  };
}

describe('reserving until fulfilled', () => {
  it('marks the units as spoken for without moving them', async () => {
    // Reserving is not a stock movement. The units are still on the shelf.
    const ref = await seed();

    await stock(ref, 10);
    const result = await reserve(harness.db, line(ref, { quantity: 3 }));

    expect(result).toMatchObject({
      outcome: 'reserved',
      reservation: { allocated: 3, shortage: 0, consumptionMode: 'reserve_until_fulfilled' },
    });
    await expect(balance(ref)).resolves.toMatchObject({ onHand: 10, reserved: 3 });
    await expect(readTimeline(harness.db, ref)).resolves.toHaveLength(1);
  });

  it('takes the reserved units out of what can be sold again', async () => {
    const ref = await seed();

    await stock(ref, 5);
    await reserve(harness.db, line(ref, { quantity: 4 }));

    const second = await reserve(harness.db, line(ref, { externalLineId: 'line-2', quantity: 3 }));

    expect(second).toMatchObject({ reservation: { allocated: 1, shortage: 2 } });
  });

  it('ships the reserved units, which is when they leave', async () => {
    const ref = await seed();

    await stock(ref, 6);
    const reserved = await reserve(harness.db, line(ref, { quantity: 2 }));
    const reservationId = reserved.outcome === 'reserved' ? reserved.reservation.reservationId : '';

    await expect(
      fulfillReservation(harness.db, { businessId: ref.businessId, reservationId }),
    ).resolves.toEqual({ outcome: 'fulfilled' });

    await expect(balance(ref)).resolves.toMatchObject({ onHand: 4, reserved: 0 });

    const [latest] = await readTimeline(harness.db, ref);
    expect(latest).toMatchObject({ kind: 'shipment', quantityDelta: -2 });
  });

  it('returns the units to the same location on cancellation', async () => {
    // Section 11: exact allocations are retained so a cancellation restores the
    // same locations, rather than being recomputed against a priority list that
    // may have changed since.
    const ref = await seed();

    await stock(ref, 3);
    const reserved = await reserve(harness.db, line(ref, { quantity: 3 }));
    const reservationId = reserved.outcome === 'reserved' ? reserved.reservation.reservationId : '';

    await expect(
      releaseReservation(harness.db, {
        businessId: ref.businessId,
        reservationId,
        reason: 'cancelled by the customer',
      }),
    ).resolves.toMatchObject({ outcome: 'released', restored: 3 });

    await expect(balance(ref)).resolves.toMatchObject({ onHand: 3, reserved: 0 });
  });

  it('refuses a release with no stated reason', async () => {
    const ref = await seed();

    await stock(ref, 1);
    const reserved = await reserve(harness.db, line(ref));

    await expect(
      releaseReservation(harness.db, {
        businessId: ref.businessId,
        reservationId: reserved.outcome === 'reserved' ? reserved.reservation.reservationId : '',
        reason: '  ',
      }),
    ).resolves.toMatchObject({ outcome: 'invalid' });
  });
});

describe('consuming immediately', () => {
  it('takes the units out of on-hand at once, with no reserved balance', async () => {
    const ref = await seed();

    await switchConsumptionMode(harness.db, {
      businessId: ref.businessId,
      to: 'consume_immediately',
    });
    await stock(ref, 8);
    await reserve(harness.db, line(ref, { quantity: 3 }));

    await expect(balance(ref)).resolves.toMatchObject({ onHand: 5, reserved: 0 });
  });

  it('restores a cancellation as a reversal of the entry that consumed it', async () => {
    // One event corrected, rather than a sale followed by an unexplained
    // delivery.
    const ref = await seed();

    await switchConsumptionMode(harness.db, {
      businessId: ref.businessId,
      to: 'consume_immediately',
    });
    await stock(ref, 4);
    const reserved = await reserve(harness.db, line(ref, { quantity: 2 }));

    await releaseReservation(harness.db, {
      businessId: ref.businessId,
      reservationId: reserved.outcome === 'reserved' ? reserved.reservation.reservationId : '',
      reason: 'cancelled before dispatch',
    });

    await expect(balance(ref)).resolves.toMatchObject({ onHand: 4, reserved: 0 });

    const [latest] = await harness.db
      .select({ kind: inventoryLedger.kind, reversalOfId: inventoryLedger.reversalOfId })
      .from(inventoryLedger)
      .where(eq(inventoryLedger.canonicalItemId, ref.canonicalItemId))
      .orderBy(desc(inventoryLedger.recordedAt))
      .limit(1);

    expect(latest?.kind).toBe('reversal');
    expect(latest?.reversalOfId).not.toBeNull();
  });
});

describe('an order that cannot be filled', () => {
  it('is still recorded, with the shortage written down', async () => {
    // Section 11: record every valid order even when insufficient stock exists.
    // The customer has bought something either way.
    const ref = await seed();

    await stock(ref, 2);
    const result = await reserve(harness.db, line(ref, { quantity: 5 }));

    expect(result).toMatchObject({
      outcome: 'reserved',
      reservation: { quantity: 5, allocated: 2, shortage: 3 },
    });
    await expect(balance(ref)).resolves.toMatchObject({ onHand: 2, reserved: 2 });
  });

  it('records a shortage of the whole line when there is nothing at all', async () => {
    const ref = await seed();

    const result = await reserve(harness.db, line(ref, { quantity: 4 }));

    expect(result).toMatchObject({ reservation: { allocated: 0, shortage: 4, allocations: [] } });
  });

  it('flags the allocation conflict when splitting would have filled it', async () => {
    // Section 9: no single location can fulfil and splitting is disabled.
    const ref = await seed();

    await stock(ref, 3);
    await stock(ref, 4, ref.otherLocationId);

    const result = await reserve(harness.db, line(ref, { quantity: 6 }));

    expect(result).toMatchObject({
      reservation: { allocated: 4, shortage: 2, splitBlocked: true },
    });
  });

  it('fills it from two locations once splitting is enabled', async () => {
    const ref = await seed();

    await updateSettings(harness.db, { businessId: ref.businessId, splitFulfillment: true });
    await stock(ref, 3);
    await stock(ref, 4, ref.otherLocationId);

    const result = await reserve(harness.db, line(ref, { quantity: 6 }));

    expect(result).toMatchObject({
      reservation: { allocated: 6, shortage: 0, splitBlocked: false },
    });
    await expect(balance(ref)).resolves.toMatchObject({ reserved: 3 });
    await expect(balance(ref, ref.otherLocationId)).resolves.toMatchObject({ reserved: 3 });
  });
});

describe('safety stock', () => {
  it('is not available to an order', async () => {
    const ref = await seed();

    await updateSettings(harness.db, { businessId: ref.businessId, defaultSafetyStock: 2 });
    await stock(ref, 5);

    const result = await reserve(harness.db, line(ref, { quantity: 5 }));

    expect(result).toMatchObject({ reservation: { allocated: 3, shortage: 2 } });
  });
});

describe('a kit line', () => {
  async function kitFixture(ref: Fixture): Promise<{ kitId: string; boltId: string }> {
    const kit = await createCanonicalItem(harness.db, {
      businessId: ref.businessId,
      sku: `${ref.slug}-kit`,
      name: 'Kit',
    });
    const bolt = await createCanonicalItem(harness.db, {
      businessId: ref.businessId,
      sku: `${ref.slug}-bolt`,
      name: 'Bolt',
    });
    const kitId = kit.outcome === 'created' ? kit.canonicalItemId : '';
    const boltId = bolt.outcome === 'created' ? bolt.canonicalItemId : '';

    await declareKit(harness.db, { businessId: ref.businessId, canonicalItemId: kitId });
    const drafted = await draftRecipe(harness.db, {
      businessId: ref.businessId,
      kitCanonicalItemId: kitId,
      components: [{ canonicalItemId: boltId, requiredQuantity: 2 }],
    });
    await approveRecipe(harness.db, {
      businessId: ref.businessId,
      recipeId: drafted.outcome === 'drafted' ? drafted.recipeId : '',
      approvedByUserId: ref.userId,
    });

    return { kitId, boltId };
  }

  it('allocates the components rather than the kit', async () => {
    // A kit has no independent physical stock, so there is nothing else it
    // could take.
    const ref = await seed();
    const { kitId, boltId } = await kitFixture(ref);

    await stock(ref, 10, ref.locationId, boltId);

    const result = await reserve(harness.db, line(ref, { canonicalItemId: kitId, quantity: 3 }));

    expect(result).toMatchObject({
      reservation: {
        allocated: 3,
        allocations: [{ canonicalItemId: boltId, quantity: 6 }],
      },
    });
    await expect(balance(ref, ref.locationId, boltId)).resolves.toMatchObject({ reserved: 6 });
  });

  it('is bounded by the component that runs out first', async () => {
    const ref = await seed();
    const { kitId, boltId } = await kitFixture(ref);

    await stock(ref, 5, ref.locationId, boltId);

    const result = await reserve(harness.db, line(ref, { canonicalItemId: kitId, quantity: 4 }));

    // Five bolts make two kits, with one bolt left over.
    expect(result).toMatchObject({ reservation: { allocated: 2, shortage: 2 } });
  });

  it('cannot be ordered without a recipe in force', async () => {
    const ref = await seed();
    const kit = await createCanonicalItem(harness.db, {
      businessId: ref.businessId,
      sku: `${ref.slug}-norecipe`,
      name: 'Kit',
    });
    const kitId = kit.outcome === 'created' ? kit.canonicalItemId : '';

    await declareKit(harness.db, { businessId: ref.businessId, canonicalItemId: kitId });

    await expect(reserve(harness.db, line(ref, { canonicalItemId: kitId }))).resolves.toEqual({
      outcome: 'not_found',
    });
  });
});

describe('idempotency', () => {
  it('does not decrement twice when an order line is redelivered', async () => {
    // Section 12: a replayed event returns the prior outcome without an
    // additional mutation, and a database constraint is what enforces it.
    const ref = await seed();

    await stock(ref, 10);
    const first = await reserve(harness.db, line(ref, { quantity: 4 }));
    const second = await reserve(harness.db, line(ref, { quantity: 4 }));

    expect(second.outcome).toBe('already_recorded');
    expect(second.outcome === 'already_recorded' ? second.reservation.reservationId : '').toBe(
      first.outcome === 'reserved' ? first.reservation.reservationId : '',
    );
    await expect(balance(ref)).resolves.toMatchObject({ onHand: 10, reserved: 4 });
  });

  it('does not re-reserve after a release', async () => {
    // A cancellation followed by a redelivery of the original order must not
    // reserve the units a second time.
    const ref = await seed();

    await stock(ref, 5);
    const reserved = await reserve(harness.db, line(ref, { quantity: 2 }));

    await releaseReservation(harness.db, {
      businessId: ref.businessId,
      reservationId: reserved.outcome === 'reserved' ? reserved.reservation.reservationId : '',
      reason: 'cancelled',
    });

    const replay = await reserve(harness.db, line(ref, { quantity: 2 }));

    expect(replay).toMatchObject({ outcome: 'already_recorded' });
    await expect(balance(ref)).resolves.toMatchObject({ onHand: 5, reserved: 0 });
  });

  it('does not fulfil the same reservation twice', async () => {
    const ref = await seed();

    await stock(ref, 4);
    const reserved = await reserve(harness.db, line(ref, { quantity: 2 }));
    const reservationId = reserved.outcome === 'reserved' ? reserved.reservation.reservationId : '';

    await fulfillReservation(harness.db, { businessId: ref.businessId, reservationId });

    await expect(
      fulfillReservation(harness.db, { businessId: ref.businessId, reservationId }),
    ).resolves.toEqual({ outcome: 'already_resolved', status: 'consumed' });
    await expect(balance(ref)).resolves.toMatchObject({ onHand: 2 });
  });

  it('does not touch a reservation in another business', async () => {
    const ref = await seed();
    const stranger = await seed();

    await stock(ref, 4);
    const reserved = await reserve(harness.db, line(ref, { quantity: 2 }));

    await expect(
      releaseReservation(harness.db, {
        businessId: stranger.businessId,
        reservationId: reserved.outcome === 'reserved' ? reserved.reservation.reservationId : '',
        reason: 'not mine',
      }),
    ).resolves.toEqual({ outcome: 'not_found' });
  });
});

describe('the last unit', () => {
  it('is reserved once when two orders race for it', async () => {
    // Section 12: simultaneous sales serialize through the canonical row lock,
    // and the first committed allocation gets the stock.
    const ref = await seed();

    await stock(ref, 1);

    const results = await Promise.all([
      reserve(harness.db, line(ref, { externalLineId: 'race-a' })),
      reserve(harness.db, line(ref, { externalLineId: 'race-b' })),
    ]);

    // Both orders are recorded. One is filled and the other becomes a shortage;
    // neither raises, because the second transaction waits on the first's row
    // lock and then plans against what is actually left.
    expect(results.every((result) => result.outcome === 'reserved')).toBe(true);

    const allocated = results.map((result) =>
      result.outcome === 'reserved' ? result.reservation.allocated : -1,
    );

    expect(allocated.filter((count) => count === 1)).toHaveLength(1);
    expect(allocated.filter((count) => count === 0)).toHaveLength(1);
    await expect(balance(ref)).resolves.toMatchObject({ onHand: 1, reserved: 1 });
  });

  it('is reserved once even when ten orders arrive together', async () => {
    // One unit, ten simultaneous buyers. The invariant that matters is that
    // reserved never exceeds on-hand, which is also what the database refuses.
    const ref = await seed();

    await stock(ref, 1);

    const results = await Promise.all(
      Array.from({ length: 10 }, async (_unused, index) =>
        reserve(harness.db, line(ref, { externalLineId: `crowd-${String(index)}` })),
      ),
    );

    const filled = results.filter(
      (result) => result.outcome === 'reserved' && result.reservation.allocated === 1,
    );

    expect(filled).toHaveLength(1);
    await expect(balance(ref)).resolves.toMatchObject({ onHand: 1, reserved: 1 });
  });
});

describe('switching consumption mode', () => {
  it('reports the impact and refuses while reservations are open', async () => {
    // Section 11: an impact preview and either no open reservations or a
    // confirmed migration.
    const ref = await seed();

    await stock(ref, 5);
    await reserve(harness.db, line(ref, { quantity: 2 }));

    const preview = await previewModeSwitch(harness.db, {
      businessId: ref.businessId,
      to: 'consume_immediately',
    });

    expect(preview).toMatchObject({
      from: 'reserve_until_fulfilled',
      to: 'consume_immediately',
      openReservations: 1,
      reservedUnits: 2,
    });

    await expect(
      switchConsumptionMode(harness.db, {
        businessId: ref.businessId,
        to: 'consume_immediately',
      }),
    ).resolves.toMatchObject({ outcome: 'needs_migration' });
  });

  it('migrates the open reservations when told to', async () => {
    const ref = await seed();

    await stock(ref, 5);
    await reserve(harness.db, line(ref, { quantity: 2 }));

    await expect(
      switchConsumptionMode(harness.db, {
        businessId: ref.businessId,
        to: 'consume_immediately',
        migrateOpenReservations: true,
      }),
    ).resolves.toEqual({ outcome: 'switched' });

    // The reserved units became a real decrement, which is the whole reason
    // section 11 will not let this happen without someone agreeing to it.
    await expect(balance(ref)).resolves.toMatchObject({ onHand: 3, reserved: 0 });
  });

  it('switches freely when nothing is open', async () => {
    const ref = await seed();

    await expect(
      switchConsumptionMode(harness.db, {
        businessId: ref.businessId,
        to: 'consume_immediately',
      }),
    ).resolves.toEqual({ outcome: 'switched' });
    await expect(
      switchConsumptionMode(harness.db, {
        businessId: ref.businessId,
        to: 'consume_immediately',
      }),
    ).resolves.toEqual({ outcome: 'unchanged' });
  });

  it('leaves a migrated reservation cancellable', async () => {
    const ref = await seed();

    await stock(ref, 5);
    const reserved = await reserve(harness.db, line(ref, { quantity: 2 }));
    const reservationId = reserved.outcome === 'reserved' ? reserved.reservation.reservationId : '';

    await switchConsumptionMode(harness.db, {
      businessId: ref.businessId,
      to: 'consume_immediately',
      migrateOpenReservations: true,
    });

    await expect(
      releaseReservation(harness.db, {
        businessId: ref.businessId,
        reservationId,
        reason: 'cancelled after the mode changed',
      }),
    ).resolves.toMatchObject({ outcome: 'released' });
    await expect(balance(ref)).resolves.toMatchObject({ onHand: 5, reserved: 0 });
  });
});

describe('reading back', () => {
  it('lists the open reservations drawing on one item', async () => {
    const ref = await seed();

    await stock(ref, 9);
    await reserve(harness.db, line(ref, { quantity: 2 }));
    await reserve(harness.db, line(ref, { externalLineId: 'line-2', quantity: 3 }));

    const open = await openReservationsForItem(harness.db, {
      businessId: ref.businessId,
      canonicalItemId: ref.canonicalItemId,
    });

    expect(open.map((row) => row.quantity).sort()).toEqual([2, 3]);
  });

  it('reports nothing for a reservation in another business', async () => {
    const ref = await seed();
    const stranger = await seed();

    await stock(ref, 2);
    const reserved = await reserve(harness.db, line(ref));

    await expect(
      readReservation(harness.db, {
        businessId: stranger.businessId,
        reservationId: reserved.outcome === 'reserved' ? reserved.reservation.reservationId : '',
      }),
    ).resolves.toBeNull();
  });
});
