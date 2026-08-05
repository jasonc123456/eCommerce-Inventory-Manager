import { rateLimitWindows, type Database } from '@eim/db';
import { lte, sql } from 'drizzle-orm';

import type { RateLimitRule } from './rules';

/**
 * Fixed-window rate limiting in PostgreSQL (section 19, D-046).
 *
 * There is no Redis, so the counter has to be somewhere both web replicas can
 * see, and that leaves the database. A fixed window rather than a sliding one
 * because it costs a single upsert: a sliding window needs either a sorted set
 * or a row per event, and paying that on the sign-in path of a self-hosted
 * installation buys precision nobody asked for.
 *
 * The known cost of a fixed window is the boundary: a subject can spend its
 * whole budget at the end of one window and again at the start of the next, so
 * the true short-term ceiling is twice the limit. For the numbers section 20
 * sets — five sign-in requests per address per fifteen minutes — ten in quick
 * succession is still nowhere near useful to an attacker, and the alternative
 * complicates the hottest authentication query for no security gain.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** How many operations remain in the current window. Never negative. */
  readonly remaining: number;
  /** When the current window ends and the budget resets. */
  readonly resetAt: Date;
  /** Seconds until the reset, for a Retry-After header. Zero when allowed. */
  readonly retryAfterSeconds: number;
}

/**
 * The per-replica pre-filter (section 19).
 *
 * Caches exhaustion and nothing else. A replica may remember "this subject is
 * already over its limit until 12:45" and reject without a query; it may never
 * remember that a subject has budget left, because that is the direction in
 * which being wrong costs something. A restart, a cold replica, or an uneven
 * load balancer therefore falls back to asking PostgreSQL, which is the only
 * thing that decides whether a window is exhausted.
 */
export interface ExhaustionCache {
  exhaustedUntil(key: string): Date | undefined;
  markExhausted(key: string, until: Date): void;
}

/**
 * A bounded in-memory cache.
 *
 * Bounded because the key includes the subject, and the subject on the sign-in
 * path is attacker-supplied: an unbounded map here would turn the rate limiter
 * into the memory-exhaustion vector it exists to prevent. Eviction is oldest
 * first and only ever loses a rejection that PostgreSQL will make again.
 */
export function createExhaustionCache(maxEntries = 10_000): ExhaustionCache {
  const entries = new Map<string, Date>();

  return {
    exhaustedUntil(key) {
      const until = entries.get(key);

      if (until === undefined) {
        return undefined;
      }

      if (until.getTime() <= Date.now()) {
        entries.delete(key);
        return undefined;
      }

      return until;
    },

    markExhausted(key, until) {
      if (entries.size >= maxEntries) {
        const oldest = entries.keys().next();
        if (!oldest.done) {
          entries.delete(oldest.value);
        }
      }

      entries.set(key, until);
    },
  };
}

export interface ConsumeOptions {
  readonly cache?: ExhaustionCache;
  /** Injected so tests can move time without waiting for it. */
  readonly now?: Date;
}

/**
 * Counts one operation against a rule and says whether it is permitted.
 *
 * Always increments, including when the subject is already over. That is
 * deliberate: an attacker who keeps hammering an exhausted window keeps their
 * own counter high, and a caller that skipped the increment would let a burst
 * arriving in the same millisecond each see a count below the limit.
 */
export async function consume(
  db: Database,
  rule: RateLimitRule,
  subject: string,
  options: ConsumeOptions = {},
): Promise<RateLimitDecision> {
  const now = options.now ?? new Date();
  const windowStart = startOfWindow(now, rule.windowSeconds);
  const resetAt = new Date(windowStart.getTime() + rule.windowSeconds * 1000);
  const key = cacheKey(rule, subject, windowStart);

  const cachedUntil = options.cache?.exhaustedUntil(key);

  if (cachedUntil !== undefined) {
    return denied(cachedUntil, now);
  }

  const [row] = await db
    .insert(rateLimitWindows)
    .values({
      bucket: rule.bucket,
      subject,
      windowStart,
      windowSeconds: rule.windowSeconds,
      count: 1,
      expiresAt: resetAt,
    })
    .onConflictDoUpdate({
      target: [rateLimitWindows.bucket, rateLimitWindows.subject, rateLimitWindows.windowStart],
      set: { count: sql`${rateLimitWindows.count} + 1` },
    })
    .returning({ count: rateLimitWindows.count });

  const count = row?.count ?? rule.limit + 1;

  if (count > rule.limit) {
    options.cache?.markExhausted(key, resetAt);
    return denied(resetAt, now);
  }

  return {
    allowed: true,
    remaining: rule.limit - count,
    resetAt,
    retryAfterSeconds: 0,
  };
}

/**
 * Reads the current usage without spending any.
 *
 * For health and audit surfaces. Never for a decision: checking and then acting
 * is two statements with a gap between them, and `consume` exists so the gap
 * does not.
 */
export async function peek(
  db: Database,
  rule: RateLimitRule,
  subject: string,
  options: ConsumeOptions = {},
): Promise<{ used: number; remaining: number; resetAt: Date }> {
  const now = options.now ?? new Date();
  const windowStart = startOfWindow(now, rule.windowSeconds);

  const [row] = await db
    .select({ count: rateLimitWindows.count })
    .from(rateLimitWindows)
    .where(
      sql`${rateLimitWindows.bucket} = ${rule.bucket}
        and ${rateLimitWindows.subject} = ${subject}
        and ${rateLimitWindows.windowStart} = ${windowStart}`,
    );

  const used = row?.count ?? 0;

  return {
    used,
    remaining: Math.max(0, rule.limit - used),
    resetAt: new Date(windowStart.getTime() + rule.windowSeconds * 1000),
  };
}

/**
 * Removes windows that have ended.
 *
 * Section 19 puts this on the same bounded cleanup jobs that clear expired
 * challenges. Without it the table grows by one row per subject per window
 * forever, which on the sign-in path means one row per address anybody has ever
 * typed.
 */
export async function pruneExpiredWindows(db: Database, now: Date = new Date()): Promise<number> {
  const removed = await db
    .delete(rateLimitWindows)
    .where(lte(rateLimitWindows.expiresAt, now))
    .returning({ bucket: rateLimitWindows.bucket });

  return removed.length;
}

/**
 * The start of the window containing `now`.
 *
 * Aligned to the epoch rather than to first use, so every replica computes the
 * same boundary for the same instant without coordinating.
 */
export function startOfWindow(now: Date, windowSeconds: number): Date {
  const size = windowSeconds * 1000;

  return new Date(Math.floor(now.getTime() / size) * size);
}

function cacheKey(rule: RateLimitRule, subject: string, windowStart: Date): string {
  return `${rule.bucket}|${subject}|${String(windowStart.getTime())}`;
}

function denied(resetAt: Date, now: Date): RateLimitDecision {
  return {
    allowed: false,
    remaining: 0,
    resetAt,
    // Rounded up, because rounding down produces a Retry-After that expires
    // before the window does and invites an immediate second rejection.
    retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000)),
  };
}
