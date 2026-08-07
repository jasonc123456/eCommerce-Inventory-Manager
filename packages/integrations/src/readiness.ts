import { connectionReadinessChecks, type Database } from '@eim/db';
import { and, eq } from 'drizzle-orm';

/**
 * What a connection can and cannot do yet, in the shape both providers use
 * (sections 13, 14).
 *
 * The two providers ask completely different questions — eBay wants business
 * policies and inventory locations, WooCommerce wants global stock management
 * and a REST route that answers — but the shape of the answer is the same one,
 * and the two properties that make it useful are properties of the shape rather
 * than of either provider:
 *
 *   Per-check, not one boolean. A connection is not simply ready. Catalog import
 *   may proceed while a write capability stays blocked on its own prerequisite,
 *   and a single verdict forces the choice between blocking everything on the
 *   strictest requirement and letting a write through on the weakest.
 *
 *   A check that could not be performed reports `unknown`, never `pass`. The
 *   difference between "the store says stock management is off" and "the store
 *   did not answer" is the difference between a setup task and an outage, and
 *   collapsing them sends the operator to fix the wrong thing. `unknown` blocks
 *   as firmly as `fail`, because a capability enabled on the strength of a check
 *   that could not be run is one that fails on its first real use.
 */

export type ReadinessStatus = 'pass' | 'warn' | 'fail' | 'unknown';

export interface ReadinessCheck {
  readonly name: string;
  readonly status: ReadinessStatus;
  /** One sentence, meant for the person who has to act on it. */
  readonly summary: string;
  /** Structured evidence for the interface. Never a credential. */
  readonly detail: Readonly<Record<string, unknown>>;
}

export interface ReadinessReport {
  readonly connectionId: string;
  readonly checks: readonly ReadinessCheck[];
  /** Capabilities whose prerequisites all pass. */
  readonly available: readonly string[];
  /** Capabilities blocked, with the check that blocks each. */
  readonly blocked: readonly { readonly capability: string; readonly because: string }[];
  readonly checkedAt: Date;
}

export function unknownCheck(name: string, summary: string): ReadinessCheck {
  return { name, status: 'unknown', summary, detail: {} };
}

/**
 * Stores an assessment, replacing the previous one wholesale.
 *
 * Merged instead of replaced, a check that stopped being run would keep its last
 * answer forever, and an old `pass` is worse than no answer at all.
 */
export async function recordChecks(
  db: Database,
  businessId: string,
  connectionId: string,
  checks: readonly ReadinessCheck[],
  now: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(connectionReadinessChecks)
      .where(eq(connectionReadinessChecks.connectionId, connectionId));

    if (checks.length === 0) {
      return;
    }

    await tx.insert(connectionReadinessChecks).values(
      checks.map((check) => ({
        businessId,
        connectionId,
        checkName: check.name,
        status: check.status,
        summary: check.summary,
        detail: check.detail,
        checkedAt: now,
      })),
    );
  });
}

export interface SummarizeInput {
  readonly connectionId: string;
  readonly checks: readonly ReadinessCheck[];
  /** Which checks each capability depends on. */
  readonly requirements: Readonly<Record<string, readonly string[]>>;
  /**
   * Capabilities the grant itself does not permit, whatever the account looks
   * like. Blocked before any condition is considered: no amount of correct setup
   * substitutes for permission.
   */
  readonly ungranted?: readonly string[];
  /** What the interface is told blocked an ungranted capability. */
  readonly ungrantedBecause?: string;
  readonly checkedAt: Date;
}

export function summarizeChecks(input: SummarizeInput): ReadinessReport {
  const byName = new Map(input.checks.map((check) => [check.name, check]));
  const ungranted = new Set(input.ungranted ?? []);
  const available: string[] = [];
  const blocked: { capability: string; because: string }[] = [];

  for (const [capability, required] of Object.entries(input.requirements)) {
    if (ungranted.has(capability)) {
      blocked.push({ capability, because: input.ungrantedBecause ?? 'permissions' });
      continue;
    }

    const blocker = required.find((name) => {
      const check = byName.get(name);

      return check === undefined || check.status === 'fail' || check.status === 'unknown';
    });

    if (blocker === undefined) {
      available.push(capability);
    } else {
      blocked.push({ capability, because: blocker });
    }
  }

  return {
    connectionId: input.connectionId,
    checks: input.checks,
    available,
    blocked,
    checkedAt: input.checkedAt,
  };
}

/**
 * The last recorded assessment, without calling the provider.
 *
 * Filtered on the business as well as the connection. A connection identifier is
 * a uuid somebody may hold from a screen they no longer have access to, and a
 * read keyed on it alone answers with another business's assessment of another
 * business's store.
 */
export async function readRecordedChecks(
  db: Database,
  businessId: string,
  connectionId: string,
): Promise<{ checks: ReadinessCheck[]; checkedAt: Date } | null> {
  const rows = await db
    .select()
    .from(connectionReadinessChecks)
    .where(
      and(
        eq(connectionReadinessChecks.connectionId, connectionId),
        eq(connectionReadinessChecks.businessId, businessId),
      ),
    );

  if (rows.length === 0) {
    return null;
  }

  return {
    checks: rows.map((row) => ({
      name: row.checkName,
      status: row.status,
      summary: row.summary,
      detail: (row.detail ?? {}) as Record<string, unknown>,
    })),
    // The newest recorded check. They are written together, so they agree — but
    // reading the maximum means a future partial refresh reports the freshest
    // answer rather than an arbitrary one.
    checkedAt: rows.reduce<Date>(
      (latest, row) => (row.checkedAt > latest ? row.checkedAt : latest),
      new Date(0),
    ),
  };
}
