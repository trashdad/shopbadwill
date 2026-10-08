// T-50: SGW search page URL <-> domain SearchQuery (I-26). The only place the
// domain query meets SGW's URL parameter names; the 31-name map lives in
// config.ts (SGW_SEARCH_URL_PARAMS). Params without a SearchQuery field (and
// values of named params that do not parse) are kept verbatim in `extra`, in
// URL order, so a round trip never loses what the user searched for.
import { formatCents, parseCents } from '../../domain/money';
import type { Cents, SearchQuery } from '../../domain/types';
import { SGW_ORIGIN, SGW_SEARCH_URL_PARAMS } from './config';

type UrlParam = keyof typeof SGW_SEARCH_URL_PARAMS;

const SEARCH_PATH = '/categories/listing';
const HOSTS = new Set(['shopgoodwill.com', 'www.shopgoodwill.com']);

/** Parameters mapped to SearchQuery fields, in the order they are emitted. */
const NAMED: readonly UrlParam[] = ['st', 'c', 's', 'lp', 'hp', 'spo', 'snpo', 'socs', 'sd', 'sca', 'col', 'p', 'desc', 'layout'];

/** Double quotes make buyerapi answer 403; surrounding quotes mean exact-phrase on the site. Never keep them. */
function stripQuotes(text: string): string {
  return text.replaceAll('"', '').trim();
}

function parseBool(v: string): boolean | undefined {
  const t = v.trim().toLowerCase();
  return t === 'true' ? true : t === 'false' ? false : undefined;
}

function parseInt10(v: string): number | undefined {
  return /^\d+$/.test(v.trim()) ? Number(v.trim()) : undefined;
}

/** "12,34" -> [12, 34]; empty -> []; any non-numeric token -> undefined (kept raw in extra). */
function parseIdList(v: string): number[] | undefined {
  if (v.trim() === '') return [];
  const ids: number[] = [];
  for (const token of v.split(',')) {
    const n = parseInt10(token);
    if (n === undefined) return undefined;
    ids.push(n);
  }
  return ids;
}

function priceText(cents: Cents): string {
  const t = formatCents(cents);
  return t.endsWith('.00') ? t.slice(0, -3) : t.endsWith('0') ? t.slice(0, -1) : t;
}

/**
 * Parses a shopgoodwill.com search page URL. Returns null for anything that is
 * not one (bad URL, other host, other path).
 */
export function searchQueryFromUrl(url: string): SearchQuery | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!HOSTS.has(u.hostname.toLowerCase())) return null;
  if (u.pathname.replace(/\/+$/, '') !== SEARCH_PATH) return null;

  const q: SearchQuery = { searchText: '', categoryIds: [], sellerIds: [], page: 1 };
  const extra: Record<string, string> = {};
  const named = new Set<string>(NAMED);

  for (const [key, value] of u.searchParams) {
    if (!named.has(key)) {
      extra[key] = value;
      continue;
    }
    let ok = true;
    switch (key as UrlParam) {
      case 'st':
        q.searchText = stripQuotes(value);
        break;
      case 'c': {
        const ids = parseIdList(value);
        if (ids === undefined) ok = false;
        else q.categoryIds = ids;
        break;
      }
      case 's': {
        const ids = parseIdList(value);
        if (ids === undefined) ok = false;
        else q.sellerIds = ids;
        break;
      }
      case 'lp':
      case 'hp': {
        const cents = parseCents(value);
        if (cents === null) ok = false;
        else if (key === 'lp') q.lowPrice = cents;
        else q.highPrice = cents;
        break;
      }
      case 'spo':
      case 'snpo':
      case 'socs':
      case 'sd':
      case 'sca':
      case 'desc': {
        const b = parseBool(value);
        if (b === undefined) ok = false;
        else if (key === 'spo') q.pickupOnly = b;
        else if (key === 'snpo') q.excludePickupOnly = b;
        else if (key === 'socs') q.oneCentShippingOnly = b;
        else if (key === 'sd') q.searchDescriptions = b;
        else if (key === 'sca') q.closedAuctions = b;
        else q.sortDescending = b;
        break;
      }
      case 'col': {
        const n = parseInt10(value);
        if (n === undefined) ok = false;
        else q.sortColumn = n;
        break;
      }
      case 'p': {
        const n = parseInt10(value);
        if (n === undefined || n < 1) ok = false;
        else q.page = n;
        break;
      }
      case 'layout':
        if (value === 'grid' || value === 'list') q.layout = value;
        else ok = false;
        break;
      default:
        ok = false;
    }
    if (!ok) extra[key] = value;
  }

  if (Object.keys(extra).length > 0) q.extra = extra;
  return q;
}

const enc = (s: string): string => encodeURIComponent(s).replaceAll('%2C', ',').replaceAll('%2F', '/');

/** Builds the search page URL for `q`. Never emits quotes; unset optional fields are omitted. */
export function searchQueryToUrl(q: SearchQuery): string {
  const out: Array<[string, string]> = [];
  const emitted = new Set<string>();
  const put = (key: UrlParam, value: string | undefined): void => {
    if (value === undefined) return;
    out.push([key, value]);
    emitted.add(key);
  };
  const bool = (b: boolean | undefined): string | undefined => (b === undefined ? undefined : b ? 'true' : 'false');

  put('st', stripQuotes(q.searchText));
  put('c', q.categoryIds.length > 0 ? q.categoryIds.join(',') : undefined);
  put('s', q.sellerIds.length > 0 ? q.sellerIds.join(',') : undefined);
  put('lp', q.lowPrice === undefined ? undefined : priceText(q.lowPrice));
  put('hp', q.highPrice === undefined ? undefined : priceText(q.highPrice));
  put('spo', bool(q.pickupOnly));
  put('snpo', bool(q.excludePickupOnly));
  put('socs', bool(q.oneCentShippingOnly));
  put('sd', bool(q.searchDescriptions));
  put('sca', bool(q.closedAuctions));
  put('col', q.sortColumn === undefined ? undefined : String(q.sortColumn));
  put('p', String(q.page));
  put('desc', bool(q.sortDescending));
  put('layout', q.layout);

  for (const [key, value] of Object.entries(q.extra ?? {})) {
    if (!emitted.has(key)) out.push([key, value.replaceAll('"', '')]);
  }
  return `${SGW_ORIGIN}${SEARCH_PATH}?${out.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&')}`;
}
