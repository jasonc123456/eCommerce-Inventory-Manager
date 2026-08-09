import type {
  AddOrderNoteInput,
  AdapterCapabilities,
  ChannelAdapter,
  ChannelEntityRef,
  CreateDraftInput,
  CreateFulfillmentInput,
  DraftRef,
  FeeLine,
  FulfillmentOperations,
  FulfillmentRef,
  InboundWebhook,
  ListingLifecycleState,
  ListingOperations,
  ListingState,
  MirroredOrderInput,
  MirroredOrderResult,
  Page,
  PreviewPublicationInput,
  PriceAcknowledgement,
  PriceChangePreview,
  PriceObservation,
  PriceWrite,
  ProviderOrder,
  ProviderOrderRef,
  PublicationPreview,
  PublishDraftInput,
  PublishedListing,
  QuantityObservation,
  QuantityWrite,
  RestockToLiveInput,
  RestockToLiveResult,
  VerifiedWebhook,
  WriteAcknowledgement,
} from '../adapter';
import type { ProviderFailure, ProviderName, ProviderResult } from '../outcomes';

/**
 * A programmable in-memory channel adapter.
 *
 * This is how every failure path gets tested. Rate limits, revoked
 * authorization, version conflicts, and partial batch failures are all
 * ordinary provider behavior that the retry policy in section 12 and the
 * reconciliation in section 14 exist to handle, and none of them can be
 * produced on demand against a real provider — you cannot ask eBay to
 * rate-limit you at a convenient moment.
 *
 * There is no HTTP anywhere in this file, and none anywhere in this package in
 * M0. Section 40 permits no live provider call, and a fake that "falls back" to
 * the network is how that guarantee gets broken by accident.
 */

export interface FakeAdapterOptions {
  readonly provider?: ProviderName;
  readonly capabilities?: Partial<AdapterCapabilities>;
  /** Starting quantities, keyed by the entity key. */
  readonly initialQuantities?: ReadonlyMap<string, number>;
  /** Entities the fake reports from `listEntities`. */
  readonly entities?: readonly ChannelEntityRef[];
  /** Orders the fake will hand back, keyed by external order id. */
  readonly orders?: ReadonlyMap<string, ProviderOrder>;
  /** Page size for `listEntities`, so pagination itself can be exercised. */
  readonly pageSize?: number;
  /**
   * Whether this channel offers reviewed listing operations at all.
   *
   * Off by default, so a test that means to exercise drafts has to say so and a
   * test that does not gets an adapter which cannot publish anything.
   */
  readonly listingOperations?: boolean;
  /**
   * Whether this channel can be told that a parcel has gone.
   *
   * Off by default, so a test that means to exercise tracking propagation has
   * to say so and a test that does not gets an adapter with nothing to tell.
   */
  readonly fulfillmentOperations?: boolean;
  /**
   * A fulfilment this channel already holds, keyed by idempotency key.
   *
   * Section 13's "ambiguous fulfillment retries first query existing
   * fulfillments" is only testable against a provider that accepted the first
   * attempt and failed to say so, which is what seeding this produces.
   */
  readonly existingFulfillments?: ReadonlyMap<string, string>;
  /** Fees `previewPublication` quotes. */
  readonly publicationFees?: readonly FeeLine[];
  /** Provider-side validation that would refuse publication. */
  readonly publicationBlockers?: readonly string[];
  /** Starting prices, keyed by the entity key. */
  readonly initialPrices?: ReadonlyMap<string, { amount: string; currency: string }>;
  /** Entity keys currently running a sale price, and what it is. */
  readonly salePrices?: ReadonlyMap<string, string>;
  /** Lifecycle state per entity key. Absent entries are `active`. */
  readonly listingStates?: ReadonlyMap<string, ListingLifecycleState>;
  /** Whether the seller has eBay's out-of-stock control enabled. */
  readonly outOfStockControlEnabled?: boolean;
  /**
   * Whether this store can actually carry out the named suppression technique.
   *
   * Defaults to true. Set false to exercise the case section 11 cares most
   * about: a store that accepted the order and reduced its own stock anyway.
   */
  readonly canSuppressStockReduction?: boolean;
}

