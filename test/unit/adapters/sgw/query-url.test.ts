// T-50: SGW search URL <-> SearchQuery. Param names live only in the adapter (I-26).
import { describe, expect, it } from 'vitest';

import { searchQueryFromUrl, searchQueryToUrl } from '../../../../src/adapters/sgw/query-url';
import { SearchQuerySchema, type SearchQuery } from '../../../../src/domain/types';

// Built in the exact format of SGW's buildSearchQueryString (S-1 section 4, config.ts).
// Repoint this constant at the user-observed URL once T-07 stage 2 delivers it.
const OBSERVED_URL =
  'https://shopgoodwill.com/categories/listing?st=vintage%20lamp&sg=&c=12,34&s=7&lp=5&hp=50.5&sbn=&spo=false&snpo=true&socs=false&sd=true&sca=false&caed=10/8/2026&cadb=7&scs=false&sis=false&col=1&p=2&ps=40&desc=false&ss=0&UseBuyerPrefs=true&sus=false&cln=1&catIds=&pn=&wc=false&mci=false&hmt=false&layout=grid&ihp=';

function parse(url: string): SearchQuery {
  const q = searchQueryFromUrl(url);
  if (q === null) throw new Error('expected a query');
  return q;
}

describe('searchQueryFromUrl', () => {
  it('maps the named params into SGW-neutral fields', () => {
    const q = parse(OBSERVED_URL);
    expect(q).toMatchObject({
      searchText: 'vintage lamp',
      categoryIds: [12, 34],
      sellerIds: [7],
      lowPrice: 500,
      highPrice: 5050,
      pickupOnly: false,
      excludePickupOnly: true,
      oneCentShippingOnly: false,
      searchDescriptions: true,
      closedAuctions: false,
      sortColumn: 1,
      sortDescending: false,
      page: 2,
      layout: 'grid',
    });
    expect(SearchQuerySchema.safeParse(q).success).toBe(true);
  });

  it('keeps every other param in extra, verbatim and in URL order', () => {
    const q = parse(OBSERVED_URL);
    expect(Object.keys(q.extra ?? {})).toEqual([
      'sg', 'sbn', 'caed', 'cadb', 'scs', 'sis', 'ps', 'ss', 'UseBuyerPrefs', 'sus', 'cln', 'catIds', 'pn', 'wc', 'mci', 'hmt', 'ihp',
    ]);
    expect(q.extra).toMatchObject({ caed: '10/8/2026', cadb: '7', ps: '40', UseBuyerPrefs: 'true', sg: '' });
  });

  it('preserves unknown params in extra', () => {
    const q = parse('https://shopgoodwill.com/categories/listing?st=a&zzz=1&future=x%20y&p=1');
    expect(q.extra).toEqual({ zzz: '1', future: 'x y' });
  });

  it('strips surrounding quotes, plain and URL-encoded', () => {
    expect(parse('https://shopgoodwill.com/categories/listing?st="lamp"').searchText).toBe('lamp');
    expect(parse('https://shopgoodwill.com/categories/listing?st=%22lamp%22').searchText).toBe('lamp');
    expect(parse('https://shopgoodwill.com/categories/listing?st=%22red%20lamp%22').searchText).toBe('red lamp');
  });

  it('defaults page to 1 and tolerates a bare search URL', () => {
    const q = parse('https://shopgoodwill.com/categories/listing');
    expect(q).toMatchObject({ searchText: '', categoryIds: [], sellerIds: [], page: 1 });
  });

  it('keeps unparseable values of named params in extra instead of inventing fields', () => {
    const q = parse('https://shopgoodwill.com/categories/listing?c=abc&lp=cheap&spo=maybe&p=0&layout=wide');
    expect(q.categoryIds).toEqual([]);
    expect(q.lowPrice).toBeUndefined();
    expect(q.pickupOnly).toBeUndefined();
    expect(q.page).toBe(1);
    expect(q.layout).toBeUndefined();
    expect(q.extra).toEqual({ c: 'abc', lp: 'cheap', spo: 'maybe', p: '0', layout: 'wide' });
  });

  it('returns null for non-search URLs', () => {
    expect(searchQueryFromUrl('not a url')).toBeNull();
    expect(searchQueryFromUrl('https://example.com/categories/listing?st=a')).toBeNull();
    expect(searchQueryFromUrl('https://shopgoodwill.com/item/123')).toBeNull();
  });

  it.todo('round-trips the user-observed S-1 URL (T-07 stage 2)');
});

describe('searchQueryToUrl', () => {
  it('round-trips the SGW-format URL: url -> query -> url -> query', () => {
    const q = parse(OBSERVED_URL);
    expect(parse(searchQueryToUrl(q))).toEqual(q);
  });

  it('re-emits every param of the SGW-format fixture with the same value', () => {
    const a = new URL(searchQueryToUrl(parse(OBSERVED_URL))).searchParams;
    const b = new URL(OBSERVED_URL).searchParams;
    expect([...a.keys()].sort()).toEqual([...b.keys()].sort());
    for (const [k, v] of b) expect(a.get(k), k).toBe(v);
  });

  it('never emits quotes', () => {
    const url = searchQueryToUrl({ searchText: '"lamp" "x"', categoryIds: [], sellerIds: [], page: 1 });
    expect(url).not.toMatch(/"|%22/);
    expect(parse(url).searchText).toBe('lamp x');
  });

  it('omits unset optional fields and formats prices', () => {
    const url = searchQueryToUrl({ searchText: 'a b', categoryIds: [], sellerIds: [], lowPrice: 1250, highPrice: 1000, page: 3 });
    const p = new URL(url).searchParams;
    expect(p.get('st')).toBe('a b');
    expect(p.get('lp')).toBe('12.5');
    expect(p.get('hp')).toBe('10');
    expect(p.get('p')).toBe('3');
    expect(p.has('spo')).toBe(false);
    expect(p.has('c')).toBe(false);
  });

  it('a mapped field wins over a colliding extra key', () => {
    const url = searchQueryToUrl({ searchText: 'x', categoryIds: [], sellerIds: [], page: 2, extra: { p: '9', zzz: '1' } });
    const p = new URL(url).searchParams;
    expect(p.getAll('p')).toEqual(['2']);
    expect(p.get('zzz')).toBe('1');
  });
});
