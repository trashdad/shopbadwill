// Test build: `pnpm build:test [wxt build options]`, e.g. `pnpm build:test -b firefox --mv3`.
//
// Sets SBW_TEST=1 (wxt.config.ts: `import.meta.env.SBW_TEST` is true and the
// manifest gains http://127.0.0.1/* for the fake servers) and builds in mode
// "test", so the output goes to .output/<browser>-mv3-test and never replaces a
// production build. T-39 extends this (fake-server base URLs).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const wxtCli = path.join(root, 'node_modules', 'wxt', 'bin', 'wxt.mjs');
const args = process.argv.slice(2).filter((arg) => arg !== '--');

const result = spawnSync(process.execPath, [wxtCli, 'build', '--mode', 'test', ...args], {
  cwd: root,
  env: { ...process.env, SBW_TEST: '1' },
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
