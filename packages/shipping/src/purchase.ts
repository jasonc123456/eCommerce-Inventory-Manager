import type { AuditRecorder } from '@eim/audit';
import {
  shipmentLabels,
  shipmentPackages,
  shipmentRateQuotes,
  type Database,
  type ShipmentLabel,
} from '@eim/db';
import {
  describeFailure,
  isSuccess,
  type ShipmentAddress,
  type ShippingAdapter,
  type ShippingRate,
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

import { rateFrom, usableUntil } from './rate-selection';

/**
 * Buying one label, for one cost, that one person agreed to (sections 21, 30).
 *
 * The only operation in this application that spends a business's money at a
 * third party, and every part of it is arranged around that. Section 21 requires
 * "purchase label after cost confirmation" and lists label purchase among the
 * actions that must "show old/new values, scope, warnings, costs/fees, and
 * affected entities before reconfirmation". Section 30's US-13 adds the rest:
 * "quote expiry/cost is shown, purchase is confirmed and idempotent, label
 * access is permissioned, and failures are recoverable".
 *
 * Four things follow, and none of them is optional.
 *
 * The confirmation is against a fingerprint of the cost, carrier, service, and
 * destination. If the quote is re-run, or the address changes, or somebody picks
 * a different service in another tab, the fingerprints disagree and the
 * confirmation is refused rather than applied to a purchase nobody approved.
 *
 * The confirmed cost travels to the provider, which refuses to sell at a
 * different price. A rate identifier alone would be enough at a well-behaved
 * provider; carrying the amount is what catches one that reprices a surcharge
 * between the quote and the click.
 *
 * The idempotency key is the operation's, so a retry after an ambiguous timeout
 * asks for the same label rather than a second one. The provider says whether it
 * replayed; either way one row is written.
 *
 * And a purchase that fails leaves the operation failed with a reason rather
 * than silently unfinished, because the recoverable half of US-13 is somebody
 * being able to see what happened and start again.
 */

export interface ProposeLabelPurchaseInput {
  readonly businessId: string;
  readonly packageId: string;
  readonly quoteId: string;
  /** Exactly the rate the person is looking at. */
  readonly rateId: string;
  /** The destination, as it was read from the channel for the quote. */
  readonly to: ShipmentAddress;
  readonly actorUserId: string;
  readonly now?: Date;
}

export interface ProposedLabelPurchase extends ProposedOperation {
  readonly rate: ShippingRate;
  /** The moment after which this quote is no longer worth confirming. */
  readonly usableUntil: Date;
}

export class LabelPurchaseRefused extends Error {
  readonly reason: LabelPurchaseRefusalReason;

  constructor(reason: LabelPurchaseRefusalReason, message: string) {
    super(message);
    this.name = 'LabelPurchaseRefused';
    this.reason = reason;
  }
}

export type LabelPurchaseRefusalReason =
  | 'unknown_package'
  | 'unknown_quote'
  | 'unknown_rate'
  | 'quote_expired'
  | 'already_labelled'
  | 'cost_changed'
  | 'provider_refused';

/**
 * Proposes a purchase, and returns the fingerprint the confirmer must send back.
 *
 * Nothing is bought here and nothing can be. The proposal records what would be
 * bought, from which quote, at what cost, to which address — and the reviewed
 * operation's own machinery does the rest: one live proposal per package, a
 * permission that cannot be scoped away, a step-up requirement, and a source
 * freshness window measured from when the provider actually quoted.
 */
export async function proposeLabelPurchase(
  db: Database,
  audit: AuditRecorder,
  input: ProposeLabelPurchaseInput,
): Promise<ProposedLabelPurchase> {
  const now = input.now ?? new Date();

  const parcel = await loadOpenPackage(db, input.businessId, input.packageId);

  const quotes = await db
    .select()
    .from(shipmentRateQuotes)
    .where(
      and(
        eq(shipmentRateQuotes.id, input.quoteId),
        eq(shipmentRateQuotes.businessId, input.businessId),
        eq(shipmentRateQuotes.packageId, input.packageId),
      ),
    )
    .limit(1);

  const quote = quotes[0];
  if (quote === undefined) {
    throw new LabelPurchaseRefused('unknown_quote', 'no such quote for this package');
  }

  const rate = rateFrom(quote, input.rateId);
  if (rate === null) {
    throw new LabelPurchaseRefused('unknown_rate', 'that rate is not part of this quote');
  }

  const deadline = usableUntil(quote.quotedAt, quote.providerExpiresAt);
  if (now.getTime() >= deadline.getTime()) {
    // Refused at proposal time as well as at confirmation. Showing somebody a
    // price that cannot be bought, and only telling them once they have agreed
    // to it, teaches them that the confirmation step means nothing.
    throw new LabelPurchaseRefused(
      'quote_expired',
      'this quote is no longer being honoured; price the parcel again',
    );
  }

  const decisive: FingerprintValue = {
    packageId: input.packageId,
    quoteId: input.quoteId,
    rateId: rate.rateId,
    carrier: rate.carrier,
    service: rate.service,
    amount: rate.amount,
    currency: rate.currency,
    // The address is part of what is being agreed to. A parcel sent to the
    // right person at the wrong address is not a smaller mistake than one sent
    // to the wrong person.
    to: {
      name: input.to.name,
      line1: input.to.line1,
      line2: input.to.line2 ?? null,
      city: input.to.city,
      region: input.to.region ?? null,
      postcode: input.to.postcode,
      country: input.to.country,
    },
  };

  const proposal = await proposeOperation(db, {
    businessId: input.businessId,
    kind: 'label_purchase',
    subjectKey: `package:${input.packageId}`,
    requiredPermission: 'purchase_labels',
    preview: {
      packageId: input.packageId,
      orderId: parcel.orderId,
      quoteId: input.quoteId,
      chosen: { ...rate },
      alternatives: (quote.rates as readonly ShippingRate[]).filter(
        (candidate) => candidate.rateId !== rate.rateId,
      ),
      to: { ...input.to },
      weightGrams: parcel.weightGrams,
      usableUntil: deadline.toISOString(),
    },
    decisive,
    // The provider's quote is the source read, so freshness runs from when the
    // carrier priced the parcel rather than from when this proposal was made.
    sourceObservedAt: quote.quotedAt,
    proposedByUserId: input.actorUserId,
    idempotencyKey: `label:${input.packageId}:${String(now.getTime())}`,
    now,
  });

  await audit.record(db, {
    action: 'review.operation.proposed',
    result: 'success',
    businessId: input.businessId,
    targetType: 'reviewed_operation',
    targetId: proposal.operationId,
    detail: {
      kind: 'label_purchase',
      packageId: input.packageId,
      carrier: rate.carrier,
      service: rate.service,
      amount: rate.amount,
      currency: rate.currency,
    },
  });

  return { ...proposal, rate, usableUntil: deadline };
}

export interface ExecuteLabelPurchaseInput {
  readonly businessId: string;
  readonly operationId: string;
  readonly accountId: string;
  readonly adapter: ShippingAdapter;
  readonly now?: Date;
}

/**
 * Buys the label a confirmation authorized.
 *
 * Runs only against a confirmed operation, which is what makes the permission,
 * the step-up, the freshness window, and the fingerprint check all already true
 * by the time anything reaches a provider.
 */
export async function executeLabelPurchase(
  db: Database,
  audit: AuditRecorder,
  input: ExecuteLabelPurchaseInput,
): Promise<ShipmentLabel> {
  const now = input.now ?? new Date();

  const operation = await beginExecution(db, {
    businessId: input.businessId,
    operationId: input.operationId,
  });

  if (operation === null) {
    throw new LabelPurchaseRefused(
      'unknown_package',
      'this purchase is not in a state that may be carried out',
    );
  }

  const preview = operation.preview as {
    packageId: string;
    quoteId: string;
    chosen: ShippingRate;
  };

  const quotes = await db
    .select()
    .from(shipmentRateQuotes)
    .where(
      and(
        eq(shipmentRateQuotes.id, preview.quoteId),
        eq(shipmentRateQuotes.businessId, input.businessId),
      ),
    )
    .limit(1);

  const quote = quotes[0];
  if (quote === undefined) {
    await failExecution(db, {
      businessId: input.businessId,
      operationId: input.operationId,
      summary: 'the quote behind this purchase is gone',
    });
    throw new LabelPurchaseRefused('unknown_quote', 'the quote behind this purchase is gone');
  }

  const bought = await input.adapter.buyLabel({
    providerShipmentId: quote.providerShipmentId,
    rateId: preview.chosen.rateId,
    confirmedAmount: preview.chosen.amount,
    confirmedCurrency: preview.chosen.currency,
    // The operation's key, so a retry after an ambiguous timeout asks the
    // provider for the same label rather than a second one.
    idempotencyKey: operation.idempotencyKey,
  });

  if (!isSuccess(bought)) {
    const summary = describeFailure(bought);
    await failExecution(db, {
      businessId: input.businessId,
      operationId: input.operationId,
      summary,
    });

    await audit.record(db, {
      action: 'shipping.label.purchased',
      result: 'failure',
      businessId: input.businessId,
      targetType: 'shipment_package',
      targetId: preview.packageId,
      detail: { summary, carrier: preview.chosen.carrier, service: preview.chosen.service },
    });

    throw new LabelPurchaseRefused('provider_refused', `the label was not bought: ${summary}`);
  }

  const label = bought.value;

  // The check that section 30's US-13 is really about. A provider that charged
  // something other than what was confirmed has sold something nobody agreed
  // to, and the honest response is to refuse the record and say so — the label
  // exists and has been paid for, so the operation fails loudly rather than
  // filing a purchase at a price that was never shown to anybody.
  if (label.amount !== preview.chosen.amount || label.currency !== preview.chosen.currency) {
    const summary = `the provider charged ${label.amount} ${label.currency} for a label confirmed at ${preview.chosen.amount} ${preview.chosen.currency}`;

    await failExecution(db, {
      businessId: input.businessId,
      operationId: input.operationId,
      summary,
      outcome: { providerLabelId: label.providerLabelId, charged: label.amount },
    });

    await audit.record(db, {
      action: 'shipping.label.purchased',
      result: 'failure',
      businessId: input.businessId,
      targetType: 'shipment_package',
      targetId: preview.packageId,
      detail: { summary, providerLabelId: label.providerLabelId },
    });

    throw new LabelPurchaseRefused('cost_changed', summary);
  }

  const stored = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(shipmentLabels)
      .values({
        businessId: input.businessId,
        packageId: preview.packageId,
        accountId: input.accountId,
        quoteId: quote.id,
        operationId: operation.id,
        providerLabelId: label.providerLabelId,
        providerShipmentId: label.providerShipmentId,
        rateId: preview.chosen.rateId,
        carrier: label.carrier,
        service: label.service,
        trackingNumber: label.trackingNumber,
        amount: label.amount,
        currency: label.currency,
        purchasedAt: label.purchasedAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    // Labelled, not shipped. Section 14: "label purchase does not mean
    // shipped", and a package that skipped straight to shipped would tell a
    // customer their parcel had gone while it was still on the bench.
    await tx
      .update(shipmentPackages)
      .set({ status: 'labelled', updatedAt: now })
      .where(
        and(
          eq(shipmentPackages.id, preview.packageId),
          eq(shipmentPackages.businessId, input.businessId),
        ),
      );

    return inserted[0];
  });

  if (stored === undefined) {
    await failExecution(db, {
      businessId: input.businessId,
      operationId: input.operationId,
      summary: 'the label was bought but could not be recorded',
    });
    throw new LabelPurchaseRefused(
      'provider_refused',
      'the label was bought but could not be recorded',
    );
  }

  await completeExecution(db, {
    businessId: input.businessId,
    operationId: input.operationId,
    outcome: {
      providerLabelId: label.providerLabelId,
      trackingNumber: label.trackingNumber,
      amount: label.amount,
      currency: label.currency,
      replayed: label.replayed,
    },
    now,
  });

  await audit.record(db, {
    action: 'shipping.label.purchased',
    result: 'success',
    businessId: input.businessId,
    targetType: 'shipment_label',
    targetId: stored.id,
    detail: {
      packageId: preview.packageId,
      carrier: label.carrier,
      service: label.service,
      amount: label.amount,
      currency: label.currency,
      trackingNumber: label.trackingNumber,
      // Recorded because it is the difference between "we bought a label" and
      // "we asked again and the provider gave us the one we already had".
      replayed: label.replayed,
    },
  });

  return stored;
}

async function loadOpenPackage(db: Database, businessId: string, packageId: string) {
  const rows = await db
    .select()
    .from(shipmentPackages)
    .where(and(eq(shipmentPackages.id, packageId), eq(shipmentPackages.businessId, businessId)))
    .limit(1);

  const parcel = rows[0];
  if (parcel === undefined) {
    throw new LabelPurchaseRefused('unknown_package', 'no such package in this business');
  }

  if (parcel.status !== 'draft') {
    throw new LabelPurchaseRefused(
      'already_labelled',
      `this package is ${parcel.status}; it does not need another label`,
    );
  }

  return parcel;
}
