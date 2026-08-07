import { authorize } from '@eim/authz';
import { connectionScopes, connections, type Database } from '@eim/db';
import {
  configuredEnvironments,
  createConnectionHealth,
  createEbayOAuth,
  createEbayReadiness,
  createIdentityReader,
  createQuotaLedger,
  credentialsFrom,
  type ConnectionHealthReport,
  type EbayOAuth,
  type EbayReadiness,
  type ReadinessReport,
} from '@eim/integrations';
import { createHttpClient } from '@eim/providers';
import { desc, eq, inArray } from 'drizzle-orm';

import { identity } from './identity';
import { runtime } from './runtime';
import { integrationUrlPolicy, woocommerce } from './woocommerce';

/**
 * Everything the connections screen needs, in one place (sections 13, 14, 21).
 *
 * Section 21 asks the connections screen to show identity, environment, scopes,
 * health, webhook status, quotas, and last sync, and to offer connect,
 * reauthorize, test, rotate, pause, and disconnect. That is a lot of moving
 * parts, and assembling them per request in the page would mean a page that
 * cannot be rendered without a live provider.
 *
 * So reading and acting are separated. `listConnections` reads only what is
 * already stored — the last recorded readiness, the last recorded health — and
 * makes no provider call at all. Testing a connection is a deliberate action a
 * person takes, and it is the only thing here that goes out to eBay or a store.
 * A status page that called every provider on every render would be the thing
 * exhausting the quota it is reporting on.
 */

const EBAY_KEY = Symbol.for('eim.web.ebay');

interface EbayWiring {
  readonly oauth: EbayOAuth;
  readonly readiness: EbayReadiness;
}

type GlobalWithEbay = Record<symbol, EbayWiring | undefined>;

export function ebay(): EbayWiring {
  const container = globalThis as unknown as GlobalWithEbay;
  const existing = container[EBAY_KEY];

  if (existing !== undefined) {
    return existing;
  }

  const { config, db } = runtime();
  const { secrets, authorizations } = woocommerce();
  const credentials = ebayCredentials();

  const http = createHttpClient({
    policy: integrationUrlPolicy(),
    userAgent: `eCommerce-Inventory-Manager/${config.EIM_APP_VERSION ?? 'unknown'}`,
  });

  const oauth = createEbayOAuth({
    db,
    http,
    secrets,
    authorizations,
    credentials,
    identify: createIdentityReader(http),
  });

  const built: EbayWiring = {
    oauth,
    readiness: createEbayReadiness({
      db,
      http,
      accessToken: async (input) => {
        const outcome = await oauth.accessToken(input);

        return outcome.ok ? outcome.token : null;
      },
    }),
  };

  container[EBAY_KEY] = built;

  return built;
}

/** The installation's eBay keysets, read from the validated configuration. */
function ebayCredentials() {
  const { config } = runtime();

  return credentialsFrom({
    EIM_EBAY_SANDBOX_CLIENT_ID: config.EIM_EBAY_SANDBOX_CLIENT_ID,
    EIM_EBAY_SANDBOX_CLIENT_SECRET: config.EIM_EBAY_SANDBOX_CLIENT_SECRET,
    EIM_EBAY_SANDBOX_RUNAME: config.EIM_EBAY_SANDBOX_RUNAME,
    EIM_EBAY_PRODUCTION_CLIENT_ID: config.EIM_EBAY_PRODUCTION_CLIENT_ID,
    EIM_EBAY_PRODUCTION_CLIENT_SECRET: config.EIM_EBAY_PRODUCTION_CLIENT_SECRET,
    EIM_EBAY_PRODUCTION_RUNAME: config.EIM_EBAY_PRODUCTION_RUNAME,
  });
}

/**
 * Which providers this installation is configured to connect at all.
 *
 * Section 21 asks for a provider-specific setup empty state, and this is what
 * distinguishes "no connections yet" from "no eBay credentials in the
 * environment file" — two situations with completely different next steps.
 *
 * WooCommerce is always offerable: its key is issued by each store, so there is
 * nothing for an installation to configure in advance.
 */
