import type { AuditRecorder } from '@eim/audit';
import { authorize, type Subject } from '@eim/authz';
import {
  channelOrderLines,
  channelOrders,
  shipmentChannelPushes,
  shipmentLabels,
  shipmentPackageLines,
  shipmentPackages,
  shipmentTrackingEvents,
  type ChannelPushKind,
  type Database,
  type ShipmentChannelPush,
  type ShipmentPackage,
} from '@eim/db';
import {
  describeFailure,
  isSuccess,
  type ChannelAdapter,
  type ShippingAdapter,
} from '@eim/providers';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { LabelActionRefused, loadLabel } from './labels';

/**
 * Tracking, marking shipped, and telling the channel (sections 13, 14, 21).
 *
 * Three separate acts, and keeping them separate is the whole design.
 *
 * Recording tracking is reading: the carrier says a parcel was scanned, and that
 * is stored against the label, deduplicated on the provider's own event
 * identifier so a poll and a webhook reporting the same scan produce one row.
 *
 * Marking shipped is a person's decision. Section 14 is unambiguous — "label
 * purchase does not mean shipped" and "a user explicitly marks each package
 * shipped" — because the two happen hours apart in a real shop, and telling a
 * customer their parcel has gone while it is still on the bench is a promise
 * nobody made.
 *
 * Telling the channel is separately confirmed again, and separately permissioned.
 * Section 13 wants an eBay fulfilment carrying the tracking number; section 14
 * offers "a separately confirmed customer-visible WooCommerce order note" and,
 * only once every quantity has shipped, a confirmed move to `completed`. Each
 * push is a row with its own idempotency key, so an ambiguous timeout is retried
 * rather than duplicated — and, where the adapter can answer, section 13's
 * instruction is followed literally: ask what fulfilments already exist before
 * creating another.
 */

export class TrackingRefused extends Error {
  readonly reason: TrackingRefusalReason;

  constructor(reason: TrackingRefusalReason, message: string) {
    super(message);
    this.name = 'TrackingRefused';
    this.reason = reason;
  }
}

export type TrackingRefusalReason =
  | 'unknown_package'
  | 'not_permitted'
  | 'not_labelled'
  | 'already_shipped'
  | 'unsupported'
  | 'not_all_shipped'
  | 'provider_refused';

/**
 * Reads what the carrier says and stores anything new.
 *
 * Returns how many events were new, which is what a screen showing "checked a
 * minute ago, nothing since" needs. Not permissioned beyond membership: this is
 * a read of the business's own parcel, and the alternative is tracking that only
 * refreshes when somebody with a particular grant happens to look.
 */
export async function recordTracking(
  db: Database,
  audit: AuditRecorder,
  input: {
    readonly businessId: string;
    readonly labelId: string;
    readonly adapter: ShippingAdapter;
  },
): Promise<{ readonly recorded: number; readonly status: string }> {
  const label = await loadLabel(db, input.businessId, input.labelId);

  if (!input.adapter.capabilities.supportsTracking || input.adapter.trackShipment === undefined) {
    throw new TrackingRefused('unsupported', 'this shipping provider does not report tracking');
  }

  const report = await input.adapter.trackShipment({ providerLabelId: label.providerLabelId });

  if (!isSuccess(report)) {
    throw new TrackingRefused(
      'provider_refused',
      `tracking could not be read: ${describeFailure(report)}`,
    );
  }

  const events = report.value.events;
  if (events.length === 0) {
    return { recorded: 0, status: report.value.status };
  }

  // Deduplicated by the unique index rather than by reading first and writing
  // second, which would lose the race between a poll and a webhook carrying the
  // same scan.
  const inserted = await db
    .insert(shipmentTrackingEvents)
    .values(
      events.map((event) => ({
        businessId: input.businessId,
        labelId: label.id,
        providerEventId: event.eventId,
        status: event.status,
        occurredAt: event.occurredAt,
        ...(event.description === undefined ? {} : { description: event.description }),
        // City and country at most, as the adapter contract requires. A street
        // address here would outlive the order it belongs to.
        ...(event.location === undefined ? {} : { location: event.location }),
      })),
    )
    .onConflictDoNothing()
    .returning({ id: shipmentTrackingEvents.id });

  if (inserted.length > 0) {
    await audit.record(db, {
      action: 'shipping.tracking.recorded',
      result: 'success',
      businessId: input.businessId,
      targetType: 'shipment_label',
      targetId: label.id,
      detail: { recorded: inserted.length, status: report.value.status },
    });
  }

  return { recorded: inserted.length, status: report.value.status };
}

