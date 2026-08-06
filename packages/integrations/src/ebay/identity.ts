import type { HttpClient } from '@eim/providers';

import { hostsFor, type EbayEnvironment } from './environment';
import type { IdentityReader } from './oauth';

/**
 * Who a token belongs to (section 13).
 *
 * eBay's Identity API returns a `userId` that does not change when the seller
 * renames their account. That identifier is what a connection is bound to, and
 * the username is only ever a label: binding to the username would mean a
 * seller who renamed themselves came back as a different account, and every
 * mapping pointing at the old name would have to be rebuilt.
 *
 * Served from `apiz`, which is a different host from the rest of the REST APIs.
 */
export function createIdentityReader(http: HttpClient): IdentityReader {
  return async ({ environment, accessToken }) => {
    const outcome = await http.send({
      method: 'GET',
      url: `${hostsFor(environment).apizBase}/commerce/identity/v1/user/`,
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
      },
      timeoutMs: 15_000,
      maxBytes: 64 * 1024,
    });

    if (!outcome.ok || outcome.response.status !== 200) {
      return null;
    }

    return parseIdentity(outcome.response.body);
  };
}

/**
 * Reads the identity response.
 *
 * Returns null rather than a partial identity. A connection bound to an empty
 * seller id is one that matches every future authorization, which is precisely
 * the check the binding exists to perform.
 */
export function parseIdentity(body: string): { sellerId: string; username?: string } | null {
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
  const userId = record['userId'];
  const username = record['username'];

  if (typeof userId !== 'string' || userId.trim().length === 0) {
    return null;
  }

  return {
    sellerId: userId.trim(),
    ...(typeof username === 'string' && username.trim().length > 0
      ? { username: username.trim() }
      : {}),
  };
}

/** The environments an installation has credentials for, for the interface. */
export function configuredEnvironments(
  isConfigured: (environment: EbayEnvironment) => boolean,
): EbayEnvironment[] {
  return (['sandbox', 'production'] as const).filter((environment) => isConfigured(environment));
}
