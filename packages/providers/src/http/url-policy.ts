import { classifyAddress, isMetadataAddress, normalize, type AddressPolicy } from './addresses';

/**
 * Canonicalizing and validating an integration URL (section 19).
 *
 * Section 19 requires this twice over: before an administrator-entered URL is
 * stored, and again before every connection. The two are not redundant. The
 * first stops a bad destination being saved; the second stops a destination
 * that was fine in March from being reached in June, after the name it uses
 * started resolving somewhere else.
 *
 * Canonicalization is part of the check rather than a tidying step afterwards.
 * `HTTPS://Store.Example./wp-json/` and `https://store.example/wp-json` are the
 * same store, and a comparison that says otherwise produces two connections to
 * one shop, each importing the same orders.
 */

export interface UrlPolicy extends AddressPolicy {
  /**
   * Whether a plain-HTTP destination is permitted at all. Section 19 requires
   * HTTPS in production; a self-hoster's local store is the documented
   * exception, and it is the same installation-level flag that opens the
   * private ranges, because the two are the same deployment.
   */
  readonly allowInsecure: boolean;
}

export type UrlVerdict =
  { readonly ok: true; readonly url: URL } | { readonly ok: false; readonly reason: string };

/** Ports an integration may be reached on. */
const PUBLIC_PORTS = new Set([80, 443]);

/**
 * Additional ports permitted when the installation has opted into private
 * destinations. These are the ports a local WooCommerce or a reverse proxy in
 * front of one actually listens on; the restriction exists so that an entered
 * URL cannot be aimed at an internal service that merely speaks HTTP, such as
 * a database admin console or the Docker daemon.
 *
 * 11434 is Ollama's default and is here for the same reason the others are:
 * section 19 names "local WooCommerce and Ollama integrations" as the two
 * documented private-host exceptions, and a self-hoster who has opted into
 * private destinations and then cannot reach the one on its own default port
 * would work around this list rather than be protected by it.
 */
const PRIVATE_PORTS = new Set([80, 443, 8000, 8080, 8443, 3000, 11434]);

export function validateIntegrationUrl(input: string, policy: UrlPolicy): UrlVerdict {
  const trimmed = input.trim();

  if (trimmed.length === 0) {
    return { ok: false, reason: 'the address is empty' };
  }

  let url: URL;

  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'the address is not a valid URL' };
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: `${url.protocol.replace(':', '')} addresses are not supported` };
  }

  if (url.protocol === 'http:' && !policy.allowInsecure) {
    return {
      ok: false,
      reason: 'the address must use HTTPS; enable private integration hosts to allow plain HTTP',
    };
  }

  // Credentials in the URL would end up in the stored connection, in logs, and
  // in any error message quoting the destination. WooCommerce authentication is
  // a header (section 14), and there is no legitimate reason for these here.
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'the address must not contain credentials' };
  }

  if (url.hostname === '') {
    return { ok: false, reason: 'the address has no host' };
  }

  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  const permittedPorts = policy.allowPrivate ? PRIVATE_PORTS : PUBLIC_PORTS;

  if (!permittedPorts.has(port)) {
    return { ok: false, reason: `port ${String(port)} is not permitted for integrations` };
  }

  // A hostname that is already a literal address can be judged now. A name
  // cannot: it is judged at connection time, against what it resolves to then.
  const literal = normalize(stripBrackets(url.hostname));

  if (literal !== null) {
    const verdict = classifyAddress(literal, policy);

    if (!verdict.allowed) {
      return { ok: false, reason: verdict.reason };
    }
  } else if (!isPlausibleHostname(url.hostname)) {
    return { ok: false, reason: 'the host is not a valid hostname' };
  } else if (isMetadataHostname(url.hostname)) {
    // The well-known names for the same never-permitted addresses. Refused here
    // as well as after resolution so the refusal is legible to whoever typed it.
    return { ok: false, reason: 'cloud metadata addresses are never permitted' };
  }

  return { ok: true, url: canonicalize(url) };
}

/**
 * The stored form of an accepted URL.
 *
 * Lowercased host, default port dropped, trailing dot removed, query and
 * fragment discarded, and the path reduced to its meaningful part. Two URLs
 * that address the same store now compare equal as strings, which is what the
 * connection's uniqueness rule relies on.
 */
export function canonicalize(url: URL): URL {
  const canonical = new URL(url.toString());

  canonical.hostname = stripTrailingDot(canonical.hostname.toLowerCase());
  canonical.hash = '';
  canonical.search = '';

  if (
    (canonical.protocol === 'https:' && canonical.port === '443') ||
    (canonical.protocol === 'http:' && canonical.port === '80')
  ) {
    canonical.port = '';
  }

  canonical.pathname = canonical.pathname.replace(/\/+$/, '');

  return canonical;
}

/** The origin as stored on a connection: scheme, host, and port only. */
export function originOf(url: URL): string {
  return canonicalize(url).origin;
}

function stripBrackets(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, '');
}

function stripTrailingDot(hostname: string): string {
  return hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
}

/**
 * Whether a name could be a public hostname at all.
 *
 * Deliberately shallow: this rejects the shapes that are never real, and leaves
 * the authoritative answer to DNS. A single-label name like `localhost` or
 * `postgres` is the interesting case — it resolves on an internal network and
 * nowhere else, so a store URL that uses one is either a mistake or an attempt.
 */
function isPlausibleHostname(hostname: string): boolean {
  const name = stripTrailingDot(hostname.toLowerCase());

  if (name.length === 0 || name.length > 253) {
    return false;
  }

  const labels = name.split('.');

  if (labels.length < 2) {
    return false;
  }

  // Spelled out rather than written as one pattern with a nested quantifier:
  // that shape is the classic catastrophic-backtracking regex, and this input
  // arrives from a form field.
  return labels.every(
    (label) =>
      label.length >= 1 &&
      label.length <= 63 &&
      /^[a-z0-9-]+$/.test(label) &&
      !label.startsWith('-') &&
      !label.endsWith('-'),
  );
}

const METADATA_HOSTNAMES = new Set([
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
]);

function isMetadataHostname(hostname: string): boolean {
  const name = stripTrailingDot(hostname.toLowerCase());

  return METADATA_HOSTNAMES.has(name) || isMetadataAddress(name);
}
