import { describe, expect, it } from 'vitest';

import { createExhaustionCache, startOfWindow } from './limiter';
import { delayForAttempt } from './pressure';
import { AUTHENTICATION_RULES, EMAIL_CHALLENGE_PER_EMAIL, EMAIL_CHALLENGE_PER_IP } from './rules';

describe('the rule catalogue', () => {
  it('throttles sign-in requests rather than budgeting them', () => {
    // One per address per minute, for as long as somebody keeps asking. The
    // owner amendment behind this is D-181: a person whose first link was eaten
    // by a mail gateway must not spend a fifteen-minute allowance discovering
    // that and then be locked out with no way in.
    expect(EMAIL_CHALLENGE_PER_EMAIL).toMatchObject({ limit: 1, windowSeconds: 60 });
  });

  it('keeps the network limit above what one person can consume', () => {
    // Otherwise the per-address throttle would be undone by the per-network one,
    // and the eleven-minute lockout would come back through the other door.
    const perHour = 3600 / EMAIL_CHALLENGE_PER_EMAIL.windowSeconds;

    expect(EMAIL_CHALLENGE_PER_IP.windowSeconds).toBe(3600);
    expect(EMAIL_CHALLENGE_PER_IP.limit).toBeGreaterThan(perHour);
  });

  it('gives every rule its own bucket', () => {
    const buckets = AUTHENTICATION_RULES.map((rule) => rule.bucket);

    expect(new Set(buckets).size).toBe(buckets.length);
  });

  it('declares a positive limit and window for every rule', () => {
    for (const rule of AUTHENTICATION_RULES) {
      expect(rule.limit).toBeGreaterThan(0);
      expect(rule.windowSeconds).toBeGreaterThan(0);
      expect(rule.description.length).toBeGreaterThan(0);
    }
  });
});

describe('startOfWindow', () => {
  it('aligns to the epoch, so every replica agrees without coordinating', () => {
    const start = startOfWindow(new Date('2026-08-05T12:07:31.482Z'), 900);

    expect(start.toISOString()).toBe('2026-08-05T12:00:00.000Z');
  });

  it('puts two instants in the same window on the same boundary', () => {
    const a = startOfWindow(new Date('2026-08-05T12:00:00.000Z'), 900);
    const b = startOfWindow(new Date('2026-08-05T12:14:59.999Z'), 900);

    expect(a.getTime()).toBe(b.getTime());
  });

  it('moves to the next boundary at the edge', () => {
    const a = startOfWindow(new Date('2026-08-05T12:14:59.999Z'), 900);
    const b = startOfWindow(new Date('2026-08-05T12:15:00.000Z'), 900);

    expect(b.getTime() - a.getTime()).toBe(900_000);
  });
});

describe('the exhaustion cache', () => {
  it('reports an exhausted key until its window ends', () => {
    const cache = createExhaustionCache();
    const until = new Date(Date.now() + 60_000);

    cache.markExhausted('key', until);

    expect(cache.exhaustedUntil('key')).toEqual(until);
  });

  it('forgets a key whose window has passed', () => {
    const cache = createExhaustionCache();

    cache.markExhausted('key', new Date(Date.now() - 1));

    expect(cache.exhaustedUntil('key')).toBeUndefined();
  });

  it('knows nothing about a key it was never told about', () => {
    // Never caching permission is the point: a cold replica has to ask
    // PostgreSQL, so a restart cannot hand an attacker a fresh budget.
    expect(createExhaustionCache().exhaustedUntil('unseen')).toBeUndefined();
  });

  it('stays bounded, because the subject is attacker-supplied', () => {
    const cache = createExhaustionCache(3);
    const until = new Date(Date.now() + 60_000);

    for (const key of ['a', 'b', 'c', 'd']) {
      cache.markExhausted(key, until);
    }

    expect(cache.exhaustedUntil('a')).toBeUndefined();
    expect(cache.exhaustedUntil('d')).toEqual(until);
  });
});

describe('progressive delay', () => {
  it('is free for the first two failures', () => {
    // Mistyping a code is ordinary. A delay there is felt only by people who
    // are not attacking anything.
    expect(delayForAttempt(1)).toBe(0);
    expect(delayForAttempt(2)).toBe(0);
  });

  it('rises with each further failure', () => {
    const delays = [3, 4, 5, 6, 7, 8].map((attempt) => delayForAttempt(attempt));

    expect(delays).toEqual([1, 2, 5, 10, 30, 60]);
  });

  it('stops rising, so it never becomes the lockout it replaces', () => {
    expect(delayForAttempt(50)).toBe(60);
    expect(delayForAttempt(5000)).toBe(60);
  });
});
