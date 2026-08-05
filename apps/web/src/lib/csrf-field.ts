/**
 * The name of the hidden field carrying the CSRF token.
 *
 * Its own module, with no imports, because client components need the name and
 * nothing else. Taking it from `csrf.ts` would drag the token derivation — and
 * through it the configuration loader, and through that `node:fs` — into the
 * browser bundle, which does not build and should not.
 */
export const CSRF_FIELD = 'csrf';
