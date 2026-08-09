import type { ProviderResult } from './outcomes';

/**
 * The shipping adapter contract (sections 2, 21, 34).
 *
 * EasyPost and Easyship sit outside the channel adapter deliberately. A channel
 * carries inventory: it has listings, orders, and quantities, and everything in
 * `ChannelAdapter` exists to keep one number true in two places. A shipping
 * provider has none of that. It sells postage. Modelling it as a channel would
 * mean an adapter that answers "no" to every question the synchronization
 * pipeline asks, which is a different thing from an adapter that is never asked.
 *
 * Three properties shape this interface, and each of them is a rule from the
 * specification rather than a convenience:
 *
 *   Quoting and buying are different calls, and only one of them spends money.
 *   Section 21 requires "purchase label after cost confirmation" and section 30's
 *   US-13 that "quote expiry/cost is shown". So a rate is a value with a price
 *   and a deadline on it, and buying names the rate that was shown rather than
 *   re-deriving one at purchase time — which would buy whatever the cheapest
 *   option happened to be by then.
 *
 *   Buying is idempotent because a duplicate label is a duplicate charge. The
 *   key is required, not optional. Nothing else in this application spends a
 *   business's money at a third party, and an ambiguous timeout on the one thing
 *   that does must be safe to retry.
 *
 *   A label is fetched, never held. `fetchDocument` returns bytes for one
 *   authorized access and the application does not keep them: a label carries
 *   the buyer's name and address printed on it, and section 13 is built around
 *   not copying buyer detail out of the provider in the first place (D-233).
 */

export type ShippingProviderName = 'easypost' | 'easyship';

/**
 * What one shipping provider will actually do.
 *
 * Void is the interesting one. Carriers differ on whether an unused label can be
 * refunded at all, and on whether the answer arrives with the request or days
 * later after the carrier has confirmed the label went unscanned. Section 2 says
 * "supported void/refund actions" and section 34 "refund/void where supported" —
 * both of which mean the application has to know, before offering a button, that
 * this provider can honour it.
 */
export interface ShippingCapabilities {
  readonly provider: ShippingProviderName;
  /** Whether a purchased label can be voided or refunded at all. */
  readonly supportsVoid: boolean;
  /**
   * Whether the refund verdict arrives later than the request.
   *
   * When true, a void request is recorded as requested rather than done, and the
   * screen says so. Reporting a refund that the carrier has not agreed to is a
   * number in somebody's accounts that never arrives.
   */
  readonly refundIsAsynchronous: boolean;
  /** Whether tracking events can be read back for a purchased label. */
  readonly supportsTracking: boolean;
  /**
   * Whether rates carry a provider-declared expiry.
   *
   * When false, the application applies its own review window and nothing else;
   * when true, the provider's deadline is honoured as well, and the earlier of
   * the two wins.
   */
  readonly quotesExpire: boolean;
  readonly documentTypes: readonly ShipmentDocumentType[];
}

/**
 * A postal address complete enough to buy a label from.
 *
 * Deliberately not `PostalContact`, whose fields are all optional because it
 * describes what a channel happened to give us. A carrier cannot ship from
 * "somewhere in Britain", and section 9 already says a location's address is
 * "optional for inventory but required for label purchase from that location".
 * Requiring the fields in the type is what makes that rule checkable before a
 * screen offers to buy anything.
 */
export interface ShipmentAddress {
  readonly name: string;
  readonly company?: string;
  readonly line1: string;
  readonly line2?: string;
  readonly city: string;
  /** State, province, or county. Absent where the country has none. */
  readonly region?: string;
  readonly postcode: string;
  /** ISO 3166-1 alpha-2, upper case. */
  readonly country: string;
  readonly phone?: string;
  readonly email?: string;
}

/**
 * The physical thing being sent.
 *
 * Grams and whole centimetres, never a float and never the provider's units.
 * Carriers price in ounces or pounds and inches or centimetres depending on the
 * account, and an application that stored whatever the last provider wanted
 * would eventually compare two weights that were not in the same unit. The
 * adapter converts; the application does not.
 */
export interface Parcel {
  readonly weightGrams: number;
  readonly lengthMm?: number;
  readonly widthMm?: number;
  readonly heightMm?: number;
}

export interface RateRequest {
  readonly from: ShipmentAddress;
  readonly to: ShipmentAddress;
  readonly parcel: Parcel;
  /**
   * The declared value of the contents, for carriers that price insurance from
   * it. Decimal string, as everything monetary in this application is.
   */
  readonly declaredValueAmount?: string;
  readonly declaredValueCurrency?: string;
}

/** One carrier service, at one price, for this parcel between these addresses. */
export interface ShippingRate {
  /** The provider's identifier for this rate. Quoted back to buy it. */
  readonly rateId: string;
  readonly carrier: string;
  readonly service: string;
  /** Decimal string. A postage cost that has been through a float is not one. */
  readonly amount: string;
  readonly currency: string;
  /** Business days in transit, when the provider estimates one. */
  readonly estimatedDays?: number;
  /** When the provider says this rate stops being honoured, if it says. */
  readonly expiresAt?: Date;
}

export interface RateQuote {
  /**
   * The provider-side shipment these rates belong to.
   *
   * Rates are not free-standing: both providers create a shipment, price it, and
   * then sell one of its rates. Carrying the identifier means the purchase asks
   * for a rate that was quoted for this exact parcel and these exact addresses,
   * rather than a number that happened to match.
   */
  readonly providerShipmentId: string;
  readonly rates: readonly ShippingRate[];
  /** When the provider produced these. The freshness clock starts here. */
  readonly quotedAt: Date;
}

