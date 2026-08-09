import type { ProviderName, ProviderResult } from './outcomes';

/**
 * The channel adapter contract (section 34).
 *
 * An adapter translates between one provider's vocabulary and this
 * application's, and does nothing else. It does not decide how much stock to
 * advertise, when to retry, or whether a discrepancy matters — those belong to
 * the domain and the scheduler, which is what keeps the inventory rules
 * testable without a network and identical across providers.
 *
 * Two consequences worth stating plainly, because they are what the interface
 * is shaped around:
 *
 *   Quantity writes are absolute, never deltas. A delta applied twice is an
 *   oversell; an absolute quantity applied twice is the same quantity. Section
 *   8 makes this the rule for every channel.
 *
 *   Reads report what the provider actually says, including when that
 *   contradicts what was last written. Adapters never quietly correct a
 *   surprising reading; a discrepancy is evidence for reconciliation, and one
 *   that is smoothed over here is a drift nobody can detect later.
 */

/** What one provider supports, so the application can degrade knowingly. */
export interface AdapterCapabilities {
  readonly provider: ProviderName;
  /** Whether the provider can push change notifications to us. */
  readonly supportsWebhooks: boolean;
  /** Whether a webhook payload can be cryptographically verified. */
  readonly supportsWebhookSignatures: boolean;
  /** Whether writes can be conditioned on a version the caller last observed. */
  readonly supportsOptimisticConcurrency: boolean;
  /** Whether the provider accepts more than one quantity update per call. */
  readonly supportsBatchQuantityWrites: boolean;
  /** Largest batch accepted, when batching is supported. */
  readonly maxBatchSize?: number;
  /**
   * Whether the provider models stock per location. eBay does not; WooCommerce
   * does not natively. Where it is absent, the application projects its own
   * multi-location total into a single number, which is why section 9 has to
   * decide the aggregation rather than delegate it.
   */
  readonly supportsPerLocationStock: boolean;
}

/** An addressable thing on a channel that can carry a quantity. */
export interface ChannelEntityRef {
  /** The provider's own identifier. Unique within a connection, not globally. */
  readonly externalId: string;
  /**
   * Set for a variation, absent for a simple product or a listing with none.
   * Section 6 as amended by D-131: a WooCommerce variable product managing
   * stock at the parent level is not inventory eligible, so a mapping always
   * addresses the level that actually holds the number.
   */
  readonly variationId?: string;
}

/** A quantity observed on the channel, with whatever the provider will tell us. */
export interface QuantityObservation {
  readonly entity: ChannelEntityRef;
  /**
   * The quantity the provider reports. May be negative where the provider uses
   * negative stock to record backorder demand, which section 8 as amended by
   * D-130 requires be preserved rather than overwritten with zero.
   */
  readonly quantity: number;
  /** Opaque version token for a later conditional write, when supported. */
  readonly version?: string;
  /** When the provider says this was true, if it says. */
  readonly observedAt?: Date;
  /**
   * Whether the channel allows sales past zero. Feeds the write-suppression
   * rule in `@eim/domain`.
   */
  readonly backordersEnabled?: boolean;
}

export interface QuantityWrite {
  readonly entity: ChannelEntityRef;
  /** Absolute, never a delta. Always zero or more. */
  readonly quantity: number;
  /**
   * The version this quantity was computed against. When the adapter reports
   * `supportsOptimisticConcurrency`, supplying it turns a lost update into a
   * `conflict` outcome instead of a silent overwrite.
   */
  readonly expectedVersion?: string;
  /**
   * Idempotency key for the write. Section 12 requires that a retry after an
   * ambiguous timeout cannot apply the same change twice.
   */
  readonly idempotencyKey: string;
}

export interface WriteAcknowledgement {
  readonly entity: ChannelEntityRef;
  /** The version now current, when the provider returns one. */
  readonly version?: string;
  /**
   * True when the provider reported no change was needed. Section 15 uses this
   * to avoid counting a no-op as a successful correction.
   */
  readonly unchanged: boolean;
}

