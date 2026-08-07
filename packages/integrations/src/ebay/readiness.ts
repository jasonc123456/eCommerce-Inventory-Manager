import { connectionScopes, connections, type Database } from '@eim/db';
import type { HttpClient } from '@eim/providers';
import { and, eq } from 'drizzle-orm';

import {
  readRecordedChecks,
  recordChecks,
  summarizeChecks,
  unknownCheck,
  type ReadinessCheck,
  type ReadinessReport,
  type ReadinessStatus,
} from '../readiness';
import { hostsFor, type EbayEnvironment } from './environment';
import { CAPABILITY_SCOPES, supports } from './scopes';

/**
 * What a connection can and cannot do yet (section 13).
 *
 * Section 13's readiness assessment is read-only and per-check, and both halves
 * of that matter.
 *
 * Read-only, because a readiness check that fixes what it finds is a check that
 * changes a seller's account on a schedule nobody asked for. Every call below is
 * a GET. Where something is missing — a business policy, an inventory location,
 * out-of-stock control — this reports it and explains what to do, and section 13
 * is explicit that existing eBay locations are never automatically modified and
 * out-of-stock control is never automatically enabled.
 *
 * Per-check, because a connection is not simply ready or not. Catalog import may
 * proceed while a write capability stays blocked on its own prerequisite, and
 * that is only expressible if each check keeps its own outcome. A single boolean
 * would force the choice between blocking everything on the strictest
 * requirement and letting a write through on the weakest.
 *
 * A check that could not be performed reports `unknown`, never `pass`. The
 * difference between "eBay says there are no business policies" and "eBay did
 * not answer" is the difference between a setup task and an outage, and
 * collapsing them sends the operator to fix the wrong thing.
 */

export type { ReadinessCheck, ReadinessReport, ReadinessStatus };

/**
 * Which checks a capability depends on.
 *
 * Scope requirements are handled separately, by `CAPABILITY_SCOPES`: a scope is
 * a fact about the grant, while these are facts about the account.
 */
const CAPABILITY_CHECKS: Readonly<Record<string, readonly string[]>> = {
  import_catalog: ['identity', 'api_reachable'],
  import_orders: ['identity', 'api_reachable'],
  import_policies: ['identity', 'api_reachable'],
  // Writing quantities needs somewhere for the stock to be and a marketplace to
  // sell it on, which is more than the catalog import needs.
  write_quantities: ['identity', 'api_reachable', 'inventory_locations', 'out_of_stock_control'],
  // Publishing needs the policies eBay requires on every listing.
  publish_listings: ['identity', 'api_reachable', 'business_policies', 'inventory_locations'],
};

export interface ReadinessOptions {
  readonly db: Database;
  readonly http: HttpClient;
  /** Supplies a usable access token, refreshing if it must. */
  readonly accessToken: (input: {
    businessId: string;
    connectionId: string;
    environment: EbayEnvironment;
  }) => Promise<string | null>;
}

export interface AssessInput {
  readonly businessId: string;
  readonly connectionId: string;
  readonly now?: Date;
}

export interface EbayReadiness {
  /** Runs every check and records the outcome. */
  assess(input: AssessInput): Promise<ReadinessReport>;
  /** The last recorded outcome, without calling eBay. */
  read(input: { businessId: string; connectionId: string }): Promise<ReadinessReport | null>;
}

