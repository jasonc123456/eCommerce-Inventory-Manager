import { connectionScopes, connections, type Database } from '@eim/db';
import type { HttpClient, UrlPolicy } from '@eim/providers';
import { and, eq } from 'drizzle-orm';

import type { Authorizations } from '../authorizations';
import type { SecretStore } from '../secrets';
import { createWooClient, parseJsonObject, type WooClient } from './client';
import { describeStore, type WooStore } from './store';

/**
 * Connecting a WooCommerce store, and proving it is connected (section 14).
 *
 * WooCommerce's `/wc-auth/v1/authorize` flow is not OAuth and does not behave
 * like it. The store owner approves a named application in their own admin, and
 * WordPress then makes a *server-to-server* POST carrying a freshly minted
 * consumer key and secret to a callback URL this application supplied. There is
 * no code to exchange, no token to refresh, and — this is the part that shapes
 * the whole file — nothing signs that callback.
 *
 * So the callback is treated as what it is: an unauthenticated request carrying
 * a credential and a state value, from which exactly one thing is taken.
 *
 *   The destination never comes from the callback. It comes from the connection
 *   row the flow created before the operator was sent anywhere. A callback can
 *   therefore supply a key, but it cannot say which store that key is for, and
 *   the case that would otherwise be an attack — somebody replaying a state
 *   value from a browser URL with their own store's credentials — ends with
 *   credentials that do not authenticate against the bound store and nothing
 *   stored at all.
 *
 *   The credential is proven before it is kept. A key that arrives and is
 *   written down unverified produces a connection that looks healthy until its
 *   first import, at which point the operator is debugging a store they
 *   correctly approved days earlier.
 *
 *   Reduced permissions pause capabilities rather than the connection. A
 *   read-only key is a perfectly good key for importing a catalog, and
 *   refusing it outright would tell an operator who granted exactly what they
 *   meant to grant that they had done something wrong.
 *
 * The manual consumer-key path (section 14's documented fallback for hosts
 * where the authorization flow fails) runs through the same verification and
 * the same store description, because a fallback that skips the checks is a
 * second, weaker way in.
 */

export type WooPermissions = 'read' | 'write' | 'read_write';

/**
 * What a permission level lets this application do.
 *
 * `write` alone is not a mistake in the table: WooCommerce really does issue
 * write-only keys, and nothing this application does is useful without reading
 * first, so every capability requires read.
 */
const CAPABILITY_PERMISSIONS: Readonly<Record<string, readonly WooPermissions[]>> = {
  import_catalog: ['read', 'read_write'],
  import_orders: ['read', 'read_write'],
  import_refunds: ['read', 'read_write'],
  manage_webhooks: ['read_write'],
  write_quantities: ['read_write'],
  publish_products: ['read_write'],
  change_prices: ['read_write'],
};

export function capabilitiesFor(permissions: WooPermissions): {
  available: string[];
  impaired: string[];
} {
  const available: string[] = [];
  const impaired: string[] = [];

  for (const [capability, allowed] of Object.entries(CAPABILITY_PERMISSIONS)) {
    (allowed.includes(permissions) ? available : impaired).push(capability);
  }

  return { available, impaired };
}

export interface BeginStoreConnection {
  readonly businessId: string;
  readonly userId: string;
  /** Whatever the operator typed. Canonicalized here, not by the caller. */
  readonly storeUrl: string;
  /** Set when replacing the key on an existing connection. */
  readonly connectionId?: string | undefined;
  readonly redirectPath?: string;
  readonly now?: Date;
}

export type BeginStoreResult =
  | {
      readonly ok: true;
      /** Where to send the operator. */
      readonly url: string;
      readonly connectionId: string;
      readonly store: WooStore;
    }
  | { readonly ok: false; readonly reason: BeginStoreFailure; readonly detail: string };

export type BeginStoreFailure =
  /** The address is not one this installation may connect to. */
  | 'invalid_url'
  /** The store did not answer at all. */
  | 'unreachable'
  /** The store answered and has no WooCommerce REST API. */
  | 'not_woocommerce'
  /** A live connection to this store already exists for this business. */
  | 'already_connected';

