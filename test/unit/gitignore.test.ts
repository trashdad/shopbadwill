// Integration review: the user's spike results (docs/USER-STEPS/S-<n>-results.txt)
// hold their own observations and must never land in this public repo. They
// were untracked but not ignored, so a `git add -A` would have committed them.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** `git check-ignore --no-index`: exit 0 means ignored, 1 means not ignored. */
function ignored(path: string): number | null {
  return spawnSync('git', ['check-ignore', '--no-index', '-q', path], { cwd: ROOT }).status;
}

describe('.gitignore', () => {
  it('ignores the user-step result files, and only those', () => {
    expect(ignored('docs/USER-STEPS/S-2-results.txt')).toBe(0);
    expect(ignored('docs/USER-STEPS/S-4-results.txt')).toBe(0);
    expect(ignored('docs/USER-STEPS/S-12-results.txt')).toBe(0);
    expect(ignored('docs/USER-STEPS/S-2.md')).toBe(1);
  });
});
