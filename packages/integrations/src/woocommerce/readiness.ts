import { connectionScopes, connections, type Database } from '@eim/db';
import type { HttpClient, UrlPolicy } from '@eim/providers';
import { and, eq } from 'drizzle-orm';

import {
  readRecordedChecks,
  recordChecks,
  summarizeChecks,
  unknownCheck,
  type ReadinessCheck,
  type ReadinessReport,
} from '../readiness';
import type { SecretStore } from '../secrets';
import { clientForConnection, parseJsonArray, type WooClient } from './client';
import { capabilitiesFor, readPermissions, type WooPermissions } from './connection';
import { describeStore } from './store';

/**
 * Whether a store is set up for what this application is about to do
 * (section 14).
 *
 * Every call here is a read. Section 14 is explicit that global stock management
 * is guided and never enabled automatically, and the reason is worth stating:
 * turning it on changes how the store behaves for every order placed by every
 * customer, including the ones placed by people who have nothing to do with this
 * integration. That is a shopkeeper's decision.
 *
 * The check that carries the most weight is `stock_management`. WooCommerce has
 * a global "manage stock" switch, and with it off a product's `stock_quantity`
 * is a number the store stores and completely ignores — orders do not decrement
 * it and nothing enforces it. Writing quantities into a store in that state
 * produces an integration that reports success on every write and has no effect
 * whatsoever, which is the worst of the available failure modes because nothing
 * anywhere says anything is wrong. So it blocks `write_quantities`, and it
 * blocks nothing else: importing a catalog from such a store is perfectly
 * meaningful.
 */

const CAPABILITY_CHECKS: Readonly<Record<string, readonly string[]>> = {
  import_catalog: ['identity', 'api_reachable', 'credentials'],
  import_orders: ['identity', 'api_reachable', 'credentials'],
  import_refunds: ['identity', 'api_reachable', 'credentials'],
  // Webhooks need the route to exist and the key to be allowed to manage it.
  // Section 14 keeps polling running regardless, so this degrades rather than
  // stops the integration.
  manage_webhooks: ['identity', 'api_reachable', 'credentials', 'webhooks'],
  write_quantities: ['identity', 'api_reachable', 'credentials', 'stock_management'],
  publish_products: ['identity', 'api_reachable', 'credentials'],
  change_prices: ['identity', 'api_reachable', 'credentials'],
};

export interface WooReadinessOptions {
  readonly db: Database;
  readonly http: HttpClient;
  readonly secrets: SecretStore;
  readonly policy: UrlPolicy;
}

export interface WooReadiness {
  assess(input: { businessId: string; connectionId: string; now?: Date }): Promise<ReadinessReport>;
  read(input: { businessId: string; connectionId: string }): Promise<ReadinessReport | null>;
}

export function createWooReadiness(options: WooReadinessOptions): WooReadiness {
  const { db } = options;

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
        return missingConnection(input.connectionId, now);
      }

      const permissions = await grantedPermissions(db, input.connectionId);
      const described = describeStore(connection.externalAccountId, options.policy);

      const checks: ReadinessCheck[] = [
        identityCheck(connection.externalAccountId, connection.status, connection.environment),
        permissionCheck(permissions),
      ];

      const client = described.ok
        ? await clientForConnection({
            http: options.http,
            secrets: options.secrets,
            businessId: input.businessId,
            connectionId: input.connectionId,
            restBase: described.store.restBase,
          })
        : null;

      if (!described.ok) {
        checks.push(
          {
            name: 'api_reachable',
            status: 'fail',
            summary: `the stored address is no longer one this installation may reach: ${described.reason}`,
            detail: { store: connection.externalAccountId },
          },
          unknownCheck('credentials', 'not checked: the store address is unusable'),
          unknownCheck('stock_management', 'not checked: the store address is unusable'),
          unknownCheck('webhooks', 'not checked: the store address is unusable'),
        );
      } else if (client === null) {
        // Everything below needs a key. Reporting `unknown` for each rather than
        // `fail` keeps the operator pointed at the one real problem instead of
        // at four symptoms of it.
        checks.push(
          unknownCheck('api_reachable', 'no stored credentials; the store must be connected again'),
          unknownCheck('credentials', 'not checked: no stored credentials'),
          unknownCheck('stock_management', 'not checked: no stored credentials'),
          unknownCheck('webhooks', 'not checked: no stored credentials'),
        );
      } else {
        const credentials = await credentialCheck(client);

        checks.push(credentials);

        if (credentials.status === 'pass') {
          checks.push(await stockManagementCheck(client), await webhookCheck(client));
        } else {
          checks.push(
            unknownCheck('stock_management', 'not checked: the store did not accept the key'),
            unknownCheck('webhooks', 'not checked: the store did not accept the key'),
          );
        }

        // Derived from the calls that were actually made rather than from a
        // separate probe: a dedicated ping proves the store answered a request
        // that costs nothing, which is not the question.
        checks.splice(2, 0, reachabilityFrom(checks));
      }

      await recordChecks(db, input.businessId, input.connectionId, checks, now);

      return summarize(input.connectionId, checks, permissions, now);
    },

    async read(input) {
      const recorded = await readRecordedChecks(db, input.businessId, input.connectionId);

      if (recorded === null) {
        return null;
      }

      return summarize(
        input.connectionId,
        recorded.checks,
        await grantedPermissions(db, input.connectionId),
        recorded.checkedAt,
      );
    },
  };
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

