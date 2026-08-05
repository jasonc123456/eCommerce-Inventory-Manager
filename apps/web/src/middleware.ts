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

/** Paths where section 19 requires a stricter referrer policy. */
const AUTHENTICATION_PATHS = ['/sign-in', '/setup', '/invitations', '/account/security'];

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
    // Section 19: authentication pages use no-referrer. A magic-link page has a
    // token in its fragment, and although a fragment is not sent in a Referer,
    // the surrounding URL still describes what the user was doing.
    response.headers.set('Referrer-Policy', 'no-referrer');
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
