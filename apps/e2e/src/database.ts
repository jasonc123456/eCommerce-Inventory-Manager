import { migrate } from '@eim/db';
import { Pool } from 'pg';

import { environment } from './environment';

/**
 * The database the browser tier is allowed to empty.
 *
 * Section 25 forbids a fallback to an in-memory database, and the browser tier
 * has no reason to want one: it drives the real application, which talks to a
 * real PostgreSQL. What it does need is a database that starts empty, because
 * the first thing it proves is that a clean install can be claimed and used —
 * and that only means something on an installation nobody has claimed.
 *
 * The reset drops the schema rather than truncating tables. Truncation would
 * leave the previous run's schema in place, so a migration that was added,
 * applied, and then edited would go unnoticed here exactly as it would in a
 * deployment that never started from nothing.
 */

/**
 * Refuses to run against anything but the disposable stack.
 *
 * `docker-compose.e2e.yml` is the only place `EIM_E2E_BASE_URL` is set, and
 * reading it is what makes this module unable to run outside that stack. It is
 * checked before the connection is opened rather than after, because the point
 * is to never have a connection to the wrong database in the first place.
 */
function assertDisposable(): void {
  const url = new URL(environment.databaseUrl);
  const allowedHosts = new Set(['postgres', 'localhost', '127.0.0.1']);

  if (!allowedHosts.has(url.hostname)) {
    throw new Error(
      `the browser tier refuses to reset ${url.hostname}: it only runs against the disposable ` +
        'database in docker-compose.e2e.yml',
    );
  }
}

export async function resetAndMigrate(): Promise<number> {
  assertDisposable();

  const pool = new Pool({ connectionString: environment.databaseUrl });

  try {
    await pool.query('drop schema if exists public cascade');
    await pool.query('create schema public');

    const result = await migrate(pool);

    return result.schemaVersion;
  } finally {
    await pool.end();
  }
}