/**
 * Records that a person put the parcel into the post.
 *
 * Only from `labelled`, because a package without a label has nothing to hand
 * over and this application does not model shipping without one. Marking is
 * irreversible by design: unshipping a parcel is not something a screen can do,
 * and a mistake is corrected by the truth of where the parcel actually is.
 */
export async function markShipped(
  db: Database,
  audit: AuditRecorder,
  input: {
    readonly businessId: string;
    readonly packageId: string;
    readonly subject: Subject;
    readonly now?: Date;
  },
): Promise<ShipmentPackage> {
  const now = input.now ?? new Date();

  const decision = authorize(input.subject, 'mark_shipped');
  if (!decision.allowed) {
    await audit.record(db, {
      action: 'authz.denied',
      result: 'denied',
      businessId: input.businessId,
      targetType: 'shipment_package',
      targetId: input.packageId,
      detail: { permission: 'mark_shipped', reason: decision.reason },
    });

    throw new TrackingRefused('not_permitted', `mark_shipped was refused: ${decision.reason}`);
  }

  const updated = await db
    .update(shipmentPackages)
    .set({
      status: 'shipped',
      shippedAt: now,
      shippedByUserId: input.subject.userId,
      updatedAt: now,
    })
    .where(
      and(
        eq(shipmentPackages.id, input.packageId),
        eq(shipmentPackages.businessId, input.businessId),
        eq(shipmentPackages.status, 'labelled'),
      ),
    )
    .returning();

  const parcel = updated[0];
  if (parcel === undefined) {
    // One message for both cases on purpose: the screen shows the package's
    // status beside the button, so the useful sentence is what state it must be
    // in rather than which of two ways it failed to be.
    throw new TrackingRefused(
      'not_labelled',
      'only a package with a label on it, not already shipped, can be marked shipped',
    );
  }

  await audit.record(db, {
    action: 'shipping.package.shipped',
    result: 'success',
    businessId: input.businessId,
    targetType: 'shipment_package',
    targetId: parcel.id,
    detail: { orderId: parcel.orderId },
  });

  return parcel;
}

export interface PushTrackingInput {
  readonly businessId: string;
  readonly packageId: string;
  readonly kind: ChannelPushKind;
  readonly subject: Subject;
  readonly adapter: ChannelAdapter;
  readonly now?: Date;
}

/**
 * Tells the channel the parcel has gone, once.
 *
 * The push row is written before the provider is called and carries the
 * idempotency key, so a retry after an ambiguous timeout is the same row and the
 * same key rather than a second fulfilment. Where the adapter can be asked what
 * already exists, it is — section 13 asks for exactly that, and a provider that
 * accepted the first attempt and timed out before replying has already done the
 * work.
 */
