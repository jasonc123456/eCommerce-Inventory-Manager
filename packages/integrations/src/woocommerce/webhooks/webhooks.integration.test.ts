import { loadKeyring } from '@eim/crypto';
import { businesses, connections, providerWebhooks, users, webhookDeliveries } from '@eim/db';
import type { HttpClient, HttpOutcome, HttpRequest, UrlPolicy } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createSecretStore, type SecretStore } from '../../secrets';
import { createWooIntake } from './intake';
import { createWooWebhooks, deliveryUrlFor, MANAGED_TOPICS } from './registration';
import { signWebhookBody } from './signature';

/**
 * The webhook lifecycle against a real database (section 14).
 *
 * The cases worth a real PostgreSQL are the ones about two things existing at
 * once: a rotation's two live registrations for one topic, and the deduplication
 * that has to make their overlap harmless. Both are decided by indexes, and an
 * in-memory fake would decide them by agreeing with the code under test.
 */

let harness: TestDatabase;
let secrets: SecretStore;

const POLICY: UrlPolicy = { allowPrivate: false, allowInsecure: false, allowlist: [] };
const PUBLIC_URL = 'https://inventory.example.invalid';

/** A store that keeps its own webhook list, so reconciliation has something real to reconcile. */
class FakeStore {
  public registrations = new Map<string, { topic: string; status: string; deliveryUrl: string }>();
  public requests: HttpRequest[] = [];
  public refuseCreate = false;
  public refuseList = false;
  public omitIdOnCreate = false;
  private nextId = 1;

  reset(): void {
    this.registrations.clear();
    this.requests = [];
    this.refuseCreate = false;
    this.refuseList = false;
    this.omitIdOnCreate = false;
    this.nextId = 1;
  }

  readonly client: HttpClient = {
    send: (request) => {
      this.requests.push(request);

      const path = new URL(request.url).pathname;
      const query = new URL(request.url).searchParams;
      const body =
        request.body === undefined ? {} : (JSON.parse(request.body) as Record<string, unknown>);
      const id = /\/webhooks\/(\d+)$/.exec(path)?.[1];

      if (request.method === 'GET') {
        if (this.refuseList) {
          return Promise.resolve(answer(403, '{}'));
        }

        const page = Number(query.get('page') ?? '1');
        const rows =
          page > 1
            ? []
            : [...this.registrations.entries()].map(([key, entry]) => ({
                id: Number(key),
                topic: entry.topic,
                status: entry.status,
                delivery_url: entry.deliveryUrl,
              }));

        return Promise.resolve(answer(200, JSON.stringify(rows)));
      }

      if (request.method === 'POST') {
        if (this.refuseCreate) {
          return Promise.resolve(answer(400, '{"code":"woocommerce_rest_cannot_create"}'));
        }

        const key = String(this.nextId);

        this.nextId += 1;
        this.registrations.set(key, {
          topic: String(body['topic']),
          status: 'active',
          deliveryUrl: String(body['delivery_url']),
        });

        return Promise.resolve(
          answer(
            201,
            JSON.stringify(this.omitIdOnCreate ? { topic: body['topic'] } : { id: Number(key) }),
          ),
        );
      }

      if (request.method === 'PUT' && id !== undefined) {
        const existing = this.registrations.get(id);

        if (existing === undefined) {
          return Promise.resolve(answer(404, '{}'));
        }

        this.registrations.set(id, {
          ...existing,
          ...(typeof body['status'] === 'string' ? { status: body['status'] } : {}),
          ...(typeof body['delivery_url'] === 'string'
            ? { deliveryUrl: body['delivery_url'] }
            : {}),
        });

        return Promise.resolve(answer(200, JSON.stringify({ id: Number(id) })));
      }

      if (request.method === 'DELETE' && id !== undefined) {
        const existed = this.registrations.delete(id);

        return Promise.resolve(answer(existed ? 200 : 404, '{}'));
      }

      return Promise.resolve(answer(404, '{}'));
    },
  };
}

function answer(status: number, body: string): HttpOutcome {
  return {
    ok: true,
    response: {
      status,
      headers: { 'content-type': 'application/json' },
      body,
      url: 'https://shop.example/',
    },
  };
}

const store = new FakeStore();

const webhooksFor = () =>
  createWooWebhooks({
    db: harness.db,
    http: store.client,
    secrets,
    policy: POLICY,
    publicUrl: PUBLIC_URL,
  });

const intakeFor = () =>
  createWooIntake({ db: harness.db, secrets, policy: POLICY, webhooks: webhooksFor() });

