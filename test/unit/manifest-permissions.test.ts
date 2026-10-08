import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Builds both production manifests exactly as `pnpm build` and
// `pnpm build:firefox` do (same wxt.config.ts, mode "production", MV3), but
// into .output/manifest-test/ so the real .output/<browser>-mv3 builds are left
// alone, then checks them against the permissions table (§2.5) and a committed
// snapshot. Any added permission, host or manifest capability fails.

type Target = 'chrome' | 'firefox';

interface Manifest {
  manifest_version?: number;
  permissions?: string[];
  optional_permissions?: string[];
  host_permissions?: string[];
  optional_host_permissions?: string[];
  content_scripts?: { matches?: string[] }[];
  web_accessible_resources?: unknown;
  externally_connectable?: unknown;
  content_security_policy?: unknown;
  commands?: Record<string, { suggested_key?: Record<string, string>; description?: string }>;
  minimum_chrome_version?: string;
  oauth2?: { client_id: string; scopes: string[] };
  browser_specific_settings?: { gecko?: Record<string, unknown> };
  background?: { service_worker?: string; scripts?: string[] };
}

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const OUT_SUBDIR = 'manifest-test';
const OUT_DIR = path.join(REPO_ROOT, '.output', OUT_SUBDIR);

// Supplied to the build so the env injection of `oauth2.client_id` is exercised
// deterministically, whatever a developer has in their own .env files.
const FAKE_CLIENT_ID = 'sbw-manifest-test.apps.googleusercontent.com';

const SGW_HOSTS = ['https://shopgoodwill.com/*', 'https://buyerapi.shopgoodwill.com/*'];
const OPTIONAL_HOSTS = [
  'https://oauth2.googleapis.com/*',
  'https://www.googleapis.com/*',
  'https://ntfy.sh/*',
];
const NOT_REQUESTED = [
  'scripting',
  'tabs',
  'cookies',
  'webNavigation',
  'unlimitedStorage',
  'webRequest',
  '<all_urls>',
  'http://127.0.0.1/*',
];

const BUILD_SCRIPT = `
const { build } = await import('wxt');
for (const browser of ['chrome', 'firefox']) {
  await build({
    browser,
    manifestVersion: 3,
    mode: 'production',
    outDirTemplate: '${OUT_SUBDIR}/{{browser}}-mv{{manifestVersion}}',
  });
}
`;

const execFileAsync = promisify(execFile);
const manifests = new Map<Target, Manifest>();

function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, SBW_GOOGLE_CLIENT_ID: FAKE_CLIENT_ID };
  // A production build: no test flag, and none of Vitest's own env vars.
  for (const key of Object.keys(env)) {
    if (key === 'SBW_TEST' || key === 'NODE_ENV' || key === 'TEST' || key.startsWith('VITEST')) {
      Reflect.deleteProperty(env, key);
    }
  }
  return env;
}

function manifestOf(target: Target): Manifest {
  const manifest = manifests.get(target);
  if (!manifest) throw new Error(`no ${target} manifest was built`);
  return manifest;
}

function allRequested(manifest: Manifest): string[] {
  return [
    ...(manifest.permissions ?? []),
    ...(manifest.optional_permissions ?? []),
    ...(manifest.host_permissions ?? []),
    ...(manifest.optional_host_permissions ?? []),
    ...(manifest.content_scripts ?? []).flatMap((script) => script.matches ?? []),
  ];
}

/** The parts of a manifest that grant or expose capabilities. */
function permissionSurface(manifest: Manifest) {
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
    oauth2: manifest.oauth2
      ? { ...manifest.oauth2, client_id: '<SBW_GOOGLE_CLIENT_ID>' }
      : null,
    browser_specific_settings: manifest.browser_specific_settings ?? null,
  };
}

