import {
  inventoryLedger,
  locationBalances,
  type Database,
  type LedgerKind,
  type LedgerEntry,
} from '@eim/db';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

/**
 * The append-only canonical ledger and the balances it explains (sections 8,
 * 12, 17).
 *
 * Two rules shape everything here.
 *
 * The first is that a committed entry is never edited or deleted to correct
 * stock (section 17). A correction is a new entry linked to the one it reverses,
 * so the history of a discrepancy survives its repair — which is what an
 * operator needs six weeks later when a channel and the shelf disagree and the
 * question is what happened, not merely what the number is now. The database
 * enforces it with a trigger, so this module is where the *supported* way to
 * correct something lives rather than the only thing standing between a caller
 * and rewritten history.
 *
 * The second is that a movement and the balance it produces commit together
 * (section 12). One transaction, rows locked in sorted order, and no external
 * call inside it. Sorted order is what makes a kit safe: a sale consuming three
 * components in one transaction and another consuming two of the same three
 * cannot deadlock if both take them in the same sequence.
 */

export type LedgerReader = Pick<Database, 'select'>;

/** The subset of the database a posting needs. Any transaction satisfies it. */
export type LedgerTransaction = Pick<
  Database,
  'select' | 'insert' | 'update' | 'delete' | 'execute'
>;

/** One movement of one item at one location. */
export interface Movement {
  readonly canonicalItemId: string;
  readonly locationId: string;
  readonly kind: LedgerKind;
  /** Signed and non-zero. The database rejects a zero-delta entry. */
  readonly quantityDelta: number;
  readonly reason?: string | null;
  readonly reversalOfId?: string | null;
}

export interface PostingInput {
  readonly businessId: string;
  readonly movements: readonly Movement[];
  readonly actorUserId?: string | null;
  /** Ties every entry of one act — a kit sale, a transfer — to the others. */
  readonly correlationId?: string | null;
  readonly occurredAt?: Date;
}

export interface ResultingBalance {
  readonly canonicalItemId: string;
  readonly locationId: string;
  readonly onHand: number;
  readonly reserved: number;
}

/** A movement that would have taken a location below zero, and by how much. */
export interface Shortfall {
  readonly canonicalItemId: string;
  readonly locationId: string;
  readonly onHand: number;
  readonly requested: number;
  /** Units the location could not supply. Section 8 records this, never a
   * negative balance. */
  readonly short: number;
}

export type PostingResult =
  | {
      readonly outcome: 'posted';
      readonly entryIds: readonly string[];
      readonly balances: readonly ResultingBalance[];
    }
  /**
   * Nothing was written. Section 8 forbids negative physical stock, and section
   * 11 records the difference as an explicit shortage rather than letting a
   * balance go below zero — but recording that shortage is the caller's decision
   * to make with an order in hand, not this module's.
   */
  | { readonly outcome: 'insufficient'; readonly shortfalls: readonly Shortfall[] }
  | { readonly outcome: 'invalid'; readonly reason: string };

/**
 * Applies movements and records them, or does neither.
 *
 * The whole set commits or none of it does. Section 10 makes that explicit for
 * kits — "partial component mutation is prohibited" — and it is no less true of
 * a transfer, where a decrement that committed without its matching increment
 * would destroy stock.
 *
 * Runs inside a transaction the caller supplies, so an order ingestion can
 * commit the sale, the ledger entries, and its own outbox intent together
 * (section 12).
 */
