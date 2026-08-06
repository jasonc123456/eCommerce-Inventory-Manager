import {
  businesses,
  connections,
  memberships,
  providerItems,
  providerLocations,
  providerOrderLines,
  providerOrders,
  providerPolicies,
  users,
} from '@eim/db';
import type { HttpClient, HttpOutcome } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createImportRunner, type ImportRunner } from '../imports/runner';
import { inventoryStream, locationStream, orderStream, policyStream } from './imports';

/**
 * Importing a seller's catalog and orders, end to end (section 13).
 *
 * eBay is a programmable fake. What is being tested is that the streams read
 * what eBay actually sends, paginate the way it actually paginates, and land in
 * the mirror without touching anything canonical.
 *
 * The activation rule gets the most attention: an order imported as current
 * when it should be historical is a year of past sales arriving as a year of
 * sudden demand, and the first thing that happens next is every listing being
 * driven to zero.
 */

let harness: TestDatabase;
let runner: ImportRunner;

class FakeEbay {
  public readonly requests: string[] = [];
  private routes: { match: string; outcome: HttpOutcome }[] = [];

  reset(): void {
    this.requests.length = 0;
    this.routes = [];
  }

  on(match: string, payload: unknown, status = 200): this {
    this.routes.push({
      match,
      outcome: {
        ok: true,
        response: {
          status,
          headers: {},
          body: JSON.stringify(payload),
          url: 'https://api.ebay.com/',
        },
      },
    });

    return this;
  }

  fail(match: string, outcome: HttpOutcome): this {
    this.routes.push({ match, outcome });

    return this;
  }

  readonly client: HttpClient = {
    send: (request) => {
      this.requests.push(request.url);

      // Last registered wins, so a test can override one route of a fixture.
      for (const route of [...this.routes].reverse()) {
        if (request.url.includes(route.match)) {
          return Promise.resolve(route.outcome);
        }
      }

      return Promise.resolve({ ok: false, kind: 'transport', reason: 'ECONNREFUSED' });
    },
  };
}

const ebay = new FakeEbay();

beforeAll(async () => {
  harness = await createTestDatabase();
  runner = createImportRunner(harness.db);
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

beforeEach(() => {
  ebay.reset();
});

let counter = 0;

async function seed(activatedAt: Date | null = new Date('2026-01-01T00:00:00Z')) {
  const slug = `ebay-import-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: `Business ${slug}`, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid` })
    .returning({ id: users.id });

  await harness.db
    .insert(memberships)
    .values({ businessId: business!.id, userId: user!.id, role: 'owner' });

  const [connection] = await harness.db
    .insert(connections)
    .values({
      businessId: business!.id,
      provider: 'ebay',
      environment: 'production',
      externalAccountId: slug,
      displayName: 'Seller',
      status: 'active',
      connectedAt: new Date('2025-12-01T00:00:00Z'),
      activatedAt,
    })
    .returning({ id: connections.id });

  return { businessId: business!.id, connectionId: connection!.id };
}

const optionsFor = (connection: { businessId: string; connectionId: string }, token = 'token') => ({
  db: harness.db,
  http: ebay.client,
  businessId: connection.businessId,
  connectionId: connection.connectionId,
  environment: 'production' as const,
  accessToken: () => Promise.resolve<string | null>(token),
  pageSize: 2,
});