export interface CompleteStoreConnection {
  /** The value returned in WooCommerce's `user_id` field. */
  readonly state: string;
  /**
   * The store this callback URL was issued for, read back out of the URL the
   * request arrived at. See `callbackUrl`.
   */
  readonly storeOrigin: string;
  readonly consumerKey: string;
  readonly consumerSecret: string;
  readonly keyPermissions?: string | undefined;
  readonly now?: Date;
}

export interface ManualStoreConnection {
  readonly businessId: string;
  readonly userId: string;
  readonly storeUrl: string;
  readonly consumerKey: string;
  readonly consumerSecret: string;
  readonly connectionId?: string | undefined;
  readonly now?: Date;
}

export type CompleteStoreResult =
  | {
      readonly ok: true;
      readonly connectionId: string;
      readonly created: boolean;
      readonly store: WooStore;
      readonly permissions: WooPermissions;
      readonly availableCapabilities: readonly string[];
      readonly impairedCapabilities: readonly string[];
      readonly redirectPath: string;
    }
  | { readonly ok: false; readonly reason: CompleteStoreFailure; readonly detail?: string };

export type CompleteStoreFailure =
  | 'invalid_state'
  | 'state_expired'
  | 'state_already_used'
  | 'invalid_url'
  | 'unknown_connection'
  /** The key does not authenticate against the bound store. */
  | 'credentials_rejected'
  /** The store could not be reached to prove the key. */
  | 'unreachable';

export interface WooConnectionOptions {
  readonly db: Database;
  readonly http: HttpClient;
  readonly secrets: SecretStore;
  readonly authorizations: Authorizations;
  /** Decides which destinations this installation may reach at all. */
  readonly policy: UrlPolicy;
  /** Shown to the store owner on the approval screen. */
  readonly appName: string;
  /** This application's public base, for the return and callback URLs. */
  readonly publicUrl: string;
}

export interface WooConnections {
  begin(input: BeginStoreConnection): Promise<BeginStoreResult>;
  /** Handles WooCommerce's server-to-server credential callback. */
  complete(input: CompleteStoreConnection): Promise<CompleteStoreResult>;
  /** Section 14's fallback: a key the operator created by hand. */
  connectManually(input: ManualStoreConnection): Promise<CompleteStoreResult>;
}