export interface BuyLabelInput {
  readonly providerShipmentId: string;
  /** Exactly the rate a person was shown and agreed to. */
  readonly rateId: string;
  /**
   * The cost that was confirmed, so the adapter can refuse a purchase the
   * provider has since repriced.
   *
   * Belt as well as braces: the rate identifier should already pin the price,
   * and this is what catches a provider that reuses identifiers or silently
   * adjusts a surcharge. Section 30's US-13 requires the purchase to be for the
   * cost that was shown, and this is where that stops being a hope.
   */
  readonly confirmedAmount: string;
  readonly confirmedCurrency: string;
  /** Required. A duplicate label is a duplicate charge. */
  readonly idempotencyKey: string;
}

export interface PurchasedLabel {
  readonly providerLabelId: string;
  readonly providerShipmentId: string;
  readonly carrier: string;
  readonly service: string;
  readonly trackingNumber: string;
  /** What was actually charged, which is checked against what was confirmed. */
  readonly amount: string;
  readonly currency: string;
  readonly purchasedAt: Date;
  /**
   * Whether the provider returned an existing label for this idempotency key
   * rather than buying another. A retry after an ambiguous timeout is expected
   * to land here, and the caller records the same label instead of a second one.
   */
  readonly replayed: boolean;
  readonly documentTypes: readonly ShipmentDocumentType[];
}

export type ShipmentDocumentType = 'label' | 'return_label' | 'commercial_invoice';

/**
 * A document, in memory, for one authorized access.
 *
 * Returned rather than stored, and the reason is worth stating where somebody
 * will read it before changing this. A shipping label has the buyer's name and
 * postal address printed on it. Section 13 requires the application to erase a
 * buyer's data on request across every business holding it, and section 11's
 * order model already avoids the problem by never copying buyer detail out of
 * the provider at all — `buyerReference` is a pseudonymous handle for exactly
 * this reason.
 *
 * Persisting label images would undo that in the one place it matters most, and
 * would do it in a format nobody can redact. So the bytes are fetched from the
 * provider, with the business's own credentials, at the moment an authorized
 * person asks for them, and are gone when the response ends.
 */
export interface ShipmentDocument {
  readonly documentType: ShipmentDocumentType;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  /** A filename with no buyer detail in it. Shown in the download dialog. */
  readonly filename: string;
}

export type VoidOutcome = 'refunded' | 'requested' | 'refused';

export interface VoidLabelResult {
  readonly outcome: VoidOutcome;
  /** What the carrier agreed to return, when it has agreed to anything. */
  readonly refundAmount?: string;
  readonly refundCurrency?: string;
  /** The provider's own explanation, for a refusal or a pending request. */
  readonly detail?: string;
}

/** One thing a carrier says happened to a parcel. */
export interface TrackingEvent {
  /** The provider's identifier for this event, so it is stored once. */
  readonly eventId: string;
  readonly status: TrackingStatus;
  readonly occurredAt: Date;
  readonly description?: string;
  /** City and country at most. Never a street address. */
  readonly location?: string;
}

export type TrackingStatus =
  | 'pre_transit'
  | 'in_transit'
  | 'out_for_delivery'
  | 'delivered'
  | 'available_for_pickup'
  | 'return_to_sender'
  | 'failure'
  | 'unknown';

export interface TrackingReport {
  readonly trackingNumber: string;
  readonly carrier: string;
  readonly status: TrackingStatus;
  readonly events: readonly TrackingEvent[];
  readonly deliveredAt?: Date;
  readonly trackingUrl?: string;
}

/**
 * One business's account with one shipping provider.
 *
 * A factory, like `ChannelAdapterFactory`, because the API key is decrypted per
 * use rather than held. Section 19 keeps every provider credential encrypted at
 * rest and out of the application's long-lived state, and an adapter cached
 * across units of work is a decrypted key held for as long as the process runs.
 */
export interface ShippingAdapter {
  readonly capabilities: ShippingCapabilities;

  /** Whether the stored key still works, without buying anything. */
  checkCredentials(): Promise<ProviderResult<{ readonly accountLabel: string }>>;

  /** Prices this parcel between these addresses. Never spends anything. */
  quoteRates(input: RateRequest): Promise<ProviderResult<RateQuote>>;

  /** Buys one quoted rate. The only call here that costs money. */
  buyLabel(input: BuyLabelInput): Promise<ProviderResult<PurchasedLabel>>;

  /**
   * Asks for a purchased label to be voided or refunded.
   *
   * Absent when `supportsVoid` is false, so there is no code path that calls a
   * method the provider has no equivalent for — the same reasoning as the
   * optional listing operations on the channel adapter.
   */
  voidLabel?(input: {
    readonly providerLabelId: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderResult<VoidLabelResult>>;

  /** Fetches a document for one authorized access. Nothing caches the result. */
  fetchDocument(input: {
    readonly providerLabelId: string;
    readonly documentType: ShipmentDocumentType;
  }): Promise<ProviderResult<ShipmentDocument>>;

  /** Reads what the carrier says has happened so far. */
  trackShipment?(input: {
    readonly providerLabelId: string;
  }): Promise<ProviderResult<TrackingReport>>;
}

export type ShippingAdapterFactory = (accountId: string) => Promise<ShippingAdapter>;
