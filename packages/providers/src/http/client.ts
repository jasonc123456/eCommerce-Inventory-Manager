import { classifyAddress } from './addresses';
import { nodeResolver, nodeTransport } from './node-transport';
import { validateIntegrationUrl, type UrlPolicy } from './url-policy';

/**
 * The only way this application talks to a provider (section 19).
 *
 * Everything a provider adapter sends goes through here, and the reason it is
 * one place rather than a convention is that each of the protections below is
 * useless on its own:
 *
 *   The destination is validated, then resolved, then the resolved address is
 *   validated, and then the connection is pinned to that exact address. Without
 *   the pinning, a name can resolve to a public address for the check and a
 *   private one for the connection a millisecond later — which is what DNS
 *   rebinding is, and it defeats a validate-then-fetch that trusts the name.
 *
 *   Redirects are followed manually so every hop is validated the same way. A
 *   library that follows redirects for you will happily follow the first one
 *   into the metadata service, because it has no idea that mattered.
 *
 *   Time, size, and hop count are all bounded. A provider that accepts the
 *   connection and then streams forever is indistinguishable from one that is
 *   slow, and only a limit tells them apart before the process runs out of
 *   memory.
 */

export interface HttpRequest {
  readonly method: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  /** Whole-request budget, including every redirect hop. */
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  readonly maxRedirects?: number;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** The URL that actually answered, which is not the one asked for after a redirect. */
  readonly url: string;
}

export type HttpOutcome =
  | { readonly ok: true; readonly response: HttpResponse }
  | { readonly ok: false; readonly kind: HttpFailureKind; readonly reason: string };

export type HttpFailureKind =
  'blocked' | 'timeout' | 'transport' | 'too_large' | 'too_many_redirects';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_REDIRECTS = 3;

/**
 * A resolved destination: the address a socket will be opened to.
 *
 * Injectable so the policy can be tested without a network. The production
 * implementation is `node:dns`, and the tests exercise the cases that matter —
 * a name resolving to a private address, a redirect crossing into one — which
 * no amount of real DNS would reliably produce.
 */
export type Resolver = (hostname: string) => Promise<readonly string[]>;

/**
 * The transport, after the destination has been decided.
 *
 * Also injectable, and for the same reason: the interesting behaviour of this
 * module is which requests it refuses and how it treats what comes back, not
 * whether Node can open a socket.
 */
export interface TransportRequest {
  readonly url: URL;
  /** The validated address to connect to. The hostname is still sent for TLS and Host. */
  readonly address: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string | undefined;
  readonly timeoutMs: number;
  readonly maxBytes: number;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export interface TransportResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** Set when the body was cut off at the limit rather than ending. */
  readonly truncated?: boolean;
}

export interface HttpClientOptions {
  readonly policy: UrlPolicy;
  readonly resolve?: Resolver;
  readonly transport?: Transport;
  readonly userAgent?: string;
}

export interface HttpClient {
  send(request: HttpRequest): Promise<HttpOutcome>;
}

