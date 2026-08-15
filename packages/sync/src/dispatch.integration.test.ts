import { operatorOrigin } from '@eim/pilot';
import { businesses, connections, providerItems, users } from '@eim/db';
import {
  activateMapping,
  approveMapping,
  createCanonicalItem,
  createLocation,
  pauseMapping,
  postMovements,
  proposeMapping,
} from '@eim/inventory';
import { claim, succeed, supersede, type ClaimedJob, type JobResult } from '@eim/jobs';
import { FakeChannelAdapter } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CHANNEL_VERIFY_JOB, handleChannelVerify, handleChannelWrite } from './dispatch';
import { CHANNEL_WRITE_JOB, readTarget, refreshTargetsForItem } from './targets';

/**
 * Carrying a quantity to a provider (sections 12, 15).
 *
 * The adapter is a fake, and deliberately so: section 40 permits no live
 * provider call, and what these tests are about is the decisions taken around
 * the call rather than the call itself. What is proven here is that a write
 * happens only when it should, exactly once, with the newest number.
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
  const slug = `disp-${String((counter += 1))}`;

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

function adapterFor(fake: FakeChannelAdapter) {
  return { adapterFor: () => Promise.resolve(fake) };
}

/** A fake that already knows about the mapped listing, as a real channel does. */
function channelHolding(fixture: Fixture, quantity = 0): FakeChannelAdapter {
  return new FakeChannelAdapter({
    provider: 'ebay',
    initialQuantities: new Map([[fixture.externalId, quantity]]),
  });
}

async function nextJob(kind: string): Promise<ClaimedJob> {
  const job = await claim(harness.db, {
    workerId: crypto.randomUUID(),
    leaseMs: 30_000,
    kinds: [kind],
  });

  if (job === null) {
    throw new Error(`no ${kind} job was queued`);
  }

  return job;
}

/**
 * Claims one job, runs its handler, and settles the claim.
 *
 * Settling matters here rather than being tidiness: writes and verifications
 * share a serialization key, so a write left `running` blocks the verification
 * it queued from ever being claimed. In production the runner settles it; in a
 * test that calls the handler directly, this stands in for the runner.
 */
async function runJob(
  kind: string,
  handler: (
    db: typeof harness.db,
    job: ClaimedJob,
    deps: { adapterFor: () => Promise<FakeChannelAdapter> },
  ) => Promise<JobResult>,
  fake: FakeChannelAdapter,
): Promise<JobResult> {
  const job = await nextJob(kind);
  const result = await handler(harness.db, job, adapterFor(fake));

  if (result.status === 'done') {
    await succeed(harness.db, { id: job.id, attemptId: job.attemptId });
  } else {
    await supersede(harness.db, { id: job.id, attemptId: job.attemptId }, 'settled by the test');
  }

  return result;
}

