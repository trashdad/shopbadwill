import { configDefaults, defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

// Suites are Vitest projects, run through `scripts/run-vitest.ts` by the
// `test:unit`, `test:contract`, `test:dom` and `test:integration` scripts.
// WxtVitest() swaps `wxt/browser` for WXT's in-memory fake browser.
//
// Tests live under test/, scripts/ and companion/. `unit` takes everything
// that is not in another suite's folder.
const SUITE_DIRS = ['test/contract/**', 'test/dom/**', 'test/integration/**'];
const NEVER = [...configDefaults.exclude, 'test/e2e/**', 'scripts/*-probe/**'];

export default defineConfig({
  plugins: [WxtVitest()],
  test: {
    // Every suite has at least one test; a filter that matches nothing fails.
    passWithNoTests: false,
    // T-03 owns `setupFiles` (fakeBrowser reset, MSW server).
    setupFiles: ['test/setup/vitest.setup.ts'],
    // Node 25's built-in localStorage warns when touched without a backing file
    // (MSW probes it). Tests never need it; happy-dom brings its own.
    execArgv: ['--no-experimental-webstorage'],
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          include: ['test/**/*.test.{ts,tsx}', 'scripts/**/*.test.ts', 'companion/**/*.test.ts'],
          exclude: [...NEVER, ...SUITE_DIRS],
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'contract',
          include: ['test/contract/**/*.test.ts'],
          exclude: NEVER,
          environment: 'node',
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          include: ['test/dom/**/*.test.{ts,tsx}'],
          exclude: NEVER,
          environment: 'happy-dom',
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          exclude: NEVER,
          environment: 'node',
        },
      },
    ],
  },
});
