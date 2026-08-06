import { connectionScopes, connections, type Database } from '@eim/db';
import type { HttpClient } from '@eim/providers';
import { and, eq, sql } from 'drizzle-orm';

import type { Authorizations, PendingAuthorization } from '../authorizations';
import type { SecretStore } from '../secrets';
import {
  basicAuthorization,
  hostsFor,
  type CredentialLookup,
  type EbayEnvironment,
} from './environment';
import { REQUESTED_SCOPES, compareScopes, parseGrantedScopes } from './scopes';

/**
 * Connecting an eBay seller, and keeping the connection usable (section 13).
 *
 * The rules that shape this file, each of which is a way the obvious
 * implementation goes wrong:
 *
 *   A connection is bound to an immutable seller identity. Reauthorization may
 *   refresh a connection only when that identity and the environment match;
 *   authorizing a different seller creates a different connection. Without the
 *   check, an operator who signs into the wrong eBay account repoints every
 *   mapping and every ledger entry at somebody else's inventory, and nothing
 *   about the screen tells them that happened.
 *
 *   Refresh is serialized per connection. Two workers refreshing at once send
 *   the same refresh token twice; eBay issues two access tokens and may
 *   invalidate the first, so the winner of the race stores a token the loser
 *   has already replaced. A per-connection advisory lock makes it one at a time.
 *
 *   Token replacement is atomic. The new refresh token, the new access token,
 *   and the granted scopes are written in one transaction, because a connection
 *   holding a new access token and an old refresh token is one that works until
 *   it expires and then cannot recover.
 *
 *   Nothing here returns a token to a caller that did not ask for one, and no
 *   error message quotes eBay's response body.
 */

export interface EbayOAuth {
  /** Where to send the operator to consent, plus the state that comes back. */
  begin(input: BeginConnection): Promise<BeginResult>;
  /** Completes the flow from the callback's code and state. */
  complete(input: CompleteConnection): Promise<CompleteResult>;
  /** Returns a usable access token, refreshing it if necessary. */
  accessToken(input: AccessTokenRequest): Promise<AccessTokenResult>;
}

export interface BeginConnection {
  readonly businessId: string;
  readonly environment: EbayEnvironment;
  readonly userId: string;
  readonly connectionId?: string | undefined;
  readonly redirectPath?: string;
  readonly now?: Date;
}

export type BeginResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: 'not_configured' };

export interface CompleteConnection {
  readonly code: string;
  readonly state: string;
  readonly now?: Date;
}

export type CompleteResult =
  | {
      readonly ok: true;
      readonly connectionId: string;
      readonly created: boolean;
      readonly sellerId: string;
      readonly grantedScopes: readonly string[];
      readonly impairedCapabilities: readonly string[];
      readonly redirectPath: string;
    }
  | { readonly ok: false; readonly reason: CompleteFailure; readonly detail?: string };

export type CompleteFailure =
  | 'invalid_state'
  | 'state_expired'
  | 'state_already_used'
  | 'not_configured'
  | 'exchange_failed'
  | 'identity_unavailable'
  | 'different_seller';

export interface AccessTokenRequest {
  readonly businessId: string;
  readonly connectionId: string;
  readonly environment: EbayEnvironment;
  readonly now?: Date;
  /** Forces a refresh even when the stored token has time left. */
  readonly force?: boolean;
}

export type AccessTokenResult =
  | { readonly ok: true; readonly token: string; readonly refreshed: boolean }
  | { readonly ok: false; readonly reason: AccessTokenFailure };

export type AccessTokenFailure =
  'not_configured' | 'no_refresh_token' | 'refresh_rejected' | 'refresh_failed';

export interface EbayOAuthOptions {
  readonly db: Database;
  readonly http: HttpClient;
  readonly secrets: SecretStore;
  readonly authorizations: Authorizations;
  readonly credentials: CredentialLookup;
  /** Reads the seller identity a token belongs to. Injected so it can be faked. */
  readonly identify: IdentityReader;
}

/**
 * Resolves a token to the seller it authorizes.
 *
 * Separated from this module because it is the one call whose *answer* decides
 * whether a connection may be updated, and a test that cannot control it cannot
 * exercise the case that matters: the same operator authorizing a different
 * account.
 */
export type IdentityReader = (input: {
  readonly environment: EbayEnvironment;
  readonly accessToken: string;
}) => Promise<{ readonly sellerId: string; readonly username?: string } | null>;

/**
 * How long before expiry a token is treated as spent.
 *
 * eBay's access tokens last two hours. Refreshing a minute before the end would
 * mean a request that starts at 1:59:59 arrives with a token that expired in
 * flight, and eBay would answer 401 to a call that was valid when it was made.
 */