describe('the catalog', () => {
  it('imports inventory items with their offers', async () => {
    ebay
      .on('/inventory_item?', {
        total: 1,
        inventoryItems: [
          {
            sku: 'WIDGET-1',
            product: { title: 'A widget' },
            availability: { shipToLocationAvailability: { quantity: 7 } },
          },
        ],
      })
      .on('/offer?sku=WIDGET-1', {
        offers: [
          {
            offerId: 'offer-1',
            availableQuantity: 7,
            listing: { listingId: '110000000001' },
            pricingSummary: { price: { value: '19.99', currency: 'USD' } },
          },
        ],
      });

    const connection = await seed();
    const outcome = await runner.run(inventoryStream(optionsFor(connection)), connection);

    expect(outcome.status).toBe('completed');

    const rows = await harness.db
      .select()
      .from(providerItems)
      .where(eq(providerItems.connectionId, connection.connectionId));

    expect(rows).toHaveLength(2);

    const item = rows.find((row) => row.kind === 'inventory_item');
    const offer = rows.find((row) => row.kind === 'offer');

    expect(item).toMatchObject({ externalId: 'WIDGET-1', quantity: 7, inventoryEligible: true });
    expect(offer).toMatchObject({
      externalId: 'offer-1',
      parentExternalId: 'WIDGET-1',
      priceCurrency: 'USD',
      inventoryEligible: true,
    });
  });

  it('keeps an item whose offers could not be read', async () => {
    // One SKU's offers timing out must not lose the other ninety-nine items on
    // the page.
    ebay
      .on('/inventory_item?', {
        total: 1,
        inventoryItems: [{ sku: 'WIDGET-2', availability: {} }],
      })
      .fail('/offer?sku=', { ok: false, kind: 'timeout', reason: 'timed out' });

    const connection = await seed();
    const outcome = await runner.run(inventoryStream(optionsFor(connection)), connection);

    expect(outcome.status).toBe('completed');

    const rows = await harness.db
      .select({ externalId: providerItems.externalId })
      .from(providerItems)
      .where(eq(providerItems.connectionId, connection.connectionId));

    expect(rows.map((row) => row.externalId)).toEqual(['WIDGET-2']);
  });

  it('follows pagination to the end', async () => {
    // eBay reports a total and expects the caller to walk offsets to it.
    const items = (skus: string[]) => ({
      total: 3,
      inventoryItems: skus.map((sku) => ({ sku, availability: {} })),
    });

    ebay
      .on('offset=0', items(['A', 'B']))
      .on('offset=2', items(['C']))
      .on('/offer?sku=', { offers: [] });

    const connection = await seed();
    const outcome = await runner.run(inventoryStream(optionsFor(connection)), connection);

    expect(outcome).toMatchObject({ status: 'completed', pagesFetched: 2, recordsSeen: 3 });
  });

  it('marks an unpublished offer ineligible instead of hiding it', async () => {
    ebay
      .on('/inventory_item?', { total: 1, inventoryItems: [{ sku: 'DRAFT-1', availability: {} }] })
      .on('/offer?sku=DRAFT-1', { offers: [{ offerId: 'offer-draft', availableQuantity: 0 }] });

    const connection = await seed();
    await runner.run(inventoryStream(optionsFor(connection)), connection);

    const [offer] = await harness.db
      .select()
      .from(providerItems)
      .where(eq(providerItems.externalId, 'offer-draft'));

    expect(offer?.inventoryEligible).toBe(false);
    expect(offer?.ineligibleReason).toContain('published');
  });

  it('stops without credentials rather than treating the catalog as empty', async () => {
    // An empty answer plus a sweep would mark the entire catalog missing.
    const connection = await seed();

    const outcome = await runner.run(
      inventoryStream({ ...optionsFor(connection), accessToken: () => Promise.resolve(null) }),
      connection,
    );

    expect(outcome).toMatchObject({ status: 'incomplete', resumable: false });
  });

  it('does not retry a rejected credential, and does retry a server error', async () => {
    const connection = await seed();

    ebay.on('/inventory_item?', {}, 401);

    expect(await runner.run(inventoryStream(optionsFor(connection)), connection)).toMatchObject({
      status: 'incomplete',
      resumable: false,
    });

    ebay.on('/inventory_item?', {}, 503);

    expect(await runner.run(inventoryStream(optionsFor(connection)), connection)).toMatchObject({
      status: 'incomplete',
      resumable: true,
    });
  });
});

