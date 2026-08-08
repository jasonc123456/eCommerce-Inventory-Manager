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

import { ingestOrder, type NormalizedOrder } from './orders';
import { readTarget } from './targets';

/**
 * Order ingestion (sections 11, 12, 15).
 *
 * Everything here needs a real database, because what is being proven is that
 * a replay changes nothing, that a stale delivery cannot roll a status back,
 * and that a line with nowhere to put its demand still gets recorded — all of
 * which are statements about rows and constraints rather than about functions.
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

async function seed(options: { onHand?: number; activate?: boolean } = {}): Promise<Fixture> {
  const slug = `ord-${String((counter += 1))}`;
  const onHand = options.onHand ?? 10;

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
      // Zero at activation time: section 7 blocks activation while the store's
      // figure and the ledger disagree, and the ledger is still empty here.
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
  if (options.activate !== false) {
    await activateMapping(harness.db, { businessId, mappingId, actorUserId: userId });
  }

  if (onHand > 0) {
    await harness.db.transaction(async (tx) => {
      await postMovements(tx, {
        businessId,
        actorUserId: userId,
        movements: [{ canonicalItemId, locationId, kind: 'receipt', quantityDelta: onHand }],
      });
    });
  }

  return { businessId, connectionId, canonicalItemId, locationId, mappingId, externalId, userId };
}

function orderOf(
  fixture: Fixture,
  overrides: Partial<NormalizedOrder> & { readonly quantity?: number } = {},
): NormalizedOrder {
  return {
    externalOrderId: overrides.externalOrderId ?? 'wc-1001',
    providerStatus: overrides.providerStatus ?? 'processing',
    demandState: overrides.demandState ?? 'committed',
    placedAt: new Date('2026-08-08T09:00:00.000Z'),
    lines: overrides.lines ?? [
      {
        externalLineId: 'line-1',
        externalItemId: fixture.externalId,
        sku: 'widget',
        quantity: overrides.quantity ?? 3,
      },
    ],
    ...(overrides.providerSequence === undefined
      ? {}
      : { providerSequence: overrides.providerSequence }),
  };
}

function eventFor(fixture: Fixture, id: string) {
  return {
    connectionId: fixture.connectionId,
    businessId: fixture.businessId,
    provider: 'woocommerce',
    source: 'webhook' as const,
    eventType: 'order.updated',
    resourceType: 'order',
    resourceId: 'wc-1001',
    externalEventId: id,
  };
}

async function ingest(
  fixture: Fixture,
  order: NormalizedOrder,
  eventId: string,
): Promise<Awaited<ReturnType<typeof ingestOrder>>> {
  return harness.db.transaction(async (tx) =>
    ingestOrder(tx, {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      order,
      event: eventFor(fixture, eventId),
      actorUserId: fixture.userId,
    }),
  );
}

async function onHandOf(fixture: Fixture): Promise<number> {
  const rows = await harness.db.execute<{ on_hand: number; reserved: number }>(sql`
    select on_hand, reserved from location_balances
     where business_id = ${fixture.businessId}::uuid
       and canonical_item_id = ${fixture.canonicalItemId}::uuid
  `);

  return rows.rows[0]?.on_hand ?? 0;
}

async function reservedOf(fixture: Fixture): Promise<number> {
  const rows = await harness.db.execute<{ reserved: number }>(sql`
    select reserved from location_balances
     where business_id = ${fixture.businessId}::uuid
       and canonical_item_id = ${fixture.canonicalItemId}::uuid
  `);

  return rows.rows[0]?.reserved ?? 0;
}

describe('ingestOrder', () => {
  it('commits inventory once, however many times the order is redelivered', async () => {
    // The duplicate-order case from the exit gate. A provider that resends
    // "processing" four times has not sold four orders.
    const fixture = await seed();

    const first = await ingest(fixture, orderOf(fixture), 'evt-1');
    const replay = await ingest(fixture, orderOf(fixture), 'evt-1');
    const resend = await ingest(fixture, orderOf(fixture), 'evt-2');

    expect(first.outcome).toBe('ingested');
    expect(replay.outcome).toBe('already_processed');
    expect(resend).toMatchObject({ outcome: 'ingested', committed: false });
    expect(await reservedOf(fixture)).toBe(3);
  });

  it('returns the earlier answer on a replay rather than recomputing it', async () => {
    const fixture = await seed();
    const first = await ingest(fixture, orderOf(fixture), 'evt-1');
    const replay = await ingest(fixture, orderOf(fixture), 'evt-1');

    expect(replay.outcome).toBe('already_processed');
    if (replay.outcome === 'already_processed' && first.outcome === 'ingested') {
      expect((replay.prior as { orderId: string }).orderId).toBe(first.orderId);
    }
  });

  it('discards a delivery that arrives after a newer one', async () => {
    // Section 12: "provider revisions/sequences take precedence over arrival
    // order." A webhook overtaking its predecessor must not roll a status back.
    const fixture = await seed();

    await ingest(
      fixture,
      orderOf(fixture, { providerSequence: 5, providerStatus: 'completed' }),
      'evt-new',
    );
    const stale = await ingest(
      fixture,
      orderOf(fixture, { providerSequence: 2, providerStatus: 'pending', demandState: 'awaiting' }),
      'evt-old',
    );

    expect(stale.outcome).toBe('superseded');

    const rows = await harness.db.execute<{ demand_state: string; provider_status: string }>(sql`
      select demand_state, provider_status from channel_orders
       where connection_id = ${fixture.connectionId}::uuid
    `);

    expect(rows.rows[0]).toMatchObject({ demand_state: 'committed', provider_status: 'completed' });
  });

  it('records an order that has not qualified without touching stock', async () => {
    const fixture = await seed();

    const result = await ingest(
      fixture,
      orderOf(fixture, { demandState: 'awaiting', providerStatus: 'pending' }),
      'evt-1',
    );

    expect(result).toMatchObject({ outcome: 'ingested', committed: false });
    expect(await reservedOf(fixture)).toBe(0);
    expect(await onHandOf(fixture)).toBe(10);
  });

  it('stores a line it cannot map, and says so', async () => {
    // Section 15: "raise an action-required warning identifying each line that
    // received no canonical inventory treatment." Dropping the line would leave
    // an order that does not add up.
    const fixture = await seed();

    const result = await ingest(
      fixture,
      orderOf(fixture, {
        lines: [
          { externalLineId: 'line-1', externalItemId: fixture.externalId, quantity: 2 },
          { externalLineId: 'line-2', externalItemId: 'product-nobody-mapped', quantity: 1 },
        ],
      }),
      'evt-1',
    );

    expect(result.outcome).toBe('ingested');
    if (result.outcome !== 'ingested') {
      return;
    }

    expect(result.needsAttention).toHaveLength(1);
    expect(result.needsAttention[0]).toMatchObject({
      externalLineId: 'line-2',
      treatment: 'unmapped',
    });
    // Section 15: an ineligible line does not stop its neighbours protecting
    // inventory.
    expect(await reservedOf(fixture)).toBe(2);
  });

  it('records a line whose mapping is not active as ineligible', async () => {
    const fixture = await seed({ activate: false });

    const result = await ingest(fixture, orderOf(fixture), 'evt-1');

    expect(result.outcome).toBe('ingested');
    if (result.outcome !== 'ingested') {
      return;
    }

    expect(result.lines[0]).toMatchObject({
      treatment: 'ineligible',
      reason: 'this mapping has not been activated',
    });
    expect(await reservedOf(fixture)).toBe(0);
  });

  it('allocates what exists and records the rest as a shortage', async () => {
    // Section 11's oversold rule: allocate available units, record the shortage
    // explicitly, target zero on the affected channel, never auto-cancel.
    const fixture = await seed({ onHand: 2 });

    const result = await ingest(fixture, orderOf(fixture, { quantity: 5 }), 'evt-1');

    expect(result.outcome).toBe('ingested');
    if (result.outcome !== 'ingested') {
      return;
    }

    // One unit is withheld by the default safety stock, so one is allocatable.
    expect(result.shortages).toBeGreaterThan(0);
    expect(result.lines[0]?.treatment).toBe('reserved');

    const target = await readTarget(harness.db, fixture.mappingId);
    expect(target?.desiredQuantity).toBe(0);
  });

  it('queues a channel write for every mapping the order touched', async () => {
    const fixture = await seed();

    await ingest(fixture, orderOf(fixture), 'evt-1');

    const target = await readTarget(harness.db, fixture.mappingId);
    // Ten on hand, three reserved, one withheld by safety stock.
    expect(target?.desiredQuantity).toBe(6);

    const jobs = await harness.db.execute<{ count: string }>(sql`
      select count(*)::text as count from background_jobs
       where business_id = ${fixture.businessId}::uuid and kind = 'channel.write'
    `);

    expect(jobs.rows[0]?.count).toBe('1');
  });

  it('takes the whole order with it when the transaction fails', async () => {
    const fixture = await seed();

    await expect(
      harness.db.transaction(async (tx) => {
        await ingestOrder(tx, {
          businessId: fixture.businessId,
          connectionId: fixture.connectionId,
          order: orderOf(fixture),
          event: eventFor(fixture, 'evt-1'),
        });
        throw new Error('something later in the transaction failed');
      }),
    ).rejects.toThrow('something later');

    const orders = await harness.db.execute<{ count: string }>(
      sql`select count(*)::text as count from channel_orders where connection_id = ${fixture.connectionId}::uuid`,
    );
    const events = await harness.db.execute<{ count: string }>(
      sql`select count(*)::text as count from processed_events where connection_id = ${fixture.connectionId}::uuid`,
    );

    expect(orders.rows[0]?.count).toBe('0');
    // The event record went with it, so the retry is not mistaken for a replay
    // of work that never happened.
    expect(events.rows[0]?.count).toBe('0');
    expect(await reservedOf(fixture)).toBe(0);
  });

  it('serializes two workers racing the same order to one commitment', async () => {
    // The simultaneous-last-unit case, at the order boundary rather than the
    // ledger's: two deliveries of one order, two transactions, one reservation.
    const fixture = await seed();

    const results = await Promise.all([
      ingest(fixture, orderOf(fixture), 'evt-a'),
      ingest(fixture, orderOf(fixture), 'evt-b'),
    ]);

    const committed = results.filter((result) => result.outcome === 'ingested' && result.committed);

    expect(committed).toHaveLength(1);
    expect(await reservedOf(fixture)).toBe(3);
  });
});
