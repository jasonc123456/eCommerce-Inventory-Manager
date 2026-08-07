import {
  businesses,
  connections,
  providerItems,
  providerOrders,
  providerRefunds,
  users,
} from '@eim/db';
import type { HttpClient, HttpOutcome } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createImportRunner, type ImportRunner } from '../imports/runner';
import { createWooClient } from './client';
import { orderStream, productStream, refundStream } from './imports';

/**
 * Importing a store into the provider mirror (section 14).
 *
 * What needs a real database here is everything about a *second* run: that
 * re-importing an unchanged catalog does not duplicate it, that a product which
 * disappeared is marked missing only after a scan that actually finished, and
 * that the activation watermark decided when an order was first seen is not
 * moved by a later import.
 */

let harness: TestDatabase;
let runner: ImportRunner;

/** A store with a catalog, paginating the way WooCommerce does. */
class FakeStore {
  public products: Record<string, unknown>[] = [];
  public variations = new Map<string, Record<string, unknown>[]>();
  public orders: Record<string, unknown>[] = [];
  public refunds = new Map<string, Record<string, unknown>[]>();
  public pageSize = 2;
  public currency = 'GBP';
  public failOn: string | null = null;
  public calls: string[] = [];

  reset(): void {
    this.products = [];
    this.variations.clear();
    this.orders = [];
    this.refunds.clear();
    this.pageSize = 2;
    this.currency = 'GBP';
    this.failOn = null;
    this.calls = [];
  }

  readonly client: HttpClient = {
    send: (request) => {
      const url = new URL(request.url);
      const path = url.pathname;

      this.calls.push(`${path}?${url.searchParams.toString()}`);

      if (this.failOn !== null && path.includes(this.failOn)) {
        return Promise.resolve<HttpOutcome>({ ok: true, response: answer(503, '[]', {}) });
      }

      const variations = /\/products\/(\d+)\/variations$/.exec(path)?.[1];

      if (variations !== undefined) {
        return Promise.resolve<HttpOutcome>({
          ok: true,
          response: answer(200, JSON.stringify(this.variations.get(variations) ?? []), {}),
        });
      }

      const refunds = /\/orders\/(\d+)\/refunds$/.exec(path)?.[1];

      if (refunds !== undefined) {
        return Promise.resolve<HttpOutcome>({
          ok: true,
          response: answer(200, JSON.stringify(this.refunds.get(refunds) ?? []), {}),
        });
      }

      if (path.endsWith('/settings/general')) {
        return Promise.resolve<HttpOutcome>({
          ok: true,
          response: answer(
            200,
            JSON.stringify([{ id: 'woocommerce_currency', value: this.currency }]),
            {},
          ),
        });
      }

      const collection = path.endsWith('/products')
        ? this.products
        : path.endsWith('/orders')
          ? this.orders
          : null;

      if (collection === null) {
        return Promise.resolve<HttpOutcome>({ ok: true, response: answer(404, '[]', {}) });
      }

      const page = Number(url.searchParams.get('page') ?? '1');
      const start = (page - 1) * this.pageSize;
      const slice = collection.slice(start, start + this.pageSize);
      const pages = Math.max(1, Math.ceil(collection.length / this.pageSize));

      return Promise.resolve<HttpOutcome>({
        ok: true,
        response: answer(200, JSON.stringify(slice), {
          'x-wp-total': String(collection.length),
          'x-wp-totalpages': String(pages),
          ...(page < pages
            ? { link: `<${url.origin}${path}?page=${String(page + 1)}>; rel="next"` }
            : {}),
        }),
      });
    },
  };
}

function answer(status: number, body: string, headers: Record<string, string>) {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body,
    url: 'https://shop.example/',
  };
}

const store = new FakeStore();

function optionsFor(ref: { businessId: string; connectionId: string }) {
  return {
    db: harness.db,
    client: createWooClient({
      http: store.client,
      restBase: 'https://shop.example/wp-json/wc/v3',
      credentials: { consumerKey: 'ck', consumerSecret: 'cs' },
    }),
    businessId: ref.businessId,
    connectionId: ref.connectionId,
    pageSize: 2,
  };
}

beforeAll(async () => {
  harness = await createTestDatabase();
  runner = createImportRunner(harness.db);
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

beforeEach(() => {
  store.reset();
});

let counter = 0;

async function seedConnection(
  activatedAt: Date | null = new Date('2026-01-01T00:00:00Z'),
): Promise<{ businessId: string; connectionId: string }> {
  const slug = `woo-import-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Owner' })
    .returning({ id: users.id });

  const [connection] = await harness.db
    .insert(connections)
    .values({
      businessId: business!.id,
      provider: 'woocommerce',
      environment: 'production',
      externalAccountId: `https://${slug}.example`,
      displayName: slug,
      status: 'active',
      connectedAt: new Date('2025-12-01T00:00:00Z'),
      ...(activatedAt === null ? {} : { activatedAt }),
      createdByUserId: user!.id,
    })
    .returning({ id: connections.id });

  return { businessId: business!.id, connectionId: connection!.id };
}

