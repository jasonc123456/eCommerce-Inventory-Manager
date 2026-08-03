import { pino, type Logger as PinoLogger, type LoggerOptions } from 'pino';

import { currentContext } from './context';
import { applyFieldAllowlist, serializeError } from './redact';

/**
 * The application logger (section 22).
 *
 * Structured JSON on stdout, five levels, and a redaction policy that does not
 * change with the level. The container runtime owns rotation and shipping; the
 * process just writes lines.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';

export interface LoggerConfig {
  readonly level: LogLevel;
  /** Which process this is. Appears on every line as `component`. */
  readonly component: string;
  /**
   * Human-readable output for a terminal. Development only, and it changes the
   * rendering rather than the redaction: the allowlist has already run by the
   * time pino-pretty sees anything.
   */
  readonly pretty?: boolean;
  readonly appVersion?: string;
}

/**
 * pino's own logger type.
 *
 * Not parameterized: pino's first type argument declares *custom* levels, and
 * trace through error are all built in. Passing them there tells pino they are
 * additions to the standard set and produces a logger typed as having no
 * standard levels at all.
 */
export type Logger = PinoLogger;

/**
 * Builds the pino options.
 *
 * The interesting part is the two hooks. `mixin` merges the ambient correlation
 * context into every line, so a log call deep inside a job never has to be
 * given the identifiers by hand. `formatters.log` then applies the allowlist to
 * the merged result, which is the last point at which every field for a line is
 * visible in one object.
 *
 * Order matters: the mixin runs first and the allowlist runs over its output,
 * so ambient fields are filtered on exactly the same terms as explicit ones.
 */
export function loggerOptions(config: LoggerConfig): LoggerOptions {
  return {
    level: config.level,
    // Section 22 wants the level as a word. The default is a number, which
    // means every log query has to carry a lookup table.
    formatters: {
      level: (label) => ({ level: label }),
      log: applyFieldAllowlist,
    },
    // pino's own error serializer keeps the whole error object graph, which is
    // where provider tokens hide. This one keeps three properties.
    serializers: { err: serializeError },
    base: {
      component: config.component,
      ...(config.appVersion === undefined ? {} : { appVersion: config.appVersion }),
    },
    mixin: () => ({ ...currentContext() }),
    timestamp: pino.stdTimeFunctions.isoTime,
  };
}

/**
 * Creates the root logger for a process.
 *
 * Every other logger in the process should be a child of this one, so the
 * redaction policy cannot be bypassed by constructing a second pino instance
 * with different options.
 */
export function createLogger(config: LoggerConfig): Logger {
  const options = loggerOptions(config);

  if (config.pretty === true) {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        // `sync` matters more than it looks. This transport runs in a worker
        // thread, so a short-lived process can reach the end of its work with
        // formatted lines still queued in the worker. Writing synchronously
        // means anything already logged has reached the terminal by the time
        // the caller decides to exit.
        options: {
          colorize: true,
          translateTime: 'HH:MM:ss.l',
          ignore: 'pid,hostname',
          sync: true,
        },
      },
    });
  }

  return pino(options);
}

/**
 * A child logger for a subsystem.
 *
 * Bindings are filtered here rather than relying on `formatters.log`. pino
 * serializes child bindings once, at child-creation time, into a cached string
 * fragment it concatenates onto every subsequent line; that fragment never
 * passes through the log formatter again. A binding is therefore the one way a
 * value could reach the output unexamined, so the allowlist is applied to it
 * directly.
 */
export function childLogger(parent: Logger, bindings: Readonly<Record<string, unknown>>): Logger {
  return parent.child(applyFieldAllowlist({ ...bindings }));
}
