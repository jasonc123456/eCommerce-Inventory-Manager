import {
  connections,
  providerItems,
  providerOrderLines,
  providerOrders,
  providerRefunds,
  type Database,
} from '@eim/db';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';

import type { ImportStream, PageFetcher, SweepContext, WriteContext } from '../imports/runner';
import { nextPageLink, parseJsonArray, totalPages, type WooClient } from './client';

/**
 * Reading a store's catalog and orders (section 14).
 *
 * Everything here is a read. M2 imports and stops: the records land in the
 * provider mirror, which is a record of what the store said rather than a
 * statement about what this application believes.
 *
 * Three decisions worth stating, because each looks like a detail and is not.
 *
 * A variable product that manages stock at the *parent* is inventory-ineligible.
 * WooCommerce lets a variable product hold one quantity covering every variation,
 * and in that mode the variations have no quantity of their own — so a mapping
 * from a variation to an eBay listing has nothing to read and nothing to write.
 * Section 6 makes those ineligible with a guided remediation path rather than
 * guessed at, because the alternative is writing a variation's quantity into a
 * field the store ignores while the parent's number goes on governing sales.
 *
 * Ineligible records are imported, not skipped. Section 14 requires unsupported
 * inventory entities to be ineligible rather than guessed, and recording them
 * with the reason is what lets the interface explain why a product the operator
 * can plainly see in wp-admin cannot be mapped. A catalog that silently omitted
 * them would look like an import that half worked.
 *
 * Refunds are financial events and never restore stock. Section 14 is explicit:
 * a refund's `api_restock` input is not readable afterwards, so nothing here can
 * tell whether the shopkeeper ticked it. The refund is recorded, and a nearby
 * quantity increase becomes a restock candidate for a person to confirm — which
 * is M4's work, and is why this file writes the evidence and draws no conclusion.
 */

export interface WooImportOptions {
  readonly db: Database;
  readonly client: WooClient;
  readonly businessId: string;
  readonly connectionId: string;
  /** How many records to ask for per page. WooCommerce caps this at 100. */
  readonly pageSize?: number;
}

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

/**
 * The catalog: products, with their variations folded in.
 *
 * The variation read is an N+1 and deliberately so — WooCommerce has no bulk
 * variation route that spans products. Doing it here, inside a paged import with
 * a page budget, keeps the cost visible and bounded rather than spread across the
 * application.
 */