describe('handleChannelWrite', () => {
  it('sends the desired quantity and schedules a verification', async () => {
    const fixture = await seed();
    const fake = channelHolding(fixture);

    const result = await runJob(CHANNEL_WRITE_JOB, handleChannelWrite, fake);

    expect(result).toEqual({ status: 'done' });
    // Nine: ten on hand, one withheld by the default safety stock.
    expect(fake.writes).toEqual([
      expect.objectContaining({ entityKey: fixture.externalId, quantity: 9 }),
    ]);

    const target = await readTarget(harness.db, fixture.mappingId);
    expect(target?.state).toBe('converged');

    const verify = await nextJob(CHANNEL_VERIFY_JOB);
    expect(verify.payload['mappingId']).toBe(fixture.mappingId);
  });

  it('stands down rather than writing a number that has been overtaken', async () => {
    // Section 12: "older targets can never overwrite newer committed targets."
    const fixture = await seed();
    const fake = channelHolding(fixture);
    const job = await nextJob(CHANNEL_WRITE_JOB);

    // A sale lands between the job being queued and the worker reaching it.
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

    const result = await handleChannelWrite(harness.db, job, adapterFor(fake));

    expect(result.status).toBe('superseded');
    expect(fake.writes).toHaveLength(0);
  });

  it('makes no call at all for a mapping that may not be written to', async () => {
    // The milestone's exit gate, at the only place a provider write can start.
    const fixture = await seed();
    const fake = channelHolding(fixture);
    const job = await nextJob(CHANNEL_WRITE_JOB);

    await pauseMapping(harness.db, {
      businessId: fixture.businessId,
      mappingId: fixture.mappingId,
      reason: 'an operator paused this mapping',
      actorUserId: fixture.userId,
    });

    const result = await handleChannelWrite(harness.db, job, adapterFor(fake));

    expect(result.status).toBe('superseded');
    expect(fake.calls).toHaveLength(0);
    expect((await readTarget(harness.db, fixture.mappingId))?.state).toBe('blocked');
  });

  it('honours a provider delay instead of guessing at one', async () => {
    const fixture = await seed();
    const fake = channelHolding(fixture).failNext({
      status: 'rate_limited',
      retryAfterMs: 45_000,
    });
    const job = await nextJob(CHANNEL_WRITE_JOB);

    const result = await handleChannelWrite(harness.db, job, adapterFor(fake));

    expect(result).toMatchObject({
      status: 'failed',
      failureKind: 'rate_limited',
      retryable: true,
      retryAfterMs: 45_000,
    });
    expect((await readTarget(harness.db, fixture.mappingId))?.state).toBe('degraded');
  });

  it('stops writing to a mapping whose credentials were rejected', async () => {
    // Section 12: "on 401 ... pause if authorization remains invalid." Queuing
    // more writes would bury the alert under failures that all say the same
    // thing.
    const fixture = await seed();
    const fake = channelHolding(fixture).failNext({
      status: 'unauthorized',
      requiresReauthorization: true,
      message: 'the grant was revoked',
    });
    const job = await nextJob(CHANNEL_WRITE_JOB);

    const result = await handleChannelWrite(harness.db, job, adapterFor(fake));

    expect(result).toMatchObject({ status: 'failed', retryable: false });
    expect((await readTarget(harness.db, fixture.mappingId))?.state).toBe('blocked');
  });

  it('records what was sent, so a retry can send the same key', async () => {
    const fixture = await seed();
    const fake = channelHolding(fixture);
    const job = await nextJob(CHANNEL_WRITE_JOB);

    await handleChannelWrite(harness.db, job, adapterFor(fake));

    const rows = await harness.db.execute<{
      idempotency_key: string;
      outcome: string;
      quantity: number;
    }>(sql`
      select idempotency_key, outcome, quantity from channel_write_attempts
       where mapping_id = ${fixture.mappingId}::uuid
    `);

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ outcome: 'acknowledged', quantity: 9 });
    expect(fake.writes[0]?.idempotencyKey).toBe(rows.rows[0]?.idempotency_key);
  });
});

describe('handleChannelVerify', () => {
  it('confirms a write that stuck', async () => {
    const fixture = await seed();
    const fake = channelHolding(fixture);

    await runJob(CHANNEL_WRITE_JOB, handleChannelWrite, fake);
    const result = await runJob(CHANNEL_VERIFY_JOB, handleChannelVerify, fake);

    expect(result).toEqual({ status: 'done' });

    const target = await readTarget(harness.db, fixture.mappingId);
    expect(target?.observedQuantity).toBe(9);
    expect(target?.state).toBe('converged');
  });

  it('reports a channel that disagrees rather than agreeing with it', async () => {
    // The entire value of a verification read is that it can disagree. One that
    // quietly agreed would turn a silent drift into a silent drift with a tick
    // next to it.
    const fixture = await seed();
    const fake = channelHolding(fixture);

    await runJob(CHANNEL_WRITE_JOB, handleChannelWrite, fake);
    fake.setQuantityOutOfBand({ externalId: fixture.externalId }, 42);

    await runJob(CHANNEL_VERIFY_JOB, handleChannelVerify, fake);

    const target = await readTarget(harness.db, fixture.mappingId);

    expect(target?.observedQuantity).toBe(42);
    expect(target?.state).toBe('degraded');
    expect(target?.stateReason).toContain('42');
    // And the canonical figure is untouched. Section 15: an unexplained channel
    // value is never adopted into physical inventory.
    expect(target?.desiredQuantity).toBe(9);
  });
});
