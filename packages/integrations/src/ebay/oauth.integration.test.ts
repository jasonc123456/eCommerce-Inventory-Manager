import { createHasher, loadKeyring, type Keyring } from '@eim/crypto';
import { businesses, connectionScopes, connections, memberships, users } from '@eim/db';
import type { HttpClient, HttpOutcome } from '@eim/providers';
import { createTestDatabase, type TestDatabase } from '@eim/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAuthorizations, type Authorizations } from '../authorizations';
import { createSecretStore, type SecretStore } from '../secrets';
import { createEbayOAuth, type EbayOAuth, type IdentityReader } from './oauth';

/**
 * Connecting an eBay seller, end to end (section 13).
 *
 * eBay is a programmable fake here, and deliberately so: the cases that decide
 * whether this code is correct are the ones a real account cannot be made to
 * produce on demand — an operator signing into the wrong seller, a refresh
 * token that has been revoked, two workers refreshing at the same instant, a
 * consent screen returning fewer scopes than it did last month.
 *
 * No call leaves this process.
 */

let harness: TestDatabase;
let keyring: Keyring;
let secrets: SecretStore;
let authorizations: Authorizations;

const HASH_SECRET = 'a'.repeat(64);

/** A programmable eBay. Each entry answers one request. */
class FakeEbay {
  public readonly calls: { url: string; body: string | undefined }[] = [];
  private responses: HttpOutcome[] = [];

  queue(...outcomes: HttpOutcome[]): void {
    this.responses.push(...outcomes);
  }

  reset(): void {
    this.calls.length = 0;
    this.responses = [];
  }

  readonly client: HttpClient = {
    send: (request) => {
      this.calls.push({ url: request.url, body: request.body });

      const next = this.responses.shift();

      if (next === undefined) {
        throw new Error(`unexpected request to ${request.url}`);
      }

      return Promise.resolve(next);
    },
  };
}

const ebay = new FakeEbay();

const okJson = (payload: unknown, status = 200): HttpOutcome => ({
  ok: true,
  response: {
    status,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    url: 'https://api.ebay.com/identity/v1/oauth2/token',
  },
});

const rawResponse = (status: number, body: string): HttpOutcome => ({
  ok: true,
  response: { status, headers: {}, body, url: 'https://api.ebay.com/identity/v1/oauth2/token' },
});

const tokenPayload = (overrides: Record<string, unknown> = {}) => ({
  access_token: 'access-1',
  expires_in: 7200,
  refresh_token: 'refresh-1',
  refresh_token_expires_in: 47_304_000,
  scope:
    'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory.readonly https://api.ebay.com/oauth/api_scope/sell.fulfillment.readonly',
  ...overrides,
});

const CREDENTIALS = {
  clientId: 'client',
  clientSecret: 'secret',
  ruName: 'Company-App-PRD-abcdef',
};

function oauthWith(identify: IdentityReader): EbayOAuth {
  return createEbayOAuth({
    db: harness.db,
    http: ebay.client,
    secrets,
    authorizations,
    credentials: (environment) => (environment === 'production' ? CREDENTIALS : null),
    identify,
  });
}

const sellerIs = (sellerId: string, username?: string): IdentityReader =>
  vi.fn(() => Promise.resolve(username === undefined ? { sellerId } : { sellerId, username }));

beforeAll(async () => {
  harness = await createTestDatabase();
  keyring = loadKeyring({
    keyring: JSON.stringify([{ version: 1, key: Buffer.alloc(32, 7).toString('base64') }]),
    activeVersion: 1,
  });
  secrets = createSecretStore({ db: harness.db, keyring });
  authorizations = createAuthorizations({ db: harness.db, hasher: createHasher(HASH_SECRET) });
}, 180_000);

afterAll(async () => {
  await harness.drop();
});

beforeEach(() => {
  ebay.reset();
});

let counter = 0;

async function seedBusiness(): Promise<{ businessId: string; userId: string }> {
  const slug = `ebay-${String((counter += 1))}`;

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

  return { businessId: business!.id, userId: user!.id };
}

