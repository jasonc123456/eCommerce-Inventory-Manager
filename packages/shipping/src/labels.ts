import type { AuditRecorder } from '@eim/audit';
import { authorize, type Subject } from '@eim/authz';
import { shipmentLabels, shipmentPackages, type Database, type ShipmentLabel } from '@eim/db';
import {
  describeFailure,
  isSuccess,
  type ShipmentDocument,
  type ShipmentDocumentType,
  type ShippingAdapter,
} from '@eim/providers';
import { and, eq } from 'drizzle-orm';

/**
 * A label after it has been bought: voiding it, and handing it over
 * (sections 2, 13, 19, 20, 21).
 *
 * Neither of these goes through the confirmation gate, and the reasons differ.
 *
 * Voiding has no preview whose values could move underneath a confirmer. The
 * label exists, the money is already spent, and the only open question is
 * whether the carrier will give any of it back — which is the provider's answer,
 * not something a person agrees to in advance. Section 21's confirmation tier
 * lists "label purchase" and does not list voiding. So this is an ordinary
 * permissioned action: `void_labels`, which section 5 makes unscopable and
 * section 20 makes subject to recent authentication (D-236).
 *
 * Fetching a document is a read, and reads are not confirmed. But it is the most
 * sensitive read in the application, so it carries its own rules: `view_shipments`,
 * business scope, an audit entry every time, and — the important one — the bytes
 * are never stored and the provider's URL never reaches the browser. A shipping
 * label has the buyer's name and postal address printed on it. Section 13 makes
 * this application responsible for erasing a buyer's data on request, and section
 * 11 made that tractable by never copying buyer detail out of the provider at
 * all. Persisting label images would undo it in the one format nobody can redact,
 * and handing out a provider's unauthenticated document URL would publish it to
 * anyone who ever saw the link (D-233).
 */

export class LabelActionRefused extends Error {
  readonly reason: LabelActionRefusalReason;

  constructor(reason: LabelActionRefusalReason, message: string) {
    super(message);
    this.name = 'LabelActionRefused';
    this.reason = reason;
  }
}

export type LabelActionRefusalReason =
  | 'unknown_label'
  | 'not_permitted'
  | 'recent_authentication_required'
  | 'unsupported'
  | 'already_settled'
  | 'provider_refused';

export interface VoidLabelInput {
  readonly businessId: string;
  readonly labelId: string;
  readonly subject: Subject;
  /** Whether this session authenticated inside the step-up window. */
  readonly hasRecentAuthentication: boolean;
  readonly adapter: ShippingAdapter;
  readonly now?: Date;
}

export interface VoidedLabel {
  readonly label: ShipmentLabel;
  /**
   * What the carrier said. `requested` is not a refund — some carriers decide
   * days later, once they have confirmed the label went unscanned, and reporting
   * that as money returned would be a number in somebody's accounts that never
   * arrives.
   */
  readonly outcome: 'refunded' | 'requested' | 'refused';
  readonly detail?: string;
}

/**
 * Asks the carrier to void a label, and records whatever it says.
 *
 * Only a refund actually frees the package for a replacement. A pending request
 * leaves a label that may yet be used; a refusal leaves one that is definitely
 * still valid and definitely still paid for. Buying a second label in either
 * case would spend money to replace postage the business already owns.
 */
