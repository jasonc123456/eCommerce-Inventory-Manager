import type { HttpClient } from '@eim/providers';

import {
  basicAuthorization,
  hostsFor,
  type CredentialLookup,
  type EbayEnvironment,
} from '../environment';

/**
 * The application's own access token (section 13).
 *
 * Distinct from every token in `oauth.ts`, and the distinction is not
 * cosmetic. Those authorize a seller: they were issued because somebody
 * consented, they reach that seller's inventory and orders, and they are
 * encrypted per connection because losing one exposes an account. This one
 * authorizes nothing but the installation itself, and is used for the three
 * calls that are about the application rather than about anybody's data:
 * registering the notification destination, discovering which topics exist, and
 * fetching the public key a notification was signed with.
 *
 * It is deliberately not stored. A client-credentials token is reissuable at
 * any moment from credentials the installation already holds, so persisting it
 * would add a decryptable copy of a credential to the database in exchange for
 * saving a request every couple of hours.
 *
 * Cached in memory per environment, with a margin. The margin exists because
 * the alternative — using a token until the moment it expires — fails during
 * the request that mattered, and signature verification is the one call that
 * cannot be retried later: eBay wants an acknowledgement now.
 */

/** Reissue this long before expiry rather than at it. */
const EXPIRY_MARGIN_MS = 120_000;

/** The scope a client-credentials grant carries. Nothing seller-specific. */
const APPLICATION_SCOPE = 'https://api.ebay.com/oauth/api_scope';

export interface ApplicationTokenOptions {
  readonly http: HttpClient;
  readonly credentials: CredentialLookup;
}

export interface ApplicationTokenReader {
  /** A usable application token, or null when this environment is unconfigured or eBay refused. */
  read(environment: EbayEnvironment, now?: Date): Promise<string | null>;
  /** Discards the cached token, for use after eBay rejects one as invalid. */
  forget(environment: EbayEnvironment): void;
}

interface CachedToken {
  readonly token: string;
  readonly expiresAt: Date;
}

export function createApplicationTokenReader(
  options: ApplicationTokenOptions,
): ApplicationTokenReader {
  const cache = new Map<EbayEnvironment, CachedToken>();
  // One in-flight request per environment. Without it, a burst of notifications
  // arriving after a restart sends one token request each, which is both
  // wasteful and the fastest way to meet eBay's rate limit on the endpoint that
  // every other call depends on.
  const inFlight = new Map<EbayEnvironment, Promise<string | null>>();

  const fetchToken = async (environment: EbayEnvironment, now: Date): Promise<string | null> => {
    const credential = options.credentials(environment);

    if (credential === null) {
      return null;
    }

    const outcome = await options.http.send({
      method: 'POST',
      url: hostsFor(environment).tokenUrl,
      headers: {
        authorization: basicAuthorization(credential),
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: APPLICATION_SCOPE,
      }).toString(),
      timeoutMs: 20_000,
      maxBytes: 64 * 1024,
    });

    if (!outcome.ok || outcome.response.status !== 200) {
      return null;
    }

    let payload: unknown;

    try {
      payload = JSON.parse(outcome.response.body);
    } catch {
      return null;
    }

    if (typeof payload !== 'object' || payload === null) {
      return null;
    }

    const record = payload as Record<string, unknown>;
    const issued = record['access_token'];
    const expiresIn = record['expires_in'];

    if (typeof issued !== 'string' || issued.length === 0) {
      return null;
    }

    // A lifetime eBay did not state is not one to rely on. The token is used
    // for the call at hand and then asked for again, which costs a request and
    // cannot produce a 401 halfway through verifying a notification.
    const lifetimeMs =
      typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0
        ? expiresIn * 1000
        : EXPIRY_MARGIN_MS;

    cache.set(environment, { token: issued, expiresAt: new Date(now.getTime() + lifetimeMs) });

    return issued;
  };

  return {
    async read(environment, now = new Date()) {
      const cached = cache.get(environment);

      if (cached !== undefined && cached.expiresAt.getTime() - EXPIRY_MARGIN_MS > now.getTime()) {
        return cached.token;
      }

      const pending = inFlight.get(environment);

      if (pending !== undefined) {
        return pending;
      }

      const request = fetchToken(environment, now).finally(() => {
        inFlight.delete(environment);
      });

      inFlight.set(environment, request);

      return request;
    },

    forget(environment) {
      cache.delete(environment);
    },
  };
}
