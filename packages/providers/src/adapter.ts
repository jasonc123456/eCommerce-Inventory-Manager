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
   * Verifies and normalizes an inbound webhook.
   *
   * Returns `rejected` when the signature does not verify. Section 19 treats an
   * unverifiable webhook as hostile, so it is never parsed for content and
   * never trusted enough to trigger a read.
   */
  verifyWebhook(webhook: InboundWebhook): Promise<ProviderResult<VerifiedWebhook>>;
}

/**
 * Builds an adapter for one stored connection.
 *
 * A factory rather than a constructor because credentials are decrypted per
 * use and access tokens are refreshed, so an adapter instance is scoped to a
 * unit of work and never cached across them.
 */
export type ChannelAdapterFactory = (connectionId: string) => Promise<ChannelAdapter>;
