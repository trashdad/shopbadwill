import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDirectory, checkWorkflow } from '../../../scripts/check-actions-pinned';

const SHA = '11bd71901bbe5b1630ceea73d27597364c9af683';

const wf = (...uses: string[]): string =>
  ['jobs:', '  a:', '    steps:', ...uses.map((u) => `      - uses: ${u}`)].join('\n');

describe('checkWorkflow', () => {
  it('fails a tag ref', () => {
    const f = checkWorkflow('ci.yml', wf('actions/checkout@v4.2.2'));
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ file: 'ci.yml', line: 4, uses: 'actions/checkout@v4.2.2' });
  });

  it('fails a branch ref and a missing ref', () => {
    expect(checkWorkflow('ci.yml', wf('actions/checkout@main', 'actions/checkout'))).toHaveLength(2);
  });

  it('fails a short SHA', () => {
    expect(checkWorkflow('ci.yml', wf('actions/checkout@11bd719'))).toHaveLength(1);
  });

  it('fails a 40-char non-hex or uppercase ref', () => {
    expect(checkWorkflow('ci.yml', wf(`actions/checkout@${'g'.repeat(40)}`))).toHaveLength(1);
    expect(checkWorkflow('ci.yml', wf(`actions/checkout@${SHA.toUpperCase()}`))).toHaveLength(1);
  });

  it('passes a full SHA, with or without a trailing comment', () => {
    expect(checkWorkflow('ci.yml', wf(`actions/checkout@${SHA}`))).toEqual([]);
    expect(checkWorkflow('ci.yml', wf(`actions/checkout@${SHA} # v4.2.2`))).toEqual([]);
  });

  it('allows local actions', () => {
    expect(checkWorkflow('ci.yml', wf('./.github/actions/foo', './foo'))).toEqual([]);
  });

  it('handles quoted values and non-list uses keys', () => {
    expect(checkWorkflow('ci.yml', '    uses: "actions/checkout@v4"\n')).toHaveLength(1);
    expect(checkWorkflow('ci.yml', `    uses: 'actions/checkout@${SHA}'\n`)).toEqual([]);
  });

  it('ignores commented-out uses lines', () => {
    expect(checkWorkflow('ci.yml', '      # - uses: actions/checkout@v4\n')).toEqual([]);
  });

  it('fails docker:// references (not immutable by SHA)', () => {
    expect(checkWorkflow('ci.yml', wf('docker://alpine:3.19'))).toHaveLength(1);
  });
});

describe('checkDirectory', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'sbw-actions-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('scans .yml and .yaml files only', async () => {
    await writeFile(path.join(dir, 'a.yml'), wf('actions/checkout@v4'));
    await writeFile(path.join(dir, 'b.yaml'), wf(`actions/checkout@${SHA}`));
    await writeFile(path.join(dir, 'c.txt'), wf('actions/checkout@v4'));
    const f = await checkDirectory(dir);
    expect(f.map((x) => x.file)).toEqual(['a.yml']);
  });
});
