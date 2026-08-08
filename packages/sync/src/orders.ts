import {
  channelMappingLocations,
  channelMappings,
  providerItems,
  type Database,
  type DemandState,
  type LineTreatment,
} from '@eim/db';
import { reserve } from '@eim/inventory';
import type { ProviderOrder, ProviderOrderLine } from '@eim/providers';
import { and, eq, inArray } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

import { claimEvent, completeEvent, type EventIdentity } from './events';
import { refreshTargetsForItem } from './targets';

/**
 * Turning what a channel sold into what this ledger owes (sections 11, 12, 15).
 *
 * The shape of this module follows one sentence in section 15: "import every
 * order line for operational visibility and deduplication [but] reserve or
 * consume only lines whose inventory mappings are active and eligible." So
 * importing and treating are two separate steps over the same rows, and an
 * untreatable line is stored, shown, and flagged rather than dropped or
 * allowed to block its neighbours.
 *
 * Three rules that are easy to state and easy to get wrong:
 *
 *   Inventory is committed once, on the first transition into a qualifying
 *   status. Every later update that still qualifies is an observation. A
 *   provider that resends "processing" four times has not sold four orders.
 *
 *   A provider's own revision beats arrival order. A webhook that overtakes
 *   its predecessor must not roll a status backwards, so an update carrying an
 *   older sequence than the row already holds is discarded outright.
 *
 *   An order is recorded even when there is not enough stock. Section 11:
 *   allocate what exists, record the shortage explicitly, target zero on the
 *   affected channels, and never cancel a customer's order automatically.
 */

/**
 * An order as an adapter reports it.
 *
 * Defined in `@eim/providers` rather than here, because deciding that
 * WooCommerce's `processing` commits demand and its `pending` does not is
 * knowledge about one provider, and the whole point of the adapter boundary is
 * that such knowledge stays behind it. The pipeline receives a vocabulary it
 * already understands.
 *
 * The alias is kept because `demandState` must remain assignable to the
 * database's column type: if the two vocabularies ever drift, this line stops
 * compiling rather than storing a state nothing can read.
 */
export type NormalizedOrder = ProviderOrder & { readonly demandState: DemandState };
export type NormalizedOrderLine = ProviderOrderLine;

export interface LineOutcome {
  readonly externalLineId: string;
  readonly treatment: LineTreatment;
  readonly reason: string | null;
  readonly canonicalItemId: string | null;
  readonly quantity: number;
  readonly shortage: number;
}

export type IngestResult =
  | {
      readonly outcome: 'ingested';
      readonly orderId: string;
      readonly committed: boolean;
      readonly lines: readonly LineOutcome[];
      /** Lines that moved no stock and need somebody's attention. */
      readonly needsAttention: readonly LineOutcome[];
      readonly shortages: number;
    }
  /** Section 12: a replayed event returns its prior outcome, mutating nothing. */
  | { readonly outcome: 'already_processed'; readonly prior: unknown }
  /** A stale delivery that arrived after a newer one. */
  | { readonly outcome: 'superseded'; readonly orderId: string };

export interface IngestInput {
  readonly businessId: string;
  readonly connectionId: string;
  readonly order: NormalizedOrder;
  readonly event: EventIdentity;
  readonly actorUserId?: string | null;
  readonly now?: Date;
}

/**
 * Records an order and, if it has just qualified, commits inventory for it.
 *
 * Call inside a transaction. Everything this does — the order, its lines, the
 * ledger entries, the reservations, the new channel targets, and the jobs that
 * will carry them to providers — has to commit together or not at all, which is
 * the whole reason section 12 asks for "one PostgreSQL transaction".
 */
export async function ingestOrder(db: Database, input: IngestInput): Promise<IngestResult> {
  const claim = await claimEvent<unknown>(db, input.event);

  if (claim.outcome === 'already_processed') {
    return { outcome: 'already_processed', prior: claim.prior };
  }

  const stored = await upsertOrder(db, input);

  if (stored.superseded) {
    const result: IngestResult = { outcome: 'superseded', orderId: stored.orderId };
    await completeEvent(db, claim.eventId, result);

    return result;
  }

  await upsertLines(db, {
    businessId: input.businessId,
    orderId: stored.orderId,
    order: input.order,
  });

  // Section 11 commits once, on the first qualifying transition. A provider
  // that resends "processing" has not sold the order again.
  const shouldCommit = input.order.demandState === 'committed' && !stored.alreadyCommitted;

  const lines = shouldCommit
    ? await treatLines(db, { ...input, orderId: stored.orderId })
    : await describeUntreated(db, stored.orderId);

  const result: IngestResult = {
    outcome: 'ingested',
    orderId: stored.orderId,
    committed: shouldCommit,
    lines,
    needsAttention: lines.filter(
      (line) => line.treatment === 'unmapped' || line.treatment === 'ineligible',
    ),
    shortages: lines.reduce((total, line) => total + line.shortage, 0),
  };

  await completeEvent(db, claim.eventId, result);

  return result;
}