export function createWooConnections(options: WooConnectionOptions): WooConnections {
  const { db, http, secrets, authorizations, policy } = options;
  const base = options.publicUrl.trim().replace(/\/+$/, '');

  return {
    async begin(input) {
      const now = input.now ?? new Date();
      const described = describeStore(input.storeUrl, policy);

      if (!described.ok) {
        return { ok: false, reason: 'invalid_url', detail: described.reason };
      }

      const store = described.store;
      const probe = await probeRestApi(http, store);

      if (!probe.ok) {
        return { ok: false, reason: probe.reason, detail: probe.detail };
      }

      const existing = await liveConnection(db, input.businessId, store.base);

      // Reconnecting a store that is already connected is a key replacement, and
      // it has to name the connection it is replacing. Without that, an operator
      // reconnecting a store gets a second connection to it, and every mapping
      // stays pointed at the first.
      if (existing !== null && existing.id !== input.connectionId) {
        return {
          ok: false,
          reason: 'already_connected',
          detail: 'this business already has a connection to this store',
        };
      }

      const connectionId =
        existing?.id ??
        (await createPending(db, {
          businessId: input.businessId,
          userId: input.userId,
          store,
          now,
        }));

      const { state } = await authorizations.begin({
        businessId: input.businessId,
        provider: 'woocommerce',
        environment: store.environment,
        initiatedByUserId: input.userId,
        connectionId,
        storeOrigin: store.origin,
        redirectPath: input.redirectPath ?? '/connections',
        now,
      });

      const url = new URL(store.authorizeUrl);

      url.searchParams.set('app_name', options.appName);
      url.searchParams.set('scope', 'read_write');
      // WooCommerce echoes this back in the callback. It is the state value, and
      // the field is named `user_id` because the flow was designed for
      // applications that key their side on a user.
      url.searchParams.set('user_id', state);
      url.searchParams.set('return_url', `${base}/connections/woocommerce/return`);
      url.searchParams.set('callback_url', callbackUrl(base, store.origin));

      return { ok: true, url: url.toString(), connectionId, store };
    },

    async complete(input) {
      const now = input.now ?? new Date();
      const spent = await authorizations.consume({
        state: input.state,
        storeOrigin: input.storeOrigin,
        now,
      });

      if (!spent.ok) {
        return { ok: false, reason: stateFailure(spent.reason) };
      }

      const authorization = spent.authorization;

      if (authorization.connectionId === null) {
        return { ok: false, reason: 'unknown_connection' };
      }

      const [row] = await db
        .select()
        .from(connections)
        .where(
          and(
            eq(connections.id, authorization.connectionId),
            eq(connections.businessId, authorization.businessId),
          ),
        )
        .limit(1);

      if (row === undefined) {
        return { ok: false, reason: 'unknown_connection' };
      }

      const described = describeStore(row.externalAccountId, policy);

      if (!described.ok) {
        // The stored address stopped satisfying the installation's policy — the
        // development flag was turned off, most likely. Refusing beats writing a
        // credential for a store this installation may no longer call.
        return { ok: false, reason: 'invalid_url', detail: described.reason };
      }

      return adopt({
        db,
        http,
        secrets,
        businessId: authorization.businessId,
        connectionId: row.id,
        created: row.status === 'pending' && row.connectedAt === null,
        store: described.store,
        credentials: { consumerKey: input.consumerKey, consumerSecret: input.consumerSecret },
        permissions: readPermissions(input.keyPermissions),
        redirectPath: authorization.redirectPath,
        now,
      });
    },

    async connectManually(input) {
      const now = input.now ?? new Date();
      const described = describeStore(input.storeUrl, policy);

      if (!described.ok) {
        return { ok: false, reason: 'invalid_url', detail: described.reason };
      }

      const store = described.store;
      const existing = await liveConnection(db, input.businessId, store.base);

      if (
        existing !== null &&
        input.connectionId !== undefined &&
        existing.id !== input.connectionId
      ) {
        return { ok: false, reason: 'unknown_connection' };
      }

      const connectionId =
        existing?.id ??
        (await createPending(db, {
          businessId: input.businessId,
          userId: input.userId,
          store,
          now,
        }));

      return adopt({
        db,
        http,
        secrets,
        businessId: input.businessId,
        connectionId,
        created: existing === null,
        store,
        credentials: { consumerKey: input.consumerKey, consumerSecret: input.consumerSecret },
        // A hand-made key does not announce what it can do. It is probed rather
        // than assumed, because assuming `read_write` offers capabilities that
        // fail on first use and assuming `read` hides ones the operator granted.
        permissions: null,
        redirectPath: '/connections',
        now,
      });
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * Where WooCommerce is told to deliver the credential, with the store it is
 * being delivered for written into the path.
 *
 * The alternative was to leave the authorization unbound, on the reasoning that
 * a server-to-server POST makes no origin claim to check. That reasoning is
 * wrong in one specific way: the callback URL is not the caller's claim, it is
 * *this application's* statement, made at the moment the flow began and handed
 * to one store. A callback arriving at the URL issued for store A carrying a
 * state issued for store B is therefore a genuine mismatch, and it is exactly
 * the confusion an attacker replaying a stolen state would produce.
 *
 * It is a second lock rather than the only one. Even a callback that matches
 * here still has its credential proven against the store named on the connection
 * row, so the destination is never something the caller supplied.
 *
 * base64url rather than percent-encoding, because the value is a whole URL and
 * a path segment holding an encoded `://` is the kind of thing a reverse proxy
 * normalizes on the way past.
 */
export function callbackUrl(publicBase: string, storeOrigin: string): string {
  const encoded = Buffer.from(storeOrigin, 'utf8').toString('base64url');

  return `${publicBase}/api/connections/woocommerce/callback/${encoded}`;
}

/** Reads the store back out of a callback path segment. */
export function storeFromCallback(segment: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(segment)) {
    return null;
  }

  const decoded = Buffer.from(segment, 'base64url').toString('utf8');

  try {
    // Round-tripped through the URL parser rather than trusted as text: what
    // comes back is compared against a stored origin, and a value that is not an
    // origin at all should fail here rather than fail to match.
    return new URL(decoded).origin === decoded ? decoded : null;
  } catch {
    return null;
  }
}

/**
 * Whether the address is a WooCommerce store at all, before an operator is sent
 * away to approve something.
 *
 * Unauthenticated, because there is no credential yet. A store that restricts
 * its REST index answers 401 or 403, and that is not a refusal — it is a store
 * that exists and is guarded, which is the configuration section 14 recommends.
 * Only a store that answers and has no `wc/v3` namespace is turned away.
 */
async function probeRestApi(
  http: HttpClient,
  store: WooStore,
): Promise<
  { ok: true } | { ok: false; reason: 'unreachable' | 'not_woocommerce'; detail: string }
> {
  const outcome = await http.send({
    method: 'GET',
    url: `${store.base}/wp-json/`,
    headers: { accept: 'application/json' },
    timeoutMs: 15_000,
    maxBytes: 2 * 1024 * 1024,
  });

  if (!outcome.ok) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: `the store did not answer (${outcome.kind})`,
    };
  }

  const status = outcome.response.status;

  if (status === 401 || status === 403) {
    return { ok: true };
  }

  if (status !== 200) {
    return {
      ok: false,
      reason: 'not_woocommerce',
      detail: `the store answered ${String(status)} for its REST index`,
    };
  }

  const payload = parseJsonObject(outcome.response.body);
  const namespaces = payload?.['namespaces'];
  const offered = Array.isArray(namespaces) ? namespaces : [];

  if (!offered.some((entry) => typeof entry === 'string' && entry.startsWith('wc/'))) {
    return {
      ok: false,
      reason: 'not_woocommerce',
      detail: 'the site has a WordPress REST API but no WooCommerce routes',
    };
  }

  return { ok: true };
}

