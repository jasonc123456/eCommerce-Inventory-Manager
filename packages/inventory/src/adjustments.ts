import {
  canonicalItems,
  inventoryLedger,
  locationBalances,
  locations,
  type Database,
} from '@eim/db';
import { and, eq, isNull } from 'drizzle-orm';

import {
  lockBalances,
  postMovements,
  transactionally,
  type PostingResult,
  type Shortfall,
} from './ledger';

/**
 * Manual adjustments, transfers, and reversals (sections 8, 9, 17).
 *
 * Section 8 is specific about the shape of an adjustment: authorized users
 * adjust canonical inventory rather than raw channel values, the workflow
 * accepts either an absolute quantity or a signed change, a reason is mandatory,
 * and confirmation is what creates the ledger event. The reason is the part
 * worth defending. An unexplained correction is indistinguishable from the drift
 * it was correcting, and section 12's conflict policy ranks confirmed canonical
 * adjustments above reconciliation observations precisely because a person
 * stated why.
 *
 * Every entry point here is a two-call shape: preview, then apply. Nothing
 * previews and applies in one call, because a flag that means "do it for real"
 * is one typo away from doing it for real.
 */

export type AdjustmentDatabase = Pick<Database, 'select' | 'transaction'>;

export type QuantityChange =
  /** "There are 12 on the shelf." */
  | { readonly mode: 'absolute'; readonly quantity: number }
  /** "Two were damaged." */
  | { readonly mode: 'delta'; readonly quantityDelta: number };

export interface AdjustmentInput {
  readonly businessId: string;
  readonly canonicalItemId: string;
  readonly locationId: string;
  readonly change: QuantityChange;
  /** Mandatory. Section 8 admits no adjustment without one. */
  readonly reason: string;
  readonly actorUserId?: string | null;
  readonly occurredAt?: Date;
}

export interface AdjustmentPreview {
  readonly canonicalItemId: string;
  readonly sku: string;
  readonly locationId: string;
  readonly locationCode: string;
  readonly onHand: number;
  readonly reserved: number;
  readonly resultingOnHand: number;
  readonly quantityDelta: number;
  /** True when the stated figure is what is already recorded. */
  readonly unchanged: boolean;
  /** Set when the change would take the location below zero. */
  readonly shortfall: number | null;
}

export type PreviewResult =
  | { readonly outcome: 'previewed'; readonly preview: AdjustmentPreview }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'invalid'; readonly reason: string };

/**
 * What the adjustment would do, without doing it.
 *
 * Reports the location effect. The channel and kit halves of section 8's
 * preview requirement need mappings and recipes to exist, and join this figure
 * in the projection preview rather than being computed twice.
 */
export async function previewAdjustment(
  db: Pick<Database, 'select'>,
  input: AdjustmentInput,
): Promise<PreviewResult> {
  const invalid = validateChange(input.change);
  if (invalid !== null) {
    return { outcome: 'invalid', reason: invalid };
  }

  const [row] = await db
    .select({
      sku: canonicalItems.sku,
      locationCode: locations.code,
      onHand: locationBalances.onHand,
      reserved: locationBalances.reserved,
    })
    .from(canonicalItems)
    .innerJoin(
      locations,
      and(eq(locations.businessId, canonicalItems.businessId), eq(locations.id, input.locationId)),
    )
    .leftJoin(
      locationBalances,
      and(
        eq(locationBalances.businessId, canonicalItems.businessId),
        eq(locationBalances.canonicalItemId, canonicalItems.id),
        eq(locationBalances.locationId, locations.id),
      ),
    )
    .where(
      and(
        eq(canonicalItems.businessId, input.businessId),
        eq(canonicalItems.id, input.canonicalItemId),
        isNull(canonicalItems.deletedAt),
        isNull(locations.deletedAt),
      ),
    )
    .limit(1);

  if (row === undefined) {
    return { outcome: 'not_found' };
  }

  // A location an item has never been stocked at has no balance row yet, which
  // is zero units rather than an error: putting the first unit somewhere new is
  // an ordinary receipt.
  const onHand = row.onHand ?? 0;
  const reserved = row.reserved ?? 0;
  const quantityDelta = deltaFor(input.change, onHand);
  const resultingOnHand = onHand + quantityDelta;

  return {
    outcome: 'previewed',
    preview: {
      canonicalItemId: input.canonicalItemId,
      sku: row.sku,
      locationId: input.locationId,
      locationCode: row.locationCode,
      onHand,
      reserved,
      resultingOnHand: Math.max(0, resultingOnHand),
      quantityDelta,
      unchanged: quantityDelta === 0,
      shortfall: resultingOnHand < 0 ? -resultingOnHand : null,
    },
  };
}

