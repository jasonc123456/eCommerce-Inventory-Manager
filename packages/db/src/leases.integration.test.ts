import { randomUUID } from 'node:crypto';

import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  acquireSchedulerLease,
  pruneHeartbeats,
  readSchedulerLease,
  recordHeartbeat,
  releaseSchedulerLease,
  renewSchedulerLease,
} from './leases';

/**
 * Leader election, against a real PostgreSQL.
 *
 * These properties cannot be established with a fake. The guarantee rests on
 * the database evaluating a WHERE clause and an INSERT atomically under real
 * concurrency, and on the database's clock rather than any process's, so a test
 * double would be testing the double.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await harness.drop();
});

beforeEach(async () => {
  await harness.pool.query('delete from scheduler_leases');
  await harness.pool.query('delete from worker_heartbeats');
});

const holderA = { holderId: randomUUID(), appVersion: '0.0.0-a' };
const holderB = { holderId: randomUUID(), appVersion: '0.0.0-b' };

describe('acquireSchedulerLease', () => {
  it('grants the lease to the first caller', async () => {
    const lease = await acquireSchedulerLease(harness.db, holderA, 60_000);

    expect(lease?.holderId).toBe(holderA.holderId);
  });

  it('refuses a second holder while the lease is live', async () => {
    await acquireSchedulerLease(harness.db, holderA, 60_000);

    expect(await acquireSchedulerLease(harness.db, holderB, 60_000)).toBeNull();
  });

  it('grants exactly one leader under concurrent contention', async () => {
    // The property the whole design exists for. Ten replicas starting at once
    // is what a rolling deployment looks like, and the acquisition is a single
    // atomic statement precisely so this cannot produce two winners.
    const contenders = Array.from({ length: 10 }, () => ({ holderId: randomUUID() }));

    const results = await Promise.all(
      contenders.map((holder) => acquireSchedulerLease(harness.db, holder, 60_000)),
    );

    const winners = results.filter((lease) => lease !== null);
    expect(winners).toHaveLength(1);

    const stored = await readSchedulerLease(harness.db);
    expect(stored?.holderId).toBe(winners[0]?.holderId);
  });

  it('is idempotent for the holder, which is how renewal-on-acquire works', async () => {
    const first = await acquireSchedulerLease(harness.db, holderA, 60_000);
    const second = await acquireSchedulerLease(harness.db, holderA, 60_000);

    expect(second?.holderId).toBe(holderA.holderId);
    // "Leader since" must not reset on every renewal, or the health page can
    // never show how long the current leader has actually been in charge.
    expect(second?.acquiredAt.getTime()).toBe(first?.acquiredAt.getTime());
    expect(second?.expiresAt.getTime()).toBeGreaterThanOrEqual(first!.expiresAt.getTime());
  });

  it('lets another process take an expired lease', async () => {
    // What a hard-killed leader leaves behind. Nothing runs to clean up, so
    // recovery has to come from the passage of time alone.
    await acquireSchedulerLease(harness.db, holderA, 50);
    await sleep(120);

    const lease = await acquireSchedulerLease(harness.db, holderB, 60_000);

    expect(lease?.holderId).toBe(holderB.holderId);
    // A change of holder does reset the acquisition time, unlike a renewal.
    expect(lease?.acquiredAt.getTime()).toBeGreaterThanOrEqual(lease!.expiresAt.getTime() - 60_000);
  });

  it('grants exactly one successor when several contend for an expired lease', async () => {
    await acquireSchedulerLease(harness.db, holderA, 50);
    await sleep(120);

    const contenders = Array.from({ length: 8 }, () => ({ holderId: randomUUID() }));
    const results = await Promise.all(
      contenders.map((holder) => acquireSchedulerLease(harness.db, holder, 60_000)),
    );

    expect(results.filter((lease) => lease !== null)).toHaveLength(1);
  });

  it('records the holder version, so a mixed rollout is visible', async () => {
    await acquireSchedulerLease(harness.db, holderA, 60_000);

    const stored = await harness.pool.query<{ app_version: string }>(
      'select app_version from scheduler_leases',
    );
    expect(stored.rows[0]?.app_version).toBe('0.0.0-a');
  });
});

describe('renewSchedulerLease', () => {
  it('extends a lease the caller holds', async () => {
    const first = await acquireSchedulerLease(harness.db, holderA, 1_000);
    await sleep(50);

    expect(await renewSchedulerLease(harness.db, holderA, 60_000)).toBe(true);

    const stored = await readSchedulerLease(harness.db);
    expect(stored!.expiresAt.getTime()).toBeGreaterThan(first!.expiresAt.getTime());
  });

  it('reports failure once the lease has been lost', async () => {
    // The scheduler's contract: a false here means stop scheduling now.
    // Continuing would put two processes on one clock and double every job.
    await acquireSchedulerLease(harness.db, holderA, 50);
    await sleep(120);
    await acquireSchedulerLease(harness.db, holderB, 60_000);

    expect(await renewSchedulerLease(harness.db, holderA, 60_000)).toBe(false);
  });

  it('refuses to renew an expired lease the caller still thinks it holds', async () => {
    // Nobody else has taken it, but it has lapsed. Renewing would be a silent
    // claim on a period during which this process was not the leader and
    // another one could legitimately have been.
    await acquireSchedulerLease(harness.db, holderA, 50);
    await sleep(120);

    expect(await renewSchedulerLease(harness.db, holderA, 60_000)).toBe(false);
  });

  it('refuses to renew a lease that was never held', async () => {
    expect(await renewSchedulerLease(harness.db, holderA, 60_000)).toBe(false);
  });
});

describe('releaseSchedulerLease', () => {
  it('frees the lease immediately for a clean handover', async () => {
    await acquireSchedulerLease(harness.db, holderA, 60_000);
    await releaseSchedulerLease(harness.db, holderA);

    expect(await readSchedulerLease(harness.db)).toBeNull();
    expect((await acquireSchedulerLease(harness.db, holderB, 60_000))?.holderId).toBe(
      holderB.holderId,
    );
  });

  it('ignores a release from a process that does not hold it', async () => {
    // A late shutdown from a replica that already lost the lease must not
    // evict the current leader.
    await acquireSchedulerLease(harness.db, holderA, 60_000);
    await releaseSchedulerLease(harness.db, holderB);

    expect((await readSchedulerLease(harness.db))?.holderId).toBe(holderA.holderId);
  });
});

describe('heartbeats', () => {
  it('records and then updates in place', async () => {
    const workerId = randomUUID();

    await recordHeartbeat(harness.db, { workerId, role: 'worker' }, 0);
    await sleep(20);
    await recordHeartbeat(harness.db, { workerId, role: 'scheduler' }, 3);

    const rows = await harness.pool.query<{
      role: string;
      active_jobs: number;
      started_at: Date;
      last_seen_at: Date;
    }>('select role, active_jobs, started_at, last_seen_at from worker_heartbeats');

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.role).toBe('scheduler');
    expect(rows.rows[0]?.active_jobs).toBe(3);
    // started_at must survive the update, or uptime is unreportable.
    expect(rows.rows[0]!.last_seen_at.getTime()).toBeGreaterThan(
      rows.rows[0]!.started_at.getTime(),
    );
  });

  it('prunes only the stale ones', async () => {
    const alive = randomUUID();
    const dead = randomUUID();

    await recordHeartbeat(harness.db, { workerId: dead, role: 'worker' }, 0);
    await sleep(150);
    await recordHeartbeat(harness.db, { workerId: alive, role: 'worker' }, 0);

    expect(await pruneHeartbeats(harness.db, 100)).toBe(1);

    const remaining = await harness.pool.query<{ worker_id: string }>(
      'select worker_id from worker_heartbeats',
    );
    expect(remaining.rows.map((row) => row.worker_id)).toEqual([alive]);
  });
});
