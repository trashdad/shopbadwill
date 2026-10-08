import { describe, expect, it } from 'vitest';
import { bumpVersion, changelogSection, rollChangelog } from '../../../scripts/release';

describe('bumpVersion', () => {
  it('bumps patch, minor and major', () => {
    expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4');
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
  });

  it('accepts an explicit X.Y.Z', () => {
    expect(bumpVersion('0.0.1', '1.0.0')).toBe('1.0.0');
  });

  it('refuses a dirty or invalid current version', () => {
    for (const bad of ['1.2', '1.2.3-beta.1', '1.2.3+build', 'v1.2.3', '1.2.3\n', '']) {
      expect(() => bumpVersion(bad, 'patch'), bad).toThrow(/not X\.Y\.Z/);
    }
  });

  it('refuses an invalid target and a no-op target', () => {
    expect(() => bumpVersion('1.2.3', 'huge')).toThrow(/not patch, minor, major or X\.Y\.Z/);
    expect(() => bumpVersion('1.2.3', '1.2.3-rc.1')).toThrow(/not patch/);
    expect(() => bumpVersion('1.2.3', '1.2.3')).toThrow(/already/);
  });
});

const SAMPLE = `# Changelog

## [Unreleased]

### Added

- Thing one.

## [0.0.1] - 2026-01-01

### Added

- Old thing.
`;

describe('rollChangelog', () => {
  it('moves Unreleased under the new version with the injected date and keeps an empty Unreleased', () => {
    const out = rollChangelog(SAMPLE, '0.1.0', '2026-10-08');
    expect(out).toContain('## [Unreleased]\n\n## [0.1.0] - 2026-10-08\n\n### Added\n\n- Thing one.');
    expect(out.indexOf('## [Unreleased]')).toBeLessThan(out.indexOf('## [0.1.0]'));
    expect(out.indexOf('## [0.1.0]')).toBeLessThan(out.indexOf('## [0.0.1]'));
    expect(out).toContain('- Old thing.');
  });

  it('throws without an Unreleased section', () => {
    expect(() => rollChangelog('# Changelog\n', '0.1.0', '2026-10-08')).toThrow(/Unreleased/);
  });
});

describe('changelogSection', () => {
  it('returns the requested version body, falling back to Unreleased', () => {
    expect(changelogSection(SAMPLE, '0.0.1')).toBe('### Added\n\n- Old thing.');
    expect(changelogSection(SAMPLE, '9.9.9')).toBe('### Added\n\n- Thing one.');
  });
});
