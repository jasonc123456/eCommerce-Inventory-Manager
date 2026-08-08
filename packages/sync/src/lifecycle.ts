import type { Database } from '@eim/db';
import { fulfillReservation, postMovements, releaseReservation } from '@eim/inventory';
import { sql } from 'drizzle-orm';

import { claimEvent, completeEvent, type EventIdentity } from './events';
import { refreshTargetsForItem } from './targets';

/**
 * What happens to committed demand afterwards (section 11).
 *
 * Four things a channel can say about an order it has already told us about,
 * and section 11 answers each of them differently:
 *
 *   Shipped. The reserved units leave on hand. Under `consume_immediately`
 *   they left at the moment of the order and this only closes the reservation;
 *   both paths end in the same state, which is what lets everything downstream
 *   stop caring which mode a business is in.
 *
 *   Cancelled before shipment. The units go back where they came from — the
 *   original allocations, read from the rows rather than recomputed, because by
 *   now priority may have changed and stock has certainly moved.
 *
 *   Cancelled after shipment. Nothing is restored. The goods are with a
 *   customer, and the fact that the money came back says nothing about where
 *   they are.
 *
 *   Refunded, returned, or disputed. Also nothing, immediately. This is the one
 *   that is tempting to get wrong: a refund is a movement of money, and
 *   treating it as a receipt would add stock to a shelf nobody has looked at. A
 *   restock candidate is raised instead, and waits for somebody to say what
 *   actually arrived.
 */

export type LifecycleResult =
  | {
      readonly outcome: 'applied';
      readonly orderId: string;
      readonly lines: readonly LineEffect[];
      readonly restockCandidates: readonly string[];
    }
  | { readonly outcome: 'already_processed'; readonly prior: unknown }
  | { readonly outcome: 'order_unknown' };

export interface LineEffect {
  readonly externalLineId: string;
  readonly effect: 'released' | 'fulfilled' | 'kept' | 'restock_candidate' | 'nothing';
  readonly reason: string | null;
  readonly quantity: number;
}

interface OrderLineRow extends Record<string, unknown> {
  id: string;
  external_line_id: string;
  quantity: number;
  shipped_quantity: number;
  treatment: string;
  canonical_item_id: string | null;
  reservation_id: string | null;
}

export interface LifecycleInput {
  readonly businessId: string;
  readonly connectionId: string;
  readonly externalOrderId: string;
  readonly event: EventIdentity;
  /** Restrict to these lines. Absent means every line on the order. */
  readonly externalLineIds?: readonly string[];
  readonly reason: string;
  readonly actorUserId?: string | null;
  readonly now?: Date;
}

/**
 * A pre-shipment cancellation: give the units back.
 *
 * Shipped quantities are left alone per line rather than per order, because
 * section 11 processes cancellations "per line and quantity" and a partially
 * shipped order is the ordinary case, not an edge one. A line that shipped and
 * was then cancelled raises a restock candidate instead of restoring stock.
 */
export async function applyCancellation(
  db: Database,
  input: LifecycleInput,
): Promise<LifecycleResult> {
  return applyLifecycle(db, input, async (line, context) => {
    if (line.shipped_quantity > 0) {
      const candidateId = await raiseRestockCandidate(db, {
        ...context,
        line,
        origin: 'cancellation_after_shipment',
        quantity: line.shipped_quantity,
        reason: input.reason,
      });

      return {
        effect: {
          externalLineId: line.external_line_id,
          effect: 'restock_candidate',
          reason: 'these units have already shipped',
          quantity: line.shipped_quantity,
        },
        candidateId,
      };
    }

    if (line.reservation_id === null) {
      return {
        effect: {
          externalLineId: line.external_line_id,
          effect: 'nothing',
          reason: 'this line never committed any inventory',
          quantity: 0,
        },
      };
    }

    const released = await releaseReservation(db, {
      businessId: input.businessId,
      reservationId: line.reservation_id,
      reason: input.reason,
      ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });

    if (released.outcome !== 'released') {
      return {
        effect: {
          externalLineId: line.external_line_id,
          effect: 'kept',
          reason:
            released.outcome === 'already_resolved'
              ? `this reservation is already ${released.status}`
              : 'this reservation could not be released',
          quantity: 0,
        },
      };
    }

    await db.execute(sql`
      update channel_order_lines
         set treatment = 'released', treatment_reason = ${input.reason}, shortage = 0
       where id = ${line.id}::uuid
    `);

    return {
      effect: {
        externalLineId: line.external_line_id,
        effect: 'released',
        reason: null,
        quantity: released.restored,
      },
      touched: line.canonical_item_id,
    };
  });
}