async function liveConnection(
  db: Database,
  businessId: string,
  storeBase: string,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: connections.id, status: connections.status })
    .from(connections)
    .where(
      and(
        eq(connections.businessId, businessId),
        eq(connections.provider, 'woocommerce'),
        eq(connections.externalAccountId, storeBase),
      ),
    );

  return rows.find((row) => row.status !== 'disconnected') ?? null;
}

async function createPending(
  db: Database,
  input: { businessId: string; userId: string; store: WooStore; now: Date },
): Promise<string> {
  const [row] = await db
    .insert(connections)
    .values({
      businessId: input.businessId,
      provider: 'woocommerce',
      environment: input.store.environment,
      // The canonical store address is the identity. It is what the operator
      // recognizes, what the callback is checked against, and what makes "the
      // same store" answerable without asking the store.
      externalAccountId: input.store.base,
      displayName: input.store.origin.replace(/^https?:\/\//, ''),
      status: 'pending',
      createdByUserId: input.userId,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: connections.id });

  if (row === undefined) {
    throw new Error('the connection could not be created');
  }

  return row.id;
}

interface AdoptInput {
  readonly db: Database;
  readonly http: HttpClient;
  readonly secrets: SecretStore;
  readonly businessId: string;
  readonly connectionId: string;
  readonly created: boolean;
  readonly store: WooStore;
  readonly credentials: { consumerKey: string; consumerSecret: string };
  /** What WooCommerce said the key can do, or null to find out. */
  readonly permissions: WooPermissions | null;
  readonly redirectPath: string;
  readonly now: Date;
}

/**
 * Proves a credential against the bound store, then keeps it.
 *
 * The order is the point. Nothing is written until the store has answered a
 * real authenticated request, so a rejected key leaves the connection exactly
 * as it was — which for a key replacement means the old, working key is still
 * in place rather than having been overwritten by one that does not work.
 */
async function adopt(input: AdoptInput): Promise<CompleteStoreResult> {
  const client = createWooClient({
    http: input.http,
    restBase: input.store.restBase,
    credentials: input.credentials,
  });

  const proof = await client.get('/products?per_page=1&status=any');

  if (!proof.ok) {
    return { ok: false, reason: 'unreachable', detail: proof.reason };
  }

  if (proof.response.status === 401 || proof.response.status === 403) {
    return {
      ok: false,
      reason: 'credentials_rejected',
      detail: `the store refused the key (${String(proof.response.status)})`,
    };
  }

  if (proof.response.status !== 200) {
    return {
      ok: false,
      reason: 'unreachable',
      detail: `the store answered ${String(proof.response.status)}`,
    };
  }

  const permissions = input.permissions ?? (await probePermissions(client));
  const capabilities = capabilitiesFor(permissions);
  const ref = { businessId: input.businessId, connectionId: input.connectionId };

  await input.secrets.put({
    ...ref,
    secretType: 'woocommerce_consumer_key',
    value: input.credentials.consumerKey,
    now: input.now,
  });

  await input.secrets.put({
    ...ref,
    secretType: 'woocommerce_consumer_secret',
    value: input.credentials.consumerSecret,
    now: input.now,
  });

  await input.db.transaction(async (tx) => {
    await tx
      .update(connections)
      .set({
        status: 'active',
        pauseReason: null,
        connectedAt: input.now,
        // The activation moment is what later divides historical orders from
        // ones this application is answerable for, so it is set once, when the
        // connection first becomes usable, and left alone on every key
        // replacement afterwards.
        ...(input.created ? { activatedAt: input.now } : {}),
        updatedAt: input.now,
      })
      .where(eq(connections.id, input.connectionId));

    // Recorded in the same table eBay's granted scopes use, so the interface has
    // one question to ask about what a connection was permitted to do.
    await tx.delete(connectionScopes).where(eq(connectionScopes.connectionId, input.connectionId));

    await tx.insert(connectionScopes).values({
      businessId: input.businessId,
      connectionId: input.connectionId,
      scope: `woocommerce:${permissions}`,
      grantedAt: input.now,
    });
  });

  return {
    ok: true,
    connectionId: input.connectionId,
    created: input.created,
    store: input.store,
    permissions,
    availableCapabilities: capabilities.available,
    impairedCapabilities: capabilities.impaired,
    redirectPath: input.redirectPath,
  };
}

/**
 * What a hand-made key can actually do.
 *
 * Asked with the only write WooCommerce offers that changes nothing: a batch
 * POST whose create, update, and delete lists are all empty. A key without write
 * permission is refused before the body is looked at; a key with it gets a 200
 * describing the nothing that happened. No product is touched either way.
 *
 * Any answer that is neither a clear refusal nor a clear success reports `read`.
 * The two mistakes are not symmetrical: understating the key hides capabilities
 * an operator granted and can be corrected by looking, while overstating it
 * offers writes that fail at the moment somebody is relying on them.
 */
async function probePermissions(client: WooClient): Promise<WooPermissions> {
  const outcome = await client.send('POST', '/products/batch', {
    create: [],
    update: [],
    delete: [],
  });

  if (!outcome.ok) {
    return 'read';
  }

  const status = outcome.response.status;

  return status >= 200 && status < 300 ? 'read_write' : 'read';
}

/**
 * Reads WooCommerce's `key_permissions`.
 *
 * Anything unrecognized becomes `read`. The alternative — treating an
 * unfamiliar value as full access — offers write capabilities on the strength of
 * a string nobody has seen before.
 */
export function readPermissions(value: string | null | undefined): WooPermissions {
  if (value === 'read_write') {
    return 'read_write';
  }

  return value === 'write' ? 'write' : 'read';
}

function stateFailure(
  reason: 'malformed' | 'unknown' | 'expired' | 'already_used' | 'wrong_store',
): CompleteStoreFailure {
  switch (reason) {
    case 'expired':
      return 'state_expired';
    case 'already_used':
      return 'state_already_used';
    case 'malformed':
    case 'unknown':
    case 'wrong_store':
      return 'invalid_state';
  }
}
