import { TOKEN_QUERY_PARAMETER } from '@eim/mail';
import { describe, expect, it } from 'vitest';

import { TOKEN_FIELD } from './token-field';

describe('the sign-in link token parameter', () => {
  it('agrees with the name the mail package builds links with', () => {
    // Two copies exist because the browser bundle cannot import the mail
    // package. A drift between them would produce a link the confirmation page
    // renders as "missing its sign-in token" — which is exactly the failure the
    // query carrier was added to fix.
    expect(TOKEN_FIELD).toBe(TOKEN_QUERY_PARAMETER);
  });
});
