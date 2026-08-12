import { schedulerLeases, workerHeartbeats } from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { assessHealth, readDisk } from './report';

/**
 * The detailed health surface (section 22).
 *
 * The property worth proving is that this screen survives the situation it
 * exists for. An operator opens it *because* something is wrong, so a check
 * that throws when its dependency is broken would take the diagnosis away at
 * the moment it was needed.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

beforeEach(async () => {
  await harness.db.delete(workerHeartbeats);
  await harness.db.delete(schedulerLeases);
});

afterAll(async () => {
  await harness.drop();
});

function ports(overrides: Record<string, unknown> = {}) {
  return { db: harness.db, pool: harness.pool, ...overrides };
}

describe('assessHealth', () => {
  it('reports every check, and names each one', async () => {
    const report = await assessHealth(ports());

    expect(report.checks.map((check) => check.name)).toEqual([
      'database',
      'schema',
      'clock',
      'scheduler',
      'workers',
      'queue',
      'storage',
      'backups',
      'versions',
    ]);
  });

  it('is content with a database it agrees with', async () => {
    const report = await assessHealth(ports());

    expect(report.checks.find((check) => check.name === 'database')?.status).toBe('ok');
    expect(report.checks.find((check) => check.name === 'schema')?.status).toBe('ok');
    expect(report.checks.find((check) => check.name === 'clock')?.status).toBe('ok');
  });

  it('says nothing is scheduling work when nothing is', async () => {
    const report = await assessHealth(ports());
    const scheduler = report.checks.find((check) => check.name === 'scheduler');

    expect(scheduler?.status).toBe('failing');
    expect(scheduler?.detail).toBe('has never reported');
    expect(scheduler?.remediation).toContain('worker service');
  });

  it('is content once something is beating', async () => {
    await harness.db.insert(schedulerLeases).values({
      role: 'scheduler',
      holderId: '11111111-1111-1111-1111-111111111111',
      expiresAt: new Date(Date.now() + 60_000),
    });
    await harness.db.insert(workerHeartbeats).values({
      workerId: '22222222-2222-2222-2222-222222222222',
      role: 'worker',
    });

    const report = await assessHealth(ports());

    expect(report.checks.find((check) => check.name === 'scheduler')?.status).toBe('ok');
    expect(report.checks.find((check) => check.name === 'workers')?.status).toBe('ok');
  });

  it('reads the freshest worker rather than the oldest', async () => {
    // A worker replaced during a deployment leaves a stale row behind, and
    // treating that as a failure would make every restart look like an outage.
    await harness.db.insert(workerHeartbeats).values([
      {
        workerId: '33333333-3333-3333-3333-333333333333',
        role: 'worker',
        lastSeenAt: new Date(Date.now() - 3_600_000),
      },
      {
        workerId: '44444444-4444-4444-4444-444444444444',
        role: 'worker',
        lastSeenAt: new Date(),
      },
    ]);

    expect(
      (await assessHealth(ports())).checks.find((check) => check.name === 'workers')?.status,
    ).toBe('ok');
  });

  it('notices a mixed rollout', async () => {
    await harness.db.insert(workerHeartbeats).values({
      workerId: '55555555-5555-5555-5555-555555555555',
      role: 'worker',
      appVersion: '1.2.0',
    });

    const versions = (await assessHealth(ports({ appVersion: '1.3.0' }))).checks.find(
      (check) => check.name === 'versions',
    );

    expect(versions?.status).toBe('degraded');
    expect(versions?.detail).toBe('web 1.3.0, worker 1.2.0');
  });

  it('does not treat an absent queue as a broken one', async () => {
    // An installation that has never started a worker has no queue rather than
    // a stalled one.
    const queue = (await assessHealth(ports())).checks.find((check) => check.name === 'queue');

    expect(queue?.status).toBe('ok');
  });

  it('measures the volume the data root is on', async () => {
    const storage = (await assessHealth(ports({ dataRoot: '/' }))).checks.find(
      (check) => check.name === 'storage',
    );

    expect(storage?.detail).toMatch(/free/u);
  });

  it('says a volume could not be measured rather than reporting it healthy', async () => {
    const storage = (await assessHealth(ports({ dataRoot: '/nowhere-at-all' }))).checks.find(
      (check) => check.name === 'storage',
    );

    expect(storage?.status).toBe('degraded');
    expect(storage?.remediation).toContain('readable');
  });

  it('is the worst of its parts', async () => {
    // The scheduler has never reported in this fixture, so the whole report
    // fails even though the database is fine.
    expect((await assessHealth(ports())).status).toBe('failing');
  });
});

describe('readDisk', () => {
  it('reports what is available rather than what is unallocated', async () => {
    // `bavail`, not `bfree`: the blocks reserved for root are not space this
    // application can have, and counting them is how a volume reports five
    // percent free right up until a write fails.
    const reading = await readDisk('/');

    expect(reading).not.toBeNull();
    expect(reading!.totalBytes).toBeGreaterThan(0);
    expect(reading!.freeBytes).toBeLessThanOrEqual(reading!.totalBytes);
  });

  it('answers null for a path that is not there', async () => {
    expect(await readDisk('/nowhere-at-all')).toBeNull();
  });
});
