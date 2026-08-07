/**
 * The schema version this build expects.
 *
 * A constant rather than a count of the files in `migrations/`, because the web
 * tier is bundled by Next.js: `import.meta.url` inside the bundle points into
 * `.next/`, the migrations directory is not there, and a readiness check that
 * reads it reports "could not be determined" on every request in production
 * while passing every test that runs from source. The failure is silent in
 * exactly the environment that matters.
 *
 * Keeping it honest is a test, not a convention. `schema-version.test.ts`
 * compares this against the actual migration files and fails if they disagree,
 * so adding a migration without updating this number breaks the build rather
 * than shipping a readiness check that lies.
 *
 * Bump this in the same commit as the migration it accompanies.
 */
export const EXPECTED_SCHEMA_VERSION = 8;
