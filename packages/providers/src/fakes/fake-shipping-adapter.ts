import type { ProviderFailure, ProviderResult } from '../outcomes';
import type {
  BuyLabelInput,
  Parcel,
  PurchasedLabel,
  RateQuote,
  RateRequest,
  ShipmentAddress,
  ShipmentDocument,
  ShipmentDocumentType,
  ShippingAdapter,
  ShippingCapabilities,
  ShippingProviderName,
  ShippingRate,
  TrackingReport,
  TrackingStatus,
  VoidLabelResult,
} from '../shipping';

/**
 * A programmable in-memory shipping provider.
 *
 * The failures worth testing here are the ones that cost money when they are
 * handled badly, and none of them can be produced against a real provider on
 * demand: a purchase that times out after the label was bought, a provider that
 * reprices between the quote and the click, a carrier that refuses a refund, a
 * rate that expired while somebody was reading it.
 *
 * As with the channel fake, there is no HTTP in this file. Verification V-04 has
 * not been run — nobody has yet confirmed EasyPost's or Easyship's current
 * authentication, rate, label, refund, tracking, quota, and commercial terms
 * against their official documentation — so no live shipping call exists
 * anywhere in this repository, and this fake is what the whole shipping suite
 * runs against.
 */

export interface FakeShippingAdapterOptions {
  readonly provider?: ShippingProviderName;
  readonly capabilities?: Partial<ShippingCapabilities>;
  /** Rates returned for every quote, in the order given. */
  readonly rates?: readonly ShippingRate[];
  /** How long a quoted rate is honoured. Absent means it carries no expiry. */
  readonly quoteLifetimeMs?: number;
  /** The clock. Supplied so freshness is testable without waiting. */
  readonly now?: () => Date;
  /**
   * What the provider actually charges, when that differs from the quote.
   *
   * The case section 30's US-13 exists to prevent: a person confirms one cost
   * and a different one is charged. The purchase is refused rather than
   * completed, and this is how that gets exercised.
   */
  readonly chargeInsteadOf?: ReadonlyMap<string, string>;
  /** Rate identifiers the provider will refuse to sell. */
  readonly unsellableRates?: ReadonlySet<string>;
  /** What a void request produces. Defaults to an immediate full refund. */
  readonly voidOutcome?: VoidLabelResult;
  /** Tracking events, in the order the carrier would report them. */
  readonly tracking?: TrackingReport;
  /**
   * Queued failures, returned one per call before any real behaviour.
   *
   * Drawn on by every method, so a test that wants the quote to succeed and the
   * purchase to fail uses `purchaseFailures` instead — which is most of them,
   * because the failures worth rehearsing here are the ones that happen after
   * the money is committed.
   */
  readonly failures?: readonly ProviderFailure[];
  /** Queued failures for `buyLabel` alone, consumed before the shared queue. */
  readonly purchaseFailures?: readonly ProviderFailure[];
}

/** A purchase this fake was asked to make. */
export interface RecordedPurchase {
  readonly providerShipmentId: string;
  readonly rateId: string;
  readonly idempotencyKey: string;
  readonly amount: string;
  readonly currency: string;
}

/** A quote this fake was asked for, kept so callers can assert on the parcel. */
export interface RecordedQuote {
  readonly from: ShipmentAddress;
  readonly to: ShipmentAddress;
  readonly parcel: Parcel;
  readonly providerShipmentId: string;
}

const DEFAULT_RATES: readonly ShippingRate[] = [
  {
    rateId: 'rate-standard',
    carrier: 'RoyalMail',
    service: 'Tracked48',
    amount: '3.95',
    currency: 'GBP',
    estimatedDays: 2,
  },
  {
    rateId: 'rate-express',
    carrier: 'RoyalMail',
    service: 'Tracked24',
    amount: '5.45',
    currency: 'GBP',
    estimatedDays: 1,
  },
];

export class FakeShippingAdapter implements ShippingAdapter {
  readonly capabilities: ShippingCapabilities;

