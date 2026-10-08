import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { http, HttpResponse } from 'msw';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { z } from 'zod';

import { findFixture, loadHtmlFixture, loadJsonFixture, loadManifest } from '../../fixtures/load';
import { FixtureManifestSchema } from '../../fixtures/manifest-schema';
import { mswServer } from '../../setup/vitest.setup';

describe('fixture loader', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(path.join(tmpdir(), 'sbw-fixtures-'));
    mkdirSync(path.join(root, 'json'));
    mkdirSync(path.join(root, 'html'));
    writeFileSync(path.join(root, 'json', 'sample-a.json'), JSON.stringify({ n: 1 }));
    writeFileSync(path.join(root, 'html', 'page.html'), '<p>hi</p>');
    writeFileSync(
      path.join(root, 'manifest.json'),
      JSON.stringify({
        fixtures: [
          { path: 'json/sample-a.json', capturedAt: '2026-10-07', auth: 'anonymous', sanitizerVersion: 1, extraKey: true },
          { path: 'html/page.html', name: 'the-page', kind: 'html' },
        ],
      }),
    );
  });
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('validates the manifest and strips unknown keys', () => {
    const m = loadManifest(root);
    expect(m.fixtures).toHaveLength(2);
    expect(m.fixtures[0]).not.toHaveProperty('extraKey');
  });

  it('rejects a malformed manifest', () => {
    expect(FixtureManifestSchema.safeParse({ fixtures: [{ nopath: true }] }).success).toBe(false);
    expect(FixtureManifestSchema.safeParse({ fixtures: [{ path: 'a', auth: 'root' }] }).success).toBe(false);
  });

  it('finds fixtures by file stem or explicit name', () => {
    expect(findFixture('sample-a', root).path).toBe('json/sample-a.json');
    expect(findFixture('the-page', root).kind).toBe('html');
  });

  it('loads JSON untyped or validated, and HTML text', () => {
    expect(loadJsonFixture('sample-a', root)).toEqual({ n: 1 });
    expect(loadJsonFixture('sample-a', root, z.object({ n: z.number() })).n).toBe(1);
    expect(() => loadJsonFixture('sample-a', root, z.object({ n: z.string() }))).toThrow();
    expect(loadHtmlFixture('the-page', root)).toBe('<p>hi</p>');
  });

  it('names the known fixtures when one is missing', () => {
    expect(() => findFixture('nope', root)).toThrow(/known: sample-a, the-page/);
  });
});

describe('vitest.setup', () => {
  it('resets the WXT fake browser before each test (part 1 writes)', async () => {
    await browser.storage.local.set({ leak: 1 });
    expect(await browser.storage.local.get('leak')).toEqual({ leak: 1 });
  });

  it('resets the WXT fake browser before each test (part 2 sees nothing)', async () => {
    expect(await browser.storage.local.get('leak')).toEqual({});
  });

  it('intercepts handled requests via the shared MSW server', async () => {
    mswServer.use(http.get('https://sgw.example.test/ping', () => HttpResponse.json({ ok: true })));
    const res = await fetch('https://sgw.example.test/ping');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('drops per-test handlers afterwards and refuses unhandled non-loopback requests', async () => {
    await expect(fetch('https://sgw.example.test/ping')).rejects.toThrow();
  });

  it('bypasses unhandled loopback requests so in-process fake servers stay reachable', async () => {
    const server = createServer((_req, res) => {
      res.end('real');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const res = await fetch(`http://127.0.0.1:${String(port)}/x`);
      expect(await res.text()).toBe('real');
    } finally {
      server.close();
    }
  });
});
