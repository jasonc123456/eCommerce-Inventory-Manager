import { constantTimeEqual } from '@eim/crypto';
import type { Session } from '@eim/db';

import { CSRF_FIELD } from './csrf-field';
import { identity } from './identity';

/**
 * CSRF tokens for cookie-authenticated mutations (section 19).
 *
 * Next.js already compares Origin against Host on every Server Action, which
 * defeats the ordinary cross-site POST. Section 19 asks for "CSRF tokens **and**
 * origin checks", and the two protect against different failures: the origin
 * check is a property of the framework that a future upgrade or a
 * misconfigured proxy could weaken without anybody noticing, and the token is a
 * property of this application that a reviewer can see in the form.
 *
 * The token is derived from the session rather than stored, so there is no
 * per-form state to expire and no table to clean up. It changes when the
 * session rotates, which is what makes a token captured before a privilege
 * change useless after it.
 */

export { CSRF_FIELD } from './csrf-field';

export function csrfToken(session: Session): string {
  // Keyed off the session's own identifier, so a token from one session cannot
  // be replayed in another, and the installation secret means a token cannot be
  // computed by anybody who has not already got the session.
  return identity().hasher.hash('session', `csrf:${session.id}`, session.tokenHash);
}

export class CsrfError extends Error {
  constructor() {
    super('This form has expired. Reload the page and try again.');
    this.name = 'CsrfError';
  }
}

/**
 * Throws unless the form carries this session's token.
 *
 * Every action that changes something calls this. A read never does: adding it
 * there would train people to pass the token everywhere, and a token on a
 * request that changes nothing protects nothing.
 */
export function assertCsrf(form: FormData, session: Session): void {
  const presented = form.get(CSRF_FIELD);

  if (typeof presented !== 'string' || !constantTimeEqual(presented, csrfToken(session))) {
    throw new CsrfError();
  }
}
