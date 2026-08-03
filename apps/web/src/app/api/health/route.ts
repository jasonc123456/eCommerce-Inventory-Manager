/**
 * Liveness (section 22).
 *
 * Reports only whether this process can serve a request. It touches nothing
 * else on purpose: a liveness probe that checked the database would restart a
 * perfectly healthy web container every time PostgreSQL hiccupped, turning a
 * brief database blip into a rolling outage of the whole tier. Whether
 * dependencies are usable is readiness, and it lives next door.
 *
 * Unauthenticated, because an orchestrator has no credentials, and it reveals
 * nothing an unauthenticated caller could not already infer from the port
 * being open.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function GET(): Response {
  return Response.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
}
