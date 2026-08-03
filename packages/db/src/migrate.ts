import type { Pool, PoolClient } from 'pg';

import { MigrationError, loadMigrations, type MigrationFile } from './migrations';
import { EXPECTED_SCHEMA_VERSION } from './schema-version';

/**
 * The migration runner (section 17, section 23).
 *
 * Section 23 runs this as a one-shot deployment task that completes before any
 * web or worker container starts. Three properties make that safe:
 *
 *   1. A session advisory lock serializes runners, so two containers starting
 *      at once cannot both apply migration 7.
 *   2. Each migration and its bookkeeping row commit together, so a crash
 *      mid-run leaves the schema and the history agreeing with each other.
 *   3. Checksums are verified before anything runs. A migration edited after it
 *      was applied means the schema in front of you is not the schema the file
 *      describes, and continuing would compound that.
 */

/**
 * Arbitrary but fixed. Any process taking this lock is a migration runner for
 * this application; the number itself has no meaning beyond not colliding with
 * another advisory lock in the same database.
 */
const MIGRATION_LOCK_KEY = 4_820_197;

export interface MigrationRecord {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: Date;
}

export interface MigrateResult {
  readonly applied: readonly MigrationFile[];
  readonly alreadyApplied: readonly number[];
  readonly schemaVersion: number;
}

export interface MigrateOptions {
  readonly directory?: string;
  /** Called after each migration commits, for progress output. */
  readonly onApplied?: (migration: MigrationFile) => void;
}

const BOOKKEEPING_TABLE_SQL = `
  create table if not exists eim_schema_migrations (
    version     integer     primary key,
    name        text        not null,
    checksum    text        not null,
    applied_at  timestamptz not null default now(),
    -- How long it took, kept because a migration that was slow on production
    -- data is the one worth knowing about before running the next one.
    duration_ms integer     not null
  )
`;

/**
 * Applies every migration not yet recorded.
 *
 * Safe to call on every deployment, including when there is nothing to do.
 */
export async function migrate(pool: Pool, options: MigrateOptions = {}): Promise<MigrateResult> {
  const migrations = loadMigrations(options.directory);
  const client = await pool.connect();

  try {
    await client.query(BOOKKEEPING_TABLE_SQL);
    await client.query('select pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);

    try {
      // Re-read inside the lock. Another runner may have applied everything
      // while this one was waiting, which is the ordinary case when several
      // containers start together.
      const recorded = await readAppliedMigrations(client);
      assertHistoryMatches(migrations, recorded);

      const applied: MigrationFile[] = [];
      const alreadyApplied: number[] = [];

      for (const migration of migrations) {
        if (recorded.has(migration.version)) {
          alreadyApplied.push(migration.version);
          continue;
        }

        await applyOne(client, migration);
        applied.push(migration);
        options.onApplied?.(migration);
      }

      return {
        applied,
        alreadyApplied,
        schemaVersion: migrations[migrations.length - 1]?.version ?? 0,
      };
    } finally {
      await client.query('select pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    client.release();
  }
}

async function applyOne(client: PoolClient, migration: MigrationFile): Promise<void> {
  const startedAt = Date.now();

  await client.query('begin');
  try {
    await client.query(migration.sql);
    await client.query(
      `insert into eim_schema_migrations (version, name, checksum, duration_ms)
       values ($1, $2, $3, $4)`,
      [migration.version, migration.name, migration.checksum, Date.now() - startedAt],
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw new MigrationError(
      `migration ${migration.name} failed: ${error instanceof Error ? error.message : 'unknown error'}`,
    );
  }
}

/** The applied migration history, oldest first. */
export async function readAppliedMigrations(
  client: Pick<PoolClient, 'query'>,
): Promise<Map<number, MigrationRecord>> {
  const result = await client.query<{
    version: number;
    name: string;
    checksum: string;
    applied_at: Date;
  }>('select version, name, checksum, applied_at from eim_schema_migrations order by version');

  return new Map(
    result.rows.map((row) => [
      row.version,
      { version: row.version, name: row.name, checksum: row.checksum, appliedAt: row.applied_at },
    ]),
  );
}

/**
 * Refuses to continue when the files on disk disagree with what was applied.
 *
 * Two cases, both fatal and both worth distinguishing in the message. A changed
 * checksum means somebody edited an applied migration, so the live schema is
 * not what the file now claims. A missing file means the database is ahead of
 * the code, which is what a rollback to an older image looks like, and running
 * an older application against a newer schema is exactly the situation section
 * 17's expand/contract discipline exists to make survivable, not to hide.
 */
function assertHistoryMatches(
  migrations: readonly MigrationFile[],
  recorded: ReadonlyMap<number, MigrationRecord>,
): void {
  const onDisk = new Map(migrations.map((migration) => [migration.version, migration]));

  for (const [version, record] of recorded) {
    const migration = onDisk.get(version);

    if (migration === undefined) {
      throw new MigrationError(
        `the database has migration ${record.name} applied but it is not present in this build; ` +
          'this deployment is older than the database schema',
      );
    }

    if (migration.checksum !== record.checksum) {
      throw new MigrationError(
        `migration ${migration.name} has changed since it was applied on ` +
          `${record.appliedAt.toISOString()}; applied migrations are immutable, so correct it ` +
          'with a new forward migration instead',
      );
    }
  }
}

/**
 * The highest applied version, or 0 on a database that has never been migrated.
 *
 * Section 22's readiness check compares this against the version the running
 * build expects, so a container started against a database that has not been
 * migrated reports unready rather than serving with a schema it disagrees with.
 */
export async function appliedSchemaVersion(pool: Pool): Promise<number> {
  // The existence check has to be a separate statement. PostgreSQL resolves
  // table names when it plans a query, so a guard inside the WHERE clause of a
  // select against a missing table still raises "relation does not exist".
  const exists = await pool.query<{ present: string | null }>(
    "select to_regclass('public.eim_schema_migrations')::text as present",
  );

  if (exists.rows[0]?.present == null) {
    return 0;
  }

  const result = await pool.query<{ version: number | null }>(
    'select max(version) as version from eim_schema_migrations',
  );

  return result.rows[0]?.version ?? 0;
}

/**
 * The schema version this build expects.
 *
 * Returns the checked-in constant rather than reading the migrations directory,
 * so it works identically in a bundled web server, a bundled worker, and a
 * source checkout. See `schema-version.ts` for why that distinction matters.
 */
export function expectedSchemaVersion(): number {
  return EXPECTED_SCHEMA_VERSION;
}
