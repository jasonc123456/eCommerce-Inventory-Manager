/**
 * Reading a constraint violation back out of a driver error.
 *
 * Section 17 puts correctness in the database and treats application validation
 * as a way to produce a better message, never as the thing preventing the bad
 * write. That only works if the service can tell *which* constraint refused it,
 * so a caller receives "that code is already in use" rather than a stack trace.
 *
 * The cause chain is walked because the driver's error frequently arrives
 * wrapped by the query builder.
 */

const MAX_CAUSE_DEPTH = 5;

export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return hasPostgresCode(error, '23505', constraint);
}

export function isCheckViolation(error: unknown, constraint: string): boolean {
  return hasPostgresCode(error, '23514', constraint);
}

function hasPostgresCode(error: unknown, code: string, constraint: string): boolean {
  for (let current: unknown = error, depth = 0; depth < MAX_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error)) {
      break;
    }

    const candidate = current as Error & { code?: unknown; constraint?: unknown };

    if (candidate.code === code && String(candidate.constraint) === constraint) {
      return true;
    }

    current = candidate.cause;
  }

  return false;
}