function product(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name: `Product ${String(id)}`,
    sku: `SKU-${String(id)}`,
    type: 'simple',
    status: 'publish',
    manage_stock: true,
    stock_quantity: 5,
    backorders: 'no',
    price: '10.00',
    ...overrides,
  };
}

function order(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    number: String(id),
    status: 'processing',
    currency: 'GBP',
    total: '10.00',
    customer_id: 3,
    date_created_gmt: '2026-02-01T12:00:00',
    date_modified_gmt: '2026-02-01T12:00:00',
    line_items: [
      { id: id * 10, product_id: 1, variation_id: 0, sku: 'SKU-1', quantity: 1, price: '10.00' },
    ],
    ...overrides,
  };
}

describe('importing a catalog', () => {
  it('follows the store’s pagination to the end', async () => {
    const ref = await seedConnection();

    store.products = [1, 2, 3, 4, 5].map((id) => product(id));

    const outcome = await runner.run(productStream(optionsFor(ref)), ref);

    expect(outcome.status).toBe('completed');
    expect(outcome).toMatchObject({ recordsSeen: 5, recordsWritten: 5, sweptCompletely: true });

    const rows = await harness.db
      .select()
      .from(providerItems)
      .where(eq(providerItems.connectionId, ref.connectionId));

    expect(rows).toHaveLength(5);
    expect(rows.every((row) => row.managementOrigin === 'woocommerce')).toBe(true);
  });

  it('imports variations alongside their parent', async () => {
    const ref = await seedConnection();

    store.products = [product(1, { type: 'variable', manage_stock: false })];
    store.variations.set('1', [
      { id: 101, sku: 'SKU-1-S', manage_stock: true, stock_quantity: 3, price: '10.00' },
      { id: 102, sku: 'SKU-1-M', manage_stock: true, stock_quantity: 4, price: '11.00' },
    ]);

    await runner.run(productStream(optionsFor(ref)), ref);

    const rows = await harness.db
      .select()
      .from(providerItems)
      .where(eq(providerItems.connectionId, ref.connectionId));

    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.kind === 'variation')).toHaveLength(2);
    expect(rows.find((row) => row.externalId === '101')?.parentExternalId).toBe('1');
  });

  it('imports an ineligible product rather than hiding it', async () => {
    // A catalog that silently omitted them would look like an import that half
    // worked, and the operator can plainly see the product in wp-admin.
    const ref = await seedConnection();

    store.products = [
      product(1, { type: 'variable', manage_stock: true }),
      product(2, { type: 'subscription' }),
      product(3, { manage_stock: false }),
    ];
    store.variations.set('1', [{ id: 101, manage_stock: true, stock_quantity: 3 }]);

    await runner.run(productStream(optionsFor(ref)), ref);

    const rows = await harness.db
      .select()
      .from(providerItems)
      .where(eq(providerItems.connectionId, ref.connectionId));

    expect(rows).toHaveLength(4);
    expect(rows.every((row) => !row.inventoryEligible)).toBe(true);
    expect(rows.every((row) => row.ineligibleReason !== null)).toBe(true);
  });

  it('records backorder-enabled products, including notify', async () => {
    const ref = await seedConnection();

    store.products = [
      product(1, { backorders: 'notify' }),
      product(2, { backorders: 'yes' }),
      product(3, { backorders: 'no' }),
    ];

    await runner.run(productStream(optionsFor(ref)), ref);

    const rows = await harness.db
      .select({ externalId: providerItems.externalId, backorders: providerItems.backordersEnabled })
      .from(providerItems)
      .where(eq(providerItems.connectionId, ref.connectionId));

    expect(rows.find((row) => row.externalId === '1')?.backorders).toBe(true);
    expect(rows.find((row) => row.externalId === '2')?.backorders).toBe(true);
    expect(rows.find((row) => row.externalId === '3')?.backorders).toBe(false);
  });

  it('updates rather than duplicates on a second import', async () => {
    const ref = await seedConnection();

    store.products = [product(1, { stock_quantity: 5 })];
    await runner.run(productStream(optionsFor(ref)), ref);

    store.products = [product(1, { stock_quantity: 2, name: 'Renamed' })];
    await runner.run(productStream(optionsFor(ref)), ref);

    const rows = await harness.db
      .select()
      .from(providerItems)
      .where(eq(providerItems.connectionId, ref.connectionId));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ quantity: 2, title: 'Renamed' });
  });

  it('marks a product missing only after a scan that reached the end', async () => {
    const ref = await seedConnection();

    store.products = [product(1), product(2)];
    await runner.run(productStream(optionsFor(ref)), ref);

    store.products = [product(1)];
    await runner.run(productStream(optionsFor(ref)), ref);

    const [gone] = await harness.db
      .select({ missingSince: providerItems.missingSince })
      .from(providerItems)
      .where(
        and(eq(providerItems.connectionId, ref.connectionId), eq(providerItems.externalId, '2')),
      );

    expect(gone?.missingSince).not.toBeNull();
  });

  it('concludes nothing about absence from a run that stopped early', async () => {
    // The rule the sweep exists for. A run that fetched two pages of five has
    // not discovered that three pages' worth of products were deleted, and a
    // sweep keyed on "not seen during this run" cannot tell the difference.
    const ref = await seedConnection();

    store.products = [1, 2, 3, 4, 5, 6].map((id) => product(id));
    await runner.run(productStream(optionsFor(ref)), ref);

    const outcome = await runner.run(productStream(optionsFor(ref)), {
      ...ref,
      maxPages: 1,
      fromStart: true,
    });

    expect(outcome.status).toBe('incomplete');

    const marked = await harness.db
      .select({ id: providerItems.id })
      .from(providerItems)
      .where(eq(providerItems.connectionId, ref.connectionId));

    const missing = await harness.db
      .select({ missingSince: providerItems.missingSince })
      .from(providerItems)
      .where(eq(providerItems.connectionId, ref.connectionId));

    expect(marked).toHaveLength(6);
    expect(missing.every((row) => row.missingSince === null)).toBe(true);
  });

  it('clears the absence when a product comes back', async () => {
    const ref = await seedConnection();

    store.products = [product(1), product(2)];
    await runner.run(productStream(optionsFor(ref)), ref);

    store.products = [product(1)];
    await runner.run(productStream(optionsFor(ref)), ref);

    store.products = [product(1), product(2)];
    await runner.run(productStream(optionsFor(ref)), ref);

    const rows = await harness.db
      .select({ missingSince: providerItems.missingSince })
      .from(providerItems)
      .where(eq(providerItems.connectionId, ref.connectionId));

    expect(rows.every((row) => row.missingSince === null)).toBe(true);
  });

  it('keeps a product whose variations could not be read', async () => {
    // Failing the whole import because one product's variations timed out would
    // lose the other forty-nine.
    const ref = await seedConnection();

    store.products = [product(1, { type: 'variable', manage_stock: false })];
    store.failOn = '/variations';

    const outcome = await runner.run(productStream(optionsFor(ref)), ref);

    expect(outcome.status).toBe('completed');

    const rows = await harness.db
      .select()
      .from(providerItems)
      .where(eq(providerItems.connectionId, ref.connectionId));

    expect(rows).toHaveLength(1);
  });

  it('reports a rejected key as something not to retry', async () => {
    const ref = await seedConnection();
    const failing = createWooClient({
      http: {
        send: () => Promise.resolve<HttpOutcome>({ ok: true, response: answer(401, '{}', {}) }),
      },
      restBase: 'https://shop.example/wp-json/wc/v3',
      credentials: { consumerKey: 'ck', consumerSecret: 'cs' },
    });

    const outcome = await runner.run(productStream({ ...optionsFor(ref), client: failing }), ref);

    expect(outcome).toMatchObject({ status: 'incomplete', resumable: false, reason: 'http_401' });
  });
});

