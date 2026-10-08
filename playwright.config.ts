import { defineConfig } from '@playwright/test';

// Chromium E2E. Specs load the unpacked extension with
// `chromium.launchPersistentContext` + `--load-extension` (fixtures land with
// T-39). Branded Chrome ignores `--load-extension`, so the bundled `chromium`
// channel is used: `pnpm exec playwright install chromium`.
export default defineConfig({
  testDir: 'test/e2e/chromium',
  outputDir: 'test-results',
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium', channel: 'chromium' },
    },
  ],
});
