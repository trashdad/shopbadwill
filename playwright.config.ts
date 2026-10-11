import { defineConfig } from '@playwright/test';

// Chromium E2E. Specs load the unpacked extension with
// `chromium.launchPersistentContext` + `--load-extension` (fixtures land with
// T-39). Branded Chrome ignores `--load-extension`, so the bundled `chromium`
// channel is used: `pnpm exec playwright install chromium`.
//
// webServer: the three fake servers every spec may need (T-39):
//   fake:sgw          buyerapi, 127.0.0.1:8787 (CI starts it too: reused)
//   fake:google       Google API, 127.0.0.1:8788 (CI starts it too: reused)
//   serve-fake-site   the fixture search page, 127.0.0.1:8789
// `reuseExistingServer` lets CI's background-started copies win and keeps a
// local run self-contained (Playwright starts what is missing and stops what
// it started).
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
      url: 'http://127.0.0.1:8787/__log',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'pnpm fake:google',
      url: 'http://127.0.0.1:8788/__admin/state',
      reuseExistingServer: true,
      timeout: 60_000,
    },
    {
      command: 'pnpm exec tsx scripts/serve-fake-site.ts',
      url: 'http://127.0.0.1:8789/',
      reuseExistingServer: true,
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