export async function postMovements(
  tx: LedgerTransaction,
  input: PostingInput,
): Promise<PostingResult> {
  if (input.movements.length === 0) {
    return { outcome: 'invalid', reason: 'a posting needs at least one movement' };
  }

  for (const movement of input.movements) {
    if (!Number.isSafeInteger(movement.quantityDelta) || movement.quantityDelta === 0) {
      return { outcome: 'invalid', reason: 'a movement is a non-zero whole number of units' };
    }
    if ((movement.kind === 'reversal') !== (movement.reversalOfId != null)) {
      return {
        outcome: 'invalid',
        reason: 'only a reversal names the entry it reverses, and every reversal must',
      };
    }
  }

  const targets = lockOrder(input.movements);

  // Create any balance row that does not exist yet, in the same sorted order as
  // the lock that follows. An insert takes its own implicit lock on the new
  // key, so doing this out of order would reintroduce the deadlock the sort
  // exists to prevent.
  for (const target of targets) {
    await tx
      .insert(locationBalances)
      .values({
        businessId: input.businessId,
        canonicalItemId: target.canonicalItemId,
        locationId: target.locationId,
        onHand: 0,
        reserved: 0,
      })
      .onConflictDoNothing();
  }

  const locked = await lockBalances(tx, input.businessId, targets);

  const netByKey = new Map<string, number>();
  for (const movement of input.movements) {
    const key = keyOf(movement);
    netByKey.set(key, (netByKey.get(key) ?? 0) + movement.quantityDelta);
  }

  const shortfalls: Shortfall[] = [];
  const resulting = new Map<string, ResultingBalance>();

  for (const target of targets) {
    const key = keyOf(target);
    const current = locked.get(key);
    const net = netByKey.get(key) ?? 0;

    if (current === undefined) {
      return {
        outcome: 'invalid',
        reason: 'the item or location does not belong to this business',
      };
    }

    const onHand = current.onHand + net;

    if (onHand < 0) {
      shortfalls.push({
        canonicalItemId: target.canonicalItemId,
        locationId: target.locationId,
        onHand: current.onHand,
        requested: -net,
        short: -onHand,
      });
      continue;
    }

    // Section 8 keeps reserved units inside on-hand, and the database agrees:
    // shipping against a reservation must release it in the same breath, or the
    // check constraint refuses the write.
    if (onHand < current.reserved) {
      return {
        outcome: 'invalid',
        reason: 'that movement would leave fewer units on hand than are reserved',
      };
    }

    resulting.set(key, { ...target, onHand, reserved: current.reserved });
  }

  if (shortfalls.length > 0) {
    return { outcome: 'insufficient', shortfalls };
  }

  const entryIds: string[] = [];
  for (const movement of input.movements) {
    const [entry] = await tx
      .insert(inventoryLedger)
      .values({
        businessId: input.businessId,
        canonicalItemId: movement.canonicalItemId,
        locationId: movement.locationId,
        kind: movement.kind,
        quantityDelta: movement.quantityDelta,
        reason: movement.reason ?? null,
        reversalOfId: movement.reversalOfId ?? null,
        actorUserId: input.actorUserId ?? null,
        correlationId: input.correlationId ?? null,
        ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      })
      .returning({ id: inventoryLedger.id });

    if (entry === undefined) {
      throw new Error('a ledger entry could not be written');
    }

    entryIds.push(entry.id);
  }

  const balances = [...resulting.values()];
  for (const balance of balances) {
    await tx
      .update(locationBalances)
      .set({ onHand: balance.onHand, updatedAt: sql`now()` })
      .where(
        and(
          eq(locationBalances.businessId, input.businessId),
          eq(locationBalances.canonicalItemId, balance.canonicalItemId),
          eq(locationBalances.locationId, balance.locationId),
        ),
      );
  }

  return { outcome: 'posted', entryIds, balances };
}

/**
 * Locks the balance rows this posting touches, in sorted order.
 *
 * Exported because reservations and allocations need the same ordering
 * discipline against the same rows; two modules each inventing their own order
 * is exactly the deadlock section 12 rules out.
 */
export async function lockBalances(
  tx: LedgerTransaction,
  businessId: string,
  targets: readonly BalanceKey[],
): Promise<Map<string, { onHand: number; reserved: number }>> {
  const held = new Map<string, { onHand: number; reserved: number }>();

  for (const target of targets) {
    // One statement per row rather than one `in` list, because PostgreSQL locks
    // the rows of a single statement in whatever order it reads them, which is
    // not necessarily the order asked for. Taking them one at a time is what
    // makes the sort above actually mean something.
    const rows = await tx.execute<{
      canonical_item_id: string;
      location_id: string;
      on_hand: number;
      reserved: number;
    }>(sql`
      select canonical_item_id, location_id, on_hand, reserved
      from location_balances
      where business_id = ${businessId}
        and canonical_item_id = ${target.canonicalItemId}
        and location_id = ${target.locationId}
      for update
    `);

    const row = rows.rows[0];
    if (row !== undefined) {
      held.set(keyOf(target), { onHand: row.on_hand, reserved: row.reserved });
    }
  }

  return held;
}