beforeAll(async () => {
  try {
    await execFileAsync(process.execPath, ['--input-type=module', '-e', BUILD_SCRIPT], {
      cwd: REPO_ROOT,
      env: buildEnv(),
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    const { stdout = '', stderr = '' } = error as { stdout?: string; stderr?: string };
    throw new Error(`production build failed\n${stdout}\n${stderr}`, { cause: error });
  }
  for (const target of ['chrome', 'firefox'] as const) {
    const file = path.join(OUT_DIR, `${target}-mv3`, 'manifest.json');
    manifests.set(target, JSON.parse(await readFile(file, 'utf8')) as Manifest);
  }
}, 180_000);

afterAll(async () => {
  await rm(OUT_DIR, { recursive: true, force: true });
});

describe.each(['chrome', 'firefox'] as const)('%s production manifest', (target) => {
  it('targets Manifest V3', () => {
    expect(manifestOf(target).manifest_version).toBe(3);
  });

  it('requires only storage and alarms', () => {
    expect(manifestOf(target).permissions).toEqual(['storage', 'alarms']);
  });

  it('requires host access only to shopgoodwill.com and buyerapi', () => {
    expect(manifestOf(target).host_permissions).toEqual(SGW_HOSTS);
  });

  it('runs content scripts only on shopgoodwill.com', () => {
    const matches = (manifestOf(target).content_scripts ?? []).flatMap((s) => s.matches ?? []);
    expect(new Set(matches)).toEqual(new Set(['https://shopgoodwill.com/*']));
  });

  it('asks for Google and ntfy hosts only as optional', () => {
    expect(manifestOf(target).optional_host_permissions).toEqual(OPTIONAL_HOSTS);
  });

  it('never requests permissions outside the table', () => {
    const requested = allRequested(manifestOf(target));
    for (const permission of NOT_REQUESTED) {
      expect(requested).not.toContain(permission);
    }
  });

  it('declares the kill-switch command with Ctrl+Shift+K', () => {
    expect(manifestOf(target).commands?.['kill-switch']).toEqual({
      suggested_key: { default: 'Ctrl+Shift+K' },
      description: expect.any(String) as string,
    });
  });

  it('matches the committed permission snapshot', () => {
    expect(permissionSurface(manifestOf(target))).toMatchSnapshot();
  });
});

describe('chrome-only manifest keys', () => {
  it('has the Chrome optional permissions', () => {
    expect(manifestOf('chrome').optional_permissions).toEqual([
      'notifications',
      'identity',
      'sidePanel',
      'background',
      'power',
      'nativeMessaging',
    ]);
  });

  it('requires Chrome 148', () => {
    expect(manifestOf('chrome').minimum_chrome_version).toBe('148');
  });

  it('injects oauth2.client_id from SBW_GOOGLE_CLIENT_ID at build time', () => {
    expect(manifestOf('chrome').oauth2).toEqual({
      client_id: FAKE_CLIENT_ID,
      scopes: ['https://www.googleapis.com/auth/calendar.app.created'],
    });
  });

  it('runs the background as a service worker', () => {
    expect(manifestOf('chrome').background?.service_worker).toEqual(expect.any(String));
    expect(manifestOf('chrome').browser_specific_settings).toBeUndefined();
  });
});

describe('firefox-only manifest keys', () => {
  it('has the Firefox optional permissions', () => {
    expect(manifestOf('firefox').optional_permissions).toEqual([
      'notifications',
      'identity',
      'nativeMessaging',
    ]);
  });

  it('declares the fixed gecko id, Firefox 128 minimum and data collection', () => {
    expect(manifestOf('firefox').browser_specific_settings).toEqual({
      gecko: {
        id: 'shopbadwill@trashdad.github.io',
        strict_min_version: '128.0',
        data_collection_permissions: {
          required: ['none'],
          optional: ['technicalAndInteraction'],
        },
      },
    });
  });

  it('has no Chrome-only keys', () => {
    expect(manifestOf('firefox').oauth2).toBeUndefined();
    expect(manifestOf('firefox').minimum_chrome_version).toBeUndefined();
  });

  it('runs the background as an event page', () => {
    expect(manifestOf('firefox').background?.scripts).toEqual([expect.any(String)]);
  });
});
