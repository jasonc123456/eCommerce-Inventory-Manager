import { challengeResponse, type IntakeRefusal } from '@eim/integrations';

import {
  isEbayEnvironment,
  notificationEndpoint,
  receiversFor,
  verificationToken,
} from '@/lib/notifications';

/**
 * Where eBay delivers seller notifications (sections 13, 14).
 *
 * A public, unauthenticated endpoint whose authentication is the signature on
 * the body. Two methods, both of which eBay uses:
 *
 *   GET answers the endpoint challenge, which is how eBay decides the URL is
 *   really ours before it will register the destination.
 *
 *   POST receives notifications. The body is read as text and passed on
 *   untouched — `request.json()` would parse and discard the exact bytes the
 *   signature covers, and every notification would then fail verification for a
 *   reason nothing reports.
 *
 * The status codes are chosen for what eBay does next. A 2xx means "we have it,
 * stop redelivering", and section 14 permits that only once the delivery is
 * durably recorded. Anything else asks eBay to try again, which is right for an
 * outage here and wrong for a forgery — so a request that fails verification is
 * refused with a 4xx rather than left to be retried forever.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

interface RouteContext {
  readonly params: Promise<{ environment: string }>;
}

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const { environment } = await context.params;

  if (!isEbayEnvironment(environment)) {
    return new Response(null, { status: 404 });
  }

  const challengeCode = new URL(request.url).searchParams.get('challenge_code');

  if (challengeCode === null) {
    return new Response(null, { status: 400 });
  }

  const answer = challengeResponse({
    challengeCode,
    verificationToken: verificationToken(),
    endpoint: notificationEndpoint(environment, 'notifications'),
  });

  if (answer === null) {
    // The installation has no usable verification token. 503 rather than 500:
    // it is a configuration state an operator fixes, and eBay retries.
    return new Response(null, { status: 503 });
  }

  return Response.json({ challengeResponse: answer }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { environment } = await context.params;

  if (!isEbayEnvironment(environment)) {
    return new Response(null, { status: 404 });
  }

  const outcome = await receiversFor(environment).intake.receive({
    body: await request.text(),
    signatureHeader: request.headers.get('x-ebay-signature'),
    headers: Object.fromEntries(request.headers.entries()),
  });

  return new Response(null, { status: outcome.ok ? 204 : REFUSAL_STATUS[outcome.refusal] });
}

/**
 * What each refusal tells eBay to do next.
 *
 * `unattributed` is a success from eBay's point of view and correctly so: the
 * notification was genuine, it was about a seller nobody here has connected,
 * and redelivering it forever helps nobody.
 */
const REFUSAL_STATUS: Record<IntakeRefusal, number> = {
  too_large: 413,
  unverified: 401,
  unreadable: 400,
  unattributed: 204,
};
