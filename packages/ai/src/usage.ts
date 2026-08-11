import { aiSuggestions, type Database } from '@eim/db';
import { and, eq, gte, lt, ne, sql } from 'drizzle-orm';

import { monthWindow, type BudgetUsage, type BudgetWindow } from './budget';

/**
 * What a business has spent this month (sections 18, 34).
 *
 * Summed from the suggestions themselves rather than kept in a counter. A
 * counter is faster and can disagree with the history explaining it, which is
 * the same mistake as a materialized balance that does not equal its ledger —
 * and this application has already decided, in section 8, which side of that
 * trade it is on. A month of one business's suggestions is a few hundred rows
 * behind a covering index.
 *
 * Refusals are excluded from every figure. A request this application declined
 * never reached the endpoint, so it consumed no tokens and no money — and
 * counting it against the request ceiling would mean a spent budget kept
 * spending itself, so nobody could see how much of it they had actually used.
 */
export async function readUsage(
  db: Database,
  businessId: string,
  window: BudgetWindow,
): Promise<BudgetUsage> {
  const rows = await db
    .select({
      requests: sql<string>`count(*)`,
      tokens: sql<string>`coalesce(sum(coalesce(${aiSuggestions.promptTokens}, 0) + coalesce(${aiSuggestions.completionTokens}, 0)), 0)`,
      // Summed by PostgreSQL as `numeric` and returned as a string. Adding
      // decimal strings in JavaScript would be exact arithmetic re-implemented
      // beside a database that already does it.
      cost: sql<string | null>`sum(${aiSuggestions.estimatedCostAmount})`,
    })
    .from(aiSuggestions)
    .where(
      and(
        eq(aiSuggestions.businessId, businessId),
        gte(aiSuggestions.requestedAt, window.start),
        lt(aiSuggestions.requestedAt, window.end),
        ne(aiSuggestions.status, 'refused'),
      ),
    );

  const row = rows[0];

  return {
    requests: Number(row?.requests ?? 0),
    tokens: Number(row?.tokens ?? 0),
    costAmount: row?.cost ?? null,
  };
}

/** The current month's usage, for a screen or a check. */
export function readCurrentUsage(
  db: Database,
  businessId: string,
  now?: Date,
): Promise<BudgetUsage> {
  return readUsage(db, businessId, monthWindow(now ?? new Date()));
}