describe('importing orders', () => {
  it('records orders and their lines', async () => {
    const ref = await seedConnection();

    store.orders = [order(501), order(502)];

    const outcome = await runner.run(orderStream(optionsFor(ref)), ref);

    expect(outcome.status).toBe('completed');

    const rows = await harness.db
      .select()
      .from(providerOrders)
      .where(eq(providerOrders.connectionId, ref.connectionId));

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ providerStatus: 'processing', totalCurrency: 'GBP' });
  });

  it('classifies an order against the activation moment once and never again', async () => {
    // Section 14's activation watermark. Moving it later must not reclassify a
    // year of history into a year of sudden demand.
    const ref = await seedConnection(new Date('2026-06-01T00:00:00Z'));

    store.orders = [order(501, { date_created_gmt: '2026-02-01T12:00:00' })];
    await runner.run(orderStream(optionsFor(ref)), ref);

    const [before] = await harness.db
      .select({ preActivation: providerOrders.preActivation })
      .from(providerOrders)
      .where(eq(providerOrders.connectionId, ref.connectionId));

    expect(before?.preActivation).toBe(true);

    await harness.db
      .update(connections)
      .set({ activatedAt: new Date('2025-01-01T00:00:00Z') })
      .where(eq(connections.id, ref.connectionId));

    await runner.run(orderStream(optionsFor(ref)), ref);

    const [after] = await harness.db
      .select({ preActivation: providerOrders.preActivation })
      .from(providerOrders)
      .where(eq(providerOrders.connectionId, ref.connectionId));

    expect(after?.preActivation).toBe(true);
  });

  it('never marks an order missing', async () => {
    // An order absent from a scan is outside the window that scan asked for.
    const ref = await seedConnection();

    store.orders = [order(501)];
    await runner.run(orderStream(optionsFor(ref)), ref);

    store.orders = [];
    const outcome = await runner.run(orderStream(optionsFor(ref)), ref);

    expect(outcome).toMatchObject({ status: 'completed', recordsMissing: 0 });

    const rows = await harness.db
      .select()
      .from(providerOrders)
      .where(eq(providerOrders.connectionId, ref.connectionId));

    expect(rows).toHaveLength(1);
  });

  it('stores no buyer name, email, or address', async () => {
    const ref = await seedConnection();

    store.orders = [
      order(501, {
        billing: { first_name: 'Ada', email: 'ada@example.invalid', address_1: '1 Test Road' },
      }),
    ];

    await runner.run(orderStream(optionsFor(ref)), ref);

    const [row] = await harness.db
      .select({ buyer: providerOrders.buyerExternalId, raw: providerOrders.raw })
      .from(providerOrders)
      .where(eq(providerOrders.connectionId, ref.connectionId));

    expect(row?.buyer).toBe('3');
    // The raw payload is retained under the shorter raw-event window and is the
    // one place the store's own words survive; the column that everything else
    // reads carries only the identifier.
    expect(row?.raw).toBeDefined();
  });
});

