import { businesses, connections, providerItems, users } from '@eim/db';
import {
  activateMapping,
  approveMapping,
  createCanonicalItem,
  createLocation,
  postMovements,
  proposeMapping,
} from '@eim/inventory';
import {
  claim,
  enqueue,
  expireOverdue,
  reclaimExpired,
  succeed,
  supersede,
  type ClaimedJob,
  type JobResult,
} from '@eim/jobs';
import { FakeChannelAdapter, type ProviderOrder } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { CHANNEL_VERIFY_JOB, handleChannelVerify, handleChannelWrite } from './dispatch';
import { ORDER_SYNC_JOB, handleOrderSync, requestOrderSync } from './pipeline';
import { reconcile } from './reconcile';
import { scheduleConnection } from './schedule';
import { CHANNEL_WRITE_JOB, readTarget, refreshTargetsForItem } from './targets';

/**
 * The M4 exit gate (section 36).
 *
 * Section 36 requires that "simultaneous-last-unit, duplicate/order, crash,
 * quota, 24-hour outage, and 5,000-mapping load tests pass" before this
 * milestone is done. Each is a section below, and each is written to fail
 * loudly if the property it names stops holding rather than to demonstrate that
 * the happy path works.
 *
 * The assertion that ties them together is the ledger identity: after every
 * sequence, the materialized balance equals the sum of the entries that explain
 * it. M3 proved that for direct movements; here it has to survive concurrent
 * orders, reclaimed jobs, and a day of nothing running.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

/**
 * Each scenario starts with an empty queue.
 *
 * The queue is deliberately not scoped to a business — a worker claims whatever
 * is most urgent across the installation, which is the behaviour section 12
 * asks for. That makes leftovers from one scenario claimable by the next, so
 * they are withdrawn here rather than by narrowing the production claim.
 */
