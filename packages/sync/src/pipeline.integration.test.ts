import { businesses, connections, providerItems, users } from '@eim/db';
import {
  activateMapping,
  approveMapping,
  createCanonicalItem,
  createLocation,
  postMovements,
  proposeMapping,
} from '@eim/inventory';
import { claim, succeed, supersede, type ClaimedJob, type JobResult } from '@eim/jobs';
import { FakeChannelAdapter, type ProviderOrder } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ORDER_POLL_JOB,
  ORDER_SYNC_JOB,
  handleOrderPoll,
  handleOrderSync,
  requestOrderSync,
} from './pipeline';
import { readTarget } from './targets';

/**
 * One path in, whatever woke us up (section 15).
 *
 * The property being proven is that the trigger does not matter. A webhook, an
 * overlapping poll, and a person pressing a button all produce one fetch, one
 * decision, and one inventory movement — which is the only way section 15's
 * "same durable, idempotent processing pipeline" means anything.
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
  const slug = `pipe-${String((counter += 1))}`;

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

function orderOf(fixture: Fixture, overrides: Partial<ProviderOrder> = {}): ProviderOrder {
  return {
    externalOrderId: 'wc-3001',
    providerStatus: 'processing',
    demandState: 'committed',
    placedAt: new Date(),
    lines: [{ externalLineId: 'line-1', externalItemId: fixture.externalId, quantity: 3 }],
    ...overrides,
  };
}

function channelWith(fixture: Fixture, order?: ProviderOrder): FakeChannelAdapter {
  const fake = new FakeChannelAdapter({
    provider: 'woocommerce',
    initialQuantities: new Map([[fixture.externalId, 0]]),
  });

  if (order !== undefined) {
    fake.setOrder(order);
  }

  return fake;
}

async function runJob(
  kind: string,
  handler: (
    db: typeof harness.db,
    job: ClaimedJob,
    deps: { adapterFor: () => Promise<FakeChannelAdapter> },
  ) => Promise<JobResult>,
  fake: FakeChannelAdapter,
): Promise<JobResult> {
  const job = await claim(harness.db, {
    workerId: crypto.randomUUID(),
    leaseMs: 30_000,
    kinds: [kind],
  });

  if (job === null) {
    throw new Error(`no ${kind} job was queued`);
  }

  const result = await handler(harness.db, job, { adapterFor: () => Promise.resolve(fake) });

  if (result.status === 'done') {
    await succeed(harness.db, { id: job.id, attemptId: job.attemptId });
  } else {
    await supersede(harness.db, { id: job.id, attemptId: job.attemptId }, 'settled by the test');
  }

  return result;
}

async function reservedOf(fixture: Fixture): Promise<number> {
  const rows = await harness.db.execute<{ reserved: number }>(sql`
    select reserved from location_balances
     where business_id = ${fixture.businessId}::uuid
       and canonical_item_id = ${fixture.canonicalItemId}::uuid
  `);

  return rows.rows[0]?.reserved ?? 0;
}

describe('handleOrderSync', () => {
  it('fetches the order rather than trusting whatever woke it up', async () => {
    // Section 15: "treat webhook content as a signal that state may have
    // changed, not as the final inventory truth." Nothing about the quantity
    // reached this job; the adapter was asked.
    const fixture = await seed();
    const fake = channelWith(fixture, orderOf(fixture));

    await requestOrderSync(harness.db, {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      externalOrderId: 'wc-3001',
      source: 'webhook',
      externalEventId: 'wh-1',
    });

    const result = await runJob(ORDER_SYNC_JOB, handleOrderSync, fake);

    expect(result).toEqual({ status: 'done' });
    expect(fake.calls).toContain('fetchOrder');
    expect(await reservedOf(fixture)).toBe(3);
  });

  it('collapses a webhook and its overlapping poll into one fetch', async () => {
    const fixture = await seed();
    const fake = channelWith(fixture, orderOf(fixture));

    for (const source of ['webhook', 'poll', 'manual'] as const) {
      await requestOrderSync(harness.db, {
        businessId: fixture.businessId,
        connectionId: fixture.connectionId,
        externalOrderId: 'wc-3001',
        source,
      });
    }

    const jobs = await harness.db.execute<{ count: string }>(sql`
      select count(*)::text as count from background_jobs
       where business_id = ${fixture.businessId}::uuid and kind = ${ORDER_SYNC_JOB}
    `);

    expect(jobs.rows[0]?.count).toBe('1');

    await runJob(ORDER_SYNC_JOB, handleOrderSync, fake);

    expect(fake.calls.filter((call) => call === 'fetchOrder')).toHaveLength(1);
    expect(await reservedOf(fixture)).toBe(3);
  });

  it('commits once when three triggers arrive one after another', async () => {
    // The same order, re-fetched three times because three things noticed it.
    // The fetch happens each time; the commitment does not.
    const fixture = await seed();
    const fake = channelWith(fixture, orderOf(fixture));

    for (const source of ['webhook', 'poll', 'reconciliation'] as const) {
      await requestOrderSync(harness.db, {
        businessId: fixture.businessId,
        connectionId: fixture.connectionId,
        externalOrderId: 'wc-3001',
        source,
      });
      await runJob(ORDER_SYNC_JOB, handleOrderSync, fake);
    }

    expect(await reservedOf(fixture)).toBe(3);
  });

  it('follows the order into cancellation without a separate trigger', async () => {
    const fixture = await seed();
    const order = orderOf(fixture);
    const fake = channelWith(fixture, order);

    await requestOrderSync(harness.db, {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      externalOrderId: 'wc-3001',
      source: 'webhook',
    });
    await runJob(ORDER_SYNC_JOB, handleOrderSync, fake);

    expect(await reservedOf(fixture)).toBe(3);

    // The store now reports the order as cancelled. One trigger, one fetch, and
    // the state it finds decides what happens.
    fake.setOrder({ ...order, demandState: 'cancelled', providerStatus: 'cancelled' });

    await requestOrderSync(harness.db, {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      externalOrderId: 'wc-3001',
      source: 'webhook',
    });
    await runJob(ORDER_SYNC_JOB, handleOrderSync, fake);

    expect(await reservedOf(fixture)).toBe(0);
  });

  it('stands down for an order the provider no longer has', async () => {
    // A cancellation webhook for an order the store has since deleted is a real
    // sequence, and there is nothing to import and nothing to fix.
    const fixture = await seed();
    const fake = channelWith(fixture);

    await requestOrderSync(harness.db, {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      externalOrderId: 'wc-vanished',
      source: 'webhook',
    });

    const result = await runJob(ORDER_SYNC_JOB, handleOrderSync, fake);

    expect(result.status).toBe('superseded');
  });

  it('projects the new quantity to every channel it touched', async () => {
    const fixture = await seed();
    const fake = channelWith(fixture, orderOf(fixture));

    await requestOrderSync(harness.db, {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      externalOrderId: 'wc-3001',
      source: 'webhook',
    });
    await runJob(ORDER_SYNC_JOB, handleOrderSync, fake);

    // Ten on hand, three reserved, one withheld.
    expect((await readTarget(harness.db, fixture.mappingId))?.desiredQuantity).toBe(6);
  });
});

describe('handleOrderPoll', () => {
  it('queues a fetch for everything the sweep found and advances the watermark', async () => {
    const fixture = await seed();
    const fake = channelWith(fixture, orderOf(fixture));
    fake.setOrder(orderOf(fixture, { externalOrderId: 'wc-3002' }));

    await harness.db.execute(sql`
      insert into background_jobs (business_id, connection_id, kind, expires_at)
      values (${fixture.businessId}::uuid, ${fixture.connectionId}::uuid, ${ORDER_POLL_JOB},
              now() + interval '1 hour')
    `);

    const result = await runJob(ORDER_POLL_JOB, handleOrderPoll, fake);

    expect(result).toEqual({ status: 'done' });

    const queued = await harness.db.execute<{ count: string }>(sql`
      select count(*)::text as count from background_jobs
       where business_id = ${fixture.businessId}::uuid and kind = ${ORDER_SYNC_JOB}
    `);
    expect(queued.rows[0]?.count).toBe('2');

    const cursor = await harness.db.execute<{ cursor_value: string }>(sql`
      select cursor_value from connection_cursors
       where connection_id = ${fixture.connectionId}::uuid and stream = 'orders'
    `);
    expect(cursor.rows[0]?.cursor_value).toBeDefined();
  });

  it('leaves the watermark alone when the sweep fails', async () => {
    // A watermark advanced past a page that was never read is a permanent gap:
    // the orders in it are never seen again by any poll.
    const fixture = await seed();
    const fake = channelWith(fixture).failNext({
      status: 'unavailable',
      message: 'the store did not answer',
    });

    await harness.db.execute(sql`
      insert into background_jobs (business_id, connection_id, kind, expires_at)
      values (${fixture.businessId}::uuid, ${fixture.connectionId}::uuid, ${ORDER_POLL_JOB},
              now() + interval '1 hour')
    `);

    const result = await runJob(ORDER_POLL_JOB, handleOrderPoll, fake);

    expect(result).toMatchObject({ status: 'failed', retryable: true });

    const cursor = await harness.db.execute<{ count: string }>(sql`
      select count(*)::text as count from connection_cursors
       where connection_id = ${fixture.connectionId}::uuid and stream = 'orders'
    `);
    expect(cursor.rows[0]?.count).toBe('0');
  });
});