/**
 * Stores the order and reports what it was before this delivery.
 *
 * Deliberately three statements rather than one clever upsert. The two facts
 * the caller needs — whether this delivery is stale, and whether the order had
 * already committed inventory — are both about the row *before* the write, and
 * `returning` on an upsert reports the row after it. Insert-if-absent, then
 * `select … for update`, then update: the lock is what makes the read-then-write
 * safe, and it is held for the rest of the caller's transaction, which also
 * serializes two deliveries for one order arriving at two workers at once.
 */
async function upsertOrder(
  db: Database,
  input: IngestInput,
): Promise<{
  readonly orderId: string;
  readonly superseded: boolean;
  readonly alreadyCommitted: boolean;
}> {
  const order = input.order;

  // Identity only. Everything else is applied by the update below, so that a
  // brand-new order and a returning one take exactly the same path and a first
  // qualifying delivery cannot mistake its own write for prior history.
  await db.execute(sql`
    insert into channel_orders (business_id, connection_id, external_order_id)
    values (${input.businessId}::uuid, ${input.connectionId}::uuid, ${order.externalOrderId})
    on conflict (connection_id, external_order_id) do nothing
  `);

  const locked = await db.execute<{
    id: string;
    first_committed_at: Date | string | null;
    provider_sequence: string | number | null;
  }>(sql`
    select id, first_committed_at, provider_sequence
      from channel_orders
     where connection_id = ${input.connectionId}::uuid
       and external_order_id = ${order.externalOrderId}
     for update
  `);

  const row = locked.rows[0];
  if (row === undefined) {
    throw new Error('storing a channel order returned nothing');
  }

  const storedSequence = row.provider_sequence === null ? null : Number(row.provider_sequence);
  // A provider that does not number its deliveries gets arrival order, which is
  // better than refusing every update it sends.
  const superseded =
    order.providerSequence !== undefined &&
    storedSequence !== null &&
    order.providerSequence < storedSequence;

  if (superseded) {
    return { orderId: row.id, superseded: true, alreadyCommitted: row.first_committed_at !== null };
  }

  const committing = order.demandState === 'committed';

  await db.execute(sql`
    update channel_orders
       set provider_status   = coalesce(${order.providerStatus ?? null}, provider_status),
           demand_state      = ${order.demandState},
           placed_at         = coalesce(${order.placedAt ?? null}::timestamptz, placed_at),
           provider_revision = coalesce(${order.providerRevision ?? null}, provider_revision),
           provider_sequence = greatest(
             coalesce(provider_sequence, ${order.providerSequence ?? null}::bigint),
             ${order.providerSequence ?? null}::bigint
           ),
           currency        = coalesce(${order.currency ?? null}, currency),
           total_amount    = coalesce(${order.totalAmount ?? null}::numeric, total_amount),
           buyer_reference = coalesce(${order.buyerReference ?? null}, buyer_reference),
           first_committed_at = case
             when ${committing} then coalesce(first_committed_at, now())
             else first_committed_at
           end
     where id = ${row.id}::uuid
  `);

  return {
    orderId: row.id,
    superseded: false,
    alreadyCommitted: row.first_committed_at !== null,
  };
}