export function productStream(options: WooImportOptions): ImportStream<MappedProduct> {
  const pageSize = Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  // Resolved once per run and remembered. A product carries a price and no
  // currency, because in WooCommerce the currency is a property of the store.
  let currency: string | null | undefined;

  return {
    name: 'woocommerce_products',

    async fetchPage(request) {
      const page = readPage(request.cursor);

      currency ??= await storeCurrency(options);
      const call = await get(
        options,
        `/products?per_page=${String(pageSize)}&page=${String(page)}&status=any&orderby=id&order=asc`,
      );

      if (!call.ok) {
        return call;
      }

      const mapped: MappedProduct[] = [];

      for (const entry of call.rows) {
        const product = mapProduct(entry, currency);

        if (product === null) {
          continue;
        }

        mapped.push(product);

        if (product.kind !== 'product' || product.type !== 'variable') {
          continue;
        }

        // A failure here degrades the record rather than failing the page: a
        // product whose variations could not be read is still a product, and
        // failing the whole import because one product's variations timed out
        // would lose the other forty-nine.
        const variations = await get(
          options,
          `/products/${product.externalId}/variations?per_page=${String(MAX_PAGE_SIZE)}`,
        );

        if (variations.ok) {
          for (const row of variations.rows) {
            const variation = mapVariation(row, product, currency);

            if (variation !== null) {
              mapped.push(variation);
            }
          }
        }
      }

      return {
        ok: true,
        page: {
          records: mapped,
          nextCursor: call.hasMore ? String(page + 1) : undefined,
          checkpoint: { page, totalPages: call.totalPages },
        },
      };
    },

    write: (records, context) => writeProducts(options.db, records, context),
    sweep: (context) => sweepProducts(options.db, context),
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
  options: WooImportOptions & { readonly since?: Date },
): ImportStream<MappedWooOrder> {
  const pageSize = Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  return {
    name: 'woocommerce_orders',

    async fetchPage(request) {
      const page = readPage(request.cursor);
      const since = options.since ?? new Date(Date.now() - 90 * 24 * 60 * 60_000);

      const call = await get(
        options,
        `/orders?per_page=${String(pageSize)}&page=${String(page)}` +
          `&status=any&orderby=modified&order=asc&modified_after=${encodeURIComponent(
            since.toISOString().replace(/\.\d{3}Z$/, ''),
          )}`,
      );

      if (!call.ok) {
        return call;
      }

      const mapped = call.rows.map(mapOrder).filter((row): row is MappedWooOrder => row !== null);

      return {
        ok: true,
        page: {
          records: mapped,
          nextCursor: call.hasMore ? String(page + 1) : undefined,
          checkpoint: { page, totalPages: call.totalPages, since: since.toISOString() },
        },
      };
    },

    write: (records, context) => writeOrders(options.db, records, context),
  };
}

/**
 * Refunds, read per order.
 *
 * WooCommerce has no collection route spanning refunds, so this walks the same
 * recently-modified orders the order stream does and reads each one's refunds.
 * That makes it a separate stream rather than part of the order stream, because
 * the two have different failure modes: an order import that could not read one
 * order's refunds has still imported the order correctly, and conflating them
 * would fail both.
 */
export function refundStream(
  options: WooImportOptions & { readonly since?: Date },
): ImportStream<MappedRefund> {
  const pageSize = Math.min(options.pageSize ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);

  return {
    name: 'woocommerce_refunds',

    async fetchPage(request) {
      const page = readPage(request.cursor);
      const since = options.since ?? new Date(Date.now() - 90 * 24 * 60 * 60_000);

      const call = await get(
        options,
        `/orders?per_page=${String(pageSize)}&page=${String(page)}` +
          `&status=any&orderby=modified&order=asc&modified_after=${encodeURIComponent(
            since.toISOString().replace(/\.\d{3}Z$/, ''),
          )}`,
      );

      if (!call.ok) {
        return call;
      }

      const mapped: MappedRefund[] = [];

      for (const order of call.rows) {
        const orderId = identifier(order['id']);

        if (orderId === null) {
          continue;
        }

        // The order carries a `refunds` summary with identifiers and totals.
        // Present on every order, so the per-order call is made only where there
        // is actually something to read.
        const summary = Array.isArray(order['refunds']) ? order['refunds'] : [];

        if (summary.length === 0) {
          continue;
        }

        const refunds = await get(
          options,
          `/orders/${orderId}/refunds?per_page=${String(MAX_PAGE_SIZE)}`,
        );

        if (!refunds.ok) {
          continue;
        }

        for (const row of refunds.rows) {
          const refund = mapRefund(row, orderId, asString(order['currency']));

          if (refund !== null) {
            mapped.push(refund);
          }
        }
      }

      return {
        ok: true,
        page: {
          records: mapped,
          nextCursor: call.hasMore ? String(page + 1) : undefined,
          checkpoint: { page, totalPages: call.totalPages, since: since.toISOString() },
        },
      };
    },

    write: (records, context) => writeRefunds(options.db, records, context),
  };
}

/** Every WooCommerce stream, for a caller importing a whole store. */
export function woocommerceStreams(
  options: WooImportOptions & { readonly since?: Date },
): ImportStream<never>[] {
  return [
    productStream(options),
    orderStream(options),
    refundStream(options),
  ] as unknown as ImportStream<never>[];
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

async function writeProducts(
  db: Database,
  records: readonly MappedProduct[],
  context: WriteContext,
): Promise<number> {
  if (records.length === 0) {
    return 0;
  }

  // Deduplicated within the page. PostgreSQL refuses to update the same row
  // twice in one statement, and a product and one of its variations can only
  // collide if the store is reporting something impossible — but the store is
  // not this application's to trust.
  const unique = new Map<string, MappedProduct>();

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
        backordersEnabled: record.backordersEnabled,
        priceAmount: record.priceAmount,
        priceCurrency: record.priceCurrency,
        providerStatus: record.providerStatus,
        managementOrigin: 'woocommerce' as const,
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
        backordersEnabled: sql`excluded.backorders_enabled`,
        priceAmount: sql`excluded.price_amount`,
        priceCurrency: sql`excluded.price_currency`,
        providerStatus: sql`excluded.provider_status`,
        managementOrigin: sql`excluded.management_origin`,
        inventoryEligible: sql`excluded.inventory_eligible`,
        ineligibleReason: sql`excluded.ineligible_reason`,
        raw: sql`excluded.raw`,
        lastSeenAt: sql`excluded.last_seen_at`,
        lastImportRunId: sql`excluded.last_import_run_id`,
        // Reappearing clears the absence. A product that came back is not still
        // missing, and leaving the mark would keep warning about it.
        missingSince: sql`null`,
      },
    })
    .returning({ id: providerItems.id });

  return written.length;
}

