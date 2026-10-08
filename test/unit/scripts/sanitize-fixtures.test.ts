import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildFixtures,
  FixtureSanitizer,
  isJwtLike,
  loremOfLength,
  SANITIZER_VERSION,
  unclassifiedIdKeys,
} from '../../../scripts/sanitize-fixtures';

/** A throwaway fixtures dir: sources.json plus raw/user files. Never the real test/fixtures/sgw. */
function tempFixturesDir(files: Record<string, string>, fixtures: unknown[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sbw-sanitize-'));
  mkdirSync(path.join(dir, 'raw', 'user'), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, 'raw', 'user', name), text);
  writeFileSync(path.join(dir, 'sources.json'), JSON.stringify({ fixtures }));
  return dir;
}

function userSource(fixture: string, kind: 'json' | 'html', file: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fixture,
    kind,
    loggedIn: true,
    ...(kind === 'json' ? { endpoint: 'itemDetail' } : { page: 'item' }),
    ...extra,
    from: { type: 'user', file, capturedAt: '2026-10-08T12:00:00.000Z', urlPattern: 'GET https://shopgoodwill.com/item/{itemId}' },
  };
}

// Synthetic inputs shaped like SGW responses (field names from the S-1 capture
// and github.com/scottmconway/shopgoodwill-scripts). No real captured data.
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJCdXllcklkIjoiMTIzNDUiLCJleHAiOjE3OTE0MDAwMDB9.c2lnbmF0dXJlLXNpZ25hdHVyZQ';

function searchResponse() {
  return {
    searchResults: {
      itemCount: 2,
      items: [
        {
          itemId: 279250057,
          title: 'Vintage Pyrex Butterfly Gold Bowl 403',
          currentPrice: 12.99,
          minimumBid: 12.99,
          numBids: 0,
          endTime: '2026-10-07T19:18:30',
          sellerId: 148,
          sellerName: 'Goodwill of Greater Washington',
          categoryId: 45,
          imageURL: 'https://shopgoodwillimages.azureedge.net/production/148/10-7-2026/abc123.jpg',
          imageServer: 'https://shopgoodwillimages.azureedge.net/production/',
          itemUrl: '/item/279250057',
        },
        {
          itemId: 279250999,
          title: 'Lot of 3 Disney VHS Tapes',
          currentPrice: 5,
          minimumBid: 5,
          numBids: 2,
          endTime: '2026-10-07T19:20:00.45',
          sellerId: 23,
          sellerName: 'Goodwill Southern California',
          categoryId: 12,
          imageURL: 'https://shopgoodwillimages.azureedge.net/production/23/10-7-2026/def456.jpg',
        },
      ],
    },
    categoryListModel: [{ categoryId: 45, categoryName: 'Glass' }],
  };
}

function detailResponse() {
  return {
    itemId: 279250057,
    title: 'Vintage Pyrex Butterfly Gold Bowl 403',
    sellerName: 'Goodwill of Greater Washington',
    serverTime: '2026-10-07T19:01:02.345',
    imageUrlString: 'https://shopgoodwillimages.azureedge.net/production/148/10-7-2026/abc123.jpg;https://shopgoodwillimages.azureedge.net/production/148/10-7-2026/abc124.jpg',
    relatedItemIds: [279250999],
    bidHistory: {
      bidSummary: [
        { bidderName: 'j****n', amount: 17, bidDate: '2026-10-07T18:59:59.123' },
        { bidderName: 'a****z', amount: 15, bidDate: '2026-10-07T18:00:00.001' },
      ],
    },
    buyerId: 987654,
    watchlistId: 555001,
    email: 'someone@example.com',
  };
}

const CARD_HTML = `<!DOCTYPE html><html><head>
<title>Vintage Pyrex Butterfly Gold Bowl 403 | ShopGoodwill</title>
<meta property="og:image" content="https://shopgoodwillimages.azureedge.net/production/148/10-7-2026/abc123.jpg">
<link rel="stylesheet" href="https://shopgoodwill.com/styles.abc.css">
<script src="https://securepubads.g.doubleclick.net/tag/js/gpt.js"></script>
<script>window.__token = "Bearer ${JWT}";</script>
<!-- <script src="https://www.google.com/recaptcha/api.js?render=explicit"></script> -->
</head><body><!---->
<div class="item-col"><app-home-product-items _ngcontent-ng-c1="">
<div class="feat-item" onclick="track(279250057)">
<a class="feat-item_name" id="279250057" href="/item/279250057" title="Vintage Pyrex Butterfly Gold Bowl 403">Vintage Pyrex Butterfly Gold Bowl 403</a>
<img src="https://shopgoodwillimages.azureedge.net/production/148/10-7-2026/abc123.jpg" alt="Vintage Pyrex Butterfly Gold Bowl 403">
<p class="feat-item_price">$12.99</p>
<span class="seller">Goodwill of Greater Washington</span>
<a class="btn-heart" aria-label="Add to your Favorites list" href="javascript:void(0)"></a>
<ul class="feat-item_bottom"><li>Bids: 0</li><li>j****n</li></ul>
</div></app-home-product-items></div>
<p>Authorization: Bearer ${JWT}</p>
<iframe src="https://ads.example/frame"></iframe>
</body></html>`;

