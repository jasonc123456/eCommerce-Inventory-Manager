import { defineConfig, devices } from '@playwright/test';

import { environment, OWNER_STATE_PATH } from './src/environment';

/**
 * The browser tier (section 25, D-116).
 *
 * Section 25 asks for "supported-browser end-to-end and authentication
 * accessibility workflows", and section 2 names the supported browsers: Chrome,
 * Edge, Firefox, and Safari, including mobile Safari and mobile Chrome. Those
 * four are three engines, and all three run here.
 *
 * What this tier exists to catch is everything the other tiers structurally
 * cannot. The unit and integration tiers prove decisions; `accessibility.test.ts`
 * greps every screen's source for structural properties. None of them can open a
 * page, so none of them can see a layout that breaks at 320 pixels, a drawer
 * that traps a keyboard, a contrast failure, a form that needs JavaScript to
 * submit, or a link that a mail scanner spends before its recipient reads it.
 *
 * Two decisions about how it is split.
 *
 * Every spec runs on Chromium. Only `*.cross.spec.ts` runs on the other four
 * projects, because rendering, focus, and layout are where engines differ and
 * multi-step flows are where they do not — running a nine-step deletion journey
 * five times would cost minutes to re-prove the same server behaviour.
 *
 * Everything depends on the `install` project, which claims a clean installation
 * through the interface and saves the resulting session. That is not a fixture
 * shortcut: it is the "clean install from documentation" drill from
 * `docs/operations/pilot.md`, run on every push, against the exact gap that made
 * this application unusable on a fresh database.
 */

// Non-empty, not merely present. `scripts/e2e.sh` forwards CI into the
// container unconditionally, because `docker compose exec` passes none of the
// host environment — so outside CI the variable arrives set and empty, and a
// presence check would put every local run into retry-and-no-reuse mode.
const CI = (process.env['CI'] ?? '') !== '';

export default defineConfig({
  testDir: './tests',
  outputDir: './.playwright/results',
  fullyParallel: false,
  forbidOnly: CI,
  // One retry, and only where a run is not being watched. A retry on a
  // developer's machine hides the flake from the person best placed to fix it.
  retries: CI ? 1 : 0,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },

  reporter: CI
    ? [['github'], ['html', { outputFolder: './.playwright/report', open: 'never' }]]
    : [['list'], ['html', { outputFolder: './.playwright/report', open: 'never' }]],

  use: {
    baseURL: environment.baseUrl,
    // The terminator in front of the application holds a self-signed
    // certificate it generated for itself. See src/tls-proxy.ts.
    ignoreHTTPSErrors: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'install',
      testMatch: /install\.setup\.ts$/u,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'chromium',
      testMatch: /.*\.spec\.ts$/u,
      dependencies: ['install'],
      use: { ...devices['Desktop Chrome'], storageState: OWNER_STATE_PATH },
    },
    {
      name: 'firefox',
      testMatch: /.*\.cross\.spec\.ts$/u,
      dependencies: ['install'],
      use: { ...devices['Desktop Firefox'], storageState: OWNER_STATE_PATH },
    },
    {
      // Stands in for Safari, which has no driver of its own on Linux and is
      // the engine most likely to disagree about layout.
      name: 'webkit',
      testMatch: /.*\.cross\.spec\.ts$/u,
      dependencies: ['install'],
      use: { ...devices['Desktop Safari'], storageState: OWNER_STATE_PATH },
    },
    {
      name: 'mobile-safari',
      testMatch: /.*\.cross\.spec\.ts$/u,
      dependencies: ['install'],
      use: { ...devices['iPhone 14'], storageState: OWNER_STATE_PATH },
    },
    {
      name: 'mobile-chrome',
      testMatch: /.*\.cross\.spec\.ts$/u,
      dependencies: ['install'],
      use: { ...devices['Pixel 7'], storageState: OWNER_STATE_PATH },
    },
  ],

  // Both processes live in this container. The application listens on plain
  // HTTP and the terminator puts HTTPS in front of it, which is the shape
  // production runs in and the shape section 19's production configuration
  // rules require.
  //
  // The standalone server, not `next start`. That is what the release image's
  // CMD runs (see the Dockerfile), and `next start` against an `output:
  // 'standalone'` build is a combination Next.js prints a warning about — so a
  // tier that used it would be testing a server no release ever runs. The tree
  // it serves is assembled by `scripts/e2e.sh` immediately after the build,
  // because the static assets and the public directory live outside the
  // standalone output by design.
  webServer: [
    {
      command: 'node apps/web/.next/standalone/apps/web/server.js',
      cwd: '../..',
      env: { PORT: '3100', HOSTNAME: '127.0.0.1' },
      url: 'http://127.0.0.1:3100/api/health',
      reuseExistingServer: !CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'pnpm --filter @eim/e2e serve:tls',
      cwd: '../..',
      url: `${environment.baseUrl}/api/health`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: !CI,
      timeout: 60_000,
    },
  ],
});
