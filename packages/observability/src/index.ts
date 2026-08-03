export { ALLOWED_LOG_FIELDS, ERROR_FIELD, isLoggableScalar } from './fields';

export { applyFieldAllowlist, serializeError, type SerializedError } from './redact';

export { currentContext, newCorrelationId, withContext, type CorrelationContext } from './context';

export {
  childLogger,
  createLogger,
  loggerOptions,
  type Logger,
  type LoggerConfig,
  type LogLevel,
} from './logger';

export {
  createMetrics,
  observeDuration,
  type EimMetrics,
  type MetricsOptions,
  type Outcome,
} from './metrics';
