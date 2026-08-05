/**
 * Where a sign-in is allowed to send somebody afterwards (sections 19, 20).
 *
 * "Validate callback URLs and redirects against exact allowlists" and "only
 * allow local allowlisted post-login redirects". An open redirect on an
 * authentication callback is the difference between a phishing attempt that
 * fails and one that succeeds: the victim sees the real hostname, signs in for
 * real, and is then handed to the attacker's page still believing they are
 * where they started.
 *
 * The rule is deliberately narrower than "same origin". A path is accepted only
 * if it is a path — no scheme, no host, no protocol-relative form — because
 * every attempt to reason about whether a full URL points back at us is a
 * parser-differential waiting to happen.
 */

export const DEFAULT_REDIRECT = '/';

/** Control characters, which have no business in a Location header. */
// eslint-disable-next-line no-control-regex -- that is precisely what is being matched
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * Returns the path if it is safe to redirect to, or the default if not.
 *
 * Never throws and never returns something unusable, because every caller is on
 * a path where the alternative to a safe destination is a broken sign-in.
 */
export function safeRedirect(candidate: string | null | undefined): string {
  if (candidate === null || candidate === undefined) {
    return DEFAULT_REDIRECT;
  }

  const value = candidate.trim();

  if (!value.startsWith('/')) {
    return DEFAULT_REDIRECT;
  }

  // `//evil.example` is a protocol-relative URL, and several browsers normalize
  // a backslash into a slash, so `/\evil.example` becomes one too. Both start
  // with a slash and neither is a local path.
  if (value.startsWith('//') || value.includes('\\')) {
    return DEFAULT_REDIRECT;
  }

  // A newline or carriage return in a redirect is a response-splitting attempt.
  if (CONTROL_CHARACTERS.test(value)) {
    return DEFAULT_REDIRECT;
  }

  return value;
}

/** Whether a candidate would survive `safeRedirect` unchanged. */
export function isSafeRedirect(candidate: string): boolean {
  return safeRedirect(candidate) === candidate;
}
