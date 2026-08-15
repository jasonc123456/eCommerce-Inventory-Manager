import { NextResponse, type NextRequest } from 'next/server';

/**
 * Per-request security headers (section 19).
 *
 * The Content-Security-Policy is here rather than in `next.config.ts` because
 * it carries a nonce, and a nonce that is the same on every response is not a
 * nonce. Everything static — MIME sniffing, framing, permissions policy — stays
 * in the config, where it costs nothing per request.
 *
 * `strict-dynamic` with a nonce rather than a host allowlist: Next.js emits its
 * own inline bootstrap and hashed chunk filenames, and an allowlist that had to
 * cover those would end up permitting `'unsafe-inline'`, which is the thing the
 * policy exists to prevent.
 */

/**
 * Paths where section 19 requires a stricter referrer policy.
 *
 * `/businesses/delete` is here because it is one in every way that matters: it
 * is reached by an emailed single-use token carried in the query (D-267), so
 * its URL is a secret even though the screen is not a sign-in screen. Without
 * it the page inherits `strict-origin-when-cross-origin`, which sends the whole
 * URL — token included — as the Referer on the next same-origin request.
 */
const AUTHENTICATION_PATHS = [
  '/sign-in',
  '/setup',
  '/invitations',
  '/account/security',
  '/businesses/delete',
];

/**
 * The stricter policy those paths get, and why it is not `no-referrer` (D-281).
 *
 * Section 19 originally said `no-referrer`, and `no-referrer` breaks every form
 * on these pages for anybody without JavaScript. The reason is in the Fetch
 * standard rather than in this application: a POST that is a top-level
 * navigation carries `Origin: null` when the referrer policy is `no-referrer`,
 * and a Server Action refuses a request whose origin does not match its host.
 * With JavaScript the submission is a same-origin fetch and carries a real
 * origin, so the failure is invisible until somebody turns scripting off — on
 * the sign-in screen, which is where people arrive when something has already
 * gone wrong.
 *
 * `strict-origin` sends `https://this-installation/` and nothing else: no path,
 * no query, no token, and nothing at all on a downgrade to HTTP. That is the
 * whole of what `no-referrer` was protecting here — every request these pages
 * make is same-origin (`default-src 'self'`, `form-action 'self'`, no
 * third-party resources), so the only thing `no-referrer` additionally hid was
 * the origin, from the one party that already knows it.
 *
 * `apps/e2e/tests/without-javascript.spec.ts` is what holds this in place.
 */
const AUTHENTICATION_REFERRER_POLICY = 'strict-origin';

export function middleware(request: NextRequest): NextResponse {
  const nonce = generateNonce();

  const header = policy(nonce, isDevelopment());

  const requestHeaders = new Headers(request.headers);
  // Set on the request as well as the response, which is how Next.js finds the
  // nonce and puts it on the scripts it emits. Without this the policy would be
  // correct and the application would not load, because Next's own bootstrap
  // script would be the first thing the browser refused.
  requestHeaders.set('content-security-policy', header);
  requestHeaders.set('x-eim-nonce', nonce);

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  const isAuthenticationPage = AUTHENTICATION_PATHS.some(
    (path) => request.nextUrl.pathname === path || request.nextUrl.pathname.startsWith(`${path}/`),
  );

  response.headers.set('Content-Security-Policy', header);

  if (isAuthenticationPage) {
    // A magic-link page has a token in its URL, and although a fragment is
    // never sent in a Referer, the query carrier (D-182) and the surrounding
    // path both describe what the user was doing. This strips all of it.
    response.headers.set('Referrer-Policy', AUTHENTICATION_REFERRER_POLICY);
  }

  return response;
}

/**
 * 128 bits of nonce, from Web Crypto rather than `node:crypto`.
 *
 * Middleware runs in the Edge runtime, which has no Node built-ins at all.
 * Importing `node:crypto` here builds cleanly and then fails at the first
 * request with "Native module not found" — a failure that appears only against
 * a production build, and only when something actually asks for a page.
 */
function generateNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));

  return btoa(String.fromCharCode(...bytes));
}

function policy(nonce: string, development: boolean): string {
  const scriptSrc = [
    `'nonce-${nonce}'`,
    "'strict-dynamic'",
    // Ignored by browsers that understand strict-dynamic, and the fallback for
    // those that do not.
    "'self'",
    // Next.js evaluates its dev-mode refresh runtime, which needs eval. It is
    // absent from a production build, and gating it on the mode means the
    // production policy cannot silently inherit a development concession.
    ...(development ? ["'unsafe-eval'"] : []),
  ].join(' ');

  return [
    "default-src 'self'",
    `script-src ${scriptSrc}`,
    // Tailwind emits a stylesheet, but Next injects inline styles for fonts and
    // for the development overlay. A nonce cannot cover the latter, and hashing
    // them would break on every Next upgrade.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    // Section 19: no analytics and no third-party resources anywhere, so the
    // connect list is this origin and nothing else.
    `connect-src 'self'${development ? ' ws: wss:' : ''}`,
    "form-action 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    // Cheap defence against a mixed-content mistake behind a TLS-terminating
    // proxy, which is exactly the topology this deployment uses.
    ...(development ? [] : ['upgrade-insecure-requests']),
  ].join('; ');
}

function isDevelopment(): boolean {
  // The one place that reads the raw environment. `@eim/config` cannot be used
  // in middleware: it runs in a restricted runtime with no access to the
  // filesystem checks the loader performs.
  // eslint-disable-next-line no-restricted-properties
  return process.env.NODE_ENV === 'development';
}

export const config = {
  // Everything except the static assets Next serves itself, which need no
  // policy of their own and would only add a header to every image request.
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
