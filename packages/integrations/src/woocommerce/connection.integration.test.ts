import { createHasher, loadKeyring } from '@eim/crypto';
import { businesses, connectionScopes, connections, memberships, users } from '@eim/db';
import type { HttpClient, HttpOutcome, UrlPolicy } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createAuthorizations, type Authorizations } from '../authorizations';
import { createSecretStore, type SecretStore } from '../secrets';
import {
  callbackUrl,
  createWooConnections,
  storeFromCallback,
  type WooConnections,
} from './connection';

/**
 * Connecting a WooCommerce store, end to end (section 14).
 *
 * The store is a programmable fake, because the cases that decide whether this
 * code is correct are the ones a real shop cannot be made to produce on demand:
 * a callback arriving with credentials for somebody else's store, a key that
 * WordPress issued and then revoked before it was used, a host that answers the
 * WordPress REST index and has no WooCommerce installed.
 *
 * No call leaves this process, and nothing here touches a live store.
 */

let harness: TestDatabase;
let secrets: SecretStore;
let authorizations: Authorizations;

const HASH_SECRET = 'a'.repeat(64);
const POLICY: UrlPolicy = { allowPrivate: false, allowInsecure: false, allowlist: [] };

/**
 * A store that answers by route.
 *
 * Longest-match-wins rather than first-registered, so a rule for `/products`
 * cannot silently answer the `/products/batch` probe — a fake whose routes
 * shadow each other proves whatever it likes.
 */
class FakeStore {
  public readonly calls: { method: string; url: string; authorization?: string }[] = [];
  private routes = new Map<string, HttpOutcome>();

  on(suffix: string, outcome: HttpOutcome): this {
    this.routes.set(suffix, outcome);

    return this;
  }

  reset(): void {
    this.calls.length = 0;
    this.routes.clear();
    this.on('/wp-json/', json({ namespaces: ['wp/v2', 'wc/v3'] }));
    this.on('/products', json([]));
    this.on('/products/batch', json({ create: [], update: [], delete: [] }));
  }