export async function pushTrackingToChannel(
  db: Database,
  audit: AuditRecorder,
  input: PushTrackingInput,
): Promise<ShipmentChannelPush> {
  const now = input.now ?? new Date();

  const permission = input.kind === 'woocommerce_status' ? 'mark_shipped' : 'manage_tracking';
  const decision = authorize(input.subject, permission);
  if (!decision.allowed) {
    await audit.record(db, {
      action: 'authz.denied',
      result: 'denied',
      businessId: input.businessId,
      targetType: 'shipment_package',
      targetId: input.packageId,
      detail: { permission, reason: decision.reason },
    });

    throw new TrackingRefused('not_permitted', `${permission} was refused: ${decision.reason}`);
  }

  const context = await loadPushContext(db, input.businessId, input.packageId);

  if (context.parcel.status !== 'shipped') {
    throw new TrackingRefused(
      'not_labelled',
      'a package is only reported to the channel once somebody has marked it shipped',
    );
  }

  if (input.kind === 'woocommerce_status' && !(await everythingShipped(db, context.parcel))) {
    // Section 14: "partially shipped orders keep their current WooCommerce
    // status because core has no universal partial-fulfilment state".
    throw new TrackingRefused(
      'not_all_shipped',
      'the order is only completed once every quantity has shipped',
    );
  }

  const idempotencyKey = `push:${input.packageId}:${input.kind}`;

  // Written first, and only once: the unique index on (business, key) is what
  // makes a second push for the same package and kind impossible even if two
  // people press the button together.
  const claimed = await db
    .insert(shipmentChannelPushes)
    .values({
      businessId: input.businessId,
      packageId: input.packageId,
      connectionId: context.connectionId,
      kind: input.kind,
      state: 'pending',
      idempotencyKey,
      attempts: 1,
      confirmedByUserId: input.subject.userId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [shipmentChannelPushes.businessId, shipmentChannelPushes.idempotencyKey],
      set: { attempts: sql`${shipmentChannelPushes.attempts} + 1`, updatedAt: now },
      // A push that already succeeded is left alone; retrying is for the ones
      // that did not.
      setWhere: sql`${shipmentChannelPushes.state} <> 'succeeded'`,
    })
    .returning();

  const push = claimed[0];
  if (push === undefined) {
    const existing = await db
      .select()
      .from(shipmentChannelPushes)
      .where(
        and(
          eq(shipmentChannelPushes.businessId, input.businessId),
          eq(shipmentChannelPushes.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);

    const settled = existing[0];
    if (settled === undefined) {
      throw new TrackingRefused('unknown_package', 'the push could not be recorded');
    }

    return settled;
  }

  const outcome = await carryOut(input, context, idempotencyKey);

  if (outcome.kind === 'unsupported') {
    const rows = await db
      .update(shipmentChannelPushes)
      .set({ state: 'unsupported', failureSummary: outcome.summary, updatedAt: now })
      .where(eq(shipmentChannelPushes.id, push.id))
      .returning();

    // Not an error. A channel that cannot be told is a supported outcome:
    // section 14 makes this application's own records authoritative, and
    // propagation outward is a courtesy the platform may not offer.
    return rows[0] ?? push;
  }

  if (outcome.kind === 'failure') {
    const rows = await db
      .update(shipmentChannelPushes)
      .set({ state: 'failed', failureSummary: outcome.summary, updatedAt: now })
      .where(eq(shipmentChannelPushes.id, push.id))
      .returning();

    await audit.record(db, {
      action: 'shipping.tracking.pushed',
      result: 'failure',
      businessId: input.businessId,
      targetType: 'shipment_package',
      targetId: input.packageId,
      detail: { kind: input.kind, summary: outcome.summary },
    });

    return rows[0] ?? push;
  }

  const rows = await db
    .update(shipmentChannelPushes)
    .set({
      state: 'succeeded',
      externalReference: outcome.reference,
      completedAt: now,
      updatedAt: now,
    })
    .where(eq(shipmentChannelPushes.id, push.id))
    .returning();

  await audit.record(db, {
    action: 'shipping.tracking.pushed',
    result: 'success',
    businessId: input.businessId,
    targetType: 'shipment_package',
    targetId: input.packageId,
    detail: {
      kind: input.kind,
      externalReference: outcome.reference,
      trackingNumber: context.trackingNumber,
      // Whether the channel already had it. Section 13's instruction to query
      // first exists so this can be true rather than a second fulfilment.
      alreadyPresent: outcome.alreadyPresent,
    },
  });

  return rows[0] ?? push;
}

/** Whether every line of a package's order has been fully shipped. */
export async function everythingShipped(
  db: Database,
  parcel: Pick<ShipmentPackage, 'businessId' | 'orderId'>,
): Promise<boolean> {
  const lines = await db
    .select()
    .from(channelOrderLines)
    .where(
      and(
        eq(channelOrderLines.businessId, parcel.businessId),
        eq(channelOrderLines.orderId, parcel.orderId),
      ),
    );

  if (lines.length === 0) {
    return false;
  }

  const shipped = await db
    .select({
      orderLineId: shipmentPackageLines.orderLineId,
      total: sql<number>`sum(${shipmentPackageLines.quantity})::int`,
    })
    .from(shipmentPackageLines)
    .innerJoin(
      shipmentPackages,
      and(
        eq(shipmentPackages.id, shipmentPackageLines.packageId),
        eq(shipmentPackages.businessId, shipmentPackageLines.businessId),
      ),
    )
    .where(
      and(
        eq(shipmentPackageLines.businessId, parcel.businessId),
        inArray(
          shipmentPackageLines.orderLineId,
          lines.map((line) => line.id),
        ),
        eq(shipmentPackages.status, 'shipped'),
      ),
    )
    .groupBy(shipmentPackageLines.orderLineId);

  const byLine = new Map(shipped.map((row) => [row.orderLineId, row.total]));

  return lines.every((line) => {
    const owed = line.quantity - line.cancelledQuantity - line.refundedQuantity;

    // A line entirely cancelled or refunded owes nothing and is satisfied.
    return owed <= (byLine.get(line.id) ?? 0);
  });
}

type PushOutcome =
  | { readonly kind: 'success'; readonly reference: string; readonly alreadyPresent: boolean }
  | { readonly kind: 'failure'; readonly summary: string }
  | { readonly kind: 'unsupported'; readonly summary: string };

async function carryOut(
  input: PushTrackingInput,
  context: PushContext,
  idempotencyKey: string,
): Promise<PushOutcome> {
  const operations = input.adapter.fulfillmentOperations;

  if (operations === undefined) {
    return { kind: 'unsupported', summary: 'this channel cannot be told about a shipment' };
  }

  if (input.kind === 'ebay_fulfillment') {
    if (operations.createFulfillment === undefined) {
      return { kind: 'unsupported', summary: 'this channel does not record fulfilments' };
    }

    // Section 13: ambiguous fulfilment retries first query existing
    // fulfilments. Asked before creating anything, so a retry after a timeout
    // adopts what is already there instead of shipping the order twice.
    if (operations.findFulfillment !== undefined) {
      const existing = await operations.findFulfillment({
        externalOrderId: context.externalOrderId,
        idempotencyKey,
      });

      if (isSuccess(existing) && existing.value !== null) {
        return {
          kind: 'success',
          reference: existing.value.externalFulfillmentId,
          alreadyPresent: true,
        };
      }
    }

    const created = await operations.createFulfillment({
      externalOrderId: context.externalOrderId,
      lines: context.lines,
      carrier: context.carrier,
      trackingNumber: context.trackingNumber,
      shippedAt: context.shippedAt,
      idempotencyKey,
    });

    return isSuccess(created)
      ? { kind: 'success', reference: created.value.externalFulfillmentId, alreadyPresent: false }
      : { kind: 'failure', summary: describeFailure(created) };
  }

  if (input.kind === 'woocommerce_order_note') {
    if (operations.addOrderNote === undefined) {
      return { kind: 'unsupported', summary: 'this channel does not accept order notes' };
    }

    const added = await operations.addOrderNote({
      externalOrderId: context.externalOrderId,
      // Plain words, and nothing a plugin would have to interpret. Section 14
      // forbids writing unofficial plugin metadata, so the customer-visible
      // note is where tracking goes.
      note: `Shipped with ${context.carrier}. Tracking number ${context.trackingNumber}.`,
      customerVisible: true,
      idempotencyKey,
    });

    return isSuccess(added)
      ? { kind: 'success', reference: added.value.noteId, alreadyPresent: false }
      : { kind: 'failure', summary: describeFailure(added) };
  }

  if (operations.setOrderStatus === undefined) {
    return { kind: 'unsupported', summary: 'this channel does not accept a status change' };
  }

  const moved = await operations.setOrderStatus({
    externalOrderId: context.externalOrderId,
    status: 'completed',
    idempotencyKey,
  });

  return isSuccess(moved)
    ? { kind: 'success', reference: moved.value.status, alreadyPresent: false }
    : { kind: 'failure', summary: describeFailure(moved) };
}

interface PushContext {
  readonly parcel: ShipmentPackage;
  readonly connectionId: string;
  readonly externalOrderId: string;
  readonly carrier: string;
  readonly trackingNumber: string;
  readonly shippedAt: Date;
  readonly lines: readonly { readonly externalLineId: string; readonly quantity: number }[];
}

async function loadPushContext(
  db: Database,
  businessId: string,
  packageId: string,
): Promise<PushContext> {
  const parcels = await db
    .select()
    .from(shipmentPackages)
    .where(and(eq(shipmentPackages.id, packageId), eq(shipmentPackages.businessId, businessId)))
    .limit(1);

  const parcel = parcels[0];
  if (parcel === undefined) {
    throw new TrackingRefused('unknown_package', 'no such package in this business');
  }

  const orders = await db
    .select()
    .from(channelOrders)
    .where(and(eq(channelOrders.id, parcel.orderId), eq(channelOrders.businessId, businessId)))
    .limit(1);

  const order = orders[0];
  if (order === undefined) {
    throw new TrackingRefused('unknown_package', 'the order behind this package is gone');
  }

  const labels = await db
    .select()
    .from(shipmentLabels)
    .where(
      and(
        eq(shipmentLabels.packageId, packageId),
        eq(shipmentLabels.businessId, businessId),
        inArray(shipmentLabels.state, ['purchased', 'void_requested', 'void_refused']),
      ),
    )
    .limit(1);

  const label = labels[0];
  if (label === undefined) {
    throw new LabelActionRefused(
      'unknown_label',
      'this package has no live label, so there is no tracking number to report',
    );
  }

  const contents = await db
    .select({
      quantity: shipmentPackageLines.quantity,
      externalLineId: channelOrderLines.externalLineId,
    })
    .from(shipmentPackageLines)
    .innerJoin(
      channelOrderLines,
      and(
        eq(channelOrderLines.id, shipmentPackageLines.orderLineId),
        eq(channelOrderLines.businessId, shipmentPackageLines.businessId),
      ),
    )
    .where(
      and(
        eq(shipmentPackageLines.packageId, packageId),
        eq(shipmentPackageLines.businessId, businessId),
      ),
    );

  return {
    parcel,
    connectionId: order.connectionId,
    externalOrderId: order.externalOrderId,
    carrier: label.carrier,
    trackingNumber: label.trackingNumber,
    shippedAt: parcel.shippedAt ?? parcel.updatedAt,
    lines: contents,
  };
}
