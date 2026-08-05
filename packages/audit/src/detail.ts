/**
 * Sanitation for the `detail` document on an audit event (section 19).
 *
 * Audit records carry "safe before/after summaries without secret values". The
 * difficulty is that `detail` is deliberately open-ended — every action shapes it
 * differently — so there is no schema to validate against, and the writer is a
 * developer who is thinking about the action rather than about what a token
 * looks like.
 *
 * This pass therefore fails closed on names. A field whose name suggests a
 * secret is replaced rather than dropped, so the record still shows that the
 * action involved one; a dropped field would read as though it never existed.
 *
 * It cannot catch a secret stored under an innocent name, and does not pretend
 * to. What it removes is the accident: `{ token }` spread into a summary,
 * an error object carrying a header, a whole request body passed in for context.
 * A row here is permanent, which is what makes even an unlikely leak expensive.
 */

export type AuditDetail = Record<string, JsonValue>;

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** What a redacted field is replaced with. Recognisable, and never a value. */
export const REDACTED = '[redacted]';

/**
 * Name fragments that mark a field as unfit for the trail.
 *
 * Matched against the key with separators removed, so `recovery_code`,
 * `recoveryCode`, and `RecoveryCode` all match `recoverycode`. Phrases rather
 * than single words on purpose: a bare `code` would redact `locationCode` and
 * `currencyCode`, which are exactly the kind of context an audit entry needs.
 */
const SECRET_NAME_FRAGMENTS = [
  'token',
  'secret',
  'password',
  'passphrase',
  'seed',
  'keyring',
  'privatekey',
  'apikey',
  'challenge',
  'cookie',
  'authorization',
  'credential',
  'recoverycode',
  'emailcode',
  'otp',
  'hash',
  'signature',
] as const;

/**
 * Bounds. An audit row is written on a request path and read years later, so it
 * must not be able to become large enough to matter in either direction.
 */
const MAX_DEPTH = 4;
const MAX_STRING_LENGTH = 512;
const MAX_ENTRIES = 50;

export function isSecretFieldName(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');

  return SECRET_NAME_FRAGMENTS.some((fragment) => normalized.includes(fragment));
}

/**
 * Reduces an arbitrary value to something safe and bounded.
 *
 * Anything that is not JSON — a function, a symbol, a class instance, undefined
 * — is described by its type rather than serialized. Serializing it is how a
 * whole provider response object ends up in a permanent row.
 */
export function sanitizeDetail(input: Record<string, unknown>): AuditDetail {
  const sanitized = sanitizeValue(input, 0);

  // `sanitizeValue` on a plain object always returns an object, but the type
  // system does not know that, and a caller passing something exotic should get
  // an empty document rather than a crash on a path that is recording evidence.
  return typeof sanitized === 'object' && sanitized !== null && !Array.isArray(sanitized)
    ? sanitized
    : {};
}

function sanitizeValue(value: unknown, depth: number): JsonValue {
  if (depth > MAX_DEPTH) {
    return '[too deep]';
  }

  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case 'string':
      return truncate(value);

    case 'number':
      // NaN and Infinity are not JSON, and PostgreSQL rejects them in jsonb.
      return Number.isFinite(value) ? value : `[${String(value)}]`;

    case 'boolean':
      return value;

    case 'bigint':
      return value.toString();

    case 'undefined':
      return null;

    case 'symbol':
    case 'function':
      return `[${typeof value}]`;

    case 'object':
      break;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ENTRIES).map((item) => sanitizeValue(item, depth + 1));

    if (value.length > MAX_ENTRIES) {
      items.push(`[${String(value.length - MAX_ENTRIES)} more]`);
    }

    return items;
  }

  const source = value as Record<string, unknown>;
  const output: Record<string, JsonValue> = {};
  let count = 0;

  for (const [key, entry] of Object.entries(source)) {
    if (count >= MAX_ENTRIES) {
      output['truncated'] = true;
      break;
    }

    output[key] = isSecretFieldName(key) ? REDACTED : sanitizeValue(entry, depth + 1);
    count += 1;
  }

  return output;
}

function truncate(value: string): string {
  return value.length <= MAX_STRING_LENGTH
    ? value
    : `${value.slice(0, MAX_STRING_LENGTH)}… [${String(value.length - MAX_STRING_LENGTH)} more characters]`;
}
