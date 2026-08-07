import { providerQuotaWindows, type Database } from '@eim/db';
import { and, eq, gt, isNull, sql } from 'drizzle-orm';

import {
  pressureFor,
  verdictFor,
  type ObserveQuota,
  type QuotaPriority,
  type QuotaState,
  type QuotaVerdict,
} from './quota-policy';

/**
 * Storing what a provider said about its own allowance (sections 12, 13).
 *
 * The decisions about who may spend it live in `quota-policy.ts`. What is here
 * is custody of the numbers, and two facts shape it:
 *
 *   A window is the provider's window, not a rolling count of ours. eBay
 *   reports a daily allowance that resets on its own clock, and inventing a
 *   window here would drift from it. What is stored is what the provider said,
 *   keyed by the window it said it about.
 *
 *   Where a provider reports nothing — WooCommerce has no quota API, and what
 *   limits a store is its own host — this application counts its own calls into
 *   a window it opens itself, with no limit attached. That records the traffic
 *   without inventing a ceiling for it.
 */

export interface QuotaLedger {
  /** Records what the provider reported about its own allowance. */
  observe(input: ObserveQuota): Promise<QuotaState>;
  /** Counts calls this application made, for providers that report nothing. */
  consume(input: {
    provider: 'ebay' | 'woocommerce';
    apiFamily: string;
    businessId?: string | undefined;
    connectionId?: string | undefined;
    count?: number;
    now?: Date;
  }): Promise<QuotaState>;
  /** Whether work of this priority may proceed. */
  check(input: {
    provider: 'ebay' | 'woocommerce';
    apiFamily: string;
    connectionId?: string | undefined;
    priority: QuotaPriority;
    now?: Date;
  }): Promise<QuotaVerdict>;
  /** Every live window for a connection, for the health assessment. */
  read(input: { connectionId: string; now?: Date }): Promise<QuotaState[]>;
}

/**
 * How long a window this application opened itself lasts.
 *
 * Only used where the provider reports nothing — WooCommerce has no quota API,
 * and what limits a store is its own host. An hour is short enough that a burst
 * is visible and long enough that the count means something.
 */
const SELF_WINDOW_MS = 60 * 60_000;

/** The row a null connection is stored under, matching the migration's index. */
const APPLICATION_SCOPE = '00000000-0000-0000-0000-000000000000';

export function createQuotaLedger(db: Database): QuotaLedger {
  return {
    async observe(input) {
      const now = input.now ?? new Date();

      // Written as SQL rather than through the query builder because the
      // uniqueness is an *expression* index — it coalesces a null connection to
      // a fixed uuid so an application-wide window deduplicates too — and an
      // `on conflict` naming the bare columns does not match it. PostgreSQL
      // would refuse the statement rather than silently insert a duplicate,
      // which is the right failure and still a failure.
      const [row] = await upsert(db, {
        businessId: input.businessId ?? null,
        connectionId: input.connectionId ?? null,
        provider: input.provider,
        apiFamily: input.apiFamily,
        windowStartsAt: input.windowStartsAt,
        windowEndsAt: input.windowEndsAt,
        limit: input.limit,
        used: input.used,
        now,
        // The provider's own count replaces ours. It knows about calls this
        // process did not make — another replica's, a previous deployment's —
        // and a local tally that disagreed would be lower, which is the
        // dangerous direction to be wrong in.
        increment: false,
      });

      if (row === undefined) {
        throw new Error('the quota observation could not be recorded');
      }

      return stateOf(row);
    },

    async consume(input) {
      const now = input.now ?? new Date();
      const count = input.count ?? 1;
      const windowStartsAt = new Date(Math.floor(now.getTime() / SELF_WINDOW_MS) * SELF_WINDOW_MS);

      const [row] = await upsert(db, {
        businessId: input.businessId ?? null,
        connectionId: input.connectionId ?? null,
        provider: input.provider,
        apiFamily: input.apiFamily,
        windowStartsAt,
        windowEndsAt: new Date(windowStartsAt.getTime() + SELF_WINDOW_MS),
        limit: null,
        used: count,
        now,
        // Added to whatever is there, in the statement, so two workers counting
        // at the same moment produce two calls' worth rather than one.
        increment: true,
      });

      if (row === undefined) {
        throw new Error('the quota consumption could not be recorded');
      }

      return stateOf(row);
    },

    async check(input) {
      const now = input.now ?? new Date();

      const rows = await db
        .select()
        .from(providerQuotaWindows)
        .where(
          and(
            eq(providerQuotaWindows.provider, input.provider),
            eq(providerQuotaWindows.apiFamily, input.apiFamily),
            input.connectionId === undefined
              ? isNull(providerQuotaWindows.connectionId)
              : eq(providerQuotaWindows.connectionId, input.connectionId),
            gt(providerQuotaWindows.windowEndsAt, now),
          ),
        );

      if (rows.length === 0) {
        return {
          allowed: true,
          pressure: 'unknown',
          summary: 'nothing is known about this allowance yet',
          state: null,
        };
      }

      // The tightest live window decides. A family can be under both a per-day
      // and a per-hour allowance, and being comfortable on one says nothing.
      const states = rows.map(stateOf);
      const worst = states.reduce((tightest, state) =>
        (state.fraction ?? -1) > (tightest.fraction ?? -1) ? state : tightest,
      );

      return verdictFor(worst, input.priority);
    },

    async read(input) {
      const now = input.now ?? new Date();

      const rows = await db
        .select()
        .from(providerQuotaWindows)
        .where(
          and(
            eq(providerQuotaWindows.connectionId, input.connectionId),
            gt(providerQuotaWindows.windowEndsAt, now),
          ),
        );

      return rows.map(stateOf);
    },
  };
}

