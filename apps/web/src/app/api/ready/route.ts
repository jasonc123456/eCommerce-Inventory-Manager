import { assessReadiness } from '@/lib/runtime';

/**
 * Readiness (section 22).
 *
 * Answers whether this process should receive traffic. Unlike liveness, it
 * checks the dependencies it cannot serve without: PostgreSQL, and a schema
 * version this build agrees with.
 *
 * 503 rather than 200-with-a-body when unready, because a proxy and an
 * orchestrator both act on the status code and neither reads JSON. Details are
 * kept to bounded, non-sensitive facts: section 22 asks for readiness that does
 * not leak internals, so no connection strings, hostnames, or driver messages
 * appear here.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(): Promise<Response> {
  const report = await assessReadiness();

  // Degraded means something is impaired but this process can still serve, so
  // it stays in rotation. Section 22 is explicit that the web tier remains
  // available for inspection while workers are unhealthy.
  const httpStatus = report.status === 'unready' ? 503 : 200;

  return Response.json(report, {
    status: httpStatus,
    headers: { 'cache-control': 'no-store' },
  });
}