beforeAll(async () => {
  harness = await createTestDatabase();
  secrets = createSecretStore({
    db: harness.db,
    keyring: loadKeyring({
      keyring: JSON.stringify([{ version: 1, key: Buffer.alloc(32, 3).toString('base64') }]),
      activeVersion: 1,
    }),
  });
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

beforeEach(() => {
  store.reset();
});

let counter = 0;

async function seedConnection(): Promise<{ businessId: string; connectionId: string }> {
  const slug = `woo-hook-${String((counter += 1))}`;

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
      externalAccountId: 'https://shop.example',
      displayName: 'shop.example',
      status: 'active',
      connectedAt: new Date(),
      activatedAt: new Date(),
      createdByUserId: user!.id,
    })
    .returning({ id: connections.id });

  for (const [secretType, value] of [
    ['woocommerce_consumer_key', 'ck_test'],
    ['woocommerce_consumer_secret', 'cs_test'],
  ] as const) {
    await secrets.put({
      businessId: business!.id,
      connectionId: connection!.id,
      secretType,
      value,
    });
  }

  return { businessId: business!.id, connectionId: connection!.id };
}

async function secretOf(
  ref: { businessId: string; connectionId: string },
  webhookId: string,
): Promise<string> {
  const value = await secrets.read(ref, 'webhook_secret', webhookId);

  if (value === null) {
    throw new Error(`no secret for ${webhookId}`);
  }

  return value;
}

function delivery(
  body: string,
  secret: string,
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-wc-webhook-signature': signWebhookBody(body, secret),
    'x-wc-webhook-source': 'https://shop.example/',
    'x-wc-webhook-topic': 'product.updated',
    'x-wc-webhook-resource': 'product',
    'x-wc-webhook-event': 'updated',
    'x-wc-webhook-delivery-id': '1001',
    ...overrides,
  };
}

const PRODUCT = '{"id":42,"name":"Blue widget","stock_quantity":7}';

