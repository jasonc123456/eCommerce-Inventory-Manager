import type { WooIntakeRefusal } from '@eim/integrations';

import { woocommerce } from '@/lib/woocommerce';

/**
 * Where a WooCommerce store delivers its webhooks (section 14).
 *
 * The connection is a path segment rather than a header, and that is the point.
 * WooCommerce sends `X-WC-Webhook-Source` and `X-WC-Webhook-ID`, and both are
 * written by the sender; choosing which business's secrets to verify against
 * from either would let anyone on the internet nominate whose store they are
 * being compared with. The URL was issued by this application to one store, so
 * it is the one part of the request the sender did not choose.
 *
 * The body is read as text and passed on untouched. `request.json()` parses and
 * re-serializes, and the result is equivalent and not identical, so every
 * delivery would fail verification for a reason nothing reports.
 *
 * The status codes are chosen for what WooCommerce does next. A 2xx means "we
 * have it", and section 14 permits that only once the delivery is durably
 * recorded. Anything else counts towards the failure tally that eventually makes
 * WooCommerce disable the registration — which is right for a store delivering
 * to the wrong place and wrong for a genuine delivery this installation could
 * not verify, so the two are answered differently.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteContext {
  readonly params: Promise<{ connection: string }>;
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { connection } = await context.params;

  if (!UUID.test(connection)) {
    return new Response(null, { status: 404 });
  }

  const outcome = await woocommerce().intake.receive({
    connectionId: connection,
    body: await request.text(),
    headers: Object.fromEntries(request.headers.entries()),
  });

  return new Response(null, { status: outcome.ok ? 200 : REFUSAL_STATUS[outcome.refusal] });
}

/**
 * What each refusal tells the store.
 *
 * `unmanaged_topic` is a success from the store's point of view and correctly
 * so: the delivery was genuine, it was about something nothing here acts on, and
 * asking the store to redeliver it forever would end with the registration
 * disabled.
 *
 * `unverified` is a 401 rather than a 200. It counts towards WooCommerce's
 * failure tally and will eventually disable the registration, which is the right
 * outcome: a store whose deliveries this installation cannot verify is one whose
 * secret has diverged, and continuing to accept them would be worse.
 */
const REFUSAL_STATUS: Record<WooIntakeRefusal, number> = {
  too_large: 413,
  unknown_connection: 404,
  wrong_content_type: 415,
  unverified: 401,
  wrong_store: 409,
  unmanaged_topic: 200,
  unreadable: 400,
};
