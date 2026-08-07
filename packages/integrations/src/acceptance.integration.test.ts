import { loadKeyring } from '@eim/crypto';
import {
  businesses,
  connections,
  providerItems,
  providerOrders,
  providerWebhooks,
  users,
  webhookDeliveries,
} from '@eim/db';
import type { HttpClient, HttpOutcome, HttpRequest, UrlPolicy } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createConnectionHealth } from './health';
import { CIRCUIT_THRESHOLD } from './health-policy';
import { ebayStreams, inventoryStream, orderStream as ebayOrders } from './ebay/imports';
import { createImportRunner, type ImportRunner } from './imports/runner';
import { createQuotaLedger, type QuotaLedger } from './quota';
import { createSecretStore, type SecretStore } from './secrets';
import { createWooClient } from './woocommerce/client';
import { orderStream, productStream } from './woocommerce/imports';
import { createWooIntake } from './woocommerce/webhooks/intake';
import { createWooWebhooks } from './woocommerce/webhooks/registration';
import { signWebhookBody } from './woocommerce/webhooks/signature';

/**
 * The M2 exit gate (section 36).
 *
 * The gate is one sentence — "multiple accounts/stores import without mutation;
 * replay/outage/rotation tests pass" — and each clause is a section below.
 *
 * The first clause is the one worth being strict about, and the strictness is
 * cheap: every request this application makes passes through one fake, so the
 * suite can assert that *no non-idempotent request was ever sent to a provider
 * during an import*. That is a stronger statement than checking a few call
 * sites, and it stays true as the import code grows, because a new write would
 * have to go through the same client.
 *
 * Nothing here reaches the network. Two eBay sellers and two WooCommerce stores
 * are programmable fakes, and each belongs to a different business, so isolation
 * is a property the assertions can check rather than an arrangement they assume.
 */

let harness: TestDatabase;
let secrets: SecretStore;
let quotas: QuotaLedger;
let runner: ImportRunner;

const POLICY: UrlPolicy = { allowPrivate: false, allowInsecure: false, allowlist: [] };
const PUBLIC_URL = 'https://inventory.example.invalid';
const NOW = new Date('2026-03-01T12:00:00Z');

/**
 * Every request the application makes, recorded.
 *
 * Routing is by host, so two sellers and two stores can be told apart, and a
 * request aimed at the wrong one is visible rather than silently answered.
 */
type Registrations = Map<string, { topic: string; status: string; url: string }>;

class Providers {
  public readonly requests: HttpRequest[] = [];
  public offline = new Set<string>();
  public webhooks = new Map<string, Registrations>();
  public catalogues = new Map<string, Record<string, unknown>[]>();
  public nextWebhookId = 1;

  reset(): void {
    this.requests.length = 0;
    this.offline.clear();
    this.webhooks.clear();
    this.catalogues.clear();
    this.nextWebhookId = 1;
  }

  /** Requests that changed something at a provider. Empty is the M2 guarantee. */
  mutations(): HttpRequest[] {
    return this.requests.filter((request) => request.method !== 'GET');
  }

  readonly client: HttpClient = {
    send: (request) => {
      this.requests.push(request);

      const url = new URL(request.url);
      const host = url.hostname;

      if (this.offline.has(host)) {
        return Promise.resolve<HttpOutcome>({ ok: false, kind: 'timeout', reason: 'timed out' });
      }

      return Promise.resolve(this.answer(host, url, request));
    },
  };

  private answer(host: string, url: URL, request: HttpRequest): HttpOutcome {
    const path = url.pathname;

    if (path.endsWith('/settings/general')) {
      return json([{ id: 'woocommerce_currency', value: 'GBP' }]);
    }

    if (path.includes('/webhooks')) {
      return this.webhookRoute(host, path, request);
    }

    if (path.endsWith('/wp-json/wc/v3/products') || path.endsWith('/wp-json/wc/v3/orders')) {
      const page = Number(url.searchParams.get('page') ?? '1');
      const rows = page === 1 ? (this.catalogues.get(host) ?? []) : [];

      return json(rows, { 'x-wp-total': String(rows.length), 'x-wp-totalpages': '1' });
    }

    // eBay's inventory route, which answers an envelope rather than an array.
    if (path.includes('/sell/inventory/v1/inventory_item')) {
      const rows = this.catalogues.get(host) ?? [];

      return json({ inventoryItems: rows, total: rows.length });
    }

    if (path.includes('/sell/inventory/v1/offer')) {
      return json({ offers: [] });
    }

    if (path.includes('/sell/fulfillment/v1/order')) {
      return json({ orders: [], total: 0 });
    }

    return json({});
  }