/** A price this fake was asked to write. */
export interface RecordedPriceWrite {
  readonly entityKey: string;
  readonly amount: string;
  readonly currency: string;
  readonly idempotencyKey: string;
}

/** A draft this fake is holding, and whether it has been published. */
export interface RecordedDraft {
  readonly externalDraftId: string;
  readonly fields: Readonly<Record<string, string | number | boolean | readonly string[]>>;
  readonly idempotencyKey: string;
  published: boolean;
}

/** A record of one call, so tests can assert on what was actually sent. */
export interface RecordedWrite {
  readonly entityKey: string;
  readonly quantity: number;
  readonly idempotencyKey: string;
  readonly expectedVersion?: string;
}

export function entityKey(entity: ChannelEntityRef): string {
  return entity.variationId === undefined
    ? entity.externalId
    : `${entity.externalId}:${entity.variationId}`;
}

const DEFAULT_CAPABILITIES: AdapterCapabilities = {
  provider: 'ebay',
  supportsWebhooks: true,
  supportsWebhookSignatures: true,
  supportsOptimisticConcurrency: true,
  supportsBatchQuantityWrites: true,
  maxBatchSize: 25,
  supportsPerLocationStock: false,
};

export class FakeChannelAdapter implements ChannelAdapter {
  public readonly capabilities: AdapterCapabilities;

  /** Everything written, in order. Assertions read this. */
  public readonly writes: RecordedWrite[] = [];
  public readonly calls: string[] = [];

  private readonly quantities = new Map<string, number>();
  private readonly versions = new Map<string, number>();
  private readonly entities: readonly ChannelEntityRef[];
  private readonly pageSize: number;
  private readonly backorders = new Set<string>();
  private readonly orders = new Map<string, ProviderOrder>();

  /**
   * Failures to return instead of doing the work, one per call, consumed in
   * order. A queue rather than a flag so a test can express "fail twice, then
   * succeed", which is the shape every retry test needs.
   */
  private readonly queuedFailures: ProviderFailure[] = [];

  /** Drafts created through `listingOperations`, in order. */
  public readonly drafts: RecordedDraft[] = [];
  /** External ids of everything this fake has published. */
  public readonly published: string[] = [];

  public readonly listingOperations?: ListingOperations;

  public readonly fulfillmentOperations?: FulfillmentOperations;

  /** Every fulfilment this fake was asked to create, in order. */
  public readonly fulfillments: CreateFulfillmentInput[] = [];
  /** Every order note, in order. */
  public readonly orderNotes: AddOrderNoteInput[] = [];
  /** Every status change asked for, as `orderId:status`. */
  public readonly statusChanges: string[] = [];

  private readonly fulfillmentsByKey = new Map<string, string>();
  private nextFulfillmentNumber = 1;

  /** Every price this fake was asked to write, in order. */
  public readonly priceWrites: RecordedPriceWrite[] = [];

  private readonly publicationFees: readonly FeeLine[];
  private readonly publicationBlockers: readonly string[];
  private nextDraftNumber = 1;
  private readonly prices = new Map<string, { amount: string; currency: string }>();
  private readonly salePrices = new Map<string, string>();
  private readonly listingStates = new Map<string, ListingLifecycleState>();
  private readonly outOfStockControlEnabled: boolean;
  private readonly canSuppressStockReduction: boolean;
  private nextMirroredOrderNumber = 1;

  /** Every order copy this fake was asked to write, in order. */
  public readonly mirroredOrders: MirroredOrderInput[] = [];

