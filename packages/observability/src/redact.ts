import { ALLOWED_LOG_FIELDS, ERROR_FIELD, isLoggableScalar } from './fields';

/**
 * The redaction pass applied to every log line, at every level (section 22).
 *
 * This runs as pino's `formatters.log` hook, which sees the fully merged object
 * for a line: the logger's bindings, the caller's object, and anything a child
 * logger contributed. Filtering here rather than at each call site means a
 * forgotten call site is safe by default instead of unsafe by default.
 */

/** Properties of an Error worth keeping. Everything else is dropped. */
export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string | number;
}

/**
 * Reduces an error to three known-safe properties.
 *
 * Provider SDKs routinely hang the whole HTTP exchange off a thrown error, so
 * `error.response.request.headers.authorization` is a real path to a real
 * bearer token. Copying named properties rather than deleting known-bad ones is
 * what makes that structurally impossible instead of merely unlikely.
 *
 * The message is kept because an error with no message is not worth logging.
 * That places a real obligation on the code that throws: an error message must
 * never be built by interpolating a secret, a customer name, or a raw provider
 * body. Section 19 states that obligation; this function cannot enforce it.
 *
 * The function is idempotent, and has to be. pino runs its `serializers` before
 * `formatters.log`, so by the time the allowlist sees the `err` field the error
 * has already been through here once and is a plain object. Treating that
 * second pass as "a non-Error was thrown" would replace a genuine diagnosis
 * with a message about the logging pipeline, which is the failure mode this
 * shape check exists to prevent. It also means an error pre-serialized by
 * pino's own `stdSerializers.err`, which spells the name `type` and copies
 * every extra property, still comes out filtered.
 */
export function serializeError(value: unknown): SerializedError {
  if (value instanceof Error) {
    return pick(value.name, value.message, value.stack, (value as { code?: unknown }).code);
  }

  if (typeof value === 'object' && value !== null) {
    const candidate = value as {
      name?: unknown;
      type?: unknown;
      message?: unknown;
      stack?: unknown;
      code?: unknown;
    };

    if (typeof candidate.message === 'string') {
      const name = typeof candidate.name === 'string' ? candidate.name : candidate.type;
      return pick(
        typeof name === 'string' ? name : 'Error',
        candidate.message,
        candidate.stack,
        candidate.code,
      );
    }
  }

  return { name: 'NonError', message: `a non-Error value of type ${typeof value} was thrown` };
}

function pick(name: string, message: string, stack: unknown, code: unknown): SerializedError {
  return {
    name,
    message,
    ...(typeof stack === 'string' ? { stack } : {}),
    ...(typeof code === 'string' || typeof code === 'number' ? { code } : {}),
  };
}

/**
 * Applies the allowlist to one merged log object.
 *
 * Dropped keys are reported by name in `unloggedFields` rather than vanishing.
 * The names are written by developers, not by users or providers, so listing
 * them leaks nothing, and it turns a silently swallowed field into something
 * visible the first time anyone reads the output.
 */
export function applyFieldAllowlist(input: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const dropped: string[] = [];

  for (const [key, value] of Object.entries(input)) {
    if (key === ERROR_FIELD) {
      output[key] = serializeError(value);
      continue;
    }

    if (!ALLOWED_LOG_FIELDS.has(key)) {
      dropped.push(key);
      continue;
    }

    if (!isLoggableScalar(value)) {
      dropped.push(key);
      continue;
    }

    output[key] = value;
  }

  if (dropped.length > 0) {
    output['unloggedFields'] = dropped.sort();
  }

  return output;
}
