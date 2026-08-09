import type { AuditRecorder } from '@eim/audit';
import { mirroredOrders, type Database } from '@eim/db';
import {
  describeFailure,
  isSuccess,
  type ChannelAdapter,
  type MirroredOrderLine,
  type PostalContact,
} from '@eim/providers';
import {
  beginExecution,
  completeExecution,
  failExecution,
  proposeOperation,
  type FingerprintValue,
  type ProposedOperation,
} from '@eim/review';
import { and, eq } from 'drizzle-orm';

import { assessOrderCopySupport, type SuppressionTechnique } from './suppression';

/**
 * Copying an eBay order into a WooCommerce store (section 11).
 *
 * The most cautious operation in this milestone, and the one with the most ways
 * to be wrong. It is also the only place this application creates an order
 * rather than observing one, which is why it is worth naming what the copy is:
 * a record, not a sale. The customer bought the goods on eBay. The ledger
 * committed the stock when eBay said so. The copy exists because somebody wants
 * their WooCommerce order list to show what they actually sold, and for no other
 * reason.
 *
 * Three rules follow from that, and all three are refusals.
 *
 * The copy must not reduce the store's stock. Section 11 is explicit that the
 * copy action has to suppress WooCommerce's own reduction "rather than relying
 * on later reconciliation to paper over it", and that where no reliable
 * technique exists the action is unavailable "instead of shipping a known double
 * decrement". `suppression.ts` holds that gate, and it is currently closed on
 * every version because verification V-03 has not been carried out.
 *
 * The copy must not become a second canonical sale when it comes back through
 * the order pipeline as an ordinary WooCommerce webhook. The `mirrored_orders`
 * row is written before the provider call, so an order that lands and then fails
 * to be recorded is impossible in the direction that matters.
 *
 * And the copy is never automatic. Section 11: "no automatic copying exists."
 */

export class OrderCopyRefused extends Error {
  public readonly verdict: string;

  constructor(message: string, verdict: string) {
    super(message);
    this.name = 'OrderCopyRefused';
    this.verdict = verdict;
  }
}

/** Everything a person must be shown before agreeing to this. */
export interface OrderCopySubject {
  readonly sourceOrderId: string;
  readonly sourceConnectionId: string;
  /** Section 11: unshipped paid orders are processing, fulfilled ones complete. */
  readonly fulfilled: boolean;
  readonly currency: string;
  readonly lines: readonly MirroredOrderLine[];
  readonly shippingAmount?: string;
  readonly taxAmount?: string;
  readonly totalAmount: string;
  readonly billing?: PostalContact;
  readonly shipping?: PostalContact;
  readonly placedAt?: Date;
}

export interface ProposeOrderCopyInput {
  readonly businessId: string;
  readonly subject: OrderCopySubject;
  readonly destinationConnectionId: string;
  /** The destination store's WooCommerce version, as its system status reports it. */
  readonly destinationWooVersion: string | null;
  readonly actorUserId: string;
  /** Overrides the shipped technique catalogue. Tests only. */
  readonly techniques?: readonly SuppressionTechnique[];
  readonly sourceObservedAt: Date;
  readonly now?: Date;
}

export interface ProposedOrderCopy extends ProposedOperation {
  readonly status: 'processing' | 'completed';
  readonly technique: SuppressionTechnique;
  readonly warnings: readonly string[];
}

/**
 * Records a proposal to copy one order.
 *
 * The version gate is checked first, before anything is built and before
 * anybody is shown a confirmation button. Offering a review of a copy that
 * cannot be made safely wastes the reviewer's time and invites them to press it.
 */
