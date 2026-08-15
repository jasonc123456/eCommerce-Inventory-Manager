import { resetAndMigrate } from '../database';

/**
 * Empties and migrates the browser tier's database.
 *
 * A separate command rather than a Playwright global setup, because the
 * application server is started by Playwright and the reset has to happen
 * before it, not alongside it. Making the ordering a line in `scripts/e2e.sh`
 * puts it somewhere a reader can see it.
 */
const version = await resetAndMigrate();

console.warn(`browser tier database reset and migrated to schema ${String(version)}`);
