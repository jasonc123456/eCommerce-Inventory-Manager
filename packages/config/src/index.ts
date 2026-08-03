export { configSchema, type ConfigKey, type InstallationConfig } from './schema';

export {
  FIELD_METADATA,
  FIELD_ORDER,
  SECRET_KEYS,
  type FieldMeta,
  type Sensitivity,
} from './fields';

export { ConfigurationError, loadConfig, type LoadOptions } from './load';

export {
  assertEnvFilePermissions,
  checkEnvFilePermissions,
  type EnvFileCheckOptions,
  type EnvFileVerdict,
} from './env-file';

export { renderEnvExample } from './env-example';
