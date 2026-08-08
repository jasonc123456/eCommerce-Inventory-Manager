export {
  connect,
  createDatabase,
  createPool,
  schema,
  type Database,
  type DatabasePool,
  type PoolConfig,
  type Schema,
} from './client';

export {
  appliedSchemaVersion,
  expectedSchemaVersion,
  migrate,
  readAppliedMigrations,
  type MigrateOptions,
  type MigrateResult,
  type MigrationRecord,
} from './migrate';

export {
  MigrationError,
  checksumOf,
  defaultMigrationsDirectory,
  loadMigrations,
  type MigrationFile,
} from './migrations';

export { EXPECTED_SCHEMA_VERSION } from './schema-version';

export {
  acquireSchedulerLease,
  pruneHeartbeats,
  readSchedulerLease,
  recordHeartbeat,
  releaseSchedulerLease,
  renewSchedulerLease,
  type LeaseHolder,
  type LeaseState,
} from './leases';

export * from './schema/tenancy';
export * from './schema/inventory';
export * from './schema/background';
export * from './schema/identity';
export * from './schema/audit';
export * from './schema/connections';
export * from './schema/provider-mirror';
export * from './schema/mappings';
export * from './schema/kits';
export * from './schema/reservations';
export * from './schema/jobs';
export * from './schema/sync';
export * from './schema/orders';
export * from './schema/restocks';
