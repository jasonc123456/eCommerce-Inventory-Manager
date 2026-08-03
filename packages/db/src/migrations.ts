import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Discovery and integrity checking of the forward migration files (section 17).
 *
 * Migrations are hand-written SQL, numbered, and forward-only. Section 17 rules
 * out depending on destructive automatic down-migrations, so there is no
 * matching `down` file to get out of sync: recovery from a bad migration is a
 * new forward migration, or a restore.
 */

export interface MigrationFile {
  /** Ordering key, taken from the filename prefix. */
  readonly version: number;
  /** Full filename, recorded so the applied history is readable. */
  readonly name: string;
  readonly sql: string;
  /** SHA-256 of the file contents, used to detect an edit after application. */
  readonly checksum: string;
}

export class MigrationError extends Error {
  public override readonly name = 'MigrationError';
}

const FILENAME_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

/** The directory shipped with this package. */
export function defaultMigrationsDirectory(): string {
  // Resolved relative to this module rather than the process working directory,
  // so the worker, the web tier, and a test all find the same files regardless
  // of where they were started from.
  return join(fileURLToPath(new URL('.', import.meta.url)), '..', 'migrations');
}

/**
 * Reads and validates the migration set.
 *
 * Rejects duplicate version numbers and unrecognized filenames rather than
 * skipping them. A file that silently does not run is worse than a failed
 * deployment, because the schema mismatch surfaces later and somewhere else.
 */
export function loadMigrations(directory = defaultMigrationsDirectory()): MigrationFile[] {
  const entries = readdirSync(directory)
    .filter((entry) => entry.endsWith('.sql'))
    .sort();
  const migrations: MigrationFile[] = [];
  const seen = new Map<number, string>();

  for (const entry of entries) {
    const match = FILENAME_PATTERN.exec(entry);
    if (match === null) {
      throw new MigrationError(
        `migration filename ${entry} must look like 0001_short_description.sql`,
      );
    }

    const version = Number.parseInt(match[1] ?? '', 10);
    const existing = seen.get(version);
    if (existing !== undefined) {
      throw new MigrationError(
        `migrations ${existing} and ${entry} share version ${String(version)}`,
      );
    }
    seen.set(version, entry);

    const sql = readFileSync(join(directory, entry), 'utf8');
    migrations.push({ version, name: entry, sql, checksum: checksumOf(sql) });
  }

  if (migrations.length === 0) {
    throw new MigrationError(`no migration files found in ${directory}`);
  }

  return migrations;
}

export function checksumOf(sql: string): string {
  // Line endings are normalized so a checkout on a machine with different Git
  // settings does not read as a tampered migration.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
}
