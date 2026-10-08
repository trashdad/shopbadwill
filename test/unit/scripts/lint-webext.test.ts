import { describe, expect, it } from 'vitest';
import { webExtLintArgs } from '../../../scripts/lint-webext';

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
