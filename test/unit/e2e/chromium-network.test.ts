// T-39: the Chromium route policy. A wrong implementation fetches the real
// shopgoodwill.com (or continues a loopback call into the dead proxy) and this
// file fails.
import { describe, expect, it } from 'vitest';

import { decideRequest, DEFAULT_FAKE_PORTS, FAKE_BUYERAPI, FAKE_PORTS, FAKE_SITE, fakePort } from '../../../test/e2e/chromium/network';

describe('chromium E2E network policy', () => {
  it('serves /categories/listing?st= and /shopgoodwill/* from the local fake site', () => {
    const listing = decideRequest('https://shopgoodwill.com/categories/listing?st=pyrex&p=1');
    expect(listing).toEqual({
      action: 'fetch',
      url: `${FAKE_SITE}/categories/listing?st=pyrex&p=1`,
      bucket: 'site',
    });
    const favorites = decideRequest('https://shopgoodwill.com/shopgoodwill/favorites');
    expect(favorites.action).toBe('fetch');
    if (favorites.action !== 'fetch') return;
    expect(new URL(favorites.url).hostname).toBe('127.0.0.1');
    expect(favorites.url.startsWith(`${FAKE_SITE}/shopgoodwill/`)).toBe(true);
    expect(favorites.url).not.toContain('shopgoodwill.com');
  });

  it('sends the page search XHR to the local fake buyerapi', () => {
    expect(decideRequest('https://buyerapi.shopgoodwill.com/api/Search/ItemListing?x=1')).toEqual({
      action: 'fetch',
      url: `${FAKE_BUYERAPI}/api/Search/ItemListing?x=1`,
      bucket: 'buyerapi',
    });
  });

  it('aborts a service-worker request that still names prod buyerapi: sbw:test:baseUrl did not rewrite it', () => {
    // Playwright routes the extension's service-worker requests too. Mapping
    // this one to the fake would let a broken hook pass the spec unseen.
    expect(decideRequest('https://buyerapi.shopgoodwill.com/__log', { serviceWorker: true })).toEqual({
      action: 'abort',
      unexpected: true,
    });
    // The rewritten request is fetched from the fake buyerapi.
    expect(decideRequest(`${FAKE_BUYERAPI}/__log`, { serviceWorker: true })).toEqual({
      action: 'fetch',
      url: `${FAKE_BUYERAPI}/__log`,
      bucket: 'local',
    });
    // The page's own search XHR is not the background's: it still goes to the fake buyerapi.
    expect(decideRequest('https://buyerapi.shopgoodwill.com/api/Search/ItemListing', { serviceWorker: false })).toEqual({
      action: 'fetch',
      url: `${FAKE_BUYERAPI}/api/Search/ItemListing`,
      bucket: 'buyerapi',
    });
  });

  it('fulfills the fake-server ports locally instead of continuing them', () => {
    // continue() would send the browser through the dead proxy (--proxy-server=127.0.0.1:9).
    for (const port of Object.values(FAKE_PORTS).map(String)) {
      const url = `http://127.0.0.1:${port}/__log`;
      expect(decideRequest(url), port).toEqual({ action: 'fetch', url, bucket: 'local' });
    }
  });

  it('aborts an unexpected host, and aborts img.test without failing the audit', () => {
    expect(decideRequest('https://evil.example/x')).toEqual({ action: 'abort', unexpected: true });
    expect(decideRequest('https://www.shopgoodwill.com/categories/listing?st=pyrex')).toEqual({
      action: 'abort',
      unexpected: true,
    });
    expect(decideRequest('https://shopgoodwill.com.evil.com/categories/listing')).toEqual({
      action: 'abort',
      unexpected: true,
    });
    expect(decideRequest('https://buyerapi.shopgoodwill.com.evil.com/api')).toEqual({
      action: 'abort',
      unexpected: true,
    });
    expect(decideRequest('https://img.test/fake.jpg')).toEqual({ action: 'abort', unexpected: false });
  });

  it('lets extension pages and about: through', () => {
    expect(decideRequest('chrome-extension://abcdefghijklmnop/popup.html')).toEqual({ action: 'continue' });
    expect(decideRequest('about:blank')).toEqual({ action: 'continue' });
  });

  it('takes each fake port from its env var (T-39b), else the default, and refuses port 0 or junk', () => {
    expect(fakePort('sgw', {})).toBe(DEFAULT_FAKE_PORTS.sgw);
    expect(fakePort('google', { FAKE_GOOGLE_PORT: '' })).toBe(DEFAULT_FAKE_PORTS.google);
    expect(fakePort('sgw', { SBW_FAKE_SGW_PORT: '51234' })).toBe(51234);
    expect(fakePort('google', { FAKE_GOOGLE_PORT: '51235' })).toBe(51235);
    expect(fakePort('site', { SBW_FAKE_SITE_PORT: '51236' })).toBe(51236);
    for (const bad of ['0', '-1', '65536', '87.5', 'abc']) {
      expect(() => fakePort('site', { SBW_FAKE_SITE_PORT: bad }), bad).toThrow(/SBW_FAKE_SITE_PORT/);
    }
  });
});