async function connect(
  seller: string,
  options: { businessId?: string; userId?: string; username?: string } = {},
) {
  const owner =
    options.businessId === undefined || options.userId === undefined
      ? await seedBusiness()
      : { businessId: options.businessId, userId: options.userId };

  const oauth = oauthWith(sellerIs(seller, options.username));
  const begun = await oauth.begin({
    businessId: owner.businessId,
    environment: 'production',
    userId: owner.userId,
  });

  const state = new URL(begun.ok ? begun.url : '').searchParams.get('state') ?? '';

  ebay.queue(okJson(tokenPayload()));

  const completed = await oauth.complete({ code: 'auth-code', state });

  return { owner, oauth, completed, state };
}

describe('beginning an authorization', () => {
  it('sends the operator to eBay with the request we intend to make', async () => {
    const { businessId, userId } = await seedBusiness();
    const begun = await oauthWith(sellerIs('u-1')).begin({
      businessId,
      environment: 'production',
      userId,
    });

    expect(begun.ok).toBe(true);

    const url = new URL(begun.ok ? begun.url : '');

    expect(url.origin).toBe('https://auth.ebay.com');
    expect(url.searchParams.get('client_id')).toBe('client');
    // eBay's RuName, not a URL. Sending a URL here fails with an error that
    // does not say so.
    expect(url.searchParams.get('redirect_uri')).toBe(CREDENTIALS.ruName);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f-]{36}\./);

    const scopes = (url.searchParams.get('scope') ?? '').split(' ');

    expect(scopes).toContain('https://api.ebay.com/oauth/api_scope/sell.inventory.readonly');
    expect(scopes).not.toContain('https://api.ebay.com/oauth/api_scope/sell.inventory');
  });

  it('refuses an environment the installation has no credentials for', async () => {
    const { businessId, userId } = await seedBusiness();

    expect(
      await oauthWith(sellerIs('u-1')).begin({ businessId, environment: 'sandbox', userId }),
    ).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('never puts the client secret in the URL', async () => {
    const { businessId, userId } = await seedBusiness();
    const begun = await oauthWith(sellerIs('u-1')).begin({
      businessId,
      environment: 'production',
      userId,
    });

    expect(begun.ok && begun.url).not.toContain('secret');
  });
});