/** Shipment: the reserved units leave on hand for good. */
export async function applyFulfillment(
  db: Database,
  input: LifecycleInput & { readonly shippedQuantities?: Readonly<Record<string, number>> },
): Promise<LifecycleResult> {
  return applyLifecycle(db, input, async (line) => {
    const shipped = input.shippedQuantities?.[line.external_line_id] ?? line.quantity;

    await db.execute(sql`
      update channel_order_lines
         set shipped_quantity = greatest(shipped_quantity, ${shipped})
       where id = ${line.id}::uuid
    `);

    if (line.reservation_id === null) {
      return {
        effect: {
          externalLineId: line.external_line_id,
          effect: 'nothing',
          reason: 'this line never committed any inventory',
          quantity: shipped,
        },
      };
    }

    const fulfilled = await fulfillReservation(db, {
      businessId: input.businessId,
      reservationId: line.reservation_id,
      ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });

    return {
      effect: {
        externalLineId: line.external_line_id,
        effect: fulfilled.outcome === 'fulfilled' ? 'fulfilled' : 'kept',
        reason: fulfilled.outcome === 'fulfilled' ? null : 'this reservation was already resolved',
        quantity: shipped,
      },
      // The units left on hand, so every channel advertising this item owes a
      // new number even though nothing was reserved or released.
      touched: fulfilled.outcome === 'fulfilled' ? line.canonical_item_id : null,
    };
  });
}

/**
 * A refund, return, or dispute: record it, restore nothing.
 *
 * Section 11: "import the refund, return, or dispute as a financial/operational
 * event without assuming physical receipt." The candidate this raises is the
 * whole mechanism — it makes the missing information visible instead of
 * guessing at it.
 */
export async function applyRefund(
  db: Database,
  input: LifecycleInput & { readonly origin?: 'refund' | 'return' | 'dispute' },
): Promise<LifecycleResult> {
  return applyLifecycle(db, input, async (line, context) => {
    const candidateId = await raiseRestockCandidate(db, {
      ...context,
      line,
      origin: input.origin ?? 'refund',
      quantity: line.quantity,
      reason: input.reason,
    });

    return {
      effect: {
        externalLineId: line.external_line_id,
        effect: 'restock_candidate',
        reason: 'a refund says nothing about where the goods are',
        quantity: line.quantity,
      },
      candidateId,
    };
  });
}

export type ConfirmRestockResult =
  | { readonly outcome: 'restocked'; readonly quantity: number }
  | { readonly outcome: 'not_found' }
  | { readonly outcome: 'already_resolved'; readonly status: string }
  | { readonly outcome: 'invalid'; readonly reason: string };

/**
 * Somebody has looked at the returned goods and says what came back.
 *
 * The confirmed quantity is deliberately allowed to differ from the claim: a
 * return of three that turns up as two damaged and one saleable is ordinary,
 * and a system that only accepted the channel's figure would force the operator
 * to lie to it. Zero is a valid answer and means nothing was restored.
 */
export async function confirmRestock(
  db: Database,
  input: {
    readonly businessId: string;
    readonly candidateId: string;
    readonly quantity: number;
    readonly locationId: string;
    readonly actorUserId: string;
    readonly reason?: string;
  },
): Promise<ConfirmRestockResult> {
  if (input.quantity < 0) {
    return { outcome: 'invalid', reason: 'a restock cannot be negative' };
  }

  const rows = await db.execute<{
    id: string;
    status: string;
    canonical_item_id: string | null;
    claimed_quantity: number;
  }>(sql`
    select id, status, canonical_item_id, claimed_quantity
      from restock_candidates
     where business_id = ${input.businessId}::uuid and id = ${input.candidateId}::uuid
     for update
  `);

  const candidate = rows.rows[0];
  if (candidate === undefined) {
    return { outcome: 'not_found' };
  }
  if (candidate.status !== 'pending') {
    return { outcome: 'already_resolved', status: candidate.status };
  }
  if (candidate.canonical_item_id === null) {
    return {
      outcome: 'invalid',
      reason: 'this candidate is not linked to a canonical item, so there is nowhere to restock it',
    };
  }

  let ledgerEntryId: string | null = null;

  if (input.quantity > 0) {
    const posted = await postMovements(db, {
      businessId: input.businessId,
      actorUserId: input.actorUserId,
      movements: [
        {
          canonicalItemId: candidate.canonical_item_id,
          locationId: input.locationId,
          kind: 'receipt',
          quantityDelta: input.quantity,
          reason: input.reason ?? 'confirmed restock from a returned order',
        },
      ],
    });

    if (posted.outcome !== 'posted') {
      return { outcome: 'invalid', reason: 'the restock movement was refused' };
    }

    ledgerEntryId = posted.entryIds[0] ?? null;
  }

  await db.execute(sql`
    update restock_candidates
       set status = 'confirmed',
           confirmed_quantity = ${input.quantity},
           confirmed_location_id = ${input.locationId}::uuid,
           confirmed_by_user_id = ${input.actorUserId}::uuid,
           confirmed_at = now(),
           ledger_entry_id = ${ledgerEntryId}::uuid,
           reason = coalesce(${input.reason ?? null}, reason)
     where id = ${candidate.id}::uuid
  `);

  if (input.quantity > 0) {
    await refreshTargetsForItem(db, {
      businessId: input.businessId,
      canonicalItemId: candidate.canonical_item_id,
      reason: 'confirmed restock',
    });
  }

  return { outcome: 'restocked', quantity: input.quantity };
}

