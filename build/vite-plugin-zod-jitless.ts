// Strips zod's Function-constructor code from bundles so `web-ext lint` reports
// no DANGEROUS_EVAL and AMO reviewers see no dynamic code. zod falls back to its
// interpreter whenever the JIT is unavailable, so behavior is unchanged:
//
//   core/util.js     `allowsEval` probe (`new F("")`)  -> returns false. Every JIT
//                    call site in zod is gated on it, so the JIT never runs.
//   core/compile.js  the compiled-parser factory (`new F(...)`) -> throws inside
//                    its existing try/catch, which zod already turns into a typed
//                    ZodCompileUnsupportedError; compile() then returns the schema
//                    unchanged (runtime parser).
//   core/doc.js      `Doc.compile()` (`new F(...)`) -> throws. Only reachable when
//                    allowsEval is true, so it is dead code after the util stub.
//
// GUARD: each rewrite must match exactly once. If a zod upgrade changes this
// source, the build FAILS naming the zod version, so eval cannot silently return.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

interface Rewrite {
  description: string;
  pattern: RegExp;
  replacement: string;
}

const UNAVAILABLE = 'zod JIT is disabled in ShopBadwill builds (vite-plugin-zod-jitless)';

const REWRITES: Record<string, Rewrite[]> = {
  'util.js': [
    {
      description: 'allowsEval probe (try { const F = Function; new F(""); return true; } catch { return false; })',
      pattern: /try\s*\{\s*const F = Function;\s*new F\(""\);\s*return true;\s*\}\s*catch\s*\(_\)\s*\{\s*return false;\s*\}/g,
      replacement: 'return false;',
    },
  ],
  'compile.js': [
    {
      description: 'const F = Function;',
      pattern: /^[ \t]*const F = Function;\r?\n/gm,
      replacement: '',
    },
    {
      description: 'JIT factory (const factory = new F(...); fn = factory(...))',
      pattern: /const factory = new F\(\.\.\.constantNames, factoryCode\);\s*fn = factory\(\.\.\.constantValues\);/g,
      replacement: `throw new Error(${JSON.stringify(UNAVAILABLE)});`,
    },
  ],
  'doc.js': [
    {
      description: 'Doc.compile() body (const F = Function; ... new F(...); factory(...))',
      pattern: /compile\(\)\s*\{[\s\S]*?return factory\(\.\.\.Object\.values\(this\.closed\)\);\s*\}/g,
      replacement: `compile() {\n        throw new Error(${JSON.stringify(UNAVAILABLE)});\n    }`,
    },
  ],
};

const SEP = String.raw`[\\/]`;
const NOT_SEP = String.raw`[^\\/]+`;
const ZOD_CORE_FILE = new RegExp(
  `${SEP}node_modules${SEP}(?:\\.pnpm${SEP}${NOT_SEP}${SEP}node_modules${SEP})?zod${SEP}v4${SEP}core${SEP}(util|compile|doc)\\.js$`,
);
const FORBIDDEN_AFTER = [/\bnew\s+F\b/, /\bnew\s+Function\b/, /\bFunction\s*\(/, /\beval\s*\(/, /=\s*Function\s*;/];

function zodVersionFor(id: string): string {
  try {
    const root = id.slice(0, id.search(new RegExp(`${SEP}v4${SEP}core${SEP}`)));
    return (JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** Pure transform. Returns null when `id` is not one of the zod files to patch. */
export function stripZodJit(code: string, id: string, version = zodVersionFor(id)): string | null {
  const file = ZOD_CORE_FILE.exec(id.split('?')[0] ?? id)?.[1];
  if (file === undefined) return null;
  const name = `${file}.js`;
  let out = code;
  for (const { description, pattern, replacement } of REWRITES[name] ?? []) {
    const matches = out.match(pattern)?.length ?? 0;
    if (matches !== 1) {
      throw new Error(
        `[vite-plugin-zod-jitless] zod ${version}: core/${name}: expected exactly 1 match for ${description}, found ${String(matches)}. ` +
          'zod changed its eval/JIT code; update build/vite-plugin-zod-jitless.ts (the build is refused so eval cannot ship).',
      );
    }
    out = out.replace(pattern, replacement);
  }
  const remaining = out
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const left = FORBIDDEN_AFTER.find((p) => p.test(remaining));
  if (left) {
    throw new Error(
      `[vite-plugin-zod-jitless] zod ${version}: core/${name}: Function-constructor/eval code (${String(left)}) remains after transform. ` +
        'Update build/vite-plugin-zod-jitless.ts.',
    );
  }
  return out;
}

export function zodJitless(): Plugin {
  return {
    name: 'sbw-zod-jitless',
    enforce: 'pre',
    transform(code, id) {
      const out = stripZodJit(code, id);
      return out === null ? null : { code: out, map: null };
    },
  };
}