export async function proposeOrderCopy(
  db: Database,
  audit: AuditRecorder,
  input: ProposeOrderCopyInput,
): Promise<ProposedOrderCopy> {
  const support = assessOrderCopySupport(input.destinationWooVersion, input.techniques);
  if (!support.supported) {
    throw new OrderCopyRefused(support.reason, 'suppression_unavailable');
  }

  const existing = await db
    .select({ id: mirroredOrders.id })
    .from(mirroredOrders)
    .where(
      and(
        eq(mirroredOrders.sourceConnectionId, input.subject.sourceConnectionId),
        eq(mirroredOrders.sourceExternalOrderId, input.subject.sourceOrderId),
        eq(mirroredOrders.destinationConnectionId, input.destinationConnectionId),
      ),
    )
    .limit(1);

  if (existing.length > 0) {
    throw new OrderCopyRefused(
      'this order has already been copied to this store',
      'already_copied',
    );
  }

  const status = input.subject.fulfilled ? 'completed' : 'processing';

  const decisive: FingerprintValue = {
    sourceOrderId: input.subject.sourceOrderId,
    status,
    currency: input.subject.currency,
    total: input.subject.totalAmount,
    shippingAmount: input.subject.shippingAmount ?? null,
    taxAmount: input.subject.taxAmount ?? null,
    // Every line, in order, with its money. Section 11 requires the user to
    // review "all customer, address, line, amount, tax, shipping, and status
    // data before confirmation", and a fingerprint that covered only the total
    // would let two lines swap quantities without the agreement noticing.
    lines: input.subject.lines.map((line) => ({
      sourceLineId: line.sourceLineId,
      sku: line.sku ?? null,
      name: line.name,
      quantity: line.quantity,
      unitAmount: line.unitAmount,
      totalAmount: line.totalAmount,
      taxAmount: line.taxAmount ?? null,
    })),
    billingAddress: contactFingerprint(input.subject.billing),
    shippingAddress: contactFingerprint(input.subject.shipping),
    suppression: support.technique.name,
  };

  const warnings = [
    'this copy records a sale that already happened on eBay; it moves no stock and creates no new demand',
    'the customer will not be emailed about this order',
    `WooCommerce’s own stock reduction will be suppressed using the ${support.technique.name} technique`,
  ];

  const proposal = await proposeOperation(db, {
    businessId: input.businessId,
    kind: 'order_copy',
    subjectKey: `order:${input.subject.sourceConnectionId}:${input.subject.sourceOrderId}`,
    requiredPermission: 'copy_ebay_order_to_woocommerce',
    preview: {
      source: {
        orderId: input.subject.sourceOrderId,
        placedAt: input.subject.placedAt,
        currency: input.subject.currency,
      },
      status,
      lines: input.subject.lines,
      billing: input.subject.billing,
      shipping: input.subject.shipping,
      shippingAmount: input.subject.shippingAmount,
      taxAmount: input.subject.taxAmount,
      totalAmount: input.subject.totalAmount,
      paymentMethodTitle: 'eBay',
      suppression: support.technique,
      warnings,
    },
    decisive,
    sourceObservedAt: input.sourceObservedAt,
    proposedByUserId: input.actorUserId,
    idempotencyKey: `order-copy:${input.subject.sourceConnectionId}:${input.subject.sourceOrderId}:${input.destinationConnectionId}`,
    sourceConnectionId: input.subject.sourceConnectionId,
    destinationConnectionId: input.destinationConnectionId,
    externalReference: input.subject.sourceOrderId,
    ...(input.now === undefined ? {} : { now: input.now }),
  });

  await audit.record(db, {
    action: 'listing.operation.proposed',
    result: 'success',
    businessId: input.businessId,
    targetType: 'reviewed_operation',
    targetId: proposal.operationId,
    detail: {
      kind: 'order_copy',
      sourceOrderId: input.subject.sourceOrderId,
      status,
      suppression: support.technique.name,
    },
  });

  return { ...proposal, status, technique: support.technique, warnings };
}

/** Only what a fingerprint needs: the fields a reviewer actually reads. */
function contactFingerprint(contact: PostalContact | undefined): FingerprintValue {
  if (contact === undefined) {
    return null;
  }

  return {
    firstName: contact.firstName ?? null,
    lastName: contact.lastName ?? null,
    company: contact.company ?? null,
    line1: contact.line1 ?? null,
    line2: contact.line2 ?? null,
    city: contact.city ?? null,
    region: contact.region ?? null,
    postcode: contact.postcode ?? null,
    country: contact.country ?? null,
    email: contact.email ?? null,
    phone: contact.phone ?? null,
  };
}

export interface ExecuteOrderCopyInput {
  readonly businessId: string;
  readonly operationId: string;
  readonly adapter: ChannelAdapter;
}

export interface CopiedOrder {
  readonly destinationOrderId: string;
  readonly status: string;
}

/**
 * Writes the copy somebody confirmed.
 *
 * The `mirrored_orders` row is inserted before the provider call and completed
 * after it. That order matters: if the process dies between the two, the row
 * exists with no destination order, which is a mirror nobody can find but also a
 * record that an attempt was made — while the reverse would leave an order in
 * somebody's shop that the pipeline would happily treat as a fresh sale.
 */
