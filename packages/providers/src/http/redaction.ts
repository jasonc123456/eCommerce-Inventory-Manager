/**
 * What may be written down about a provider call (section 19).
 *
 * Section 19 keeps credentials out of logs, and the awkward part is that the
 * places they appear are not the places anybody thinks to look. An
 * `Authorization` header is obvious. A refresh token in a query string, an eBay
 * error body quoting the request that failed, a WooCommerce redirect carrying a
 * consumer key — those arrive in whatever gets logged when something breaks,
 * which is exactly when logging is turned up.
 *
 * So this redacts by name and by shape, and it fails closed: an unrecognised
 * header is redacted if its name looks credential-shaped, rather than kept
 * because it was not on a list.
 */

const SENSITIVE_HEADER_PATTERN = /(authorization|cookie|token|secret|key|signature|password)/i;

/**
 * Headers that look sensitive but are not, and are worth keeping because they
 * are how a provider tells us what went wrong and when to come back.
 */
const KEEP = new Set(['x-ebay-c-request-id', 'x-request-id', 'retry-after', 'x-rate-limit-reset']);

export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const redacted: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();

    redacted[lower] =
      !KEEP.has(lower) && SENSITIVE_HEADER_PATTERN.test(lower) ? '[redacted]' : value;
  }

  return redacted;
}

/** Query parameters whose values are credentials wherever they appear. */
const SENSITIVE_PARAMS =
  /^(code|state|token|access_token|refresh_token|consumer_key|consumer_secret|client_secret|signature|key|secret|password)$/i;

/**
 * A URL safe to log.
 *
 * The path is kept, because which endpoint failed is the whole diagnostic
 * value. Sensitive parameters are replaced rather than dropped, so a reader can
 * see that a token was present without being shown it — "there was a code here"
 * and "there was no code" are different bugs.
 */
export function redactUrl(url: string): string {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return '[unparseable url]';
  }

  if (parsed.username !== '' || parsed.password !== '') {
    parsed.username = '';
    parsed.password = '';
  }

  const parameters = new URLSearchParams(parsed.search);
  const cleaned = new URLSearchParams();

  for (const [name, value] of parameters.entries()) {
    cleaned.set(name, SENSITIVE_PARAMS.test(name) ? '[redacted]' : value);
  }

  parsed.search = cleaned.toString();

  return parsed.toString();
}

const MAX_SUMMARY_LENGTH = 240;

/**
 * A bounded, non-sensitive description of a provider's response body.
 *
 * Providers put useful things in error bodies and also put the request back in
 * them. Keeping a truncated, credential-stripped prefix is the compromise:
 * enough to recognise "category not found" without storing an access token
 * somebody echoed back.
 */
export function summarizeBody(body: string): string {
  const withoutSecrets = body
    // Anything that looks like a bearer token or a long opaque credential.
    .replace(/\b(v\^?1\.1#[A-Za-z0-9+/=_#|-]{20,})/g, '[redacted]')
    .replace(/\b([A-Za-z0-9_-]{40,})\b/g, '[redacted]')
    .replace(
      /"(access_token|refresh_token|client_secret|consumer_secret)"\s*:\s*"[^"]*"/gi,
      '"$1":"[redacted]"',
    );

  const collapsed = withoutSecrets.replace(/\s+/g, ' ').trim();

  return collapsed.length <= MAX_SUMMARY_LENGTH
    ? collapsed
    : `${collapsed.slice(0, MAX_SUMMARY_LENGTH)}…`;
}