describe('reconciling registrations', () => {
  it('creates one registration per managed topic, each with its own secret', async () => {
    // Section 14: a distinct random secret per managed webhook. One secret
    // shared across topics means compromising a coupon hook forges an order.
    const ref = await seedConnection();
    const report = await webhooksFor().reconcile(ref);

    expect(report.outcomes.map((outcome) => outcome.action)).toEqual(
      MANAGED_TOPICS.map(() => 'created'),
    );
    expect(report.pollingRequired).toEqual([]);
    expect(store.registrations.size).toBe(MANAGED_TOPICS.length);

    const values = await Promise.all(
      report.outcomes.map((outcome) => secretOf(ref, outcome.webhookId!)),
    );

    expect(new Set(values).size).toBe(MANAGED_TOPICS.length);
  });

  it('points every registration at this connection’s own delivery URL', async () => {
    const ref = await seedConnection();

    await webhooksFor().reconcile(ref);

    for (const entry of store.registrations.values()) {
      expect(entry.deliveryUrl).toBe(deliveryUrlFor(PUBLIC_URL, ref.connectionId));
    }
  });

  it('changes nothing on a second pass', async () => {
    const ref = await seedConnection();
    const webhooks = webhooksFor();

    await webhooks.reconcile(ref);

    const report = await webhooks.reconcile(ref);

    expect(report.outcomes.every((outcome) => outcome.action === 'unchanged')).toBe(true);
    expect(store.registrations.size).toBe(MANAGED_TOPICS.length);
  });

  it('switches a registration WooCommerce disabled back on', async () => {
    // WooCommerce disables a webhook after repeated delivery failures and
    // nothing else ever turns it back on. Polling keeps the integration
    // working, so without this the silence lasts for weeks.
    const ref = await seedConnection();
    const webhooks = webhooksFor();

    await webhooks.reconcile(ref);

    const [key, entry] = [...store.registrations.entries()][0]!;

    store.registrations.set(key, { ...entry, status: 'disabled' });

    const report = await webhooks.reconcile(ref);

    expect(report.outcomes.filter((outcome) => outcome.action === 're_enabled')).toHaveLength(1);
    expect(store.registrations.get(key)?.status).toBe('active');
  });

  it('aims a registration that was pointed elsewhere back here', async () => {
    const ref = await seedConnection();
    const webhooks = webhooksFor();

    await webhooks.reconcile(ref);

    const [key, entry] = [...store.registrations.entries()][0]!;

    store.registrations.set(key, { ...entry, deliveryUrl: 'https://elsewhere.example/hook' });

    const report = await webhooks.reconcile(ref);

    expect(report.outcomes.filter((outcome) => outcome.action === 'redirected')).toHaveLength(1);
    expect(store.registrations.get(key)?.deliveryUrl).toBe(
      deliveryUrlFor(PUBLIC_URL, ref.connectionId),
    );
  });

  it('recreates a registration an administrator deleted, with a new secret', async () => {
    const ref = await seedConnection();
    const webhooks = webhooksFor();

    const first = await webhooks.reconcile(ref);
    const original = first.outcomes[0]!;
    const originalSecret = await secretOf(ref, original.webhookId!);

    store.registrations.delete([...store.registrations.keys()][0]!);

    const second = await webhooks.reconcile(ref);
    const recreated = second.outcomes.find((outcome) => outcome.action === 'recreated');

    expect(recreated).toBeDefined();
    // The old secret signed for a registration that no longer exists.
    await expect(secrets.read(ref, 'webhook_secret', original.webhookId)).resolves.toBeNull();
    await expect(secretOf(ref, recreated!.webhookId!)).resolves.not.toBe(originalSecret);
  });

  it('concludes nothing when the store will not list its webhooks', async () => {
    // A registration that could not be read is not a registration that is gone.
    // Recreating on that basis leaves two live at the store and a secret for
    // neither.
    const ref = await seedConnection();
    const webhooks = webhooksFor();

    await webhooks.reconcile(ref);

    store.refuseList = true;

    const report = await webhooks.reconcile(ref);

    expect(report.outcomes).toEqual([
      { topic: 'all', action: 'failed', summary: 'the store did not list its webhooks' },
    ]);
    expect(report.pollingRequired).toEqual([...MANAGED_TOPICS]);
    expect(store.registrations.size).toBe(MANAGED_TOPICS.length);
  });

  it('names the topics that need polling when the store refuses to register them', async () => {
    // Section 14: polling remains active and missing webhook capability
    // produces visible degraded status. This is what makes it visible.
    const ref = await seedConnection();

    store.refuseCreate = true;

    const report = await webhooksFor().reconcile(ref);

    expect(report.pollingRequired).toEqual([...MANAGED_TOPICS]);
    expect(report.outcomes.every((outcome) => outcome.action === 'failed')).toBe(true);
  });

  it('records a registration the store accepted without naming as a failure', async () => {
    // Unnamed means unmanageable afterwards: it cannot be updated, re-enabled,
    // or removed on disconnection.
    const ref = await seedConnection();

    store.omitIdOnCreate = true;

    const report = await webhooksFor().reconcile(ref);

    expect(report.outcomes.every((outcome) => outcome.action === 'failed')).toBe(true);
  });

  it('lists registrations aimed here that it did not create, without deleting them', async () => {
    const ref = await seedConnection();

    store.registrations.set('900', {
      topic: 'product.updated',
      status: 'active',
      deliveryUrl: deliveryUrlFor(PUBLIC_URL, ref.connectionId),
    });

    const report = await webhooksFor().reconcile(ref);

    expect(report.foreign).toContainEqual({ externalId: '900', topic: 'product.updated' });
    expect(store.registrations.has('900')).toBe(true);
  });
});