function allStrings(value: unknown): string {
  return JSON.stringify(value);
}

describe('sanitize-fixtures', () => {
  it('exports a sanitizer version for manifest provenance', () => {
    expect(SANITIZER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  describe('titles', () => {
    it('replaces titles with deterministic lorem of the same length', () => {
      const a = new FixtureSanitizer({ salt: 'test-salt' }).sanitizeJson(searchResponse());
      const b = new FixtureSanitizer({ salt: 'test-salt' }).sanitizeJson(searchResponse());
      const orig = searchResponse().searchResults.items;
      a.searchResults.items.forEach((row, i) => {
        const o = orig[i];
        expect(o).toBeDefined();
        expect(row.title).not.toBe(o?.title);
        expect(row.title).toHaveLength(o?.title.length ?? -1);
        expect(row.title).toMatch(/^[A-Z][a-z ]*[a-z]$/);
      });
      expect(a).toEqual(b);
    });

    it('depends on the salt', () => {
      const a = new FixtureSanitizer({ salt: 'salt-a' }).sanitizeJson(searchResponse());
      const b = new FixtureSanitizer({ salt: 'salt-b' }).sanitizeJson(searchResponse());
      expect(a.searchResults.items[0]?.title).not.toBe(b.searchResults.items[0]?.title);
    });

    it('loremOfLength is deterministic and exact-length', () => {
      expect(loremOfLength('seed', 37)).toBe(loremOfLength('seed', 37));
      for (const n of [1, 2, 5, 37, 80, 200]) expect(loremOfLength('seed', n)).toHaveLength(n);
    });

    it('replaces the same title everywhere in HTML, including attributes and <title>', () => {
      const s = new FixtureSanitizer({ salt: 'test-salt' });
      const json = s.sanitizeJson(searchResponse());
      const html = s.sanitizeHtml(CARD_HTML);
      expect(html).not.toContain('Pyrex');
      expect(html).toContain(json.searchResults.items[0]?.title ?? 'missing');
    });

    it('also replaces the HTML-encoded form of a title (descriptions repeat it)', () => {
      const s = new FixtureSanitizer({ salt: 'test-salt' });
      const out = s.sanitizeJson({
        title: 'Glass Mixing Bowls & Lids Set',
        description: '<p><strong>Bidding on Glass Mixing Bowls &amp; Lids Set 101</strong></p>',
      });
      expect(out.description).not.toContain('Mixing Bowls');
      expect(s.findLeaks(JSON.stringify(out))).toEqual([]);
      expect(s.findLeaks('<p>Glass Mixing Bowls &amp; Lids Set</p>')).not.toEqual([]);
    });

    it('finds card titles from the DOM alone (no paired JSON)', () => {
      const html = new FixtureSanitizer({ salt: 'test-salt' }).sanitizeHtml(CARD_HTML);
      expect(html).not.toContain('Pyrex');
      expect(html).not.toContain('Butterfly');
    });
  });

  describe('seller names', () => {
    it('become "Goodwill of <Letter>", consistently and distinctly', () => {
      const s = new FixtureSanitizer({ salt: 'test-salt' });
      const search = s.sanitizeJson(searchResponse());
      const detail = s.sanitizeJson(detailResponse());
      const [r0, r1] = search.searchResults.items;
      expect(r0?.sellerName).toMatch(/^Goodwill of [A-Z]\d*$/);
      expect(r1?.sellerName).toMatch(/^Goodwill of [A-Z]\d*$/);
      expect(r0?.sellerName).not.toBe(r1?.sellerName);
      expect(detail.sellerName).toBe(r0?.sellerName);
      const html = s.sanitizeHtml(CARD_HTML);
      expect(html).not.toContain('Greater Washington');
      expect(html).toContain(r0?.sellerName ?? 'missing');
    });
  });

  describe('bidder masks', () => {
    it('become b****r in JSON and HTML', () => {
      const s = new FixtureSanitizer({ salt: 'test-salt' });
      const detail = s.sanitizeJson(detailResponse());
      expect(detail.bidHistory.bidSummary.map((b) => b.bidderName)).toEqual(['b****r', 'b****r']);
      const html = s.sanitizeHtml(CARD_HTML);
      expect(html).not.toContain('j****n');
      expect(html).toContain('b****r');
    });
  });

  describe('image URLs', () => {
    it('become https://img.test/<hash>.jpg, deterministically', () => {
      const s = new FixtureSanitizer({ salt: 'test-salt' });
      const search = s.sanitizeJson(searchResponse());
      const detail = s.sanitizeJson(detailResponse());
      const row = search.searchResults.items[0];
      expect(row?.imageURL).toMatch(/^https:\/\/img\.test\/[0-9a-f]{16}\.jpg$/);
      expect(row?.imageServer).toBe('https://img.test/');
      expect(detail.imageUrlString.split(';')).toHaveLength(2);
      expect(detail.imageUrlString.split(';')[0]).toBe(row?.imageURL);
      const html = s.sanitizeHtml(CARD_HTML);
      expect(html).toContain(`src="${row?.imageURL ?? 'missing'}"`);
      expect(allStrings(search) + allStrings(detail) + html).not.toContain('azureedge');
      const again = new FixtureSanitizer({ salt: 'test-salt' }).sanitizeJson(searchResponse());
      expect(again.searchResults.items[0]?.imageURL).toBe(row?.imageURL);
    });
  });

  describe('item ids', () => {
    it('are remapped with a stable salted hash, consistent across JSON and HTML', () => {
      const s = new FixtureSanitizer({ salt: 'test-salt' });
      const search = s.sanitizeJson(searchResponse());
      const detail = s.sanitizeJson(detailResponse());
      const html = s.sanitizeHtml(CARD_HTML);
      const id0 = search.searchResults.items[0]?.itemId;
      const id1 = search.searchResults.items[1]?.itemId;
      expect(id0).toBeTypeOf('number');
      expect(String(id0)).toMatch(/^[1-9]\d{8}$/);
      expect(id0).not.toBe(279250057);
      expect(id0).not.toBe(id1);
      expect(detail.itemId).toBe(id0);
      expect(detail.relatedItemIds).toEqual([id1]);
      expect(search.searchResults.items[0]?.itemUrl).toBe(`/item/${String(id0)}`);
      expect(html).toContain(`href="/item/${String(id0)}"`);
      expect(html).toContain(`id="${String(id0)}"`);
      const everything = allStrings(search) + allStrings(detail) + html;
      expect(everything).not.toContain('279250057');
      expect(everything).not.toContain('279250999');
      expect(s.remapItemId(279250057)).toBe(id0);
      expect(new FixtureSanitizer({ salt: 'test-salt' }).remapItemId(279250057)).toBe(id0);
      expect(new FixtureSanitizer({ salt: 'other' }).remapItemId(279250057)).not.toBe(id0);
    });

    it('remaps item ids in request URLs', () => {
      const s = new FixtureSanitizer({ salt: 'test-salt' });
      const id = s.remapItemId(279250057);
      expect(s.sanitizeUrl('https://buyerapi.shopgoodwill.com/api/ItemDetail/GetItemDetailModelByItemId/279250057')).toBe(
        `https://buyerapi.shopgoodwill.com/api/ItemDetail/GetItemDetailModelByItemId/${String(id)}`,
      );
      expect(s.sanitizeUrl('https://shopgoodwill.com/item/279250057')).toBe(`https://shopgoodwill.com/item/${String(id)}`);
    });

    it('remaps private ids and redacts personal fields', () => {
      const detail = new FixtureSanitizer({ salt: 'test-salt' }).sanitizeJson(detailResponse());
      expect(detail.buyerId).not.toBe(987654);
      expect(detail.watchlistId).not.toBe(555001);
      expect(detail.email).not.toContain('someone');
    });

    it("redacts the signed-in buyer's own details and SGW-internal IPs (ItemDetail, favorites)", () => {
      const out = new FixtureSanitizer({ salt: 'test-salt' }).sanitizeJson({
        buyerStreet: '1 Main St',
        buyerZip: '12345',
        buyerState: 'IL',
        buyerCountry: 'United States',
        buyerCountryCode: 'US',
        province: 'IL',
        buyerShippingAddresses: ['12|US|OR|12345', { street: '1 Main St', zip: '12345' }],
        pickupStreet: '500 Sample Rd',
        pickupState: 'OR',
        bidHistory: {
          authenticatedBuyerLogin: 'myusername',
          bidComplete: [{ serverIP: '192.0.2.10', bidIPAddress: '203.0.113.9', bidderName: 'X****y', highBidderName: 'Z****9' }],
        },
        favorite: { watchlistId: 555001, notes: '{"max_bid": 25}' },
      });
      const text = allStrings(out);
      for (const secret of ['1 Main St', '12345', 'myusername', '192.0.2.10', '203.0.113.9', 'max_bid', 'X****y', 'Z****9']) {
        expect(text).not.toContain(secret);
      }
      expect(out.favorite.notes).toHaveLength('{"max_bid": 25}'.length);
      expect([out.buyerState, out.buyerCountry, out.buyerCountryCode, out.province]).toEqual(['[redacted]', '[redacted]', '[redacted]', '[redacted]']);
      // The seller's street identifies the seller (fix round 1, I1); its state stays for the location rule.
      expect(out.pickupStreet).not.toBe('500 Sample Rd');
      expect(out.pickupState).toBe('OR');
    });

    it('keeps 0 ("none") in private-id fields such as the search body savedSearchId', () => {
      const out = new FixtureSanitizer({ salt: 'test-salt' }).sanitizeJson({ savedSearchId: 0, watchlistId: 0, bidLogId: 0, bidHistoryId: 0, buyerId: 77 });
      expect([out.savedSearchId, out.watchlistId, out.bidLogId, out.bidHistoryId]).toEqual([0, 0, 0, 0]);
      expect(out.buyerId).not.toBe(77);
    });

    it('keeps ProblemDetails titles: a validation message is not a listing title', () => {
      const s = new FixtureSanitizer({ salt: 'test-salt' });
      const problem = {
        type: 'https://tools.ietf.org/html/rfc9110#section-15.5.1',
        title: 'One or more validation errors occurred.',
        status: 400,
        errors: { lowPrice: ['Could not convert string to decimal: abc.'] },
      };
      expect(s.sanitizeJson(problem)).toEqual(problem);
      expect(s.sanitizeJson({ itemId: 279250057, title: 'Vintage Pyrex Butterfly Gold Bowl 403' }).title).not.toContain('Pyrex');
    });

    it('fails naming the file and key when a URL inside a value cannot be parsed', () => {
      const s = new FixtureSanitizer({ salt: 'test-salt' });
      expect(() => s.sanitizeJson({ outer: { link: 'see http://[oops for details' } }, 'json/example.json')).toThrow(
        /json\/example\.json: unparseable URL at outer\.link/,
      );
      expect(() => s.sanitizeHtml('<!DOCTYPE html><html><body><a href="http://[oops">x</a></body></html>', 'html/example.html')).toThrow(
        /html\/example\.html: unparseable URL at <a href>/,
      );
    });

    it("replaces the user's own name and username (local redact list) everywhere, case-insensitively", () => {
      const s = new FixtureSanitizer({ salt: 'test-salt', redact: ['JaneQBuyer', 'Jane Buyer', ' ', 'ab'] });
      const html = s.sanitizeHtml(
        '<!DOCTYPE html><html><body><app-header><span>Hi, Jane Buyer</span><a title="janeqbuyer" href="/shopgoodwill/x">JANEQBUYER</a></app-header><p>about</p></body></html>',
      );
      expect(html.toLowerCase()).not.toContain('jane');
      expect(html).toContain('<p>about</p>'); // entries under 3 characters are ignored
      expect(s.sanitizeJson({ greeting: 'Welcome JaneQBuyer!' }).greeting).toBe('Welcome [redacted]!');
      expect(s.findLeaks('hello janeqbuyer')).toEqual(['personal: JaneQBuyer']);
    });

    it('keeps non-sensitive fields unchanged', () => {
      const out = new FixtureSanitizer({ salt: 'test-salt' }).sanitizeJson(searchResponse());
      const orig = searchResponse();
      expect(out.searchResults.itemCount).toBe(2);
      expect(out.searchResults.items.map((r) => [r.currentPrice, r.minimumBid, r.numBids, r.endTime, r.categoryId])).toEqual(
        orig.searchResults.items.map((r) => [r.currentPrice, r.minimumBid, r.numBids, r.endTime, r.categoryId]),
      );
      expect(out.categoryListModel).toEqual(orig.categoryListModel);
    });
  });

  describe('seller identity (fix round 1, I1)', () => {
    // A seller as ItemDetail describes it; every value is invented.
    function sellerDetail() {
      return {
        itemId: 279250057,
        sellerId: 148,
        sellerCompanyName: 'Goodwill Industries of Lower Examplia',
        sellerLandingPageName: 'Samplton ',
        pickupStreet: '42 N. Fictional Blvd',
        pickupCity: 'Samplton (unless otherwise noted in listing)',
        pickupState: 'OR',
        pickupZip: '97999-1234',
        pickupHours: 'Pickup by appointment only, 503-555-0199',
        pickupPolicy: '<p>Pick up at our Samplton store, 42 N. Fictional Blvd.</p>',
        sellerCustomerService: '<p>Thank you for supporting Goodwill of Lower Examplia. Call (503) 555-0199.</p>',
        shippingPolicy: 'Rates are calculated from the 97999 zip code.',
        related: { seller: { name: 'Goodwill Industries of Upper Fakeland', sellerId: 23 } },
      };
    }
    const REAL = ['examplia', 'samplton', 'fictional', '97999', '555-0199', 'fakeland'];

    it('replaces name variants, a nested seller.name, the slug (JSON and href) and pickup street, city, ZIP and phone', () => {
      const s = new FixtureSanitizer({ salt: 'test-salt' });
      const detail = s.sanitizeJson(sellerDetail());
      const info = s.sanitizeJson({ sellerId: 148, companyName: 'Goodwill Industries of Lower Examplia', street: '42 N. Fictional', city: 'Samplton', state: 'OR', zip: '97999' });
      const html = s.sanitizeHtml(
        '<!DOCTYPE html><html><body><a class="seller" href="/Samplton">Goodwill of Lower Examplia</a><p>42 N. Fictional<br> Samplton, OR 97999</p><p>Thanks from Upper Fakeland Goodwill, (503) 555-0199</p></body></html>',
      );
      const text = (allStrings(detail) + allStrings(info) + html).toLowerCase();
      for (const real of REAL) expect(text, real).not.toContain(real);
      // The state stays: the location rule needs it.
      expect(detail.pickupState).toBe('OR');
      expect(info.state).toBe('OR');
      // One synthetic identity per seller, the same in JSON and HTML.
      const slug = detail.sellerLandingPageName.trim();
      expect(slug).toMatch(/^[A-Za-z0-9]+$/);
      expect(html).toContain(`href="/${slug}"`);
      expect(detail.pickupCity.startsWith(slug)).toBe(true);
      expect(info.city).toBe(slug);
      expect(detail.sellerCompanyName).toMatch(/^Goodwill of [A-Z]\d*$/);
      expect(info.companyName).toBe(detail.sellerCompanyName);
      expect(html).toContain(`>${detail.sellerCompanyName}</a>`);
      expect(detail.related.seller.name).toMatch(/^Goodwill of [A-Z]\d*$/);
      expect(detail.related.seller.name).not.toBe(detail.sellerCompanyName);
      // Shapes survive so parsers still see a ZIP and a phone number.
      expect(detail.pickupZip).toMatch(/^\d{5}-\d{4}$/);
      expect(detail.pickupHours).toMatch(/\d{3}-\d{3}-\d{4}$/);
    });

    it('leak-checks learned names, cores, slugs, streets, ZIPs and phones case-insensitively', () => {
      const s = new FixtureSanitizer({ salt: 'test-salt' });
      s.sanitizeJson(sellerDetail());
      for (const leak of ['LOWER EXAMPLIA store', 'visit samplton', '42 n. fictional blvd', 'zip 97999', 'call 503.555.0199', 'upper fakeland']) {
        expect(s.findLeaks(leak), leak).not.toEqual([]);
      }
      expect(s.findLeaks('a clean sentence about OR')).toEqual([]);
    });
  });

  describe('logged-in captures (fix round 1, I2)', () => {
    it('(a) replaces saved shipping addresses in the shipping tab, and the leak check flags any that survive', () => {
      const s = new FixtureSanitizer({ salt: 'test-salt' });
      const html = s.sanitizeHtml(`<!DOCTYPE html><html><body><app-shipping-tab>
        <select id="shippingAddress"><option value="7788991"> 12 Elm Way, OR 97201 United States </option><option value="7788992">PO Box 5, Bend, OR 97701-0005 United States</option></select>
        <select id="country"><option>Puerto Rico</option><option>United States</option></select>
      </app-shipping-tab></body></html>`);
      for (const real of ['Elm Way', '97201', 'PO Box 5', 'Bend', '97701', '7788991']) expect(html, real).not.toContain(real);
      expect(html).toContain('<option>United States</option>');
      expect(html.match(/\[redacted address\]/g)).toHaveLength(2);
      expect(s.findLeaks('<option value="1"> 12 Elm Way, OR 97201 United States </option>')).toContain('address option');
    });

    it('(b) learns the item-page title from app-detail h1[id] and replaces it in <title> and meta tags', () => {
      const s = new FixtureSanitizer({ salt: 'test-salt' });
      const html = s.sanitizeHtml(`<!DOCTYPE html><html><head><title>Rare Example Teapot 77 | ShopGoodwill.com</title>
        <meta property="og:title" content="Rare Example Teapot 77"><meta property="og:description" content="Bidding on Rare Example Teapot 77 starts now">
        <meta name="description" content="Rare Example Teapot 77 at ShopGoodwill"></head>
        <body><app-detail><h1 id="279250057" class="mb-4">Rare Example Teapot 77</h1></app-detail></body></html>`);
      expect(html).not.toContain('Teapot');
      expect(html).not.toContain('279250057');
      expect(html).toContain(`id="${String(s.remapItemId(279250057))}"`);
      expect(s.findLeaks('<title>Rare Example Teapot 77</title>')).not.toEqual([]);
    });

    it('(c) remaps learned private ids (5+ digits) in HTML attributes, hrefs and text', () => {
      const s = new FixtureSanitizer({ salt: 'test-salt' });
      const json = s.sanitizeJson({ watchlistId: 55500123, buyerId: 98765432, shippingAddressId: 4455667, bidLogId: 0 });
      const html = s.sanitizeHtml(
        '<!DOCTYPE html><html><body><a href="/shopgoodwill/favorites?watchlistId=55500123" data-buyer="98765432">Address #4455667</a></body></html>',
      );
      for (const real of ['55500123', '98765432', '4455667']) {
        expect(html, real).not.toContain(real);
        expect(allStrings(json), real).not.toContain(real);
      }
      for (const mapped of [json.watchlistId, json.buyerId, json.shippingAddressId]) expect(html).toContain(String(mapped));
      expect(json.bidLogId).toBe(0);
      expect(s.findLeaks('buyer 98765432')).not.toEqual([]);
    });

    it('(d) the build refuses a real item id in sources.json and writes a sanitized urlPattern to the manifest', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'sbw-sanitize-'));
      mkdirSync(path.join(dir, 'raw', 'user'), { recursive: true });
      writeFileSync(path.join(dir, 'raw', 'user', 'show-bid-modal.json'), '{"itemId":279250057,"sellerId":23,"minimumBid":5,"title":"Rare Example Teapot 77"}');
      const source = (urlPattern: string) =>
        JSON.stringify({
          fixtures: [
            {
              fixture: 'show-bid-modal',
              kind: 'json',
              endpoint: 'showBidModal',
              loggedIn: true,
              from: { type: 'user', file: 'user/show-bid-modal.json', capturedAt: '2026-10-08T12:00:00.000Z', urlPattern },
            },
          ],
        });
      const api = 'GET https://buyerapi.shopgoodwill.com/api/ItemBid/ShowBidModal?itemId=';
      writeFileSync(path.join(dir, 'sources.json'), source(`${api}279250057`));
      expect(() => {
        buildFixtures(new FixtureSanitizer({ salt: 'test-salt' }), dir);
      }).toThrow(/sources\.json: itemId/);

      writeFileSync(path.join(dir, 'sources.json'), source(`${api}{itemId}`));
      buildFixtures(new FixtureSanitizer({ salt: 'test-salt' }), dir);
      const manifest = readFileSync(path.join(dir, 'manifest.json'), 'utf8');
      const fixture = readFileSync(path.join(dir, 'json', 'show-bid-modal.json'), 'utf8');
      expect(manifest).toContain(`${api}{itemId}`);
      expect(manifest + fixture).not.toContain('279250057');
      expect(fixture).not.toContain('Teapot');
    });
  });

  describe('stage-2 fail-closed rules (fix round 2)', () => {
    // A logged-in item page: its seller appears only in the DOM.
    const ITEM_PAGE = `<!DOCTYPE html><html><head><title>Rare Example Teapot 77 | ShopGoodwill.com</title></head><body>
      <app-detail><h1 id="279250057">Rare Example Teapot 77</h1>
      <app-seller-info-tab><a href="/Samplton">Goodwill of Lower Examplia</a><p>42 N. Fictional<br> Samplton, OR 97999</p></app-seller-info-tab>
      </app-detail></body></html>`;
    const ITEM_DETAIL = JSON.stringify({
      itemId: 279250057,
      title: 'Rare Example Teapot 77',
      sellerId: 148,
      sellerCompanyName: 'Goodwill Industries of Lower Examplia',
      sellerLandingPageName: 'Samplton',
      pickupStreet: '42 N. Fictional Blvd',
      pickupCity: 'Samplton',
      pickupState: 'OR',
      pickupZip: '97999',
    });

    it('N1: the build fails on an item page with no ItemDetail JSON for the same item, and scrubs its seller when there is one', () => {
      const pageOnly = tempFixturesDir({ 'item-page.html': ITEM_PAGE }, [userSource('item-page-logged-in', 'html', 'user/item-page.html')]);
      expect(() => {
        buildFixtures(new FixtureSanitizer({ salt: 'test-salt' }), pageOnly);
      }).toThrow(/html\/item-page-logged-in\.html: item page has no ItemDetail JSON for its item among the inputs/);
      expect(existsSync(path.join(pageOnly, 'html', 'item-page-logged-in.html'))).toBe(false);

      // An ItemDetail for ANOTHER item does not count.
      const otherItem = tempFixturesDir({ 'item-page.html': ITEM_PAGE, 'detail.json': ITEM_DETAIL.replace('279250057', '279250099') }, [
        userSource('item-detail-logged-in', 'json', 'user/detail.json'),
        userSource('item-page-logged-in', 'html', 'user/item-page.html'),
      ]);
      expect(() => {
        buildFixtures(new FixtureSanitizer({ salt: 'test-salt' }), otherItem);
      }).toThrow(/no ItemDetail JSON/);

      const both = tempFixturesDir({ 'item-page.html': ITEM_PAGE, 'detail.json': ITEM_DETAIL }, [
        userSource('item-detail-logged-in', 'json', 'user/detail.json'),
        userSource('item-page-logged-in', 'html', 'user/item-page.html'),
      ]);
      buildFixtures(new FixtureSanitizer({ salt: 'test-salt' }), both);
      const html = readFileSync(path.join(both, 'html', 'item-page-logged-in.html'), 'utf8').toLowerCase();
      for (const real of ['examplia', 'samplton', 'fictional', '97999', 'teapot', '279250057']) expect(html, real).not.toContain(real);
    });

    it('N2: phone numbers in every common layout are replaced, and learned ones are found by digits in any layout', () => {
      const s = new FixtureSanitizer({ salt: 'test-salt' });
      const layouts = ['503 555 0199', '1-503-555-0199', '+1 503 555 0199', '5035550199', '(503)555-0199', '503.555.0199'];
      const out = s.sanitizeJson({ sellerCompanyName: 'Goodwill of Examplia', pickupHours: `Call ${layouts.join(' or ')}` });
      expect(out.pickupHours).not.toMatch(/503/);
      expect(out.pickupHours).toMatch(/^Call 555-555-01\d\d or /);
      for (const p of layouts) expect(s.findLeaks(`call ${p} today`), p).not.toEqual([]);
      // A learned number is caught even in a layout the generic pattern does not know.
      expect(s.sanitizeJson({ note2: 'phone: 503 - 555 - 0199' }).note2).not.toMatch(/0199/);
      expect(s.findLeaks('phone: 503 / 555 / 0199')).toContain('learned phone');
      // Not phones: epoch seconds, item ids, dates.
      const plain = s.sanitizeJson({ text: 'at 1791428301 item 279250057 on 2026-10-07' }).text;
      expect(plain).toContain('1791428301');
      expect(plain).toContain('2026-10-07');
    });

    it('N3: only a real ProblemDetails keeps its title', () => {
      const s = new FixtureSanitizer({ salt: 'test-salt' });
      const row = s.sanitizeJson({ itemId: 279250057, status: 1, type: 'auction', title: 'Rare Example Teapot 77' });
      expect(row.title).not.toContain('Teapot');
      const withTrace = { status: 400, type: 'about:blank', title: 'Bad Request', traceId: '00-abc-01' };
      expect(s.sanitizeJson(withTrace)).toEqual(withTrace);
      const withErrors = { status: 400, title: 'One or more validation errors occurred.', errors: { page: ['bad'] } };
      expect(s.sanitizeJson(withErrors)).toEqual(withErrors);
      const httpType = { status: 404, type: 'https://tools.ietf.org/html/rfc9110#section-15.5.5', title: 'Not Found' };
      expect(s.sanitizeJson(httpType)).toEqual(httpType);
    });

    it('N4: the shipping-tab rule keeps quantity options and redacts only address-like ones', () => {
      const html = new FixtureSanitizer({ salt: 'test-salt' }).sanitizeHtml(`<!DOCTYPE html><html><body><app-shipping-tab>
        <select id="quantity"><option>1</option><option>2</option><option>10</option></select>
        <select id="address"><option>Select an address</option><option>12 Elm Way, Bend</option></select>
        <select id="country"><option>United States</option></select></app-shipping-tab></body></html>`);
      for (const kept of ['<option>1</option>', '<option>2</option>', '<option>10</option>', '<option>Select an address</option>', '<option>United States</option>']) {
        expect(html, kept).toContain(kept);
      }
      expect(html).not.toContain('Elm Way');
      expect(html.match(/\[redacted address\]/g)).toHaveLength(1);
    });

    it('N5: user JSON with an unclassified *id key fails the build, naming the key but not its value', () => {
      expect(unclassifiedIdKeys({ itemId: 1, sellerId: 2, watchlistId: 3, minimumBid: 4, nested: [{ favoriteGroupId: 5, categoryId: 6 }], id: 7 })).toEqual(['favoriteGroupId', 'id']);
      const dir = tempFixturesDir({ 'favs.json': '{"data":[{"itemId":279250057,"favoriteGroupId":8675309}]}' }, [
        { ...userSource('favorites-open', 'json', 'user/favs.json'), endpoint: 'favorites' },
      ]);
      let message = '';
      try {
        buildFixtures(new FixtureSanitizer({ salt: 'test-salt' }), dir);
      } catch (e) {
        message = e instanceof Error ? e.message : String(e);
      }
      expect(message).toMatch(/json\/favorites-open\.json: unclassified id key\(s\) in user JSON: favoriteGroupId/);
      expect(message).not.toContain('8675309');
      expect(existsSync(path.join(dir, 'json', 'favorites-open.json'))).toBe(false);
    });
  });

  describe('secrets', () => {
    it('no Authorization, Cookie or Set-Cookie survives in header maps or HAR-style header arrays', () => {
      const s = new FixtureSanitizer({ salt: 'test-salt' });
      const out = s.sanitizeJson({
        request: {
          headers: { Authorization: `Bearer ${JWT}`, Cookie: 'cookieSession_8=abc', 'Content-Type': 'application/json' },
        },
        response: {
          headers: [
            { name: 'set-cookie', value: 'Bid=1; Path=/' },
            { name: 'X-Azure-Ref', value: '0abc' },
            { name: 'content-type', value: 'application/json' },
          ],
        },
        accessToken: JWT,
        nested: { note: `token ${JWT} here` },
      });
      const text = allStrings(out).toLowerCase();
      expect(text).not.toContain('authorization');
      expect(text).not.toContain('cookie');
      expect(text).not.toContain('x-azure-ref');
      expect(allStrings(out)).not.toContain(JWT);
      expect(allStrings(out)).toContain('content-type');
      expect(s.sanitizeHeaders({ authorization: 'Bearer x', cookie: 'a=b', 'set-cookie': 'c=d', date: 'Thu' })).toEqual({ date: 'Thu' });
    });

    it('strips JWT-shaped strings, scripts, iframes and inline handlers from HTML', () => {
      const html = new FixtureSanitizer({ salt: 'test-salt' }).sanitizeHtml(CARD_HTML);
      expect(html).not.toContain(JWT);
      expect(html.toLowerCase()).not.toContain('<script');
      expect(html.toLowerCase()).not.toContain('<iframe');
      expect(html).not.toMatch(/\sonclick=/i);
      expect(html).not.toContain('javascript:');
      expect(html).not.toContain('doubleclick');
      expect(html).not.toMatch(/<link[^>]+stylesheet/i);
      // Structure the DOM adapter relies on survives.
      expect(html).toContain('app-home-product-items');
      expect(html).toContain('class="feat-item_name"');
      expect(html).toContain('aria-label="Add to your Favorites list"');
      expect(html).toContain('_ngcontent-ng-c1');
    });

    it('isJwtLike recognises JWT-shaped strings only', () => {
      expect(isJwtLike(JWT)).toBe(true);
      expect(isJwtLike('2026-10-07T19:18:30')).toBe(false);
      expect(isJwtLike('a.b.c')).toBe(false);
    });
  });
});
