import { defineConfig } from '@playwright/test';

import { FAKE_BUYERAPI, FAKE_GOOGLE, FAKE_PORT_ENV, FAKE_PORTS, FAKE_SITE } from './test/e2e/chromium/network';

// Chromium E2E. Specs load the unpacked extension with
// `chromium.launchPersistentContext` + `--load-extension` (fixtures land with
// T-39). Branded Chrome ignores `--load-extension`, so the bundled `chromium`
// channel is used: `pnpm exec playwright install chromium`.
//
// webServer: the three fake servers every spec may need (T-39), each on this
// run's own port (T-39b; test/e2e/chromium/network.ts):
//   fake:sgw          buyerapi, 127.0.0.1:$SBW_FAKE_SGW_PORT  (default 8787)
//   fake:google       Google API, 127.0.0.1:$FAKE_GOOGLE_PORT (default 8788)
//   serve-fake-site   the fixture search page, 127.0.0.1:$SBW_FAKE_SITE_PORT (default 8789)
// `pnpm test:e2e:chromium` (scripts/run-playwright.ts) sets the three vars to
// free ports, so parallel runs (two worktrees) never share a fake. A server
// already answering on a port is never reused: it belongs to another process,
// whose teardown would break this run, so Playwright fails fast instead.
// Playwright starts the servers and stops them after the run.
export default defineConfig({
  testDir: 'test/e2e/chromium',
  outputDir: 'test-results',
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 120_000,
  use: {
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm fake:sgw',
      url: `${FAKE_BUYERAPI}/__log`,
      env: { [FAKE_PORT_ENV.sgw]: String(FAKE_PORTS.sgw) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm fake:google',
      url: `${FAKE_GOOGLE}/__admin/state`,
      env: { [FAKE_PORT_ENV.google]: String(FAKE_PORTS.google) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'pnpm exec tsx scripts/serve-fake-site.ts',
      url: `${FAKE_SITE}/`,
      env: { [FAKE_PORT_ENV.site]: String(FAKE_PORTS.site) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium', channel: 'chromium' },
    },
  ],
});
