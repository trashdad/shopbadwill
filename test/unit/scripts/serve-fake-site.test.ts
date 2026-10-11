// T-39: the fake SGW site server (scripts/serve-fake-site.ts). It serves the
// committed sanitized search fixture with the real Angular replaced by a
// minimal script that performs the same XHR the real page performs (POST
// buyerapi Search/ItemListing with the body built from the URL), so the
// MAIN-world api-tap path is exercised end to end.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { buildSearchPage, fakeSiteScript, FIXTURE_HTML, SEARCH_API, startFakeSite, type FakeSite } from '../../../scripts/serve-fake-site';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXTURE = readFileSync(path.join(ROOT, 'test/fixtures/sgw/html/search-grid-logged-out.html'), 'utf8');

describe('scripts/serve-fake-site', () => {
  it('injects exactly one script, before </body>, and keeps the fixture intact', () => {
    const page = buildSearchPage(FIXTURE);
    expect(page).toContain('Search Results: Pyrex | ShopGoodwill.com');
    // The SSR cards stay (the script re-renders them on load, like Angular hydration).
    expect(page.split('app-home-product-items').length).toBeGreaterThan(40);
    const scripts = page.match(/<script data-sbw-fake-script>/g) ?? [];
    expect(scripts).toHaveLength(1);
    expect(page.indexOf('<script data-sbw-fake-script>')).toBeLessThan(page.indexOf('</body>'));
  });

  it('the replacement script performs the same XHR and SPA navigation as the site', () => {
    const script = fakeSiteScript();
    expect(script).toContain(SEARCH_API);
    expect(script).toContain("method: 'POST'");
    expect(script).toContain("'content-type': 'application/json'");
    expect(script).toContain('searchText'); // the real search body defaults
    expect(script).toContain('pageSize');
    expect(script).toContain('history.pushState'); // SPA page change, like the Angular router
    expect(script).toContain('p-paginator-page'); // the paginator buttons drive it
    expect(script).toContain('app-home-product-items'); // renders the site's card component
    expect(script).toContain('feat-item_name');
    expect(script).not.toContain('innerHTML'); // text/DOM nodes only
  });

  describe('startFakeSite', () => {
    let site: FakeSite | null = null;
    afterEach(async () => {
      await site?.close();
      site = null;
    });

    it('serves the fixture page for /categories/listing and a health line at /', async () => {
      site = await startFakeSite({ port: 0 });
      const health = await fetch(`${site.url}/`);
      expect(health.status).toBe(200);
      expect(health.headers.get('content-type')).toContain('text/plain');

      const page = await fetch(`${site.url}/categories/listing?st=pyrex&p=1`);
      expect(page.status).toBe(200);
      expect(page.headers.get('content-type')).toContain('text/html');
      const body = await page.text();
      expect(body).toContain('Search Results: Pyrex | ShopGoodwill.com');
      expect(body).toContain('<script data-sbw-fake-script>');
      expect(body).toContain(SEARCH_API);
    });

    it('answers 404 for any other path', async () => {
      site = await startFakeSite({ port: 0 });
      const res = await fetch(`${site.url}/shopgoodwill/favorites`);
      expect(res.status).toBe(404);
    });

    it('stops cleanly and then refuses connections', async () => {
      const started = await startFakeSite({ port: 0 });
      const url = started.url;
      await started.close();
      await expect(fetch(url)).rejects.toThrow();
    });
  });

  it('reads only the committed sanitized search fixture, never raw/', () => {
    const fixturePath = FIXTURE_HTML.replaceAll('\\', '/');
    expect(fixturePath).toMatch(/test\/fixtures\/sgw\/html\/search-grid-logged-out\.html$/);
    expect(fixturePath).not.toMatch(/\/raw\//);
    expect(FIXTURE).toContain('Search Results: Pyrex | ShopGoodwill.com');
  });
});
