// `pnpm sign:firefox`: signs .output/firefox-mv3 as a self-distributed (unlisted)
// add-on with `web-ext sign --channel unlisted --upload-source-code`.
//
// Needs AMO_JWT_ISSUER and AMO_JWT_SECRET (addons.mozilla.org API credentials,
// stored as repository secrets). WITHOUT them this skips cleanly with exit 0 and
// makes no network call. The keys are handed to web-ext through its
// WEB_EXT_API_KEY / WEB_EXT_API_SECRET environment variables, never argv.
//
//   pnpm build:firefox && pnpm sign:firefox path/to/sources.zip
//
// Output: .output/signed/*.xpi. AMO requires the human-readable source, so a
// source zip is mandatory; the release workflow builds it with `git archive`.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceDir = path.join(root, '.output', 'firefox-mv3');
const artifactsDir = path.join(root, '.output', 'signed');

const issuer = process.env.AMO_JWT_ISSUER?.trim() ?? '';
const secret = process.env.AMO_JWT_SECRET?.trim() ?? '';

if (issuer === '' || secret === '') {
  console.log('sign:firefox: skipped (AMO_JWT_ISSUER / AMO_JWT_SECRET not set); no signing attempted, no network used.');
  process.exit(0);
}

const sourceArg = process.argv[2] ?? process.env.SBW_SOURCE_ZIP;
if (sourceArg === undefined || sourceArg === '' || !existsSync(path.resolve(sourceArg))) {
  console.error('sign:firefox: AMO keys are set but the source zip is missing. Pass its path as the first argument (or SBW_SOURCE_ZIP).');
  process.exit(1);
}
if (!existsSync(path.join(sourceDir, 'manifest.json'))) {
  console.error('sign:firefox: .output/firefox-mv3 is not built (run `pnpm build:firefox`).');
  process.exit(1);
}

const webExtCli = path.join(root, 'node_modules', 'web-ext', 'bin', 'web-ext.js');
const result = spawnSync(
  process.execPath,
  [
    webExtCli, 'sign',
    '--source-dir', sourceDir,
    '--artifacts-dir', artifactsDir,
    '--channel', 'unlisted',
    '--upload-source-code', path.resolve(sourceArg),
  ],
  { cwd: root, stdio: 'inherit', env: { ...process.env, WEB_EXT_API_KEY: issuer, WEB_EXT_API_SECRET: secret } },
);
if (result.status !== 0) {
  console.error(`sign:firefox: web-ext sign failed (exit ${String(result.status)})`);
  process.exit(result.status ?? 1);
}
const xpis = existsSync(artifactsDir) ? readdirSync(artifactsDir).filter((f) => f.endsWith('.xpi')) : [];
if (xpis.length === 0) {
  console.error('sign:firefox: web-ext reported success but produced no .xpi');
  process.exit(1);
}
console.log(`sign:firefox: signed ${xpis.map((f) => path.join('.output', 'signed', f)).join(', ')}`);