async function upsertLines(
  db: Database,
  input: {
    readonly businessId: string;
    readonly orderId: string;
    readonly order: NormalizedOrder;
  },
): Promise<void> {
  for (const line of input.order.lines) {
    await db.execute(sql`
      insert into channel_order_lines (
        business_id, order_id, external_line_id, external_item_id, variation_id,
        sku, title, quantity, cancelled_quantity, shipped_quantity, refunded_quantity
      )
      values (
        ${input.businessId}::uuid, ${input.orderId}::uuid, ${line.externalLineId},
        ${line.externalItemId}, ${line.variationId ?? null}, ${line.sku ?? null},
        ${line.title ?? null}, ${line.quantity},
        ${line.cancelledQuantity ?? 0}, ${line.shippedQuantity ?? 0}, ${line.refundedQuantity ?? 0}
      )
      on conflict (order_id, external_line_id) do update
         set quantity           = excluded.quantity,
             sku                = coalesce(excluded.sku, channel_order_lines.sku),
             title              = coalesce(excluded.title, channel_order_lines.title),
             -- Per-line lifecycle only ever advances. A provider that reports a
             -- smaller shipped figure than we already recorded is describing one
             -- shipment of several, not an unshipping.
             cancelled_quantity = greatest(channel_order_lines.cancelled_quantity, excluded.cancelled_quantity),
             shipped_quantity   = greatest(channel_order_lines.shipped_quantity, excluded.shipped_quantity),
             refunded_quantity  = greatest(channel_order_lines.refunded_quantity, excluded.refunded_quantity)
    `);
  }
}

interface StoredLine {
  id: string;
  external_line_id: string;
  external_item_id: string | null;
  variation_id: string | null;
  quantity: number;
  treatment: LineTreatment;
  treatment_reason: string | null;
  canonical_item_id: string | null;
  shortage: number;
}

/**
 * Commits inventory for every line that has somewhere to commit it.
 *
 * Section 15: "an ineligible line does not prevent eligible mapped lines in the
 * same order from protecting inventory." So each line is decided on its own,
 * and the ones that cannot move stock are recorded with a reason instead of
 * aborting the order.
 */
async function treatLines(
  db: Database,
  input: IngestInput & { readonly orderId: string },
): Promise<LineOutcome[]> {
  const lines = await readLines(db, input.orderId);
  const outcomes: LineOutcome[] = [];
  const touched = new Set<string>();

  for (const line of lines) {
    const resolved = await resolveMapping(db, {
      businessId: input.businessId,
      connectionId: input.connectionId,
      externalItemId: line.external_item_id,
      variationId: line.variation_id,
    });

    if (resolved === null) {
      outcomes.push(
        await markLine(db, line, {
          treatment: 'unmapped',
          reason: 'no mapping exists for this channel entity',
        }),
      );
      continue;
    }

    if (resolved.reason !== null) {
      outcomes.push(await markLine(db, line, { treatment: 'ineligible', reason: resolved.reason }));
      continue;
    }

    const reservation = await reserve(db, {
      businessId: input.businessId,
      connectionId: input.connectionId,
      externalOrderId: input.order.externalOrderId,
      externalLineId: line.external_line_id,
      canonicalItemId: resolved.canonicalItemId,
      quantity: line.quantity,
      locationIds: resolved.locationIds,
      ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
      ...(input.now === undefined ? {} : { now: input.now }),
    });

    if (reservation.outcome === 'not_found' || reservation.outcome === 'invalid') {
      outcomes.push(
        await markLine(db, line, {
          treatment: 'ineligible',
          reason:
            reservation.outcome === 'invalid'
              ? reservation.reason
              : 'the canonical item this line maps to no longer exists',
        }),
      );
      continue;
    }

    const view = reservation.reservation;

    outcomes.push(
      await markLine(db, line, {
        treatment: view.consumptionMode === 'consume_immediately' ? 'consumed' : 'reserved',
        reason: null,
        canonicalItemId: resolved.canonicalItemId,
        mappingId: resolved.mappingId,
        reservationId: view.reservationId,
        shortage: view.shortage,
      }),
    );

    touched.add(resolved.canonicalItemId);
  }

  // Every channel that advertises anything this order touched now owes a new
  // number, including the ones the order did not come from. Section 11's
  // "immediately target zero on affected channels" for a shortage falls out of
  // this rather than being a special case: availability is zero, so the target
  // computed from it is zero.
  for (const canonicalItemId of touched) {
    await refreshTargetsForItem(db, {
      businessId: input.businessId,
      canonicalItemId,
      reason: `order ${input.order.externalOrderId}`,
    });
  }

  return outcomes;
}

async function describeUntreated(db: Database, orderId: string): Promise<LineOutcome[]> {
  const lines = await readLines(db, orderId);

  return lines.map((line) => ({
    externalLineId: line.external_line_id,
    treatment: line.treatment,
    reason: line.treatment_reason,
    canonicalItemId: line.canonical_item_id,
    quantity: line.quantity,
    shortage: line.shortage,
  }));
}