export function createHttpClient(options: HttpClientOptions): HttpClient {
  const resolve = options.resolve ?? nodeResolver;
  const transport = options.transport ?? nodeTransport;
  const userAgent = options.userAgent ?? 'eCommerce-Inventory-Manager';

  return {
    async send(request) {
      const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const maxBytes = request.maxBytes ?? DEFAULT_MAX_BYTES;
      const maxRedirects = request.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
      const deadline = Date.now() + timeoutMs;

      let target = request.url;
      let method = request.method;
      let body = request.body;

      for (let hop = 0; hop <= maxRedirects; hop += 1) {
        const verdict = validateIntegrationUrl(target, options.policy);

        if (!verdict.ok) {
          return { ok: false, kind: 'blocked', reason: verdict.reason };
        }

        const remaining = deadline - Date.now();

        if (remaining <= 0) {
          return { ok: false, kind: 'timeout', reason: 'the request budget was exhausted' };
        }

        const address = await pickAddress(verdict.url.hostname, options.policy, resolve);

        if (!address.ok) {
          return { ok: false, kind: 'blocked', reason: address.reason };
        }

        let response: TransportResponse;

        try {
          response = await transport({
            url: verdict.url,
            address: address.address,
            method,
            headers: {
              'user-agent': userAgent,
              // Sent explicitly because the connection is pinned to an address:
              // without it, a request to a virtual host would arrive addressed
              // to whatever that address answers to by default.
              host: verdict.url.host,
              ...normalizeHeaders(request.headers ?? {}),
            },
            body,
            timeoutMs: remaining,
            maxBytes,
          });
        } catch (error: unknown) {
          return { ok: false, kind: classifyTransportError(error), reason: describe(error) };
        }

        if (response.truncated === true) {
          return {
            ok: false,
            kind: 'too_large',
            reason: `the response exceeded ${String(maxBytes)} bytes`,
          };
        }

        const location = redirectTarget(response);

        if (location === null) {
          return {
            ok: true,
            response: {
              status: response.status,
              headers: response.headers,
              body: response.body,
              url: verdict.url.toString(),
            },
          };
        }

        let next: URL;

        try {
          next = new URL(location, verdict.url);
        } catch {
          return { ok: false, kind: 'blocked', reason: 'the redirect target is not a valid URL' };
        }

        // 303 always becomes a GET, and 301/302 do in every real client. The
        // body is dropped with the method: carrying a POST body onto a GET
        // would resend whatever it contained to a destination that asked for
        // something else.
        if (
          response.status === 303 ||
          ((response.status === 301 || response.status === 302) &&
            method !== 'GET' &&
            method !== 'HEAD')
        ) {
          method = 'GET';
          body = undefined;
        }

        target = next.toString();
      }

      return {
        ok: false,
        kind: 'too_many_redirects',
        reason: `more than ${String(maxRedirects)} redirects`,
      };
    },
  };
}

type AddressChoice =
  { readonly ok: true; readonly address: string } | { readonly ok: false; readonly reason: string };

/**
 * Resolves a host and returns an address only if every answer is permitted.
 *
 * Every answer, not the first permitted one. A name that resolves to both a
 * public and a private address is being used to smuggle the private one past a
 * check that stops at the first acceptable result, and there is no legitimate
 * store configured that way.
 */
async function pickAddress(
  hostname: string,
  policy: UrlPolicy,
  resolve: Resolver,
): Promise<AddressChoice> {
  let addresses: readonly string[];

  try {
    addresses = await resolve(hostname.replace(/^\[|\]$/g, ''));
  } catch (error: unknown) {
    return { ok: false, reason: `the host could not be resolved (${describe(error)})` };
  }

  if (addresses.length === 0) {
    return { ok: false, reason: 'the host did not resolve to any address' };
  }

  const [first, ...rest] = addresses;

  if (first === undefined) {
    return { ok: false, reason: 'the host did not resolve to any address' };
  }

  for (const address of [first, ...rest]) {
    const verdict = classifyAddress(address, policy);

    if (!verdict.allowed) {
      return { ok: false, reason: verdict.reason };
    }
  }

  return { ok: true, address: first };
}

function redirectTarget(response: TransportResponse): string | null {
  if (response.status < 300 || response.status > 399) {
    return null;
  }

  const location = response.headers['location'];

  return location === undefined || location.trim() === '' ? null : location.trim();
}

function normalizeHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const normalized: Record<string, string> = {};

  for (const [name, value] of Object.entries(headers)) {
    normalized[name.toLowerCase()] = value;
  }

  return normalized;
}

function classifyTransportError(error: unknown): HttpFailureKind {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;

  return code === 'ETIMEDOUT' || code === 'EIM_TIMEOUT' ? 'timeout' : 'transport';
}

/** A short description, never the provider's response body (section 19). */
function describe(error: unknown): string {
  if (typeof error === 'object' && error !== null) {
    const code = (error as { code?: unknown }).code;

    if (typeof code === 'string') {
      return code;
    }
  }

  return 'the request failed';
}