  /** Every quote asked for, oldest first. */
  readonly quotes: RecordedQuote[] = [];
  /** Every purchase attempted, including the ones that were refused. */
  readonly purchases: RecordedPurchase[] = [];
  /** Every document access, so a test can assert nothing fetched twice by accident. */
  readonly documentReads: { providerLabelId: string; documentType: ShipmentDocumentType }[] = [];
  /** Void requests, in order. */
  readonly voids: string[] = [];

  private readonly options: FakeShippingAdapterOptions;
  private readonly failures: ProviderFailure[];
  private readonly purchaseFailures: ProviderFailure[];
  private readonly boughtByKey = new Map<string, PurchasedLabel>();
  private readonly labelsById = new Map<string, PurchasedLabel>();
  private readonly voidedLabels = new Set<string>();
  private counter = 0;

  constructor(options: FakeShippingAdapterOptions = {}) {
    this.options = options;
    this.failures = [...(options.failures ?? [])];
    this.purchaseFailures = [...(options.purchaseFailures ?? [])];
    this.capabilities = {
      provider: options.provider ?? 'easypost',
      supportsVoid: true,
      refundIsAsynchronous: false,
      supportsTracking: true,
      quotesExpire: options.quoteLifetimeMs !== undefined,
      documentTypes: ['label'],
      ...options.capabilities,
    };
  }

