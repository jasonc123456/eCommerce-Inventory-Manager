import { loadKeyring } from '@eim/crypto';
import { businesses, connectionScopes, connections, users } from '@eim/db';
import type { HttpClient, HttpOutcome, UrlPolicy } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createSecretStore, type SecretStore } from '../secrets';
import { createWooReadiness } from './readiness';

/**
 * What a store is and is not set up to do (section 14).
 *
 * The case this suite exists for is global stock management being switched off.
 * A store in that state accepts a quantity write, stores the number, and ignores
 * it completely — orders do not decrement it and nothing enforces it. Every
 * request succeeds and the integration does nothing, which is the worst failure
 * available because no part of it looks like a failure.
 */

let harness: TestDatabase;
let secrets: SecretStore;

const POLICY: UrlPolicy = { allowPrivate: true, allowInsecure: true, allowlist: [] };

class FakeStore {
  private routes = new Map<string, HttpOutcome>();

  on(suffix: string, outcome: HttpOutcome): this {
    this.routes.set(suffix, outcome);

    return this;
  }

  reset(): void {
    this.routes.clear();
    this.on('/products', json([]));
    this.on('/settings/products', json([{ id: 'woocommerce_manage_stock', value: 'yes' }]));
    this.on('/webhooks', json([]));
  }

  readonly client: HttpClient = {
    send: (request) => {
      const path = new URL(request.url).pathname;
      const match = [...this.routes.keys()]
        .filter((suffix) => path.endsWith(suffix))
        .sort((a, b) => b.length - a.length)[0];

      return Promise.resolve(
        (match === undefined ? undefined : this.routes.get(match)) ?? {
          ok: true,
          response: { status: 404, headers: {}, body: '{}', url: request.url },
        },
      );
    },
  };
}

function json(payload: unknown, status = 200): HttpOutcome {
  return {
    ok: true,
    response: {
      status,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      url: 'https://shop.example/',
    },
  };
}

const store = new FakeStore();

const readiness = () =>
  createWooReadiness({ db: harness.db, http: store.client, secrets, policy: POLICY });

