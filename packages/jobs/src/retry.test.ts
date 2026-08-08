import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DEAD_LETTER_WINDOW_MS,
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  nextAttempt,
  nominalDelayMs,
  totalScheduleMs,
} from './retry';

const now = new Date('2026-08-08T00:00:00.000Z');
const window = new Date(now.getTime() + DEAD_LETTER_WINDOW_MS);

describe('the retry schedule', () => {
  it('has one fewer delay than it has attempts', () => {
    // Section 12 as amended by D-138. The specification originally read as ten
    // delays for ten attempts, which is one retry too many and half a day of
    // schedule that does not exist. Attempt one runs immediately.
    expect(RETRY_DELAYS_MS).toHaveLength(MAX_ATTEMPTS - 1);
  });

  it('fits inside the dead-letter window with room for the attempts themselves', () => {
    expect(totalScheduleMs()).toBeLessThan(DEAD_LETTER_WINDOW_MS);
    // About 22.4 hours: enough headroom that a job is not dead-lettered purely
    // because its own provider calls took time.
    expect(DEAD_LETTER_WINDOW_MS - totalScheduleMs()).toBeGreaterThan(60 * 60 * 1000);
  });

  it('never shortens', () => {
    for (let index = 1; index < RETRY_DELAYS_MS.length; index += 1) {
      expect(RETRY_DELAYS_MS[index]).toBeGreaterThan(RETRY_DELAYS_MS[index - 1] ?? 0);
    }
  });
});

describe('nextAttempt', () => {
  it('retries the first nine failures and dead-letters the tenth', () => {
    const outcomes = Array.from({ length: MAX_ATTEMPTS }, (_, index) =>
      nextAttempt({ attempt: index + 1, now, expiresAt: window, random: () => 0.5 }),
    );

    expect(outcomes.slice(0, 9).map((o) => o.decision)).toEqual(Array(9).fill('retry'));
    expect(outcomes[9]).toEqual({ decision: 'dead_letter', reason: 'attempts_exhausted' });
  });

  it('draws each delay from the whole interval, not a band around it', () => {
    // Full jitter, section 12. The lower end has to actually be reachable: a
    // fleet that all waits four-fifths of the nominal delay has not spread out.
    const lowest = nextAttempt({ attempt: 5, now, expiresAt: window, random: () => 0 });
    const highest = nextAttempt({ attempt: 5, now, expiresAt: window, random: () => 0.999_999 });

    expect(lowest).toMatchObject({ decision: 'retry', delayMs: 0 });
    expect(highest).toMatchObject({ decision: 'retry' });
    if (highest.decision === 'retry') {
      expect(highest.delayMs).toBeLessThan(nominalDelayMs(5));
      expect(highest.delayMs).toBeGreaterThan(nominalDelayMs(5) * 0.9);
    }
  });

  it('does not retry what cannot succeed', () => {
    expect(nextAttempt({ attempt: 1, now, expiresAt: window, retryable: false })).toEqual({
      decision: 'dead_letter',
      reason: 'not_retryable',
    });
  });

  it('takes a provider delay literally instead of jittering it', () => {
    const decision = nextAttempt({
      attempt: 1,
      now,
      expiresAt: window,
      retryAfterMs: 90_000,
      random: () => 0,
    });

    expect(decision).toEqual({
      decision: 'retry',
      delayMs: 90_000,
      runAt: new Date(now.getTime() + 90_000),
    });
  });

  it('dead-letters rather than sleeping past the window', () => {
    // D-139. The provider says come back in three hours; the job has one hour
    // of window left. Scheduling it would promise a retry the system has
    // already decided to abandon, and the operator would find out three hours
    // later instead of now.
    const decision = nextAttempt({
      attempt: 1,
      now,
      expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
      retryAfterMs: 3 * 60 * 60 * 1000,
    });

    expect(decision).toEqual({ decision: 'dead_letter', reason: 'retry_after_exceeds_window' });
  });

  it('dead-letters once the window has already elapsed', () => {
    expect(nextAttempt({ attempt: 2, now, expiresAt: new Date(now.getTime() - 1) })).toEqual({
      decision: 'dead_letter',
      reason: 'window_elapsed',
    });
  });

  it('falls back to the ambient clock when no randomness is supplied', () => {
    const decision = nextAttempt({ attempt: 1, now, expiresAt: window });

    expect(decision.decision).toBe('retry');
    if (decision.decision === 'retry') {
      expect(decision.delayMs).toBeGreaterThanOrEqual(0);
      expect(decision.delayMs).toBeLessThan(nominalDelayMs(1));
    }
  });

  it('treats a negative provider delay as no delay at all', () => {
    // Not hypothetical: a `Retry-After` date already in the past parses to a
    // negative interval, and subtracting it from now would schedule the retry
    // before the failure that caused it.
    const decision = nextAttempt({ attempt: 1, now, expiresAt: window, retryAfterMs: -5_000 });

    expect(decision).toEqual({ decision: 'retry', delayMs: 0, runAt: now });
  });

  it('repeats the last delay for an attempt past the end of the table', () => {
    expect(nominalDelayMs(1)).toBe(RETRY_DELAYS_MS[0]);
    expect(nominalDelayMs(99)).toBe(RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]);
  });

  it('never schedules an attempt beyond the deadline', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: MAX_ATTEMPTS - 1 }),
        fc.integer({ min: 0, max: DEAD_LETTER_WINDOW_MS }),
        fc.double({ min: 0, max: 0.999_999, noNaN: true }),
        (attempt, remainingMs, roll) => {
          const expiresAt = new Date(now.getTime() + remainingMs);
          const decision = nextAttempt({ attempt, now, expiresAt, random: () => roll });

          if (decision.decision === 'retry') {
            expect(decision.runAt.getTime()).toBeLessThanOrEqual(expiresAt.getTime());
            expect(decision.runAt.getTime()).toBeGreaterThanOrEqual(now.getTime());
          }
        },
      ),
    );
  });
});
