import {
  businesses,
  connectionScopes,
  connections,
  memberships,
  providerNotificationTopics,
  users,
} from '@eim/db';
import type { HttpClient, HttpOutcome, HttpRequest } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createNotificationTopics, classifyTopic, type NotificationTopics } from './topics';

/**
 * Subscribing a seller to the events this application acts on.
 *
 * The cases worth proving are the ones where a subscription cannot be created:
 * a topic eBay does not offer this keyset, a scope the seller did not grant, a
 * subscription eBay disabled after failed deliveries. Each has to end with the
 * affected family named as one that must be polled — because that is the
 * difference between events arriving late and events never arriving at all.
 */

const DESTINATION = 'dest-1';

class FakeEbay {
  public requests: HttpRequest[] = [];
  private routes: { method: string; match: string; outcome: HttpOutcome }[] = [];

  reset(): void {
    this.requests = [];
    this.routes = [];
  }

  json(method: string, match: string, payload: unknown, status = 200, headers = {}): this {
    this.routes.push({
      method,
      match,
      outcome: {
        ok: true,
        response: { status, headers, body: JSON.stringify(payload), url: 'https://api.ebay.com/' },
      },
    });

    return this;
  }

  down(method: string, match: string): this {
    this.routes.push({
      method,
      match,
      outcome: { ok: false, kind: 'timeout', reason: 'timed out' },
    });

    return this;
  }

  readonly client: HttpClient = {
    send: (request) => {
      this.requests.push(request);

      // The most specific route wins, not the last registered: several eBay
      // notification paths are prefixes of each other, and a prefix match would
      // quietly answer the enable call with the create call's response.
      const matched = this.routes
        .filter((route) => route.method === request.method && request.url.includes(route.match))
        .sort((left, right) => right.match.length - left.match.length)[0];

      return Promise.resolve(
        matched?.outcome ?? { ok: false, kind: 'transport', reason: 'ECONNREFUSED' },
      );
    },
  };
}

let harness: TestDatabase;
let topics: NotificationTopics;
const ebay = new FakeEbay();

const ORDER_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly';
const CATALOG_SCOPE = 'https://api.ebay.com/oauth/api_scope/sell.inventory.readonly';

beforeAll(async () => {
  harness = await createTestDatabase();
  topics = createNotificationTopics({
    db: harness.db,
    http: ebay.client,
    applicationToken: () => Promise.resolve('app-token'),
    accessToken: () => Promise.resolve('seller-token'),
    destinationId: () => Promise.resolve(DESTINATION),
  });
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

beforeEach(() => {
  ebay.reset();
});

let counter = 0;

async function seed(scopes: readonly string[] = [ORDER_SCOPE, CATALOG_SCOPE]) {
  const slug = `ebay-topics-${String((counter += 1))}`;

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
      connectedAt: new Date('2026-01-01T00:00:00Z'),
    })
    .returning({ id: connections.id });

  if (scopes.length > 0) {
    await harness.db
      .insert(connectionScopes)
      .values(
        scopes.map((scope) => ({ businessId: business!.id, connectionId: connection!.id, scope })),
      );
  }

  return { businessId: business!.id, connectionId: connection!.id };
}

/** eBay's topic catalogue, as its shape actually is. */
function catalogue(
  entries: readonly { topicId: string; scope?: string; status?: string; json?: boolean }[],
) {
  return {
    total: entries.length,
    topics: entries.map((entry) => ({
      topicId: entry.topicId,
      scope: entry.scope ?? '',
      status: entry.status ?? 'ENABLED',
      supportedPayloads:
        entry.json === false
          ? [{ format: 'XML', schemaVersion: '1.0', deliveryProtocol: 'HTTPS' }]
          : [{ format: 'JSON', schemaVersion: '1.3', deliveryProtocol: 'HTTPS' }],
    })),
  };
}

const FULL_CATALOGUE = catalogue([
  { topicId: 'AUTHORIZATION_REVOCATION' },
  { topicId: 'ITEM_INVENTORY_CHANGE', scope: CATALOG_SCOPE },
  { topicId: 'ORDER_SALE_COMPLETED', scope: ORDER_SCOPE },
  { topicId: 'MARKETPLACE_ACCOUNT_DELETION' },
  { topicId: 'BUYER_MESSAGE_RECEIVED' },
]);