  private webhookRoute(host: string, path: string, request: HttpRequest): HttpOutcome {
    const store: Registrations = this.webhooks.get(host) ?? new Map();

    this.webhooks.set(host, store);

    const id = /\/webhooks\/(\d+)/.exec(path)?.[1];

    if (request.method === 'GET') {
      return json(
        [...store.entries()].map(([key, entry]) => ({
          id: Number(key),
          topic: entry.topic,
          status: entry.status,
          delivery_url: entry.url,
        })),
      );
    }

    if (request.method === 'POST') {
      const body = JSON.parse(request.body ?? '{}') as Record<string, unknown>;
      const key = String(this.nextWebhookId);

      this.nextWebhookId += 1;
      store.set(key, {
        topic: String(body['topic']),
        status: 'active',
        url: String(body['delivery_url']),
      });

      return json({ id: Number(key) }, {}, 201);
    }

    if (request.method === 'DELETE' && id !== undefined) {
      store.delete(id);

      return json({});
    }

    return json({});
  }
}

function json(payload: unknown, headers: Record<string, string> = {}, status = 200): HttpOutcome {
  return {
    ok: true,
    response: {
      status,
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(payload),
      url: 'https://provider.invalid/',
    },
  };
}

const providers = new Providers();

beforeAll(async () => {
  harness = await createTestDatabase();
  secrets = createSecretStore({
    db: harness.db,
    keyring: loadKeyring({
      keyring: JSON.stringify([{ version: 1, key: Buffer.alloc(32, 11).toString('base64') }]),
      activeVersion: 1,
    }),
  });
  quotas = createQuotaLedger(harness.db);
  runner = createImportRunner(harness.db);
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

beforeEach(() => {
  providers.reset();
});

let counter = 0;

interface Party {
  businessId: string;
  connectionId: string;
  host: string;
}

async function seedBusiness(): Promise<string> {
  const slug = `m2-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: slug, slug })
    .returning({ id: businesses.id });

  await harness.db.insert(users).values({ email: `${slug}@example.invalid`, displayName: 'Owner' });

  return business!.id;
}

async function seedStore(businessId: string, host: string): Promise<Party> {
  const [connection] = await harness.db
    .insert(connections)
    .values({
      businessId,
      provider: 'woocommerce',
      environment: 'production',
      externalAccountId: `https://${host}`,
      displayName: host,
      status: 'active',
      connectedAt: NOW,
      activatedAt: NOW,
    })
    .returning({ id: connections.id });

  for (const [secretType, value] of [
    ['woocommerce_consumer_key', `ck_${host}`],
    ['woocommerce_consumer_secret', `cs_${host}`],
  ] as const) {
    await secrets.put({ businessId, connectionId: connection!.id, secretType, value });
  }

  return { businessId, connectionId: connection!.id, host };
}

async function seedSeller(businessId: string, sellerId: string): Promise<Party> {
  const [connection] = await harness.db
    .insert(connections)
    .values({
      businessId,
      provider: 'ebay',
      environment: 'production',
      externalAccountId: sellerId,
      displayName: sellerId,
      status: 'active',
      connectedAt: NOW,
      activatedAt: NOW,
    })
    .returning({ id: connections.id });

  return { businessId, connectionId: connection!.id, host: 'api.ebay.com' };
}

function storeOptions(party: Party) {
  return {
    db: harness.db,
    client: createWooClient({
      http: providers.client,
      restBase: `https://${party.host}/wp-json/wc/v3`,
      credentials: { consumerKey: 'ck', consumerSecret: 'cs' },
    }),
    businessId: party.businessId,
    connectionId: party.connectionId,
    pageSize: 50,
  };
}

function sellerOptions(party: Party) {
  return {
    db: harness.db,
    http: providers.client,
    businessId: party.businessId,
    connectionId: party.connectionId,
    environment: 'production' as const,
    accessToken: () => Promise.resolve('access-token'),
  };
}