describe('completing an authorization', () => {
  it('creates a connection bound to the seller identity', async () => {
    const { completed, owner } = await connect('u-100', { username: 'thrifty-shop' });

    expect(completed.ok).toBe(true);

    if (!completed.ok) return;

    expect(completed.created).toBe(true);
    expect(completed.sellerId).toBe('u-100');

    const [row] = await harness.db
      .select()
      .from(connections)
      .where(eq(connections.id, completed.connectionId));

    expect(row?.businessId).toBe(owner.businessId);
    expect(row?.externalAccountId).toBe('u-100');
    expect(row?.displayName).toBe('thrifty-shop');
    expect(row?.status).toBe('active');
  });

  it('stores the tokens encrypted and never returns them', async () => {
    const { completed, owner } = await connect('u-101');

    if (!completed.ok) throw new Error('expected success');

    const ref = { businessId: owner.businessId, connectionId: completed.connectionId };

    expect(await secrets.read(ref, 'ebay_refresh_token')).toBe('refresh-1');
    expect(JSON.stringify(completed)).not.toContain('refresh-1');
    expect(JSON.stringify(completed)).not.toContain('access-1');

    // What is on disk is a ciphertext, not the token.
    const described = await secrets.describe(ref, 'ebay_refresh_token');

    expect(described?.keyVersion).toBe(1);
  });

  it('records the scopes eBay actually granted', async () => {
    const { completed } = await connect('u-102');

    if (!completed.ok) throw new Error('expected success');

    const scopes = await harness.db
      .select({ scope: connectionScopes.scope })
      .from(connectionScopes)
      .where(eq(connectionScopes.connectionId, completed.connectionId));

    expect(scopes).toHaveLength(3);
  });

  it('refuses a state that was already spent', async () => {
    // A callback URL lives in browser history and in eBay's referrer logs.
    const { oauth, state } = await connect('u-103');

    ebay.queue(okJson(tokenPayload()));

    expect(await oauth.complete({ code: 'auth-code', state })).toEqual({
      ok: false,
      reason: 'state_already_used',
    });
  });

  it('refuses a forged state', async () => {
    const { businessId, userId } = await seedBusiness();
    const oauth = oauthWith(sellerIs('u-104'));

    await oauth.begin({ businessId, environment: 'production', userId });

    for (const state of [
      '',
      'nonsense',
      '00000000-0000-4000-8000-000000000000.secret',
      `${crypto.randomUUID()}.wrong-secret`,
    ]) {
      expect(await oauth.complete({ code: 'c', state })).toMatchObject({
        ok: false,
        reason: 'invalid_state',
      });
    }

    // And no token exchange was ever attempted.
    expect(ebay.calls).toHaveLength(0);
  });

  it('refuses an expired state', async () => {
    const { businessId, userId } = await seedBusiness();
    const oauth = oauthWith(sellerIs('u-105'));

    const begun = await oauth.begin({ businessId, environment: 'production', userId });
    const state = new URL(begun.ok ? begun.url : '').searchParams.get('state') ?? '';

    // An hour later: consent takes a minute, and anything still pending after
    // that is an abandoned tab.
    expect(
      await oauth.complete({
        code: 'c',
        state,
        now: new Date(Date.now() + 60 * 60_000),
      }),
    ).toEqual({ ok: false, reason: 'state_expired' });
  });

  it('stores nothing when the seller identity cannot be read', async () => {
    // A connection bound to nothing is one a later reauthorization cannot
    // check, so it is better not to create it.
    const { businessId, userId } = await seedBusiness();
    const oauth = oauthWith(() => Promise.resolve(null));

    const begun = await oauth.begin({ businessId, environment: 'production', userId });
    const state = new URL(begun.ok ? begun.url : '').searchParams.get('state') ?? '';

    ebay.queue(okJson(tokenPayload()));

    expect(await oauth.complete({ code: 'c', state })).toEqual({
      ok: false,
      reason: 'identity_unavailable',
    });

    const rows = await harness.db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.businessId, businessId));

    expect(rows).toEqual([]);
  });

  it('reports an exchange failure without quoting eBay', async () => {
    const { businessId, userId } = await seedBusiness();
    const oauth = oauthWith(sellerIs('u-106'));

    const begun = await oauth.begin({ businessId, environment: 'production', userId });
    const state = new URL(begun.ok ? begun.url : '').searchParams.get('state') ?? '';

    ebay.queue(rawResponse(400, '{"error":"invalid_client","error_description":"secret abc123"}'));

    const result = await oauth.complete({ code: 'c', state });

    expect(result).toMatchObject({ ok: false, reason: 'exchange_failed' });
    expect(JSON.stringify(result)).not.toContain('abc123');
  });
});

