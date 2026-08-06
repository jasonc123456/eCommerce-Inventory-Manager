import { describe, expect, it } from 'vitest';

import {
  DEAD_LETTER_WINDOW_MS,
  DELAY_SCHEDULE_MS,
  MAX_ATTEMPTS,
  decideRetry,
  parseRetryAfter,
} from './backoff';

/**
 * The retry schedule (section 12, D-139).
 *
 * The off-by-one this encodes was a genuine defect in the specification before
 * D-139: ten attempts need nine delays, and reading it as ten produced a
 * schedule that ran past the dead-letter window it was designed to fit inside.
 */

const START = new Date('2026-01-01T00:00:00Z');

const context = (overrides: Partial<Parameters<typeof decideRetry>[0]> = {}) => ({
  attemptsMade: 1,
  firstAttemptAt: START,
  now: START,
  retryable: true,
  // Full jitter, pinned to its maximum so the assertions are about the schedule
  // rather than about chance.
  random: () => 0.999_999,
  ...overrides,
});

describe('decideRetry', () => {
  it('has nine delays for ten attempts', () => {
    expect(DELAY_SCHEDULE_MS).toHaveLength(MAX_ATTEMPTS - 1);
  });

  it('fits inside the dead-letter window unjittered', () => {
    const total = DELAY_SCHEDULE_MS.reduce((sum, delay) => sum + delay, 0);

    expect(total).toBeLessThan(DEAD_LETTER_WINDOW_MS);
    // And is not trivially short: the point is to use most of the day.
    expect(total).toBeGreaterThan(20 * 60 * 60_000);
  });

  it('retries with a delay drawn from the schedule', () => {
    const decision = decideRetry(context({ attemptsMade: 1 }));

    expect(decision).toMatchObject({ retry: true, attempt: 2 });
    expect(decision.retry && decision.delayMs).toBeLessThanOrEqual(DELAY_SCHEDULE_MS[0]!);
  });

  it('uses full jitter, so a recovered provider is not hit by a herd', () => {
    const early = decideRetry(context({ attemptsMade: 3, random: () => 0 }));
    const late = decideRetry(context({ attemptsMade: 3, random: () => 0.999 }));

    expect(early.retry && early.delayMs).toBe(0);
    expect(late.retry && late.delayMs).toBeGreaterThan(0);
    expect(late.retry && late.delayMs).toBeLessThan(DELAY_SCHEDULE_MS[2]!);
  });

  it('stops after the tenth attempt', () => {
    expect(decideRetry(context({ attemptsMade: MAX_ATTEMPTS }))).toEqual({
      retry: false,
      reason: 'attempts_exhausted',
    });
  });

  it('never retries a failure that repeating cannot fix', () => {
    expect(decideRetry(context({ retryable: false }))).toEqual({
      retry: false,
      reason: 'not_retryable',
    });
  });

  it('stops once the window has passed, however few attempts were made', () => {
    const decision = decideRetry(
      context({
        attemptsMade: 2,
        now: new Date(START.getTime() + DEAD_LETTER_WINDOW_MS + 1),
      }),
    );

    expect(decision).toEqual({ retry: false, reason: 'window_exceeded' });
  });

  it('honours a provider-stated delay over the schedule', () => {
    const decision = decideRetry(context({ attemptsMade: 1, providerDelayMs: 90_000 }));

    expect(decision).toEqual({ retry: true, delayMs: 90_000, attempt: 2 });
  });

  it('dead-letters immediately when the stated delay runs past the window', () => {
    // Scheduling a wake-up nobody will honour reads as "still trying" on every
    // screen that shows it. D-139 makes the failure honest instead.
    const decision = decideRetry(
      context({
        attemptsMade: 2,
        now: new Date(START.getTime() + 60_000),
        providerDelayMs: DEAD_LETTER_WINDOW_MS,
      }),
    );

    expect(decision).toEqual({ retry: false, reason: 'provider_delay_exceeds_window' });
  });
});

describe('parseRetryAfter', () => {
  it('reads the seconds form', () => {
    expect(parseRetryAfter('120', START)).toBe(120_000);
    expect(parseRetryAfter(' 5 ', START)).toBe(5_000);
  });

  it('reads the date form', () => {
    expect(parseRetryAfter('Thu, 01 Jan 2026 00:02:00 GMT', START)).toBe(120_000);
  });

  it('treats a date in the past as now, not as negative time', () => {
    expect(parseRetryAfter('Wed, 31 Dec 2025 23:00:00 GMT', START)).toBe(0);
  });

  it('ignores what it cannot read', () => {
    for (const value of [undefined, '', '   ', 'soon', 'NaN']) {
      expect(parseRetryAfter(value, START)).toBeUndefined();
    }
  });
});