const wooProduct = (id: number) => ({
  id,
  name: `Product ${String(id)}`,
  sku: `SKU-${String(id)}`,
  type: 'simple',
  status: 'publish',
  manage_stock: true,
  stock_quantity: 5,
  backorders: 'no',
  price: '10.00',
});

const ebayItem = (sku: string) => ({
  sku,
  product: { title: `Item ${sku}` },
  availability: { shipToLocationAvailability: { quantity: 4 } },
});

// ---------------------------------------------------------------------------

describe('multiple accounts and stores import without mutation', () => {
  it('would notice a mutation if one were made', async () => {
    // The gate's central assertion is that a list is empty, and an empty list
    // proves nothing unless something could have put an entry in it. Webhook
    // registration is the one place M2 writes to a provider at all, so it is
    // what demonstrates the recorder works.
    const business = await seedBusiness();
    const party = await seedStore(business, 'guard.example');

    await createWooWebhooks({
      db: harness.db,
      http: providers.client,
      secrets,
      policy: POLICY,
      publicUrl: PUBLIC_URL,
    }).reconcile(party);

    expect(providers.mutations().length).toBeGreaterThan(0);
    expect(providers.mutations().every((request) => request.method === 'POST')).toBe(true);
  });

  it('imports two stores and two sellers, and writes to neither', async () => {
    const first = await seedBusiness();
    const second = await seedBusiness();

    const storeA = await seedStore(first, 'shop-a.example');
    const storeB = await seedStore(second, 'shop-b.example');
    const sellerA = await seedSeller(first, 'seller-a');
    const sellerB = await seedSeller(second, 'seller-b');

    providers.catalogues.set('shop-a.example', [wooProduct(1), wooProduct(2)]);
    providers.catalogues.set('shop-b.example', [wooProduct(3)]);
    providers.catalogues.set('api.ebay.com', [ebayItem('EB-1')]);

    for (const party of [storeA, storeB]) {
      await runner.run(productStream(storeOptions(party)), party);
      await runner.run(orderStream(storeOptions(party)), party);
    }

    for (const party of [sellerA, sellerB]) {
      await runner.run(inventoryStream(sellerOptions(party)), party);
      await runner.run(ebayOrders(sellerOptions(party)), party);
    }

    // The gate's own words. Every request that left this application during
    // those eight imports was a read.
    expect(providers.mutations()).toEqual([]);
    expect(providers.requests.length).toBeGreaterThan(0);
  });

  it('keeps each business’s catalog to itself', async () => {
    const first = await seedBusiness();
    const second = await seedBusiness();

    const storeA = await seedStore(first, 'shop-c.example');
    const storeB = await seedStore(second, 'shop-d.example');

    providers.catalogues.set('shop-c.example', [wooProduct(1), wooProduct(2)]);
    providers.catalogues.set('shop-d.example', [wooProduct(9)]);

    await runner.run(productStream(storeOptions(storeA)), storeA);
    await runner.run(productStream(storeOptions(storeB)), storeB);

    const a = await harness.db
      .select({ externalId: providerItems.externalId, businessId: providerItems.businessId })
      .from(providerItems)
      .where(eq(providerItems.connectionId, storeA.connectionId));

    const b = await harness.db
      .select({ externalId: providerItems.externalId, businessId: providerItems.businessId })
      .from(providerItems)
      .where(eq(providerItems.connectionId, storeB.connectionId));

    expect(a.map((row) => row.externalId).sort()).toEqual(['1', '2']);
    expect(b.map((row) => row.externalId)).toEqual(['9']);
    expect(a.every((row) => row.businessId === first)).toBe(true);
    expect(b.every((row) => row.businessId === second)).toBe(true);
  });

  it('lets two businesses connect stores with the same product identifiers', async () => {
    // The mirror is keyed by connection, not by the provider's own numbering.
    // Two shops both selling product 1 is ordinary.
    const first = await seedBusiness();
    const second = await seedBusiness();

    const storeA = await seedStore(first, 'shop-e.example');
    const storeB = await seedStore(second, 'shop-f.example');

    providers.catalogues.set('shop-e.example', [wooProduct(1)]);
    providers.catalogues.set('shop-f.example', [wooProduct(1)]);

    await runner.run(productStream(storeOptions(storeA)), storeA);
    await runner.run(productStream(storeOptions(storeB)), storeB);

    for (const party of [storeA, storeB]) {
      const rows = await harness.db
        .select({ id: providerItems.id })
        .from(providerItems)
        .where(eq(providerItems.connectionId, party.connectionId));

      expect(rows).toHaveLength(1);
    }
  });

  it('imports every eBay stream without a write', async () => {
    const business = await seedBusiness();
    const seller = await seedSeller(business, 'seller-streams');

    providers.catalogues.set('api.ebay.com', [ebayItem('EB-2')]);

    for (const stream of ebayStreams(sellerOptions(seller))) {
      await runner.run(stream, seller);
    }

    expect(providers.mutations()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe('replay', () => {
  async function connectedStore(host: string) {
    const business = await seedBusiness();
    const party = await seedStore(business, host);
    const webhooks = createWooWebhooks({
      db: harness.db,
      http: providers.client,
      secrets,
      policy: POLICY,
      publicUrl: PUBLIC_URL,
    });

    const report = await webhooks.reconcile(party);
    const hook = report.outcomes.find((outcome) => outcome.topic === 'product.updated')!;
    const secret = await secrets.read(party, 'webhook_secret', hook.webhookId);

    return {
      party,
      webhooks,
      hook,
      secret: secret!,
      intake: createWooIntake({ db: harness.db, secrets, policy: POLICY, webhooks }),
    };
  }

  function headers(body: string, secret: string, deliveryId: string) {
    return {
      'content-type': 'application/json',
      'x-wc-webhook-signature': signWebhookBody(body, secret),
      'x-wc-webhook-topic': 'product.updated',
      'x-wc-webhook-resource': 'product',
      'x-wc-webhook-delivery-id': deliveryId,
    };
  }

  it('records one event however many times it is delivered', async () => {
    const { party, secret, intake } = await connectedStore('replay-a.example');
    const body = '{"id":42,"stock_quantity":3}';

    for (const deliveryId of ['1', '1', '1']) {
      await intake.receive({
        connectionId: party.connectionId,
        body,
        headers: headers(body, secret, deliveryId),
      });
    }

    const rows = await harness.db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.connectionId, party.connectionId));

    expect(rows).toHaveLength(1);
  });

  it('records one event delivered under two identifiers during a rotation', async () => {
    const { party, hook, secret, webhooks, intake } = await connectedStore('replay-b.example');
    const rotated = await webhooks.rotate({ ...party, topic: 'product.updated' });
    const replacement = await secrets.read(party, 'webhook_secret', rotated.outcomes[0]!.webhookId);

    const body = '{"id":42,"stock_quantity":3}';

    await intake.receive({
      connectionId: party.connectionId,
      body,
      headers: headers(body, secret, '10'),
    });

    const second = await intake.receive({
      connectionId: party.connectionId,
      body,
      headers: headers(body, replacement!, '11'),
    });

    expect(second).toMatchObject({ ok: true, duplicate: true });

    const rows = await harness.db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.connectionId, party.connectionId));

    expect(rows).toHaveLength(1);
    void hook;
  });

  it('re-importing an unchanged catalog changes nothing', async () => {
    const business = await seedBusiness();
    const party = await seedStore(business, 'replay-c.example');

    providers.catalogues.set('replay-c.example', [wooProduct(1), wooProduct(2)]);

    await runner.run(productStream(storeOptions(party)), party);

    const before = await harness.db
      .select()
      .from(providerItems)
      .where(eq(providerItems.connectionId, party.connectionId));

    await runner.run(productStream(storeOptions(party)), party);

    const after = await harness.db
      .select()
      .from(providerItems)
      .where(eq(providerItems.connectionId, party.connectionId));

    expect(after).toHaveLength(before.length);
    expect(after.map((row) => row.id).sort()).toEqual(before.map((row) => row.id).sort());
    expect(after.every((row) => row.missingSince === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('outage', () => {
  it('resumes an interrupted import from where it stopped', async () => {
    const business = await seedBusiness();
    const party = await seedStore(business, 'outage-a.example');

    providers.catalogues.set('outage-a.example', [wooProduct(1), wooProduct(2), wooProduct(3)]);
    providers.offline.add('outage-a.example');

    const failed = await runner.run(productStream(storeOptions(party)), party);

    expect(failed).toMatchObject({ status: 'incomplete', resumable: true });

    providers.offline.delete('outage-a.example');

    const recovered = await runner.run(productStream(storeOptions(party)), party);

    expect(recovered.status).toBe('completed');

    const rows = await harness.db
      .select({ id: providerItems.id })
      .from(providerItems)
      .where(eq(providerItems.connectionId, party.connectionId));

    expect(rows).toHaveLength(3);
  });

  it('concludes nothing about absence from an import that failed', async () => {
    // The rule the whole sweep design rests on: an import that did not reach the
    // end has not discovered that anything is gone.
    const business = await seedBusiness();
    const party = await seedStore(business, 'outage-b.example');

    providers.catalogues.set('outage-b.example', [wooProduct(1), wooProduct(2)]);
    await runner.run(productStream(storeOptions(party)), party);

    providers.offline.add('outage-b.example');
    await runner.run(productStream(storeOptions(party)), party);

    const rows = await harness.db
      .select({ missingSince: providerItems.missingSince })
      .from(providerItems)
      .where(eq(providerItems.connectionId, party.connectionId));

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.missingSince === null)).toBe(true);
  });

  it('opens the circuit and reports the connection as failing, then recovers', async () => {
    const business = await seedBusiness();
    const party = await seedStore(business, 'outage-c.example');
    const health = createConnectionHealth({ db: harness.db, quotas });

    for (let attempt = 0; attempt < CIRCUIT_THRESHOLD; attempt += 1) {
      await health.record({ ...party, outcome: 'failure', summary: 'timed out', now: NOW });
    }

    await expect(health.circuit({ ...party, now: NOW })).resolves.toMatchObject({
      state: 'open',
      allowed: false,
    });
    await expect(health.assess({ ...party, now: NOW })).resolves.toMatchObject({
      status: 'failing',
    });

    await health.record({ ...party, outcome: 'success', now: NOW });

    await expect(health.circuit({ ...party, now: NOW })).resolves.toMatchObject({
      state: 'closed',
      allowed: true,
    });
    await expect(health.assess({ ...party, now: NOW })).resolves.toMatchObject({
      status: 'healthy',
    });
  });

  it('changes no registration when the store cannot be listed', async () => {
    const business = await seedBusiness();
    const party = await seedStore(business, 'outage-d.example');
    const webhooks = createWooWebhooks({
      db: harness.db,
      http: providers.client,
      secrets,
      policy: POLICY,
      publicUrl: PUBLIC_URL,
    });

    const created = await webhooks.reconcile(party);

    expect(created.pollingRequired).toEqual([]);

    providers.offline.add('outage-d.example');

    const during = await webhooks.reconcile(party);

    expect(during.outcomes).toEqual([
      { topic: 'all', action: 'failed', summary: 'the store did not list its webhooks' },
    ]);

    const rows = await harness.db
      .select({ status: providerWebhooks.status })
      .from(providerWebhooks)
      .where(eq(providerWebhooks.connectionId, party.connectionId));

    expect(rows.filter((row) => row.status === 'active')).toHaveLength(created.outcomes.length);
  });
});

// ---------------------------------------------------------------------------

describe('rotation', () => {
  it('loses no delivery across a webhook secret rotation', async () => {
    // The property the overlap exists for. A delivery signed with the old secret
    // arrives after the replacement was created, and a delivery signed with the
    // new one arrives before the old registration is gone. Both verify.
    const business = await seedBusiness();
    const party = await seedStore(business, 'rotate-a.example');
    const webhooks = createWooWebhooks({
      db: harness.db,
      http: providers.client,
      secrets,
      policy: POLICY,
      publicUrl: PUBLIC_URL,
    });

    const created = await webhooks.reconcile(party);
    const original = created.outcomes.find((outcome) => outcome.topic === 'product.updated')!;
    const oldSecret = await secrets.read(party, 'webhook_secret', original.webhookId);

    const rotated = await webhooks.rotate({ ...party, topic: 'product.updated' });
    const newSecret = await secrets.read(party, 'webhook_secret', rotated.outcomes[0]!.webhookId);

    const intake = createWooIntake({ db: harness.db, secrets, policy: POLICY, webhooks });

    const first = '{"id":1,"stock_quantity":1}';
    const second = '{"id":2,"stock_quantity":2}';

    const inFlight = await intake.receive({
      connectionId: party.connectionId,
      body: first,
      headers: {
        'content-type': 'application/json',
        'x-wc-webhook-signature': signWebhookBody(first, oldSecret!),
        'x-wc-webhook-topic': 'product.updated',
        'x-wc-webhook-delivery-id': '20',
      },
    });

    const afterSwap = await intake.receive({
      connectionId: party.connectionId,
      body: second,
      headers: {
        'content-type': 'application/json',
        'x-wc-webhook-signature': signWebhookBody(second, newSecret!),
        'x-wc-webhook-topic': 'product.updated',
        'x-wc-webhook-delivery-id': '21',
      },
    });

    expect(inFlight).toMatchObject({ ok: true, webhookId: original.webhookId });
    expect(afterSwap).toMatchObject({ ok: true, webhookId: rotated.outcomes[0]!.webhookId });

    const rows = await harness.db
      .select({ id: webhookDeliveries.id })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.connectionId, party.connectionId));

    expect(rows).toHaveLength(2);
  });

  it('retires the old secret only once the replacement has proved itself', async () => {
    const business = await seedBusiness();
    const party = await seedStore(business, 'rotate-b.example');
    const webhooks = createWooWebhooks({
      db: harness.db,
      http: providers.client,
      secrets,
      policy: POLICY,
      publicUrl: PUBLIC_URL,
    });

    const created = await webhooks.reconcile(party);
    const original = created.outcomes.find((outcome) => outcome.topic === 'product.updated')!;
    const rotated = await webhooks.rotate({ ...party, topic: 'product.updated' });
    const newSecret = await secrets.read(party, 'webhook_secret', rotated.outcomes[0]!.webhookId);

    // Still live while nothing has verified against the replacement.
    await expect(secrets.read(party, 'webhook_secret', original.webhookId)).resolves.not.toBeNull();

    const body = '{"id":3}';
    const intake = createWooIntake({ db: harness.db, secrets, policy: POLICY, webhooks });

    await intake.receive({
      connectionId: party.connectionId,
      body,
      headers: {
        'content-type': 'application/json',
        'x-wc-webhook-signature': signWebhookBody(body, newSecret!),
        'x-wc-webhook-topic': 'product.updated',
        'x-wc-webhook-delivery-id': '30',
      },
    });

    await expect(secrets.read(party, 'webhook_secret', original.webhookId)).resolves.toBeNull();
  });

  it('replaces a store key without disturbing the imported catalog', async () => {
    const business = await seedBusiness();
    const party = await seedStore(business, 'rotate-c.example');

    providers.catalogues.set('rotate-c.example', [wooProduct(1)]);
    await runner.run(productStream(storeOptions(party)), party);

    await secrets.put({
      ...party,
      secretType: 'woocommerce_consumer_key',
      value: 'ck_rotated',
    });

    await expect(secrets.read(party, 'woocommerce_consumer_key')).resolves.toBe('ck_rotated');

    const rows = await harness.db
      .select({ id: providerItems.id })
      .from(providerItems)
      .where(eq(providerItems.connectionId, party.connectionId));

    expect(rows).toHaveLength(1);
  });

  it('keeps an order’s activation classification across a re-import', async () => {
    // The classification is made once, when the order is first seen. A rotation
    // or a re-import must not reclassify a year of history into a year of demand.
    const business = await seedBusiness();
    const party = await seedStore(business, 'rotate-d.example');

    providers.catalogues.set('rotate-d.example', [
      {
        id: 900,
        number: '900',
        status: 'processing',
        currency: 'GBP',
        total: '10.00',
        customer_id: 4,
        date_created_gmt: '2025-06-01T10:00:00',
        date_modified_gmt: '2025-06-01T10:00:00',
        line_items: [],
      },
    ]);

    await runner.run(orderStream(storeOptions(party)), party);

    const [before] = await harness.db
      .select({ preActivation: providerOrders.preActivation })
      .from(providerOrders)
      .where(eq(providerOrders.connectionId, party.connectionId));

    await runner.run(orderStream(storeOptions(party)), party);

    const [after] = await harness.db
      .select({ preActivation: providerOrders.preActivation })
      .from(providerOrders)
      .where(eq(providerOrders.connectionId, party.connectionId));

    expect(before?.preActivation).toBe(true);
    expect(after?.preActivation).toBe(before?.preActivation);
  });
});