function identityCheck(store: string, status: string, environment: string): ReadinessCheck {
  if (status === 'disconnected' || status === 'revoked') {
    return {
      name: 'identity',
      status: 'fail',
      summary: 'the store has been disconnected and must be connected again',
      detail: { store, environment },
    };
  }

  const insecure = store.startsWith('http://');

  return {
    name: 'identity',
    // A plain-HTTP store is reachable only because the installation opted into
    // it, and it stays a warning for as long as it is connected: the consumer
    // key is sent on every request, and on that transport it is sent in clear.
    status: status === 'active' ? (insecure ? 'warn' : 'pass') : 'warn',
    summary: insecure
      ? `connected to ${store} over plain HTTP; the store key is sent unencrypted`
      : status === 'active'
        ? `connected to ${store}`
        : `connected to ${store}, currently ${status}`,
    detail: { store, environment, status, transport: insecure ? 'http' : 'https' },
  };
}

function permissionCheck(permissions: WooPermissions): ReadinessCheck {
  const { impaired } = capabilitiesFor(permissions);

  return {
    name: 'permissions',
    status: impaired.length === 0 ? 'pass' : 'warn',
    summary:
      impaired.length === 0
        ? 'the store key has read and write access'
        : `the store key is ${permissions}, so ${impaired.join(', ')} are unavailable`,
    detail: { permissions, impairedCapabilities: impaired },
  };
}

/** Whether the stored key still authenticates. */
async function credentialCheck(client: WooClient): Promise<ReadinessCheck> {
  const outcome = await client.get('/products?per_page=1&status=any');

  if (!outcome.ok) {
    return unknownCheck('credentials', `the store did not answer (${outcome.reason})`);
  }

  const status = outcome.response.status;

  if (status === 401 || status === 403) {
    return {
      name: 'credentials',
      status: 'fail',
      summary: 'the store rejected the stored key; it must be replaced',
      detail: { status },
    };
  }

  if (status !== 200) {
    return unknownCheck('credentials', `the store answered ${String(status)} to a catalog read`);
  }

  return {
    name: 'credentials',
    status: 'pass',
    summary: 'the stored key reads the catalog',
    detail: { status },
  };
}

/**
 * WooCommerce's global stock management switch.
 *
 * Read from the settings API rather than inferred from a product, because a
 * single product with `manage_stock` set says nothing about the store: the
 * per-product flag is only consulted when the global one is on.
 */