  readonly client: HttpClient = {
    send: (request) => {
      const authorization = request.headers?.['authorization'];

      this.calls.push({
        method: request.method,
        url: request.url,
        ...(authorization === undefined ? {} : { authorization }),
      });

      const path = new URL(request.url).pathname;
      const match = [...this.routes.keys()]
        .filter((suffix) => path.endsWith(suffix))
        .sort((a, b) => b.length - a.length)[0];

      const answer = match === undefined ? undefined : this.routes.get(match);

      if (answer === undefined) {
        return Promise.resolve<HttpOutcome>({
          ok: true,
          response: { status: 404, headers: {}, body: '{}', url: request.url },
        });
      }

      return Promise.resolve(answer);
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

function connectionsWith(): WooConnections {
  return createWooConnections({
    db: harness.db,
    http: store.client,
    secrets,
    authorizations,
    policy: POLICY,
    appName: 'Inventory Manager',
    publicUrl: 'https://inventory.example.invalid',
  });
}

beforeAll(async () => {
  harness = await createTestDatabase();
  secrets = createSecretStore({
    db: harness.db,
    keyring: loadKeyring({
      keyring: JSON.stringify([{ version: 1, key: Buffer.alloc(32, 9).toString('base64') }]),
      activeVersion: 1,
    }),
  });
  authorizations = createAuthorizations({ db: harness.db, hasher: createHasher(HASH_SECRET) });
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

beforeEach(() => {
  store.reset();
});

let counter = 0;

async function seedBusiness(): Promise<{ businessId: string; userId: string }> {
  const slug = `woo-${String((counter += 1))}`;

  const [business] = await harness.db
    .insert(businesses)
    .values({ name: `Business ${slug}`, slug })
    .returning({ id: businesses.id });
  const [user] = await harness.db
    .insert(users)
    .values({ email: `${slug}@example.invalid`, displayName: 'Owner' })
    .returning({ id: users.id });

  await harness.db
    .insert(memberships)
    .values({ businessId: business!.id, userId: user!.id, role: 'owner' });

  return { businessId: business!.id, userId: user!.id };
}

function stateFrom(url: string): string {
  return new URL(url).searchParams.get('user_id') ?? '';
}

describe('beginning a store connection', () => {
  it('sends the operator to their own store with the request we intend to make', async () => {
    const { businessId, userId } = await seedBusiness();
    const begun = await connectionsWith().begin({
      businessId,
      userId,
      storeUrl: 'HTTPS://Shop.Example/',
    });

    expect(begun.ok).toBe(true);

    if (!begun.ok) {
      return;
    }

    const url = new URL(begun.url);

    expect(url.origin + url.pathname).toBe('https://shop.example/wc-auth/v1/authorize');
    expect(url.searchParams.get('app_name')).toBe('Inventory Manager');
    expect(url.searchParams.get('scope')).toBe('read_write');
    // The store this callback is for is written into the URL handed to that one
    // store, so a callback arriving at it with a state issued for a different
    // store is a mismatch this application can see.
    expect(url.searchParams.get('callback_url')).toBe(
      callbackUrl('https://inventory.example.invalid', 'https://shop.example'),
    );
    expect(
      storeFromCallback((url.searchParams.get('callback_url') ?? '').split('/').at(-1) ?? ''),
    ).toBe('https://shop.example');
    expect(url.searchParams.get('user_id')).not.toBe('');
  });

  it('creates the connection before sending the operator away', async () => {
    // The store has to exist on this side first, because it is what the callback
    // is resolved against. A flow that creates the connection from the callback
    // is one where the callback chooses the destination.
    const { businessId, userId } = await seedBusiness();
    const begun = await connectionsWith().begin({
      businessId,
      userId,
      storeUrl: 'https://shop.example',
    });

    expect(begun.ok).toBe(true);

    const [row] = await harness.db
      .select()
      .from(connections)
      .where(eq(connections.id, begun.ok ? begun.connectionId : ''));

    expect(row).toMatchObject({
      provider: 'woocommerce',
      externalAccountId: 'https://shop.example',
      status: 'pending',
      environment: 'production',
    });
  });

  it('refuses an address this installation may not reach', async () => {
    const { businessId, userId } = await seedBusiness();

    await expect(
      connectionsWith().begin({ businessId, userId, storeUrl: 'http://169.254.169.254' }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_url' });
  });

  it('refuses a site that has a WordPress API and no WooCommerce', async () => {
    // Otherwise the operator is sent to an authorization page that does not
    // exist, and comes back with a 404 and no idea which of the two things they
    // configured was wrong.
    const { businessId, userId } = await seedBusiness();

    store.on('/wp-json/', json({ namespaces: ['wp/v2'] }));

    await expect(
      connectionsWith().begin({ businessId, userId, storeUrl: 'https://shop.example' }),
    ).resolves.toMatchObject({ ok: false, reason: 'not_woocommerce' });
  });

  it('accepts a store that guards its REST index', async () => {
    // 401 means the API is there and protected, which is the configuration
    // section 14 recommends. Refusing it would turn good practice into a fault.
    const { businessId, userId } = await seedBusiness();

    store.on('/wp-json/', json({ code: 'rest_forbidden' }, 401));

    await expect(
      connectionsWith().begin({ businessId, userId, storeUrl: 'https://shop.example' }),
    ).resolves.toMatchObject({ ok: true });
  });

  it('reports a store that did not answer as unreachable rather than as wrong', async () => {
    const { businessId, userId } = await seedBusiness();
    const offline: HttpClient = {
      send: () => Promise.resolve<HttpOutcome>({ ok: false, kind: 'timeout', reason: 'timed out' }),
    };

    const woo = createWooConnections({
      db: harness.db,
      http: offline,
      secrets,
      authorizations,
      policy: POLICY,
      appName: 'Inventory Manager',
      publicUrl: 'https://inventory.example.invalid',
    });

    await expect(
      woo.begin({ businessId, userId, storeUrl: 'https://shop.example' }),
    ).resolves.toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('refuses a second connection to a store this business already has', async () => {
    const { businessId, userId } = await seedBusiness();
    const woo = connectionsWith();

    await woo.begin({ businessId, userId, storeUrl: 'https://shop.example' });

    // The same store, spelled differently. Canonicalization is what makes this
    // the same store rather than a second one importing the same orders.
    await expect(
      woo.begin({ businessId, userId, storeUrl: 'https://shop.example/wp-json/wc/v3' }),
    ).resolves.toMatchObject({ ok: false, reason: 'already_connected' });
  });

  it('lets two businesses connect the same store', async () => {
    const first = await seedBusiness();
    const second = await seedBusiness();
    const woo = connectionsWith();

    await expect(
      woo.begin({ ...first, storeUrl: 'https://shared.example' }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      woo.begin({ ...second, storeUrl: 'https://shared.example' }),
    ).resolves.toMatchObject({ ok: true });
  });
});

describe('completing a store connection', () => {
  async function begin() {
    const owner = await seedBusiness();
    const woo = connectionsWith();
    const begun = await woo.begin({ ...owner, storeUrl: 'https://shop.example' });

    if (!begun.ok) {
      throw new Error('the flow did not begin');
    }

    return { owner, woo, begun, state: stateFrom(begun.url) };
  }

  it('stores the key, activates the connection, and records what it may do', async () => {
    const { owner, woo, begun, state } = await begin();

    const completed = await woo.complete({
      state,
      storeOrigin: 'https://shop.example',
      consumerKey: 'ck_live',
      consumerSecret: 'cs_live',
      keyPermissions: 'read_write',
    });

    expect(completed).toMatchObject({
      ok: true,
      connectionId: begun.connectionId,
      created: true,
      permissions: 'read_write',
      impairedCapabilities: [],
    });

    const [row] = await harness.db
      .select()
      .from(connections)
      .where(eq(connections.id, begun.connectionId));

    expect(row?.status).toBe('active');
    expect(row?.activatedAt).not.toBeNull();

    await expect(
      secrets.read(
        { businessId: owner.businessId, connectionId: begun.connectionId },
        'woocommerce_consumer_secret',
      ),
    ).resolves.toBe('cs_live');

    const scopes = await harness.db
      .select({ scope: connectionScopes.scope })
      .from(connectionScopes)
      .where(eq(connectionScopes.connectionId, begun.connectionId));

    expect(scopes).toEqual([{ scope: 'woocommerce:read_write' }]);
  });

  it('never sends the credential in a URL', async () => {
    const { woo, state } = await begin();

    await woo.complete({
      state,
      storeOrigin: 'https://shop.example',
      consumerKey: 'ck_live',
      consumerSecret: 'cs_live',
    });

    for (const call of store.calls) {
      expect(call.url).not.toContain('ck_live');
      expect(call.url).not.toContain('cs_live');
      expect(call.url).not.toContain('consumer_key');
    }

    expect(store.calls.some((call) => call.authorization?.startsWith('Basic ') === true)).toBe(
      true,
    );
  });

  it('keeps a read-only key and pauses only the capabilities it cannot do', async () => {
    // A read key is a perfectly good key for importing a catalog. Refusing it
    // would tell an operator who granted exactly what they meant to grant that
    // they had done something wrong.
    const { woo, state } = await begin();

    const completed = await woo.complete({
      state,
      storeOrigin: 'https://shop.example',
      consumerKey: 'ck_read',
      consumerSecret: 'cs_read',
      keyPermissions: 'read',
    });

    expect(completed).toMatchObject({ ok: true, permissions: 'read' });

    if (!completed.ok) {
      return;
    }

    expect(completed.availableCapabilities).toContain('import_catalog');
    expect(completed.impairedCapabilities).toContain('write_quantities');
    expect(completed.impairedCapabilities).toContain('manage_webhooks');
  });

  it('treats an unfamiliar permission string as read-only', async () => {
    const { woo, state } = await begin();

    await expect(
      woo.complete({
        state,
        storeOrigin: 'https://shop.example',
        consumerKey: 'ck',
        consumerSecret: 'cs',
        keyPermissions: 'superuser',
      }),
    ).resolves.toMatchObject({ ok: true, permissions: 'read' });
  });

  it('stores nothing when the store rejects the key', async () => {
    const { owner, woo, begun, state } = await begin();

    store.on('/products', json({ code: 'woocommerce_rest_authentication_error' }, 401));

    await expect(
      woo.complete({
        state,
        storeOrigin: 'https://shop.example',
        consumerKey: 'ck_bad',
        consumerSecret: 'cs_bad',
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'credentials_rejected' });

    await expect(
      secrets.read(
        { businessId: owner.businessId, connectionId: begun.connectionId },
        'woocommerce_consumer_key',
      ),
    ).resolves.toBeNull();

    const [row] = await harness.db
      .select()
      .from(connections)
      .where(eq(connections.id, begun.connectionId));

    expect(row?.status).toBe('pending');
  });

  it('leaves a working key in place when a replacement is rejected', async () => {
    // The failure that matters on a key rotation: writing the new key first and
    // proving it afterwards leaves a store connected with a credential that does
    // not work, and the one that did work has already been retired.
    const { owner, woo, begun, state } = await begin();

    await woo.complete({
      state,
      storeOrigin: 'https://shop.example',
      consumerKey: 'ck_good',
      consumerSecret: 'cs_good',
    });

    const second = await woo.begin({
      ...owner,
      storeUrl: 'https://shop.example',
      connectionId: begun.connectionId,
    });

    store.on('/products', json({}, 401));

    await expect(
      woo.complete({
        state: stateFrom(second.ok ? second.url : ''),
        storeOrigin: 'https://shop.example',
        consumerKey: 'ck_bad',
        consumerSecret: 'cs_bad',
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'credentials_rejected' });

    await expect(
      secrets.read(
        { businessId: owner.businessId, connectionId: begun.connectionId },
        'woocommerce_consumer_key',
      ),
    ).resolves.toBe('ck_good');
  });

  it('spends the state once', async () => {
    const { woo, state } = await begin();

    await woo.complete({
      state,
      storeOrigin: 'https://shop.example',
      consumerKey: 'ck',
      consumerSecret: 'cs',
    });

    // The state value travels through the store's database and the operator's
    // browser history. Replaying it must not bind a second credential.
    await expect(
      woo.complete({
        state,
        storeOrigin: 'https://shop.example',
        consumerKey: 'ck_attacker',
        consumerSecret: 'cs_attacker',
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'state_already_used' });
  });

  it('refuses a callback delivered to a different store’s callback URL', async () => {
    // A state value travels through the store's own database and through the
    // operator's browser history, so treat it as obtainable. Replayed against
    // the callback URL issued for another store, it names a store the
    // authorization was not issued for, and that is visible from here.
    const { woo, state } = await begin();

    await expect(
      woo.complete({
        state,
        storeOrigin: 'https://attacker.example',
        consumerKey: 'ck',
        consumerSecret: 'cs',
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_state' });
  });

  it('refuses a state that was never issued', async () => {
    const { woo } = await begin();

    await expect(
      woo.complete({
        state: '00000000-0000-4000-8000-000000000000.forged',
        storeOrigin: 'https://shop.example',
        consumerKey: 'ck',
        consumerSecret: 'cs',
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_state' });
  });

  it('refuses an expired state', async () => {
    const { woo, state } = await begin();

    await expect(
      woo.complete({
        state,
        storeOrigin: 'https://shop.example',
        consumerKey: 'ck',
        consumerSecret: 'cs',
        now: new Date(Date.now() + 60 * 60_000),
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'state_expired' });
  });

  it('takes the destination from the connection, never from the callback', async () => {
    // The security property the whole flow rests on. WordPress does not sign the
    // callback, so a stolen state value is a real possibility — and it buys
    // nothing, because the key it carries is proven against the bound store
    // rather than against whatever the caller had in mind.
    const { woo, begun, state } = await begin();

    await woo.complete({
      state,
      storeOrigin: 'https://shop.example',
      consumerKey: 'ck_live',
      consumerSecret: 'cs_live',
    });

    const authenticated = store.calls.filter((call) => call.authorization !== undefined);

    expect(authenticated.length).toBeGreaterThan(0);

    for (const call of authenticated) {
      expect(new URL(call.url).origin).toBe('https://shop.example');
    }

    const [row] = await harness.db
      .select()
      .from(connections)
      .where(eq(connections.id, begun.connectionId));

    expect(row?.externalAccountId).toBe('https://shop.example');
  });

  it('keeps the activation moment across a key replacement', async () => {
    // It divides historical orders from ones this application is answerable for.
    // Moving it on every rotation would reclassify a year of history.
    const { owner, woo, begun, state } = await begin();

    await woo.complete({
      state,
      storeOrigin: 'https://shop.example',
      consumerKey: 'ck_1',
      consumerSecret: 'cs_1',
    });

    const [first] = await harness.db
      .select({ activatedAt: connections.activatedAt })
      .from(connections)
      .where(eq(connections.id, begun.connectionId));

    const again = await woo.begin({
      ...owner,
      storeUrl: 'https://shop.example',
      connectionId: begun.connectionId,
    });

    await woo.complete({
      state: stateFrom(again.ok ? again.url : ''),
      storeOrigin: 'https://shop.example',
      consumerKey: 'ck_2',
      consumerSecret: 'cs_2',
    });

    const [second] = await harness.db
      .select({ activatedAt: connections.activatedAt })
      .from(connections)
      .where(eq(connections.id, begun.connectionId));

    expect(second?.activatedAt).toEqual(first?.activatedAt);
  });
});

describe('connecting with a key made by hand', () => {
  it('proves the key against the store before keeping it', async () => {
    const owner = await seedBusiness();

    const connected = await connectionsWith().connectManually({
      ...owner,
      storeUrl: 'https://manual.example',
      consumerKey: 'ck_manual',
      consumerSecret: 'cs_manual',
    });

    expect(connected).toMatchObject({ ok: true, created: true });

    if (!connected.ok) {
      return;
    }

    const [row] = await harness.db
      .select()
      .from(connections)
      .where(
        and(
          eq(connections.businessId, owner.businessId),
          eq(connections.externalAccountId, 'https://manual.example'),
        ),
      );

    expect(row?.status).toBe('active');
  });

  it('finds out what the key can do rather than assuming', async () => {
    const owner = await seedBusiness();

    store.on('/products/batch', json({ code: 'woocommerce_rest_cannot_create' }, 401));

    await expect(
      connectionsWith().connectManually({
        ...owner,
        storeUrl: 'https://readonly.example',
        consumerKey: 'ck',
        consumerSecret: 'cs',
      }),
    ).resolves.toMatchObject({ ok: true, permissions: 'read' });
  });

  it('does not claim write access on an answer it cannot interpret', async () => {
    // Understating the key hides capabilities and can be corrected by looking.
    // Overstating it offers writes that fail when somebody is relying on them.
    const owner = await seedBusiness();

    store.on('/products/batch', json({}, 500));

    await expect(
      connectionsWith().connectManually({
        ...owner,
        storeUrl: 'https://odd.example',
        consumerKey: 'ck',
        consumerSecret: 'cs',
      }),
    ).resolves.toMatchObject({ ok: true, permissions: 'read' });
  });

  it('refuses a key the store does not accept', async () => {
    const owner = await seedBusiness();

    store.on('/products', json({}, 401));

    await expect(
      connectionsWith().connectManually({
        ...owner,
        storeUrl: 'https://guarded.example',
        consumerKey: 'ck',
        consumerSecret: 'cs',
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'credentials_rejected' });
  });

  it('refuses an address the installation may not reach', async () => {
    const owner = await seedBusiness();

    await expect(
      connectionsWith().connectManually({
        ...owner,
        storeUrl: 'http://127.0.0.1:8080',
        consumerKey: 'ck',
        consumerSecret: 'cs',
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid_url' });
  });

  it('replaces the key on a store that is already connected', async () => {
    const owner = await seedBusiness();
    const woo = connectionsWith();

    const first = await woo.connectManually({
      ...owner,
      storeUrl: 'https://rotate.example',
      consumerKey: 'ck_old',
      consumerSecret: 'cs_old',
    });

    const second = await woo.connectManually({
      ...owner,
      storeUrl: 'https://rotate.example',
      consumerKey: 'ck_new',
      consumerSecret: 'cs_new',
    });

    expect(second).toMatchObject({ ok: true, created: false });
    expect(first.ok && second.ok && first.connectionId === second.connectionId).toBe(true);

    await expect(
      secrets.read(
        {
          businessId: owner.businessId,
          connectionId: first.ok ? first.connectionId : '',
        },
        'woocommerce_consumer_key',
      ),
    ).resolves.toBe('ck_new');
  });
});
