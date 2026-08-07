import {
  createAuthorizations,
  createSecretStore,
  createWooConnections,
  createWooIntake,
  createWooReadiness,
  createWooWebhooks,
  type Authorizations,
  type SecretStore,
  type WooConnections,
  type WooIntake,
  type WooReadiness,
  type WooWebhooks,
} from '@eim/integrations';
import { createHttpClient, type UrlPolicy } from '@eim/providers';

import { identity } from './identity';
import { runtime } from './runtime';

/**
 * The WooCommerce half of the connection lifecycle, wired for the web tier
 * (section 14).
 *
 * Built once and cached on the runtime, for the same reason the database pool
 * is: the HTTP client holds the SSRF policy and a DNS-pinning resolver, and a
 * new one per request throws that away.
 */

const WOO_KEY = Symbol.for('eim.web.woocommerce');

interface Wiring {
  readonly connections: WooConnections;
  readonly readiness: WooReadiness;
  readonly webhooks: WooWebhooks;
  readonly intake: WooIntake;
  /** Shared with the eBay flow: one custody boundary for every credential. */
  readonly secrets: SecretStore;
  readonly authorizations: Authorizations;
}

type GlobalWithWoo = Record<symbol, Wiring | undefined>;

/**
 * What the store owner sees on the approval screen.
 *
 * The host is part of the name deliberately. A shop that has approved two
 * installations of this application — a staging one and a live one, say — sees
 * two entries in WooCommerce's key list, and without the host they are
 * indistinguishable at exactly the moment somebody is deciding which to revoke.
 */
export function applicationName(publicUrl: string): string {
  let host: string;

  try {
    host = new URL(publicUrl).host;
  } catch {
    host = '';
  }

  return host === '' ? 'eCommerce Inventory Manager' : `eCommerce Inventory Manager (${host})`;
}

export function integrationUrlPolicy(): UrlPolicy {
  const { config } = runtime();

  return {
    // One flag opens both, because a private destination and a plain-HTTP one
    // are the same deployment: a self-hoster's store on their own network.
    allowPrivate: config.EIM_ALLOW_PRIVATE_INTEGRATION_HOSTS,
    allowInsecure: config.EIM_ALLOW_PRIVATE_INTEGRATION_HOSTS,
    allowlist: config.EIM_PRIVATE_HOST_ALLOWLIST,
  };
}

export function woocommerce(): Wiring {
  const container = globalThis as unknown as GlobalWithWoo;
  const existing = container[WOO_KEY];

  if (existing !== undefined) {
    return existing;
  }

  const { config, db } = runtime();
  const { hasher, keyring } = identity();
  const policy = integrationUrlPolicy();

  const http = createHttpClient({
    policy,
    userAgent: `eCommerce-Inventory-Manager/${config.EIM_APP_VERSION ?? 'unknown'}`,
  });

  const secrets = createSecretStore({ db, keyring });
  const authorizations = createAuthorizations({ db, hasher });

  const webhooks = createWooWebhooks({
    db,
    http,
    secrets,
    policy,
    publicUrl: config.EIM_PUBLIC_URL,
  });

  const built: Wiring = {
    secrets,
    authorizations,
    webhooks,
    intake: createWooIntake({ db, secrets, policy, webhooks }),
    connections: createWooConnections({
      db,
      http,
      secrets,
      authorizations,
      policy,
      appName: applicationName(config.EIM_PUBLIC_URL),
      publicUrl: config.EIM_PUBLIC_URL,
    }),
    readiness: createWooReadiness({ db, http, secrets, policy }),
  };

  container[WOO_KEY] = built;

  return built;
}
