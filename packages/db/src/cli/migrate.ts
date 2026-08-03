import { loadConfig } from '@eim/config';
import { createLogger } from '@eim/observability';

import { createPool } from '../client';
import { migrate } from '../migrate';

/**
 * The one-shot migration task (section 23).
 *
 * Compose runs this to completion before the web and worker services start, so
 * no application process ever serves against a schema it has not been built
 * for. It exits non-zero on any failure, which is what makes the dependency
 * meaningful: a failed migration must stop the deployment, not be logged and
 * stepped over.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({
    level: config.EIM_LOG_LEVEL,
    component: 'migrate',
    pretty: config.NODE_ENV === 'development',
  });

  const pool = createPool({
    connectionString: config.EIM_DATABASE_URL,
    applicationName: 'eim-migrate',
    // One connection. This process does nothing concurrently, and the advisory
    // lock serializes it against any other runner anyway.
    maxConnections: 1,
  });

  try {
    const result = await migrate(pool, {
      onApplied: (migration) => {
        logger.info(
          { event: 'migration_applied', schemaVersion: migration.version },
          migration.name,
        );
      },
    });

    logger.info(
      {
        event: 'migrations_complete',
        schemaVersion: result.schemaVersion,
        count: result.applied.length,
      },
      result.applied.length === 0
        ? 'schema already up to date'
        : `applied ${String(result.applied.length)} migration(s)`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  // The logger may not exist yet if configuration itself failed, so this path
  // deliberately uses stderr directly rather than assuming it does.
  console.error(error instanceof Error ? error.message : 'migration failed');
  process.exitCode = 1;
});