  public constructor(options: FakeAdapterOptions = {}) {
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
    if (options.provider !== undefined) {
      this.capabilities = { ...this.capabilities, provider: options.provider };
    }
    this.entities = options.entities ?? [];
    this.pageSize = options.pageSize ?? 50;

    for (const [id, order] of options.orders ?? []) {
      this.orders.set(id, order);
    }

    for (const [key, quantity] of options.initialQuantities ?? []) {
      this.quantities.set(key, quantity);
      this.versions.set(key, 1);
    }

    this.publicationFees = options.publicationFees ?? [
      { label: 'Insertion fee', amount: '0.35', currency: 'GBP' },
      { label: 'Final value fee (estimated)', amount: '1.20', currency: 'GBP' },
    ];
    this.publicationBlockers = options.publicationBlockers ?? [];

    for (const [key, price] of options.initialPrices ?? []) {
      this.prices.set(key, price);
      this.versions.set(key, this.versions.get(key) ?? 1);
    }
    for (const [key, amount] of options.salePrices ?? []) {
      this.salePrices.set(key, amount);
    }
    for (const [key, state] of options.listingStates ?? []) {
      this.listingStates.set(key, state);
    }
    this.outOfStockControlEnabled = options.outOfStockControlEnabled ?? true;
    this.canSuppressStockReduction = options.canSuppressStockReduction ?? true;

    for (const [key, id] of options.existingFulfillments ?? []) {
      this.fulfillmentsByKey.set(key, id);
    }

    if (options.fulfillmentOperations === true) {
      this.fulfillmentOperations = {
        createFulfillment: (input) => this.createFulfillment(input),
        findFulfillment: (input) => this.findFulfillment(input),
        addOrderNote: (input) => this.addOrderNote(input),
        setOrderStatus: (input) => this.setOrderStatus(input),
      };
    }

    if (options.listingOperations === true) {
      this.listingOperations = {
        createDraft: (input) => this.createDraft(input),
        previewPublication: (input) => this.previewPublication(input),
        publishDraft: (input) => this.publishDraft(input),
        readPrice: (entity) => this.readPrice(entity),
        previewPriceChange: (input) => this.previewPriceChange(input),
        writePrice: (input) => this.writePrice(input),
        readListingState: (entity) => this.readListingState(entity),
        restockToLive: (input) => this.restockToLive(input),
        createMirroredOrder: (input) => this.createMirroredOrder(input),
      };
    }
  }

  private createFulfillment(
    input: CreateFulfillmentInput,
  ): Promise<ProviderResult<FulfillmentRef>> {
    this.calls.push('createFulfillment');
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      // Recorded even on failure, because the ambiguous-timeout case is a
      // provider that did the work and did not manage to say so.
      this.fulfillments.push(input);
      return Promise.resolve(failure);
    }

    this.fulfillments.push(input);

    const existing = this.fulfillmentsByKey.get(input.idempotencyKey);
    if (existing !== undefined) {
      return Promise.resolve({
        status: 'success',
        value: { externalFulfillmentId: existing },
      });
    }

    const externalFulfillmentId = `ful-${String(this.nextFulfillmentNumber++)}`;
    this.fulfillmentsByKey.set(input.idempotencyKey, externalFulfillmentId);

