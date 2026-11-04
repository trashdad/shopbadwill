import { describe, expect, it } from 'vitest';
import { splitWarnings, webExtLintArgs } from '../../../scripts/lint-webext';

describe('webExtLintArgs', () => {
  it('keeps the fixed arguments when nothing extra is passed', () => {
    expect(webExtLintArgs('/out', [])).toEqual(['lint', '--source-dir', '/out', '--output', 'json']);
  });

  it('forwards extra arguments such as --self-hosted', () => {
    expect(webExtLintArgs('/out', ['--self-hosted'])).toEqual([
      'lint', '--source-dir', '/out', '--output', 'json', '--self-hosted',
    ]);
  });

  it('drops a leading -- separator (pnpm lint:webext -- --self-hosted)', () => {
    expect(webExtLintArgs('/out', ['--', '--self-hosted'])).toContain('--self-hosted');
    expect(webExtLintArgs('/out', ['--', '--self-hosted'])).not.toContain('--');
  });
});

describe('splitWarnings (Preact runtime allowlist)', () => {
  const preact = (file: string, line = 1) => ({ code: 'UNSAFE_VAR_ASSIGNMENT', message: 'Unsafe assignment to innerHTML', file, line, column: 10 });
  const isPreact = (m: { code?: string }) => Promise.resolve(m.code === 'UNSAFE_VAR_ASSIGNMENT');

  it('allows the Preact warning once in each bundle that inlines the runtime (content script + shared chunk)', async () => {
    const warnings = [preact('chunks/preact-abc.js'), preact('content-scripts/sgw.js')];
    const { allowed, failures } = await splitWarnings(warnings, isPreact);
    expect(allowed).toEqual(warnings);
    expect(failures).toEqual([]);
  });

  it('a second Preact-looking warning in the same file fails', async () => {
    const warnings = [preact('content-scripts/sgw.js', 1), preact('content-scripts/sgw.js', 9)];
    const { allowed, failures } = await splitWarnings(warnings, isPreact);
    expect(allowed).toEqual([warnings[0]]);
    expect(failures).toEqual([warnings[1]]);
  });

  it('anything the detector rejects fails, and a warning without a file is never allowed', async () => {
    const other = { code: 'UNSAFE_VAR_ASSIGNMENT', message: 'innerHTML', file: 'popup.js', line: 1, column: 1 };
    const noFile = { code: 'UNSAFE_VAR_ASSIGNMENT', message: 'innerHTML' };
    const { allowed, failures } = await splitWarnings([other, noFile], (m) => Promise.resolve(m !== other));
    expect(allowed).toEqual([]);
    expect(failures).toEqual([other, noFile]);
  });
});
