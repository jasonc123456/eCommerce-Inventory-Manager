import { describe, expect, it } from 'vitest';

import { loadMigrations } from './migrations';
import { EXPECTED_SCHEMA_VERSION } from './schema-version';

/**
 * Keeps the constant honest.
 *
 * The constant exists because the web bundle cannot read the migrations
 * directory at runtime. That trade only holds if the number is right, and the
 * only way to guarantee it is to check it here, where the files are readable.
 */
describe('EXPECTED_SCHEMA_VERSION', () => {
  it('matches the highest migration on disk', () => {
    const migrations = loadMigrations();
    const highest = migrations[migrations.length - 1]?.version;

    expect(EXPECTED_SCHEMA_VERSION).toBe(highest);
  });

  it('accounts for every migration, with no gaps in the sequence', () => {
    // A gap means a migration was deleted after being written. Numbering is how
    // the runner orders and records work, so a hole in it is a hole in the
    // applied history of every installation that already ran the missing file.
    const versions = loadMigrations().map((migration) => migration.version);

    expect(versions).toEqual(Array.from({ length: versions.length }, (_, index) => index + 1));
  });
});