export type AdjustmentResult =
  | { readonly outcome: 'adjusted'; readonly entryId: string; readonly onHand: number }
  /** The stated figure is already the recorded one; no entry was written. */
  | { readonly outcome: 'unchanged'; readonly onHand: number }
  | { readonly outcome: 'insufficient'; readonly shortfalls: readonly Shortfall[] }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'invalid'; readonly reason: string };

/**
 * Records a confirmed adjustment.
 *
 * An absolute figure is turned into a delta *inside* the transaction, after the
 * row is locked. Computing it from the number the preview showed would write a
 * delta derived from a balance that a sale may have changed in between, which is
 * how an operator correcting a count to twelve ends up with fourteen.
 */
export async function applyAdjustment(
  db: AdjustmentDatabase,
  input: AdjustmentInput,
): Promise<AdjustmentResult> {
  const invalid = validateChange(input.change);
  if (invalid !== null) {
    return { outcome: 'invalid', reason: invalid };
  }
  if (input.reason.trim().length === 0) {
    return { outcome: 'invalid', reason: 'an adjustment needs a stated reason' };
  }

  return transactionally<AdjustmentResult>(db, async (tx) => {
    const target = { canonicalItemId: input.canonicalItemId, locationId: input.locationId };
    const existing = await lockBalances(tx, input.businessId, [target]);
    const current = existing.get(`${target.canonicalItemId}:${target.locationId}`);
    const onHand = current?.onHand ?? 0;
    const quantityDelta = deltaFor(input.change, onHand);

    if (quantityDelta === 0) {
      // The database refuses a zero-delta entry, and it is right to: an entry
      // recording that nothing happened only dilutes the timeline.
      return { keep: false, value: { outcome: 'unchanged', onHand } };
    }

    const posted = await postMovements(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId ?? null,
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      movements: [{ ...target, kind: 'adjustment', quantityDelta, reason: input.reason.trim() }],
    });

    if (posted.outcome !== 'posted') {
      return { keep: false, value: failureOf(posted) };
    }

    return { keep: true, value: { outcome: 'adjusted', ...singleEntry(posted) } };
  });
}

export interface TransferInput {
  readonly businessId: string;
  readonly canonicalItemId: string;
  readonly fromLocationId: string;
  readonly toLocationId: string;
  readonly quantity: number;
  readonly reason?: string | null;
  readonly actorUserId?: string | null;
  readonly occurredAt?: Date;
}

export type TransferResult =
  | { readonly outcome: 'transferred'; readonly entryIds: readonly string[] }
  | { readonly outcome: 'insufficient'; readonly shortfalls: readonly Shortfall[] }
  | { readonly outcome: 'invalid'; readonly reason: string };

/**
 * Moves units between two locations as one act (section 9).
 *
 * Both entries commit or neither does. Version 1 does not model an in-transit
 * state, so the units are at the destination the moment this returns — which is
 * a deliberate simplification and the reason a transfer is confirmed rather than
 * scheduled.
 */
export async function transferStock(
  db: AdjustmentDatabase,
  input: TransferInput,
): Promise<TransferResult> {
  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
    return { outcome: 'invalid', reason: 'a transfer moves a whole positive number of units' };
  }
  if (input.fromLocationId === input.toLocationId) {
    return { outcome: 'invalid', reason: 'a transfer needs two different locations' };
  }

  return transactionally<TransferResult>(db, async (tx) => {
    const reason = input.reason?.trim() ?? null;
    const posted = await postMovements(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId ?? null,
      // One correlation identifier over both halves, so the timeline at either
      // location can name the other end of the move.
      correlationId: crypto.randomUUID(),
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      movements: [
        {
          canonicalItemId: input.canonicalItemId,
          locationId: input.fromLocationId,
          kind: 'transfer_out',
          quantityDelta: -input.quantity,
          reason,
        },
        {
          canonicalItemId: input.canonicalItemId,
          locationId: input.toLocationId,
          kind: 'transfer_in',
          quantityDelta: input.quantity,
          reason,
        },
      ],
    });

    return posted.outcome === 'posted'
      ? { keep: true, value: { outcome: 'transferred', entryIds: posted.entryIds } }
      : { keep: false, value: failureOf(posted) };
  });
}

export type ReversalResult =
  | { readonly outcome: 'reversed'; readonly entryId: string; readonly onHand: number }
  | { readonly outcome: 'already_reversed'; readonly entryId: string }
  | { readonly outcome: 'insufficient'; readonly shortfalls: readonly Shortfall[] }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'invalid'; readonly reason: string };