async function stockManagementCheck(client: WooClient): Promise<ReadinessCheck> {
  const outcome = await client.get('/settings/products');

  if (!outcome.ok) {
    return unknownCheck('stock_management', `the store did not answer (${outcome.reason})`);
  }

  if (outcome.response.status !== 200) {
    return unknownCheck(
      'stock_management',
      `the store answered ${String(outcome.response.status)} for its product settings`,
    );
  }

  const settings = parseJsonArray(outcome.response.body);
  const setting = settings.find((entry) => entry['id'] === 'woocommerce_manage_stock');
  const value = setting?.['value'];

  if (typeof value !== 'string') {
    return unknownCheck(
      'stock_management',
      'the store did not report whether it manages stock globally',
    );
  }

  const enabled = value === 'yes';

  return {
    name: 'stock_management',
    status: enabled ? 'pass' : 'fail',
    summary: enabled
      ? 'the store manages stock globally, so quantity writes take effect'
      : 'the store has global stock management switched off; quantities written to it would be stored and ignored',
    detail: {
      enabled,
      // Section 14: guide, never enable automatically.
      remedy: enabled
        ? null
        : 'switch on WooCommerce → Settings → Products → Inventory → Manage stock',
    },
  };
}

/**
 * Whether webhooks can be managed at all.
 *
 * A `warn` rather than a `fail` when the route refuses: section 14 keeps polling
 * running regardless, so a store whose webhooks cannot be managed is a store
 * this application still works with, more slowly and visibly degraded.
 */
async function webhookCheck(client: WooClient): Promise<ReadinessCheck> {
  const outcome = await client.get('/webhooks?per_page=1');

  if (!outcome.ok) {
    return unknownCheck('webhooks', `the store did not answer (${outcome.reason})`);
  }

  const status = outcome.response.status;

  if (status === 200) {
    return {
      name: 'webhooks',
      status: 'pass',
      summary: 'the store allows this key to manage webhooks',
      detail: { status },
    };
  }

  if (status === 401 || status === 403) {
    return {
      name: 'webhooks',
      status: 'warn',
      summary:
        'the store key may not manage webhooks; changes will be found by polling, which is slower',
      detail: { status },
    };
  }

  if (status === 404) {
    return {
      name: 'webhooks',
      status: 'warn',
      summary: 'this store does not offer the webhook route; changes will be found by polling',
      detail: { status },
    };
  }

  return unknownCheck('webhooks', `the store answered ${String(status)} for its webhook route`);
}

function reachabilityFrom(checks: readonly ReadinessCheck[]): ReadinessCheck {
  const names = ['credentials', 'stock_management', 'webhooks'];
  const attempted = checks.filter((check) => names.includes(check.name));
  const unknown = attempted.filter((check) => check.status === 'unknown');

  if (unknown.length === 0) {
    return {
      name: 'api_reachable',
      status: 'pass',
      summary: 'the store answered every request',
      detail: { attempted: attempted.length },
    };
  }

  return {
    name: 'api_reachable',
    status: unknown.length === attempted.length ? 'fail' : 'warn',
    summary:
      unknown.length === attempted.length
        ? 'the store did not answer any request'
        : `the store did not answer ${String(unknown.length)} of ${String(attempted.length)} requests`,
    detail: { attempted: attempted.length, unanswered: unknown.map((check) => check.name) },
  };
}

// ---------------------------------------------------------------------------

async function grantedPermissions(db: Database, connectionId: string): Promise<WooPermissions> {
  const rows = await db
    .select({ scope: connectionScopes.scope })
    .from(connectionScopes)
    .where(eq(connectionScopes.connectionId, connectionId));

  const recorded = rows.find((row) => row.scope.startsWith('woocommerce:'));

  return readPermissions(recorded?.scope.slice('woocommerce:'.length));
}

function summarize(
  connectionId: string,
  checks: readonly ReadinessCheck[],
  permissions: WooPermissions,
  checkedAt: Date,
): ReadinessReport {
  return summarizeChecks({
    connectionId,
    checks,
    requirements: CAPABILITY_CHECKS,
    ungranted: capabilitiesFor(permissions).impaired,
    ungrantedBecause: 'permissions',
    checkedAt,
  });
}

function missingConnection(connectionId: string, now: Date): ReadinessReport {
  return {
    connectionId,
    checks: [
      { name: 'identity', status: 'fail', summary: 'this connection no longer exists', detail: {} },
    ],
    available: [],
    blocked: Object.keys(CAPABILITY_CHECKS).map((capability) => ({
      capability,
      because: 'identity',
    })),
    checkedAt: now,
  };
}
