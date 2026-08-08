import { businesses } from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  JobPriority,
  claim,
  enqueue,
  expireOverdue,
  fail,
  heartbeat,
  listDeadLettered,
  reclaimExpired,
  release,
  replay,
  succeed,
  supersede,
} from './queue';
import { DEAD_LETTER_WINDOW_MS } from './retry';

/**
 * The durable queue against a real PostgreSQL (sections 12, 15).
 *
 * Everything worth proving here is a database guarantee: that one job is
 * claimed once, that two jobs sharing a serialization key never run together,
 * that a dead worker's job comes back, and that a rolled-back transaction takes
 * its jobs with it. A fake queue would agree with all four by construction.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

async function seed(): Promise<string> {
  const slug = `job-${String((counter += 1))}`;
  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });

  return business!.id;
}

const worker = () => crypto.randomUUID();

describe('enqueue', () => {
  it('is transactional, so a rolled-back cause leaves no job', async () => {
    // This is the whole reason the queue lives in PostgreSQL. A job that
    // survived its cause would project a quantity change that never happened.
    const businessId = await seed();

    await expect(
      harness.db.transaction(async (tx) => {
        await enqueue(tx, { kind: 'test.write', businessId, dedupeKey: `rollback-${businessId}` });
        throw new Error('the caller changed its mind');
      }),
    ).rejects.toThrow('changed its mind');

    const rows = await harness.db.execute<{ count: string }>(
      sql`select count(*)::text as count from background_jobs where business_id = ${businessId}::uuid`,
    );

    expect(rows.rows[0]?.count).toBe('0');
  });

  it('coalesces repeated wake-ups for one entity', async () => {
    // Section 15: "coalesce repeated wake-ups for the same entity without
    // losing audit evidence." Fifty webhooks about one product are one job.
    const businessId = await seed();
    const key = `dirty:${businessId}:sku-1`;

    const results = await Promise.all(
      Array.from({ length: 50 }, async () =>
        enqueue(harness.db, { kind: 'test.dirty', businessId, dedupeKey: key }),
      ),
    );

    const ids = new Set(results.map((result) => result.job.id));

    expect(ids.size).toBe(1);
    expect(results.filter((result) => !result.deduplicated)).toHaveLength(1);
  });

  it('lets a new wake-up through once the previous one has finished', async () => {
    const businessId = await seed();
    const key = `dirty:${businessId}:sku-2`;

    const first = await enqueue(harness.db, { kind: 'test.settled', businessId, dedupeKey: key });
    const claimed = await claim(harness.db, {
      workerId: worker(),
      leaseMs: 30_000,
      kinds: ['test.settled'],
    });
    await succeed(harness.db, { id: claimed!.id, attemptId: claimed!.attemptId });

    const second = await enqueue(harness.db, { kind: 'test.settled', businessId, dedupeKey: key });

    expect(second.deduplicated).toBe(false);
    expect(second.job.id).not.toBe(first.job.id);
  });
});

describe('claim', () => {
  it('gives one job to exactly one worker', async () => {
    const businessId = await seed();
    await enqueue(harness.db, { kind: 'test.solo', businessId });

    const claims = await Promise.all(
      Array.from({ length: 8 }, async () =>
        claim(harness.db, { workerId: worker(), leaseMs: 30_000, kinds: ['test.solo'] }),
      ),
    );

    expect(claims.filter((job) => job !== null)).toHaveLength(1);
  });

  it('serves the most urgent work first', async () => {
    // Section 12: order ingestion outranks reconciliation, which outranks
    // imports. Enqueued in the opposite order so a queue that ignored priority
    // would come out backwards.
    const businessId = await seed();
    await enqueue(harness.db, {
      kind: 'test.p',
      businessId,
      priority: JobPriority.imports,
      payload: { rank: 'imports' },
    });
    await enqueue(harness.db, {
      kind: 'test.p',
      businessId,
      priority: JobPriority.reconciliation,
      payload: { rank: 'reconciliation' },
    });
    await enqueue(harness.db, {
      kind: 'test.p',
      businessId,
      priority: JobPriority.orderIngestion,
      payload: { rank: 'order' },
    });

    const order: unknown[] = [];
    for (let index = 0; index < 3; index += 1) {
      const job = await claim(harness.db, {
        workerId: worker(),
        leaseMs: 30_000,
        kinds: ['test.p'],
      });
      order.push(job?.payload['rank']);
      await succeed(harness.db, { id: job!.id, attemptId: job!.attemptId });
    }

    expect(order).toEqual(['order', 'reconciliation', 'imports']);
  });

  it('never runs two jobs that share a serialization key', async () => {
    // Section 12: "writes serialize per channel mapping". Ten queued writes for
    // one mapping, ten workers, and only one may be running at any moment.
    const businessId = await seed();
    const key = `mapping:${businessId}`;

    for (let index = 0; index < 10; index += 1) {
      await enqueue(harness.db, {
        kind: 'test.serial',
        businessId,
        serializationKey: key,
        payload: { index },
      });
    }

    const claims = await Promise.all(
      Array.from({ length: 10 }, async () =>
        claim(harness.db, { workerId: worker(), leaseMs: 30_000, kinds: ['test.serial'] }),
      ),
    );

    expect(claims.filter((job) => job !== null)).toHaveLength(1);

    // And the next one only becomes available once the first has finished.
    const held = claims.find((job) => job !== null)!;
    await succeed(harness.db, { id: held.id, attemptId: held.attemptId });

    const next = await claim(harness.db, {
      workerId: worker(),
      leaseMs: 30_000,
      kinds: ['test.serial'],
    });

    expect(next).not.toBeNull();
    expect(next!.id).not.toBe(held.id);
  });

  it('runs unrelated serialization keys side by side', async () => {
    const businessId = await seed();

    for (let index = 0; index < 4; index += 1) {
      await enqueue(harness.db, {
        kind: 'test.parallel',
        businessId,
        serializationKey: `mapping-${businessId}-${String(index)}`,
      });
    }

    const claims = await Promise.all(
      Array.from({ length: 4 }, async () =>
        claim(harness.db, { workerId: worker(), leaseMs: 30_000, kinds: ['test.parallel'] }),
      ),
    );

    expect(claims.filter((job) => job !== null)).toHaveLength(4);
  });

  it('leaves a job alone until its run_at', async () => {
    const businessId = await seed();
    await enqueue(harness.db, {
      kind: 'test.future',
      businessId,
      runAt: new Date(Date.now() + 60_000),
    });

    expect(
      await claim(harness.db, { workerId: worker(), leaseMs: 30_000, kinds: ['test.future'] }),
    ).toBeNull();
  });
});

describe('failure and recovery', () => {
  it('brings back a job whose worker stopped reporting', async () => {
    // The crash case. Section 12: "PostgreSQL leases and heartbeats make worker
    // jobs reclaimable after crashes."
    const businessId = await seed();
    await enqueue(harness.db, { kind: 'test.crash', businessId });

    const job = await claim(harness.db, {
      workerId: worker(),
      leaseMs: 30_000,
      kinds: ['test.crash'],
    });

    // Age the lease rather than waiting for it, which is the only difference
    // between this test and an actual kill -9.
    await harness.db.execute(
      sql`update background_jobs set claim_lease_expires_at = now() - interval '1 second' where id = ${job!.id}::uuid`,
    );

    expect(await reclaimExpired(harness.db)).toBe(1);

    const again = await claim(harness.db, {
      workerId: worker(),
      leaseMs: 30_000,
      kinds: ['test.crash'],
    });

    expect(again?.id).toBe(job!.id);
    // The attempt is spent, not refunded: the work may well have reached the
    // provider before the process died.
    expect(again?.attempts).toBe(2);
  });

  it('does not resurrect a job that had already used its last attempt', async () => {
    const businessId = await seed();
    await enqueue(harness.db, { kind: 'test.lastcrash', businessId, maxAttempts: 1 });

    const job = await claim(harness.db, {
      workerId: worker(),
      leaseMs: 30_000,
      kinds: ['test.lastcrash'],
    });
    await harness.db.execute(
      sql`update background_jobs set claim_lease_expires_at = now() - interval '1 second' where id = ${job!.id}::uuid`,
    );

    await reclaimExpired(harness.db);

    const dead = await listDeadLettered(harness.db, businessId);
    expect(dead.map((entry) => entry.id)).toContain(job!.id);
  });

  it('schedules a retry and dead-letters the last one', async () => {
    const businessId = await seed();
    await enqueue(harness.db, { kind: 'test.retry', businessId, maxAttempts: 2 });

    const first = await claim(harness.db, {
      workerId: worker(),
      leaseMs: 30_000,
      kinds: ['test.retry'],
    });
    const retry = await fail(harness.db, {
      job: first!,
      failureKind: 'unavailable',
      detail: 'the provider is unavailable',
      retryable: true,
      random: () => 0,
    });

    expect(retry.outcome).toBe('retry');

    const second = await claim(harness.db, {
      workerId: worker(),
      leaseMs: 30_000,
      kinds: ['test.retry'],
    });
    const done = await fail(harness.db, {
      job: second!,
      failureKind: 'unavailable',
      detail: 'still unavailable',
      retryable: true,
    });

    expect(done).toEqual({ outcome: 'dead_letter', reason: 'attempts_exhausted' });
    expect((await listDeadLettered(harness.db, businessId)).map((job) => job.id)).toEqual([
      first!.id,
    ]);
  });

  it('keeps every attempt, so an operator can see whether it failed nine ways or one', async () => {
    const businessId = await seed();
    await enqueue(harness.db, { kind: 'test.history', businessId, maxAttempts: 3 });

    for (const kind of ['rate_limited', 'unavailable', 'unavailable']) {
      const job = await claim(harness.db, {
        workerId: worker(),
        leaseMs: 30_000,
        kinds: ['test.history'],
      });
      await fail(harness.db, {
        job: job!,
        failureKind: kind,
        detail: kind,
        retryable: true,
        random: () => 0,
      });
    }

    const rows = await harness.db.execute<{ attempt: number; failure_kind: string }>(sql`
      select a.attempt, a.failure_kind
        from background_job_attempts a
        join background_jobs j on j.id = a.job_id
       where j.business_id = ${businessId}::uuid
       order by a.attempt
    `);

    expect(rows.rows.map((row) => row.failure_kind)).toEqual([
      'rate_limited',
      'unavailable',
      'unavailable',
    ]);
  });

  it('refuses to rewrite an attempt that already happened', async () => {
    const businessId = await seed();
    await enqueue(harness.db, { kind: 'test.immutable', businessId });
    const job = await claim(harness.db, {
      workerId: worker(),
      leaseMs: 30_000,
      kinds: ['test.immutable'],
    });

    await expect(
      harness.db.execute(
        sql`update background_job_attempts set attempt = 99 where id = ${job!.attemptId}::uuid`,
      ),
    ).rejects.toSatisfy((error: unknown) => whyItFailed(error).includes('identity is immutable'));

    await expect(
      harness.db.execute(
        sql`delete from background_job_attempts where id = ${job!.attemptId}::uuid`,
      ),
    ).rejects.toSatisfy((error: unknown) => whyItFailed(error).includes('append-only'));
  });

  it('dead-letters work whose window elapsed while nothing was running', async () => {
    // The 24-hour outage. No attempt failed, because no worker was alive to
    // fail one, but the deadline passed all the same.
    const businessId = await seed();
    const stale = await enqueue(harness.db, { kind: 'test.stale', businessId });
    await harness.db.execute(
      sql`update background_jobs set expires_at = now() - interval '1 minute' where id = ${stale.job.id}::uuid`,
    );

    expect(await expireOverdue(harness.db)).toBeGreaterThanOrEqual(1);
    expect(
      await claim(harness.db, { workerId: worker(), leaseMs: 30_000, kinds: ['test.stale'] }),
    ).toBeNull();
  });

  it('lets an operator replay a dead-lettered job with a fresh window', async () => {
    const businessId = await seed();
    await enqueue(harness.db, { kind: 'test.replay', businessId, maxAttempts: 1 });
    const job = await claim(harness.db, {
      workerId: worker(),
      leaseMs: 30_000,
      kinds: ['test.replay'],
    });
    await fail(harness.db, {
      job: job!,
      failureKind: 'rate_limited',
      detail: 'come back tomorrow',
      retryable: true,
      retryAfterMs: 48 * 60 * 60 * 1000,
    });

    expect(await replay(harness.db, job!.id, DEAD_LETTER_WINDOW_MS)).toBe(true);

    const again = await claim(harness.db, {
      workerId: worker(),
      leaseMs: 30_000,
      kinds: ['test.replay'],
    });

    expect(again?.id).toBe(job!.id);
    // The history survives the replay; the attempt counter is what resets.
    const attempts = await harness.db.execute<{ count: string }>(
      sql`select count(*)::text as count from background_job_attempts where job_id = ${job!.id}::uuid`,
    );
    expect(attempts.rows[0]?.count).toBe('2');
  });

  it('hands a job back untouched on shutdown', async () => {
    const businessId = await seed();
    await enqueue(harness.db, { kind: 'test.shutdown', businessId });
    const workerId = worker();
    const job = await claim(harness.db, { workerId, leaseMs: 30_000, kinds: ['test.shutdown'] });

    await release(harness.db, { id: job!.id, attemptId: job!.attemptId, workerId });

    const again = await claim(harness.db, {
      workerId: worker(),
      leaseMs: 30_000,
      kinds: ['test.shutdown'],
    });

    // Released, not failed: the attempt is refunded because nothing was tried.
    expect(again?.attempts).toBe(1);
  });

  it('drops a superseded job without counting it as a failure', async () => {
    const businessId = await seed();
    await enqueue(harness.db, { kind: 'test.superseded', businessId });
    const job = await claim(harness.db, {
      workerId: worker(),
      leaseMs: 30_000,
      kinds: ['test.superseded'],
    });

    await supersede(
      harness.db,
      { id: job!.id, attemptId: job!.attemptId },
      'a newer target exists',
    );

    expect(await listDeadLettered(harness.db, businessId)).toEqual([]);
    expect(
      await claim(harness.db, { workerId: worker(), leaseMs: 30_000, kinds: ['test.superseded'] }),
    ).toBeNull();
  });

  it('only lets the holder heartbeat', async () => {
    const businessId = await seed();
    await enqueue(harness.db, { kind: 'test.heartbeat', businessId });
    const workerId = worker();
    const job = await claim(harness.db, { workerId, leaseMs: 30_000, kinds: ['test.heartbeat'] });

    expect(await heartbeat(harness.db, { id: job!.id, workerId }, 30_000)).toBe(true);
    expect(await heartbeat(harness.db, { id: job!.id, workerId: worker() }, 30_000)).toBe(false);
  });
});

/**
 * Walks an error's cause chain for the words the database used.
 *
 * The query builder wraps a driver error in its own, whose message names the
 * failing statement rather than the trigger that refused it. Asserting on the
 * wrapper would pass for any failure at all, including a typo in the SQL.
 */
function whyItFailed(error: unknown): string {
  const parts: string[] = [];

  for (let current: unknown = error; current !== undefined && current !== null;) {
    if (!(current instanceof Error)) {
      break;
    }

    parts.push(current.message);
    current = current.cause;
  }

  return parts.join(' | ');
}
