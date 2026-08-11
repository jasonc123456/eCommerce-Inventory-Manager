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
        // Quota ceilings and the health verdict. Both are pure decisions whose
        // branches are the behaviour: an unmeasured one is a priority that
        // never gets throttled or a fault that never gets named. The ledger and
        // the health service they sit behind touch the database and are proven
        // by the integration project instead.
        'packages/integrations/src/quota-policy.ts',
        'packages/integrations/src/health-policy.ts',
        // When a failed job runs again, and when it stops. Pure and clock-free
        // on purpose: the ten-attempt ceiling and the 24-hour window are only
        // testable as properties because nothing in here reads a clock. The
        // queue and the runner around it need a database and a worker loop and
        // are proven by the integration project instead.
        'packages/jobs/src/retry.ts',
        // How often a connection is swept and why it is not what was asked
        // for. Pure for the same reason the retry schedule is: the adaptation
        // rules are only testable as properties if nothing in them reads a
        // clock or a database.
        'packages/sync/src/cadence.ts',
        // What a person agreed to, and for how long that stays true. Both are
        // the confirmation gate rather than decoration around it: the hash is
        // what makes a confirmation refer to one exact set of values, and the
        // windows are what stop a stale one being applied to different ones.
        'packages/review/src/fingerprint.ts',
        'packages/review/src/freshness.ts',
        // Section 6's conversion matrix and what a converted draft would say.
        // Both are pure decision tables, and in both the refusals and the
        // absences are the behaviour: an unmeasured branch is a product type
        // converted that should not have been, or a field silently dropped.
        'packages/listings/src/draft-eligibility.ts',
        'packages/listings/src/draft-fields.ts',
        // Decimal arithmetic on prices. The whole reason prices are stored as
        // strings is undone by one comparison screen that parses them into
        // doubles, so this is measured like the rest of the safety domain.
        'packages/listings/src/money.ts',
        // Which listings may be returned to sale. The refusal that matters —
        // an ended listing is never relisted by a restock — is a branch, so an
        // unmeasured one here is a listing recreated that nobody asked for.
        'packages/listings/src/restock-eligibility.ts',
        // The V-03 gate. What it refuses is the protection: an unmeasured
        // branch here is a copied order that halves a shop's stock figures.
        'packages/listings/src/suppression.ts',
        // When a postage quote stops counting, and which of several rates is
        // the cheapest. Both decide whether money may be spent and on what, and
        // both are pure so that they can be tested without waiting for a
        // carrier to withdraw a rate.
        'packages/shipping/src/rate-selection.ts',
        // What a model is allowed to have said. Section 18's protected facts are
        // enforced here and nowhere else, which makes this a security domain in
        // section 25's sense: an unmeasured branch is a price, a SKU, or a
        // fabricated product identifier arriving on a listing from a model.
        'packages/ai/src/output.ts',
        'packages/ai/src/protected-fields.ts',
        // What a month of asking is allowed to cost. Pure and clock-free so the
        // ceilings can be tested without waiting for a month or a bill.
        'packages/ai/src/budget.ts',
        // Everything this application discloses to a third party is assembled
        // here. Section 18's privacy rules are properties of this output, so an
        // unmeasured branch is data leaving in a shape nobody checked.
        'packages/ai/src/request.ts',
        // The two real endpoints. What is measured is the translation — which
        // refusal becomes which outcome — because a misclassified failure is a
        // credential retried into a lockout or a rate limit hammered.
        'packages/ai/src/endpoints.ts',
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
        'packages/integrations/src/quota-policy.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'packages/integrations/src/health-policy.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        // An unmeasured branch here is a job that retries when it should have
        // stopped, or stops when it should have retried. Both are section 25
        // inventory-safety failures: the first hammers a provider into a
        // lockout, the second silently abandons a quantity write.
        'packages/jobs/src/retry.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        // An unmeasured branch here is a throttle that never lifts or one that
        // never applies: the first stalls synchronization silently, the second
        // spends a provider quota until the connection is cut off.
        'packages/sync/src/cadence.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        // An unmeasured branch here is a confirmation that passes when it should
        // have been refused. That is section 25's security domain exactly: what
        // these two refuse is the whole protection, and section 3's exclusion of
        // automatic publication and recurring price changes rests on them.
        'packages/review/src/fingerprint.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'packages/review/src/freshness.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'packages/listings/src/draft-eligibility.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'packages/listings/src/draft-fields.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'packages/listings/src/money.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'packages/listings/src/restock-eligibility.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'packages/listings/src/suppression.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'packages/shipping/src/rate-selection.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        // An unmeasured branch here is a protected fact that reached a screen,
        // or a malformed answer that was treated as a suggestion. Both are the
        // failures section 18 exists to prevent.
        'packages/ai/src/output.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'packages/ai/src/protected-fields.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        // An unmeasured branch here is a ceiling that never refuses, which is
        // section 18's spend limit quietly absent.
        'packages/ai/src/budget.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'packages/ai/src/request.ts': {
          branches: 90,
          functions: 90,
          lines: 90,
          statements: 90,
        },
        'packages/ai/src/endpoints.ts': {
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
