/**
 * When to try again, and when to stop (section 12, D-139).
 *
 * The schedule is fixed by the specification: at most ten attempts, the first
 * immediate, and nine delays of roughly 5s, 15s, 1m, 5m, 15m, 1h, 3h, 6h, and
 * 12h before attempts two through ten. Unjittered that spans about 22.4 hours,
 * which is deliberately inside the 24-hour dead-letter window rather than
 * exactly at it.
 *
 * Two rules here are easy to get backwards, and both are about honesty.
 *
 * Full jitter, not a jittered fraction. Every retry of every job of a given age
 * would otherwise fire at the same moment after an outage — the thundering herd
 * that turns a recovered provider back into a failing one.
 *
 * A provider-directed delay that would push past the window dead-letters the
 * job immediately rather than scheduling a wake-up nobody will honour. A retry
 * the system has already decided to abandon is worse than an honest failure,
 * because it reads as "still trying" on every screen that shows it.
 */

export const MAX_ATTEMPTS = 10;

/** The nine delays before attempts two through ten, in milliseconds. */
export const DELAY_SCHEDULE_MS: readonly number[] = [
  5_000,
  15_000,
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
  3 * 60 * 60_000,
  6 * 60 * 60_000,
  12 * 60 * 60_000,
];

/** The window a job may live in before it is dead-lettered regardless. */
export const DEAD_LETTER_WINDOW_MS = 24 * 60 * 60_000;

export type RetryDecision =
  | { readonly retry: true; readonly delayMs: number; readonly attempt: number }
  | { readonly retry: false; readonly reason: DeadLetterReason };

export type DeadLetterReason =
  'attempts_exhausted' | 'window_exceeded' | 'provider_delay_exceeds_window' | 'not_retryable';

export interface RetryContext {
  /** How many attempts have already been made, including the one that just failed. */
  readonly attemptsMade: number;
  /** When the job first ran. The window is measured from here, not from now. */
  readonly firstAttemptAt: Date;
  readonly now: Date;
  /** Whether the failure is one that repeating unchanged could fix. */
  readonly retryable: boolean;
  /** A provider-stated delay, when the provider stated one. */
  readonly providerDelayMs?: number;
  /** Injectable for tests. Returns a number in [0, 1). */
  readonly random?: () => number;
}

export function decideRetry(context: RetryContext): RetryDecision {
  if (!context.retryable) {
    return { retry: false, reason: 'not_retryable' };
  }

  if (context.attemptsMade >= MAX_ATTEMPTS) {
    return { retry: false, reason: 'attempts_exhausted' };
  }

  const deadline = context.firstAttemptAt.getTime() + DEAD_LETTER_WINDOW_MS;
  const elapsedAlready = context.now.getTime() >= deadline;

  if (elapsedAlready) {
    return { retry: false, reason: 'window_exceeded' };
  }

  const random = context.random ?? Math.random;

  // attemptsMade is 1-based on the attempt that just failed, and the delay
  // before attempt two is the first entry.
  const scheduled = DELAY_SCHEDULE_MS[context.attemptsMade - 1];

  if (scheduled === undefined) {
    return { retry: false, reason: 'attempts_exhausted' };
  }

  const delayMs = context.providerDelayMs ?? Math.floor(random() * scheduled);

  if (context.now.getTime() + delayMs >= deadline) {
    return {
      retry: false,
      reason:
        context.providerDelayMs === undefined ? 'window_exceeded' : 'provider_delay_exceeds_window',
    };
  }

  return { retry: true, delayMs, attempt: context.attemptsMade + 1 };
}

/**
 * Reads a `Retry-After` header.
 *
 * Both forms are real: a delay in seconds, and an HTTP date. A provider that
 * sends a date in the past means "now", not "negative time ago".
 */
export function parseRetryAfter(value: string | undefined, now: Date): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();

  if (trimmed === '') {
    return undefined;
  }

  if (/^\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10) * 1000;
  }

  const at = Date.parse(trimmed);

  if (Number.isNaN(at)) {
    return undefined;
  }

  return Math.max(0, at - now.getTime());
}