/**
 * Undoes an entry the only way the schema allows: by appending its opposite.
 *
 * Section 17's rule is absolute — no committed entry is edited or deleted to
 * correct stock — so this is not a convenience over `delete`. It is the whole
 * correction path, and the link it writes is what lets the timeline say "this
 * was a mistake, corrected on Tuesday" rather than quietly showing the fixed
 * number as if it had always been right.
 *
 * Reversing a reversal is refused. It would be arithmetically fine and
 * historically incomprehensible.
 */
export async function reverseEntry(
  db: AdjustmentDatabase,
  input: {
    readonly businessId: string;
    readonly entryId: string;
    readonly reason: string;
    readonly actorUserId?: string | null;
    readonly occurredAt?: Date;
  },
): Promise<ReversalResult> {
  if (input.reason.trim().length === 0) {
    return { outcome: 'invalid', reason: 'a reversal needs a stated reason' };
  }

  return transactionally<ReversalResult>(db, async (tx) => {
    const [original] = await tx
      .select({
        canonicalItemId: inventoryLedger.canonicalItemId,
        locationId: inventoryLedger.locationId,
        quantityDelta: inventoryLedger.quantityDelta,
        kind: inventoryLedger.kind,
      })
      .from(inventoryLedger)
      .where(
        and(
          eq(inventoryLedger.businessId, input.businessId),
          eq(inventoryLedger.id, input.entryId),
        ),
      )
      .limit(1);

    if (original === undefined) {
      return { keep: false, value: { outcome: 'not_found' } };
    }
    if (original.kind === 'reversal') {
      return {
        keep: false,
        value: {
          outcome: 'invalid',
          reason: 'a reversal is itself corrected by a new adjustment, not by another reversal',
        },
      };
    }

    const [existing] = await tx
      .select({ id: inventoryLedger.id })
      .from(inventoryLedger)
      .where(
        and(
          eq(inventoryLedger.businessId, input.businessId),
          eq(inventoryLedger.reversalOfId, input.entryId),
        ),
      )
      .limit(1);

    if (existing !== undefined) {
      return { keep: false, value: { outcome: 'already_reversed', entryId: existing.id } };
    }

    const posted = await postMovements(tx, {
      businessId: input.businessId,
      actorUserId: input.actorUserId ?? null,
      ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
      movements: [
        {
          canonicalItemId: original.canonicalItemId,
          locationId: original.locationId,
          kind: 'reversal',
          quantityDelta: -original.quantityDelta,
          reason: input.reason.trim(),
          reversalOfId: input.entryId,
        },
      ],
    });

    if (posted.outcome !== 'posted') {
      return { keep: false, value: failureOf(posted) };
    }

    return { keep: true, value: { outcome: 'reversed', ...singleEntry(posted) } };
  });
}

function validateChange(change: QuantityChange): string | null {
  if (change.mode === 'absolute') {
    return Number.isSafeInteger(change.quantity) && change.quantity >= 0
      ? null
      : 'an absolute quantity is a whole number of units, and never negative';
  }

  return Number.isSafeInteger(change.quantityDelta)
    ? null
    : 'a signed change is a whole number of units';
}

function deltaFor(change: QuantityChange, onHand: number): number {
  return change.mode === 'absolute' ? change.quantity - onHand : change.quantityDelta;
}

/** Restates a refused posting in the vocabulary of the operation that asked. */
function failureOf(posted: Exclude<PostingResult, { outcome: 'posted' }>):
  | { readonly outcome: 'insufficient'; readonly shortfalls: readonly Shortfall[] }
  | {
      readonly outcome: 'invalid';
      readonly reason: string;
    } {
  return posted.outcome === 'insufficient'
    ? { outcome: 'insufficient', shortfalls: posted.shortfalls }
    : { outcome: 'invalid', reason: posted.reason };
}

/**
 * Turns a posting that wrote exactly one entry into a single-entry answer.
 *
 * Both callers below post one movement, so a posted result that produced no
 * entry is a bug in this module rather than a case to report to the operator.
 */
function singleEntry(posted: Extract<PostingResult, { outcome: 'posted' }>): {
  readonly entryId: string;
  readonly onHand: number;
} {
  const [entryId] = posted.entryIds;
  const [balance] = posted.balances;

  if (entryId === undefined || balance === undefined) {
    throw new Error('a single-movement posting returned no entry');
  }

  return { entryId, onHand: balance.onHand };
}