export interface BalanceKey {
  readonly canonicalItemId: string;
  readonly locationId: string;
}

/** Carries a typed answer out of a transaction that is being rolled back. */
class Rollback extends Error {
  public override readonly name = 'Rollback';

  public constructor(public readonly value: unknown) {
    super('the transaction was rolled back deliberately');
  }
}

/**
 * Runs work in a transaction that is discarded unless the work says to keep it.
 *
 * A posting that finds it cannot be supplied has usually already created the
 * balance rows it was about to lock — creating them is how an absent row becomes
 * lockable at all, which is what makes two concurrent first receipts safe. But a
 * refused transfer must leave no trace at the destination it never reached, so
 * the honest thing is to discard the whole attempt rather than to tidy up after
 * it.
 *
 * PostgreSQL only rolls back on an error, so the answer travels out inside one.
 */
export async function transactionally<T>(
  db: Pick<Database, 'transaction'>,
  work: (tx: LedgerTransaction) => Promise<{ readonly keep: boolean; readonly value: T }>,
): Promise<T> {
  try {
    return await db.transaction(async (tx) => {
      const outcome = await work(tx);

      if (!outcome.keep) {
        throw new Rollback(outcome.value);
      }

      return outcome.value;
    });
  } catch (error) {
    if (error instanceof Rollback) {
      return error.value as T;
    }

    throw error;
  }
}

/**
 * The order rows must be taken in: canonical item UUID, then location.
 *
 * Section 12 names sorted UUID order for kit and multi-item locks. Duplicates
 * collapse, so a posting naming one item twice takes its lock once.
 */
export function lockOrder(movements: readonly BalanceKey[]): BalanceKey[] {
  const unique = new Map<string, BalanceKey>();

  for (const movement of movements) {
    unique.set(keyOf(movement), {
      canonicalItemId: movement.canonicalItemId,
      locationId: movement.locationId,
    });
  }

  return [...unique.values()].sort((left, right) => {
    const byItem = left.canonicalItemId.localeCompare(right.canonicalItemId);

    return byItem === 0 ? left.locationId.localeCompare(right.locationId) : byItem;
  });
}

function keyOf(target: BalanceKey): string {
  return `${target.canonicalItemId}:${target.locationId}`;
}

/** One item's recent movements, newest first. */
export async function readTimeline(
  db: LedgerReader,
  input: {
    readonly businessId: string;
    readonly canonicalItemId: string;
    readonly limit?: number;
  },
): Promise<LedgerEntry[]> {
  return db
    .select()
    .from(inventoryLedger)
    .where(
      and(
        eq(inventoryLedger.businessId, input.businessId),
        eq(inventoryLedger.canonicalItemId, input.canonicalItemId),
      ),
    )
    .orderBy(desc(inventoryLedger.occurredAt), desc(inventoryLedger.recordedAt))
    .limit(input.limit ?? 100);
}

/** The entries already reversing the given ones, so a repeat can be refused. */
export async function readReversals(
  db: LedgerReader,
  input: { readonly businessId: string; readonly entryIds: readonly string[] },
): Promise<Map<string, string>> {
  if (input.entryIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select({ id: inventoryLedger.id, reversalOfId: inventoryLedger.reversalOfId })
    .from(inventoryLedger)
    .where(
      and(
        eq(inventoryLedger.businessId, input.businessId),
        inArray(inventoryLedger.reversalOfId, [...input.entryIds]),
      ),
    );

  const reversals = new Map<string, string>();
  for (const row of rows) {
    if (row.reversalOfId !== null) {
      reversals.set(row.reversalOfId, row.id);
    }
  }

  return reversals;
}
