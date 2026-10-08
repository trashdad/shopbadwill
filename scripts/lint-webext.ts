// `pnpm lint:webext`: runs `web-ext lint` on the built Firefox extension
// (.output/firefox-mv3) and fails on ANY warning or error, with one exception:
// the single UNSAFE_VAR_ASSIGNMENT / innerHTML warning that points at Preact's
// own dangerouslySetInnerHTML handling inside the chunk that contains the Preact
// runtime. That is the same allowlist entry as scripts/check-prod-bundle.ts and
// uses the same detector, so a first-party innerHTML (or a second Preact one)
// still fails. Notices are printed but do not fail the run.
//
//   pnpm build:firefox && pnpm lint:webext [-- --self-hosted]
// Extra CLI args are forwarded to `web-ext lint` (the release workflow passes --self-hosted).
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedInnerHtmlOffsets } from './check-prod-bundle';

interface LintMessage {
  code?: string;
  message?: string;
  file?: string;
  line?: number;
  column?: number;
}

interface LintReport {
  errors: LintMessage[];
  warnings: LintMessage[];
  notices: LintMessage[];
}

const MAX_ALLOWED_PREACT_WARNINGS = 1;
// web-ext reports the column of the assignment's member expression, a couple of
// characters before the `innerHTML` property name.
const COLUMN_SLACK_BEFORE = 4;
const COLUMN_SLACK_AFTER = 12;

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDir = path.join(root, '.output', 'firefox-mv3');

/** web-ext lint arguments: fixed ones plus any extra CLI args (a leading `--` separator is dropped). */
export function webExtLintArgs(dir: string, extra: readonly string[]): string[] {
  const forwarded = extra[0] === '--' ? extra.slice(1) : extra;
  return ['lint', '--source-dir', dir, '--output', 'json', ...forwarded];
}

function describe(m: LintMessage): string {
  const where = m.file === undefined ? '' : `${m.file}:${String(m.line ?? '?')}:${String(m.column ?? '?')}  `;
  return `${where}${m.code ?? 'UNKNOWN'}: ${m.message ?? ''}`;
}

/** True when this warning is the Preact runtime's own innerHTML assignment. */
async function isPreactInnerHtmlWarning(m: LintMessage): Promise<boolean> {
  if (m.code !== 'UNSAFE_VAR_ASSIGNMENT' || !/innerHTML/.test(m.message ?? '')) return false;
  if (m.file === undefined || m.line === undefined || m.column === undefined) return false;
  let text: string;
  try {
    text = await readFile(path.join(sourceDir, m.file), 'utf8');
  } catch {
    return false;
  }
  const lines = text.split('\n');
  const lineStart = lines.slice(0, m.line - 1).reduce((sum, l) => sum + l.length + 1, 0);
  const offset = lineStart + m.column;
  return [...allowedInnerHtmlOffsets(text)].some(
    (at) => offset >= at - COLUMN_SLACK_BEFORE && offset <= at + COLUMN_SLACK_AFTER,
  );
}

async function main(): Promise<void> {
  const webExtCli = path.join(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js');
  const result = spawnSync(
    process.execPath,
    [webExtCli, ...webExtLintArgs(sourceDir, process.argv.slice(2))],
    { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  const start = result.stdout.indexOf('{');
  let report: LintReport;
  try {
    report = JSON.parse(result.stdout.slice(start)) as LintReport;
  } catch {
    console.error('lint:webext: could not read web-ext output (is .output/firefox-mv3 built? run `pnpm build:firefox`)');
    console.error(result.stdout);
    console.error(result.stderr);
    process.exit(1);
  }

  const failures: LintMessage[] = [...report.errors];
  let allowed = 0;
  for (const warning of report.warnings) {
    if (allowed < MAX_ALLOWED_PREACT_WARNINGS && (await isPreactInnerHtmlWarning(warning))) {
      allowed += 1;
      console.log(`lint:webext: allowlisted (Preact runtime) ${describe(warning)}`);
    } else {
      failures.push(warning);
    }
  }
  for (const notice of report.notices) console.log(`lint:webext: notice ${describe(notice)}`);

  if (failures.length > 0) {
    for (const f of failures) console.error(`lint:webext: ${describe(f)}`);
    console.error(`lint:webext: ${String(failures.length)} problem(s)`);
    process.exit(1);
  }
  console.log(`lint:webext: OK (${String(report.notices.length)} notices, ${String(allowed)} allowlisted)`);
}

// Only run when executed directly (so webExtLintArgs stays importable by tests).
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