describe('rotating a secret', () => {
  it('puts a replacement alongside the live registration rather than swapping it', async () => {
    // Swapping in place has a window where deliveries signed with the old secret
    // are unverifiable and ones signed with the new have not started. Every
    // event in that window is lost with no record it existed.
    const ref = await seedConnection();
    const webhooks = webhooksFor();

    await webhooks.reconcile(ref);

    const report = await webhooks.rotate({ ...ref, topic: 'product.updated' });

    expect(report.outcomes).toHaveLength(1);
    expect(report.outcomes[0]?.action).toBe('rotating');

    const rows = await harness.db
      .select()
      .from(providerWebhooks)
      .where(eq(providerWebhooks.connectionId, ref.connectionId));

    const forTopic = rows.filter((row) => row.topic === 'product.updated');

    expect(forTopic).toHaveLength(2);
    expect(forTopic.filter((row) => row.status === 'active')).toHaveLength(1);
    expect(forTopic.filter((row) => row.status === 'replacing')).toHaveLength(1);
  });

  it('verifies deliveries signed with either secret while both are live', async () => {
    const ref = await seedConnection();
    const webhooks = webhooksFor();

    const created = await webhooks.reconcile(ref);
    const old = created.outcomes.find((outcome) => outcome.topic === 'product.updated')!;
    const rotated = await webhooks.rotate({ ...ref, topic: 'product.updated' });
    const replacement = rotated.outcomes[0]!;

    const oldSecret = await secretOf(ref, old.webhookId!);
    const newSecret = await secretOf(ref, replacement.webhookId!);

    await expect(
      intakeFor().receive({
        connectionId: ref.connectionId,
        body: PRODUCT,
        headers: delivery(PRODUCT, oldSecret),
      }),
    ).resolves.toMatchObject({ ok: true, webhookId: old.webhookId });

    await expect(
      intakeFor().receive({
        connectionId: ref.connectionId,
        body: '{"id":43}',
        headers: delivery('{"id":43}', newSecret, { 'x-wc-webhook-delivery-id': '1002' }),
      }),
    ).resolves.toMatchObject({ ok: true, webhookId: replacement.webhookId });
  });

  it('promotes the replacement once a delivery proves it, and removes the old one', async () => {
    // Section 14's order: test delivery, transition, then remove the old owned
    // hook. The test is a real event verifying, because WooCommerce's REST API
    // offers no ping.
    const ref = await seedConnection();
    const webhooks = webhooksFor();

    const created = await webhooks.reconcile(ref);
    const old = created.outcomes.find((outcome) => outcome.topic === 'product.updated')!;
    const rotated = await webhooks.rotate({ ...ref, topic: 'product.updated' });
    const replacement = rotated.outcomes[0]!;
    const newSecret = await secretOf(ref, replacement.webhookId!);

    const [oldRow] = await harness.db
      .select({ externalId: providerWebhooks.externalId })
      .from(providerWebhooks)
      .where(eq(providerWebhooks.id, old.webhookId!));

    await intakeFor().receive({
      connectionId: ref.connectionId,
      body: PRODUCT,
      headers: delivery(PRODUCT, newSecret),
    });

    const rows = await harness.db
      .select()
      .from(providerWebhooks)
      .where(eq(providerWebhooks.connectionId, ref.connectionId));

    expect(rows.find((row) => row.id === replacement.webhookId)?.status).toBe('active');
    expect(rows.find((row) => row.id === old.webhookId)?.status).toBe('deleted');
    expect(store.registrations.has(oldRow!.externalId!)).toBe(false);
    // The retired secret is gone, so a delivery signed with it no longer verifies.
    await expect(secrets.read(ref, 'webhook_secret', old.webhookId)).resolves.toBeNull();
  });

  it('does not start a second rotation while one is in flight', async () => {
    // Three registrations on a topic, and "retire what this replaced" cannot say
    // which of two it meant.
    const ref = await seedConnection();
    const webhooks = webhooksFor();

    await webhooks.reconcile(ref);
    await webhooks.rotate({ ...ref, topic: 'product.updated' });

    const second = await webhooks.rotate({ ...ref, topic: 'product.updated' });

    expect(second.outcomes[0]?.action).toBe('unchanged');
  });
});

