// `pnpm test:e2e:firefox [--no-build] [pytest args...]`: the Firefox E2E
// harness (T-12, S-6; docs/spikes/S-6.md).
//
// 1. Builds the Firefox test extension (`pnpm build:test -b firefox --mv3`,
//    output .output/firefox-mv3-test), unless --no-build is given.
// 2. Runs pytest in test/e2e/firefox. The specs install that build temporarily
//    in Firefox through Selenium/geckodriver. One-time setup (a venv is best;
//    SBW_PYTHON points at its python):
//      python -m pip install -r test/e2e/firefox/requirements.txt -c test/e2e/firefox/constraints.txt
//
// Other arguments go to pytest, which runs in test/e2e/firefox, for example
// `pnpm test:e2e:firefox -k badge` or `pnpm test:e2e:firefox smoke_test.py`.
// A literal `--` (as pnpm forwards it) is dropped. A filter that selects no
// test fails (pytest exit code 5), so a mistyped gate cannot pass vacuously.
//
// Environment: SBW_PYTHON (Python to use), plus the harness's SBW_FIREFOX_BIN,
// SBW_GECKODRIVER and SBW_E2E_HEADED (test/e2e/firefox/harness/firefox.py).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const harnessDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(harnessDir, '..', '..', '..');
const extensionDir = path.join(root, '.output', 'firefox-mv3-test');

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const build = !args.includes('--no-build');
const pytestArgs = args.filter((arg) => arg !== '--no-build');

function run(command: string, commandArgs: string[], cwd = root, env = process.env): number {
  const result = spawnSync(command, commandArgs, { cwd, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function findPython(): string[] {
  const fromEnv = process.env.SBW_PYTHON;
  const candidates = fromEnv
    ? [[fromEnv]]
    : process.platform === 'win32'
      ? [['python'], ['py', '-3']]
      : [['python3'], ['python']];
  for (const [command = '', ...prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, '-c', 'import sys; sys.exit(sys.version_info < (3, 10))']);
    if (probe.status === 0) return [command, ...prefix];
  }
  throw new Error(`No Python 3.10+ found (tried ${candidates.map((c) => c.join(' ')).join(', ')}). Set SBW_PYTHON.`);
}

if (build) {
  const tsxCli = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const status = run(process.execPath, [tsxCli, 'scripts/build-test.ts', '-b', 'firefox', '--mv3']);
  if (status !== 0) process.exit(status);
}

const [python = 'python', ...pythonPrefix] = findPython();
const deps = spawnSync(python, [...pythonPrefix, '-c', 'import selenium, pytest, cryptography'], { encoding: 'utf8' });
if (deps.status !== 0) {
  console.error(
    'test:e2e:firefox: the Python harness dependencies are missing. Install them with\n' +
      `  ${[python, ...pythonPrefix].join(' ')} -m pip install -r test/e2e/firefox/requirements.txt` +
      ' -c test/e2e/firefox/constraints.txt\n' +
      deps.stderr.trim(),
  );
  process.exit(1);
}

console.log(`> ${[python, ...pythonPrefix].join(' ')} -m pytest ${pytestArgs.join(' ')}  (in test/e2e/firefox)`);
process.exit(
  run(python, [...pythonPrefix, '-m', 'pytest', ...pytestArgs], harnessDir, {
    ...process.env,
    SBW_FIREFOX_EXTENSION_DIR: extensionDir,
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
  }),
);
