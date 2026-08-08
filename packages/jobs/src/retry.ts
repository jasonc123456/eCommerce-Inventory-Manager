/**
 * When a failed job runs again, and when it stops (section 12).
 *
 * Pure and clock-free: every input is a parameter, including the randomness, so
 * the schedule can be tested for the properties it actually has to hold rather
 * than for one sampled run of it. The randomness matters more than it looks —
 * a fleet that retries on a fixed schedule reconverges on the same instant
 * after an outage and re-creates the load that caused it.
 *
 * The rules, from section 12 as amended by D-138 and D-139:
 *
 *   Ten attempts in total. Attempt one runs immediately, so there are nine
 *   delays, not ten. That off-by-one was a real ambiguity in the specification
 *   and is now fixed in one place, here, where it can be tested.
 *
 *   Full jitter. Each delay is drawn uniformly from zero to the nominal value,
 *   not from a band around it. Half of a spread-out retry is not much better
 *   than none, and the nominal figures below are ceilings rather than targets.
 *
 *   A provider's stated delay wins over the schedule, but never over the
 *   window. If honouring `Retry-After` would put the next attempt past the
 *   deadline, the job is dead-lettered now, with the provider's figure recorded
 *   as the reason. Sleeping past a deadline the system has already promised to
 *   abandon is worse than an honest failure, because the operator finds out
 *   twenty-four hours later instead of immediately.
 */

/** The longest delay in the schedule, and what anything past it repeats. */
const FINAL_DELAY_MS = 43_200_000; // 12h

/** The nine delays before attempts two through ten, before jitter. */
export const RETRY_DELAYS_MS: readonly number[] = [
  5_000, // 5s
  15_000, // 15s
  60_000, // 1m
  300_000, // 5m
  900_000, // 15m
  3_600_000, // 1h
  10_800_000, // 3h
  21_600_000, // 6h
  FINAL_DELAY_MS,
];

/**
 * The schedule as a lookup from one-based attempt number to delay.
 *
 * A map rather than an index into the array above, because an index needs a
 * bounds check whose failing side no caller can reach, and unreachable
 * defensive code is indistinguishable from untested code.
 */
const DELAY_BY_ATTEMPT = new Map(RETRY_DELAYS_MS.map((delay, index) => [index + 1, delay]));

export const MAX_ATTEMPTS = 10;

/** Section 12's dead-letter window, measured from the job's creation. */
export const DEAD_LETTER_WINDOW_MS = 24 * 60 * 60 * 1000;

export type RetryDecision =
  | { readonly decision: 'retry'; readonly runAt: Date; readonly delayMs: number }
  | { readonly decision: 'dead_letter'; readonly reason: DeadLetterReason };

export type DeadLetterReason =
  'attempts_exhausted' | 'window_elapsed' | 'retry_after_exceeds_window' | 'not_retryable';

export interface RetryInput {
  /** The attempt that just failed, one-based. */
  readonly attempt: number;
  readonly maxAttempts?: number;
  readonly now: Date;
  /** The job's deadline, fixed at enqueue. */
  readonly expiresAt: Date;
  /** What the provider asked for, when it asked. */
  readonly retryAfterMs?: number;
  /** Whether repeating this call unchanged could ever succeed. */
  readonly retryable?: boolean;
  /** Uniform in [0, 1). Injected so the schedule is testable. */
  readonly random?: () => number;
}

export function nextAttempt(input: RetryInput): RetryDecision {
  const maxAttempts = input.maxAttempts ?? MAX_ATTEMPTS;

  if (input.retryable === false) {
    // Section 12: validation, permission, missing-resource, and unsupported
    // operations are not retried blindly. Nothing about waiting changes the
    // answer, and nine more attempts only delay the alert a human needs.
    return { decision: 'dead_letter', reason: 'not_retryable' };
  }

  if (input.attempt >= maxAttempts) {
    return { decision: 'dead_letter', reason: 'attempts_exhausted' };
  }

  if (input.now.getTime() >= input.expiresAt.getTime()) {
    return { decision: 'dead_letter', reason: 'window_elapsed' };
  }

  const delayMs =
    input.retryAfterMs === undefined
      ? jitter(nominalDelayMs(input.attempt), input.random ?? Math.random)
      : // A provider-directed delay is taken literally. Jittering it would mean
        // either coming back early, which the provider just refused, or late,
        // which spends window the job may not have.
        Math.max(0, input.retryAfterMs);

  const runAt = new Date(input.now.getTime() + delayMs);

  if (runAt.getTime() > input.expiresAt.getTime()) {
    return {
      decision: 'dead_letter',
      reason: input.retryAfterMs === undefined ? 'window_elapsed' : 'retry_after_exceeds_window',
    };
  }

  return { decision: 'retry', runAt, delayMs };
}

/**
 * The delay after a given one-based attempt, before jitter.
 *
 * Attempts past the end of the table would only be reached with a
 * `maxAttempts` above ten, which nothing configures today; the last delay is
 * repeated rather than throwing, because a queue is the wrong place to discover
 * a configuration mistake by crashing the worker that found it.
 */
export function nominalDelayMs(attempt: number): number {
  return DELAY_BY_ATTEMPT.get(attempt) ?? FINAL_DELAY_MS;
}

/** Full jitter: uniform across the whole interval, not a band around it. */
function jitter(delayMs: number, random: () => number): number {
  return Math.floor(random() * delayMs);
}

/**
 * The unjittered span of the whole schedule.
 *
 * About 22.4 hours, which is what leaves headroom inside the 24-hour window for
 * the attempts themselves to take time. Exported so the test can assert the
 * relationship rather than restate the number.
 */
export function totalScheduleMs(): number {
  return RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
}
