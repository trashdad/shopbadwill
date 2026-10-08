// Runs one Vitest project (suite) with an optional path filter:
//
//   pnpm test:unit [path...]           e.g. pnpm test:unit -- src/domain/time
//
// - A leading `--` (as written in task gates) is dropped.
// - A filter under `src/` is mapped to the suite's mirror under `test/<suite>/`
//   (src/domain/time -> test/unit/domain/time), because tests live in
//   test/<suite>/ mirroring src/.
// - With no filter, an empty suite passes. With a filter that matches no test
//   file, the run fails, so a mistyped gate can never pass vacuously.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCLI } from 'vitest/node';

const SUITES = ['unit', 'contract', 'dom', 'integration'];

const [suiteArg, ...rest] = process.argv.slice(2);
if (suiteArg === undefined || !SUITES.includes(suiteArg)) {
  console.error(`usage: node scripts/run-vitest.ts <${SUITES.join('|')}> [filter...] [vitest options]`);
  process.exit(2);
}
const suite: string = suiteArg;

const args = rest.filter((arg) => arg !== '--');
const filters = new Set(parseCLI(['vitest', 'run', ...args]).filter);

function mapFilter(filter: string): string {
  const normalized = filter.replaceAll('\\', '/').replace(/^\.\//, '');
  if (!normalized.startsWith('src/')) return normalized;
  const mirrored = `test/${suite}/${normalized.slice('src/'.length)}`;
  console.log(`test:${suite}: filter ${normalized} -> ${mirrored}`);
  return mirrored;
}

const vitestArgs = [
  'run',
  '--project',
  suite,
  ...(filters.size === 0 ? ['--passWithNoTests'] : []),
  ...args.map((arg) => (filters.has(arg) ? mapFilter(arg) : arg)),
];

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const vitestCli = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(process.execPath, [vitestCli, ...vitestArgs], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
