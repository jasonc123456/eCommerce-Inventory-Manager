import { defineConfig } from 'vitest/config';

/**
 * Two projects, matching the execution tiers in section 25.
 *
 * `unit` is fast, deterministic, and runs on every change. `integration` needs a
 * real PostgreSQL 18 and runs separately, because a suite that silently degrades
 * to a fake when the database is missing proves nothing about constraints,
 * locking, or transactions.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
          exclude: ['**/*.integration.test.ts', '**/node_modules/**', '**/dist/**'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          include: ['packages/*/src/**/*.integration.test.ts'],
          exclude: ['**/node_modules/**', '**/dist/**'],
          // Schema creation and migration against a real engine is not fast.
          testTimeout: 60_000,
          hookTimeout: 120_000,
          // Each file creates its own database; running files in parallel against
          // one server is fine, but keep concurrency modest so a laptop-sized
          // PostgreSQL is not the bottleneck.
          fileParallelism: false,
        },
      },
    ],

    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'lcov'],
      reportsDirectory: 'coverage',
      // Only packages carrying real logic are measured. Skeleton entry points
      // gain their coverage requirement when they gain behavior in M1.
      include: [
        'packages/domain/src/**/*.ts',
        'packages/audit/src/**/*.ts',
        'packages/ratelimit/src/**/*.ts',
        'packages/authz/src/**/*.ts',
        'packages/config/src/**/*.ts',
        'packages/crypto/src/**/*.ts',
        'packages/identity/src/**/*.ts',
        'packages/mail/src/**/*.ts',
        'packages/observability/src/**/*.ts',
        // The provider HTTP layer, which is where section 19's SSRF boundary
        // actually lives. The transport itself is excluded below; the policy
        // that decides what may be reached is measured here.
        'packages/providers/src/http/**/*.ts',
        // Notification verification, which is the other half of the same
        // boundary: the SSRF policy decides what this application may reach,
        // and this decides what may reach it. The modules that need a database
        // are excluded below and measured by the integration project.
        'packages/integrations/src/ebay/notifications/**/*.ts',
        // The WooCommerce store description and REST client. Both are section
        // 19 and section 14 boundaries: one decides which address is the store
        // and which is somebody else's network, the other decides that a
        // credential never reaches a URL.
        'packages/integrations/src/woocommerce/store.ts',
        'packages/integrations/src/woocommerce/client.ts',
        // The other half of that boundary: what may reach this application.
        'packages/integrations/src/woocommerce/webhooks/signature.ts',
        // The web tier's security-critical pure helpers. The screens and server
        // actions are not measured here: they need a browser and a session, and
        // the integration and Compose tiers are where they are exercised.
        'apps/web/src/lib/redirects.ts',
        'apps/web/src/lib/client-address.ts',
        'apps/web/src/lib/forms.ts',
      ],
      exclude: [
        '**/*.test.ts',
        '**/index.ts',
        '**/cli/**',
        '**/dist/**',
        // Exercised by the integration project against a real database, which
        // the unit project does not run. Measuring it here would report a
        // coverage gap that the suite it belongs to already fills.
        'packages/audit/src/query.ts',
        'packages/audit/src/recorder.ts',
        'packages/ratelimit/src/limiter.ts',
        'packages/ratelimit/src/pressure.ts',
        // Wraps nodemailer's transport. What is worth asserting is the failure
        // describer, which is tested; the rest is configuration handed to a
        // library and would need a live SMTP server to mean anything.
        'packages/mail/src/mailer.ts',
        'packages/identity/src/sessions.ts',
        'packages/identity/src/challenges.ts',
        'packages/identity/src/bootstrap.ts',
        'packages/identity/src/memberships.ts',
        'packages/identity/src/passkeys.ts',
        'packages/identity/src/twofactor.ts',
        // Node's HTTP client with a pinned address, a byte ceiling, and a
        // timeout. Exercising it needs a real listening socket, and what the
        // assertions would prove is that Node can make a request. The decisions
        // it carries out are all in client.ts, which is measured.
        'packages/providers/src/http/node-transport.ts',
        // The notification modules that write to the database. Their guarantees
        // — persist before acknowledge, one row per business, an erasure that
        // actually erases — are only meaningful against a real PostgreSQL, and
        // the integration project is where they are proven.
        'packages/integrations/src/ebay/notifications/destination.ts',
        'packages/integrations/src/ebay/notifications/topics.ts',
        'packages/integrations/src/ebay/notifications/intake.ts',
        'packages/integrations/src/ebay/notifications/deletion.ts',
      ],
      thresholds: {
        // Section 25: at least 90% branch coverage in the inventory,
        // authentication, authorization, and security domains.
        'packages/domain/src/**/*.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'packages/authz/src/**/*.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'packages/crypto/src/**/*.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        // The SSRF boundary is a security domain in section 25's sense: what it
        // refuses is the protection, so an unmeasured branch here is an
        // unmeasured refusal.
        'packages/providers/src/http/**/*.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        // A notification's signature is the only thing standing between a
        // public endpoint and an irreversible erasure, so an unmeasured branch
        // here is an unmeasured refusal in exactly section 25's sense.
        'packages/integrations/src/ebay/notifications/**/*.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        // Same reasoning on the WooCommerce side: what these two refuse — a
        // private address dressed as a store, a credential in a URL — is the
        // protection, so an unmeasured branch is an unmeasured refusal.
        'packages/integrations/src/woocommerce/store.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'packages/integrations/src/woocommerce/client.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'packages/integrations/src/woocommerce/webhooks/signature.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        // Section 25: at least 80% overall.
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
