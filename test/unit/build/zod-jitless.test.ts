import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { stripZodJit, zodJitless } from '../../../build/vite-plugin-zod-jitless';

const require = createRequire(import.meta.url);
const zodRoot = path.dirname(require.resolve('zod/package.json'));
const coreFile = (name: string) => path.join(zodRoot, 'v4', 'core', name);
const read = (name: string) => readFileSync(coreFile(name), 'utf8');
const VERSION = (JSON.parse(readFileSync(path.join(zodRoot, 'package.json'), 'utf8')) as { version: string }).version;

const stripComments = (code: string) => code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const EVAL_PATTERNS = [/\bnew\s+F\b/, /\bnew\s+Function\b/, /\bFunction\s*\(/, /\beval\s*\(/, /=\s*Function\b/];

describe('zod jitless transform (real zod source)', () => {
  for (const file of ['util.js', 'compile.js', 'doc.js']) {
    it(`${file}: output has no Function-constructor/eval code`, () => {
      const original = stripComments(read(file));
      expect(EVAL_PATTERNS.some((p) => p.test(original))).toBe(true); // the source really has it
      const out = stripZodJit(read(file), coreFile(file), VERSION);
      expect(out).not.toBeNull();
      const code = stripComments(out ?? '');
      for (const p of EVAL_PATTERNS) expect(code).not.toMatch(p);
    });
  }

  it('plugin ignores modules outside zod core and other zod files', () => {
    const plugin = zodJitless();
    expect(plugin.enforce).toBe('pre');
    const transform = plugin.transform as (code: string, id: string) => unknown;
    expect(transform('x', '/repo/src/a.ts')).toBeNull();
    expect(transform('x', coreFile('schemas.js'))).toBeNull();
    expect(transform(read('util.js'), `${coreFile('util.js')}?v=1`)).not.toBeNull();
  });
});

describe('zod jitless: CJS and duplicate copies', () => {
  for (const file of ['util.cjs', 'compile.cjs', 'doc.cjs']) {
    it(`${file}: real installed CJS source is transformed clean`, () => {
      const out = stripZodJit(read(file), coreFile(file), VERSION);
      expect(out).not.toBeNull();
      const code = stripComments(out ?? '');
      for (const p of EVAL_PATTERNS) expect(code).not.toMatch(p);
    });
  }

  it('matches a second zod copy at any pnpm path, with forward or back slashes', () => {
    const src = read('util.js');
    const ids = [
      '/r/node_modules/.pnpm/zod@3.99.0/node_modules/zod/v4/core/util.js',
      String.raw`C:\r\node_modules\.pnpm\zod@4.6.5\node_modules\zod\v4\core\util.cjs`,
      '/r/node_modules/dep/node_modules/zod/v4/core/util.js?v=abc',
    ];
    for (const id of ids) expect(stripZodJit(src, id, VERSION), id).not.toBeNull();
    expect(stripZodJit(src, '/r/node_modules/zod/v4/mini/util.js', VERSION)).toBeNull();
  });

  it('doc rewrite is anchored on the Function constructor inside compile()', () => {
    const decoy = ['class A { compile() { return 1; } }', read('doc.js')].join(String.fromCharCode(10));
    const out = stripZodJit(decoy, coreFile('doc.js'), VERSION) ?? '';
    expect(out).toContain('compile() { return 1; }');
  });
});

describe('zod jitless guard', () => {
  it.each(['util.js', 'compile.js', 'doc.js'])('%s: throws naming the zod version when a pattern is absent', (file) => {
    expect(() => stripZodJit('export const nothing = 1;\n', coreFile(file), '9.9.9')).toThrow(/zod 9\.9\.9/);
    expect(() => stripZodJit('export const nothing = 1;\n', coreFile(file), '9.9.9')).toThrow(/vite-plugin-zod-jitless/);
  });

  it('throws when the expected pattern appears twice', () => {
    const doubled = read('doc.js') + read('doc.js');
    expect(() => stripZodJit(doubled, coreFile('doc.js'), VERSION)).toThrow(/expected exactly 1/);
  });
});

describe('zod with the stubbed modules (interpreter path)', () => {
  // The transformed util/compile/doc are exercised through a real Vite SSR load.
  it('parses and rejects correctly with JIT unavailable', async () => {
    const { createServer } = await import('vite');
    const server = await createServer({
      configFile: false,
      logLevel: 'silent',
      plugins: [zodJitless()],
      server: { middlewareMode: true, hmr: false, watch: null },
      appType: 'custom',
      ssr: { noExternal: ['zod'] },
      optimizeDeps: { noDiscovery: true, include: [] },
    });
    try {
      const mod = (await server.ssrLoadModule('zod')) as typeof import('zod');
      const util = (await server.ssrLoadModule(coreFile('util.js'))) as { allowsEval: { value: boolean } };
      expect(util.allowsEval.value).toBe(false);
      const { z: zz } = mod;
      const schema = zz.object({
        id: zz.string().min(1),
        n: zz.number().int(),
        tags: zz.array(zz.string()).default([]),
        opt: zz.string().optional(),
      });
      expect(schema.parse({ id: 'a', n: 3 })).toEqual({ id: 'a', n: 3, tags: [] });
      const bad = schema.safeParse({ id: '', n: 1.5 });
      expect(bad.success).toBe(false);
      expect(bad.error?.issues.map((i) => i.path[0]).sort()).toEqual(['id', 'n']);
      expect(schema.safeParse(null).success).toBe(false);
      // The explicit compile API must hit zod's own fallback, not crash.
      const compiled = mod.z.core.compile(schema);
      expect(compiled.parse({ id: 'b', n: 2 })).toEqual({ id: 'b', n: 2, tags: [] });
      expect(compiled.safeParse({ id: 'b', n: 'x' }).success).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('unmodified zod still works in this environment (sanity)', () => {
    expect(z.string().safeParse(1).success).toBe(false);
  });
});
