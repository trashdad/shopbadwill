// `pnpm release <patch|minor|major|X.Y.Z> [--dry-run]`: the local half of a release.
//
//   * bumps "version" in package.json (wxt.config.ts reads it from there, so the
//     manifest follows),
//   * turns the CHANGELOG.md "Unreleased" section into a dated "[X.Y.Z]" section
//     and leaves a fresh empty "Unreleased" above it.
//
// It does NOT commit, tag or push. Afterwards, review the diff, commit it, then
// `git tag vX.Y.Z && git push origin vX.Y.Z`; the tag triggers
// .github/workflows/release.yml.
//
// `pnpm release notes [X.Y.Z]` prints that version's changelog section (falling
// back to "Unreleased") for the workflow's GitHub release body.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export function bumpVersion(current: string, target: string): string {
  const m = SEMVER.exec(current);
  if (m === null) throw new Error(`current version "${current}" is not X.Y.Z`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  let next: string;
  if (target === 'major') next = `${String(major + 1)}.0.0`;
  else if (target === 'minor') next = `${String(major)}.${String(minor + 1)}.0`;
  else if (target === 'patch') next = `${String(major)}.${String(minor)}.${String(patch + 1)}`;
  else if (SEMVER.test(target)) next = target;
  else throw new Error(`"${target}" is not patch, minor, major or X.Y.Z`);
  if (next === current) throw new Error(`version is already ${current}`);
  return next;
}

/** Moves the Unreleased body under a new dated heading; keeps an empty Unreleased on top. */
export function rollChangelog(changelog: string, version: string, date: string): string {
  const heading = /^## \[Unreleased\][^\n]*\n/m;
  const m = heading.exec(changelog);
  if (m === null) throw new Error('CHANGELOG.md has no "## [Unreleased]" section');
  const at = m.index + m[0].length;
  return `${changelog.slice(0, m.index)}## [Unreleased]\n\n## [${version}] - ${date}\n${changelog.slice(at)}`;
}

/** Body of "## [version]" (or "## [Unreleased]" when absent), up to the next "## " heading. */
export function changelogSection(changelog: string, version: string): string {
  const all = changelog.split('\n');
  for (const name of [version, 'Unreleased']) {
    const start = all.findIndex((l) => l.startsWith(`## [${name}]`));
    if (start === -1) continue;
    const lines = all.slice(start + 1);
    const end = lines.findIndex((l) => l.startsWith('## '));
    const body = (end === -1 ? lines : lines.slice(0, end)).join('\n').trim();
    if (body !== '') return body;
  }
  return '';
}

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkgPath = path.join(root, 'package.json');
const changelogPath = path.join(root, 'CHANGELOG.md');

function main(argv: string[]): void {
  const dryRun = argv.includes('--dry-run');
  const args = argv.filter((a) => !a.startsWith('--'));
  const pkgText = readFileSync(pkgPath, 'utf8');
  const current = (JSON.parse(pkgText) as { version: string }).version;

  if (args[0] === 'notes') {
    console.log(changelogSection(readFileSync(changelogPath, 'utf8'), args[1] ?? current));
    return;
  }
  if (args.length !== 1) {
    console.error('usage: pnpm release <patch|minor|major|X.Y.Z> [--dry-run]\n       pnpm release notes [X.Y.Z]');
    process.exit(2);
  }
  const next = bumpVersion(current, args[0] ?? '');
  const date = new Date().toISOString().slice(0, 10);
  const newPkg = pkgText.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`);
  const newChangelog = rollChangelog(readFileSync(changelogPath, 'utf8'), next, date);

  if (dryRun) {
    console.log(`release (dry run): ${current} -> ${next}; would update package.json and CHANGELOG.md (${date}). Nothing written.`);
    return;
  }
  writeFileSync(pkgPath, newPkg);
  writeFileSync(changelogPath, newChangelog);
  console.log(`release: ${current} -> ${next}`);
  console.log(`Next: review, commit, then\n  git tag v${next} && git push origin v${next}\nThe tag triggers .github/workflows/release.yml.`);
}

// Only run when executed directly (so the helpers above stay importable by tests).
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`release: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
