import {
  connections,
  providerItems,
  providerLocations,
  providerOrderLines,
  providerOrders,
  providerPolicies,
  type Database,
} from '@eim/db';
import type { HttpClient } from '@eim/providers';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';

import type { ImportStream, PageFetcher, SweepContext, WriteContext } from '../imports/runner';
import { hostsFor, type EbayEnvironment } from './environment';

/**
 * Reading a seller's catalog and orders (section 13).
 *
 * Everything here is a read. M2 imports and stops: the records land in the
 * provider mirror, which is a record of what eBay said rather than a statement
 * about what this application believes. Nothing in this file writes to eBay, and
 * nothing in it touches canonical inventory.
 *
 * Two decisions worth stating, because both look like details and are not.
 *
 * The catalog is imported from the Inventory API, and a listing whose origin is
 * not the Inventory API is recorded as ineligible rather than skipped. Section
 * 13 makes management origin decide which API may later write to a listing, and
 * an ambiguous origin makes it read-only. Recording the ineligible ones is what
 * lets the interface explain why a seller's listing cannot be mapped — the
 * alternative is a catalog that silently omits half of what the operator can
 * see in Seller Hub.
 *
 * Orders are classified against the connection's activation moment at import
 * time. Pre-activation orders are historical: they exist for visibility and
 * deduplication, and they do not mutate inventory. Deciding once, from the
 * activation moment as it stood when the order was first seen, means a later
 * change to that moment cannot silently reclassify a year of history into a
 * year of sudden demand.
 */

export interface EbayImportOptions {
  readonly db: Database;
  readonly http: HttpClient;
  readonly businessId: string;
  readonly connectionId: string;
  readonly environment: EbayEnvironment;
  /** Supplies a usable access token. Refreshes are somebody else's problem. */
  readonly accessToken: () => Promise<string | null>;
  /** How many records to ask for per page. eBay caps most of these at 200. */
  readonly pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 100;

/**
 * The catalog: inventory items, with their offers folded in.
 *
 * eBay models a sellable thing as an inventory item keyed by SKU, and the
 * listing of it as an offer against that SKU. Both are needed — the item
 * carries the quantity, the offer carries the listing identifier and price — so
 * this stream reads items and then asks for each SKU's offers.
 *
 * That is an N+1, and deliberately so: eBay has no bulk offer read that filters
 * by anything except SKU. Doing it here, inside a paged import with a page
 * budget, keeps the cost visible and bounded rather than spread across the
 * application.
 */
export function inventoryStream(options: EbayImportOptions): ImportStream<MappedItem> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;

  return {
    name: 'ebay_inventory',

    async fetchPage(request) {
      const offset = readOffset(request.cursor);
      const call = await get(
        options,
        `/sell/inventory/v1/inventory_item?limit=${String(pageSize)}&offset=${String(offset)}`,
      );

      if (!call.ok) {
        return call;
      }

      const payload = call.body;
      const items = asArray(payload['inventoryItems']);
      const total = asNumber(payload['total']) ?? 0;

      const mapped: MappedItem[] = [];

      for (const entry of items) {
        const item = mapInventoryItem(entry);

        if (item === null) {
          continue;
        }

        mapped.push(item);

        // Offers for this SKU. A failure here degrades the record rather than
        // failing the page: an item whose offers could not be read is still an
        // item, and reporting the whole import as broken because one SKU's
        // offers timed out would lose the other ninety-nine.
        const offers = await get(
          options,
          `/sell/inventory/v1/offer?sku=${encodeURIComponent(item.externalId)}&limit=50`,
        );

        if (offers.ok) {
          for (const offer of asArray(offers.body['offers'])) {
            const mappedOffer = mapOffer(offer, item.externalId);

            if (mappedOffer !== null) {
              mapped.push(mappedOffer);
            }
          }
        }
      }

      const nextOffset = offset + items.length;
      const finished = items.length === 0 || nextOffset >= total;

      return {
        ok: true,
        page: {
          records: mapped,
          nextCursor: finished ? undefined : String(nextOffset),
          checkpoint: { offset: nextOffset, total },
        },
      };
    },

    write: (records, context) => writeItems(options.db, records, context),
    sweep: (context) => sweepItems(options.db, context),
  };
}