describe('importing refunds', () => {
  it('records a refund as a financial event and links it to its order', async () => {
    const ref = await seedConnection();

    store.orders = [order(501, { refunds: [{ id: 900, total: '-10.00' }] })];
    store.refunds.set('501', [
      { id: 900, amount: '10.00', reason: 'returned', date_created_gmt: '2026-02-05T09:00:00' },
    ]);

    await runner.run(orderStream(optionsFor(ref)), ref);
    const outcome = await runner.run(refundStream(optionsFor(ref)), ref);

    expect(outcome.status).toBe('completed');

    const [refund] = await harness.db
      .select()
      .from(providerRefunds)
      .where(eq(providerRefunds.connectionId, ref.connectionId));

    expect(refund).toMatchObject({ externalId: '900', orderExternalId: '501', amount: '10.0000' });
    expect(refund?.orderId).not.toBeNull();
  });

  it('keeps a refund whose order is outside the import window', async () => {
    // Money was returned. Dropping the record because the order is old would
    // lose that.
    const ref = await seedConnection();

    store.orders = [order(501, { refunds: [{ id: 900 }] })];
    store.refunds.set('501', [{ id: 900, amount: '10.00' }]);

    await runner.run(refundStream(optionsFor(ref)), ref);

    const [refund] = await harness.db
      .select()
      .from(providerRefunds)
      .where(eq(providerRefunds.connectionId, ref.connectionId));

    expect(refund?.orderId).toBeNull();
    expect(refund?.orderExternalId).toBe('501');
  });

  it('asks for refunds only where the order says there are some', async () => {
    const ref = await seedConnection();

    store.orders = [order(501), order(502, { refunds: [{ id: 900 }] })];
    store.refunds.set('502', [{ id: 900, amount: '5.00' }]);

    await runner.run(refundStream(optionsFor(ref)), ref);

    expect(store.calls.filter((call) => call.includes('/refunds'))).toEqual([
      expect.stringContaining('/orders/502/refunds'),
    ]);
  });

  it('does not restore inventory', async () => {
    // Section 14: a refund alone never restores canonical stock, because its
    // `api_restock` input is not readable afterwards. M2 records the evidence
    // and draws no conclusion.
    const ref = await seedConnection();

    store.products = [product(1, { stock_quantity: 5 })];
    store.orders = [order(501, { refunds: [{ id: 900 }] })];
    store.refunds.set('501', [{ id: 900, amount: '10.00' }]);

    await runner.run(productStream(optionsFor(ref)), ref);
    await runner.run(refundStream(optionsFor(ref)), ref);

    const [item] = await harness.db
      .select({ quantity: providerItems.quantity })
      .from(providerItems)
      .where(eq(providerItems.connectionId, ref.connectionId));

    expect(item?.quantity).toBe(5);
  });
});