    return Promise.resolve({ status: 'success', value: { externalFulfillmentId } });
  }

  private findFulfillment(input: {
    readonly externalOrderId: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderResult<FulfillmentRef | null>> {
    this.calls.push('findFulfillment');
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    const existing = this.fulfillmentsByKey.get(input.idempotencyKey);

    return Promise.resolve({
      status: 'success',
      value: existing === undefined ? null : { externalFulfillmentId: existing },
    });
  }

  private addOrderNote(
    input: AddOrderNoteInput,
  ): Promise<ProviderResult<{ readonly noteId: string }>> {
    this.calls.push('addOrderNote');
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    this.orderNotes.push(input);

    return Promise.resolve({
      status: 'success',
      value: { noteId: `note-${String(this.orderNotes.length)}` },
    });
  }

  private setOrderStatus(input: {
    readonly externalOrderId: string;
    readonly status: string;
    readonly idempotencyKey: string;
  }): Promise<ProviderResult<{ readonly status: string }>> {
    this.calls.push('setOrderStatus');
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    this.statusChanges.push(`${input.externalOrderId}:${input.status}`);

    return Promise.resolve({ status: 'success', value: { status: input.status } });
  }

  private createMirroredOrder(
    input: MirroredOrderInput,
  ): Promise<ProviderResult<MirroredOrderResult>> {
    this.calls.push('createMirroredOrder');
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    const existing = this.mirroredOrders.findIndex(
      (order) => order.idempotencyKey === input.idempotencyKey,
    );
    if (existing !== -1) {
      return Promise.resolve({
        status: 'success',
        value: {
          externalOrderId: `WC-${String(existing + 1)}`,
          stockReductionSuppressed: this.canSuppressStockReduction,
        },
      });
    }

    this.mirroredOrders.push(input);

    return Promise.resolve({
      status: 'success',
      value: {
        externalOrderId: `WC-${String(this.nextMirroredOrderNumber++)}`,
        stockReductionSuppressed: this.canSuppressStockReduction,
      },
    });
  }

  private readListingState(entity: ChannelEntityRef): Promise<ProviderResult<ListingState>> {
    this.calls.push('readListingState');
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    const key = entityKey(entity);
    if (!this.quantities.has(key)) {
      return Promise.resolve({ status: 'not_found', message: `no entity ${key}` });
    }

    return Promise.resolve({
      status: 'success',
      value: {
        entity,
        state: this.listingStates.get(key) ?? 'active',
        outOfStockControlEnabled: this.outOfStockControlEnabled,
        quantity: this.quantities.get(key) ?? 0,
        version: String(this.versions.get(key) ?? 1),
        observedAt: new Date(0),
      },
    });
  }

  private restockToLive(input: RestockToLiveInput): Promise<ProviderResult<RestockToLiveResult>> {
    this.calls.push('restockToLive');
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    const key = entityKey(input.entity);
    if (!this.quantities.has(key)) {
      return Promise.resolve({ status: 'not_found', message: `no entity ${key}` });
    }

    // An ended listing is not a listing to bring back. A real provider refuses
    // this too, and discovering it here rather than after a confirmation is why
    // the eligibility check exists on our side as well.
    if (this.listingStates.get(key) === 'ended') {
      return Promise.resolve({
        status: 'rejected',
        message: 'this listing has ended and must be relisted rather than restocked',
        code: 'LISTING_ENDED',
      });
    }

    if (input.quantity <= 0) {
      return Promise.resolve({
        status: 'rejected',
        message: 'a listing cannot be returned to sale with no stock',
        code: 'INVALID_QUANTITY',
      });
    }

    const currentVersion = String(this.versions.get(key) ?? 1);
    if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
      return Promise.resolve({
        status: 'conflict',
        message: `entity ${key} changed since it was read`,
        currentVersion,
      });
    }

    this.quantities.set(key, input.quantity);
    this.listingStates.set(key, 'active');
    this.versions.set(key, Number(currentVersion) + 1);

    return Promise.resolve({
      status: 'success',
      value: {
        entity: input.entity,
        state: 'active',
        quantity: input.quantity,
        version: String(this.versions.get(key) ?? 1),
      },
    });
  }

  /** Simulates a price edited on the channel by somebody else. */
  public setPriceOutOfBand(entity: ChannelEntityRef, amount: string, currency: string): this {
    const key = entityKey(entity);
    this.prices.set(key, { amount, currency });
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    return this;
  }

  public priceOf(entity: ChannelEntityRef): { amount: string; currency: string } | undefined {
    return this.prices.get(entityKey(entity));
  }

  private readPrice(entity: ChannelEntityRef): Promise<ProviderResult<PriceObservation>> {
    this.calls.push('readPrice');
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    const key = entityKey(entity);
    const price = this.prices.get(key);
    if (price === undefined) {
      return Promise.resolve({ status: 'not_found', message: `no price for ${key}` });
    }

    const salePrice = this.salePrices.get(key);

    return Promise.resolve({
      status: 'success',
      value: {
        entity,
        amount: price.amount,
        currency: price.currency,
        version: String(this.versions.get(key) ?? 1),
        observedAt: new Date(0),
        ...(salePrice === undefined ? {} : { salePriceAmount: salePrice }),
      },
    });
  }

  private previewPriceChange(input: PriceWrite): Promise<ProviderResult<PriceChangePreview>> {
    this.calls.push('previewPriceChange');
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    const key = entityKey(input.entity);
    if (!this.prices.has(key)) {
      return Promise.resolve({ status: 'not_found', message: `no price for ${key}` });
    }

    // A flat proportion of the new price, which is close enough to how a final
    // value fee behaves for the application to have something real to show.
    const fee = (Number(input.amount) * 0.1).toFixed(2);

    return Promise.resolve({
      status: 'success',
      value: {
        fees: [{ label: 'Final value fee (estimated)', amount: fee, currency: input.currency }],
        totalAmount: fee,
        currency: input.currency,
        warnings: [],
        blockers: this.publicationBlockers,
      },
    });
  }

  private writePrice(input: PriceWrite): Promise<ProviderResult<PriceAcknowledgement>> {
    this.calls.push('writePrice');
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    const key = entityKey(input.entity);
    const current = this.prices.get(key);
    if (current === undefined) {
      return Promise.resolve({ status: 'not_found', message: `no price for ${key}` });
    }

    const currentVersion = String(this.versions.get(key) ?? 1);
    if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
      return Promise.resolve({
        status: 'conflict',
        message: `the price of ${key} changed since it was read`,
        currentVersion,
      });
    }

    // Replaying a key changes nothing and reports what it reported before, which
    // is what an idempotency key is for.
    const replay = this.priceWrites.some((write) => write.idempotencyKey === input.idempotencyKey);
    if (!replay) {
      this.priceWrites.push({
        entityKey: key,
        amount: input.amount,
        currency: input.currency,
        idempotencyKey: input.idempotencyKey,
      });
    }

    const unchanged = current.amount === input.amount && current.currency === input.currency;
    if (!unchanged && !replay) {
      this.prices.set(key, { amount: input.amount, currency: input.currency });
      this.versions.set(key, Number(currentVersion) + 1);
    }

    return Promise.resolve({
      status: 'success',
      value: {
        entity: input.entity,
        amount: input.amount,
        currency: input.currency,
        version: String(this.versions.get(key) ?? 1),
        unchanged,
      },
    });
  }

  private createDraft(input: CreateDraftInput): Promise<ProviderResult<DraftRef>> {
    this.calls.push('createDraft');
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    // Replaying a key returns what it returned the first time. A real provider
    // that honours idempotency does exactly this, and the whole reason the
    // application carries a key across retries is to get this answer back.
    const existing = this.drafts.find((draft) => draft.idempotencyKey === input.idempotencyKey);
    if (existing !== undefined) {
      return Promise.resolve({
        status: 'success',
        value: { externalDraftId: existing.externalDraftId },
      });
    }

    // A draft is a draft. A caller that sends a published status has a bug, and
    // discovering it here rather than on a live storefront is the point.
    if (input.fields['status'] === 'publish' || input.fields['status'] === 'active') {
      return Promise.resolve({
        status: 'rejected',
        message: 'a draft cannot be created in a published state',
        code: 'NOT_A_DRAFT',
      });
    }

    const externalDraftId = `DRAFT-${String(this.nextDraftNumber++)}`;
    this.drafts.push({
      externalDraftId,
      fields: input.fields,
      idempotencyKey: input.idempotencyKey,
      published: false,
    });

    return Promise.resolve({ status: 'success', value: { externalDraftId } });
  }

  private previewPublication(
    input: PreviewPublicationInput,
  ): Promise<ProviderResult<PublicationPreview>> {
    this.calls.push('previewPublication');
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    const draft = this.drafts.find((entry) => entry.externalDraftId === input.externalDraftId);
    if (draft === undefined) {
      return Promise.resolve({ status: 'not_found', message: `no draft ${input.externalDraftId}` });
    }

    const total = this.publicationFees.reduce((sum, fee) => sum + Number(fee.amount), 0).toFixed(2);

    return Promise.resolve({
      status: 'success',
      value: {
        fees: this.publicationFees,
        totalAmount: total,
        currency: this.publicationFees[0]?.currency ?? 'GBP',
        warnings: [
          'listings created here must be revised through this application, not Seller Hub',
        ],
        blockers: this.publicationBlockers,
      },
    });
  }

  private publishDraft(input: PublishDraftInput): Promise<ProviderResult<PublishedListing>> {
    this.calls.push('publishDraft');
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    const draft = this.drafts.find((entry) => entry.externalDraftId === input.externalDraftId);
    if (draft === undefined) {
      return Promise.resolve({ status: 'not_found', message: `no draft ${input.externalDraftId}` });
    }

    if (this.publicationBlockers.length > 0) {
      return Promise.resolve({
        status: 'rejected',
        message: this.publicationBlockers.join('; '),
        code: 'VALIDATION_FAILED',
      });
    }

    const externalListingId = `LISTING-${draft.externalDraftId}`;
    if (!draft.published) {
      draft.published = true;
      this.published.push(externalListingId);
    }

    return Promise.resolve({
      status: 'success',
      value: { externalListingId, revisableOnlyThroughApi: true },
    });
  }

  /** Makes the next call fail. Call repeatedly to queue several. */
  public failNext(failure: ProviderFailure): this {
    this.queuedFailures.push(failure);
    return this;
  }

  /** Simulates a change made outside this application, which is what drift is. */
  public setQuantityOutOfBand(entity: ChannelEntityRef, quantity: number): this {
    const key = entityKey(entity);
    this.quantities.set(key, quantity);
    this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    return this;
  }

  public enableBackorders(entity: ChannelEntityRef): this {
    this.backorders.add(entityKey(entity));
    return this;
  }

  public quantityOf(entity: ChannelEntityRef): number | undefined {
    return this.quantities.get(entityKey(entity));
  }

  public checkCredentials(): Promise<ProviderResult<{ readonly accountLabel: string }>> {
    this.calls.push('checkCredentials');
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }
    return Promise.resolve({
      status: 'success',
      value: { accountLabel: `fake-${this.capabilities.provider}` },
    });
  }

  public listEntities(cursor?: string): Promise<ProviderResult<Page<ChannelEntityRef>>> {
    this.calls.push('listEntities');
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    const offset = cursor === undefined ? 0 : Number.parseInt(cursor, 10);
    if (Number.isNaN(offset) || offset < 0) {
      return Promise.resolve({ status: 'rejected', message: 'malformed cursor' });
    }

    const items = this.entities.slice(offset, offset + this.pageSize);
    const next = offset + this.pageSize;

    return Promise.resolve({
      status: 'success',
      value: {
        items,
        ...(next < this.entities.length ? { nextCursor: String(next) } : {}),
      },
    });
  }

  /** Adds or replaces an order, as a channel does when a customer buys. */
  public setOrder(order: ProviderOrder): this {
    this.orders.set(order.externalOrderId, order);
    return this;
  }

  public fetchOrder(externalOrderId: string): Promise<ProviderResult<ProviderOrder>> {
    this.calls.push('fetchOrder');
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    const order = this.orders.get(externalOrderId);

    return Promise.resolve(
      order === undefined
        ? { status: 'not_found', message: `no order ${externalOrderId}` }
        : { status: 'success', value: order },
    );
  }

  public listChangedOrders(input: {
    readonly since: Date;
    readonly cursor?: string;
  }): Promise<ProviderResult<Page<ProviderOrderRef>>> {
    this.calls.push('listChangedOrders');
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    // Deliberately inclusive of the boundary. An adapter should err towards
    // returning too much: a duplicate costs one deduplicated event, a miss
    // costs a sale nobody accounted for.
    const items = [...this.orders.values()]
      .filter((order) => order.placedAt === undefined || order.placedAt >= input.since)
      .map((order) => ({
        externalOrderId: order.externalOrderId,
        ...(order.placedAt === undefined ? {} : { updatedAt: order.placedAt }),
      }));

    return Promise.resolve({ status: 'success', value: { items } });
  }

  public readQuantities(
    entities: readonly ChannelEntityRef[],
  ): Promise<ProviderResult<readonly QuantityObservation[]>> {
    this.calls.push('readQuantities');
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    const observations: QuantityObservation[] = [];
    for (const entity of entities) {
      const key = entityKey(entity);
      const quantity = this.quantities.get(key);
      if (quantity === undefined) {
        continue;
      }
      observations.push({
        entity,
        quantity,
        version: String(this.versions.get(key) ?? 1),
        observedAt: new Date(0),
        backordersEnabled: this.backorders.has(key),
      });
    }

    return Promise.resolve({ status: 'success', value: observations });
  }

  public writeQuantities(
    writes: readonly QuantityWrite[],
  ): Promise<ProviderResult<readonly ProviderResult<WriteAcknowledgement>[]>> {
    this.calls.push('writeQuantities');
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    if (
      this.capabilities.maxBatchSize !== undefined &&
      writes.length > this.capabilities.maxBatchSize
    ) {
      return Promise.resolve({
        status: 'rejected',
        message: `batch of ${String(writes.length)} exceeds the maximum of ${String(this.capabilities.maxBatchSize)}`,
        code: 'BATCH_TOO_LARGE',
      });
    }

    const results = writes.map((write) => this.applyWrite(write));
    return Promise.resolve({ status: 'success', value: results });
  }

  private applyWrite(write: QuantityWrite): ProviderResult<WriteAcknowledgement> {
    const key = entityKey(write.entity);

    if (!this.quantities.has(key)) {
      return { status: 'not_found', message: `no entity ${key}` };
    }

    if (write.quantity < 0 || !Number.isInteger(write.quantity)) {
      return {
        status: 'rejected',
        message: 'quantity must be a whole number of zero or more',
        code: 'INVALID_QUANTITY',
      };
    }

    const currentVersion = String(this.versions.get(key) ?? 1);

    if (
      this.capabilities.supportsOptimisticConcurrency &&
      write.expectedVersion !== undefined &&
      write.expectedVersion !== currentVersion
    ) {
      return {
        status: 'conflict',
        message: `entity ${key} changed since it was read`,
        currentVersion,
      };
    }

    this.writes.push({
      entityKey: key,
      quantity: write.quantity,
      idempotencyKey: write.idempotencyKey,
      ...(write.expectedVersion === undefined ? {} : { expectedVersion: write.expectedVersion }),
    });

    const unchanged = this.quantities.get(key) === write.quantity;
    if (!unchanged) {
      this.quantities.set(key, write.quantity);
      this.versions.set(key, Number(currentVersion) + 1);
    }

    return {
      status: 'success',
      value: {
        entity: write.entity,
        version: String(this.versions.get(key) ?? 1),
        unchanged,
      },
    };
  }

  /**
   * Verifies a webhook against a fixed test secret.
   *
   * The check is a literal header comparison rather than a real HMAC, because
   * this fake exists to exercise the application's handling of verified and
   * unverified webhooks. The real signature algorithms are each provider's own
   * and are tested against that provider's adapter in M2.
   */
  public verifyWebhook(webhook: InboundWebhook): Promise<ProviderResult<VerifiedWebhook>> {
    this.calls.push('verifyWebhook');
    const failure = this.queuedFailures.shift();
    if (failure !== undefined) {
      return Promise.resolve(failure);
    }

    if (webhook.headers['x-fake-signature'] !== 'valid') {
      return Promise.resolve({
        status: 'rejected',
        message: 'signature did not verify',
        code: 'BAD_SIGNATURE',
      });
    }

    let parsed: { eventId?: unknown; eventType?: unknown; externalId?: unknown };
    try {
      parsed = JSON.parse(new TextDecoder().decode(webhook.rawBody)) as typeof parsed;
    } catch {
      return Promise.resolve({ status: 'rejected', message: 'body was not JSON' });
    }

    if (typeof parsed.eventId !== 'string' || typeof parsed.eventType !== 'string') {
      return Promise.resolve({ status: 'rejected', message: 'body was missing required fields' });
    }

    return Promise.resolve({
      status: 'success',
      value: {
        eventId: parsed.eventId,
        eventType: parsed.eventType,
        affects: typeof parsed.externalId === 'string' ? [{ externalId: parsed.externalId }] : [],
      },
    });
  }
}
