import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

// Suites are Vitest projects, run through `scripts/run-vitest.ts` by the
// `test:unit`, `test:contract`, `test:dom` and `test:integration` scripts.
// WxtVitest() swaps `wxt/browser` for WXT's in-memory fake browser.
export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    // T-03 owns `setupFiles` (fakeBrowser reset, MSW server).
    setupFiles: [],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts', 'test/fakes/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'contract',
          include: ['test/contract/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          include: ['test/dom/**/*.test.{ts,tsx}'],
          environment: 'happy-dom',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
