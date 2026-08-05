import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { consume, createExhaustionCache, peek, pruneExpiredWindows } from './limiter';
import {
  clearPressure,
  pruneExpiredPressure,
  readPressure,
  recordFailure,
  remainingDelaySeconds,
} from './pressure';
import type { RateLimitRule } from './rules';

/**
 * The limiter against a real database.
 *
 * Everything worth proving here is about concurrency and durability, which a
 * fake cannot show: that two replicas share one budget, that a burst arriving
 * together cannot each see a count below the limit, and that a restart does not
 * hand an attacker a fresh allowance.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await createTestDatabase();
}, 120_000);

afterAll(async () => {
  await harness.drop();
});

let sequence = 0;

const rule = (limit: number, windowSeconds = 900): RateLimitRule => {
  sequence += 1;

  return {
    bucket: `test:bucket:${String(sequence)}`,
    limit,
    windowSeconds,
    description: 'test',
  };
};

const subject = (): string => `subject-${String((sequence += 1))}`;

describe('consume', () => {
  it('permits up to the limit and refuses beyond it', async () => {
    const limit = rule(3);
    const who = subject();

    const decisions = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      decisions.push(await consume(harness.db, limit, who));
    }

    expect(decisions.map((decision) => decision.allowed)).toEqual([true, true, true, false, false]);
    expect(decisions[0]!.remaining).toBe(2);
    expect(decisions[2]!.remaining).toBe(0);
  });

  it('counts each subject separately', async () => {
    const limit = rule(1);

    expect((await consume(harness.db, limit, subject())).allowed).toBe(true);
    expect((await consume(harness.db, limit, subject())).allowed).toBe(true);
  });

  it('counts each bucket separately', async () => {
    const who = subject();

    expect((await consume(harness.db, rule(1), who)).allowed).toBe(true);
    expect((await consume(harness.db, rule(1), who)).allowed).toBe(true);
  });

  it('offers a Retry-After that outlasts the window', async () => {
    const limit = rule(1, 60);
    const who = subject();

    await consume(harness.db, limit, who);
    const denied = await consume(harness.db, limit, who);

    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
    expect(denied.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(denied.resetAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('holds one budget across replicas', async () => {
    // Two caches standing in for two web processes. The budget is in
    // PostgreSQL, so the second process sees what the first spent.
    const limit = rule(2);
    const who = subject();
    const replicaOne = createExhaustionCache();
    const replicaTwo = createExhaustionCache();

    expect((await consume(harness.db, limit, who, { cache: replicaOne })).allowed).toBe(true);
    expect((await consume(harness.db, limit, who, { cache: replicaTwo })).allowed).toBe(true);
    expect((await consume(harness.db, limit, who, { cache: replicaTwo })).allowed).toBe(false);
    expect((await consume(harness.db, limit, who, { cache: replicaOne })).allowed).toBe(false);
  });

  it('does not hand a restarted replica a fresh allowance', async () => {
    const limit = rule(1);
    const who = subject();

    await consume(harness.db, limit, who, { cache: createExhaustionCache() });

    // A brand new cache is exactly what a restart produces.
    const afterRestart = await consume(harness.db, limit, who, {
      cache: createExhaustionCache(),
    });

    expect(afterRestart.allowed).toBe(false);
  });

  it('cannot be beaten by a burst arriving together', async () => {
    // The increment and the comparison are one statement, so ten concurrent
    // callers cannot each read a count below the limit before any of them
    // writes.
    const limit = rule(3);
    const who = subject();

    const results = await Promise.all(
      Array.from({ length: 10 }, () => consume(harness.db, limit, who)),
    );

    expect(results.filter((decision) => decision.allowed)).toHaveLength(3);
  });

  it('starts a fresh budget in the next window', async () => {
    const limit = rule(1, 60);
    const who = subject();
    const now = new Date('2026-08-05T12:00:30.000Z');

    expect((await consume(harness.db, limit, who, { now })).allowed).toBe(true);
    expect((await consume(harness.db, limit, who, { now })).allowed).toBe(false);

    const nextWindow = new Date('2026-08-05T12:01:05.000Z');
    expect((await consume(harness.db, limit, who, { now: nextWindow })).allowed).toBe(true);
  });

  it('keeps counting an exhausted subject, so hammering does not help', async () => {
    const limit = rule(1);
    const who = subject();

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await consume(harness.db, limit, who);
    }

    expect((await peek(harness.db, limit, who)).used).toBe(4);
  });
});

describe('peek', () => {
  it('reports usage without spending any', async () => {
    const limit = rule(5);
    const who = subject();

    await consume(harness.db, limit, who);

    expect(await peek(harness.db, limit, who)).toMatchObject({ used: 1, remaining: 4 });
    expect(await peek(harness.db, limit, who)).toMatchObject({ used: 1, remaining: 4 });
  });

  it('reports an untouched subject as unused', async () => {
    expect(await peek(harness.db, rule(5), subject())).toMatchObject({ used: 0, remaining: 5 });
  });
});

describe('pruneExpiredWindows', () => {
  it('removes windows that have ended and leaves live ones', async () => {
    const limit = rule(5, 60);
    const stale = subject();
    const live = subject();

    await consume(harness.db, limit, stale, { now: new Date('2026-08-05T12:00:00.000Z') });
    await consume(harness.db, limit, live);

    const removed = await pruneExpiredWindows(harness.db, new Date('2026-08-05T13:00:00.000Z'));

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await peek(harness.db, limit, live)).toMatchObject({ used: 1 });
  });
});

describe('authentication pressure', () => {
  it('is free for the first two failures and then makes the caller wait', async () => {
    const who = subject();

    expect((await recordFailure(harness.db, who)).delaySeconds).toBe(0);
    expect((await recordFailure(harness.db, who)).delaySeconds).toBe(0);

    const third = await recordFailure(harness.db, who);
    expect(third.failedAttempts).toBe(3);
    expect(third.delaySeconds).toBe(1);
    expect(third.nextAttemptAllowedAt).not.toBeNull();
  });

  it('survives a new challenge, because it is keyed on the address', async () => {
    // Section 20 requires failed-attempt pressure to be retained across
    // resends. A counter on the challenge row would reset here.
    const who = subject();

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await recordFailure(harness.db, who);
    }

    expect((await readPressure(harness.db, who))!.failedAttempts).toBe(5);
  });

  it('reports the remaining wait and lets it elapse', async () => {
    const who = subject();
    const start = new Date('2026-08-05T12:00:00.000Z');

    // Five failures, which the schedule prices at five seconds.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await recordFailure(harness.db, who, start);
    }

    expect(await remainingDelaySeconds(harness.db, who, start)).toBe(5);
    expect(await remainingDelaySeconds(harness.db, who, new Date('2026-08-05T12:00:06.000Z'))).toBe(
      0,
    );
  });

  it('reports no wait for a subject that has never failed', async () => {
    expect(await remainingDelaySeconds(harness.db, subject())).toBe(0);
    expect(await readPressure(harness.db, subject())).toBeNull();
  });

  it('clears on success, which is what keeps the cost asymmetric', async () => {
    const who = subject();

    await recordFailure(harness.db, who);
    await recordFailure(harness.db, who);
    await recordFailure(harness.db, who);
    await clearPressure(harness.db, who);

    expect(await readPressure(harness.db, who)).toBeNull();
    expect(await remainingDelaySeconds(harness.db, who)).toBe(0);
  });

  it('prunes records that have gone quiet', async () => {
    const who = subject();
    await recordFailure(harness.db, who, new Date('2026-08-05T12:00:00.000Z'));

    const removed = await pruneExpiredPressure(harness.db, new Date('2026-08-07T12:00:00.000Z'));

    expect(removed).toBeGreaterThanOrEqual(1);
    expect(await readPressure(harness.db, who)).toBeNull();
  });
});
