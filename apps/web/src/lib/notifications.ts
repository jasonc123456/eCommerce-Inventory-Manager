import {
  createApplicationTokenReader,
  createMarketplaceDeletion,
  createNotificationIntake,
  createPublicKeyReader,
  createSignatureVerifier,
  credentialsFrom,
  type EbayEnvironment,
  type MarketplaceDeletion,
  type NotificationIntake,
} from '@eim/integrations';
import { createHttpClient } from '@eim/providers';

import { runtime } from './runtime';

/**
 * The receiving half of eBay notifications, wired for the web tier.
 *
 * Built once per environment and cached on the runtime, for the same reason the
 * database pool is: these hold caches — an application token, eBay's signing
 * keys — that are worthless if a new one is constructed per request, and the
 * key fetch is a network call sitting in front of every notification.
 *
 * Environment is a path segment rather than a setting. Sandbox and production
 * are different keysets signing with different keys, and a receiver that
 * guessed which one a notification came from would verify against the wrong
 * key and refuse everything from one of them.
 */

export const ENVIRONMENTS = ['sandbox', 'production'] as const;

export function isEbayEnvironment(value: string): value is EbayEnvironment {
  return (ENVIRONMENTS as readonly string[]).includes(value);
}

interface Receivers {
  readonly intake: NotificationIntake;
  readonly deletion: MarketplaceDeletion;
}

const RECEIVERS_KEY = Symbol.for('eim.web.ebay.notifications');

type GlobalWithReceivers = Record<symbol, Map<EbayEnvironment, Receivers> | undefined>;

/**
 * The URL eBay was told to deliver to.
 *
 * The challenge hash is over this exact string, so it is derived from one
 * place. A trailing slash or a scheme that disagrees with what is registered in
 * eBay's portal produces a hash that is simply wrong, and eBay reports only
 * that validation failed.
 */
export function notificationEndpoint(environment: EbayEnvironment, kind: EndpointKind): string {
  return buildEndpoint(runtime().config.EIM_PUBLIC_URL, environment, kind);
}

export type EndpointKind = 'notifications' | 'account-deletion';

/** The pure half, so the exact string can be tested without a configuration. */
export function buildEndpoint(
  publicUrl: string,
  environment: EbayEnvironment,
  kind: EndpointKind,
): string {
  // A configured base with a trailing slash is ordinary and would otherwise
  // produce a double slash in the middle of a hashed string.
  const base = publicUrl.trim().replace(/\/+$/, '');
  const path = `/api/webhooks/ebay/${environment}`;

  return kind === 'notifications' ? `${base}${path}` : `${base}${path}/account-deletion`;
}

/**
 * The token both endpoints answer eBay's challenge with.
 *
 * Read through a function rather than exported as a value, because a route
 * module is evaluated at build time and the configuration is not loaded then.
 */
export function verificationToken(): string {
  return runtime().config.EIM_EBAY_DELETION_VERIFICATION_TOKEN ?? '';
}

export function receiversFor(environment: EbayEnvironment): Receivers {
  const container = globalThis as unknown as GlobalWithReceivers;
  const cache = (container[RECEIVERS_KEY] ??= new Map<EbayEnvironment, Receivers>());
  const existing = cache.get(environment);

  if (existing !== undefined) {
    return existing;
  }

  const { config, db } = runtime();

  const http = createHttpClient({
    policy: {
      allowPrivate: config.EIM_ALLOW_PRIVATE_INTEGRATION_HOSTS,
      allowlist: config.EIM_PRIVATE_HOST_ALLOWLIST,
      allowInsecure: config.EIM_ALLOW_PRIVATE_INTEGRATION_HOSTS,
    },
    userAgent: `eCommerce-Inventory-Manager/${config.EIM_APP_VERSION ?? 'unknown'}`,
  });

  const applicationToken = createApplicationTokenReader({
    http,
    // Listed rather than passed wholesale: the lookup takes a plain record, and
    // handing it the whole configuration would mean every installation secret
    // is in reach of a function that needs six of them.
    credentials: credentialsFrom({
      EIM_EBAY_SANDBOX_CLIENT_ID: config.EIM_EBAY_SANDBOX_CLIENT_ID,
      EIM_EBAY_SANDBOX_CLIENT_SECRET: config.EIM_EBAY_SANDBOX_CLIENT_SECRET,
      EIM_EBAY_SANDBOX_RUNAME: config.EIM_EBAY_SANDBOX_RUNAME,
      EIM_EBAY_PRODUCTION_CLIENT_ID: config.EIM_EBAY_PRODUCTION_CLIENT_ID,
      EIM_EBAY_PRODUCTION_CLIENT_SECRET: config.EIM_EBAY_PRODUCTION_CLIENT_SECRET,
      EIM_EBAY_PRODUCTION_RUNAME: config.EIM_EBAY_PRODUCTION_RUNAME,
    }),
  });

  const verifier = createSignatureVerifier({
    keys: createPublicKeyReader({
      http,
      environment,
      applicationToken: (now) => applicationToken.read(environment, now),
    }),
  });

  const built: Receivers = {
    intake: createNotificationIntake({ db, environment, verifier }),
    deletion: createMarketplaceDeletion({
      db,
      verifier,
      endpoint: notificationEndpoint(environment, 'account-deletion'),
      // eBay's portal holds the same value. One token serves both endpoints
      // because the challenge hash binds the endpoint URL, so an answer for one
      // is the wrong answer at the other.
      verificationToken: config.EIM_EBAY_DELETION_VERIFICATION_TOKEN ?? '',
    }),
  };

  cache.set(environment, built);

  return built;
}
