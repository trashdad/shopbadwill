// `pnpm check:prod-bundle`: greps the PRODUCTION outputs (.output/chrome-mv3,
// .output/firefox-mv3) for tokens that must never ship, and fails on any hit:
//   127.0.0.1  localhost  SBW_TEST  __scenario  sbw:test  innerHTML  eval(  new Function
//
// Two allowlist entries, nothing else:
//
// 1. 127.0.0.1 only as the exact prefix `http://127.0.0.1/mozoauth2/` (T-62,
//    controller ruling): Firefox's OAuth loopback redirect, which the Google
//    provider must build at runtime. Any other 127.0.0.1 string still fails,
//    including the same text glued to a longer scheme (`xhttp://...`).
//
// 2. Preact's own `dangerouslySetInnerHTML` handling in the
// chunk that contains the Preact runtime. Nothing else is exempt, and the same
// token in a first-party chunk (even one that also bundles Preact) fails.
//
// How the Preact chunk is identified (not by file name or line number: content
// scripts inline Preact into their own bundle, so a vendor chunk name is not
// reliable): the file must contain Preact's runtime markers, the strings
// `dangerouslySetInnerHTML`, `__html` and the VNode field `__k`. Inside such a
// file the allowed innerHTML tokens are those of the one diff statement (a read
// of `dom.innerHTML` and two assignments, 3 tokens today): every token must have
// `__html` within ALLOWED_CONTEXT characters, all must sit in one cluster, and
// there may be at most MAX_PREACT_INNERHTML of them. Absent Preact: no allowance.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FORBIDDEN = [
  { name: '127.0.0.1', pattern: /127\.0\.0\.1/g },
  { name: 'localhost', pattern: /localhost/g },
  { name: 'SBW_TEST', pattern: /SBW_TEST/g },
  { name: '__scenario', pattern: /__scenario/g },
  { name: 'sbw:test', pattern: /sbw:test/g },
  { name: 'innerHTML', pattern: /innerHTML/g },
  { name: 'eval(', pattern: /\beval\s*\(/g },
  { name: 'new Function', pattern: /new\s+Function\b/g },
  // Function-constructor signatures that survive in a bundle even when the
  // spellings above do not match (zod's JIT probe and compiler, which
  // build/vite-plugin-zod-jitless.ts strips).
  { name: 'new F("")', pattern: /\bnew\s+F\(\s*""/g },
  { name: 'const F = Function', pattern: /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*Function\b/g },
  { name: '= Function;', pattern: /=\s*Function\s*[;,)]/g },
  { name: 'Function("', pattern: /(?<!new\s+)\bFunction\s*\(\s*["'`]/g },
  { name: '(0, eval)', pattern: /\(\s*0\s*,\s*eval\s*\)/g },
] as const;

export interface Finding {
  file: string;
  line: number;
  column: number;
  token: string;
  snippet: string;
}

/** The one 127.0.0.1 text production may contain (Firefox's OAuth loopback redirect). */
export const ALLOWED_LOOPBACK_PREFIX = 'http://127.0.0.1/mozoauth2/';
const LOOPBACK_SCHEME = 'http://';

/** Whether the 127.0.0.1 at `offset` starts the allowed prefix, with no scheme character glued in front. */
export function isAllowedLoopback(text: string, offset: number): boolean {
  const start = offset - LOOPBACK_SCHEME.length;
  if (start < 0 || !text.startsWith(ALLOWED_LOOPBACK_PREFIX, start)) return false;
  return !/[A-Za-z0-9+.-]/.test(text.charAt(start - 1));
}

const PREACT_MARKERS = ['dangerouslySetInnerHTML', '__html', '__k'] as const;
export const ALLOWED_CONTEXT = 200;
export const MAX_PREACT_INNERHTML = 3;
const SCANNED_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.html', '.htm', '.css', '.json', '.svg']);

export function isPreactRuntime(text: string): boolean {
  return PREACT_MARKERS.every((marker) => text.includes(marker));
}

/** Offsets of `innerHTML` tokens that belong to Preact's single allowed statement. */
export function allowedInnerHtmlOffsets(text: string): Set<number> {
  if (!isPreactRuntime(text)) return new Set();
  const offsets = [...text.matchAll(/innerHTML/g)].map((m) => m.index);
  const nearHtml = offsets.filter((at) =>
    text.slice(Math.max(0, at - ALLOWED_CONTEXT), at + ALLOWED_CONTEXT).includes('__html'),
  );
  const first = nearHtml[0];
  const last = nearHtml[nearHtml.length - 1];
  if (first === undefined || last === undefined) return new Set();
  if (nearHtml.length > MAX_PREACT_INNERHTML || last - first > ALLOWED_CONTEXT) return new Set();
  return new Set(nearHtml);
}

export function positionOf(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  return { line: before.split('\n').length, column: offset - (before.lastIndexOf('\n') + 1) + 1 };
}

export function scanText(file: string, text: string): Finding[] {
  const allowed = allowedInnerHtmlOffsets(text);
  const findings: Finding[] = [];
  for (const { name, pattern } of FORBIDDEN) {
    for (const match of text.matchAll(pattern)) {
      if (name === 'innerHTML' && allowed.has(match.index)) continue;
      if (name === '127.0.0.1' && isAllowedLoopback(text, match.index)) continue;
      const { line, column } = positionOf(text, match.index);
      const start = Math.max(0, match.index - 30);
      findings.push({
        file,
        line,
        column,
        token: name,
        snippet: text.slice(start, match.index + 40).replace(/\s+/g, ' '),
      });
    }
  }
  return findings;
}

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (SCANNED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) yield full;
  }
}

export async function scanDirectory(dir: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  for await (const file of walk(dir)) {
    findings.push(...scanText(path.relative(dir, file).replaceAll('\\', '/'), await readFile(file, 'utf8')));
  }
  return findings;
}

async function main(): Promise<void> {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  let failed = false;
  for (const target of ['chrome-mv3', 'firefox-mv3']) {
    const dir = path.join(root, '.output', target);
    let findings: Finding[];
    try {
      findings = await scanDirectory(dir);
    } catch {
      console.error(`check:prod-bundle: ${dir} not found. Run \`pnpm build\` and \`pnpm build:firefox\` first.`);
      failed = true;
      continue;
    }
    for (const f of findings) {
      console.error(`${target}/${f.file}:${String(f.line)}:${String(f.column)}  forbidden "${f.token}"  ...${f.snippet}...`);
    }
    if (findings.length > 0) failed = true;
    else console.log(`check:prod-bundle: ${target} clean`);
  }
  if (failed) process.exit(1);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