/** One page of a listing enumeration. */
export interface Page<T> {
  readonly items: readonly T[];
  /** Opaque cursor for the next page, absent on the last one. */
  readonly nextCursor?: string;
}

/**
 * A webhook as received, before any trust has been established.
 *
 * Deliberately raw. Verification needs the exact bytes, because any parse and
 * re-serialize step changes them and invalidates the signature.
 */
export interface InboundWebhook {
  readonly rawBody: Uint8Array;
  readonly headers: Readonly<Record<string, string>>;
}

export interface VerifiedWebhook {
  /** Stable provider event identifier, used for the idempotency record. */
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt?: Date;
  /** Entities this event says something about, for targeted re-reads. */
  readonly affects: readonly ChannelEntityRef[];
}

/**
 * What an order means for inventory, in this application's vocabulary.
 *
 * The adapter decides this, not the pipeline. Only the adapter knows that
 * WooCommerce's `processing` commits demand while `pending` does not, or which
 * of eBay's fulfilment states count as shipped — and putting that knowledge
 * behind the boundary is the entire reason the boundary exists.
 *
 *   awaiting   nothing is committed: a cart, an unpaid order
 *   committed  a qualifying order; mapped lines reserve or consume
 *   fulfilled  shipped or otherwise handed over
 *   cancelled  ended before shipment
 *   refunded   money returned, which says nothing about the goods (section 11)
 */
export type OrderDemandState = 'awaiting' | 'committed' | 'fulfilled' | 'cancelled' | 'refunded';

export interface ProviderOrderLine {
  readonly externalLineId: string;
  /** The channel entity sold, as the provider names it. */
  readonly externalItemId: string;
  readonly variationId?: string;
  readonly sku?: string;
  readonly title?: string;
  readonly quantity: number;
  readonly cancelledQuantity?: number;
  readonly shippedQuantity?: number;
  readonly refundedQuantity?: number;
}

export interface ProviderOrder {
  readonly externalOrderId: string;
  /** The provider's own word for the state, kept verbatim for the timeline. */
  readonly providerStatus?: string;
  readonly demandState: OrderDemandState;
  readonly placedAt?: Date;
  readonly providerRevision?: string;
  /**
   * Monotonic per order where the provider supplies one. Section 12 gives this
   * precedence over arrival order, so an adapter that can supply it should.
   */
  readonly providerSequence?: number;
  readonly currency?: string;
  readonly totalAmount?: string;
  /**
   * A pseudonymous handle for the buyer. Never a name, an address, or an email:
   * section 13's erasure obligations are much simpler when buyer detail was
   * never copied out of the provider in the first place.
   */
  readonly buyerReference?: string;
  readonly lines: readonly ProviderOrderLine[];
}

/** Enough to go and fetch an order that has changed. */
export interface ProviderOrderRef {
  readonly externalOrderId: string;
  readonly updatedAt?: Date;
}

/**
 * Operations a person confirms, one at a time (sections 3, 11, 13, 14, 30).
 *
 * Kept off `ChannelAdapter` and behind an optional accessor, because these are
 * the operations a channel might not offer at all and the application has to
 * degrade knowingly rather than discover it at the moment somebody clicks. An
 * adapter that cannot create drafts does not implement `createDraft`, the screen
 * does not offer the button, and there is no code path that calls a method that
 * is not there.
 *
 * Every method takes an idempotency key, and it is required rather than
 * optional. These operations create listings, change prices, and place orders:
 * the cost of applying one twice is not a wasted call but a duplicate listing, a
 * price applied to a price, or a customer's order entered into a shop twice.
 */
export interface ListingOperations {
  /**
   * Creates an unpublished draft on this channel.
   *
   * Never publishes, whatever the fields say. Section 30's US-11 requires that
   * "publication is impossible from the draft action", and the adapter is where
   * that has to be true — a projection that omits a publish flag is only a
   * convention until the thing making the HTTP call refuses to send one.
   */
  createDraft?(input: CreateDraftInput): Promise<ProviderResult<DraftRef>>;