async function readLines(db: Database, orderId: string): Promise<StoredLine[]> {
  const rows = await db.execute<StoredLine & Record<string, unknown>>(sql`
    select id, external_line_id, external_item_id, variation_id, quantity,
           treatment, treatment_reason, canonical_item_id, shortage
      from channel_order_lines
     where order_id = ${orderId}::uuid
     order by external_line_id
  `);

  return [...rows.rows];
}

async function markLine(
  db: Database,
  line: StoredLine,
  update: {
    readonly treatment: LineTreatment;
    readonly reason: string | null;
    readonly canonicalItemId?: string;
    readonly mappingId?: string;
    readonly reservationId?: string;
    readonly shortage?: number;
  },
): Promise<LineOutcome> {
  await db.execute(sql`
    update channel_order_lines
       set treatment = ${update.treatment},
           treatment_reason = ${update.reason},
           canonical_item_id = ${update.canonicalItemId ?? null}::uuid,
           mapping_id = ${update.mappingId ?? null}::uuid,
           reservation_id = ${update.reservationId ?? null}::uuid,
           shortage = ${update.shortage ?? 0}
     where id = ${line.id}::uuid
  `);

  return {
    externalLineId: line.external_line_id,
    treatment: update.treatment,
    reason: update.reason,
    canonicalItemId: update.canonicalItemId ?? null,
    quantity: line.quantity,
    shortage: update.shortage ?? 0,
  };
}

interface ResolvedMapping {
  readonly mappingId: string;
  readonly canonicalItemId: string;
  readonly locationIds: readonly string[];
  /** Null when this mapping may move stock; otherwise why it may not. */
  readonly reason: string | null;
}

/**
 * Finds the mapping for a channel entity, and says whether it may move stock.
 *
 * The eligibility question is asked here rather than trusted from activation,
 * for the same reason `resolveWriteTarget` asks it again at write time: a
 * mapping can be paused, an entity can go missing, and an order arriving in
 * between must be recorded with the truth as it stands now.
 */
async function resolveMapping(
  db: Database,
  input: {
    readonly businessId: string;
    readonly connectionId: string;
    readonly externalItemId: string | null;
    readonly variationId: string | null;
  },
): Promise<ResolvedMapping | null> {
  if (input.externalItemId === null) {
    return null;
  }

  // A variation is addressed by its own external id where the provider gives
  // one, because section 6 as amended by D-131 requires a mapping to address
  // the level that actually holds the number.
  const externalId = input.variationId ?? input.externalItemId;

  const rows = await db
    .select({
      mappingId: channelMappings.id,
      canonicalItemId: channelMappings.canonicalItemId,
      status: channelMappings.status,
      pauseReason: channelMappings.pauseReason,
      inventoryEligible: providerItems.inventoryEligible,
      ineligibleReason: providerItems.ineligibleReason,
      missingSince: providerItems.missingSince,
    })
    .from(channelMappings)
    .innerJoin(providerItems, eq(providerItems.id, channelMappings.providerItemId))
    .where(
      and(
        eq(channelMappings.businessId, input.businessId),
        eq(channelMappings.connectionId, input.connectionId),
        eq(providerItems.externalId, externalId),
        inArray(channelMappings.status, ['active', 'paused', 'approved', 'draft']),
      ),
    )
    .limit(1);

  const mapping = rows[0];
  if (mapping === undefined) {
    return null;
  }

  const locations = await db
    .select({ locationId: channelMappingLocations.locationId })
    .from(channelMappingLocations)
    .where(eq(channelMappingLocations.mappingId, mapping.mappingId));

  return {
    mappingId: mapping.mappingId,
    canonicalItemId: mapping.canonicalItemId,
    locationIds: locations.map((location) => location.locationId),
    reason: whyIneligible(mapping),
  };
}

function whyIneligible(mapping: {
  readonly status: string;
  readonly pauseReason: string | null;
  readonly inventoryEligible: boolean;
  readonly ineligibleReason: string | null;
  readonly missingSince: Date | null;
}): string | null {
  if (!mapping.inventoryEligible) {
    return mapping.ineligibleReason ?? 'this channel entity cannot be synchronized in version 1';
  }
  if (mapping.missingSince !== null) {
    return 'the last complete catalog scan did not find this entity';
  }
  if (mapping.status === 'paused') {
    return mapping.pauseReason ?? 'this mapping is paused';
  }
  if (mapping.status !== 'active') {
    return 'this mapping has not been activated';
  }

  return null;
}
