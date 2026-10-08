import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../../../..');
const MODULE = resolve(ROOT, 'src/domain/time/pacific.ts');

describe('Date.parse is banned in the time module', () => {
  const eslint = new ESLint({ cwd: ROOT });

  it('the lint rule (no-restricted-syntax) flags Date.parse under src/domain/time', async () => {
    const [res] = await eslint.lintText('export const x = Date.parse("2026-10-07T19:18:30");\n', {
      filePath: resolve(ROOT, 'src/domain/time/pacific.ts'),
    });
    expect(res?.messages.some((m) => m.ruleId === 'no-restricted-syntax' && m.message.includes('Date.parse'))).toBe(
      true,
    );
  }, 60_000);

  it('pacific.ts lints clean of that rule and never calls Date.parse', async () => {
    const src = readFileSync(MODULE, 'utf8');
    const [res] = await eslint.lintText(src, { filePath: MODULE });
    expect(res?.messages.filter((m) => m.ruleId === 'no-restricted-syntax')).toEqual([]);
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/Date\s*\.\s*parse/);
  }, 60_000);

  it('uses the America/Los_Angeles zone and has no imports', () => {
    const src = readFileSync(MODULE, 'utf8');
    expect(src).toContain('America/Los_Angeles');
    expect(src).not.toMatch(/^import\s/m);
  });
});