/** Inventory locations, imported for explicit mapping and never modified. */
export function locationStream(options: EbayImportOptions): ImportStream<MappedLocation> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;

  return {
    name: 'ebay_locations',

    async fetchPage(request) {
      const offset = readOffset(request.cursor);
      const call = await get(
        options,
        `/sell/inventory/v1/location?limit=${String(pageSize)}&offset=${String(offset)}`,
      );

      if (!call.ok) {
        return call;
      }

      const rows = asArray(call.body['locations']);
      const total = asNumber(call.body['total']) ?? rows.length;
      const mapped = rows.map(mapLocation).filter((row): row is MappedLocation => row !== null);
      const nextOffset = offset + rows.length;
      const finished = rows.length === 0 || nextOffset >= total;

      return {
        ok: true,
        page: {
          records: mapped,
          nextCursor: finished ? undefined : String(nextOffset),
          checkpoint: { offset: nextOffset, total },
        },
      };
    },

    async write(records, context) {
      if (records.length === 0) {
        return 0;
      }

      const written = await options.db
        .insert(providerLocations)
        .values(
          records.map((record) => ({
            businessId: context.businessId,
            connectionId: context.connectionId,
            externalId: record.externalId,
            name: record.name,
            merchantKey: record.merchantKey,
            enabled: record.enabled,
            raw: record.raw,
            lastSeenAt: context.startedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [providerLocations.connectionId, providerLocations.externalId],
          set: {
            name: sql`excluded.name`,
            merchantKey: sql`excluded.merchant_key`,
            enabled: sql`excluded.enabled`,
            raw: sql`excluded.raw`,
            lastSeenAt: sql`excluded.last_seen_at`,
            // Reappearing clears the absence. A location that came back is not
            // still missing, and leaving the mark would keep warning about it.
            missingSince: sql`null`,
          },
        })
        .returning({ id: providerLocations.id });

      return written.length;
    },

    async sweep(context) {
      const marked = await options.db
        .update(providerLocations)
        .set({ missingSince: context.notSeenSince })
        .where(
          and(
            eq(providerLocations.connectionId, context.connectionId),
            lt(providerLocations.lastSeenAt, context.notSeenSince),
            isNull(providerLocations.missingSince),
          ),
        )
        .returning({ id: providerLocations.id });

      return marked.length;
    },
  };
}

/** Business policies: payment, return, and fulfillment, in one stream. */
export function policyStream(options: EbayImportOptions): ImportStream<MappedPolicy> {
  const KINDS = [
    ['payment', 'payment_policy', 'paymentPolicies', 'paymentPolicyId'],
    ['return', 'return_policy', 'returnPolicies', 'returnPolicyId'],
    ['fulfillment', 'fulfillment_policy', 'fulfillmentPolicies', 'fulfillmentPolicyId'],
  ] as const;

  return {
    name: 'ebay_policies',

    async fetchPage(request) {
      // The cursor is which policy family to read next, so an interrupted run
      // resumes at the family it did not reach rather than re-reading all three.
      const index = readOffset(request.cursor);
      const kind = KINDS[index];

      if (kind === undefined) {
        return { ok: true, page: { records: [], nextCursor: undefined } };
      }

      const [policyType, path, listKey, idKey] = kind;
      const call = await get(options, `/sell/account/v1/${path}?marketplace_id=EBAY_US`);

      if (!call.ok) {
        return call;
      }

      const rows = asArray(call.body[listKey]);
      const records = rows
        .map((row) => mapPolicy(row, policyType, idKey))
        .filter((row): row is MappedPolicy => row !== null);

      const nextIndex = index + 1;

      return {
        ok: true,
        page: {
          records,
          nextCursor: nextIndex >= KINDS.length ? undefined : String(nextIndex),
          checkpoint: { policyFamily: policyType },
        },
      };
    },

    async write(records, context) {
      if (records.length === 0) {
        return 0;
      }

      const written = await options.db
        .insert(providerPolicies)
        .values(
          records.map((record) => ({
            businessId: context.businessId,
            connectionId: context.connectionId,
            externalId: record.externalId,
            policyType: record.policyType,
            name: record.name,
            marketplace: record.marketplace,
            raw: record.raw,
            lastSeenAt: context.startedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [
            providerPolicies.connectionId,
            providerPolicies.policyType,
            providerPolicies.externalId,
          ],
          set: {
            name: sql`excluded.name`,
            marketplace: sql`excluded.marketplace`,
            raw: sql`excluded.raw`,
            lastSeenAt: sql`excluded.last_seen_at`,
            missingSince: sql`null`,
          },
        })
        .returning({ id: providerPolicies.id });

      return written.length;
    },

    async sweep(context) {
      const marked = await options.db
        .update(providerPolicies)
        .set({ missingSince: context.notSeenSince })
        .where(
          and(
            eq(providerPolicies.connectionId, context.connectionId),
            lt(providerPolicies.lastSeenAt, context.notSeenSince),
            isNull(providerPolicies.missingSince),
          ),
        )
        .returning({ id: providerPolicies.id });

      return marked.length;
    },
  };
}

/**
 * Orders, imported for visibility and deduplication.
 *
 * Deliberately no sweep. An order is never withdrawn: one absent from a scan is
 * outside the window that scan asked for, and marking it missing would say
 * something false about a sale that happened.
 */
export function orderStream(
  options: EbayImportOptions & { readonly since?: Date },
): ImportStream<MappedOrder> {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;

  return {
    name: 'ebay_orders',

    async fetchPage(request) {
      const offset = readOffset(request.cursor);
      const since = options.since ?? new Date(Date.now() - 90 * 24 * 60 * 60_000);
      const filter = `lastmodifieddate:[${since.toISOString()}..]`;

      const call = await get(
        options,
        `/sell/fulfillment/v1/order?limit=${String(pageSize)}&offset=${String(offset)}&filter=${encodeURIComponent(filter)}`,
      );

      if (!call.ok) {
        return call;
      }

      const rows = asArray(call.body['orders']);
      const total = asNumber(call.body['total']) ?? rows.length;
      const mapped = rows.map(mapOrder).filter((row): row is MappedOrder => row !== null);
      const nextOffset = offset + rows.length;
      const finished = rows.length === 0 || nextOffset >= total;

      return {
        ok: true,
        page: {
          records: mapped,
          nextCursor: finished ? undefined : String(nextOffset),
          checkpoint: { offset: nextOffset, total, since: since.toISOString() },
        },
      };
    },

    write: (records, context) => writeOrders(options.db, records, context),
  };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

async function writeItems(
  db: Database,
  records: readonly MappedItem[],
  context: WriteContext,
): Promise<number> {
  if (records.length === 0) {
    return 0;
  }

  // Deduplicated within the page: an offer and its inventory item can arrive
  // under the same identifier when a seller uses the SKU as the listing key,
  // and PostgreSQL refuses to update the same row twice in one statement.
  const unique = new Map<string, MappedItem>();

  for (const record of records) {
    unique.set(record.externalId, record);
  }

  const written = await db
    .insert(providerItems)
    .values(
      [...unique.values()].map((record) => ({
        businessId: context.businessId,
        connectionId: context.connectionId,
        externalId: record.externalId,
        parentExternalId: record.parentExternalId,
        kind: record.kind,
        sku: record.sku,
        title: record.title,
        quantity: record.quantity,
        priceAmount: record.priceAmount,
        priceCurrency: record.priceCurrency,
        providerStatus: record.providerStatus,
        managementOrigin: record.managementOrigin,
        inventoryEligible: record.inventoryEligible,
        ineligibleReason: record.ineligibleReason,
        raw: record.raw,
        lastSeenAt: context.startedAt,
        lastImportRunId: context.runId,
      })),
    )
    .onConflictDoUpdate({
      target: [providerItems.connectionId, providerItems.externalId],
      set: {
        parentExternalId: sql`excluded.parent_external_id`,
        kind: sql`excluded.kind`,
        sku: sql`excluded.sku`,
        title: sql`excluded.title`,
        quantity: sql`excluded.quantity`,
        priceAmount: sql`excluded.price_amount`,
        priceCurrency: sql`excluded.price_currency`,
        providerStatus: sql`excluded.provider_status`,
        managementOrigin: sql`excluded.management_origin`,
        inventoryEligible: sql`excluded.inventory_eligible`,
        ineligibleReason: sql`excluded.ineligible_reason`,
        raw: sql`excluded.raw`,
        lastSeenAt: sql`excluded.last_seen_at`,
        lastImportRunId: sql`excluded.last_import_run_id`,
        missingSince: sql`null`,
      },
    })
    .returning({ id: providerItems.id });

  return written.length;
}

async function sweepItems(db: Database, context: SweepContext): Promise<number> {
  const marked = await db
    .update(providerItems)
    .set({ missingSince: context.notSeenSince })
    .where(
      and(
        eq(providerItems.connectionId, context.connectionId),
        lt(providerItems.lastSeenAt, context.notSeenSince),
        isNull(providerItems.missingSince),
      ),
    )
    .returning({ id: providerItems.id });

  return marked.length;
}

async function writeOrders(
  db: Database,
  records: readonly MappedOrder[],
  context: WriteContext,
): Promise<number> {
  if (records.length === 0) {
    return 0;
  }

  // The activation moment, read once per page. Orders placed before it are
  // historical: they exist for visibility and deduplication and do not mutate
  // inventory (section 13).
  const [connection] = await db
    .select({ activatedAt: connections.activatedAt })
    .from(connections)
    .where(eq(connections.id, context.connectionId))
    .limit(1);

  const activatedAt = connection?.activatedAt ?? null;

  let written = 0;

  for (const record of records) {
    const preActivation =
      activatedAt === null ||
      record.placedAt === null ||
      record.placedAt.getTime() < activatedAt.getTime();

    const [order] = await db
      .insert(providerOrders)
      .values({
        businessId: context.businessId,
        connectionId: context.connectionId,
        externalId: record.externalId,
        externalReference: record.externalReference,
        placedAt: record.placedAt,
        updatedAtProvider: record.updatedAt,
        providerStatus: record.providerStatus,
        totalAmount: record.totalAmount,
        totalCurrency: record.totalCurrency,
        buyerExternalId: record.buyerExternalId,
        preActivation,
        raw: record.raw,
        lastSeenAt: context.startedAt,
        lastImportRunId: context.runId,
      })
      .onConflictDoUpdate({
        target: [providerOrders.connectionId, providerOrders.externalId],
        set: {
          externalReference: sql`excluded.external_reference`,
          placedAt: sql`excluded.placed_at`,
          updatedAtProvider: sql`excluded.updated_at_provider`,
          providerStatus: sql`excluded.provider_status`,
          totalAmount: sql`excluded.total_amount`,
          totalCurrency: sql`excluded.total_currency`,
          buyerExternalId: sql`excluded.buyer_external_id`,
          raw: sql`excluded.raw`,
          lastSeenAt: sql`excluded.last_seen_at`,
          lastImportRunId: sql`excluded.last_import_run_id`,
          // `pre_activation` is deliberately absent. It was decided when the
          // order was first seen, and a later change to the activation moment
          // must not reclassify a year of history into a year of demand.
        },
      })
      .returning({ id: providerOrders.id });

    if (order === undefined) {
      continue;
    }

    written += 1;

    if (record.lines.length === 0) {
      continue;
    }

    await db
      .insert(providerOrderLines)
      .values(
        record.lines.map((line) => ({
          businessId: context.businessId,
          orderId: order.id,
          externalId: line.externalId,
          itemExternalId: line.itemExternalId,
          variationExternalId: line.variationExternalId,
          sku: line.sku,
          quantity: line.quantity,
          quantityFulfilled: line.quantityFulfilled,
          unitAmount: line.unitAmount,
          currency: line.currency,
          raw: line.raw,
        })),
      )
      .onConflictDoUpdate({
        target: [providerOrderLines.orderId, providerOrderLines.externalId],
        set: {
          itemExternalId: sql`excluded.item_external_id`,
          variationExternalId: sql`excluded.variation_external_id`,
          sku: sql`excluded.sku`,
          quantity: sql`excluded.quantity`,
          quantityFulfilled: sql`excluded.quantity_fulfilled`,
          unitAmount: sql`excluded.unit_amount`,
          currency: sql`excluded.currency`,
          raw: sql`excluded.raw`,
        },
      });
  }

  return written;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export interface MappedItem {
  readonly externalId: string;
  readonly parentExternalId: string | null;
  readonly kind: 'listing' | 'offer' | 'inventory_item' | 'product' | 'variation';
  readonly sku: string | null;
  readonly title: string | null;
  readonly quantity: number | null;
  readonly priceAmount: string | null;
  readonly priceCurrency: string | null;
  readonly providerStatus: string | null;
  readonly managementOrigin:
    'unknown' | 'inventory_api' | 'trading_api' | 'ambiguous' | 'woocommerce';
  readonly inventoryEligible: boolean;
  readonly ineligibleReason: string | null;
  readonly raw: Record<string, unknown>;
}

/**
 * An inventory item.
 *
 * The SKU is the identifier eBay addresses these by, so it is both the external
 * id and the SKU. An item without one cannot be addressed at all and is
 * dropped: there is nothing later code could do with it.
 */
export function mapInventoryItem(entry: unknown): MappedItem | null {
  const record = asRecord(entry);

  if (record === null) {
    return null;
  }

  const sku = asString(record['sku']);

  if (sku === null) {
    return null;
  }

  const availability = asRecord(record['availability']);
  const shipToLocation =
    availability === null ? null : asRecord(availability['shipToLocationAvailability']);
  const quantity = shipToLocation === null ? null : asNumber(shipToLocation['quantity']);
  const product = asRecord(record['product']);

  return {
    externalId: sku,
    parentExternalId: null,
    kind: 'inventory_item',
    sku,
    title: product === null ? null : asString(product['title']),
    quantity,
    priceAmount: null,
    priceCurrency: null,
    providerStatus: null,
    managementOrigin: 'inventory_api',
    inventoryEligible: true,
    ineligibleReason: null,
    raw: record,
  };
}

/**
 * An offer: the listing of an inventory item.
 *
 * An offer with no listing identifier is unpublished, which section 13 imports
 * deliberately — a seller's draft is part of their catalog, and hiding it would
 * make the import look wrong to anybody comparing it against Seller Hub.
 * Ineligible, though: there is no live listing to carry a quantity.
 */
export function mapOffer(entry: unknown, sku: string): MappedItem | null {
  const record = asRecord(entry);

  if (record === null) {
    return null;
  }

  const offerId = asString(record['offerId']);

  if (offerId === null) {
    return null;
  }

  const listingId = asString(asRecord(record['listing'])?.['listingId'] ?? null);
  const price = asRecord(record['pricingSummary'])?.['price'];
  const priceRecord = asRecord(price ?? null);
  const status = asString(record['status']);
  const published = listingId !== null;

  return {
    externalId: offerId,
    parentExternalId: sku,
    kind: 'offer',
    sku,
    title: null,
    quantity: asNumber(record['availableQuantity']),
    priceAmount: priceRecord === null ? null : asString(priceRecord['value']),
    priceCurrency: priceRecord === null ? null : asString(priceRecord['currency']),
    providerStatus: status ?? (published ? 'PUBLISHED' : 'UNPUBLISHED'),
    managementOrigin: 'inventory_api',
    inventoryEligible: published,
    ineligibleReason: published ? null : 'this offer has not been published to eBay yet',
    raw: record,
  };
}

export interface MappedLocation {
  readonly externalId: string;
  readonly name: string | null;
  readonly merchantKey: string | null;
  readonly enabled: boolean;
  readonly raw: Record<string, unknown>;
}

export function mapLocation(entry: unknown): MappedLocation | null {
  const record = asRecord(entry);

  if (record === null) {
    return null;
  }

  const key = asString(record['merchantLocationKey']);

  if (key === null) {
    return null;
  }

  return {
    externalId: key,
    name: asString(record['name']),
    merchantKey: key,
    enabled: asString(record['merchantLocationStatus']) !== 'DISABLED',
    raw: record,
  };
}

export interface MappedPolicy {
  readonly externalId: string;
  readonly policyType: 'payment' | 'return' | 'fulfillment';
  readonly name: string | null;
  readonly marketplace: string | null;
  readonly raw: Record<string, unknown>;
}

export function mapPolicy(
  entry: unknown,
  policyType: 'payment' | 'return' | 'fulfillment',
  idKey: string,
): MappedPolicy | null {
  const record = asRecord(entry);

  if (record === null) {
    return null;
  }

  const id = asString(record[idKey]);

  if (id === null) {
    return null;
  }

  return {
    externalId: id,
    policyType,
    name: asString(record['name']),
    marketplace: asString(record['marketplaceId']),
    raw: record,
  };
}

export interface MappedOrderLine {
  readonly externalId: string;
  readonly itemExternalId: string | null;
  readonly variationExternalId: string | null;
  readonly sku: string | null;
  readonly quantity: number;
  readonly quantityFulfilled: number;
  readonly unitAmount: string | null;
  readonly currency: string | null;
  readonly raw: Record<string, unknown>;
}

export interface MappedOrder {
  readonly externalId: string;
  readonly externalReference: string | null;
  readonly placedAt: Date | null;
  readonly updatedAt: Date | null;
  readonly providerStatus: string | null;
  readonly totalAmount: string | null;
  readonly totalCurrency: string | null;
  readonly buyerExternalId: string | null;
  readonly lines: readonly MappedOrderLine[];
  readonly raw: Record<string, unknown>;
}

/**
 * An order.
 *
 * The buyer is reduced to eBay's identifier for them and nothing else. Section
 * 13 makes account-deletion compliance mandatory *because* buyer data is
 * stored, and the cheapest way to comply is to store almost none of it: what a
 * deletion request arrives naming is the identifier, so that is what has to be
 * findable. Names and addresses are collected when fulfilment needs them.
 */
export function mapOrder(entry: unknown): MappedOrder | null {
  const record = asRecord(entry);

  if (record === null) {
    return null;
  }

  const orderId = asString(record['orderId']);

  if (orderId === null) {
    return null;
  }

  const total = asRecord(asRecord(record['pricingSummary'])?.['total'] ?? null);
  const buyer = asRecord(record['buyer']);

  const lines = asArray(record['lineItems'])
    .map(mapOrderLine)
    .filter((line): line is MappedOrderLine => line !== null);

  return {
    externalId: orderId,
    externalReference: asString(record['legacyOrderId']),
    placedAt: asDate(record['creationDate']),
    updatedAt: asDate(record['lastModifiedDate']),
    providerStatus: asString(record['orderFulfillmentStatus']),
    totalAmount: total === null ? null : asString(total['value']),
    totalCurrency: total === null ? null : asString(total['currency']),
    buyerExternalId: buyer === null ? null : asString(buyer['username']),
    lines,
    raw: record,
  };
}

function mapOrderLine(entry: unknown): MappedOrderLine | null {
  const record = asRecord(entry);

  if (record === null) {
    return null;
  }

  const lineItemId = asString(record['lineItemId']);
  const quantity = asNumber(record['quantity']);

  if (lineItemId === null || quantity === null || quantity <= 0) {
    return null;
  }

  const cost = asRecord(record['lineItemCost']);
  const fulfilledCount = asNumber(record['quantityShipped']) ?? 0;

  return {
    externalId: lineItemId,
    itemExternalId: asString(record['legacyItemId']),
    variationExternalId: asString(record['legacyVariationId']),
    sku: asString(record['sku']),
    quantity,
    // Clamped, because the database refuses more shipped than sold and eBay has
    // been known to report a fulfilment against a cancelled line.
    quantityFulfilled: Math.min(Math.max(fulfilledCount, 0), quantity),
    unitAmount: cost === null ? null : asString(cost['value']),
    currency: cost === null ? null : asString(cost['currency']),
    raw: record,
  };
}

// ---------------------------------------------------------------------------
// Reading eBay
// ---------------------------------------------------------------------------

type Call =
  | { readonly ok: true; readonly body: Record<string, unknown> }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

async function get(options: EbayImportOptions, path: string): Promise<Call> {
  const credential = await options.accessToken();

  if (credential === null) {
    return { ok: false, reason: 'no usable credentials', retryable: false };
  }

  const outcome = await options.http.send({
    method: 'GET',
    url: `${hostsFor(options.environment).apiBase}${path}`,
    headers: {
      authorization: `Bearer ${credential}`,
      accept: 'application/json',
      'x-ebay-c-marketplace-id': 'EBAY_US',
    },
    timeoutMs: 30_000,
    maxBytes: 4 * 1024 * 1024,
  });

  if (!outcome.ok) {
    return { ok: false, reason: outcome.kind, retryable: outcome.kind !== 'blocked' };
  }

  const status = outcome.response.status;

  if (status === 401 || status === 403) {
    // Not retryable: repeating a rejected credential is how an account gets
    // locked, and the fix is always a human reauthorizing.
    return { ok: false, reason: `http_${String(status)}`, retryable: false };
  }

  if (status === 429 || status >= 500) {
    return { ok: false, reason: `http_${String(status)}`, retryable: true };
  }

  if (status !== 200) {
    return { ok: false, reason: `http_${String(status)}`, retryable: false };
  }

  const body = parseJson(outcome.response.body);

  return body === null
    ? { ok: false, reason: 'unparseable response', retryable: true }
    : { ok: true, body };
}

function readOffset(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 0;
  }

  const parsed = Number.parseInt(cursor, 10);

  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function parseJson(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);

    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asDate(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }

  const parsed = Date.parse(value);

  return Number.isNaN(parsed) ? null : new Date(parsed);
}

/** Every eBay stream, for a caller that wants to import a whole connection. */
export function ebayStreams(options: EbayImportOptions): ImportStream<never>[] {
  return [
    locationStream(options),
    policyStream(options),
    inventoryStream(options),
    orderStream(options),
  ] as unknown as ImportStream<never>[];
}

export type { PageFetcher, SweepContext, WriteContext };