describe('reauthorizing', () => {
  it('refreshes the same connection when the same seller comes back', async () => {
    const first = await connect('u-200');

    if (!first.completed.ok) throw new Error('expected success');

    const oauth = oauthWith(sellerIs('u-200'));
    const begun = await oauth.begin({
      businessId: first.owner.businessId,
      environment: 'production',
      userId: first.owner.userId,
      connectionId: first.completed.connectionId,
    });
    const state = new URL(begun.ok ? begun.url : '').searchParams.get('state') ?? '';

    ebay.queue(okJson(tokenPayload({ refresh_token: 'refresh-2' })));

    const again = await oauth.complete({ code: 'c', state });

    expect(again.ok).toBe(true);
    expect(again.ok && again.created).toBe(false);
    expect(again.ok && again.connectionId).toBe(first.completed.connectionId);

    // The replacement refresh token is the live one now.
    expect(
      await secrets.read(
        { businessId: first.owner.businessId, connectionId: first.completed.connectionId },
        'ebay_refresh_token',
      ),
    ).toBe('refresh-2');
  });

  it('refuses to repoint a connection at a different seller', async () => {
    // The operator signed into the wrong eBay account. Without this check,
    // every mapping and every ledger entry silently starts describing somebody
    // else's inventory.
    const first = await connect('u-201');

    if (!first.completed.ok) throw new Error('expected success');

    const oauth = oauthWith(sellerIs('u-999'));
    const begun = await oauth.begin({
      businessId: first.owner.businessId,
      environment: 'production',
      userId: first.owner.userId,
      connectionId: first.completed.connectionId,
    });
    const state = new URL(begun.ok ? begun.url : '').searchParams.get('state') ?? '';

    ebay.queue(okJson(tokenPayload()));

    expect(await oauth.complete({ code: 'c', state })).toEqual({
      ok: false,
      reason: 'different_seller',
    });

    const [row] = await harness.db
      .select({ externalAccountId: connections.externalAccountId })
      .from(connections)
      .where(eq(connections.id, first.completed.connectionId));

    expect(row?.externalAccountId).toBe('u-201');
  });

  it('creates a second connection when a different seller is added', async () => {
    // Not a reauthorization: no connection was named, so this is a new account
    // for the same business, which section 13 allows.
    const first = await connect('u-202');

    const second = await connect('u-203', {
      businessId: first.owner.businessId,
      userId: first.owner.userId,
    });

    expect(second.completed.ok && second.completed.created).toBe(true);

    const rows = await harness.db
      .select({ id: connections.id })
      .from(connections)
      .where(eq(connections.businessId, first.owner.businessId));

    expect(rows).toHaveLength(2);
  });

  it('pauses the connection when eBay grants fewer scopes than before', async () => {
    // Section 13: reduced scopes pause the affected capabilities after an
    // impact preview. The connection stays visible so the operator can see what
    // it can no longer do.
    const first = await connect('u-204');

    if (!first.completed.ok) throw new Error('expected success');

    const oauth = oauthWith(sellerIs('u-204'));
    const begun = await oauth.begin({
      businessId: first.owner.businessId,
      environment: 'production',
      userId: first.owner.userId,
      connectionId: first.completed.connectionId,
    });
    const state = new URL(begun.ok ? begun.url : '').searchParams.get('state') ?? '';

    ebay.queue(
      okJson(
        tokenPayload({
          scope:
            'https://api.ebay.com/oauth/api_scope https://api.ebay.com/oauth/api_scope/sell.inventory.readonly',
        }),
      ),
    );

    const again = await oauth.complete({ code: 'c', state });

    expect(again.ok && again.impairedCapabilities).toEqual(['import_orders']);

    const [row] = await harness.db
      .select({ status: connections.status, reason: connections.pauseReason })
      .from(connections)
      .where(eq(connections.id, first.completed.connectionId));

    expect(row?.status).toBe('paused');
    expect(row?.reason).toContain('import_orders');
  });
});