  /**
   * What publishing would cost and what would stop it.
   *
   * Section 13 requires "expected fees, warnings, and separate confirmation"
   * before a draft becomes a listing, and section 30's AC-10 makes fee impact
   * part of the confirmation rather than a footnote beside it. Read-only: asking
   * what something costs must never be what buys it.
   */
  previewPublication?(input: PreviewPublicationInput): Promise<ProviderResult<PublicationPreview>>;

  /** Publishes a draft that a person has separately confirmed. */
  publishDraft?(input: PublishDraftInput): Promise<ProviderResult<PublishedListing>>;

  /**
   * Reads what this channel is currently charging.
   *
   * Sections 13 and 14 both say the same thing about prices: they are "observed
   * channel values, not canonical inventory state". Nothing in the automatic
   * synchronization path reads this, and nothing writes a price without a
   * person having confirmed that specific number.
   */
  readPrice?(entity: ChannelEntityRef): Promise<ProviderResult<PriceObservation>>;

  /**
   * What a price change would cost, and what would stop it.
   *
   * Separate from the publication preview because the fees differ: a final value
   * fee scales with the price, so changing one changes what the next sale costs.
   * Section 30's AC-10 requires fee impact at the moment of confirmation, and a
   * price change has one even though nothing is being listed.
   */
  previewPriceChange?(input: PriceWrite): Promise<ProviderResult<PriceChangePreview>>;

  /** Writes one confirmed price. Never called except from a confirmation. */
  writePrice?(input: PriceWrite): Promise<ProviderResult<PriceAcknowledgement>>;

  /**
   * Whether a listing is live, hidden at zero, or over.
   *
   * The distinction is the whole of section 6's restock rule. A listing hidden
   * by eBay's out-of-stock control is still a listing and can be returned to
   * sale; an ended one is not, and bringing it back is a relisting decision with
   * its own fees and its own duration. Nothing but the provider can tell the two
   * apart, so nothing but the adapter is asked.
   */
  readListingState?(entity: ChannelEntityRef): Promise<ProviderResult<ListingState>>;

  /**
   * Returns an eligible out-of-stock listing to sale at a confirmed quantity.
   *
   * Section 6: "confirmed positive stock can return eligible listing to sale."
   * Separate from an ordinary quantity write because it changes what the public
   * can see rather than only what it says, which is why it carries a publication
   * permission and a person's confirmation instead of arriving from a sweep.
   */
  restockToLive?(input: RestockToLiveInput): Promise<ProviderResult<RestockToLiveResult>>;

  /**
   * Writes a copy of an order that happened on another channel.
   *
   * Section 11's optional manual copy, and the only place this application
   * creates an order rather than observing one. The copy is a record, not a
   * sale: the customer already bought the goods somewhere else, and the ledger
   * already knows.
   *
   * `suppressStockReduction` is not advice. A WooCommerce order created in a
   * qualifying status runs the store's own stock reduction, on top of the
   * projection the original sale already wrote, so an adapter that cannot carry
   * out the named technique must fail rather than create the order — section 11
   * would rather the action be unavailable than ship "a known double
   * decrement".
   */
  createMirroredOrder?(input: MirroredOrderInput): Promise<ProviderResult<MirroredOrderResult>>;
}

/** A person's name and address, exactly as the source channel gave it. */
export interface PostalContact {
  readonly firstName?: string;
  readonly lastName?: string;
  readonly company?: string;
  readonly line1?: string;
  readonly line2?: string;
  readonly city?: string;
  readonly region?: string;
  readonly postcode?: string;
  readonly country?: string;
  readonly email?: string;
  readonly phone?: string;
}

export interface MirroredOrderLine {
  readonly sku?: string;
  readonly name: string;
  readonly quantity: number;
  /** Decimal strings throughout, as quoted by the source channel. */
  readonly unitAmount: string;
  readonly totalAmount: string;
  readonly taxAmount?: string;
  /** The source channel's own line identifier, carried into the copy. */
  readonly sourceLineId: string;
}

