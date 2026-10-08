import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const script = path.join(root, 'scripts', 'sign-firefox.ts');

function run(env: Record<string, string>, args: string[] = []) {
  const clean = { ...process.env };
  delete clean.AMO_JWT_ISSUER;
  delete clean.AMO_JWT_SECRET;
  delete clean.SBW_SOURCE_ZIP;
  return spawnSync(process.execPath, [tsx, script, ...args], {
    cwd: root,
    encoding: 'utf8',
    // Point any (unexpected) web-ext/network use at a dead proxy; the script must not get that far.
    env: { ...clean, HTTPS_PROXY: 'http://127.0.0.1:9', ...env },
    timeout: 30_000,
  });
}

describe('scripts/sign-firefox.ts', () => {
  it('skips with exit 0 and no signing when the AMO keys are absent', () => {
    const r = run({});
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/skipped .*no network used/);
  });

  it('skips when only one key is set', () => {
    const r = run({ AMO_JWT_ISSUER: 'issuer' });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/skipped/);
    expect(r.stderr).toMatch(/WARNING: only one AMO credential is set \(AMO_JWT_SECRET is missing\)/);
  });

  it('warns about the other missing key too, and stays silent when both are absent', () => {
    expect(run({ AMO_JWT_SECRET: 'secret' }).stderr).toMatch(/AMO_JWT_ISSUER is missing/);
    expect(run({}).stderr).not.toMatch(/WARNING/);
  });

  it('fails fast before any network call when keys are set but the source zip is missing', () => {
    const r = run({ AMO_JWT_ISSUER: 'issuer', AMO_JWT_SECRET: 'secret' }, ['does-not-exist.zip']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/source zip is missing/);
    expect(r.stdout).not.toMatch(/Submitting|Uploading|signed/i);
  });
});