describe('access tokens', () => {
  it('reuses a stored token that has not expired', async () => {
    const { completed, owner, oauth } = await connect('u-300');

    if (!completed.ok) throw new Error('expected success');

    const result = await oauth.accessToken({
      businessId: owner.businessId,
      connectionId: completed.connectionId,
      environment: 'production',
    });

    expect(result).toEqual({ ok: true, token: 'access-1', refreshed: false });
    // One call in total: the original exchange. No refresh was needed.
    expect(ebay.calls).toHaveLength(1);
  });

  it('refreshes before expiry rather than at it', async () => {
    // A request that starts at 1:59:59 arrives with a token that expired in
    // flight, and eBay answers 401 to a call that was valid when it was made.
    const { completed, owner, oauth } = await connect('u-301');

    if (!completed.ok) throw new Error('expected success');

    ebay.queue(okJson(tokenPayload({ access_token: 'access-2' })));

    const nearlyExpired = new Date(Date.now() + 7200_000 - 60_000);

    const result = await oauth.accessToken({
      businessId: owner.businessId,
      connectionId: completed.connectionId,
      environment: 'production',
      now: nearlyExpired,
    });

    expect(result).toEqual({ ok: true, token: 'access-2', refreshed: true });
  });

  it('keeps the existing refresh token when eBay returns none', async () => {
    // Storing `undefined` would retire the working one and leave the connection
    // with no way back.
    const { completed, owner, oauth } = await connect('u-302');

    if (!completed.ok) throw new Error('expected success');

    ebay.queue(okJson({ access_token: 'access-3', expires_in: 7200 }));

    await oauth.accessToken({
      businessId: owner.businessId,
      connectionId: completed.connectionId,
      environment: 'production',
      force: true,
    });

    expect(
      await secrets.read(
        { businessId: owner.businessId, connectionId: completed.connectionId },
        'ebay_refresh_token',
      ),
    ).toBe('refresh-1');
  });

  it('pauses the connection and discards credentials when the grant is revoked', async () => {
    // Section 13: a conclusive refresh revocation invalidates immediately,
    // pauses work, and asks a human to reauthorize.
    const { completed, owner, oauth } = await connect('u-303');

    if (!completed.ok) throw new Error('expected success');

    ebay.queue(rawResponse(400, '{"error":"invalid_grant"}'));

    const result = await oauth.accessToken({
      businessId: owner.businessId,
      connectionId: completed.connectionId,
      environment: 'production',
      force: true,
    });

    expect(result).toEqual({ ok: false, reason: 'refresh_rejected' });

    const [row] = await harness.db
      .select({ status: connections.status, reason: connections.pauseReason })
      .from(connections)
      .where(eq(connections.id, completed.connectionId));

    expect(row?.status).toBe('paused');
    expect(row?.reason).toContain('reauthoriz');

    const ref = { businessId: owner.businessId, connectionId: completed.connectionId };

    expect(await secrets.read(ref, 'ebay_refresh_token')).toBeNull();
    expect(await secrets.read(ref, 'ebay_access_token')).toBeNull();
  });

  it('keeps the connection when the refresh merely failed to get through', async () => {
    // A network blip is not eBay saying the credential is dead. Treating them
    // alike strands a working connection.
    const { completed, owner, oauth } = await connect('u-304');

    if (!completed.ok) throw new Error('expected success');

    ebay.queue({ ok: false, kind: 'transport', reason: 'ECONNRESET' });

    const result = await oauth.accessToken({
      businessId: owner.businessId,
      connectionId: completed.connectionId,
      environment: 'production',
      force: true,
    });

    expect(result).toEqual({ ok: false, reason: 'refresh_failed' });

    const [row] = await harness.db
      .select({ status: connections.status })
      .from(connections)
      .where(eq(connections.id, completed.connectionId));

    expect(row?.status).toBe('active');
    expect(
      await secrets.read(
        { businessId: owner.businessId, connectionId: completed.connectionId },
        'ebay_refresh_token',
      ),
    ).toBe('refresh-1');
  });

  it('refreshes once when two callers race', async () => {
    // Two workers sending the same refresh token produce two access tokens, and
    // eBay may invalidate the first — so the winner stores a token the loser has
    // already replaced. The advisory lock makes it one at a time, and the
    // second caller finds the fresh token already stored.
    const { completed, owner, oauth } = await connect('u-305');

    if (!completed.ok) throw new Error('expected success');

    ebay.queue(okJson(tokenPayload({ access_token: 'access-raced' })));

    const nearlyExpired = new Date(Date.now() + 7200_000 - 60_000);
    const request = {
      businessId: owner.businessId,
      connectionId: completed.connectionId,
      environment: 'production' as const,
      now: nearlyExpired,
    };

    const [first, second] = await Promise.all([
      oauth.accessToken(request),
      oauth.accessToken(request),
    ]);

    expect(first.ok && first.token).toBe('access-raced');
    expect(second.ok && second.token).toBe('access-raced');
    // Exactly one refresh happened: the original exchange plus one.
    expect(ebay.calls).toHaveLength(2);
  });
});

describe('tenancy', () => {
  it('will not read another business’s credentials with a borrowed connection id', async () => {
    // The connection id is a uuid somebody could learn. What stops it being
    // useful is that the secret's encryption context names the business, so the
    // lookup finds nothing.
    const first = await connect('u-400');
    const stranger = await seedBusiness();

    if (!first.completed.ok) throw new Error('expected success');

    expect(
      await secrets.read(
        { businessId: stranger.businessId, connectionId: first.completed.connectionId },
        'ebay_refresh_token',
      ),
    ).toBeNull();
  });

  it('lets two businesses connect the same seller independently', async () => {
    const first = await connect('u-401');
    const second = await connect('u-401');

    expect(first.completed.ok && second.completed.ok).toBe(true);
    expect(first.completed.ok && second.completed.ok).toBe(true);

    const rows = await harness.db
      .select({ id: connections.id })
      .from(connections)
      .where(and(eq(connections.externalAccountId, 'u-401'), eq(connections.provider, 'ebay')));

    expect(rows).toHaveLength(2);
  });
});
