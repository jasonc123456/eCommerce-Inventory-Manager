import type { HttpClient } from '@eim/providers';

import type { SecretStore } from '../secrets';

/**
 * Talking to a WooCommerce store (section 14).
 *
 * Section 14 has one absolute rule about how these requests are made, and this
 * file exists mainly to make breaking it impossible: credentials go in the
 * HTTPS `Authorization` header, and query-string credentials are prohibited.
 *
 * The prohibition is not stylistic. WooCommerce still accepts
 * `?consumer_key=…&consumer_secret=…`, and it works, which is exactly why it is
 * dangerous — a URL is written to the web server's access log, to any proxy in
 * front of it, to this application's own request log, and to the `Referer` of
 * anything the store subsequently loads. The header is not. So the only place
 * credentials are attached is here, once, and `path` is a path rather than a
 * URL so that a caller has nowhere to put them even by accident.
 *
 * The other thing this file owns is pagination. WooCommerce reports totals in
 * `X-WP-Total` and `X-WP-TotalPages` and offers a `Link: …; rel="next"` header,
 * and the two disagree in a way that matters: totals are computed when the page
 * is built, so a catalog being edited during an import will renumber underneath
 * a page counter. `rel="next"` is the store's own answer to "what comes after
 * this", so it is preferred and the counter is the fallback.
 */

export interface WooCredentials {
  readonly consumerKey: string;
  readonly consumerSecret: string;
}

export interface WooResponse {
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type WooCall =
  | { readonly ok: true; readonly response: WooResponse }
  | { readonly ok: false; readonly reason: string; readonly retryable: boolean };

export interface WooClient {
  /** A read. `path` is relative to the store's `/wc/v3` base. */
  get(path: string): Promise<WooCall>;
  /** A write. Section 14 requires these to carry only the fields being changed. */
  send(method: 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<WooCall>;
}

export interface WooClientOptions {
  readonly http: HttpClient;
  /** The store's `…/wp-json/wc/v3` base, already canonical. */
  readonly restBase: string;
  readonly credentials: WooCredentials;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export function createWooClient(options: WooClientOptions): WooClient {
  const authorization = `Basic ${Buffer.from(
    `${options.credentials.consumerKey}:${options.credentials.consumerSecret}`,
    'utf8',
  ).toString('base64')}`;

  const call = async (method: string, path: string, body?: unknown): Promise<WooCall> => {
    const outcome = await options.http.send({
      method,
      url: `${options.restBase}${path.startsWith('/') ? path : `/${path}`}`,
      headers: {
        authorization,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
    });

    if (!outcome.ok) {
      // `blocked` is the SSRF policy refusing the destination. Retrying cannot
      // change its mind, and repeating it would turn one refusal into a loop.
      return { ok: false, reason: outcome.kind, retryable: outcome.kind !== 'blocked' };
    }

    return {
      ok: true,
      response: {
        status: outcome.response.status,
        body: outcome.response.body,
        headers: outcome.response.headers,
      },
    };
  };

  return {
    get: (path) => call('GET', path),
    send: (method, path, body) => call(method, path, body),
  };
}

/**
 * Builds a client from a connection's stored credentials.
 *
 * Returns null rather than throwing when there are none: a connection whose key
 * has been discarded on disconnection is an ordinary state, and every caller
 * here has something sensible to report about it.
 */
export async function clientForConnection(input: {
  readonly http: HttpClient;
  readonly secrets: SecretStore;
  readonly businessId: string;
  readonly connectionId: string;
  readonly restBase: string;
}): Promise<WooClient | null> {
  const ref = { businessId: input.businessId, connectionId: input.connectionId };

  const consumerKey = await input.secrets.read(ref, 'woocommerce_consumer_key');
  const consumerSecret = await input.secrets.read(ref, 'woocommerce_consumer_secret');

  if (consumerKey === null || consumerSecret === null) {
    return null;
  }

  return createWooClient({
    http: input.http,
    restBase: input.restBase,
    credentials: { consumerKey, consumerSecret },
  });
}

// ---------------------------------------------------------------------------
// Reading what a store answered
// ---------------------------------------------------------------------------

/**
 * Classifies a status the way the import and health code needs it classified.
 *
 * 401 and 403 are deliberately not retryable. A rejected key repeated on a
 * schedule is how a store's security plugin decides this application is an
 * attacker and bans the address it is calling from, and the fix is always a
 * person supplying a working key rather than another attempt.
 */
export function classifyStatus(status: number): {
  ok: boolean;
  reason: string;
  retryable: boolean;
} {
  if (status >= 200 && status < 300) {
    return { ok: true, reason: 'ok', retryable: false };
  }

  if (status === 401 || status === 403) {
    return { ok: false, reason: `http_${String(status)}`, retryable: false };
  }

  if (status === 429 || status >= 500) {
    return { ok: false, reason: `http_${String(status)}`, retryable: true };
  }

  return { ok: false, reason: `http_${String(status)}`, retryable: false };
}

export function parseJsonObject(body: string): Record<string, unknown> | null {
  const parsed = parseJson(body);

  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** WooCommerce collection routes answer with a bare array, not an envelope. */
export function parseJsonArray(body: string): Record<string, unknown>[] {
  const parsed = parseJson(body);

  if (!Array.isArray(parsed)) {
    return [];
  }

  return parsed.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === 'object' && entry !== null && !Array.isArray(entry),
  );
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/**
 * Where the next page is, according to the store.
 *
 * The `Link` header follows RFC 8288: several comma-separated entries, each a
 * bracketed URI with parameters. Only `rel="next"` is wanted, and only when the
 * store gave one — its absence is how a store says this page was the last, and
 * inventing a next page from a counter instead is how an import loops forever
 * on a catalog whose length changed while it was being read.
 */
export function nextPageLink(headers: Readonly<Record<string, string>>): string | null {
  const header = headerValue(headers, 'link');

  if (header === null) {
    return null;
  }

  for (const entry of splitLinkHeader(header)) {
    const match = /^<([^>]*)>\s*;\s*(.*)$/.exec(entry.trim());

    if (match === null) {
      continue;
    }

    const [, uri = '', parameters = ''] = match;

    if (/\brel\s*=\s*"?next"?/i.test(parameters) && uri.length > 0) {
      return uri;
    }
  }

  return null;
}

/**
 * Splits on commas that separate entries rather than commas inside a URI.
 *
 * A WooCommerce collection URL routinely carries `?include=1,2,3`, so a plain
 * `split(',')` tears one link into three fragments and finds no `rel` on any of
 * them — which reads exactly like a store that offered no next page.
 */
function splitLinkHeader(header: string): string[] {
  const entries: string[] = [];
  let depth = 0;
  let start = 0;

  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];

    if (character === '<') {
      depth += 1;
    } else if (character === '>') {
      depth -= 1;
    } else if (character === ',' && depth <= 0) {
      entries.push(header.slice(start, index));
      start = index + 1;
    }
  }

  entries.push(header.slice(start));

  return entries.filter((entry) => entry.trim().length > 0);
}

/** The page counters, when the store reported them. */
export function totalPages(headers: Readonly<Record<string, string>>): number | null {
  const raw = headerValue(headers, 'x-wp-totalpages');

  if (raw === null) {
    return null;
  }

  const parsed = Number.parseInt(raw, 10);

  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function headerValue(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | null {
  const lower = name.toLowerCase();

  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && value.length > 0) {
      return value;
    }
  }

  return null;
}
