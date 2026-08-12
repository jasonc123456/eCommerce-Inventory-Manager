import { appliedSchemaVersion } from '@eim/db';

import { assessScrape } from '@/lib/metrics-auth';
// Aliased because `runtime` is also a Next.js route segment option, and this
// file has to export one of those under that exact name.
import { runtime as appRuntime } from '@/lib/runtime';

/**
 * Prometheus metrics (section 22).
 *
 * Section 22 asks for "a protected Prometheus-compatible metrics endpoint on an
 * internal/administrative path". Who may scrape it is decided in
 * `lib/metrics-auth.ts`, which is testable; what is here is the shape of the
 * answer.
 *
 * No session is accepted, and that is a decision rather than an omission.
 * Metrics are for a collector, not for a person: a cookie-authenticated path
 * would put browser credentials on an endpoint that exists to be fetched by a
 * machine. The screen for a person is `/health`, which says the same things in
 * sentences.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: Request): Promise<Response> {
  const { config, metrics, pool } = appRuntime();
  const verdict = assessScrape(request.headers.get('authorization'), config.EIM_METRICS_TOKEN);

  if (verdict === 'not_configured') {
    return new Response('Not found', { status: 404 });
  }

  if (verdict === 'unauthorized') {
    // No `WWW-Authenticate` challenge: this is not a browser surface, and a
    // challenge would invite a password prompt from anything that wandered in.
    return new Response('Unauthorized', { status: 401 });
  }

  // Read at scrape time rather than at startup, so a migration applied under a
  // running process is visible without a restart. Section 22 wants a version
  // mismatch to be alertable, and a gauge that was correct an hour ago is how a
  // half-finished deployment goes unnoticed.
  try {
    metrics.schemaVersion.set(await appliedSchemaVersion(pool));
  } catch {
    // A database that cannot be asked is its own alert, raised elsewhere. The
    // remaining metrics are process-local and still worth returning: an
    // exporter that answers nothing during an outage is silent exactly when
    // somebody is looking at it.
  }

  return new Response(await metrics.registry.metrics(), {
    status: 200,
    headers: {
      'content-type': metrics.registry.contentType,
      'cache-control': 'no-store',
    },
  });
}
