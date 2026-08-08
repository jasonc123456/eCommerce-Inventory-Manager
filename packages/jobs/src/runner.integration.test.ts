import { businesses } from '@eim/db';
import { createLogger } from '@eim/observability';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { enqueue } from './queue';
import { createRunner, type JobHandler } from './runner';

/**
 * The worker loop (sections 12, 16).
 *
 * What is worth proving is the settlement: that each of the three things a
 * handler can say lands the job in the right state, that a handler which throws
 * is still treated as a failure rather than losing the job, and that a kind this
 * replica does not understand is handed back rather than failed.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

const logger = createLogger({ level: 'silent', component: 'worker' });

let counter = 0;

async function seed(): Promise<string> {
  const slug = `run-${String((counter += 1))}`;
  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });

  return business!.id;
}

async function statusOf(jobId: string): Promise<string | undefined> {
  const rows = await harness.db.execute<{ status: string }>(
    sql`select status from background_jobs where id = ${jobId}::uuid`,
  );

  return rows.rows[0]?.status;
}

function runnerFor(handlers: Readonly<Record<string, JobHandler>>) {
  return createRunner({
    db: harness.db,
    logger,
    workerId: crypto.randomUUID(),
    handlers,
    idleDelayMs: 5,
  });
}

describe('the runner', () => {
  it('marks a finished job succeeded', async () => {
    const businessId = await seed();
    const job = await enqueue(harness.db, { kind: 'run.done', businessId });
    const runner = runnerFor({ 'run.done': () => Promise.resolve({ status: 'done' }) });

    expect(await runner.runOnce()).toBe(true);
    expect(await statusOf(job.job.id)).toBe('succeeded');
  });

  it('reschedules a failure the provider might yet answer', async () => {
    const businessId = await seed();
    const job = await enqueue(harness.db, { kind: 'run.retry', businessId });
    const runner = runnerFor({
      'run.retry': () =>
        Promise.resolve({
          status: 'failed',
          failureKind: 'unavailable',
          detail: 'the store did not answer',
          retryable: true,
        }),
    });

    await runner.runOnce();

    expect(await statusOf(job.job.id)).toBe('ready');
  });

  it('dead-letters a failure no retry can fix', async () => {
    const businessId = await seed();
    const job = await enqueue(harness.db, { kind: 'run.reject', businessId });
    const runner = runnerFor({
      'run.reject': () =>
        Promise.resolve({
          status: 'failed',
          failureKind: 'rejected',
          detail: 'the mapping names a product that does not exist',
          retryable: false,
        }),
    });

    await runner.runOnce();

    expect(await statusOf(job.job.id)).toBe('dead');
  });

  it('treats a thrown error as retryable rather than losing the job', async () => {
    // An unexpected exception is more often a transient environment problem
    // than a permanent one, and the ten-attempt ceiling bounds the cost of
    // being wrong about that. Losing the job entirely has no such bound.
    const businessId = await seed();
    const job = await enqueue(harness.db, { kind: 'run.throw', businessId });
    const runner = runnerFor({
      'run.throw': () => {
        throw new Error('a bug, not a provider saying no');
      },
    });

    await runner.runOnce();

    expect(await statusOf(job.job.id)).toBe('ready');
    const rows = await harness.db.execute<{ last_failure_kind: string }>(
      sql`select last_failure_kind from background_jobs where id = ${job.job.id}::uuid`,
    );
    expect(rows.rows[0]?.last_failure_kind).toBe('handler_threw');
  });

  it('hands back a kind it does not understand', async () => {
    // The rolling-deployment case: an older replica claims work only the newer
    // one knows how to do. Failing it would burn attempts on a job that is
    // perfectly valid somewhere else in the fleet.
    const businessId = await seed();
    const job = await enqueue(harness.db, { kind: 'run.future', businessId });
    const runner = createRunner({
      db: harness.db,
      logger,
      workerId: crypto.randomUUID(),
      handlers: { 'run.other': () => Promise.resolve({ status: 'done' }) },
      kinds: ['run.future'],
      idleDelayMs: 5,
    });

    await runner.runOnce();

    expect(await statusOf(job.job.id)).toBe('ready');
    const rows = await harness.db.execute<{ attempts: number }>(
      sql`select attempts from background_jobs where id = ${job.job.id}::uuid`,
    );
    expect(rows.rows[0]?.attempts).toBe(0);
  });

  it('finishes the work in hand before it stops', async () => {
    // Section 12: "graceful shutdown stops new claims and finishes or releases
    // active jobs." The handler is deliberately slower than the stop call.
    const businessId = await seed();
    const job = await enqueue(harness.db, { kind: 'run.slow', businessId });

    let started = false;
    const runner = runnerFor({
      'run.slow': async () => {
        started = true;
        await new Promise((resolve) => setTimeout(resolve, 150));
        return { status: 'done' };
      },
    });

    runner.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(started).toBe(true);

    await runner.stop();

    expect(await statusOf(job.job.id)).toBe('succeeded');
    expect(runner.activeJobs()).toBe(0);
  });

  it('reports nothing to do rather than spinning on an empty queue', async () => {
    const runner = runnerFor({ 'run.absent': () => Promise.resolve({ status: 'done' }) });

    expect(await runner.runOnce()).toBe(false);
  });
});