export function availableProviders(): {
  ebay: readonly ('sandbox' | 'production')[];
  woocommerce: boolean;
} {
  const credentials = ebayCredentials();

  // A predicate, not a lookup: whether a keyset exists, never what is in it.
  return {
    ebay: configuredEnvironments((environment) => credentials(environment) !== null),
    woocommerce: true,
  };
}

export interface ConnectionSummary {
  readonly id: string;
  readonly provider: 'ebay' | 'woocommerce';
  readonly environment: 'sandbox' | 'production';
  readonly displayName: string;
  /** The seller identifier or the store address. Immutable (sections 13, 14). */
  readonly externalAccountId: string;
  readonly status: string;
  readonly pauseReason: string | null;
  readonly connectedAt: Date | null;
  readonly scopes: readonly string[];
  readonly readiness: ReadinessReport | null;
  readonly health: ConnectionHealthReport;
}

/**
 * Every connection in a business, with what is already known about each.
 *
 * No provider is called. Readiness is the last recorded assessment and health is
 * computed from stored counters, so this renders during a provider outage — which
 * is exactly when somebody is looking at it.
 */
export async function listConnections(businessId: string): Promise<ConnectionSummary[]> {
  const { db } = runtime();

  const rows = await db
    .select()
    .from(connections)
    .where(eq(connections.businessId, businessId))
    .orderBy(desc(connections.createdAt));

  const live = rows.filter((row) => row.status !== 'disconnected');

  if (live.length === 0) {
    return [];
  }

  const scopes = await db
    .select({ connectionId: connectionScopes.connectionId, scope: connectionScopes.scope })
    .from(connectionScopes)
    .where(
      inArray(
        connectionScopes.connectionId,
        live.map((row) => row.id),
      ),
    );

  const health = createConnectionHealth({ db, quotas: createQuotaLedger(db) });
  const summaries: ConnectionSummary[] = [];

  for (const row of live) {
    summaries.push({
      id: row.id,
      provider: row.provider,
      environment: row.environment,
      displayName: row.displayName,
      externalAccountId: row.externalAccountId,
      status: row.status,
      pauseReason: row.pauseReason,
      connectedAt: row.connectedAt,
      scopes: scopes.filter((scope) => scope.connectionId === row.id).map((scope) => scope.scope),
      readiness: await readinessFor(row.provider, businessId, row.id),
      health: await health.assess({ businessId, connectionId: row.id }),
    });
  }

  return summaries;
}

async function readinessFor(
  provider: 'ebay' | 'woocommerce',
  businessId: string,
  connectionId: string,
): Promise<ReadinessReport | null> {
  return provider === 'ebay'
    ? ebay().readiness.read({ businessId, connectionId })
    : woocommerce().readiness.read({ businessId, connectionId });
}

/** The connection, once it is established the caller may act on it. */
export async function loadConnection(
  db: Database,
  businessId: string,
  connectionId: string,
): Promise<typeof connections.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(connections)
    .where(eq(connections.id, connectionId))
    .limit(1);

  // Compared rather than filtered in the query, so that the caller cannot
  // distinguish "not yours" from "does not exist" by timing or by error.
  return row?.businessId === businessId ? row : null;
}

/**
 * Whether the caller may see connection health, and whether they may change it.
 *
 * Section 5's rule holds: the screen hides what the caller cannot do, and every
 * action re-checks server-side anyway. Hiding a button is a courtesy to the
 * person using the screen, not a control on the person attacking it.
 */
export async function connectionPermissions(
  businessId: string,
  userId: string,
): Promise<{ canView: boolean; canManage: boolean }> {
  const { db } = runtime();
  const subject = await identity().memberships.loadSubject(db, businessId, userId);

  if (subject === null) {
    return { canView: false, canManage: false };
  }

  return {
    canView: authorize(subject, 'view_connection_health').allowed,
    canManage: authorize(subject, 'manage_integrations').allowed,
  };
}