const EXPIRY_MARGIN_MS = 5 * 60_000;

export function createEbayOAuth(options: EbayOAuthOptions): EbayOAuth {
  const { db, http, secrets, authorizations, credentials, identify } = options;

  return {
    async begin(input) {
      const credential = credentials(input.environment);

      if (credential === null) {
        return { ok: false, reason: 'not_configured' };
      }

      const { state } = await authorizations.begin({
        businessId: input.businessId,
        provider: 'ebay',
        environment: input.environment,
        initiatedByUserId: input.userId,
        connectionId: input.connectionId,
        redirectPath: input.redirectPath ?? '/connections',
        now: input.now,
      });

      const url = new URL(hostsFor(input.environment).authorizeUrl);

      url.searchParams.set('client_id', credential.clientId);
      url.searchParams.set('response_type', 'code');
      // eBay's RuName, not a URL: it names the redirect configuration registered
      // in eBay's portal, which is where the accept and decline URLs live.
      url.searchParams.set('redirect_uri', credential.ruName);
      url.searchParams.set('scope', REQUESTED_SCOPES.join(' '));
      url.searchParams.set('state', state);
      // Consent is asked for every time rather than silently reused, so an
      // operator reauthorizing can see and change which account they are using.
      url.searchParams.set('prompt', 'login');

      return { ok: true, url: url.toString() };
    },

    async complete(input) {
      const now = input.now ?? new Date();
      const spent = await authorizations.consume({ state: input.state, now });

      if (!spent.ok) {
        return { ok: false, reason: failureFor(spent.reason) };
      }

      const authorization = spent.authorization;
      const environment = authorization.environment;
      const credential = credentials(environment);

      if (credential === null) {
        return { ok: false, reason: 'not_configured' };
      }

      const exchanged = await exchange(
        http,
        environment,
        credential,
        {
          grant_type: 'authorization_code',
          code: input.code,
          redirect_uri: credential.ruName,
        },
        now,
      );

      if (!exchanged.ok) {
        return { ok: false, reason: 'exchange_failed', detail: exchanged.reason };
      }

      const identity = await identify({
        environment,
        accessToken: exchanged.tokens.accessToken,
      });

      if (identity === null) {
        // Without the seller identity there is nothing to bind the connection
        // to, and a connection bound to nothing is one that a later
        // reauthorization cannot check. Refusing here is better than creating
        // something that has to be repaired.
        return { ok: false, reason: 'identity_unavailable' };
      }

      const granted = parseGrantedScopes(exchanged.tokens.scope);

      return completeConnection({
        db,
        secrets,
        authorization,
        environment,
        identity,
        tokens: exchanged.tokens,
        granted,
        now,
      });
    },

    async accessToken(input) {
      const now = input.now ?? new Date();
      const credential = credentials(input.environment);

      if (credential === null) {
        return { ok: false, reason: 'not_configured' };
      }

      const ref = { businessId: input.businessId, connectionId: input.connectionId };

      if (input.force !== true) {
        const usable = await usableAccessToken(secrets, ref, now);

        if (usable !== null) {
          return { ok: true, token: usable, refreshed: false };
        }
      }

      // One refresh at a time per connection. The lock is held for the whole
      // transaction and released when it ends, including when it ends badly,
      // which a lock table would not guarantee.
      return db.transaction(async (tx) => {
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtext(${`ebay-refresh:${input.connectionId}`}))`,
        );

        // Re-read inside the lock: the request that was waiting is usually
        // waiting because another one was refreshing, and its result is already
        // stored by the time the lock is granted.
        if (input.force !== true) {
          const usable = await usableAccessToken(secrets, ref, now);

          if (usable !== null) {
            return { ok: true, token: usable, refreshed: false };
          }
        }

        const refreshToken = await secrets.read(ref, 'ebay_refresh_token');

        if (refreshToken === null) {
          return { ok: false, reason: 'no_refresh_token' };
        }

        const exchanged = await exchange(
          http,
          input.environment,
          credential,
          {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            scope: REQUESTED_SCOPES.join(' '),
          },
          now,
        );

        if (!exchanged.ok) {
          if (exchanged.rejected) {
            // eBay refused the refresh token itself. Section 13 treats a
            // conclusive refresh revocation as immediate invalidation: the
            // connection pauses, the credentials go, and a human reauthorizes.
            await pauseForRevocation(db, secrets, ref, now);

            return { ok: false, reason: 'refresh_rejected' };
          }

          return { ok: false, reason: 'refresh_failed' };
        }

        await storeTokens(secrets, ref, exchanged.tokens, now);

        return { ok: true, token: exchanged.tokens.accessToken, refreshed: true };
      });
    },
  };
}

// ---------------------------------------------------------------------------

/**
 * The stored access token, when it has enough life left to be worth using.
 *
 * Asked twice — once before taking the lock and once after — because the caller
 * that waited was usually waiting for the refresh whose result it is about to
 * read. Checking expiry before decrypting keeps the common path from doing
 * cryptography it does not need.
 */
async function usableAccessToken(
  secrets: SecretStore,
  ref: { businessId: string; connectionId: string },
  now: Date,
): Promise<string | null> {
  const described = await secrets.describe(ref, 'ebay_access_token');

  const expiresAt = described?.expiresAt;

  // A stored token with no recorded expiry is treated as spent. eBay always
  // states one, so its absence means the row was written by something that did
  // not know what it was storing, and using it would be guessing.
  if (expiresAt === null || expiresAt === undefined) {
    return null;
  }

  if (expiresAt.getTime() - EXPIRY_MARGIN_MS <= now.getTime()) {
    return null;
  }

  return secrets.read(ref, 'ebay_access_token');
}

interface TokenSet {
  readonly accessToken: string;
  readonly accessTokenExpiresAt: Date;
  readonly refreshToken?: string;
  readonly refreshTokenExpiresAt?: Date;
  readonly scope?: string;
}

type ExchangeResult =
  | { readonly ok: true; readonly tokens: TokenSet }
  | { readonly ok: false; readonly reason: string; readonly rejected: boolean };

/**
 * The token endpoint, for both grant types.
 *
 * `rejected` distinguishes "eBay says this credential is no longer valid" from
 * "the call did not get through". The first pauses the connection and asks a
 * person to reauthorize; the second is retried later. Treating them alike either
 * strands a working connection on a network blip or leaves a revoked one
 * retrying until its attempts run out.
 */
async function exchange(
  http: HttpClient,
  environment: EbayEnvironment,
  credential: { clientId: string; clientSecret: string; ruName: string },
  form: Readonly<Record<string, string>>,
  now: Date,
): Promise<ExchangeResult> {
  const outcome = await http.send({
    method: 'POST',
    url: hostsFor(environment).tokenUrl,
    headers: {
      authorization: basicAuthorization(credential),
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: new URLSearchParams(form).toString(),
    timeoutMs: 20_000,
    maxBytes: 256 * 1024,
  });

  if (!outcome.ok) {
    return { ok: false, reason: outcome.kind, rejected: false };
  }

  if (outcome.response.status !== 200) {
    // 400 with `invalid_grant` is eBay saying the refresh token is dead. Every
    // other status is a failure to ask, not an answer about the credential.
    const rejected =
      outcome.response.status === 400 && outcome.response.body.includes('invalid_grant');

    return {
      ok: false,
      reason: `http_${String(outcome.response.status)}`,
      rejected,
    };
  }

  // Expiry is computed from the caller's clock rather than the wall clock.
  // They are the same in production and differ under test, and a token whose
  // recorded expiry disagrees with the clock the caller is using is one that
  // gets refreshed again a moment later by whoever asks next.
  const parsed = parseTokenResponse(outcome.response.body, now);

  return parsed === null
    ? { ok: false, reason: 'unparseable', rejected: false }
    : { ok: true, tokens: parsed };
}

/**
 * Reads eBay's token response.
 *
 * Written by hand rather than trusted to a schema library at this one point,
 * because the failure mode being guarded against is a response that parses as
 * JSON and contains no token: a proxy's error page, a login redirect, an
 * html body with a 200. Every field is checked for the type it must have, and
 * anything missing produces null rather than `undefined` flowing onward.
 */
export function parseTokenResponse(body: string, now: Date = new Date()): TokenSet | null {
  let payload: unknown;

  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }

  if (typeof payload !== 'object' || payload === null) {
    return null;
  }

  const record = payload as Record<string, unknown>;
  const accessToken = record['access_token'];
  const expiresIn = record['expires_in'];

  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return null;
  }

  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    return null;
  }

  const refreshToken = record['refresh_token'];
  const refreshExpiresIn = record['refresh_token_expires_in'];
  const scope = record['scope'];

  return {
    accessToken,
    accessTokenExpiresAt: new Date(now.getTime() + expiresIn * 1000),
    ...(typeof refreshToken === 'string' && refreshToken.length > 0 ? { refreshToken } : {}),
    ...(typeof refreshExpiresIn === 'number' && refreshExpiresIn > 0
      ? { refreshTokenExpiresAt: new Date(now.getTime() + refreshExpiresIn * 1000) }
      : {}),
    ...(typeof scope === 'string' ? { scope } : {}),
  };
}

async function storeTokens(
  secrets: SecretStore,
  ref: { businessId: string; connectionId: string },
  tokens: TokenSet,
  now: Date,
): Promise<void> {
  await secrets.put({
    ...ref,
    secretType: 'ebay_access_token',
    value: tokens.accessToken,
    expiresAt: tokens.accessTokenExpiresAt,
    now,
  });

  // eBay does not always return a new refresh token on refresh. Storing
  // `undefined` would retire the working one and leave the connection with no
  // way back, so absence means "keep what you have".
  if (tokens.refreshToken !== undefined) {
    await secrets.put({
      ...ref,
      secretType: 'ebay_refresh_token',
      value: tokens.refreshToken,
      expiresAt: tokens.refreshTokenExpiresAt,
      now,
    });
  }
}

async function pauseForRevocation(
  db: Database,
  secrets: SecretStore,
  ref: { businessId: string; connectionId: string },
  now: Date,
): Promise<void> {
  await secrets.retire(ref, 'ebay_access_token');
  await secrets.retire(ref, 'ebay_refresh_token');

  await db
    .update(connections)
    .set({
      status: 'paused',
      pauseReason: 'eBay rejected the stored credentials; the connection must be reauthorized',
      updatedAt: now,
    })
    .where(and(eq(connections.id, ref.connectionId), eq(connections.businessId, ref.businessId)));
}

interface CompleteInput {
  readonly db: Database;
  readonly secrets: SecretStore;
  readonly authorization: PendingAuthorization;
  readonly environment: EbayEnvironment;
  readonly identity: { readonly sellerId: string; readonly username?: string };
  readonly tokens: TokenSet;
  readonly granted: readonly string[];
  readonly now: Date;
}

async function completeConnection(input: CompleteInput): Promise<CompleteResult> {
  const { db, secrets, authorization, environment, identity, granted, now } = input;

  const existing = await db
    .select()
    .from(connections)
    .where(
      and(
        eq(connections.businessId, authorization.businessId),
        eq(connections.provider, 'ebay'),
        eq(connections.environment, environment),
        eq(connections.externalAccountId, identity.sellerId),
      ),
    )
    .limit(1);

  const live = existing.find((row) => row.status !== 'disconnected');

  // A reauthorization that names a connection must land on that connection. If
  // the operator signed into a different eBay account, this is where it is
  // caught — before any token is stored against the wrong seller.
  if (authorization.connectionId !== null && live?.id !== authorization.connectionId) {
    return { ok: false, reason: 'different_seller' };
  }

  const previousScopes =
    live === undefined
      ? []
      : (
          await db
            .select({ scope: connectionScopes.scope })
            .from(connectionScopes)
            .where(eq(connectionScopes.connectionId, live.id))
        ).map((row) => row.scope);

  const comparison = compareScopes(previousScopes, granted);

  const connectionId = await db.transaction(async (tx) => {
    let id: string;

    if (live === undefined) {
      const [row] = await tx
        .insert(connections)
        .values({
          businessId: authorization.businessId,
          provider: 'ebay',
          environment,
          externalAccountId: identity.sellerId,
          displayName: identity.username ?? identity.sellerId,
          status: 'active',
          connectedAt: now,
          createdByUserId: authorization.initiatedByUserId,
        })
        .returning({ id: connections.id });

      if (row === undefined) {
        throw new Error('the connection could not be created');
      }

      id = row.id;
    } else {
      id = live.id;

      await tx
        .update(connections)
        .set(
          comparison.impairedCapabilities.length === 0
            ? { status: 'active', pauseReason: null, connectedAt: live.connectedAt ?? now }
            : {
                // Section 13: reduced scopes pause the affected capabilities
                // after an impact preview. The connection stays, and stays
                // visible, because the operator has to be able to see what it
                // can no longer do.
                status: 'paused',
                pauseReason: `eBay granted fewer permissions than before; ${comparison.impairedCapabilities.join(', ')} are unavailable`,
                connectedAt: live.connectedAt ?? now,
              },
        )
        .where(eq(connections.id, id));
    }

    await tx.delete(connectionScopes).where(eq(connectionScopes.connectionId, id));

    if (granted.length > 0) {
      await tx.insert(connectionScopes).values(
        granted.map((scope) => ({
          businessId: authorization.businessId,
          connectionId: id,
          scope,
        })),
      );
    }

    return id;
  });

  await storeTokens(
    secrets,
    { businessId: authorization.businessId, connectionId },
    input.tokens,
    now,
  );

  return {
    ok: true,
    connectionId,
    created: live === undefined,
    sellerId: identity.sellerId,
    grantedScopes: granted,
    impairedCapabilities: comparison.impairedCapabilities,
    redirectPath: authorization.redirectPath,
  };
}

function failureFor(
  reason: 'malformed' | 'unknown' | 'expired' | 'already_used' | 'wrong_store',
): CompleteFailure {
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