/** Records that the goods did not come back, or came back unsaleable. */
export async function declineRestock(
  db: Database,
  input: {
    readonly businessId: string;
    readonly candidateId: string;
    readonly reason: string;
    readonly actorUserId: string;
  },
): Promise<boolean> {
  const rows = await db.execute<{ id: string }>(sql`
    update restock_candidates
       set status = 'declined',
           reason = ${input.reason},
           confirmed_by_user_id = ${input.actorUserId}::uuid,
           confirmed_at = now()
     where business_id = ${input.businessId}::uuid
       and id = ${input.candidateId}::uuid
       and status = 'pending'
    returning id
  `);

  return rows.rows.length === 1;
}

interface LineDecision {
  readonly effect: LineEffect;
  readonly touched?: string | null;
  readonly candidateId?: string;
}

/**
 * The shared spine: deduplicate, find the order, decide per line, reproject.
 *
 * Every lifecycle transition does the same four things in the same order, and
 * the differences between them are entirely in the per-line decision. Writing
 * that structure once is what stops a later transition quietly forgetting to
 * deduplicate or to tell the channels.
 */
async function applyLifecycle(
  db: Database,
  input: LifecycleInput,
  decide: (
    line: OrderLineRow,
    context: {
      readonly businessId: string;
      readonly connectionId: string;
      readonly orderId: string;
    },
  ) => Promise<LineDecision>,
): Promise<LifecycleResult> {
  const claim = await claimEvent<unknown>(db, input.event);

  if (claim.outcome === 'already_processed') {
    return { outcome: 'already_processed', prior: claim.prior };
  }

  const orderRows = await db.execute<{ id: string }>(sql`
    select id from channel_orders
     where connection_id = ${input.connectionId}::uuid
       and external_order_id = ${input.externalOrderId}
     for update
  `);

  const order = orderRows.rows[0];
  if (order === undefined) {
    // Not an error: a cancellation can outrun the order it cancels when two
    // webhooks are delivered out of order. The event stays claimed so the
    // caller can decide to fetch the order and try again.
    const missing: LifecycleResult = { outcome: 'order_unknown' };
    await completeEvent(db, claim.eventId, missing);

    return missing;
  }

  const lines = await readLines(db, order.id, input.externalLineIds);
  const effects: LineEffect[] = [];
  const candidates: string[] = [];
  const touched = new Set<string>();

  for (const line of lines) {
    const decision = await decide(line, {
      businessId: input.businessId,
      connectionId: input.connectionId,
      orderId: order.id,
    });

    effects.push(decision.effect);

    if (decision.candidateId !== undefined) {
      candidates.push(decision.candidateId);
    }
    if (decision.touched !== undefined && decision.touched !== null) {
      touched.add(decision.touched);
    }
  }

  for (const canonicalItemId of touched) {
    await refreshTargetsForItem(db, {
      businessId: input.businessId,
      canonicalItemId,
      reason: input.reason,
    });
  }

  const result: LifecycleResult = {
    outcome: 'applied',
    orderId: order.id,
    lines: effects,
    restockCandidates: candidates,
  };

  await completeEvent(db, claim.eventId, result);

  return result;
}

async function readLines(
  db: Database,
  orderId: string,
  externalLineIds?: readonly string[],
): Promise<OrderLineRow[]> {
  const rows = await db.execute<OrderLineRow>(sql`
    select id, external_line_id, quantity, shipped_quantity, treatment,
           canonical_item_id, reservation_id
      from channel_order_lines
     where order_id = ${orderId}::uuid
       ${
         externalLineIds === undefined
           ? sql``
           : sql`and external_line_id = any(${sql.param([...externalLineIds])}::text[])`
       }
     order by external_line_id
  `);

  return [...rows.rows];
}

async function raiseRestockCandidate(
  db: Database,
  input: {
    readonly businessId: string;
    readonly connectionId: string;
    readonly orderId: string;
    readonly line: OrderLineRow;
    readonly origin: 'refund' | 'return' | 'dispute' | 'cancellation_after_shipment';
    readonly quantity: number;
    readonly reason: string;
  },
): Promise<string> {
  const rows = await db.execute<{ id: string }>(sql`
    insert into restock_candidates (
      business_id, connection_id, order_id, order_line_id, external_order_id,
      external_line_id, canonical_item_id, origin, claimed_quantity, reason
    )
    select ${input.businessId}::uuid, ${input.connectionId}::uuid, ${input.orderId}::uuid,
           ${input.line.id}::uuid, o.external_order_id, ${input.line.external_line_id},
           ${input.line.canonical_item_id}::uuid, ${input.origin}, ${input.quantity},
           ${input.reason}
      from channel_orders o
     where o.id = ${input.orderId}::uuid
    -- A provider that redelivers a refund notification must not accumulate a
    -- queue of identical decisions for one person to work through.
    on conflict (connection_id, external_order_id, external_line_id, origin) do update
       set claimed_quantity = greatest(restock_candidates.claimed_quantity, excluded.claimed_quantity)
    returning id
  `);

  const id = rows.rows[0]?.id;
  if (id === undefined) {
    throw new Error('raising a restock candidate returned nothing');
  }

  return id;
}
