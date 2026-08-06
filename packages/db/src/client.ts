import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as audit from './schema/audit';
import * as background from './schema/background';
import * as connections from './schema/connections';
import * as identity from './schema/identity';
import * as inventory from './schema/inventory';
import * as tenancy from './schema/tenancy';

/**
 * Connection pooling and the typed database handle.
 *
 * One pool per process. Section 16 puts a dedicated LISTEN/NOTIFY connection
 * outside this pool, because a connection parked on LISTEN is not available for
 * queries and would otherwise be counted as if it were.
 */

/**
 * The connection pool type, re-exported.
 *
 * Callers need to name a pool without taking a direct dependency on the driver.
 * Funnelling it through here means swapping the driver is one package's problem
 * rather than every consumer's.
 */
export type DatabasePool = pg.Pool;

export const schema = {
  ...tenancy,
  ...inventory,
  ...background,
  ...identity,
  ...audit,
  ...connections,
};
export type Schema = typeof schema;
export type Database = NodePgDatabase<Schema>;

export interface PoolConfig {
  readonly connectionString: string;
  /**
   * Maximum connections held by this process.
   *
   * Kept small on purpose. PostgreSQL charges real memory per backend, and a
   * self-hosted installation is typically sharing a small machine with the
   * store it syncs. Web and worker processes each hold their own pool, so the
   * installation total is this number times the replica count plus the
   * dedicated listener connections.
   */
  readonly maxConnections?: number;
  /** Milliseconds an idle connection is kept before being closed. */
  readonly idleTimeoutMillis?: number;
  /**
   * How long to wait for a connection from the pool before failing.
   *
   * Bounded rather than infinite: a request that waits forever for a connection
   * holds its own resources and turns pool exhaustion into a total stall
   * instead of a visible error.
   */
  readonly connectionTimeoutMillis?: number;
  readonly applicationName?: string;
  /**
   * Called when an idle connection fails.
   *
   * Optional, but the pool always gets a handler: see `createPool`.
   */
  readonly onError?: (error: Error) => void;
}

export function createPool(config: PoolConfig): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.connectionString,
    max: config.maxConnections ?? 10,
    idleTimeoutMillis: config.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: config.connectionTimeoutMillis ?? 5_000,
    application_name: config.applicationName ?? 'eim',
    // Statements are never cancelled silently mid-transaction by the client;
    // timeouts are set per statement where a bound is meaningful.
    allowExitOnIdle: false,
  });

  // An idle connection that fails emits 'error' on the pool, and in Node an
  // unhandled 'error' event on an EventEmitter terminates the process. A
  // PostgreSQL restart, or a firewall reaping an idle connection, would
  // therefore take down a worker that was perfectly healthy and had nothing in
  // flight. The pool discards the broken connection and opens another by
  // itself; all this handler has to do is exist.
  pool.on('error', (error: Error) => {
    config.onError?.(error);
  });

  return pool;
}

export function createDatabase(pool: pg.Pool): Database {
  return drizzle(pool, { schema });
}

/** Convenience for a process that needs both and keeps them for its lifetime. */
export function connect(config: PoolConfig): { pool: pg.Pool; db: Database } {
  const pool = createPool(config);
  return { pool, db: createDatabase(pool) };
}
