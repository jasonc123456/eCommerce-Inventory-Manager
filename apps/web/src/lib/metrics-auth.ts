import { timingSafeEqual } from 'node:crypto';

/**
 * Who may scrape the metrics endpoint (section 22).
 *
 * Separated from the route because it is the whole security of that endpoint
 * and a route handler is the one place in this application that cannot be
 * tested without a running server. What is left in the route is the shape of
 * the response; what is decided here is who gets one.
 */

export type ScrapeVerdict = 'not_configured' | 'unauthorized' | 'allowed';

/**
 * Three answers, and the first is the interesting one.
 *
 * `not_configured` becomes a 404 rather than a 401. Metrics reveal queue depth,
 * provider error rates, and how many businesses an installation has — not
 * secret exactly, but more than a stranger should be able to ask for — and an
 * endpoint that is open until somebody closes it is an endpoint that stays
 * open. Answering 404 also keeps an unconfigured installation from advertising
 * that there is something here worth finding a token for.
 */
export function assessScrape(
  authorization: string | null,
  configuredToken: string | undefined,
): ScrapeVerdict {
  if (configuredToken === undefined) {
    return 'not_configured';
  }

  const prefix = 'Bearer ';

  if (authorization?.startsWith(prefix) !== true) {
    return 'unauthorized';
  }

  return constantTimeMatches(authorization.slice(prefix.length), configuredToken)
    ? 'allowed'
    : 'unauthorized';
}

/**
 * Compared in constant time.
 *
 * A fixed string checked on every scrape is exactly the shape a timing oracle
 * needs, and a collector polls often enough to make one practical. The length
 * is compared first and separately: buffers of different lengths cannot be
 * compared at all, and the length of a token is not the secret part.
 */
function constantTimeMatches(offered: string, expected: string): boolean {
  const left = Buffer.from(offered);
  const right = Buffer.from(expected);

  return left.length === right.length && timingSafeEqual(left, right);
}