export interface MirroredOrderInput {
  /** The order being copied, and where it happened. */
  readonly sourceOrderId: string;
  readonly sourceProvider: ProviderName;
  /**
   * Section 11: "unshipped paid orders use WooCommerce `processing`; already
   * fulfilled orders use `completed`."
   */
  readonly status: 'processing' | 'completed';
  readonly currency: string;
  readonly lines: readonly MirroredOrderLine[];
  readonly shippingAmount?: string;
  readonly taxAmount?: string;
  readonly totalAmount: string;
  readonly billing?: PostalContact;
  readonly shipping?: PostalContact;
  /** Section 11: an `eBay` label, without invoking a payment gateway. */
  readonly paymentMethodTitle: string;
  /** The technique this store's version supports. Never empty. */
  readonly suppressStockReduction: string;
  /** Section 11: customer email is disabled by default. */
  readonly suppressCustomerEmail: boolean;
  /** Integration metadata written onto the order, naming its origin. */
  readonly metadata: Readonly<Record<string, string>>;
  readonly idempotencyKey: string;
}

export interface MirroredOrderResult {
  readonly externalOrderId: string;
  readonly url?: string;
  /**
   * Whether the store's own stock reduction was actually suppressed.
   *
   * Reported rather than assumed. The caller treats `false` as a failure and
   * refuses to keep the order, because an unsuppressed copy has already
   * decremented a shop's numbers for a sale that was counted elsewhere.
   */
  readonly stockReductionSuppressed: boolean;
}

export type ListingLifecycleState = 'active' | 'out_of_stock' | 'ended';

export interface ListingState {
  readonly entity: ChannelEntityRef;
  readonly state: ListingLifecycleState;
  /**
   * Whether the seller has eBay's out-of-stock control enabled.
   *
   * Without it, hitting zero ends the listing rather than hiding it, so there is
   * nothing to return to sale. Section 13's operator checklist asks for it to be
   * enabled; this reports whether it actually is.
   */
  readonly outOfStockControlEnabled: boolean;
  readonly quantity: number;
  readonly version?: string;
  readonly observedAt?: Date;
}

export interface RestockToLiveInput {
  readonly entity: ChannelEntityRef;
  /** The confirmed positive quantity to return to sale with. */
  readonly quantity: number;
  readonly expectedVersion?: string;
  readonly idempotencyKey: string;
}

export interface RestockToLiveResult {
  readonly entity: ChannelEntityRef;
  readonly state: ListingLifecycleState;
  readonly quantity: number;
  readonly version?: string;
}

export interface PriceObservation {
  readonly entity: ChannelEntityRef;
  /** Decimal string, as the provider quoted it. */
  readonly amount: string;
  readonly currency: string;
  /**
   * A sale price currently overriding the regular one, when there is one.
   *
   * Reported because section 14 requires "sale-price implications" to be shown
   * before a change is confirmed: raising a regular price that a sale price is
   * currently undercutting changes nothing a customer sees, and somebody
   * confirming that change should know it.
   */
  readonly salePriceAmount?: string;
  readonly version?: string;
  readonly observedAt?: Date;
}

export interface PriceWrite {
  readonly entity: ChannelEntityRef;
  readonly amount: string;
  readonly currency: string;
  readonly expectedVersion?: string;
  readonly idempotencyKey: string;
}

export interface PriceChangePreview {
  readonly fees: readonly FeeLine[];
  readonly totalAmount?: string;
  readonly currency?: string;
  readonly warnings: readonly string[];
  readonly blockers: readonly string[];
}

export interface PriceAcknowledgement {
  readonly entity: ChannelEntityRef;
  readonly amount: string;
  readonly currency: string;
  readonly version?: string;
  /** True when the provider reported the price was already this. */
  readonly unchanged: boolean;
}

export interface CreateDraftInput {
  /** The reviewed projection, already carrying the reviewer's selections. */
  readonly fields: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  readonly idempotencyKey: string;
}

export interface DraftRef {
  readonly externalDraftId: string;
  /** Where a person can go and look at it. Shown, never followed by us. */
  readonly url?: string;
}