async function sweepProducts(db: Database, context: SweepContext): Promise<number> {
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
  records: readonly MappedWooOrder[],
  context: WriteContext,
): Promise<number> {
  if (records.length === 0) {
    return 0;
  }

  // The activation moment, read once per page. Orders placed before it are
  // historical: they exist for visibility and deduplication and do not mutate
  // inventory (section 14's activation watermark).
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

async function writeRefunds(
  db: Database,
  records: readonly MappedRefund[],
  context: WriteContext,
): Promise<number> {
  if (records.length === 0) {
    return 0;
  }

  // The order the refund belongs to, where it has already been imported. Null
  // when it has not: a refund on an order outside the import window is still a
  // financial event, and dropping it would lose the record of money returned.
  const orders = await db
    .select({ id: providerOrders.id, externalId: providerOrders.externalId })
    .from(providerOrders)
    .where(eq(providerOrders.connectionId, context.connectionId));

  const byExternalId = new Map(orders.map((row) => [row.externalId, row.id]));

  const written = await db
    .insert(providerRefunds)
    .values(
      records.map((record) => ({
        businessId: context.businessId,
        connectionId: context.connectionId,
        orderId: byExternalId.get(record.orderExternalId) ?? null,
        externalId: record.externalId,
        orderExternalId: record.orderExternalId,
        amount: record.amount,
        currency: record.currency,
        reason: record.reason,
        refundedAt: record.refundedAt,
        raw: record.raw,
        lastSeenAt: context.startedAt,
      })),
    )
    .onConflictDoUpdate({
      target: [providerRefunds.connectionId, providerRefunds.externalId],
      set: {
        orderId: sql`excluded.order_id`,
        amount: sql`excluded.amount`,
        currency: sql`excluded.currency`,
        reason: sql`excluded.reason`,
        refundedAt: sql`excluded.refunded_at`,
        raw: sql`excluded.raw`,
        lastSeenAt: sql`excluded.last_seen_at`,
      },
    })
    .returning({ id: providerRefunds.id });

  return written.length;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

export interface MappedProduct {
  readonly externalId: string;
  readonly parentExternalId: string | null;
  readonly kind: 'product' | 'variation';
  /** WooCommerce's product type, which decides eligibility. */
  readonly type: string;
  readonly sku: string | null;
  readonly title: string | null;
  readonly quantity: number | null;
  readonly backordersEnabled: boolean;
  readonly priceAmount: string | null;
  readonly priceCurrency: string | null;
  readonly providerStatus: string | null;
  readonly inventoryEligible: boolean;
  readonly ineligibleReason: string | null;
  readonly raw: Record<string, unknown>;
}

/** Product types this application understands well enough to sync quantities for. */
const SUPPORTED_TYPES = new Set(['simple', 'variable']);

export function mapProduct(entry: unknown, currency: string | null = null): MappedProduct | null {
  const record = asRecord(entry);

  if (record === null) {
    return null;
  }

  const id = identifier(record['id']);

  if (id === null) {
    return null;
  }

  const type = asString(record['type']) ?? 'unknown';
  const managesStock = record['manage_stock'] === true;
  const ineligible = productIneligibility(type, managesStock);

  return {
    externalId: id,
    parentExternalId: null,
    kind: 'product',
    type,
    sku: asString(record['sku']),
    title: asString(record['name']),
    quantity: managesStock ? asNumber(record['stock_quantity']) : null,
    backordersEnabled: backordersEnabled(record['backorders']),
    // A price with no currency is not a price, and the database says so. When
    // the store would not report its currency the number is dropped rather than
    // recorded as an amount of nothing in particular.
    priceAmount: currency === null ? null : asDecimal(record['price']),
    priceCurrency: currency === null ? null : asDecimal(record['price']) === null ? null : currency,
    providerStatus: asString(record['status']),
    inventoryEligible: ineligible === null,
    ineligibleReason: ineligible,
    raw: record,
  };
}

/**
 * Why a product cannot carry a synchronized quantity, or null when it can.
 *
 * The `variable` case is the one that matters. A variable product managing stock
 * at the parent holds one quantity covering every variation, and the variations
 * then have none of their own — so nothing this application could map has a
 * number to read or write. Section 6 makes that ineligible with a guided
 * remediation rather than guessed at.
 */
export function productIneligibility(type: string, managesStock: boolean): string | null {
  if (!SUPPORTED_TYPES.has(type)) {
    // Section 14: unsupported plugin-controlled inventory entities are
    // ineligible rather than guessed. A subscription or a bundle has quantity
    // semantics this application does not implement.
    return `this store manages “${type}” products with an extension this application does not support`;
  }

  if (type === 'variable') {
    return managesStock
      ? 'this product manages stock at the parent rather than per variation, so its variations have no quantity of their own; switch stock management to the variation level to map them'
      : null;
  }

  return managesStock
    ? null
    : 'this product does not manage stock in WooCommerce, so it has no quantity to synchronize';
}

export function mapVariation(
  entry: unknown,
  parent: MappedProduct,
  currency: string | null = null,
): MappedProduct | null {
  const record = asRecord(entry);

  if (record === null) {
    return null;
  }

  const id = identifier(record['id']);

  if (id === null) {
    return null;
  }

  const managesStock = record['manage_stock'] === true;
  // A variation inherits its parent's ineligibility: a parent managing stock for
  // the whole product leaves its variations with nothing of their own.
  const parentBlocks = parent.ineligibleReason;

  return {
    externalId: id,
    parentExternalId: parent.externalId,
    kind: 'variation',
    type: 'variation',
    sku: asString(record['sku']),
    title: asString(record['name']),
    quantity: managesStock ? asNumber(record['stock_quantity']) : null,
    backordersEnabled: backordersEnabled(record['backorders']),
    priceAmount: currency === null ? null : asDecimal(record['price']),
    priceCurrency: currency === null ? null : asDecimal(record['price']) === null ? null : currency,
    providerStatus: asString(record['status']),
    inventoryEligible: parentBlocks === null && managesStock,
    ineligibleReason:
      parentBlocks ??
      (managesStock
        ? null
        : 'this variation does not manage its own stock in WooCommerce, so it has no quantity to synchronize'),
    raw: record,
  };
}

/**
 * Whether WooCommerce will sell this past zero.
 *
 * Both `yes` and `notify` allow it; they differ only in whether the shopkeeper
 * gets an email. Section 8 exempts backorder-enabled products from absolute
 * downward writes at zero, so treating `notify` as "no" would clamp a store that
 * deliberately sells on backorder.
 */
export function backordersEnabled(value: unknown): boolean {
  return value === 'yes' || value === 'notify' || value === true;
}

export interface MappedWooOrderLine {
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

export interface MappedWooOrder {
  readonly externalId: string;
  readonly externalReference: string | null;
  readonly placedAt: Date | null;
  readonly updatedAt: Date | null;
  readonly providerStatus: string | null;
  readonly totalAmount: string | null;
  readonly totalCurrency: string | null;
  readonly buyerExternalId: string | null;
  readonly lines: readonly MappedWooOrderLine[];
  readonly raw: Record<string, unknown>;
}

/**
 * An order.
 *
 * The buyer is reduced to WooCommerce's customer identifier and nothing else.
 * The billing block on a Woo order carries a name, an email, and a postal
 * address, and none of it is needed to know that stock moved — so it is not
 * copied out. What is stored is what a later erasure request would arrive
 * naming.
 */
export function mapOrder(entry: unknown): MappedWooOrder | null {
  const record = asRecord(entry);

  if (record === null) {
    return null;
  }

  const id = identifier(record['id']);

  if (id === null) {
    return null;
  }

  const customerId = record['customer_id'];
  const currency = asString(record['currency']);
  const lines = (Array.isArray(record['line_items']) ? record['line_items'] : [])
    .map((line) => mapOrderLine(line, currency))
    .filter((line): line is MappedWooOrderLine => line !== null);

  return {
    externalId: id,
    externalReference: asString(record['number']),
    placedAt: asDate(record['date_created_gmt'] ?? record['date_created']),
    updatedAt: asDate(record['date_modified_gmt'] ?? record['date_modified']),
    providerStatus: asString(record['status']),
    totalAmount: asDecimal(record['total']),
    totalCurrency: currency,
    // A guest checkout is customer 0, which is not a customer. Storing "0" would
    // make every guest order in the store look like one person's.
    buyerExternalId: typeof customerId === 'number' && customerId > 0 ? String(customerId) : null,
    lines,
    raw: record,
  };
}

function mapOrderLine(entry: unknown, currency: string | null): MappedWooOrderLine | null {
  const record = asRecord(entry);

  if (record === null) {
    return null;
  }

  const id = identifier(record['id']);
  const quantity = asNumber(record['quantity']);

  if (id === null || quantity === null || quantity <= 0) {
    return null;
  }

  const variationId = identifier(record['variation_id']);

  return {
    externalId: id,
    itemExternalId: identifier(record['product_id']),
    variationExternalId: variationId,
    sku: asString(record['sku']),
    quantity,
    // WooCommerce core has no per-line fulfilment count. Section 14 says partial
    // shipments live in this application's own records, so zero here is the
    // honest answer rather than a placeholder.
    quantityFulfilled: 0,
    unitAmount: currency === null ? null : asDecimal(record['price'] ?? record['subtotal']),
    currency:
      currency === null
        ? null
        : asDecimal(record['price'] ?? record['subtotal']) === null
          ? null
          : currency,
    raw: record,
  };
}

export interface MappedRefund {
  readonly externalId: string;
  readonly orderExternalId: string;
  readonly amount: string | null;
  readonly currency: string | null;
  readonly reason: string | null;
  readonly refundedAt: Date | null;
  readonly raw: Record<string, unknown>;
}

export function mapRefund(
  entry: unknown,
  orderExternalId: string,
  currency: string | null = null,
): MappedRefund | null {
  const record = asRecord(entry);

  if (record === null) {
    return null;
  }

  const id = identifier(record['id']);

  if (id === null) {
    return null;
  }

  return {
    externalId: id,
    orderExternalId,
    // WooCommerce reports a refund total as a negative number on the order and
    // as a positive one on the refund. Kept as sent, because a sign flipped
    // somewhere in the middle is worse than an inconsistency that is documented.
    amount: asDecimal(record['amount']),
    currency,
    reason: asString(record['reason']),
    refundedAt: asDate(record['date_created_gmt'] ?? record['date_created']),
    raw: record,
  };
}

// ---------------------------------------------------------------------------
// Reading the store
// ---------------------------------------------------------------------------

type Call =
  | {
      readonly ok: true;
      readonly rows: Record<string, unknown>[];
      readonly hasMore: boolean;
      readonly totalPages: number | null;
    }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

async function get(options: WooImportOptions, path: string): Promise<Call> {
  const outcome = await options.client.get(path);

  if (!outcome.ok) {
    return { ok: false, reason: outcome.reason, retryable: outcome.retryable };
  }

  const status = outcome.response.status;

  if (status === 401 || status === 403) {
    // Not retryable: repeating a rejected key is how a store's security plugin
    // decides this application is an attacker, and the fix is always a person
    // supplying a working key.
    return { ok: false, reason: `http_${String(status)}`, retryable: false };
  }

  if (status === 429 || status >= 500) {
    return { ok: false, reason: `http_${String(status)}`, retryable: true };
  }

  if (status !== 200) {
    return { ok: false, reason: `http_${String(status)}`, retryable: false };
  }

  const rows = parseJsonArray(outcome.response.body);
  const pages = totalPages(outcome.response.headers);

  return {
    ok: true,
    rows,
    // The store's own `rel="next"` is preferred over the page counter. Totals
    // are computed when the page is built, so a catalog being edited during an
    // import renumbers underneath a counter; the link is the store's answer to
    // "what comes after this", and its absence is how it says there is nothing.
    hasMore: nextPageLink(outcome.response.headers) !== null || (pages === null && rows.length > 0),
    totalPages: pages,
  };
}

/**
 * What the store prices in.
 *
 * A WooCommerce product reports a price and no currency, because the currency
 * belongs to the store rather than to the product. Read once per run: it cannot
 * change part-way through, and asking per product would be a call per row.
 *
 * Null when the store would not say. Recording a bare number as a price would
 * make every comparison against an eBay listing a comparison between an amount
 * and an amount of nothing in particular.
 */
async function storeCurrency(options: WooImportOptions): Promise<string | null> {
  const call = await get(options, '/settings/general');

  if (!call.ok) {
    return null;
  }

  const setting = call.rows.find((row) => row['id'] === 'woocommerce_currency');
  const value = setting?.['value'];

  return typeof value === 'string' && /^[A-Za-z]{3}$/.test(value) ? value.toUpperCase() : null;
}

function readPage(cursor: string | undefined): number {
  if (cursor === undefined) {
    return 1;
  }

  const parsed = Number.parseInt(cursor, 10);

  return Number.isInteger(parsed) && parsed >= 1 ? parsed : 1;
}

/** WooCommerce sends identifiers as numbers; everything here treats them as text. */
function identifier(value: unknown): string | null {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return String(value);
  }

  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  // WooCommerce sends `stock_quantity` as a number and as a numeric string
  // depending on the route and the version.
  // Bounded rather than open-ended. The value arrives from a remote store, and
  // a quantity of a thousand digits is not a quantity.
  if (typeof value === 'string' && /^-?\d{1,10}$/.test(value.trim())) {
    return Number.parseInt(value, 10);
  }

  return null;
}

/**
 * A monetary amount, as text.
 *
 * Never through a float. WooCommerce sends prices as strings precisely because
 * they are decimals, and a price that has been through a double is a price that
 * may no longer be the one the store quoted.
 */
function asDecimal(value: unknown): string | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  const unsigned = trimmed.startsWith('-') ? trimmed.slice(1) : trimmed;
  const point = unsigned.indexOf('.');
  const whole = point === -1 ? unsigned : unsigned.slice(0, point);
  const fraction = point === -1 ? '' : unsigned.slice(point + 1);

  // Taken apart rather than matched with one pattern. The shape is trivial, and
  // spelling it out keeps the check obviously linear on a value that arrives
  // from a remote store — and lets the lengths be bounded to what the column
  // holds, numeric(18, 4), with room on the fraction so a store using more
  // decimal places has its price rounded by the database rather than dropped.
  if (!isDigits(whole, 1, 14)) {
    return null;
  }

  if (point !== -1 && !isDigits(fraction, 1, 6)) {
    return null;
  }

  return trimmed;
}

function isDigits(value: string, min: number, max: number): boolean {
  if (value.length < min || value.length > max) {
    return false;
  }

  for (const character of value) {
    if (character < '0' || character > '9') {
      return false;
    }
  }

  return true;
}

function asDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }

  // WooCommerce's `_gmt` fields are ISO-8601 with no zone marker and are in UTC.
  // Parsed without one, JavaScript reads them in the server's local time, which
  // moves every order by the host's offset — and the host is a container whose
  // timezone nobody set deliberately.
  const normalized = /Z$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`;
  const parsed = Date.parse(normalized);

  return Number.isNaN(parsed) ? null : new Date(parsed);
}

export type { PageFetcher, SweepContext, WriteContext };