describe('locations and policies', () => {
  it('imports locations without mapping them to anything', async () => {
    // Guessing which internal warehouse an eBay location means is the guess
    // that sends stock to the wrong place.
    ebay.on('/location?', {
      total: 1,
      locations: [
        { merchantLocationKey: 'WAREHOUSE', name: 'Main', merchantLocationStatus: 'ENABLED' },
      ],
    });

    const connection = await seed();
    await runner.run(locationStream(optionsFor(connection)), connection);

    const [row] = await harness.db
      .select()
      .from(providerLocations)
      .where(eq(providerLocations.connectionId, connection.connectionId));

    expect(row).toMatchObject({ externalId: 'WAREHOUSE', enabled: true });
    expect(row?.mappedLocationId).toBeNull();
  });

  it('imports all three policy families in one run', async () => {
    ebay
      .on('payment_policy', { paymentPolicies: [{ paymentPolicyId: 'p1', name: 'Standard' }] })
      .on('return_policy', { returnPolicies: [{ returnPolicyId: 'r1', name: '30 day' }] })
      .on('fulfillment_policy', {
        fulfillmentPolicies: [{ fulfillmentPolicyId: 'f1', name: 'Economy' }],
      });

    const connection = await seed();
    const outcome = await runner.run(policyStream(optionsFor(connection)), connection);

    expect(outcome).toMatchObject({ status: 'completed', recordsWritten: 3 });

    const rows = await harness.db
      .select({ policyType: providerPolicies.policyType })
      .from(providerPolicies)
      .where(eq(providerPolicies.connectionId, connection.connectionId));

    expect(rows.map((row) => row.policyType).sort()).toEqual(['fulfillment', 'payment', 'return']);
  });

  it('resumes at the policy family it did not reach', async () => {
    ebay
      .on('payment_policy', { paymentPolicies: [{ paymentPolicyId: 'p1' }] })
      .fail('return_policy', { ok: false, kind: 'timeout', reason: 'timed out' });

    const connection = await seed();

    expect(await runner.run(policyStream(optionsFor(connection)), connection)).toMatchObject({
      status: 'incomplete',
    });

    ebay
      .on('return_policy', { returnPolicies: [{ returnPolicyId: 'r1' }] })
      .on('fulfillment_policy', { fulfillmentPolicies: [{ fulfillmentPolicyId: 'f1' }] });

    ebay.requests.length = 0;

    expect(await runner.run(policyStream(optionsFor(connection)), connection)).toMatchObject({
      status: 'completed',
    });

    // The payment family was not read a second time.
    expect(ebay.requests.some((url) => url.includes('payment_policy'))).toBe(false);
  });
});