export interface PreviewPublicationInput {
  readonly externalDraftId: string;
}

/** One charge, named as the provider names it. Never summed by the adapter. */
export interface FeeLine {
  readonly label: string;
  /** Decimal string. A fee that has been through a float is not the fee. */
  readonly amount: string;
  readonly currency: string;
}

export interface PublicationPreview {
  readonly fees: readonly FeeLine[];
  /**
   * The provider's own total, when it gives one.
   *
   * Absent rather than computed here when it does not. Adding up fee lines
   * across currencies, or across a provider's own rounding, produces a number
   * this application would be presenting as the provider's — and a confirmation
   * screen that quotes a fee the provider never quoted is worse than one that
   * says the total is unavailable.
   */
  readonly totalAmount?: string;
  readonly currency?: string;
  readonly warnings: readonly string[];
  /** Provider-side validation that would refuse this publication. */
  readonly blockers: readonly string[];
}

export interface PublishDraftInput {
  readonly externalDraftId: string;
  readonly idempotencyKey: string;
}

export interface PublishedListing {
  readonly externalListingId: string;
  readonly url?: string;
  /**
   * Section 13: a listing created through the Inventory API "must later be
   * revised through the app/API, not Seller Hub". Reported by the adapter so
   * the warning shown after publication is the provider's fact rather than a
   * guess from the connection's settings.
   */
  readonly revisableOnlyThroughApi?: boolean;
}

/**
 * Telling a channel that a parcel has gone (sections 13, 14).
 *
 * Optional and nested for the same reason `ListingOperations` is: presence is
 * the capability. eBay takes a fulfilment with a tracking number; WooCommerce
 * core has no fulfilment concept at all and takes a customer-visible order note
 * and, when everything has shipped, a status change. An adapter implements what
 * its platform actually offers, so a screen cannot advertise a button whose
 * method does not exist.
 *
 * Section 14 is emphatic about what must *not* be here: "do not write unofficial
 * plugin metadata". Tracking on WooCommerce goes into a note a customer can
 * read, not into meta keys belonging to a plugin this application does not ship
 * and cannot promise to keep in step with.
 */
export interface FulfillmentOperations {
  /**
   * Records a shipment against a channel order.
   *
   * Carries an idempotency key, and section 13 asks for more than that:
   * "ambiguous fulfillment retries first query existing fulfillments". An
   * adapter that can answer `findFulfillment` should, because a provider that
   * accepted the first attempt and timed out before replying has already done
   * the work.
   */
  createFulfillment?(input: CreateFulfillmentInput): Promise<ProviderResult<FulfillmentRef>>;

