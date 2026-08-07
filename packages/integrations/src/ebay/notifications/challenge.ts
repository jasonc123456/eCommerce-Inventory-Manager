import { createHash } from 'node:crypto';

/**
 * Answering eBay's endpoint challenge (section 13).
 *
 * Before eBay will deliver anything to a URL — a notification destination or
 * the marketplace account-deletion endpoint — it sends a GET carrying a
 * challenge code and expects a hash back. The hash is over three things, in
 * this order: the code, a verification token the operator and this application
 * both know, and the endpoint URL itself.
 *
 * The endpoint being part of the hash is the useful part, and it is why one
 * token can serve both endpoints. A correct answer for the deletion endpoint is
 * a wrong answer for the notification endpoint, so proving control of one is
 * not proof of control of the other, and an answer captured from one cannot be
 * replayed at the other.
 *
 * The endpoint must be spelled exactly as it is registered in eBay's portal —
 * same scheme, same host, no trailing slash unless it was registered with one.
 * A mismatch produces a hash that is wrong for a reason nothing reports: eBay
 * says validation failed, and every part of the configuration looks right.
 */

/**
 * What eBay accepts as a verification token: 32–80 characters, alphanumeric
 * with underscore and hyphen. Checked here so a token the operator mistyped
 * fails locally with a clear reason rather than as a rejected registration.
 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,80}$/;

export function isUsableVerificationToken(token: string | undefined): token is string {
  return token !== undefined && TOKEN_PATTERN.test(token);
}

export interface ChallengeInput {
  readonly challengeCode: string;
  readonly verificationToken: string;
  /** Exactly as registered with eBay. */
  readonly endpoint: string;
}

/**
 * Returns the hex digest eBay expects, or null when the inputs cannot produce a
 * valid one.
 *
 * Null rather than a throw or a wrong answer: this runs in a public request
 * handler, and the caller has to distinguish "eBay asked us something we cannot
 * answer" from "we answered".
 */
export function challengeResponse(input: ChallengeInput): string | null {
  if (input.challengeCode.length === 0 || input.endpoint.length === 0) {
    return null;
  }

  if (!isUsableVerificationToken(input.verificationToken)) {
    return null;
  }

  return createHash('sha256')
    .update(input.challengeCode, 'utf8')
    .update(input.verificationToken, 'utf8')
    .update(input.endpoint, 'utf8')
    .digest('hex');
}
