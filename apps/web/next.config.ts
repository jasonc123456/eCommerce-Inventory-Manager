import type { NextConfig } from 'next';

/**
 * Next.js configuration (sections 19, 23).
 *
 * Two things here are load-bearing rather than conventional.
 *
 * `output: 'standalone'` produces a self-contained server directory, which is
 * what lets the runtime image ship without node_modules or a package manager.
 * Section 23 wants a small image running as a non-root user, and a smaller
 * image is also a smaller attack surface to keep patched.
 *
 * `transpilePackages` covers the workspace packages, which export TypeScript
 * source rather than compiled output. That removes a build-ordering problem
 * across the monorepo at the cost of Next.js compiling them, which it was
 * already doing for the application itself.
 */
const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  poweredByHeader: false,

  transpilePackages: ['@eim/authz', '@eim/config', '@eim/db', '@eim/domain', '@eim/observability'],

  // Left false so a local `next build` still fails on a type error rather than
  // deferring the discovery to CI. Linting is not configured here: Next 16
  // dropped the option, and `pnpm lint` covers the whole workspace anyway.
  typescript: { ignoreBuildErrors: false },

  experimental: {
    // Keeps the request body limit low by default. Section 19 bounds request
    // sizes, and the places that genuinely need more (catalog import) raise it
    // per route rather than globally.
    serverActions: { bodySizeLimit: '1mb' },
  },

  headers() {
    return Promise.resolve([
      {
        source: '/:path*',
        headers: [
          // Section 19's baseline. The Content-Security-Policy itself is set
          // per response in middleware, because it carries a per-request nonce
          // and a static header here could not.
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), payment=()',
          },
          // Cross-origin isolation defaults. Nothing here embeds third-party
          // content, so the strict values cost nothing.
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Resource-Policy', value: 'same-origin' },
        ],
      },
      {
        // Liveness and readiness must never be cached. A cached readiness
        // response is an answer about a moment that has passed, which is
        // exactly the wrong thing for an orchestrator to act on.
        source: '/api/:path(health|ready)',
        headers: [{ key: 'Cache-Control', value: 'no-store, max-age=0' }],
      },
    ]);
  },
};

export default nextConfig;