describe('receiving a delivery', () => {
  async function connected() {
    const ref = await seedConnection();
    const created = await webhooksFor().reconcile(ref);
    const hook = created.outcomes.find((outcome) => outcome.topic === 'product.updated')!;

    return { ref, hook, secret: await secretOf(ref, hook.webhookId!) };
  }

  it('records the delivery and says which registration signed it', async () => {
    const { ref, hook, secret } = await connected();

    const outcome = await intakeFor().receive({
      connectionId: ref.connectionId,
      body: PRODUCT,
      headers: delivery(PRODUCT, secret),
    });

    expect(outcome).toMatchObject({
      ok: true,
      topic: 'product.updated',
      resourceId: '42',
      webhookId: hook.webhookId,
      duplicate: false,
    });

    const [row] = await harness.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.connectionId, ref.connectionId));

    expect(row).toMatchObject({ signatureVerified: true, status: 'received', rawBody: PRODUCT });
  });

  it('does not store the signature it verified', async () => {
    const { ref, secret } = await connected();

    await intakeFor().receive({
      connectionId: ref.connectionId,
      body: PRODUCT,
      headers: delivery(PRODUCT, secret),
    });

    const [row] = await harness.db
      .select({ headers: webhookDeliveries.headers })
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.connectionId, ref.connectionId));

    expect(Object.keys(row!.headers as Record<string, string>)).not.toContain(
      'x-wc-webhook-signature',
    );
  });

  it('collapses a redelivery carrying the same delivery identifier', async () => {
    const { ref, secret } = await connected();
    const headers = delivery(PRODUCT, secret);

    await intakeFor().receive({ connectionId: ref.connectionId, body: PRODUCT, headers });

    await expect(
      intakeFor().receive({ connectionId: ref.connectionId, body: PRODUCT, headers }),
    ).resolves.toMatchObject({ duplicate: true });

    const rows = await harness.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.connectionId, ref.connectionId));

    expect(rows).toHaveLength(1);
  });

  it('collapses one event delivered twice by a rotation’s overlapping registrations', async () => {
    // The case the delivery identifier alone cannot catch: two registrations,
    // two identifiers, one event. For an order, acting on both is a second stock
    // movement for a sale that happened once.
    const ref = await seedConnection();
    const webhooks = webhooksFor();

    const created = await webhooks.reconcile(ref);
    const old = created.outcomes.find((outcome) => outcome.topic === 'product.updated')!;
    const rotated = await webhooks.rotate({ ...ref, topic: 'product.updated' });

    const oldSecret = await secretOf(ref, old.webhookId!);
    const newSecret = await secretOf(ref, rotated.outcomes[0]!.webhookId!);

    await intakeFor().receive({
      connectionId: ref.connectionId,
      body: PRODUCT,
      headers: delivery(PRODUCT, oldSecret, { 'x-wc-webhook-delivery-id': '2001' }),
    });

    const second = await intakeFor().receive({
      connectionId: ref.connectionId,
      body: PRODUCT,
      headers: delivery(PRODUCT, newSecret, { 'x-wc-webhook-delivery-id': '2002' }),
    });

    expect(second).toMatchObject({ ok: true, duplicate: true });

    const rows = await harness.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.connectionId, ref.connectionId));

    expect(rows).toHaveLength(1);
  });

  it('keeps two genuinely different updates to one product', async () => {
    // The fingerprint includes the body, so the second update — the one that
    // actually changed something — is not discarded as a duplicate.
    const { ref, secret } = await connected();
    const changed = '{"id":42,"name":"Blue widget","stock_quantity":6}';

    await intakeFor().receive({
      connectionId: ref.connectionId,
      body: PRODUCT,
      headers: delivery(PRODUCT, secret, { 'x-wc-webhook-delivery-id': '3001' }),
    });

    await intakeFor().receive({
      connectionId: ref.connectionId,
      body: changed,
      headers: delivery(changed, secret, { 'x-wc-webhook-delivery-id': '3002' }),
    });

    const rows = await harness.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.connectionId, ref.connectionId));

    expect(rows).toHaveLength(2);
  });

  it('stores nothing that failed verification', async () => {
    const { ref } = await connected();

    const outcome = await intakeFor().receive({
      connectionId: ref.connectionId,
      body: PRODUCT,
      headers: delivery(PRODUCT, 'not-the-secret'),
    });

    expect(outcome).toMatchObject({ ok: false, refusal: 'unverified', reason: 'mismatch' });

    const rows = await harness.db
      .select()
      .from(webhookDeliveries)
      .where(eq(webhookDeliveries.connectionId, ref.connectionId));

    expect(rows).toHaveLength(0);
  });

  it('takes the connection from the URL, not from a header', async () => {
    // Using `X-WC-Webhook-Source` to choose the connection would let anyone on
    // the internet nominate whose webhook secrets they are checked against.
    const first = await connected();
    const second = await connected();

    const outcome = await intakeFor().receive({
      connectionId: second.ref.connectionId,
      body: PRODUCT,
      headers: delivery(PRODUCT, first.secret),
    });

    expect(outcome).toMatchObject({ ok: false, refusal: 'unverified' });
  });

  it('refuses a delivery whose source names a different store', async () => {
    const { ref, secret } = await connected();

    const outcome = await intakeFor().receive({
      connectionId: ref.connectionId,
      body: PRODUCT,
      headers: delivery(PRODUCT, secret, { 'x-wc-webhook-source': 'https://elsewhere.example' }),
    });

    expect(outcome).toMatchObject({ ok: false, refusal: 'wrong_store' });
  });

  it('accepts a source that differs only in spelling', async () => {
    const { ref, secret } = await connected();

    await expect(
      intakeFor().receive({
        connectionId: ref.connectionId,
        body: PRODUCT,
        headers: delivery(PRODUCT, secret, { 'x-wc-webhook-source': 'https://Shop.Example:443/' }),
      }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('refuses a body that is too large before reading it as anything', async () => {
    const { ref, secret } = await connected();
    const huge = `{"id":42,"pad":"${'x'.repeat(1024 * 1024)}"}`;

    await expect(
      intakeFor().receive({
        connectionId: ref.connectionId,
        body: huge,
        headers: delivery(huge, secret),
      }),
    ).resolves.toEqual({ ok: false, refusal: 'too_large' });
  });

  it('refuses a delivery that is not JSON', async () => {
    const { ref, secret } = await connected();

    await expect(
      intakeFor().receive({
        connectionId: ref.connectionId,
        body: PRODUCT,
        headers: delivery(PRODUCT, secret, { 'content-type': 'text/html' }),
      }),
    ).resolves.toEqual({ ok: false, refusal: 'wrong_content_type' });
  });

  it('refuses a delivery for a connection that does not exist', async () => {
    await expect(
      intakeFor().receive({
        connectionId: '00000000-0000-4000-8000-000000000000',
        body: PRODUCT,
        headers: delivery(PRODUCT, 'anything'),
      }),
    ).resolves.toEqual({ ok: false, refusal: 'unknown_connection' });
  });

  it('acknowledges a verified delivery for a topic nothing here acts on', async () => {
    // Refusing it would ask the store to redeliver forever and eventually
    // disable the registration.
    const { ref, secret } = await connected();

    await expect(
      intakeFor().receive({
        connectionId: ref.connectionId,
        body: PRODUCT,
        headers: delivery(PRODUCT, secret, { 'x-wc-webhook-topic': 'coupon.updated' }),
      }),
    ).resolves.toEqual({ ok: false, refusal: 'unmanaged_topic' });
  });

  it('reports having no secrets differently from having the wrong one', async () => {
    const ref = await seedConnection();

    await expect(
      intakeFor().receive({
        connectionId: ref.connectionId,
        body: PRODUCT,
        headers: delivery(PRODUCT, 'anything'),
      }),
    ).resolves.toMatchObject({ ok: false, refusal: 'unverified', reason: 'no_secrets' });
  });
});

describe('the manual fallback', () => {
  it('generates the values an operator pastes into the store, and shows the secret once', async () => {
    const ref = await seedConnection();
    const setup = await webhooksFor().prepareManual({ ...ref, topic: 'product.updated' });

    expect(setup?.deliveryUrl).toBe(deliveryUrlFor(PUBLIC_URL, ref.connectionId));
    expect(setup?.secret.length).toBeGreaterThan(20);
    // Nothing was created at the store: the operator does that by hand.
    expect(store.registrations.size).toBe(0);
  });

  it('verifies itself the first time a delivery arrives', async () => {
    // Section 14's health verification for the manual path. There is nothing
    // else that could prove it: the registration exists only in the store.
    const ref = await seedConnection();
    const setup = await webhooksFor().prepareManual({ ...ref, topic: 'product.updated' });

    const outcome = await intakeFor().receive({
      connectionId: ref.connectionId,
      body: PRODUCT,
      headers: delivery(PRODUCT, setup!.secret),
    });

    expect(outcome).toMatchObject({ ok: true, webhookId: setup!.webhookId });

    const [row] = await harness.db
      .select()
      .from(providerWebhooks)
      .where(eq(providerWebhooks.id, setup!.webhookId));

    expect(row?.lastVerifiedAt).not.toBeNull();
  });
});

describe('removing registrations', () => {
  it('deletes what this application created and leaves the rest', async () => {
    const ref = await seedConnection();
    const webhooks = webhooksFor();

    await webhooks.reconcile(ref);
    await webhooks.prepareManual({ ...ref, topic: 'product.updated' });

    const report = await webhooks.remove(ref);

    // The hand-made one has no store identifier, so there is nothing to delete
    // and section 14 leaves it for the operator.
    expect(store.registrations.size).toBe(0);
    expect(report.outcomes.every((outcome) => outcome.action === 'removed')).toBe(true);

    const rows = await harness.db
      .select()
      .from(providerWebhooks)
      .where(eq(providerWebhooks.connectionId, ref.connectionId));

    expect(rows.every((row) => row.status === 'deleted' && row.secretId === null)).toBe(true);
  });

  it('discards every webhook secret', async () => {
    const ref = await seedConnection();
    const webhooks = webhooksFor();

    const created = await webhooks.reconcile(ref);

    await webhooks.remove(ref);

    for (const outcome of created.outcomes) {
      await expect(secrets.read(ref, 'webhook_secret', outcome.webhookId)).resolves.toBeNull();
    }
  });
});