describe('classifyTopic', () => {
  it('sorts topics by what this application would do with them', () => {
    expect(classifyTopic('AUTHORIZATION_REVOCATION')).toBe('revocation');
    expect(classifyTopic('ITEM_INVENTORY_CHANGE')).toBe('catalog');
    expect(classifyTopic('ORDER_SALE_COMPLETED')).toBe('orders');
    expect(classifyTopic('MARKETPLACE_ACCOUNT_DELETION')).toBe('account_deletion');
    expect(classifyTopic('BUYER_MESSAGE_RECEIVED')).toBeNull();
  });
});

describe('reconcile', () => {
  it('subscribes to every relevant permitted topic and enables each', async () => {
    ebay
      .json('GET', '/notification/v1/topic', FULL_CATALOGUE)
      .json('GET', '/notification/v1/subscription?', { subscriptions: [] })
      .json('POST', '/notification/v1/subscription/sub-1/enable', {}, 204)
      .json('POST', '/notification/v1/subscription', { subscriptionId: 'sub-1' }, 201);

    const connection = await seed();
    const outcome = await topics.reconcile(connection);

    expect(outcome.ok).toBe(true);

    if (!outcome.ok) {
      return;
    }

    expect(outcome.report.topics.map((topic) => topic.status)).toEqual([
      'subscribed',
      'subscribed',
      'subscribed',
    ]);
    expect(outcome.report.pollingRequired).toEqual([]);
  });

  it('never subscribes a seller to account deletion or to events nothing handles', async () => {
    // The deletion endpoint is registered once per application in eBay's
    // portal; there is no per-seller subscription to make. A buyer message is
    // simply not something this application acts on.
    ebay
      .json('GET', '/notification/v1/topic', FULL_CATALOGUE)
      .json('GET', '/notification/v1/subscription?', { subscriptions: [] })
      .json('POST', '/notification/v1/subscription/sub-1/enable', {}, 204)
      .json('POST', '/notification/v1/subscription', { subscriptionId: 'sub-1' }, 201);

    const connection = await seed();
    await topics.reconcile(connection);

    const attempted = ebay.requests
      .filter((request) => request.method === 'POST' && request.body !== undefined)
      .map((request) => String(request.body));

    expect(attempted.some((body) => body.includes('MARKETPLACE_ACCOUNT_DELETION'))).toBe(false);
    expect(attempted.some((body) => body.includes('BUYER_MESSAGE_RECEIVED'))).toBe(false);
  });

  it('leaves an already-enabled subscription alone', async () => {
    ebay
      .json('GET', '/notification/v1/topic', catalogue([{ topicId: 'ORDER_SALE_COMPLETED' }]))
      .json('GET', '/notification/v1/subscription?', {
        subscriptions: [
          {
            subscriptionId: 'sub-existing',
            topicId: 'ORDER_SALE_COMPLETED',
            destinationId: DESTINATION,
            status: 'ENABLED',
          },
        ],
      });

    const connection = await seed();
    const outcome = await topics.reconcile(connection);

    expect(outcome).toMatchObject({ ok: true });
    expect(ebay.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });

  it('re-enables a subscription eBay disabled after failed deliveries', async () => {
    ebay
      .json('GET', '/notification/v1/topic', catalogue([{ topicId: 'ORDER_SALE_COMPLETED' }]))
      .json('GET', '/notification/v1/subscription?', {
        subscriptions: [
          {
            subscriptionId: 'sub-existing',
            topicId: 'ORDER_SALE_COMPLETED',
            destinationId: DESTINATION,
            status: 'DISABLED',
          },
        ],
      })
      .json('POST', '/notification/v1/subscription/sub-existing/enable', {}, 204);

    const connection = await seed();
    const outcome = await topics.reconcile(connection);

    expect(outcome).toMatchObject({ ok: true });

    if (outcome.ok) {
      expect(outcome.report.topics[0]).toMatchObject({
        status: 'subscribed',
        subscriptionId: 'sub-existing',
      });
      expect(outcome.report.pollingRequired).not.toContain('orders');
    }
  });

  it('treats an already-enabled conflict as success', async () => {
    ebay
      .json('GET', '/notification/v1/topic', catalogue([{ topicId: 'ORDER_SALE_COMPLETED' }]))
      .json('GET', '/notification/v1/subscription?', { subscriptions: [] })
      .json('POST', '/notification/v1/subscription/sub-1/enable', { errors: [] }, 409)
      .json('POST', '/notification/v1/subscription', { subscriptionId: 'sub-1' }, 201);

    const connection = await seed();
    const outcome = await topics.reconcile(connection);

    if (outcome.ok) {
      expect(outcome.report.topics[0]?.status).toBe('subscribed');
    }
  });

  it('ignores a subscription pointed at somebody else’s destination', async () => {
    // Another integration on the same seller account. Deleting or adopting it
    // would break somebody else's system; a subscription of ours is created
    // alongside it.
    ebay
      .json('GET', '/notification/v1/topic', catalogue([{ topicId: 'ORDER_SALE_COMPLETED' }]))
      .json('GET', '/notification/v1/subscription?', {
        subscriptions: [
          {
            subscriptionId: 'sub-theirs',
            topicId: 'ORDER_SALE_COMPLETED',
            destinationId: 'somebody-elses-destination',
            status: 'ENABLED',
          },
        ],
      })
      .json('POST', '/notification/v1/subscription/sub-ours/enable', {}, 204)
      .json('POST', '/notification/v1/subscription', { subscriptionId: 'sub-ours' }, 201);

    const connection = await seed();
    const outcome = await topics.reconcile(connection);

    if (outcome.ok) {
      expect(outcome.report.topics[0]).toMatchObject({
        status: 'subscribed',
        subscriptionId: 'sub-ours',
      });
    }
  });

  it('reports a scope the seller did not grant as permission, and requires polling', async () => {
    ebay
      .json(
        'GET',
        '/notification/v1/topic',
        catalogue([{ topicId: 'ORDER_SALE_COMPLETED', scope: ORDER_SCOPE }]),
      )
      .json('GET', '/notification/v1/subscription?', { subscriptions: [] });

    const connection = await seed([CATALOG_SCOPE]);
    const outcome = await topics.reconcile(connection);

    if (outcome.ok) {
      expect(outcome.report.topics[0]).toMatchObject({
        status: 'unavailable',
        summary: expect.stringContaining('not granted'),
      });
      expect(outcome.report.pollingRequired).toContain('orders');
    }

    // Nothing was attempted: the refusal would have read like an outage.
    expect(ebay.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });

  it('requires polling for a family eBay offers no topic for at all', async () => {
    // The case a report derived only from returned topics would silently omit.
    ebay
      .json('GET', '/notification/v1/topic', catalogue([{ topicId: 'ORDER_SALE_COMPLETED' }]))
      .json('GET', '/notification/v1/subscription?', { subscriptions: [] })
      .json('POST', '/notification/v1/subscription/sub-1/enable', {}, 204)
      .json('POST', '/notification/v1/subscription', { subscriptionId: 'sub-1' }, 201);

    const connection = await seed();
    const outcome = await topics.reconcile(connection);

    if (outcome.ok) {
      expect(outcome.report.pollingRequired).toEqual(['revocation', 'catalog']);
    }
  });

  it('requires polling for a topic eBay reports as unavailable', async () => {
    ebay
      .json(
        'GET',
        '/notification/v1/topic',
        catalogue([{ topicId: 'ORDER_SALE_COMPLETED', status: 'DISABLED' }]),
      )
      .json('GET', '/notification/v1/subscription?', { subscriptions: [] });

    const connection = await seed();
    const outcome = await topics.reconcile(connection);

    if (outcome.ok) {
      expect(outcome.report.topics[0]?.status).toBe('unavailable');
      expect(outcome.report.pollingRequired).toContain('orders');
    }
  });

  it('requires polling for a topic with no JSON payload', async () => {
    ebay
      .json(
        'GET',
        '/notification/v1/topic',
        catalogue([{ topicId: 'ORDER_SALE_COMPLETED', json: false }]),
      )
      .json('GET', '/notification/v1/subscription?', { subscriptions: [] });

    const connection = await seed();
    const outcome = await topics.reconcile(connection);

    if (outcome.ok) {
      expect(outcome.report.topics[0]).toMatchObject({
        status: 'unavailable',
        summary: expect.stringContaining('JSON'),
      });
    }
  });

  it('records a refused subscription as failed rather than as unavailable', async () => {
    // Unavailable is a fact about eBay's catalogue; failed is something to
    // retry. Collapsing them sends an operator to the wrong place.
    ebay
      .json('GET', '/notification/v1/topic', catalogue([{ topicId: 'ORDER_SALE_COMPLETED' }]))
      .json('GET', '/notification/v1/subscription?', { subscriptions: [] })
      .json('POST', '/notification/v1/subscription', { errors: [{ message: 'no' }] }, 400);

    const connection = await seed();
    const outcome = await topics.reconcile(connection);

    if (outcome.ok) {
      expect(outcome.report.topics[0]?.status).toBe('failed');
      expect(outcome.report.pollingRequired).toContain('orders');
    }
  });

  it('records a subscription that was created and could not be enabled', async () => {
    ebay
      .json('GET', '/notification/v1/topic', catalogue([{ topicId: 'ORDER_SALE_COMPLETED' }]))
      .json('GET', '/notification/v1/subscription?', { subscriptions: [] })
      .json('POST', '/notification/v1/subscription', { subscriptionId: 'sub-1' }, 201)
      .down('POST', '/notification/v1/subscription/sub-1/enable');

    const connection = await seed();
    const outcome = await topics.reconcile(connection);

    if (outcome.ok) {
      expect(outcome.report.topics[0]).toMatchObject({
        status: 'failed',
        subscriptionId: 'sub-1',
      });
    }
  });

  it('persists what it found, and reads it back without calling eBay', async () => {
    ebay
      .json('GET', '/notification/v1/topic', catalogue([{ topicId: 'ORDER_SALE_COMPLETED' }]))
      .json('GET', '/notification/v1/subscription?', { subscriptions: [] })
      .json('POST', '/notification/v1/subscription/sub-1/enable', {}, 204)
      .json('POST', '/notification/v1/subscription', { subscriptionId: 'sub-1' }, 201);

    const connection = await seed();
    await topics.reconcile(connection);

    const rows = await harness.db
      .select()
      .from(providerNotificationTopics)
      .where(eq(providerNotificationTopics.connectionId, connection.connectionId));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      topic: 'ORDER_SALE_COMPLETED',
      status: 'subscribed',
      subscriptionId: 'sub-1',
    });
    expect(rows[0]?.subscribedAt).not.toBeNull();

    ebay.reset();
    await expect(topics.read(connection)).resolves.toMatchObject([{ status: 'subscribed' }]);
    expect(ebay.requests).toHaveLength(0);
  });

  it('clears the subscription moment when a topic stops being subscribed', async () => {
    const connection = await seed();

    ebay
      .json('GET', '/notification/v1/topic', catalogue([{ topicId: 'ORDER_SALE_COMPLETED' }]))
      .json('GET', '/notification/v1/subscription?', { subscriptions: [] })
      .json('POST', '/notification/v1/subscription/sub-1/enable', {}, 204)
      .json('POST', '/notification/v1/subscription', { subscriptionId: 'sub-1' }, 201);
    await topics.reconcile(connection);

    ebay.reset();
    ebay
      .json(
        'GET',
        '/notification/v1/topic',
        catalogue([{ topicId: 'ORDER_SALE_COMPLETED', status: 'DISABLED' }]),
      )
      .json('GET', '/notification/v1/subscription?', { subscriptions: [] });
    await topics.reconcile(connection);

    const [row] = await harness.db
      .select()
      .from(providerNotificationTopics)
      .where(eq(providerNotificationTopics.connectionId, connection.connectionId));

    expect(row).toMatchObject({ status: 'unavailable', subscribedAt: null });
  });

  it('does nothing at all when eBay will not say what is already subscribed', async () => {
    // Creating blind would duplicate subscriptions eBay then rejects, and the
    // report would claim failures that are nothing of the kind.
    ebay
      .json('GET', '/notification/v1/topic', FULL_CATALOGUE)
      .down('GET', '/notification/v1/subscription?');

    const connection = await seed();

    await expect(topics.reconcile(connection)).resolves.toEqual({
      ok: false,
      reason: 'provider_unavailable',
    });
    expect(ebay.requests.filter((request) => request.method === 'POST')).toHaveLength(0);
  });

  it('refuses to subscribe when there is nowhere to deliver', async () => {
    const without = createNotificationTopics({
      db: harness.db,
      http: ebay.client,
      applicationToken: () => Promise.resolve('app-token'),
      accessToken: () => Promise.resolve('seller-token'),
      destinationId: () => Promise.resolve(null),
    });

    await expect(without.reconcile(await seed())).resolves.toEqual({
      ok: false,
      reason: 'no_destination',
    });
    expect(ebay.requests).toHaveLength(0);
  });

  it('reports a connection with no usable seller credentials', async () => {
    const without = createNotificationTopics({
      db: harness.db,
      http: ebay.client,
      applicationToken: () => Promise.resolve('app-token'),
      accessToken: () => Promise.resolve(null),
      destinationId: () => Promise.resolve(DESTINATION),
    });

    await expect(without.reconcile(await seed())).resolves.toEqual({
      ok: false,
      reason: 'no_credentials',
    });
  });

  it('reports a connection that no longer exists', async () => {
    await expect(
      topics.reconcile({
        businessId: '00000000-0000-0000-0000-000000000000',
        connectionId: '00000000-0000-0000-0000-000000000000',
      }),
    ).resolves.toEqual({ ok: false, reason: 'connection_missing' });
  });
});
