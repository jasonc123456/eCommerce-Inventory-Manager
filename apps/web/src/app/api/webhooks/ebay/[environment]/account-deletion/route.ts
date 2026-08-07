import type { DeletionRefusal } from '@eim/integrations';

import { isEbayEnvironment, receiversFor } from '@/lib/notifications';

/**
 * eBay marketplace account deletion (section 13).
 *
 * The endpoint an operator registers in eBay's developer portal, and the one
 * compliance depends on. eBay validates it with a challenge before accepting
 * it, and then posts here whenever a buyer closes their account.
 *
 * Everything of consequence happens in `@eim/integrations`; this file exists to
 * turn an HTTP request into that call and its answer back into a status code.
 * The one thing it must not do is parse the body — the signature is over the
 * bytes as sent, and a request that has been through `json()` and back is a
 * different sequence of bytes.
 *
 * A 200 here is a claim that the erasure is done. It is only returned when it
 * is, which is why the fan-out runs before the response rather than after it:
 * eBay stops asking once it has been told yes.
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

  const answer = receiversFor(environment).deletion.challenge(challengeCode);

  if (answer === null) {
    return new Response(null, { status: 503 });
  }

  return Response.json({ challengeResponse: answer }, { headers: { 'cache-control': 'no-store' } });
}

export async function POST(request: Request, context: RouteContext): Promise<Response> {
  const { environment } = await context.params;

  if (!isEbayEnvironment(environment)) {
    return new Response(null, { status: 404 });
  }

  const outcome = await receiversFor(environment).deletion.receive({
    body: await request.text(),
    signatureHeader: request.headers.get('x-ebay-signature'),
  });

  return new Response(null, { status: outcome.ok ? 200 : REFUSAL_STATUS[outcome.refusal] });
}

/**
 * eBay documents 412 for a notification that fails verification, and treats it
 * as a signal to stop rather than to retry.
 */
const REFUSAL_STATUS: Record<DeletionRefusal, number> = {
  too_large: 413,
  unverified: 412,
  unreadable: 400,
};
