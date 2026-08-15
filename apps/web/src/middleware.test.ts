import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The referrer policy on authentication pages (section 19, D-281).
 *
 * Read from the source rather than exercised, because `middleware.ts` runs in
 * the Edge runtime and importing it here would pull in `next/server` and a
 * `NextRequest` this project has no way to construct outside a real request.
 * What is being protected is a constant, and a constant is exactly the kind of
 * thing a source assertion can hold.
 *
 * The behaviour it stands for is proven where it can be: the browser tier
 * submits these forms with scripting turned off
 * (`apps/e2e/tests/without-javascript.spec.ts`). This is the cheap, fast check
 * that fails on the commit that changes the value, rather than on the nightly
 * run that drives a browser.
 */

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'middleware.ts'), 'utf8');

describe('the authentication referrer policy', () => {
  it('is strict-origin, not no-referrer', () => {
    // `no-referrer` makes a browser send `Origin: null` on a form POST that is
    // a top-level navigation, and a Server Action refuses a request whose
    // origin does not match its host. The result is that every form on these
    // pages fails for anybody without JavaScript — silently, because with
    // JavaScript the submission is a fetch and carries a real origin.
    expect(source).toContain("const AUTHENTICATION_REFERRER_POLICY = 'strict-origin'");
    expect(source).not.toContain("'no-referrer'");
  });

  it('covers every screen whose URL is itself a secret', () => {
    // Each of these is reachable by a single-use token in the query, so the URL
    // must not travel in a Referer even to this same origin.
    for (const path of ['/sign-in', '/setup', '/invitations', '/businesses/delete']) {
      expect(source).toContain(`'${path}'`);
    }
  });
});
