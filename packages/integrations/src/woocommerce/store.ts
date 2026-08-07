import { canonicalize, validateIntegrationUrl, type UrlPolicy } from '@eim/providers';

/**
 * Deciding what store a typed address names (section 14).
 *
 * Section 14 requires a canonical HTTPS REST origin and an approved origin that
 * is bound to the connection. Everything in this file exists to make "the same
 * store" a decidable question, because two answers to it are two connections to
 * one shop, each importing the same orders and each writing the same stock.
 *
 * Three things a person types that all mean one store:
 *
 *   `HTTPS://Shop.Example./` — case, trailing dot, trailing slash.
 *   `https://shop.example/?utm_source=email` — a query string carried in from
 *   wherever they copied it.
 *   `https://shop.example/wp-json/wc/v3` — the REST route rather than the store,
 *   which is what somebody who has read the API documentation pastes.
 *
 * The third is the one worth spelling out. A store may genuinely live under a
 * path — `https://example.com/shop` is an ordinary WordPress subdirectory
 * install — so the path cannot simply be discarded. It is the API suffix that
 * has to go, and only when it is a suffix.
 */

/** What the application derives from an address, and stores against a connection. */
export interface WooStore {
  /** Scheme, host, port, and any subdirectory the install lives under. */
  readonly base: string;
  /** Scheme, host, and port only. What a callback is checked against. */
  readonly origin: string;
  /** Where the v3 REST routes are. */
  readonly restBase: string;
  /** Where an operator is sent to approve a key. */
  readonly authorizeUrl: string;
  /**
   * Which half of the installation this store belongs to.
   *
   * A plain-HTTP store is a development store — section 14 permits one only
   * behind the installation's development flag — so it is recorded as
   * `sandbox`. That keeps a developer's fixture catalog out of the same bucket
   * as a live shop's, and it is derived rather than chosen so the two cannot
   * drift apart.
   */
  readonly environment: 'sandbox' | 'production';
}

export type StoreVerdict =
  { readonly ok: true; readonly store: WooStore } | { readonly ok: false; readonly reason: string };

/**
 * Suffixes that name the API rather than the store.
 *
 * Longest first, so `/wp-json/wc/v3` is recognized before `/wp-json`.
 */
const API_SUFFIXES = [
  '/wp-json/wc/v3',
  '/wp-json/wc/v2',
  '/wp-json/wc/v1',
  '/wc-auth/v1/authorize',
  '/wp-json',
] as const;

export function describeStore(input: string, policy: UrlPolicy): StoreVerdict {
  const verdict = validateIntegrationUrl(input, policy);

  if (!verdict.ok) {
    return verdict;
  }

  const url = canonicalize(verdict.url);

  url.pathname = stripApiSuffix(url.pathname);

  const base = url.toString().replace(/\/+$/, '');

  return {
    ok: true,
    store: {
      base,
      origin: url.origin,
      restBase: `${base}/wp-json/wc/v3`,
      authorizeUrl: `${base}/wc-auth/v1/authorize`,
      environment: url.protocol === 'https:' ? 'production' : 'sandbox',
    },
  };
}

/**
 * The store's own address, given one of its API routes.
 *
 * Applied repeatedly, because `…/wp-json/wc/v3` reduces to `…/wp-json` and then
 * to nothing, and a single pass would leave the intermediate form standing.
 */
function stripApiSuffix(pathname: string): string {
  let path = pathname.replace(/\/+$/, '');

  for (;;) {
    const suffix = API_SUFFIXES.find((candidate) => path.toLowerCase().endsWith(candidate));

    if (suffix === undefined) {
      return path;
    }

    path = path.slice(0, path.length - suffix.length).replace(/\/+$/, '');
  }
}

/**
 * Whether a callback claiming to be from a store really is from the one bound
 * to the authorization.
 *
 * Compared on origin rather than on the full base, because WordPress sends the
 * callback from the site's own request context and a subdirectory install may
 * report its home rather than its shop path. The origin is the part that
 * identifies whose server it is, and it is the part an attacker would have to
 * control.
 */
export function sameOrigin(expected: string, claimed: string | null | undefined): boolean {
  if (claimed === null || claimed === undefined || claimed.length === 0) {
    return false;
  }

  let url: URL;

  try {
    url = new URL(claimed);
  } catch {
    return false;
  }

  return canonicalize(url).origin === expected;
}
