import { businesses, connectionHealth, connections } from '@eim/db';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ORDER_POLL_JOB } from './pipeline';
import {
  readSyncSettings,
  schedulableConnections,
  scheduleConnection,
  setSyncPaused,
  setTargetInterval,
} from './schedule';

/**
 * The cadence, as it actually behaves against stored state (section 15).
 *
 * The rules themselves are proven as properties in `cadence.test.ts`. What
 * needs a database is that the schedule survives the process: every "when did
 * this last run" is a row, so a failover reads the same rows and reaches the
 * same conclusions rather than sweeping everything again.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

let counter = 0;

async function seed(status: 'active' | 'paused' = 'active') {
  const slug = `sched-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });

  const businessId = business!.id;

  const [connection] = await harness.db
    .insert(connections)
    .values({
      businessId,
      provider: 'woocommerce',
      environment: 'production',
      externalAccountId: `store-${slug}`,
      displayName: 'Test store',
      status,
      // The schema requires a paused connection to say why, which is the same
      // rule everywhere else: a state nobody can explain is not a state.
      ...(status === 'paused' ? { pauseReason: 'paused for this test' } : {}),
    })
    .returning({ id: connections.id });

  return { businessId, connectionId: connection!.id };
}

async function pollsQueued(connectionId: string): Promise<number> {
  const rows = await harness.db.execute<{ count: string }>(sql`
    select count(*)::text as count from background_jobs
     where connection_id = ${connectionId}::uuid and kind = ${ORDER_POLL_JOB}
  `);

  return Number(rows.rows[0]?.count ?? '0');
}

describe('readSyncSettings', () => {
  it('gives a connection the default cadence the first time it is asked about', async () => {
    const fixture = await seed();
    const settings = await readSyncSettings(harness.db, fixture);

    expect(settings.targetIntervalSeconds).toBe(30);
    expect(settings.effectiveIntervalSeconds).toBe(30);
    expect(settings.paused).toBe(false);
  });
});

describe('setTargetInterval', () => {
  it('accepts an interval inside section 15 bounds', async () => {
    const fixture = await seed();

    expect(await setTargetInterval(harness.db, { ...fixture, seconds: 120 })).toEqual({
      outcome: 'set',
      seconds: 120,
      clamped: false,
    });
    expect((await readSyncSettings(harness.db, fixture)).targetIntervalSeconds).toBe(120);
  });

  it('says so when it had to clamp', async () => {
    // Somebody who typed five seconds and got ten should be told. A settings
    // screen that appears to accept a value and then behaves otherwise is worse
    // than one that refuses.
    const fixture = await seed();

    expect(await setTargetInterval(harness.db, { ...fixture, seconds: 5 })).toEqual({
      outcome: 'set',
      seconds: 10,
      clamped: true,
    });
  });

  it('refuses a connection belonging to somebody else', async () => {
    const mine = await seed();
    const theirs = await seed();

    expect(
      await setTargetInterval(harness.db, {
        businessId: mine.businessId,
        connectionId: theirs.connectionId,
        seconds: 60,
      }),
    ).toEqual({ outcome: 'not_found' });
  });

  it('refuses to store an effective interval faster than the target', async () => {
    // The database backstop behind the one-way throttling rule. Going slower
    // than asked can be explained; going faster is a surprise.
    const fixture = await seed();
    await readSyncSettings(harness.db, fixture);

    await expect(
      harness.db.execute(sql`
        update connection_sync_settings
           set effective_interval_seconds = 5
         where connection_id = ${fixture.connectionId}::uuid
      `),
    ).rejects.toSatisfy((error: unknown) =>
      JSON.stringify(error).includes('connection_sync_settings_effective_not_faster'),
    );
  });
});

describe('scheduleConnection', () => {
  it('queues a poll the first time and not again until it is due', async () => {
    const fixture = await seed();

    const first = await scheduleConnection(harness.db, { ...fixture, random: () => 0 });
    expect(first.queued).toEqual([ORDER_POLL_JOB]);

    const second = await scheduleConnection(harness.db, { ...fixture, random: () => 0 });
    expect(second.queued).toEqual([]);
    expect(await pollsQueued(fixture.connectionId)).toBe(1);
  });

  it('remembers across a restart, because the schedule is a row', async () => {
    const fixture = await seed();
    await scheduleConnection(harness.db, { ...fixture, random: () => 0 });

    // A new leader takes over: same rows, same conclusions, no second sweep.
    const afterFailover = await scheduleConnection(harness.db, { ...fixture, random: () => 0 });

    expect(afterFailover.queued).toEqual([]);
  });

  it('stretches the interval when the connection is unwell, and says why', async () => {
    const fixture = await seed();
    await harness.db.insert(connectionHealth).values({
      businessId: fixture.businessId,
      connectionId: fixture.connectionId,
      status: 'failing',
      consecutiveFailures: 9,
    });

    const result = await scheduleConnection(harness.db, { ...fixture, random: () => 0 });

    expect(result.cadence.effectiveIntervalSeconds).toBe(240);
    expect(result.cadence.reason).toBe('the connection is failing');

    const stored = await readSyncSettings(harness.db, fixture);
    expect(stored.effectiveIntervalSeconds).toBe(240);
    expect(stored.effectiveReason).toBe('the connection is failing');
  });

  it('backs off rather than piling on when the backlog is not being worked through', async () => {
    const fixture = await seed();

    for (let index = 0; index < 250; index += 1) {
      await harness.db.execute(sql`
        insert into background_jobs (business_id, connection_id, kind, expires_at)
        values (${fixture.businessId}::uuid, ${fixture.connectionId}::uuid, 'test.backlog',
                now() + interval '1 hour')
      `);
    }

    const result = await scheduleConnection(harness.db, { ...fixture, random: () => 0 });

    expect(result.cadence.effectiveIntervalSeconds).toBeGreaterThan(30);
    expect(result.cadence.reason).toContain('waiting for this connection');
  });

  it('queues nothing for a connection whose sweeping is paused', async () => {
    const fixture = await seed();
    await setSyncPaused(harness.db, { ...fixture, paused: true, reason: 'the owner paused it' });

    const result = await scheduleConnection(harness.db, { ...fixture, random: () => 0 });

    expect(result.queued).toEqual([]);
    expect(result.skipped).toBe('the owner paused it');
    expect(await pollsQueued(fixture.connectionId)).toBe(0);
  });

  it('still records the cadence for a paused connection', async () => {
    // An operator looking at a paused connection should still see what the
    // interval would be, not a blank where the answer used to be.
    const fixture = await seed();
    await setSyncPaused(harness.db, { ...fixture, paused: true, reason: 'paused' });

    const result = await scheduleConnection(harness.db, { ...fixture, random: () => 0 });

    expect(result.cadence.targetIntervalSeconds).toBe(30);
  });
});

describe('schedulableConnections', () => {
  it('leaves out connections nobody wants us talking to', async () => {
    const active = await seed('active');
    const paused = await seed('paused');

    const listed = await schedulableConnections(harness.db);
    const ids = listed.map((entry) => entry.connectionId);

    expect(ids).toContain(active.connectionId);
    expect(ids).not.toContain(paused.connectionId);
  });
});
