import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ALLOWED_LOOPBACK_PREFIX,
  allowedInnerHtmlOffsets,
  isPreactRuntime,
  scanDirectory,
  scanText,
} from '../../../scripts/check-prod-bundle';
import { stripZodJit } from '../../../build/vite-plugin-zod-jitless';

// The real, minified Preact runtime (what Vite bundles), so the allowlist is
// tested against Preact's actual innerHTML statement, not a hand-written copy.
const require = createRequire(import.meta.url);
const preactPath = path.join(path.dirname(require.resolve('preact/package.json')), 'dist', 'preact.min.module.js');
let preactSource = '';

let dir = '';

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'sbw-prod-bundle-'));
  preactSource = await readFile(preactPath, 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(rel: string, content: string): Promise<void> {
  const file = path.join(dir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

const TOKEN_FIXTURES: [token: string, code: string][] = [
  ['127.0.0.1', 'fetch("http://127.0.0.1:8787/api");'],
  ['localhost', 'const base = "http://localhost:3000";'],
  ['SBW_TEST', 'if (globalThis.SBW_TEST) hook();'],
  ['__scenario', 'const s = state.__scenario;'],
  ['sbw:test', 'port.onMessage("sbw:test:state", h);'],
  ['innerHTML', 'el.innerHTML = userText;'],
  ['eval(', 'eval("1+1");'],
  ['new Function', 'const f = new Function("return 1");'],
];

describe('check-prod-bundle: forbidden tokens', () => {
  it.each(TOKEN_FIXTURES)('flags %s in a chunk', async (token, code) => {
    await write('chunks/app-abc123.js', `export const x = 1;\n${code}\n`);
    const findings = await scanDirectory(dir);
    expect(findings.map((f) => f.token)).toEqual([token]);
    expect(findings[0]).toMatchObject({ file: 'chunks/app-abc123.js', line: 2 });
  });

  it('flags tokens in every scanned file type, including the manifest and html', async () => {
    await write('manifest.json', '{"host_permissions":["http://127.0.0.1/*"]}');
    await write('sidebar.html', '<script>eval ("x")</script>');
    await write('content-scripts/sgw.js', 'new  Function("a", "return a")');
    const findings = await scanDirectory(dir);
    expect(findings.map((f) => `${f.file}:${f.token}`).sort()).toEqual([
      'content-scripts/sgw.js:new Function',
      'manifest.json:127.0.0.1',
      'sidebar.html:eval(',
    ]);
  });

  it('passes a clean bundle', async () => {
    await write('background.js', 'const a = "shopgoodwill.com"; export default a;');
    expect(await scanDirectory(dir)).toEqual([]);
  });

  it('does not match identifiers that merely contain eval', () => {
    expect(scanText('a.js', 'const medieval = retrieval(1);')).toEqual([]);
  });
});

describe('check-prod-bundle: Firefox OAuth loopback allowlist (T-62)', () => {
  it('is exactly the mozoauth2 loopback prefix', () => {
    expect(ALLOWED_LOOPBACK_PREFIX).toBe('http://127.0.0.1/mozoauth2/');
  });

  it('passes the prefix as a minifier emits it: a concatenation or a template', () => {
    expect(scanText('background.js', 'const r="http://127.0.0.1/mozoauth2/"+h;')).toEqual([]);
    expect(scanText('background.js', 'const r=`http://127.0.0.1/mozoauth2/${h}`;')).toEqual([]);
    expect(scanText('background.js', "const r='http://127.0.0.1/mozoauth2/'+h;")).toEqual([]);
  });

  it.each([
    'http://127.0.0.1:8788/token',
    'http://127.0.0.1/*',
    'http://127.0.0.1/mozoauth2',
    'https://127.0.0.1/mozoauth2/',
    'ws://127.0.0.1/mozoauth2/',
    'xhttp://127.0.0.1/mozoauth2/',
    'http://127.0.0.1/mozoauth2x/',
    'http://127.0.0.1/other/mozoauth2/',
    'http://user@127.0.0.1/mozoauth2/',
    '127.0.0.1',
  ])('still flags any other 127.0.0.1 string: %s', (url) => {
    expect(scanText('background.js', `const u="${url}";`).map((f) => f.token)).toEqual(['127.0.0.1']);
  });

  it('in a file with both, flags only the other one', async () => {
    await write('background.js', 'const a="http://127.0.0.1/mozoauth2/"+h;\nconst b="http://127.0.0.1:8788/";\n');
    const findings = await scanDirectory(dir);
    expect(findings.map((f) => `${f.token}@${String(f.line)}`)).toEqual(['127.0.0.1@2']);
  });

  it('passes the provider source that builds the loopback (src/adapters/google/auth-pkce.ts)', async () => {
    const source = await readFile(path.join(import.meta.dirname, '../../../src/adapters/google/auth-pkce.ts'), 'utf8');
    expect(source).toContain(ALLOWED_LOOPBACK_PREFIX);
    expect(scanText('auth-pkce.ts', source).filter((f) => f.token === '127.0.0.1')).toEqual([]);
  });
});

describe('check-prod-bundle: Preact innerHTML allowlist', () => {
  it('fixture sanity: the real Preact runtime is recognised and has 3 innerHTML tokens', () => {
    expect(isPreactRuntime(preactSource)).toBe(true);
    expect(preactSource.match(/innerHTML/g)).toHaveLength(3);
    expect(allowedInnerHtmlOffsets(preactSource).size).toBe(3);
  });

  it('passes Preact innerHTML in the chunk that contains the Preact runtime', async () => {
    await write('chunks/sidebar-Xy12.js', preactSource);
    expect(await scanDirectory(dir)).toEqual([]);
  });

  it('passes when Preact is absent (no allowance needed)', async () => {
    await write('background.js', 'export {};');
    expect(await scanDirectory(dir)).toEqual([]);
  });

  it('fails the same token in a first-party chunk', async () => {
    await write('chunks/sidebar-Xy12.js', preactSource);
    await write('chunks/dashboard-Ab34.js', 'el.innerHTML = "<b>x</b>";');
    const findings = await scanDirectory(dir);
    expect(findings.map((f) => `${f.file}:${f.token}`)).toEqual(['chunks/dashboard-Ab34.js:innerHTML']);
  });

  it('fails a first-party innerHTML that shares a chunk with Preact', async () => {
    const mixed = `${preactSource}\n;(function () { document.body.innerHTML = location.hash; })();\n`;
    await write('content-scripts/sgw.js', mixed);
    const findings = await scanDirectory(dir);
    expect(findings.map((f) => f.token)).toEqual(['innerHTML']);
    expect(findings[0]?.line).toBe(preactSource.split('\n').length + 1);
  });

  it('fails when Preact has more than its one statement worth of innerHTML', () => {
    const extra = `${preactSource};a.innerHTML=b.__html;b.innerHTML="";`;
    expect(scanText('c.js', extra).filter((f) => f.token === 'innerHTML')).not.toHaveLength(0);
  });

  it('does not exempt a chunk that only mentions innerHTML near __html without Preact markers', () => {
    const lookalike = 'x.innerHTML = y.__html;';
    expect(isPreactRuntime(lookalike)).toBe(false);
    expect(scanText('d.js', lookalike).map((f) => f.token)).toEqual(['innerHTML']);
  });

  it('still flags other forbidden tokens inside the Preact chunk', () => {
    const findings = scanText('p.js', `${preactSource};eval("x");`);
    expect(findings.map((f) => f.token)).toEqual(['eval(']);
  });
});

describe('check-prod-bundle: zod Function-constructor signatures', () => {
  const zodCore = path.join(path.dirname(require.resolve('zod/package.json')), 'v4', 'core');
  const coreId = (name: string) => path.join(zodCore, name);

  it('fails on zod original JIT sources (ESM and CJS), including a minified-style probe', async () => {
    for (const name of ['util.js', 'compile.js', 'doc.js', 'util.cjs']) {
      const findings = scanText(name, await readFile(coreId(name), 'utf8'));
      expect(findings.length, name).toBeGreaterThan(0);
    }
    const tokens = scanText('util.js', await readFile(coreId('util.js'), 'utf8')).map((f) => f.token);
    expect(tokens).toEqual(expect.arrayContaining(['const F = Function', 'new F("")']));
    expect(scanText('m.js', 'try{const F=Function;return new F(""),!0}catch{return!1}').length).toBeGreaterThan(0);
  });

  it.each([
    ['= Function;', 'var x=Function;'],
    ['Function("', 'Function("return this")()'],
    ['(0, eval)', '(0,eval)("1")'],
  ])('flags %s', (token, code) => {
    expect(scanText('a.js', code).map((f) => f.token)).toContain(token);
  });

  it('passes the transformed zod sources', async () => {
    for (const name of ['util.js', 'compile.js', 'doc.js', 'util.cjs', 'compile.cjs', 'doc.cjs']) {
      const out = stripZodJit(await readFile(coreId(name), 'utf8'), coreId(name));
      expect(out, name).not.toBeNull();
      // Comments mention `new Function`; bundlers strip them from production output.
      const code = (out ?? '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(scanText(name, code), name).toEqual([]);
    }
  });
});
