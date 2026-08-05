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
        'packages/mail/src/**/*.ts',
        'packages/observability/src/**/*.ts',
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
        // Section 25: at least 80% overall.
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