export function createEbayReadiness(options: ReadinessOptions): EbayReadiness {
  const { db, http, accessToken } = options;

  return {
    async assess(input) {
      const now = input.now ?? new Date();

      const [connection] = await db
        .select()
        .from(connections)
        .where(
          and(eq(connections.id, input.connectionId), eq(connections.businessId, input.businessId)),
        )
        .limit(1);

      if (connection === undefined) {
        // Not an error worth throwing: a connection can be disconnected between
        // a screen being rendered and its refresh button being pressed.
        return {
          connectionId: input.connectionId,
          checks: [
            {
              name: 'identity',
              status: 'fail',
              summary: 'this connection no longer exists',
              detail: {},
            },
          ],
          available: [],
          blocked: Object.keys(CAPABILITY_CHECKS).map((capability) => ({
            capability,
            because: 'identity',
          })),
          checkedAt: now,
        };
      }

      const granted = (
        await db
          .select({ scope: connectionScopes.scope })
          .from(connectionScopes)
          .where(eq(connectionScopes.connectionId, input.connectionId))
      ).map((row) => row.scope);

      const credential = await accessToken({
        businessId: input.businessId,
        connectionId: input.connectionId,
        environment: connection.environment,
      });

      const checks: ReadinessCheck[] = [
        identityCheck(connection.externalAccountId, connection.environment, connection.status),
        scopeCheck(granted),
      ];

      if (credential === null) {
        // Everything below needs a token. Reporting `unknown` for each rather
        // than `fail` keeps the operator pointed at the one real problem — the
        // credentials — instead of at eight symptoms of it.
        checks.push(
          unknownCheck(
            'api_reachable',
            'no usable credentials; the connection needs reauthorizing',
          ),
          unknownCheck('marketplace', 'not checked: no usable credentials'),
          unknownCheck('business_policies', 'not checked: no usable credentials'),
          unknownCheck('inventory_locations', 'not checked: no usable credentials'),
          unknownCheck('out_of_stock_control', 'not checked: no usable credentials'),
        );
      } else {
        const context = { http, token: credential, hosts: hostsFor(connection.environment) };

        checks.push(
          await marketplaceCheck(context),
          await businessPolicyCheck(context),
          await inventoryLocationCheck(context),
          await outOfStockCheck(context),
        );

        // Derived from the calls above rather than from a separate probe: a
        // dedicated ping tells you the API answered a request that costs
        // nothing, which is not the question.
        checks.unshift(reachabilityFrom(checks));
      }

      await recordChecks(db, input.businessId, input.connectionId, checks, now);

      return summarize(input.connectionId, checks, granted, now);
    },

    async read(input) {
      const recorded = await readRecordedChecks(db, input.businessId, input.connectionId);

      if (recorded === null) {
        return null;
      }

      const granted = (
        await db
          .select({ scope: connectionScopes.scope })
          .from(connectionScopes)
          .where(eq(connectionScopes.connectionId, input.connectionId))
      ).map((row) => row.scope);

      return summarize(input.connectionId, recorded.checks, granted, recorded.checkedAt);
    },
  };
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

interface CallContext {
  readonly http: HttpClient;
  readonly token: string;
  readonly hosts: ReturnType<typeof hostsFor>;
}

function identityCheck(
  sellerId: string,
  environment: EbayEnvironment,
  status: string,
): ReadinessCheck {
  if (status === 'disconnected' || status === 'revoked') {
    return {
      name: 'identity',
      status: 'fail',
      summary: 'the connection has been disconnected and must be authorized again',
      detail: { sellerId, environment },
    };
  }

  return {
    name: 'identity',
    status: status === 'active' ? 'pass' : 'warn',
    summary:
      status === 'active'
        ? `connected to eBay seller ${sellerId} in ${environment}`
        : `connected to eBay seller ${sellerId} in ${environment}, currently ${status}`,
    detail: { sellerId, environment, status },
  };
}

function scopeCheck(granted: readonly string[]): ReadinessCheck {
  const missing = Object.entries(CAPABILITY_SCOPES)
    .filter(([capability]) => !capability.startsWith('write_'))
    .filter(([capability]) => !supports(granted, capability))
    .map(([capability]) => capability);

  if (granted.length === 0) {
    return {
      name: 'scopes',
      status: 'fail',
      summary: 'eBay granted no permissions; the connection must be authorized again',
      detail: { granted: [] },
    };
  }

  return {
    name: 'scopes',
    status: missing.length === 0 ? 'pass' : 'warn',
    summary:
      missing.length === 0
        ? 'every permission this milestone needs was granted'
        : `eBay did not grant the permissions for ${missing.join(', ')}`,
    detail: { granted, missingCapabilities: missing },
  };
}

/**
 * eBay US and the seller's privileges there.
 *
 * `getPrivileges` is the call that says whether the account can actually list,
 * and it is where a seller who has not completed registration shows up as
 * something other than an error.
 */
async function marketplaceCheck(context: CallContext): Promise<ReadinessCheck> {
  const outcome = await get(context, '/sell/account/v1/privilege');

  if (outcome === null) {
    return unknownCheck('marketplace', 'eBay did not answer the seller privileges request');
  }

  if (outcome.status === 403 || outcome.status === 401) {
    return {
      name: 'marketplace',
      status: 'warn',
      summary: 'eBay refused the seller privileges request for this grant',
      detail: { status: outcome.status },
    };
  }

  const payload = json(outcome.body);

  if (payload === null) {
    return unknownCheck('marketplace', 'eBay returned something other than seller privileges');
  }

  const registrationCompleted = payload['sellerRegistrationCompleted'];
  const limit = payload['sellingLimit'];

  return {
    name: 'marketplace',
    status: registrationCompleted === true ? 'pass' : 'warn',
    summary:
      registrationCompleted === true
        ? 'the seller account is registered and able to list'
        : 'eBay reports the seller registration is not complete',
    detail: {
      sellerRegistrationCompleted: registrationCompleted === true,
      ...(typeof limit === 'object' && limit !== null ? { sellingLimit: limit } : {}),
    },
  };
}

/**
 * Business policies.
 *
 * Section 13 imports and selects existing policies and does not create them in
 * version 1, so an account with none is a setup task for the operator rather
 * than something to fix from here. Warn, not fail: catalog import works without
 * them, and only publication does not.
 */
async function businessPolicyCheck(context: CallContext): Promise<ReadinessCheck> {
  const kinds = [
    ['payment', '/sell/account/v1/payment_policy?marketplace_id=EBAY_US'],
    ['return', '/sell/account/v1/return_policy?marketplace_id=EBAY_US'],
    ['fulfillment', '/sell/account/v1/fulfillment_policy?marketplace_id=EBAY_US'],
  ] as const;

  const counts: Record<string, number> = {};
  let unavailable = false;

  for (const [kind, path] of kinds) {
    const outcome = await get(context, path);
    const payload = outcome === null ? null : json(outcome.body);

    if (payload === null) {
      unavailable = true;
      continue;
    }

    const list = payload[`${kind}Policies`];

    counts[kind] = Array.isArray(list) ? list.length : 0;
  }

  if (unavailable) {
    return unknownCheck('business_policies', 'eBay did not answer the business policy request');
  }

  const missing = Object.entries(counts)
    .filter(([, count]) => count === 0)
    .map(([kind]) => kind);

  return {
    name: 'business_policies',
    status: missing.length === 0 ? 'pass' : 'warn',
    summary:
      missing.length === 0
        ? 'payment, return, and fulfillment policies are available'
        : `no ${missing.join(' or ')} policy is set up on this eBay account`,
    detail: { counts },
  };
}

/**
 * Inventory locations.
 *
 * A quantity write has to name a location, so an account with none cannot be
 * written to. Section 13 permits creating one only through a separately
 * confirmed preview, which is not this.
 */
async function inventoryLocationCheck(context: CallContext): Promise<ReadinessCheck> {
  const outcome = await get(context, '/sell/inventory/v1/location?limit=100');

  if (outcome === null) {
    return unknownCheck('inventory_locations', 'eBay did not answer the location request');
  }

  const payload = json(outcome.body);

  if (payload === null) {
    return unknownCheck('inventory_locations', 'eBay returned something other than locations');
  }

  const locations = payload['locations'];
  const list = Array.isArray(locations) ? locations : [];
  const enabled = list.filter(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      (entry as Record<string, unknown>)['merchantLocationStatus'] !== 'DISABLED',
  );

  return {
    name: 'inventory_locations',
    status: enabled.length > 0 ? 'pass' : 'fail',
    summary:
      enabled.length > 0
        ? `${String(enabled.length)} inventory location${enabled.length === 1 ? '' : 's'} available`
        : 'this eBay account has no enabled inventory location, so quantities cannot be published',
    detail: { total: list.length, enabled: enabled.length },
  };
}

/**
 * Out-of-stock control.
 *
 * With it on, a listing that reaches zero is hidden rather than ended, and it
 * comes back when stock returns. With it off, the listing ends and has to be
 * relisted — which loses its identifiers, and with them every mapping pointing
 * at it. Section 13 says to detect it and warn, and never to change it.
 */
async function outOfStockCheck(context: CallContext): Promise<ReadinessCheck> {
  const outcome = await get(context, '/sell/account/v1/privilege');

  if (outcome === null) {
    return unknownCheck(
      'out_of_stock_control',
      'eBay did not answer, so the out-of-stock setting is unknown',
    );
  }

  const payload = json(outcome.body);
  const enabled =
    payload === null
      ? null
      : firstBoolean(payload, ['outOfStockControlEnabled', 'outOfStockControl']);

  if (enabled === null) {
    // eBay does not always report this. Unknown is the honest answer: guessing
    // "on" invites a mapping-destroying relist, and guessing "off" nags an
    // operator who has already set it correctly.
    return unknownCheck(
      'out_of_stock_control',
      'eBay did not report the out-of-stock setting for this account',
    );
  }

  return {
    name: 'out_of_stock_control',
    status: enabled ? 'pass' : 'warn',
    summary: enabled
      ? 'out-of-stock control is on, so listings are hidden at zero rather than ended'
      : 'out-of-stock control is off; listings that reach zero will end and lose their mappings',
    detail: { enabled },
  };
}

/**
 * Whether eBay answered at all.
 *
 * Derived from the checks that were actually attempted rather than from a
 * separate probe, because a dedicated ping proves the API answered a request
 * that costs nothing, which is not what anybody wants to know.
 */
function reachabilityFrom(checks: readonly ReadinessCheck[]): ReadinessCheck {
  const attempted = checks.filter((check) =>
    ['marketplace', 'business_policies', 'inventory_locations', 'out_of_stock_control'].includes(
      check.name,
    ),
  );

  const unknown = attempted.filter((check) => check.status === 'unknown');

  if (unknown.length === 0) {
    return {
      name: 'api_reachable',
      status: 'pass',
      summary: 'eBay answered every request',
      detail: { attempted: attempted.length },
    };
  }

  return {
    name: 'api_reachable',
    status: unknown.length === attempted.length ? 'fail' : 'warn',
    summary:
      unknown.length === attempted.length
        ? 'eBay did not answer any request'
        : `eBay did not answer ${String(unknown.length)} of ${String(attempted.length)} requests`,
    detail: { attempted: attempted.length, unanswered: unknown.map((check) => check.name) },
  };
}

// ---------------------------------------------------------------------------

async function get(
  context: CallContext,
  path: string,
): Promise<{ status: number; body: string } | null> {
  const outcome = await context.http.send({
    method: 'GET',
    url: `${context.hosts.apiBase}${path}`,
    headers: {
      authorization: `Bearer ${context.token}`,
      accept: 'application/json',
      // eBay requires the marketplace on several Account calls and ignores it
      // on the rest, so it is sent everywhere rather than remembered per call.
      'x-ebay-c-marketplace-id': 'EBAY_US',
    },
    timeoutMs: 15_000,
    maxBytes: 512 * 1024,
  });

  return outcome.ok ? { status: outcome.response.status, body: outcome.response.body } : null;
}

function json(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);

    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The first of several spellings eBay has used for one setting. */
function firstBoolean(payload: Record<string, unknown>, keys: readonly string[]): boolean | null {
  for (const key of keys) {
    const value = payload[key];

    if (typeof value === 'boolean') {
      return value;
    }
  }

  return null;
}

function summarize(
  connectionId: string,
  checks: readonly ReadinessCheck[],
  granted: readonly string[],
  checkedAt: Date,
): ReadinessReport {
  // A scope this connection was not granted blocks the capability before any
  // account condition is considered: no amount of correct setup substitutes for
  // permission.
  const ungranted = Object.keys(CAPABILITY_CHECKS).filter(
    (capability) => CAPABILITY_SCOPES[capability] !== undefined && !supports(granted, capability),
  );

  return summarizeChecks({
    connectionId,
    checks,
    requirements: CAPABILITY_CHECKS,
    ungranted,
    ungrantedBecause: 'scopes',
    checkedAt,
  });
}
