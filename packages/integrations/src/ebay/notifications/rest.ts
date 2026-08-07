/**
 * Reading eBay's REST answers.
 *
 * Small, shared, and hand-written for the same reason as the token parser in
 * `oauth.ts`: the failure being guarded against is a response that parses as
 * JSON and means nothing — a proxy's error page, a login redirect with a 200, a
 * body that is an array where an object was documented. Every one of those is a
 * successful `JSON.parse`, and every one of them turns into `undefined` flowing
 * somewhere it will be mistaken for an answer.
 */

export function parseJsonObject(body: string): Record<string, unknown> | null {
  let payload: unknown;

  try {
    payload = JSON.parse(body);
  } catch {
    return null;
  }

  return typeof payload === 'object' && payload !== null && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

/** The array under `key`, with non-object entries dropped rather than trusted. */
export function objectArray(
  payload: Record<string, unknown> | null,
  key: string,
): readonly Record<string, unknown>[] {
  const value = payload?.[key];

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
}

export function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];

  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * The identifier of something eBay just created.
 *
 * eBay puts it in the body, in the `Location` header, or in both, depending on
 * which of its APIs answered. Both are read rather than one, because a
 * registration whose identifier was not captured is unmanageable afterwards:
 * it cannot be updated, re-enabled, or removed on disconnect.
 */
export function identifierFrom(
  body: string,
  headers: Readonly<Record<string, string>>,
  bodyKey: string,
): string | undefined {
  const fromBody = stringField(parseJsonObject(body) ?? undefined, bodyKey);

  if (fromBody !== undefined) {
    return fromBody;
  }

  const location = headers['location'] ?? headers['Location'];

  if (typeof location !== 'string' || location.length === 0) {
    return undefined;
  }

  const segment = location.split('?')[0]?.split('/').filter(Boolean).pop();

  return segment === undefined || segment.length === 0 ? undefined : segment;
}