beforeAll(async () => {
  harness = await createTestDatabase();
  secrets = createSecretStore({
    db: harness.db,
    keyring: loadKeyring({
      keyring: JSON.stringify([{ version: 1, key: Buffer.alloc(32, 4).toString('base64') }]),
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

interface Seeded {
  businessId: string;
  connectionId: string;
}

async function seedConnection(
  options: {
    storeUrl?: string;
    permissions?: string;
    status?: 'active' | 'paused' | 'disconnected';
    withKey?: boolean;
  } = {},
): Promise<Seeded> {
  const slug = `woo-ready-${String((counter += 1))}`;

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
      externalAccountId: options.storeUrl ?? `https://${slug}.example`,
      displayName: slug,
      status: options.status ?? 'active',
      connectedAt: new Date(),
      activatedAt: new Date(),
      // The database refuses a disconnected connection with no disconnection
      // moment, which is the constraint doing its job rather than a nuisance.
      ...(options.status === 'disconnected' ? { disconnectedAt: new Date() } : {}),
      createdByUserId: user!.id,
    })
    .returning({ id: connections.id });

  await harness.db.insert(connectionScopes).values({
    businessId: business!.id,
    connectionId: connection!.id,
    scope: `woocommerce:${options.permissions ?? 'read_write'}`,
  });

  if (options.withKey !== false) {
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
  }

  return { businessId: business!.id, connectionId: connection!.id };
}

function statusOf(
  report: { checks: readonly { name: string; status: string }[] },
  name: string,
): string | undefined {
  return report.checks.find((check) => check.name === name)?.status;
}

describe('assessing a store', () => {
  it('reports a well-configured store as ready for everything', async () => {
    const seeded = await seedConnection();
    const report = await readiness().assess(seeded);

    expect(statusOf(report, 'identity')).toBe('pass');
    expect(statusOf(report, 'credentials')).toBe('pass');
    expect(statusOf(report, 'stock_management')).toBe('pass');
    expect(statusOf(report, 'webhooks')).toBe('pass');
    expect(report.blocked).toEqual([]);
    expect(report.available).toContain('write_quantities');
  });

  it('blocks quantity writes when the store does not manage stock globally', async () => {
    const seeded = await seedConnection();

    store.on('/settings/products', json([{ id: 'woocommerce_manage_stock', value: 'no' }]));

    const report = await readiness().assess(seeded);

    expect(statusOf(report, 'stock_management')).toBe('fail');
    expect(report.blocked).toContainEqual({
      capability: 'write_quantities',
      because: 'stock_management',
    });
    // Importing from such a store is perfectly meaningful, so it is not blocked.
    expect(report.available).toContain('import_catalog');
  });

  it('guides rather than switches the setting on', async () => {
    // Section 14: never enable automatically. Turning it on changes how the shop
    // behaves for every customer, which is a shopkeeper's decision.
    const seeded = await seedConnection();

    store.on('/settings/products', json([{ id: 'woocommerce_manage_stock', value: 'no' }]));

    const report = await readiness().assess(seeded);
    const check = report.checks.find((entry) => entry.name === 'stock_management');

    expect(check?.detail['remedy']).toEqual(expect.stringContaining('Manage stock'));
  });

  it('reports a setting the store did not mention as unknown, not as off', async () => {
    const seeded = await seedConnection();

    store.on('/settings/products', json([{ id: 'woocommerce_notify_low_stock', value: 'yes' }]));

    const report = await readiness().assess(seeded);

    expect(statusOf(report, 'stock_management')).toBe('unknown');
    // Unknown blocks as firmly as fail: a write enabled on an unperformed check
    // fails on its first real use.
    expect(report.blocked).toContainEqual({
      capability: 'write_quantities',
      because: 'stock_management',
    });
  });

  it('fails the credential check when the store rejects the key', async () => {
    const seeded = await seedConnection();

    store.on('/products', json({}, 401));

    const report = await readiness().assess(seeded);

    expect(statusOf(report, 'credentials')).toBe('fail');
    expect(statusOf(report, 'stock_management')).toBe('unknown');
    expect(report.available).toEqual([]);
  });

  it('degrades rather than fails when webhooks cannot be managed', async () => {
    // Section 14 keeps polling running regardless, so a store whose webhooks are
    // unavailable is one this application still works with.
    const seeded = await seedConnection();

    store.on('/webhooks', json({}, 403));

    const report = await readiness().assess(seeded);

    expect(statusOf(report, 'webhooks')).toBe('warn');
    expect(report.available).toContain('import_catalog');
    expect(report.available).toContain('manage_webhooks');
  });

  it('reports a store with no webhook route as degraded', async () => {
    const seeded = await seedConnection();

    store.on('/webhooks', json({}, 404));

    const report = await readiness().assess(seeded);

    expect(statusOf(report, 'webhooks')).toBe('warn');
  });

  it('blocks write capabilities a read-only key cannot reach', async () => {
    const seeded = await seedConnection({ permissions: 'read' });
    const report = await readiness().assess(seeded);

    expect(report.blocked).toContainEqual({
      capability: 'write_quantities',
      because: 'permissions',
    });
    expect(report.available).toContain('import_orders');
  });

  it('points at the missing credential rather than at four symptoms of it', async () => {
    const seeded = await seedConnection({ withKey: false });
    const report = await readiness().assess(seeded);

    expect(statusOf(report, 'api_reachable')).toBe('unknown');
    expect(statusOf(report, 'credentials')).toBe('unknown');
    expect(report.available).toEqual([]);
  });

  it('separates a store that did not answer from one that answered badly', async () => {
    const seeded = await seedConnection();
    const offline = createWooReadiness({
      db: harness.db,
      secrets,
      policy: POLICY,
      http: {
        send: () =>
          Promise.resolve<HttpOutcome>({ ok: false, kind: 'timeout', reason: 'timed out' }),
      },
    });

    const report = await offline.assess(seeded);

    expect(statusOf(report, 'credentials')).toBe('unknown');
    expect(statusOf(report, 'api_reachable')).toBe('fail');
  });

  it('warns for as long as a store is connected over plain HTTP', async () => {
    // The consumer key is sent on every request, and on that transport it is
    // sent in clear. It stays a warning rather than becoming a one-time notice.
    const seeded = await seedConnection({ storeUrl: 'http://dev.example' });
    const report = await readiness().assess(seeded);

    expect(statusOf(report, 'identity')).toBe('warn');
  });

  it('fails everything for a disconnected store', async () => {
    const seeded = await seedConnection({ status: 'disconnected' });
    const report = await readiness().assess(seeded);

    expect(statusOf(report, 'identity')).toBe('fail');
    expect(report.available).toEqual([]);
  });

  it('reports a connection that no longer exists without throwing', async () => {
    const report = await readiness().assess({
      businessId: '00000000-0000-4000-8000-000000000000',
      connectionId: '00000000-0000-4000-8000-000000000001',
    });

    expect(report.checks).toHaveLength(1);
    expect(report.available).toEqual([]);
  });
});

describe('reading a recorded assessment', () => {
  it('gives the same answer without calling the store', async () => {
    const seeded = await seedConnection();
    const assessed = await readiness().assess(seeded);

    const offline = createWooReadiness({
      db: harness.db,
      secrets,
      policy: POLICY,
      http: {
        send: () => {
          throw new Error('the recorded assessment must not call the store');
        },
      },
    });

    const read = await offline.read(seeded);

    expect(read?.available).toEqual(assessed.available);
    expect(read?.blocked).toEqual(assessed.blocked);
  });

  it('replaces the previous assessment rather than merging with it', async () => {
    // A check that stopped being run would otherwise keep its last answer
    // forever, and an old `pass` is worse than no answer at all.
    const seeded = await seedConnection();

    await readiness().assess(seeded);

    store.on('/products', json({}, 401));

    await readiness().assess(seeded);

    const read = await readiness().read(seeded);

    expect(statusOf(read!, 'credentials')).toBe('fail');
    expect(statusOf(read!, 'stock_management')).toBe('unknown');
  });

  it('reports nothing for a store that has never been assessed', async () => {
    const seeded = await seedConnection();

    await expect(readiness().read(seeded)).resolves.toBeNull();
  });
});