// ---------------------------------------------------------------------------

interface UpsertInput {
  readonly businessId: string | null;
  readonly connectionId: string | null;
  readonly provider: 'ebay' | 'woocommerce';
  readonly apiFamily: string;
  readonly windowStartsAt: Date;
  readonly windowEndsAt: Date;
  readonly limit: number | null;
  readonly used: number;
  readonly now: Date;
  /** Whether the count adds to what is stored or replaces it. */
  readonly increment: boolean;
}

async function upsert(db: Database, input: UpsertInput): Promise<QuotaRow[]> {
  const result = await db.execute(sql`
    insert into provider_quota_windows (
      business_id, connection_id, provider, api_family,
      window_starts_at, window_ends_at, limit_count, used_count, observed_at
    )
    values (
      ${input.businessId}, ${input.connectionId}, ${input.provider}, ${input.apiFamily},
      ${input.windowStartsAt}, ${input.windowEndsAt}, ${input.limit}, ${input.used}, ${input.now}
    )
    on conflict (
      provider,
      api_family,
      coalesce(connection_id, ${APPLICATION_SCOPE}::uuid),
      window_starts_at
    )
    do update set
      limit_count = coalesce(excluded.limit_count, provider_quota_windows.limit_count),
      used_count = ${
        input.increment
          ? sql`provider_quota_windows.used_count + excluded.used_count`
          : sql`excluded.used_count`
      },
      window_ends_at = excluded.window_ends_at,
      observed_at = excluded.observed_at
    returning *
  `);

  return (Array.isArray(result) ? result : result.rows).map(readRow);
}

/** A uuid column, which the driver returns as a string or as null. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Turns a raw row into the typed one, since `execute` returns snake-cased text. */
function readRow(row: Record<string, unknown>): QuotaRow {
  return {
    id: text(row['id']) ?? '',
    businessId: text(row['business_id']),
    connectionId: text(row['connection_id']),
    provider: row['provider'] as QuotaRow['provider'],
    apiFamily: String(row['api_family']),
    windowStartsAt: new Date(String(row['window_starts_at'])),
    windowEndsAt: new Date(String(row['window_ends_at'])),
    // `bigint` arrives from the driver as a string, because a JavaScript number
    // cannot hold every value the column can. These are call counts and fit
    // comfortably, but the conversion has to be deliberate rather than implied.
    limitCount: row['limit_count'] === null ? null : Number(row['limit_count']),
    usedCount: Number(row['used_count']),
    observedAt: new Date(String(row['observed_at'])),
  };
}

type QuotaRow = typeof providerQuotaWindows.$inferSelect;

function stateOf(row: QuotaRow): QuotaState {
  const limit = row.limitCount;
  // A limit of zero is a provider saying "none of this is available", which is
  // a real answer and not a missing one — but it cannot be divided by.
  const fraction = limit === null || limit <= 0 ? null : row.usedCount / limit;

  return {
    provider: row.provider,
    apiFamily: row.apiFamily,
    connectionId: row.connectionId,
    limit,
    used: row.usedCount,
    fraction,
    pressure: pressureFor(fraction, limit),
    windowEndsAt: row.windowEndsAt,
  };
}
