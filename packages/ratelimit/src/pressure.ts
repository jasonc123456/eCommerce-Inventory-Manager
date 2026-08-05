import { authenticationPressure, type Database } from '@eim/db';
import { eq, lte, sql } from 'drizzle-orm';

/**
 * Progressive delay after failed authentication (section 20).
 *
 * Section 20 chooses "progressive delays and suspicious-activity challenges
 * rather than attacker-triggerable permanent account lockout", and the reason is
 * worth restating because lockout is the more obvious design: if failing on
 * purpose locks an account, then anybody who knows an address can deny its owner
 * access indefinitely, and the login form becomes a denial-of-service tool
 * aimed at the one user who is definitely legitimate.
 *
 * A delay costs an attacker linearly and a real user almost nothing, because a
 * real user fails once or twice and then succeeds, which clears the record.
 *
 * Pressure is tracked per address rather than per challenge, because section 20
 * requires it to survive a resend. A counter on the challenge would reset every
 * time a new code was requested.
 */

/**
 * Seconds to wait before the nth failure may be followed by another attempt.
 *
 * The first two failures are free: typing a code wrong is ordinary, and a delay
 * there is felt only by the people who are not attacking anything. It rises
 * steeply after that and stops at a minute, because a longer delay stops adding
 * deterrence and starts being indistinguishable from the lockout this avoids.
 */
const DELAY_SCHEDULE_SECONDS = [0, 0, 0, 1, 2, 5, 10, 30, 60] as const;

/** How long a quiet record is kept before it is pruned. */
const PRESSURE_TTL_SECONDS = 24 * 60 * 60;

export interface PressureState {
  readonly failedAttempts: number;
  /** Null when the next attempt may proceed immediately. */
  readonly nextAttemptAllowedAt: Date | null;
  readonly delaySeconds: number;
}

export function delayForAttempt(failedAttempts: number): number {
  const index = Math.min(failedAttempts, DELAY_SCHEDULE_SECONDS.length - 1);

  return DELAY_SCHEDULE_SECONDS[index] ?? 0;
}

/**
 * Records a failure and returns how long the subject must now wait.
 *
 * One statement, so two failures arriving together cannot both read the same
 * count and write the same delay.
 */
export async function recordFailure(
  db: Database,
  subjectFingerprint: string,
  now: Date = new Date(),
): Promise<PressureState> {
  const expiresAt = new Date(now.getTime() + PRESSURE_TTL_SECONDS * 1000);

  const [row] = await db
    .insert(authenticationPressure)
    .values({
      subjectFingerprint,
      failedAttempts: 1,
      firstFailureAt: now,
      lastFailureAt: now,
      nextAttemptAllowedAt: null,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: authenticationPressure.subjectFingerprint,
      set: {
        failedAttempts: sql`${authenticationPressure.failedAttempts} + 1`,
        lastFailureAt: now,
        expiresAt,
      },
    })
    .returning({ failedAttempts: authenticationPressure.failedAttempts });

  const failedAttempts = row?.failedAttempts ?? 1;
  const delaySeconds = delayForAttempt(failedAttempts);
  const nextAttemptAllowedAt =
    delaySeconds === 0 ? null : new Date(now.getTime() + delaySeconds * 1000);

  // Written back rather than computed on read, so the wait a caller was told
  // about is the wait the next request is measured against even if the schedule
  // is changed underneath it.
  await db
    .update(authenticationPressure)
    .set({ nextAttemptAllowedAt })
    .where(eq(authenticationPressure.subjectFingerprint, subjectFingerprint));

  return { failedAttempts, nextAttemptAllowedAt, delaySeconds };
}

/**
 * How long the subject must wait before another attempt is accepted.
 *
 * Returns zero when there is nothing to wait for, which is the common case and
 * costs one indexed lookup.
 */
export async function remainingDelaySeconds(
  db: Database,
  subjectFingerprint: string,
  now: Date = new Date(),
): Promise<number> {
  const [row] = await db
    .select({ nextAttemptAllowedAt: authenticationPressure.nextAttemptAllowedAt })
    .from(authenticationPressure)
    .where(eq(authenticationPressure.subjectFingerprint, subjectFingerprint));

  const next = row?.nextAttemptAllowedAt;

  if (next === undefined || next === null || next.getTime() <= now.getTime()) {
    return 0;
  }

  return Math.ceil((next.getTime() - now.getTime()) / 1000);
}

export async function readPressure(
  db: Database,
  subjectFingerprint: string,
): Promise<PressureState | null> {
  const [row] = await db
    .select()
    .from(authenticationPressure)
    .where(eq(authenticationPressure.subjectFingerprint, subjectFingerprint));

  if (row === undefined) {
    return null;
  }

  return {
    failedAttempts: row.failedAttempts,
    nextAttemptAllowedAt: row.nextAttemptAllowedAt,
    delaySeconds: delayForAttempt(row.failedAttempts),
  };
}

/**
 * Clears the record after a successful authentication.
 *
 * This is what keeps the cost asymmetric. A real user who mistyped a code twice
 * and then got it right starts from zero again; an attacker who never succeeds
 * never does.
 */
export async function clearPressure(db: Database, subjectFingerprint: string): Promise<void> {
  await db
    .delete(authenticationPressure)
    .where(eq(authenticationPressure.subjectFingerprint, subjectFingerprint));
}

export async function pruneExpiredPressure(db: Database, now: Date = new Date()): Promise<number> {
  const removed = await db
    .delete(authenticationPressure)
    .where(lte(authenticationPressure.expiresAt, now))
    .returning({ subjectFingerprint: authenticationPressure.subjectFingerprint });

  return removed.length;
}
