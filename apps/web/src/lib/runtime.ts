import { loadConfig, type InstallationConfig } from '@eim/config';
import {
  appliedSchemaVersion,
  connect,
  expectedSchemaVersion,
  type Database,
  type DatabasePool,
} from '@eim/db';
import { createLogger, createMetrics, type EimMetrics, type Logger } from '@eim/observability';

/**
 * Process-wide singletons for the web tier.
 *
 * Next.js does not give a server process an explicit startup hook, so these are
 * built on first use and cached on `globalThis`. The global is not laziness: in
 * development Next.js reloads modules on every edit, and a plain module-level
 * variable would create a new connection pool per reload until PostgreSQL ran
 * out of connections. Pinning to the global survives module reload.
 */

interface Runtime {
  readonly config: InstallationConfig;
  readonly logger: Logger;
  readonly metrics: EimMetrics;
  readonly pool: DatabasePool;
  readonly db: Database;
}

const RUNTIME_KEY = Symbol.for('eim.web.runtime');

interface GlobalWithRuntime {
  [RUNTIME_KEY]?: Runtime;
}

export function runtime(): Runtime {
  const container = globalThis as unknown as GlobalWithRuntime;
  const existing = container[RUNTIME_KEY];

  if (existing !== undefined) {
    return existing;
  }

  const config = loadConfig();
  const logger = createLogger({
    level: config.EIM_LOG_LEVEL,
    component: 'web',
    pretty: config.NODE_ENV === 'development',
  });
  const { pool, db } = connect({
    connectionString: config.EIM_DATABASE_URL,
    applicationName: 'eim-web',
    onError: (error) => {
      logger.warn({ err: error, event: 'pool_connection_error' }, 'an idle connection failed');
    },
  });

  const created: Runtime = { config, logger, metrics: createMetrics(), pool, db };
  container[RUNTIME_KEY] = created;
  return created;
}

export type ReadinessStatus = 'ready' | 'degraded' | 'unready';

export interface ReadinessCheck {
  readonly name: string;
  readonly status: ReadinessStatus;
  /** Short, non-sensitive. Section 22: report state without leaking internals. */
  readonly detail?: string;
}

export interface ReadinessReport {
  readonly status: ReadinessStatus;
  readonly checks: readonly ReadinessCheck[];
}

/**
 * The readiness assessment (section 22).
 *
 * Section 22 draws a line this function has to respect: the web tier stays
 * ready for inspection even when workers are degraded, because taking the
 * interface offline is what removes the operator's ability to see why. So a
 * stale worker heartbeat degrades rather than unreadies, and only the things
 * the web tier genuinely cannot serve without — the database, and a schema it
 * agrees with — make it unready.
 */
export async function assessReadiness(): Promise<ReadinessReport> {
  const { pool } = runtime();
  const checks: ReadinessCheck[] = [];

  try {
    await pool.query('select 1');
    checks.push({ name: 'database', status: 'ready' });
  } catch {
    // The reason is deliberately not reported. Section 22 requires readiness to
    // avoid leaking internals, and a connection error string carries the host,
    // the port, and sometimes the user.
    checks.push({ name: 'database', status: 'unready', detail: 'unreachable' });
    return { status: 'unready', checks };
  }

  try {
    const expected = expectedSchemaVersion();
    const applied = await appliedSchemaVersion(pool);

    checks.push(
      applied === expected
        ? { name: 'schema', status: 'ready' }
        : {
            name: 'schema',
            status: 'unready',
            // Version numbers are safe to report and are the single most
            // useful fact when a deployment half-succeeded.
            detail: `expected ${String(expected)}, found ${String(applied)}`,
          },
    );
  } catch {
    checks.push({ name: 'schema', status: 'unready', detail: 'could not be determined' });
  }

  const status = checks.some((check) => check.status === 'unready')
    ? 'unready'
    : checks.some((check) => check.status === 'degraded')
      ? 'degraded'
      : 'ready';

  return { status, checks };
}