  /** Labels this fake has actually sold, keyed by provider label id. */
  get sold(): ReadonlyMap<string, PurchasedLabel> {
    return this.labelsById;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private nextFailure(): ProviderFailure | undefined {
    return this.failures.shift();
  }

  checkCredentials(): Promise<ProviderResult<{ readonly accountLabel: string }>> {
    const failure = this.nextFailure();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    return Promise.resolve({
      status: 'success',
      value: { accountLabel: `${this.capabilities.provider} account` },
    });
  }

  quoteRates(input: RateRequest): Promise<ProviderResult<RateQuote>> {
    const failure = this.nextFailure();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    const quotedAt = this.now();
    const providerShipmentId = `shp-${String((this.counter += 1))}`;
    this.quotes.push({
      from: input.from,
      to: input.to,
      parcel: input.parcel,
      providerShipmentId,
    });

    const lifetime = this.options.quoteLifetimeMs;
    const rates = (this.options.rates ?? DEFAULT_RATES).map((rate) => ({
      ...rate,
      ...(lifetime === undefined ? {} : { expiresAt: new Date(quotedAt.getTime() + lifetime) }),
    }));

    return Promise.resolve({ status: 'success', value: { providerShipmentId, rates, quotedAt } });
  }

  buyLabel(input: BuyLabelInput): Promise<ProviderResult<PurchasedLabel>> {
    const failure = this.purchaseFailures.shift() ?? this.nextFailure();
    if (failure !== undefined) {
      // Recorded even though it failed. The ambiguous-timeout case is exactly a
      // provider that took the money and did not say so, and a fake that forgot
      // the attempt could not reproduce it.
      this.purchases.push({
        providerShipmentId: input.providerShipmentId,
        rateId: input.rateId,
        idempotencyKey: input.idempotencyKey,
        amount: input.confirmedAmount,
        currency: input.confirmedCurrency,
      });
      return Promise.resolve(failure);
    }

    this.purchases.push({
      providerShipmentId: input.providerShipmentId,
      rateId: input.rateId,
      idempotencyKey: input.idempotencyKey,
      amount: input.confirmedAmount,
      currency: input.confirmedCurrency,
    });

    // The whole point of the key: the same request twice buys one label.
    const existing = this.boughtByKey.get(input.idempotencyKey);
    if (existing !== undefined) {
      return Promise.resolve({ status: 'success', value: { ...existing, replayed: true } });
    }

    if (this.options.unsellableRates?.has(input.rateId) === true) {
      return Promise.resolve({
        status: 'rejected',
        message: 'that rate is no longer available',
        code: 'RATE_GONE',
      });
    }

    const rate = (this.options.rates ?? DEFAULT_RATES).find(
      (candidate) => candidate.rateId === input.rateId,
    );
    if (rate === undefined) {
      return Promise.resolve({ status: 'not_found', message: 'no such rate on that shipment' });
    }

    const charged = this.options.chargeInsteadOf?.get(input.rateId) ?? rate.amount;

    const label: PurchasedLabel = {
      providerLabelId: `lbl-${String((this.counter += 1))}`,
      providerShipmentId: input.providerShipmentId,
      carrier: rate.carrier,
      service: rate.service,
      trackingNumber: `TRK${String(this.counter).padStart(9, '0')}`,
      amount: charged,
      currency: rate.currency,
      purchasedAt: this.now(),
      replayed: false,
      documentTypes: this.capabilities.documentTypes,
    };

    this.boughtByKey.set(input.idempotencyKey, label);
    this.labelsById.set(label.providerLabelId, label);

    return Promise.resolve({ status: 'success', value: label });
  }

  voidLabel(input: {
    readonly providerLabelId: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderResult<VoidLabelResult>> {
    const failure = this.nextFailure();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    this.voids.push(input.providerLabelId);

    const label = this.labelsById.get(input.providerLabelId);
    if (label === undefined) {
      return Promise.resolve({ status: 'not_found', message: 'no such label' });
    }

    if (this.voidedLabels.has(input.providerLabelId)) {
      // Voiding twice is not an error at a provider that already voided it, and
      // treating it as one would turn a safe retry into a failed operation.
      return Promise.resolve({
        status: 'success',
        value: this.options.voidOutcome ?? {
          outcome: 'refunded',
          refundAmount: label.amount,
          refundCurrency: label.currency,
        },
      });
    }

    this.voidedLabels.add(input.providerLabelId);

    return Promise.resolve({
      status: 'success',
      value: this.options.voidOutcome ?? {
        outcome: 'refunded',
        refundAmount: label.amount,
        refundCurrency: label.currency,
      },
    });
  }

  fetchDocument(input: {
    readonly providerLabelId: string;
    readonly documentType: ShipmentDocumentType;
  }): Promise<ProviderResult<ShipmentDocument>> {
    const failure = this.nextFailure();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    this.documentReads.push({ ...input });

    const label = this.labelsById.get(input.providerLabelId);
    if (label === undefined) {
      return Promise.resolve({ status: 'not_found', message: 'no such label' });
    }

    if (!this.capabilities.documentTypes.includes(input.documentType)) {
      return Promise.resolve({
        status: 'rejected',
        message: 'this provider does not produce that document',
      });
    }

    return Promise.resolve({
      status: 'success',
      value: {
        documentType: input.documentType,
        contentType: 'application/pdf',
        // Enough of a PDF to be recognisable, and nothing that looks like an
        // address: a fixture nobody should be tempted to treat as real output.
        bytes: new TextEncoder().encode(`%PDF-1.4 fake ${input.documentType}\n`),
        filename: `${input.documentType}-${label.trackingNumber}.pdf`,
      },
    });
  }

  trackShipment(input: {
    readonly providerLabelId: string;
  }): Promise<ProviderResult<TrackingReport>> {
    const failure = this.nextFailure();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    const label = this.labelsById.get(input.providerLabelId);
    if (label === undefined) {
      return Promise.resolve({ status: 'not_found', message: 'no such label' });
    }

    const configured = this.options.tracking;
    if (configured !== undefined) {
      return Promise.resolve({ status: 'success', value: configured });
    }

    const status: TrackingStatus = 'pre_transit';

    return Promise.resolve({
      status: 'success',
      value: {
        trackingNumber: label.trackingNumber,
        carrier: label.carrier,
        status,
        events: [
          {
            eventId: `${label.providerLabelId}-1`,
            status,
            occurredAt: label.purchasedAt,
            description: 'Label created',
          },
        ],
      },
    });
  }
}