describe('orders', () => {
  const order = (id: string, creationDate: string) => ({
    orderId: id,
    legacyOrderId: `legacy-${id}`,
    creationDate,
    lastModifiedDate: creationDate,
    orderFulfillmentStatus: 'NOT_STARTED',
    pricingSummary: { total: { value: '19.99', currency: 'USD' } },
    buyer: { username: 'a-buyer' },
    lineItems: [
      {
        lineItemId: `${id}-line-1`,
        legacyItemId: '110000000001',
        sku: 'WIDGET-1',
        quantity: 1,
        lineItemCost: { value: '19.99', currency: 'USD' },
      },
    ],
  });

  it('imports orders with their lines', async () => {
    ebay.on('/order?', { total: 1, orders: [order('order-1', '2026-03-01T00:00:00.000Z')] });

    const connection = await seed();
    const outcome = await runner.run(orderStream(optionsFor(connection)), connection);

    expect(outcome).toMatchObject({ status: 'completed', recordsWritten: 1 });

    const [row] = await harness.db
      .select()
      .from(providerOrders)
      .where(eq(providerOrders.connectionId, connection.connectionId));

    expect(row).toMatchObject({ externalId: 'order-1', buyerExternalId: 'a-buyer' });

    const lines = await harness.db
      .select()
      .from(providerOrderLines)
      .where(eq(providerOrderLines.orderId, row!.id));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ sku: 'WIDGET-1', quantity: 1 });
  });

  it('marks an order placed before activation as historical', async () => {
    // Pre-activation orders exist for visibility and deduplication; they do not
    // mutate inventory.
    ebay.on('/order?', {
      total: 2,
      orders: [
        order('before', '2025-06-01T00:00:00.000Z'),
        order('after', '2026-06-01T00:00:00.000Z'),
      ],
    });

    const connection = await seed(new Date('2026-01-01T00:00:00Z'));
    await runner.run(orderStream(optionsFor(connection)), connection);

    const rows = await harness.db
      .select({ externalId: providerOrders.externalId, pre: providerOrders.preActivation })
      .from(providerOrders)
      .where(eq(providerOrders.connectionId, connection.connectionId));

    expect(rows.find((row) => row.externalId === 'before')?.pre).toBe(true);
    expect(rows.find((row) => row.externalId === 'after')?.pre).toBe(false);
  });

  it('treats every order as historical when the connection was never activated', async () => {
    ebay.on('/order?', { total: 1, orders: [order('any', '2026-06-01T00:00:00.000Z')] });

    const connection = await seed(null);
    await runner.run(orderStream(optionsFor(connection)), connection);

    const [row] = await harness.db
      .select({ pre: providerOrders.preActivation })
      .from(providerOrders)
      .where(eq(providerOrders.connectionId, connection.connectionId));

    expect(row?.pre).toBe(true);
  });

  it('does not reclassify history when the activation moment moves', async () => {
    // Deciding once, at first sight, is what stops a year of past sales
    // becoming a year of sudden demand because somebody re-activated a
    // connection.
    ebay.on('/order?', { total: 1, orders: [order('settled', '2025-06-01T00:00:00.000Z')] });

    const connection = await seed(new Date('2026-01-01T00:00:00Z'));
    await runner.run(orderStream(optionsFor(connection)), connection);

    await harness.db
      .update(connections)
      .set({ activatedAt: new Date('2020-01-01T00:00:00Z') })
      .where(eq(connections.id, connection.connectionId));

    await runner.run(orderStream(optionsFor(connection)), connection);

    const [row] = await harness.db
      .select({ pre: providerOrders.preActivation })
      .from(providerOrders)
      .where(eq(providerOrders.connectionId, connection.connectionId));

    expect(row?.pre).toBe(true);
  });

  it('never marks an order missing, because orders are not withdrawn', async () => {
    ebay.on('/order?', { total: 1, orders: [order('kept', '2026-03-01T00:00:00.000Z')] });

    const connection = await seed();
    await runner.run(orderStream(optionsFor(connection)), connection);

    ebay.on('/order?', { total: 0, orders: [] });
    await runner.run(orderStream(optionsFor(connection)), connection);

    const rows = await harness.db
      .select({ id: providerOrders.id })
      .from(providerOrders)
      .where(eq(providerOrders.connectionId, connection.connectionId));

    expect(rows).toHaveLength(1);
  });

  it('updates an order that changed without duplicating it', async () => {
    ebay.on('/order?', { total: 1, orders: [order('evolving', '2026-03-01T00:00:00.000Z')] });

    const connection = await seed();
    await runner.run(orderStream(optionsFor(connection)), connection);

    ebay.on('/order?', {
      total: 1,
      orders: [
        { ...order('evolving', '2026-03-01T00:00:00.000Z'), orderFulfillmentStatus: 'FULFILLED' },
      ],
    });
    await runner.run(orderStream(optionsFor(connection)), connection);

    const rows = await harness.db
      .select({ status: providerOrders.providerStatus })
      .from(providerOrders)
      .where(eq(providerOrders.connectionId, connection.connectionId));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('FULFILLED');
  });
});

describe('tenancy', () => {
  it('imports two sellers into the same business without mixing them', async () => {
    // The exit gate's requirement, in miniature: identifiers are unique within
    // an account, not globally, so two sellers can both have a listing named 1.
    ebay
      .on('/inventory_item?', { total: 1, inventoryItems: [{ sku: '1', availability: {} }] })
      .on('/offer?sku=1', { offers: [] });

    const first = await seed();
    const [second] = await harness.db
      .insert(connections)
      .values({
        businessId: first.businessId,
        provider: 'ebay',
        environment: 'production',
        externalAccountId: `second-${String((counter += 1))}`,
        displayName: 'Second seller',
        status: 'active',
        connectedAt: new Date(),
      })
      .returning({ id: connections.id });

    await runner.run(inventoryStream(optionsFor(first)), first);
    await runner.run(
      inventoryStream(optionsFor({ businessId: first.businessId, connectionId: second!.id })),
      { businessId: first.businessId, connectionId: second!.id },
    );

    const rows = await harness.db
      .select({ connectionId: providerItems.connectionId })
      .from(providerItems)
      .where(eq(providerItems.externalId, '1'));

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.connectionId)).size).toBe(2);
  });
});
