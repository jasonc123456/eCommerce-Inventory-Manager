import { storeFromCallback, type CompleteStoreFailure } from '@eim/integrations';

import { woocommerce } from '@/lib/woocommerce';

/**
 * Where WooCommerce delivers a freshly minted store key (section 14).
 *
 * A public, unauthenticated endpoint, and unlike the eBay notification endpoint
 * there is no signature to lean on: WordPress does not sign this request. What
 * stands in its place is a chain in which the caller controls exactly one link.
 *
 *   The state value in `user_id` was issued for one authorization, is stored
 *   only as a keyed hash, expires in fifteen minutes, and is spent on first use.
 *
 *   The store segment in this route's own path was written by this application
 *   when the flow began and handed to one store, so a callback delivered here
 *   with a state issued for a different store does not match.
 *
 *   The credential in the body is proven against the store named on the
 *   connection row before it is kept. That is the link the caller cannot reach:
 *   whatever they send, it is tried against the operator's store and nowhere
 *   else, so a key that is not for that store is simply refused.
 *
 * The response body is deliberately empty. WooCommerce ignores it, and anything
 * descriptive here would be an oracle telling an unauthenticated caller which of
 * the three links they failed.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Larger than any credential payload, small enough that a flood is bounded. */
const MAX_BODY_BYTES = 8 * 1024;

interface RouteContext {
  readonly params: Promise<{ store: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { store } = await context.params;
  const storeOrigin = storeFromCallback(store);

  if (storeOrigin === null) {
    return new Response(null, { status: 404 });
  }

  const body = await request.text();

  if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }

  const payload = readCallback(body);

  if (payload === null) {
    return new Response(null, { status: 400 });
  }

  const outcome = await woocommerce().connections.complete({
    state: payload.state,
    storeOrigin,
    consumerKey: payload.consumerKey,
    consumerSecret: payload.consumerSecret,
    ...(payload.keyPermissions === undefined ? {} : { keyPermissions: payload.keyPermissions }),
  });

  return new Response(null, { status: outcome.ok ? 200 : FAILURE_STATUS[outcome.reason] });
}

/**
 * What each refusal tells WordPress.
 *
 * `unreachable` is a 503 rather than a 4xx because it is this side's problem:
 * the store's own outbound request arrived, and it was the return trip that
 * failed. Everything else is 400 — WooCommerce does not retry, and the operator
 * is told what happened by the interface rather than by this status.
 */
const FAILURE_STATUS: Record<CompleteStoreFailure, number> = {
  invalid_state: 400,
  state_expired: 400,
  state_already_used: 400,
  invalid_url: 400,
  unknown_connection: 400,
  credentials_rejected: 400,
  unreachable: 503,
};

interface Callback {
  readonly state: string;
  readonly consumerKey: string;
  readonly consumerSecret: string;
  readonly keyPermissions: string | undefined;
}

/**
 * Reads WooCommerce's callback body.
 *
 * WordPress sends JSON, but a store behind a plugin that rewrites requests, or a
 * misconfigured proxy, can deliver form encoding instead — so both are read.
 * Every required field is required: a callback missing one is not a partial
 * success to be patched up, it is a request this endpoint cannot act on.
 */
export function readCallback(body: string): Callback | null {
  const fields = asJson(body) ?? asForm(body);

  if (fields === null) {
    return null;
  }

  const state = fields['user_id'];
  const consumerKey = fields['consumer_key'];
  const consumerSecret = fields['consumer_secret'];
  const keyPermissions = fields['key_permissions'];

  if (
    typeof state !== 'string' ||
    state.length === 0 ||
    typeof consumerKey !== 'string' ||
    consumerKey.length === 0 ||
    typeof consumerSecret !== 'string' ||
    consumerSecret.length === 0
  ) {
    return null;
  }

  return {
    state,
    consumerKey,
    consumerSecret,
    keyPermissions: typeof keyPermissions === 'string' ? keyPermissions : undefined,
  };
}

function asJson(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);

    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function asForm(body: string): Record<string, string> | null {
  if (!body.includes('=')) {
    return null;
  }

  return Object.fromEntries(new URLSearchParams(body).entries());
}
