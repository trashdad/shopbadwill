// `pnpm check:permissions`: diffs the permission surface of the BUILT production
// manifests (.output/chrome-mv3, .output/firefox-mv3) against the committed
// snapshots test/snapshots/permissions.{chrome,firefox}.json. Any added or
// removed permission, host, content-script match or capability key fails.
//
//   pnpm build && pnpm build:firefox && pnpm check:permissions
//   pnpm check:permissions --update      rewrite the snapshots (review the diff!)
//
// Snapshots are taken from a build with SBW_GOOGLE_CLIENT_ID set (CI sets a dummy
// one); a build without it has no `oauth2` key, which is tolerated, with a note.
// The client id itself is never part of a snapshot.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type Target = 'chrome' | 'firefox';
export const TARGETS: readonly Target[] = ['chrome', 'firefox'];

export interface Manifest {
  manifest_version?: number;
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: { matches?: string[] }[];
  web_accessible_resources?: unknown;
  externally_connectable?: unknown;
  content_security_policy?: unknown;
  commands?: unknown;
  minimum_chrome_version?: string;
  oauth2?: { client_id?: string; scopes?: string[] };
  browser_specific_settings?: unknown;
}

export type Surface = Record<string, unknown>;

export const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function snapshotPath(target: Target): string {
  return path.join(REPO_ROOT, 'test', 'snapshots', `permissions.${target}.json`);
}

/** The parts of a manifest that grant or expose capabilities. */
export function permissionSurface(manifest: Manifest): Surface {
  return {
    manifest_version: manifest.manifest_version,
    permissions: manifest.permissions ?? [],
    optional_permissions: manifest.optional_permissions ?? [],
    host_permissions: manifest.host_permissions ?? [],
    optional_host_permissions: manifest.optional_host_permissions ?? [],
    content_script_matches: (manifest.content_scripts ?? []).map((script) => script.matches ?? []),
    web_accessible_resources: manifest.web_accessible_resources ?? null,
    externally_connectable: manifest.externally_connectable ?? null,
    content_security_policy: manifest.content_security_policy ?? null,
    commands: manifest.commands ?? {},
    minimum_chrome_version: manifest.minimum_chrome_version ?? null,
    oauth2: manifest.oauth2 ? { scopes: manifest.oauth2.scopes ?? [] } : null,
    browser_specific_settings: manifest.browser_specific_settings ?? null,
  };
}

export async function readSnapshot(target: Target): Promise<Surface> {
  return JSON.parse(await readFile(snapshotPath(target), 'utf8')) as Surface;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

/** Human-readable differences between two surfaces (empty when equal). */
export function diffSurfaces(expected: Surface, actual: Surface): string[] {
  const lines: string[] = [];
  for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const want = expected[key];
    const got = actual[key];
    if (JSON.stringify(want) === JSON.stringify(got)) continue;
    if (isStringArray(want) && isStringArray(got)) {
      const added = got.filter((v) => !want.includes(v));
      const removed = want.filter((v) => !got.includes(v));
      for (const v of added) lines.push(`  ${key}: + ${v}`);
      for (const v of removed) lines.push(`  ${key}: - ${v}`);
      if (added.length === 0 && removed.length === 0) lines.push(`  ${key}: order changed`);
    } else {
      lines.push(`  ${key}:`, `    snapshot: ${JSON.stringify(want)}`, `    built:    ${JSON.stringify(got)}`);
    }
  }
  return lines;
}

async function main(): Promise<void> {
  const update = process.argv.includes('--update');
  const clientIdConfigured = (process.env.SBW_GOOGLE_CLIENT_ID ?? '').trim() !== '';
  let failed = false;

  for (const target of TARGETS) {
    const manifestFile = path.join(REPO_ROOT, '.output', `${target}-mv3`, 'manifest.json');
    let manifest: Manifest;
    try {
      manifest = JSON.parse(await readFile(manifestFile, 'utf8')) as Manifest;
    } catch {
      console.error(`check:permissions: ${manifestFile} not found. Run \`pnpm build\` and \`pnpm build:firefox\` first.`);
      failed = true;
      continue;
    }
    const actual = permissionSurface(manifest);

    if (update) {
      await mkdir(path.dirname(snapshotPath(target)), { recursive: true });
      await writeFile(snapshotPath(target), `${JSON.stringify(actual, null, 2)}\n`);
      console.log(`check:permissions: wrote ${path.relative(REPO_ROOT, snapshotPath(target))}`);
      continue;
    }

    const expected = await readSnapshot(target);
    if (target === 'chrome' && actual.oauth2 === null && !clientIdConfigured) {
      console.log('check:permissions: chrome build has no oauth2 (SBW_GOOGLE_CLIENT_ID unset); oauth2 scopes not checked');
      expected.oauth2 = null;
    }
    const diff = diffSurfaces(expected, actual);
    if (diff.length > 0) {
      failed = true;
      console.error(`check:permissions: ${target} manifest differs from test/snapshots/permissions.${target}.json`);
      console.error(diff.join('\n'));
    } else {
      console.log(`check:permissions: ${target} OK`);
    }
  }

  if (failed) {
    console.error('If the change is intended, review it, then run `pnpm check:permissions --update` and commit the snapshots.');
    process.exit(1);
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