  /** Whether a fulfilment for this key already exists. Null when it does not. */
  findFulfillment?(input: {
    readonly externalOrderId: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderResult<FulfillmentRef | null>>;

  /**
   * Adds a note to a channel order.
   *
   * `customerVisible` is the whole point on WooCommerce: section 14 offers "a
   * separately confirmed customer-visible order note with tracking", and a note
   * the customer cannot see would be a private memo pretending to be a
   * notification.
   */
  addOrderNote?(input: AddOrderNoteInput): Promise<ProviderResult<{ readonly noteId: string }>>;

  /**
   * Moves a channel order to a new status.
   *
   * Section 14 permits exactly one use of this: offering a confirmed update to
   * `completed` once every quantity has shipped. Partially shipped orders keep
   * their status, because WooCommerce core has no universal partial-fulfilment
   * state and inventing one would mean writing a custom status this application
   * would then have to interpret forever.
   */
  setOrderStatus?(input: {
    readonly externalOrderId: string;
    readonly status: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderResult<{ readonly status: string }>>;
}

export interface FulfillmentLine {
  readonly externalLineId: string;
  readonly quantity: number;
}

export interface CreateFulfillmentInput {
  readonly externalOrderId: string;
  readonly lines: readonly FulfillmentLine[];
  readonly carrier: string;
  readonly trackingNumber: string;
  readonly shippedAt: Date;
  readonly idempotencyKey: string;
}

export interface FulfillmentRef {
  readonly externalFulfillmentId: string;
}

export interface AddOrderNoteInput {
  readonly externalOrderId: string;
  readonly note: string;
  /** Whether the customer sees it. Section 14 requires a note that they do. */
  readonly customerVisible: boolean;
  readonly idempotencyKey: string;
}

/**
 * The operations every channel adapter provides.
 *
 * Deliberately small. Everything a provider offers beyond this is either
 * modelled by the domain or does not belong in the synchronization path at all,
 * and an interface that grew to cover each provider's full surface would stop
 * being a boundary and start being a union of two APIs.
 */
export interface ChannelAdapter {
  readonly capabilities: AdapterCapabilities;

  /** Whether the stored credentials still work, without changing anything. */
  checkCredentials(): Promise<ProviderResult<{ readonly accountLabel: string }>>;

  /** Enumerates inventory-bearing entities for the initial catalog import. */
  listEntities(cursor?: string): Promise<ProviderResult<Page<ChannelEntityRef>>>;

  /** Reads current quantities. Reports what the provider says, unedited. */
  readQuantities(
    entities: readonly ChannelEntityRef[],
  ): Promise<ProviderResult<readonly QuantityObservation[]>>;

  /**
   * Writes absolute quantities.
   *
   * Partial success is expressed per entity rather than as one outcome for the
   * batch: a provider that accepts nine of ten writes has done something the
   * caller must record accurately, and collapsing that into a single failure
   * would either lose nine successes or claim one that did not happen.
   */
  writeQuantities(
    writes: readonly QuantityWrite[],
  ): Promise<ProviderResult<readonly ProviderResult<WriteAcknowledgement>[]>>;

  /**
   * Fetches one order as the provider currently holds it.
   *
   * Section 15 is emphatic that a webhook is "a signal that state may have
   * changed, not the final inventory truth", and requires fetching the current
   * authoritative state before deciding a mutation. So the pipeline never
   * commits inventory from a payload; it commits from this.
   */
  fetchOrder(externalOrderId: string): Promise<ProviderResult<ProviderOrder>>;

  /**
   * Lists orders changed since a watermark, for incremental polling.
   *
   * `since` is applied with the caller's overlap already subtracted. An adapter
   * should err towards returning too much: a duplicate is deduplicated for free
   * by the pipeline, and a missed order is a sale nobody accounted for.
   */
  listChangedOrders(input: {
    readonly since: Date;
    readonly cursor?: string;
  }): Promise<ProviderResult<Page<ProviderOrderRef>>>;

  /**
   * Verifies and normalizes an inbound webhook.
   *
   * Returns `rejected` when the signature does not verify. Section 19 treats an
   * unverifiable webhook as hostile, so it is never parsed for content and
   * never trusted enough to trigger a read.
   */
  verifyWebhook(webhook: InboundWebhook): Promise<ProviderResult<VerifiedWebhook>>;

  /**
   * The reviewed operations this channel offers, if any.
   *
   * Absent means this adapter takes part in synchronization only. Nothing above
   * has to be guarded by a capability flag as a result: the operations either
   * exist here or they do not, so a screen cannot advertise one the adapter has
   * no method for, and a flag cannot disagree with the code beneath it.
   */
  readonly listingOperations?: ListingOperations;

  /**
   * How this channel is told that a parcel has gone, if it can be told at all.
   *
   * Absent means tracking stays inside this application, which is a supported
   * outcome rather than a degraded one: section 14 makes the app-native package,
   * label, carrier, and tracking records authoritative, and propagating them
   * outward is an additional courtesy to the platform the customer bought on.
   */
  readonly fulfillmentOperations?: FulfillmentOperations;
}

/**
 * Builds an adapter for one stored connection.
 *
 * A factory rather than a constructor because credentials are decrypted per
 * use and access tokens are refreshed, so an adapter instance is scoped to a
 * unit of work and never cached across them.
 */
export type ChannelAdapterFactory = (connectionId: string) => Promise<ChannelAdapter>;