export async function executeOrderCopy(
  db: Database,
  audit: AuditRecorder,
  input: ExecuteOrderCopyInput,
): Promise<CopiedOrder> {
  const operation = await beginExecution(db, input);
  if (operation === null) {
    throw new OrderCopyRefused('this copy has not been confirmed, or has already run', 'state');
  }

  const preview = operation.preview as {
    status?: unknown;
    lines?: readonly MirroredOrderLine[];
    billing?: PostalContact;
    shipping?: PostalContact;
    shippingAmount?: string;
    taxAmount?: string;
    totalAmount?: unknown;
    suppression?: { name?: unknown };
    source?: { orderId?: unknown; currency?: unknown };
  };

  const status = preview.status;
  const technique = preview.suppression?.name;
  const sourceOrderId = preview.source?.orderId;
  const currency = preview.source?.currency;

  if (
    (status !== 'processing' && status !== 'completed') ||
    typeof technique !== 'string' ||
    typeof sourceOrderId !== 'string' ||
    typeof currency !== 'string' ||
    typeof preview.totalAmount !== 'string' ||
    operation.sourceConnectionId === null ||
    operation.destinationConnectionId === null
  ) {
    await failExecution(db, { ...input, summary: 'the confirmed operation is incomplete' });
    throw new OrderCopyRefused('the confirmed operation is incomplete', 'state');
  }

  // Reserved before the call, so the pipeline can never see the copy first.
  const reserved = await db
    .insert(mirroredOrders)
    .values({
      businessId: input.businessId,
      sourceConnectionId: operation.sourceConnectionId,
      sourceExternalOrderId: sourceOrderId,
      destinationConnectionId: operation.destinationConnectionId,
      operationId: operation.id,
      suppressionTechnique: technique,
      ...(operation.confirmedByUserId === null
        ? {}
        : { createdByUserId: operation.confirmedByUserId }),
    })
    .returning({ id: mirroredOrders.id });

  const mirror = reserved[0];
  if (mirror === undefined) {
    await failExecution(db, { ...input, summary: 'the mirror record could not be reserved' });
    throw new OrderCopyRefused('the mirror record could not be reserved', 'state');
  }

  const result = await input.adapter.listingOperations?.createMirroredOrder?.({
    sourceOrderId,
    sourceProvider: 'ebay',
    status,
    currency,
    lines: preview.lines ?? [],
    ...(preview.shippingAmount === undefined ? {} : { shippingAmount: preview.shippingAmount }),
    ...(preview.taxAmount === undefined ? {} : { taxAmount: preview.taxAmount }),
    totalAmount: preview.totalAmount,
    ...(preview.billing === undefined ? {} : { billing: preview.billing }),
    ...(preview.shipping === undefined ? {} : { shipping: preview.shipping }),
    // Section 11: an eBay label, without invoking a payment gateway.
    paymentMethodTitle: 'eBay',
    suppressStockReduction: technique,
    suppressCustomerEmail: true,
    metadata: {
      // Section 11: "the copied order contains original eBay order/line
      // identifiers and integration metadata."
      _eim_source_provider: 'ebay',
      _eim_source_order_id: sourceOrderId,
      _eim_mirror_of: sourceOrderId,
      _eim_operation_id: operation.id,
    },
    idempotencyKey: operation.idempotencyKey,
  });

  if (result === undefined) {
    await failExecution(db, { ...input, summary: 'this channel cannot accept a copied order' });
    throw new OrderCopyRefused('this channel cannot accept a copied order', 'unsupported');
  }
  if (!isSuccess(result)) {
    await failExecution(db, { ...input, summary: describeFailure(result) });
    throw new OrderCopyRefused(describeFailure(result), 'provider');
  }

  if (!result.value.stockReductionSuppressed) {
    // The store took the order and reduced its own stock anyway. Section 11
    // would rather the action were unavailable than leave this in place, so the
    // failure is loud and names the order that now needs correcting by hand.
    await failExecution(db, {
      ...input,
      summary: `the store created order ${result.value.externalOrderId} but did not suppress its own stock reduction; its figures for these lines are now one sale too low`,
    });
    throw new OrderCopyRefused(
      `the store did not suppress its own stock reduction for order ${result.value.externalOrderId}`,
      'suppression_failed',
    );
  }

  await db
    .update(mirroredOrders)
    .set({
      destinationExternalOrderId: result.value.externalOrderId,
      suppressionConfirmed: true,
    })
    .where(eq(mirroredOrders.id, mirror.id));

  await completeExecution(db, {
    ...input,
    outcome: { destinationOrderId: result.value.externalOrderId, status },
  });

  await audit.record(db, {
    action: 'order.copied_to_woocommerce',
    result: 'success',
    businessId: input.businessId,
    targetType: 'reviewed_operation',
    targetId: input.operationId,
    detail: {
      sourceOrderId,
      destinationOrderId: result.value.externalOrderId,
      status,
      suppression: technique,
    },
  });

  return { destinationOrderId: result.value.externalOrderId, status };
}
