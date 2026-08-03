/**
 * The structured-log field allowlist (section 22).
 *
 * Section 22 requires that sensitive values never reach a log at any level, and
 * that enabling debug or trace changes the amount of detail rather than the
 * redaction policy. A denylist cannot deliver that: it protects only the field
 * names somebody remembered, and the first provider error object attached to a
 * log line brings an access token with it under a name nobody predicted.
 *
 * So the policy is inverted. Only the names below may appear in a log line, and
 * everything else is dropped and reported by name in `unloggedFields`. Adding a
 * field is a deliberate edit to this list, which is where the question "could
 * this ever hold a token, an email address, or a customer's name?" gets asked.
 *
 * Two rules keep the list honest:
 *
 *   1. Identifiers only, never the things they identify. `businessId` is here;
 *      `businessName` is not. An opaque identifier is meaningless to anyone who
 *      steals the logs and sufficient for anyone diagnosing an incident.
 *   2. Allowlisted keys carry scalars. An object under an allowlisted key is
 *      dropped, because the allowlist says nothing about what is inside it.
 *      `err` is the sole exception and goes through a serializer that keeps
 *      three known-safe properties.
 */

/**
 * Correlation identifiers, which are what actually make an incident traceable
 * across the webhook, ledger, outbox, job, and audit evidence (section 22).
 */
const CORRELATION_FIELDS = ['correlationId', 'requestId', 'traceId', 'spanId'] as const;

/**
 * Scope identifiers. Opaque primary keys, never the names or addresses behind
 * them. `userId` identifies an account without revealing who holds it.
 */
const SCOPE_FIELDS = [
  'installationId',
  'businessId',
  'userId',
  'actorId',
  'connectionId',
  'locationId',
  'mappingId',
  'canonicalItemId',
  'componentItemId',
  'listingId',
  'offerId',
  'orderId',
  'lineItemId',
  'outboxId',
  'webhookId',
  'jobId',
  'alertId',
  'notificationId',
  'reconciliationId',
  'conflictId',
] as const;

/**
 * Operational facts about the work itself. Every one of these is either a
 * bounded enumeration or a number, which is also what keeps them safe to use as
 * metric labels.
 */
const OPERATIONAL_FIELDS = [
  'component',
  'event',
  'outcome',
  'reason',
  'severity',
  'provider',
  'channel',
  'jobType',
  'queue',
  'priority',
  'attempt',
  'maxAttempts',
  'durationMs',
  'retryAfterMs',
  'statusCode',
  'method',
  'route',
  'quantity',
  'previousQuantity',
  'delta',
  'count',
  'schemaVersion',
  'appVersion',
  'role',
  'permission',
  'decision',
] as const;

/**
 * Fields pino itself writes, or that the logging contract depends on. Filtering
 * these out would produce log lines with no message.
 */
const RESERVED_FIELDS = [
  'level',
  'time',
  'pid',
  'hostname',
  'msg',
  'err',
  'unloggedFields',
] as const;

export const ALLOWED_LOG_FIELDS: ReadonlySet<string> = new Set<string>([
  ...CORRELATION_FIELDS,
  ...SCOPE_FIELDS,
  ...OPERATIONAL_FIELDS,
  ...RESERVED_FIELDS,
]);

/** The one allowlisted key permitted to carry a structured value. */
export const ERROR_FIELD = 'err';

/**
 * Whether a value is simple enough to log under an allowlisted key.
 *
 * `null` and `undefined` pass because they carry no information to leak.
 * Objects and arrays do not, because the allowlist vouches for the key and not
 * for whatever a caller nested beneath it.
 */
export function isLoggableScalar(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}
