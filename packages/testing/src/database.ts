import { createHash, randomBytes } from 'node:crypto';

import { createDatabase, createPool, loadMigrations, migrate, type Database } from '@eim/db';
import type pg from 'pg';

/**
 * A real PostgreSQL 18 for integration tests (section 25).
 *
 * Section 25 requires that integration tests run against the real engine. A
 * suite that falls back to an in-memory fake when the database is missing
 * proves nothing about the things this schema relies on — composite foreign
 * keys, deferred constraint triggers, partial unique indexes, `SKIP LOCKED` —
 * so this harness fails loudly rather than degrading.
 *
 * Each test file gets its own database, created from a template that already
 * has the migrations applied. Creating from a template is a file copy inside
 * the server, which is fast enough to afford per-file isolation; re-running the
 * migrations for every file would not be. Isolation matters more than it might
 * appear: several of these tests deliberately violate constraints, and a shared
 * database would leave the next test reasoning about the wreckage.
 *
 * The connection target is the PostgreSQL already running in the development
 * stack, not a container this process starts. See docs/adr/0007 for why.
 */

/**
 * Advisory lock guarding template creation. Two test files racing to build the
 * template would both see it missing and both try to create it.
 */
const TEMPLATE_LOCK_KEY = 4_820_198;

/**
 * The template name, derived from the migrations it was built from.
 *
 * Keying the name by content is what makes the cache correct rather than merely
 * fast. A fixed name would survive a migration edit, and every later test run
 * would copy a schema that no longer matches the repository — passing tests
 * against code that would fail on a fresh database, which is the worst possible
 * outcome for a test harness. Changing any migration changes the hash, so the
 * next run finds no template and builds one.
 */
function templateDatabaseName(): string {
  const digest = createHash('sha256')
    .update(
      loadMigrations()
        .map((migration) => migration.checksum)
        .join(':'),
    )
    .digest('hex')
    .slice(0, 12);

  return `eim_test_tpl_${digest}`;
}

export interface TestDatabase {
  readonly db: Database;
  readonly pool: pg.Pool;
  readonly name: string;
  /** Drops the database. Always call it, even when a test failed. */
  readonly drop: () => Promise<void>;
}

/**
 * The maintenance connection string.
 *
 * Points at a database that is not the one under test, because `create
 * database` and `drop database` cannot run from inside their own target.
 */
function maintenanceUrl(): string {
  const url = process.env['EIM_TEST_DATABASE_URL'];

  if (url === undefined || url.length === 0) {
    throw new Error(
      'EIM_TEST_DATABASE_URL is not set. Integration tests need a real PostgreSQL 18; ' +
        'start the development stack and run them through scripts/dev.sh.',
    );
  }

  return url;
}

function withDatabaseName(url: string, databaseName: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${databaseName}`;
  return parsed.toString();
}

function maintenanceConnection(): pg.Pool {
  return createPool({
    connectionString: maintenanceUrl(),
    applicationName: 'eim-test-harness',
    maxConnections: 2,
  });
}

/**
 * Builds the template database if it is missing, then returns.
 *
 * Idempotent and safe to call concurrently. The advisory lock is taken on the
 * maintenance database, so it serializes callers without needing the template
 * to exist first.
 */
async function ensureTemplate(maintenance: pg.Pool, template: string): Promise<void> {
  const client = await maintenance.connect();

  try {
    await client.query('select pg_advisory_lock($1)', [TEMPLATE_LOCK_KEY]);

    try {
      const existing = await client.query<{ count: string }>(
        'select count(*)::text as count from pg_database where datname = $1',
        [template],
      );

      if (existing.rows[0]?.count !== '0') {
        return;
      }

      // Built under a scratch name and renamed on success, so a migration that
      // fails halfway cannot leave a half-migrated template in place for every
      // later run to copy.
      const scratch = `${template}_building`;
      await client.query(`drop database if exists ${quoteIdentifier(scratch)} with (force)`);
      await client.query(`create database ${quoteIdentifier(scratch)}`);

      const scratchPool = createPool({
        connectionString: withDatabaseName(maintenanceUrl(), scratch),
        applicationName: 'eim-test-template',
        maxConnections: 1,
      });

      try {
        await migrate(scratchPool);
      } finally {
        await scratchPool.end();
      }

      await client.query(
        `alter database ${quoteIdentifier(scratch)} rename to ${quoteIdentifier(template)}`,
      );

      // Older templates are from superseded migrations and will never be used
      // again. Left alone they accumulate one database per schema change.
      await dropStaleTemplates(client, template);
    } finally {
      await client.query('select pg_advisory_unlock($1)', [TEMPLATE_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function dropStaleTemplates(client: pg.PoolClient, keep: string): Promise<void> {
  const stale = await client.query<{ datname: string }>(
    "select datname from pg_database where datname like 'eim_test_tpl_%' and datname <> $1",
    [keep],
  );

  for (const row of stale.rows) {
    await client.query(`drop database if exists ${quoteIdentifier(row.datname)} with (force)`);
  }
}

/**
 * Creates a migrated database for one test file.
 *
 * The caller owns teardown. `afterAll(() => handle.drop())` is the intended
 * shape; a leaked database is harmless but accumulates.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const maintenance = maintenanceConnection();

  try {
    const template = templateDatabaseName();
    await ensureTemplate(maintenance, template);

    const name = `eim_test_${randomBytes(6).toString('hex')}`;
    await maintenance.query(
      `create database ${quoteIdentifier(name)} template ${quoteIdentifier(template)}`,
    );

    const pool = createPool({
      connectionString: withDatabaseName(maintenanceUrl(), name),
      applicationName: `eim-test-${name}`,
      maxConnections: 5,
    });

    return {
      db: createDatabase(pool),
      pool,
      name,
      drop: async () => {
        await pool.end();
        const cleanup = maintenanceConnection();
        try {
          // WITH (FORCE) terminates any connection the test forgot to close,
          // which would otherwise make the drop hang until the pool timed out.
          await cleanup.query(`drop database if exists ${quoteIdentifier(name)} with (force)`);
        } finally {
          await cleanup.end();
        }
      },
    };
  } finally {
    await maintenance.end();
  }
}

/**
 * Quotes an identifier for interpolation.
 *
 * `create database` and `drop database` cannot take a parameter, so the name
 * has to be interpolated. Every name reaching here is generated by this module
 * from hex bytes or is a constant, and the quoting is belt and braces.
 */
function quoteIdentifier(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) {
    throw new Error(`refusing to use ${name} as a database identifier`);
  }
  return `"${name}"`;
}

/**
 * Drops every cached template.
 *
 * Routine use should not need this: the template name is derived from the
 * migration checksums, so a schema change invalidates the cache by itself. It
 * exists for the case where the template is suspected of being wrong for a
 * reason the checksum cannot see, such as a PostgreSQL version change under the
 * same data directory.
 */
export async function dropTestTemplates(): Promise<void> {
  const maintenance = maintenanceConnection();
  const client = await maintenance.connect();
  try {
    await dropStaleTemplates(client, '');
  } finally {
    client.release();
    await maintenance.end();
  }
}