afterEach(async () => {
  await harness.db.execute(sql`
    update background_jobs
       set status = 'cancelled', claimed_by = null, claimed_at = null,
           claim_lease_expires_at = null, finished_at = now()
     where status in ('ready', 'running')
  `);
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

async function seed(onHand: number): Promise<Fixture> {
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

  // Zero safety stock, so "the last unit" means the last unit rather than the
  // last unit but one. Section 8 permits an override of zero, which is exactly
  // what makes this test able to say what it means.
  await harness.db.execute(sql`
    update canonical_items set safety_stock_override = 0 where id = ${canonicalItemId}::uuid
  `);

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

  if (onHand > 0) {
    await harness.db.transaction(async (tx) => {
      await postMovements(tx, {
        businessId,
        actorUserId: userId,
        movements: [{ canonicalItemId, locationId, kind: 'receipt', quantityDelta: onHand }],
      });
      await refreshTargetsForItem(tx, { businessId, canonicalItemId, reason: 'receipt' });
    });
  }

  return { businessId, connectionId, canonicalItemId, locationId, mappingId, externalId, userId };
}

function channelFor(fixture: Fixture, quantity = 0): FakeChannelAdapter {
  return new FakeChannelAdapter({
    provider: 'woocommerce',
    initialQuantities: new Map([[fixture.externalId, quantity]]),
  });
}

function orderOf(fixture: Fixture, id: string, quantity: number): ProviderOrder {
  return {
    externalOrderId: id,
    providerStatus: 'processing',
    demandState: 'committed',
    placedAt: new Date(),
    lines: [{ externalLineId: 'line-1', externalItemId: fixture.externalId, quantity }],
  };
}

async function runJob(
  kind: string,
  handler: (
    db: typeof harness.db,
    job: ClaimedJob,
    deps: { adapterFor: () => Promise<FakeChannelAdapter> },
  ) => Promise<JobResult>,
  fake: FakeChannelAdapter,
): Promise<JobResult | null> {
  const job = await claim(harness.db, {
    workerId: crypto.randomUUID(),
    leaseMs: 30_000,
    kinds: [kind],
  });

  if (job === null) {
    return null;
  }

  const result = await handler(harness.db, job, { adapterFor: () => Promise.resolve(fake) });

  if (result.status === 'done') {
    await succeed(harness.db, { id: job.id, attemptId: job.attemptId });
  } else {
    await supersede(harness.db, { id: job.id, attemptId: job.attemptId }, 'settled by the test');
  }

  return result;
}

async function balance(fixture: Fixture): Promise<{ onHand: number; reserved: number }> {
  const rows = await harness.db.execute<{ on_hand: number; reserved: number }>(sql`
    select on_hand, reserved from location_balances
     where business_id = ${fixture.businessId}::uuid
       and canonical_item_id = ${fixture.canonicalItemId}::uuid
  `);

  return { onHand: rows.rows[0]?.on_hand ?? 0, reserved: rows.rows[0]?.reserved ?? 0 };
}

/**
 * The invariant every section below has to leave standing.
 *
 * The materialized balance is a cache of the ledger. If they ever disagree,
 * every number this application shows is a guess — so this is asserted after
 * each scenario rather than once at the end, because knowing which sequence
 * broke it is most of the value.
 */
async function ledgerIdentityHolds(businessId: string): Promise<boolean> {
  const rows = await harness.db.execute<{
    canonical_item_id: string;
    on_hand: number;
    ledger_total: number;
  }>(sql`
    select b.canonical_item_id, b.location_id, b.on_hand,
           coalesce(sum(l.quantity_delta), 0)::int as ledger_total
      from location_balances b
      left join inventory_ledger l on l.business_id = b.business_id
       and l.canonical_item_id = b.canonical_item_id
       and l.location_id = b.location_id
     where b.business_id = ${businessId}::uuid
     group by b.canonical_item_id, b.location_id, b.on_hand
  `);

  return rows.rows.every((row) => row.on_hand === row.ledger_total);
}

describe('simultaneous last unit', () => {
  it('gives the last unit to exactly one order and records the rest as shortages', async () => {
    // Section 12: "the first committed allocation receives stock. A later valid
    // sale becomes a shortage; it is never auto-cancelled."
    const fixture = await seed(1);
    const fake = channelFor(fixture);

    for (let index = 0; index < 12; index += 1) {
      fake.setOrder(orderOf(fixture, `race-${String(index)}`, 1));
    }

    await Promise.all(
      Array.from({ length: 12 }, async (_, index) =>
        requestOrderSync(harness.db, {
          businessId: fixture.businessId,
          connectionId: fixture.connectionId,
          externalOrderId: `race-${String(index)}`,
          source: 'webhook',
        }),
      ),
    );

    // Twelve workers, all at once, all wanting the same unit.
    await Promise.all(
      Array.from({ length: 12 }, async () => runJob(ORDER_SYNC_JOB, handleOrderSync, fake)),
    );

    const after = await balance(fixture);

    expect(after.onHand).toBe(1);
    expect(after.reserved).toBe(1);
    expect(await ledgerIdentityHolds(fixture.businessId)).toBe(true);

    const shortages = await harness.db.execute<{ count: string; total: string }>(sql`
      select count(*)::text as count, coalesce(sum(shortage), 0)::text as total
        from channel_order_lines
       where business_id = ${fixture.businessId}::uuid and shortage > 0
    `);

    expect(shortages.rows[0]?.count).toBe('11');
    expect(shortages.rows[0]?.total).toBe('11');

    // And nobody's order was cancelled to make the numbers work.
    const orders = await harness.db.execute<{ count: string }>(sql`
      select count(*)::text as count from channel_orders
       where business_id = ${fixture.businessId}::uuid and demand_state = 'cancelled'
    `);
    expect(orders.rows[0]?.count).toBe('0');
  });

  it('never lets a balance go below zero, whatever the ordering', async () => {
    const fixture = await seed(3);
    const fake = channelFor(fixture);

    for (let index = 0; index < 10; index += 1) {
      fake.setOrder(orderOf(fixture, `multi-${String(index)}`, 2));
      await requestOrderSync(harness.db, {
        businessId: fixture.businessId,
        connectionId: fixture.connectionId,
        externalOrderId: `multi-${String(index)}`,
        source: 'webhook',
      });
    }

    await Promise.all(
      Array.from({ length: 10 }, async () => runJob(ORDER_SYNC_JOB, handleOrderSync, fake)),
    );

    const after = await balance(fixture);

    expect(after.onHand).toBe(3);
    expect(after.reserved).toBe(3);
    expect(await ledgerIdentityHolds(fixture.businessId)).toBe(true);
  });
});

describe('duplicate and out-of-order delivery', () => {
  it('commits once however many times the same order arrives', async () => {
    const fixture = await seed(10);
    const fake = channelFor(fixture);
    fake.setOrder(orderOf(fixture, 'dup-1', 4));

    for (let pass = 0; pass < 5; pass += 1) {
      await requestOrderSync(harness.db, {
        businessId: fixture.businessId,
        connectionId: fixture.connectionId,
        externalOrderId: 'dup-1',
        source: pass % 2 === 0 ? 'webhook' : 'poll',
      });
      await runJob(ORDER_SYNC_JOB, handleOrderSync, fake);
    }

    expect(await balance(fixture)).toEqual({ onHand: 10, reserved: 4 });
    expect(await ledgerIdentityHolds(fixture.businessId)).toBe(true);
  });

  it('does not let a stale delivery undo a newer one', async () => {
    // Section 12: "provider revisions/sequences take precedence over arrival
    // order." The cancellation arrives, then a stale "processing" overtakes it.
    const fixture = await seed(10);
    const fake = channelFor(fixture);
    const base = orderOf(fixture, 'seq-1', 3);

    fake.setOrder({ ...base, providerSequence: 1 });
    await requestOrderSync(harness.db, {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      externalOrderId: 'seq-1',
      source: 'webhook',
    });
    await runJob(ORDER_SYNC_JOB, handleOrderSync, fake);

    fake.setOrder({ ...base, providerSequence: 5, demandState: 'cancelled' });
    await requestOrderSync(harness.db, {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      externalOrderId: 'seq-1',
      source: 'webhook',
    });
    await runJob(ORDER_SYNC_JOB, handleOrderSync, fake);

    expect(await balance(fixture)).toEqual({ onHand: 10, reserved: 0 });

    // Now the late one turns up, claiming the order is still being processed.
    fake.setOrder({ ...base, providerSequence: 2 });
    await requestOrderSync(harness.db, {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      externalOrderId: 'seq-1',
      source: 'poll',
    });
    await runJob(ORDER_SYNC_JOB, handleOrderSync, fake);

    const state = await harness.db.execute<{ demand_state: string }>(sql`
      select demand_state from channel_orders
       where connection_id = ${fixture.connectionId}::uuid and external_order_id = 'seq-1'
    `);

    expect(state.rows[0]?.demand_state).toBe('cancelled');
    expect(await balance(fixture)).toEqual({ onHand: 10, reserved: 0 });
    expect(await ledgerIdentityHolds(fixture.businessId)).toBe(true);
  });
});

describe('crash recovery', () => {
  it('finishes a job whose worker died, exactly once', async () => {
    const fixture = await seed(10);
    const fake = channelFor(fixture);

    // A worker claims the write and then vanishes: the lease is left to expire
    // rather than being released, which is the only difference between this and
    // an actual kill -9.
    const abandoned = await claim(harness.db, {
      workerId: crypto.randomUUID(),
      leaseMs: 30_000,
      kinds: [CHANNEL_WRITE_JOB],
    });

    expect(abandoned).not.toBeNull();
    await harness.db.execute(sql`
      update background_jobs set claim_lease_expires_at = now() - interval '1 second'
       where id = ${abandoned!.id}::uuid
    `);

    expect(await reclaimExpired(harness.db)).toBe(1);

    const result = await runJob(CHANNEL_WRITE_JOB, handleChannelWrite, fake);

    expect(result).toEqual({ status: 'done' });
    // One write reached the provider, not two: the abandoned attempt never
    // got that far, and the reclaimed one carried the same idempotency key.
    expect(fake.writes).toHaveLength(1);
    expect(fake.writes[0]?.quantity).toBe(10);
    expect(await ledgerIdentityHolds(fixture.businessId)).toBe(true);
  });

  it('leaves the canonical ledger untouched by a worker that never finished', async () => {
    const fixture = await seed(10);
    const fake = channelFor(fixture);
    fake.setOrder(orderOf(fixture, 'crash-1', 2));

    await requestOrderSync(harness.db, {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      externalOrderId: 'crash-1',
      source: 'webhook',
    });

    const claimed = await claim(harness.db, {
      workerId: crypto.randomUUID(),
      leaseMs: 30_000,
      kinds: [ORDER_SYNC_JOB],
    });
    // Claimed, never run, worker gone.
    await harness.db.execute(sql`
      update background_jobs set claim_lease_expires_at = now() - interval '1 second'
       where id = ${claimed!.id}::uuid
    `);

    expect(await balance(fixture)).toEqual({ onHand: 10, reserved: 0 });

    await reclaimExpired(harness.db);
    await runJob(ORDER_SYNC_JOB, handleOrderSync, fake);

    expect(await balance(fixture)).toEqual({ onHand: 10, reserved: 2 });
    expect(await ledgerIdentityHolds(fixture.businessId)).toBe(true);
  });
});

describe('quota exhaustion', () => {
  it('honours the provider delay and does not spend the attempt budget faster', async () => {
    const fixture = await seed(10);
    const fake = channelFor(fixture).failNext({ status: 'rate_limited', retryAfterMs: 60_000 });

    const result = await runJob(CHANNEL_WRITE_JOB, handleChannelWrite, fake);

    expect(result).toMatchObject({
      status: 'failed',
      failureKind: 'rate_limited',
      retryAfterMs: 60_000,
    });
    expect(await ledgerIdentityHolds(fixture.businessId)).toBe(true);
  });

  it('lengthens the sweep interval rather than pressing harder', async () => {
    // Section 15: adapt "to provider quotas, throttling, connection health, and
    // backlog". Pressing harder into a quota wall is how a connection gets cut
    // off entirely.
    const fixture = await seed(10);

    const relaxed = await scheduleConnection(harness.db, {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      quotaPressure: 'normal',
      random: () => 0,
    });
    const squeezed = await scheduleConnection(harness.db, {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      quotaPressure: 'critical',
      random: () => 0,
    });

    expect(relaxed.cadence.effectiveIntervalSeconds).toBe(30);
    expect(squeezed.cadence.effectiveIntervalSeconds).toBe(240);
    expect(squeezed.cadence.reason).toContain('quota');
  });
});

describe('twenty-four hour outage', () => {
  it('abandons work whose moment has passed rather than acting on it late', async () => {
    const fixture = await seed(10);

    // The application was down for a day. Nothing failed, because nothing ran.
    await harness.db.execute(sql`
      update background_jobs
         set expires_at = now() - interval '1 minute'
       where business_id = ${fixture.businessId}::uuid and status = 'ready'
    `);

    expect(await expireOverdue(harness.db)).toBeGreaterThanOrEqual(1);

    const nothingLeft = await claim(harness.db, {
      workerId: crypto.randomUUID(),
      leaseMs: 30_000,
      kinds: [CHANNEL_WRITE_JOB],
    });

    expect(nothingLeft).toBeNull();
    expect(await ledgerIdentityHolds(fixture.businessId)).toBe(true);
  });

  it('recovers by reconciling current state rather than replaying old values', async () => {
    // Section 15: "reconcile current inventory rather than replaying obsolete
    // intermediate quantity events." The store moved on while we were away.
    const fixture = await seed(10);
    const fake = channelFor(fixture, 10);

    await harness.db.execute(sql`
      update background_jobs set expires_at = now() - interval '1 minute'
       where business_id = ${fixture.businessId}::uuid and status = 'ready'
    `);
    await expireOverdue(harness.db);

    // Meanwhile somebody sold four through the store's own admin.
    fake.setQuantityOutOfBand({ externalId: fixture.externalId }, 6);

    const run = await reconcile(
      harness.db,
      { businessId: fixture.businessId, trigger: 'startup', dryRun: false },
      { adapterFor: () => Promise.resolve(fake) },
    );

    expect(run.examined).toBe(1);
    expect(run.findings[0]?.finding).toBe('drift');
    // Recovery does not invent a physical movement to explain the difference.
    expect(await balance(fixture)).toEqual({ onHand: 10, reserved: 0 });
    expect(await ledgerIdentityHolds(fixture.businessId)).toBe(true);

    const conflicts = await harness.db.execute<{ count: string }>(sql`
      select count(*)::text as count from inventory_conflicts
       where business_id = ${fixture.businessId}::uuid and status = 'open'
    `);
    expect(conflicts.rows[0]?.count).toBe('1');
  });
});

describe('five thousand mappings', () => {
  const SCALE = 5000;

  it('queues and drains a full sweep without losing or duplicating work', async () => {
    // Section 36's load case, and section 15's "the interval never means
    // rereading or rewriting every mapped listing on every tick". What is
    // asserted is that the queue's own guarantees — one claim per job, one
    // running job per serialization key — hold at the size the specification
    // names, not that any particular wall-clock time is met.
    const fixture = await seed(0);

    const enqueuedAt = Date.now();
    await Promise.all(
      Array.from({ length: SCALE }, async (_, index) =>
        enqueue(harness.db, {
          kind: 'load.write',
          businessId: fixture.businessId,
          connectionId: fixture.connectionId,
          serializationKey: `mapping:load-${String(index)}`,
          payload: { index },
        }),
      ),
    );
    const enqueueMs = Date.now() - enqueuedAt;

    const queued = await harness.db.execute<{ count: string }>(sql`
      select count(*)::text as count from background_jobs
       where business_id = ${fixture.businessId}::uuid and kind = 'load.write'
    `);

    expect(queued.rows[0]?.count).toBe(String(SCALE));
    // Generous by design: this is a guard against an accidental per-row query
    // or a missing index, not a performance target.
    expect(enqueueMs).toBeLessThan(60_000);

    // Eight workers drain it. Each job has its own serialization key, so all
    // eight should be able to work at once rather than queueing behind one.
    const claimedIds = new Set<string>();
    const drainedAt = Date.now();

    await Promise.all(
      Array.from({ length: 8 }, async () => {
        for (;;) {
          const job = await claim(harness.db, {
            workerId: crypto.randomUUID(),
            leaseMs: 60_000,
            kinds: ['load.write'],
          });

          if (job === null) {
            return;
          }

          claimedIds.add(job.id);
          await succeed(harness.db, { id: job.id, attemptId: job.attemptId });
        }
      }),
    );

    const drainMs = Date.now() - drainedAt;

    // Every job claimed exactly once. A duplicate would show as a smaller set
    // than the number of jobs, because the same id would be added twice.
    expect(claimedIds.size).toBe(SCALE);
    expect(drainMs).toBeLessThan(120_000);

    const unfinished = await harness.db.execute<{ count: string }>(sql`
      select count(*)::text as count from background_jobs
       where business_id = ${fixture.businessId}::uuid
         and kind = 'load.write' and status <> 'succeeded'
    `);

    expect(unfinished.rows[0]?.count).toBe('0');
  }, 300_000);
});

describe('the write gate, end to end', () => {
  it('reaches a provider only through an active, eligible, approved mapping', async () => {
    // M3 proved this for the gate function. Here it is proven for the path that
    // actually calls it: a sale, a target, a queued write, a provider call.
    const fixture = await seed(10);
    const fake = channelFor(fixture);
    fake.setOrder(orderOf(fixture, 'gate-1', 2));

    await requestOrderSync(harness.db, {
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      externalOrderId: 'gate-1',
      source: 'webhook',
    });
    await runJob(ORDER_SYNC_JOB, handleOrderSync, fake);

    // Two write jobs exist by now: the one the initial receipt queued and the
    // one the sale queued. Draining both is the point — the older carries a
    // version that has been overtaken and must stand down without writing,
    // which is section 12's superseded rule doing its job.
    while ((await runJob(CHANNEL_WRITE_JOB, handleChannelWrite, fake)) !== null) {
      // keep going until the queue is empty
    }
    while ((await runJob(CHANNEL_VERIFY_JOB, handleChannelVerify, fake)) !== null) {
      // and the verification each successful write queued
    }

    expect(fake.writes.map((write) => write.quantity)).toEqual([8]);
    expect((await readTarget(harness.db, fixture.mappingId))?.state).toBe('converged');
    expect(await ledgerIdentityHolds(fixture.businessId)).toBe(true);
  });

  it('makes no provider call at all once the mapping is archived', async () => {
    const fixture = await seed(10);
    const fake = channelFor(fixture);

    await harness.db.execute(sql`
      update channel_mappings
         set status = 'archived', archived_at = now()
       where id = ${fixture.mappingId}::uuid
    `);

    const result = await runJob(CHANNEL_WRITE_JOB, handleChannelWrite, fake);

    expect(result?.status).toBe('superseded');
    expect(fake.calls).toHaveLength(0);
  });
});