export async function voidLabel(
  db: Database,
  audit: AuditRecorder,
  input: VoidLabelInput,
): Promise<VoidedLabel> {
  const now = input.now ?? new Date();

  const decision = authorize(input.subject, 'void_labels');
  if (!decision.allowed) {
    await audit.record(db, {
      action: 'authz.denied',
      result: 'denied',
      businessId: input.businessId,
      targetType: 'shipment_label',
      targetId: input.labelId,
      detail: { permission: 'void_labels', reason: decision.reason },
    });

    throw new LabelActionRefused('not_permitted', `void_labels was refused: ${decision.reason}`);
  }

  if (!input.hasRecentAuthentication) {
    throw new LabelActionRefused(
      'recent_authentication_required',
      'voiding a label requires authentication within the step-up window',
    );
  }

  const label = await loadLabel(db, input.businessId, input.labelId);

  if (label.state !== 'purchased') {
    throw new LabelActionRefused(
      'already_settled',
      `this label is already ${label.state.replace('_', ' ')}`,
    );
  }

  // Presence is the capability, and the stored capability is what a screen
  // consulted before drawing the button. Both are checked, because a screen can
  // be out of date and an adapter cannot.
  if (!input.adapter.capabilities.supportsVoid || input.adapter.voidLabel === undefined) {
    throw new LabelActionRefused(
      'unsupported',
      'this shipping provider does not void or refund labels',
    );
  }

  await db
    .update(shipmentLabels)
    .set({
      voidRequestedAt: now,
      voidRequestedByUserId: input.subject.userId,
      state: 'void_requested',
      updatedAt: now,
    })
    .where(and(eq(shipmentLabels.id, label.id), eq(shipmentLabels.businessId, input.businessId)));

  await audit.record(db, {
    action: 'shipping.label.void_requested',
    result: 'success',
    businessId: input.businessId,
    targetType: 'shipment_label',
    targetId: label.id,
    detail: { carrier: label.carrier, amount: label.amount, currency: label.currency },
  });

  const voided = await input.adapter.voidLabel({
    providerLabelId: label.providerLabelId,
    // Stable per label, so asking twice asks about the same one. There is no
    // second void to be idempotent against, but a provider that treats a repeat
    // as a new request would answer about a label it had already handled.
    idempotencyKey: `void:${label.id}`,
  });

  if (!isSuccess(voided)) {
    const summary = describeFailure(voided);

    // Back to purchased. The request never reached a carrier that agreed to
    // anything, and leaving the row saying a void is pending would make the
    // label unusable and unreplaceable at the same time.
    await db
      .update(shipmentLabels)
      .set({ state: 'purchased', voidDetail: summary, updatedAt: now })
      .where(eq(shipmentLabels.id, label.id));

    throw new LabelActionRefused('provider_refused', `the void was not accepted: ${summary}`);
  }

  const result = voided.value;

  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(shipmentLabels)
      .set({
        state:
          result.outcome === 'refunded'
            ? 'voided'
            : result.outcome === 'refused'
              ? 'void_refused'
              : 'void_requested',
        ...(result.outcome === 'refunded' ? { voidedAt: now } : {}),
        ...(result.refundAmount === undefined ? {} : { refundAmount: result.refundAmount }),
        ...(result.refundCurrency === undefined ? {} : { refundCurrency: result.refundCurrency }),
        ...(result.detail === undefined ? {} : { voidDetail: result.detail }),
        updatedAt: now,
      })
      .where(eq(shipmentLabels.id, label.id))
      .returning();

    if (result.outcome === 'refunded') {
      // The package goes back to being a package. Buying a replacement is the
      // entire reason for voiding, and a package stuck at `labelled` with no
      // usable label would need a database edit to rescue.
      await tx
        .update(shipmentPackages)
        .set({ status: 'draft', updatedAt: now })
        .where(
          and(
            eq(shipmentPackages.id, label.packageId),
            eq(shipmentPackages.businessId, input.businessId),
            eq(shipmentPackages.status, 'labelled'),
          ),
        );
    }

    return rows[0];
  });

  if (updated === undefined) {
    throw new LabelActionRefused('unknown_label', 'the void could not be recorded');
  }

  if (result.outcome === 'refunded') {
    await audit.record(db, {
      action: 'shipping.label.voided',
      result: 'success',
      businessId: input.businessId,
      targetType: 'shipment_label',
      targetId: label.id,
      detail: {
        refundAmount: result.refundAmount,
        refundCurrency: result.refundCurrency,
      },
    });
  }

  return {
    label: updated,
    outcome: result.outcome,
    ...(result.detail === undefined ? {} : { detail: result.detail }),
  };
}

export interface FetchDocumentInput {
  readonly businessId: string;
  readonly labelId: string;
  readonly documentType: ShipmentDocumentType;
  readonly subject: Subject;
  readonly adapter: ShippingAdapter;
}

/**
 * Fetches a label document for one authorized access.
 *
 * Nothing is cached, nothing is written, and the caller is expected to stream
 * the bytes to one person and let them go. The audit entry is the only durable
 * trace, which is deliberate: the document is the sensitive artifact, and the
 * record of who looked at it is the thing worth keeping.
 */
export async function fetchLabelDocument(
  db: Database,
  audit: AuditRecorder,
  input: FetchDocumentInput,
): Promise<ShipmentDocument> {
  const decision = authorize(input.subject, 'view_shipments');
  if (!decision.allowed) {
    await audit.record(db, {
      action: 'authz.denied',
      result: 'denied',
      businessId: input.businessId,
      targetType: 'shipment_label',
      targetId: input.labelId,
      detail: { permission: 'view_shipments', reason: decision.reason },
    });

    throw new LabelActionRefused('not_permitted', `view_shipments was refused: ${decision.reason}`);
  }

  // Scoped to the business before the provider is asked anything. A label
  // identifier from another business must not become a request on this
  // business's shipping account.
  const label = await loadLabel(db, input.businessId, input.labelId);

  const document = await input.adapter.fetchDocument({
    providerLabelId: label.providerLabelId,
    documentType: input.documentType,
  });

  if (!isSuccess(document)) {
    const summary = describeFailure(document);

    await audit.record(db, {
      action: 'shipping.label.document_accessed',
      result: 'failure',
      businessId: input.businessId,
      targetType: 'shipment_label',
      targetId: label.id,
      detail: { documentType: input.documentType, summary },
    });

    throw new LabelActionRefused(
      'provider_refused',
      `the document could not be fetched: ${summary}`,
    );
  }

  await audit.record(db, {
    action: 'shipping.label.document_accessed',
    result: 'success',
    businessId: input.businessId,
    targetType: 'shipment_label',
    targetId: label.id,
    // The tracking number, not the buyer. This row is kept for as long as the
    // audit trail is, and a postal address in it would outlive the order.
    detail: {
      documentType: input.documentType,
      trackingNumber: label.trackingNumber,
      carrier: label.carrier,
    },
  });

  return document.value;
}

export async function loadLabel(
  db: Database,
  businessId: string,
  labelId: string,
): Promise<ShipmentLabel> {
  const rows = await db
    .select()
    .from(shipmentLabels)
    .where(and(eq(shipmentLabels.id, labelId), eq(shipmentLabels.businessId, businessId)))
    .limit(1);

  const label = rows[0];
  if (label === undefined) {
    throw new LabelActionRefused('unknown_label', 'no such label in this business');
  }

  return label;
}
