import { operatorOrigin } from '@eim/pilot';
import { businesses, connections, providerItems, users } from '@eim/db';
import {
  activateMapping,
  approveMapping,
  createCanonicalItem,
  createLocation,
  postMovements,
  proposeMapping,
} from '@eim/inventory';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  applyCancellation,
  applyFulfillment,
  applyRefund,
  confirmRestock,
  declineRestock,
} from './lifecycle';
import { ingestOrder, type NormalizedOrder } from './orders';
import { readTarget } from './targets';

/**
 * What happens to committed demand afterwards (section 11).
 *
 * The line these tests exist to hold is the one between money and goods: a
 * refund is not a receipt, and a shipped unit does not come back because a
 * customer was reimbursed. Everything else here is a consequence of that.
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
  const slug = `life-${String((counter += 1))}`;

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
      provider: 'woocommerce',
      environment: 'production',
      externalAccountId: `store-${slug}`,
      displayName: 'Test store',
      status: 'active',
    })
    .returning({ id: connections.id });

  const connectionId = connection!.id;
  const location = await createLocation(harness.db, { businessId, code: 'MAIN', name: 'Main' });
  const locationId = location.outcome === 'created' ? location.locationId : '';
  const item = await createCanonicalItem(harness.db, { businessId, sku: slug, name: 'Widget' });
  const canonicalItemId = item.outcome === 'created' ? item.canonicalItemId : '';

  const externalId = `product-${slug}`;
  const [providerItem] = await harness.db
    .insert(providerItems)
    .values({
      businessId,
      connectionId,
      externalId,
      title: 'Widget',
      kind: 'product',
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
  });

  return { businessId, connectionId, canonicalItemId, locationId, mappingId, externalId, userId };
}

function eventFor(fixture: Fixture, id: string, type = 'order.updated') {
  return {
    connectionId: fixture.connectionId,
    businessId: fixture.businessId,
    provider: 'woocommerce',
    source: 'webhook' as const,
    eventType: type,
    resourceType: 'order',
    resourceId: 'wc-2001',
    externalEventId: id,
  };
}

async function placeOrder(fixture: Fixture, quantity = 3): Promise<void> {
  const order: NormalizedOrder = {
    externalOrderId: 'wc-2001',
    providerStatus: 'processing',
    demandState: 'committed',
    lines: [{ externalLineId: 'line-1', externalItemId: fixture.externalId, quantity }],
  };

  await harness.db.transaction(async (tx) => {
    await ingestOrder(tx, {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      order,
      event: eventFor(fixture, 'evt-place'),
      actorUserId: fixture.userId,
      changeOrigin: operatorOrigin('manual'),
    });
  });
}

async function balance(fixture: Fixture): Promise<{ onHand: number; reserved: number }> {
  const rows = await harness.db.execute<{ on_hand: number; reserved: number }>(sql`
    select on_hand, reserved from location_balances
     where business_id = ${fixture.businessId}::uuid
       and canonical_item_id = ${fixture.canonicalItemId}::uuid
  `);

  return { onHand: rows.rows[0]?.on_hand ?? 0, reserved: rows.rows[0]?.reserved ?? 0 };
}

async function candidatesOf(fixture: Fixture) {
  const rows = await harness.db.execute<{
    id: string;
    origin: string;
    status: string;
    claimed_quantity: number;
  }>(sql`
    select id, origin, status, claimed_quantity from restock_candidates
     where business_id = ${fixture.businessId}::uuid
     order by created_at
  `);

  return rows.rows;
}

describe('applyCancellation', () => {
  it('gives unshipped units back and tells the channel', async () => {
    const fixture = await seed();
    await placeOrder(fixture);

    expect(await balance(fixture)).toEqual({ onHand: 10, reserved: 3 });

    const result = await harness.db.transaction(async (tx) =>
      applyCancellation(tx, {
        businessId: fixture.businessId,
        connectionId: fixture.connectionId,
        externalOrderId: 'wc-2001',
        event: eventFor(fixture, 'evt-cancel', 'order.cancelled'),
        reason: 'the customer changed their mind',
        actorUserId: fixture.userId,
        changeOrigin: operatorOrigin('manual'),
      }),
    );

    expect(result.outcome).toBe('applied');
    if (result.outcome === 'applied') {
      expect(result.lines[0]).toMatchObject({ effect: 'released', quantity: 3 });
    }

    expect(await balance(fixture)).toEqual({ onHand: 10, reserved: 0 });
    // Nine, not ten: the default safety stock still withholds one unit.
    expect((await readTarget(harness.db, fixture.mappingId))?.desiredQuantity).toBe(9);
  });

  it('refuses to restore units that have already shipped', async () => {
    // Section 11: "shipped/fulfilled inventory is not restored by cancellation
    // or financial refund alone." The goods are with a customer.
    const fixture = await seed();
    await placeOrder(fixture);

    await harness.db.transaction(async (tx) =>
      applyFulfillment(tx, {
        businessId: fixture.businessId,
        connectionId: fixture.connectionId,
        externalOrderId: 'wc-2001',
        event: eventFor(fixture, 'evt-ship', 'order.shipped'),
        reason: 'shipped',
        actorUserId: fixture.userId,
        changeOrigin: operatorOrigin('manual'),
      }),
    );

    const after = await balance(fixture);
    expect(after).toEqual({ onHand: 7, reserved: 0 });

    const result = await harness.db.transaction(async (tx) =>
      applyCancellation(tx, {
        businessId: fixture.businessId,
        connectionId: fixture.connectionId,
        externalOrderId: 'wc-2001',
        event: eventFor(fixture, 'evt-cancel', 'order.cancelled'),
        reason: 'cancelled after despatch',
        actorUserId: fixture.userId,
        changeOrigin: operatorOrigin('manual'),
      }),
    );

    expect(result.outcome).toBe('applied');
    if (result.outcome === 'applied') {
      expect(result.lines[0]?.effect).toBe('restock_candidate');
      expect(result.restockCandidates).toHaveLength(1);
    }

    // Unchanged. The units are somewhere else now.
    expect(await balance(fixture)).toEqual({ onHand: 7, reserved: 0 });
  });

  it('does nothing twice for one cancellation', async () => {
    const fixture = await seed();
    await placeOrder(fixture);

    const cancel = async (): Promise<unknown> =>
      harness.db.transaction(async (tx) =>
        applyCancellation(tx, {
          businessId: fixture.businessId,
          connectionId: fixture.connectionId,
          externalOrderId: 'wc-2001',
          event: eventFor(fixture, 'evt-cancel', 'order.cancelled'),
          reason: 'cancelled',
          actorUserId: fixture.userId,
          changeOrigin: operatorOrigin('manual'),
        }),
      );

    await cancel();
    const replay = await cancel();

    expect(replay).toMatchObject({ outcome: 'already_processed' });
    expect(await balance(fixture)).toEqual({ onHand: 10, reserved: 0 });
  });

  it('reports an order it has never heard of rather than failing', async () => {
    // A cancellation can outrun the order it cancels when two webhooks are
    // delivered out of order.
    const fixture = await seed();

    const result = await harness.db.transaction(async (tx) =>
      applyCancellation(tx, {
        businessId: fixture.businessId,
        connectionId: fixture.connectionId,
        externalOrderId: 'wc-never-seen',
        event: eventFor(fixture, 'evt-orphan', 'order.cancelled'),
        reason: 'cancelled',
        changeOrigin: operatorOrigin('manual'),
      }),
    );

    expect(result.outcome).toBe('order_unknown');
  });
});

describe('applyFulfillment', () => {
  it('takes the reserved units off hand', async () => {
    const fixture = await seed();
    await placeOrder(fixture);

    await harness.db.transaction(async (tx) =>
      applyFulfillment(tx, {
        businessId: fixture.businessId,
        connectionId: fixture.connectionId,
        externalOrderId: 'wc-2001',
        event: eventFor(fixture, 'evt-ship', 'order.shipped'),
        reason: 'shipped',
        actorUserId: fixture.userId,
        changeOrigin: operatorOrigin('manual'),
      }),
    );

    expect(await balance(fixture)).toEqual({ onHand: 7, reserved: 0 });
    // Seven on hand, none reserved, one withheld.
    expect((await readTarget(harness.db, fixture.mappingId))?.desiredQuantity).toBe(6);
  });
});

describe('applyRefund', () => {
  it('restores nothing and raises a candidate instead', async () => {
    // The rule that is tempting to get wrong. Section 11: "import the refund,
    // return, or dispute as a financial/operational event without assuming
    // physical receipt."
    const fixture = await seed();
    await placeOrder(fixture);
    await harness.db.transaction(async (tx) =>
      applyFulfillment(tx, {
        businessId: fixture.businessId,
        connectionId: fixture.connectionId,
        externalOrderId: 'wc-2001',
        event: eventFor(fixture, 'evt-ship', 'order.shipped'),
        reason: 'shipped',
        actorUserId: fixture.userId,
        changeOrigin: operatorOrigin('manual'),
      }),
    );

    const result = await harness.db.transaction(async (tx) =>
      applyRefund(tx, {
        businessId: fixture.businessId,
        connectionId: fixture.connectionId,
        externalOrderId: 'wc-2001',
        event: eventFor(fixture, 'evt-refund', 'order.refunded'),
        reason: 'refunded in full',
        origin: 'return',
        actorUserId: fixture.userId,
        changeOrigin: operatorOrigin('manual'),
      }),
    );

    expect(result.outcome).toBe('applied');
    expect(await balance(fixture)).toEqual({ onHand: 7, reserved: 0 });

    const candidates = await candidatesOf(fixture);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      origin: 'return',
      status: 'pending',
      claimed_quantity: 3,
    });
  });

  it('does not queue two decisions for one redelivered refund', async () => {
    const fixture = await seed();
    await placeOrder(fixture);

    for (const eventId of ['evt-refund-a', 'evt-refund-b']) {
      await harness.db.transaction(async (tx) =>
        applyRefund(tx, {
          businessId: fixture.businessId,
          connectionId: fixture.connectionId,
          externalOrderId: 'wc-2001',
          event: eventFor(fixture, eventId, 'order.refunded'),
          reason: 'refunded',
          actorUserId: fixture.userId,
          changeOrigin: operatorOrigin('manual'),
        }),
      );
    }

    expect(await candidatesOf(fixture)).toHaveLength(1);
  });
});

describe('confirmRestock', () => {
  it('puts back what an authorized person says arrived', async () => {
    const fixture = await seed();
    await placeOrder(fixture);
    await harness.db.transaction(async (tx) =>
      applyFulfillment(tx, {
        businessId: fixture.businessId,
        connectionId: fixture.connectionId,
        externalOrderId: 'wc-2001',
        event: eventFor(fixture, 'evt-ship', 'order.shipped'),
        reason: 'shipped',
        actorUserId: fixture.userId,
        changeOrigin: operatorOrigin('manual'),
      }),
    );
    await harness.db.transaction(async (tx) =>
      applyRefund(tx, {
        businessId: fixture.businessId,
        connectionId: fixture.connectionId,
        externalOrderId: 'wc-2001',
        event: eventFor(fixture, 'evt-refund', 'order.refunded'),
        reason: 'returned',
        actorUserId: fixture.userId,
        changeOrigin: operatorOrigin('manual'),
      }),
    );

    const [candidate] = await candidatesOf(fixture);

    // Two of the three came back saleable. The channel claimed three; the
    // person who opened the box says two, and the person wins.
    const result = await confirmRestock(harness.db, {
      businessId: fixture.businessId,
      candidateId: candidate!.id,
      quantity: 2,
      locationId: fixture.locationId,
      actorUserId: fixture.userId,
      reason: 'one arrived damaged',
    });

    expect(result).toEqual({ outcome: 'restocked', quantity: 2 });
    expect(await balance(fixture)).toEqual({ onHand: 9, reserved: 0 });
    expect((await readTarget(harness.db, fixture.mappingId))?.desiredQuantity).toBe(8);
  });

  it('accepts zero, meaning nothing came back', async () => {
    const fixture = await seed();
    await placeOrder(fixture);
    await harness.db.transaction(async (tx) =>
      applyRefund(tx, {
        businessId: fixture.businessId,
        connectionId: fixture.connectionId,
        externalOrderId: 'wc-2001',
        event: eventFor(fixture, 'evt-refund', 'order.refunded'),
        reason: 'refunded',
        actorUserId: fixture.userId,
        changeOrigin: operatorOrigin('manual'),
      }),
    );

    const [candidate] = await candidatesOf(fixture);
    const before = await balance(fixture);

    const result = await confirmRestock(harness.db, {
      businessId: fixture.businessId,
      candidateId: candidate!.id,
      quantity: 0,
      locationId: fixture.locationId,
      actorUserId: fixture.userId,
    });

    expect(result).toEqual({ outcome: 'restocked', quantity: 0 });
    expect(await balance(fixture)).toEqual(before);
  });

  it('will not confirm the same candidate twice', async () => {
    const fixture = await seed();
    await placeOrder(fixture);
    await harness.db.transaction(async (tx) =>
      applyRefund(tx, {
        businessId: fixture.businessId,
        connectionId: fixture.connectionId,
        externalOrderId: 'wc-2001',
        event: eventFor(fixture, 'evt-refund', 'order.refunded'),
        reason: 'refunded',
        actorUserId: fixture.userId,
        changeOrigin: operatorOrigin('manual'),
      }),
    );

    const [candidate] = await candidatesOf(fixture);
    const confirm = async () =>
      confirmRestock(harness.db, {
        businessId: fixture.businessId,
        candidateId: candidate!.id,
        quantity: 1,
        locationId: fixture.locationId,
        actorUserId: fixture.userId,
      });

    await confirm();

    expect(await confirm()).toEqual({ outcome: 'already_resolved', status: 'confirmed' });
  });

  it('refuses a negative restock', async () => {
    const fixture = await seed();

    expect(
      await confirmRestock(harness.db, {
        businessId: fixture.businessId,
        candidateId: crypto.randomUUID(),
        quantity: -1,
        locationId: fixture.locationId,
        actorUserId: fixture.userId,
      }),
    ).toMatchObject({ outcome: 'invalid' });
  });

  it('reports a candidate that is not there', async () => {
    const fixture = await seed();

    expect(
      await confirmRestock(harness.db, {
        businessId: fixture.businessId,
        candidateId: crypto.randomUUID(),
        quantity: 1,
        locationId: fixture.locationId,
        actorUserId: fixture.userId,
      }),
    ).toEqual({ outcome: 'not_found' });
  });
});

describe('declineRestock', () => {
  it('closes a candidate whose goods never came back', async () => {
    const fixture = await seed();
    await placeOrder(fixture);
    await harness.db.transaction(async (tx) =>
      applyRefund(tx, {
        businessId: fixture.businessId,
        connectionId: fixture.connectionId,
        externalOrderId: 'wc-2001',
        event: eventFor(fixture, 'evt-refund', 'order.refunded'),
        reason: 'refunded',
        actorUserId: fixture.userId,
        changeOrigin: operatorOrigin('manual'),
      }),
    );

    const [candidate] = await candidatesOf(fixture);

    expect(
      await declineRestock(harness.db, {
        businessId: fixture.businessId,
        candidateId: candidate!.id,
        reason: 'the customer kept the goods',
        actorUserId: fixture.userId,
      }),
    ).toBe(true);

    expect((await candidatesOf(fixture))[0]?.status).toBe('declined');
  });
});
