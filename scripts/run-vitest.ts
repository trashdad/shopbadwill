// Runs one Vitest project (suite) with optional file filters:
//
//   pnpm test:unit [filter...]           e.g. pnpm test:unit -- domain/time
//
// pnpm forwards a `--` literally, and Vitest treats everything after `--` as
// "rest" arguments and silently ignores them as filters (running every test).
// So this drops `--` and passes the remaining arguments through unchanged.
// A filter is a substring of the test file path. `passWithNoTests` is false
// (vitest.config.ts), so a filter that matches no file fails the run.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SUITES = ['unit', 'contract', 'dom', 'integration'];

const [suite, ...rest] = process.argv.slice(2);
if (suite === undefined || !SUITES.includes(suite)) {
  console.error(`usage: run-vitest.ts <${SUITES.join('|')}> [filter...] [vitest options]`);
  process.exit(2);
}

const vitestArgs = ['run', '--project', suite, ...rest.filter((arg) => arg !== '--')];
console.log(`> vitest ${vitestArgs.join(' ')}`);

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vitestCli = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(process.execPath, [vitestCli, ...vitestArgs], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
