// Runs the Chromium E2E suite with an optional spec filter:
//
//   pnpm test:e2e:chromium [filter...]   e.g. pnpm test:e2e:chromium -- overlay
//
// - A leading `--` (as written in task gates) is dropped; Playwright would
//   otherwise ignore every filter after it and run all specs.
// - With no filter, an empty suite passes. With a filter that matches no spec,
//   the run fails, so a mistyped gate can never pass vacuously.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `playwright test` options that take a separate value (`--opt value`), from
// `playwright test --help` (1.63).
const OPTIONS_WITH_VALUE = new Set([
  '--add-reporter', '--browser', '-c', '--config', '-g', '--grep', '-G', '--grep-invert',
  '--global-timeout', '-j', '--workers', '--last-failed-file', '--max-failures', '--output',
  '--project', '--repeat-each', '--reporter', '--retries', '--run-agents', '--shard',
  '--test-list', '--test-list-invert', '--timeout', '--trace', '--tsconfig', '--ui-host',
  '--ui-port', '--update-source-method',
]);

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const hasFilter = args.some(
  (arg, i) => !arg.startsWith('-') && !OPTIONS_WITH_VALUE.has(args[i - 1] ?? ''),
);

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const playwrightCli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const playwrightArgs = ['test', ...(hasFilter ? [] : ['--pass-with-no-tests']), ...args];

const result = spawnSync(process.execPath, [playwrightCli, ...playwrightArgs], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
