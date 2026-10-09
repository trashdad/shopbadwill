// Normalizers: validated raw SGW responses -> frozen domain shapes (Listing,
// ItemDetail, Favorite, ...). Pure functions; no I/O. T-24.
//
// Conversions live in one place so every caller agrees:
//  - dollars (JSON numbers) -> integer cents through domain/money `parseCents`
//  - naive Pacific timestamps -> UTC instants through domain/time/pacific
//  - HTML (`message`) -> plain text
// Each function takes the RAW response, validates it (SgwApiError 'schema' with
// the failing path) and then maps it.
import { parseCents } from '../../domain/money';
import { parsePacific, parsePacificDetailed } from '../../domain/time/pacific';
import type { Cents, EpochMs, Favorite, ItemDetail, Listing, SearchQuery } from '../../domain/types';
import { SgwApiError } from '../../ports/errors';
import { SGW_FIELDS, SGW_SEARCH_URL_PARAMS } from './config';
import {
  CurrentTimeResponseSchema,
  FavoritesResponseSchema,
  ItemDetailResponseSchema,
  PlaceBidResponseSchema,
  SavedSearchesResponseSchema,
  SearchResponseSchema,
  SearchRowSchema,
  SgwEnvelopeHeadSchema,
  SellerInfoResponseSchema,
  ShippingQuoteResponseSchema,
  ShowBidModalResponseSchema,
  parseSgw,
} from './schemas';

// ── Scalars ─────────────────────────────────────────────────────────────────

/** 67.01 -> 6701. Goes through the two-decimal string so no float error survives. */
export function dollarsToCents(dollars: number, label = 'amount'): Cents {
  const cents = parseCents(dollars.toFixed(2));
  if (cents === null) throw new SgwApiError('schema', `${label}: not a money amount: ${String(dollars)}`);
  return cents;
}

function pacificToMs(raw: string, label: string): number {
  try {
    return parsePacific(raw);
  } catch (e) {
    throw new SgwApiError('schema', `${label}: not a Pacific time: ${raw}`, { cause: e });
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  sbquo: '‚',
  bdquo: '„',
  copy: '©',
  reg: '®',
  trade: '™',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  bull: '•',
  middot: '·',
  deg: '°',
  cent: '¢',
  pound: '£',
  euro: '€',
  frac12: '½',
  frac14: '¼',
  frac34: '¾',
  times: '×',
  eacute: 'é',
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * HTML -> plain text, for SGW's `message` fields. Block tags become line
 * breaks, real tags (`<` followed by a letter, `/` or `!`) vanish, entities are
 * decoded, whitespace is collapsed. A bare `<` or `>` in prose is kept. An
 * unclosed `<script>`/`<style>` drops everything after it. Tags are removed
 * before entities are decoded, so `&lt;b&gt;` stays the literal text "<b>".
 * The result is for text rendering only, never innerHTML.
 */
export function htmlToText(html: string): string {
  const noBlocks = html
    .replace(/<!--[\s\S]*?(-->|$)/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(script|style)\b[\s\S]*$/i, ' ')
    .replace(/<br\b[^>]*>|<\/(p|div|li|tr|h[1-6]|ul|ol|table)\s*>/gi, '\n');
  const text = decodeEntities(noBlocks.replace(/<[a-zA-Z/!][^>]*>/g, ''));
  return text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

// ── Context ─────────────────────────────────────────────────────────────────

export interface NormalizeContext {
  /** EpochMs the response was received; becomes `Listing.observedAt`. */
  observedAt: EpochMs;
  /**
   * Whether the request carried a bearer. Anonymous replies say `false` for
   * `inWatchlist` / `isHighBidderLogIn`, which means "unknown", so they map to null.
   */
  authenticated: boolean;
}

/** The part of the request that decides what a search row implies. */
export interface SearchNormalizeContext extends NormalizeContext {
  query: Pick<SearchQuery, 'page' | 'pickupOnly' | 'excludePickupOnly'>;
}

/**
 * Shared first step for enveloped replies (`{status, message, isUnauthorized,
 * data}`): `isUnauthorized` is an `auth` error and `status: false` a `server`
 * error, BEFORE `data` is looked at, so a failure is never read as an empty
 * list or reported as a schema error. Replies of unconfirmed wrapping
 * (`flat: true`) are only unwrapped when they look enveloped.
 */
function checkEnvelope(raw: unknown, label: string, flat = false): void {
  if (flat) {
    // The bare shapes have no `status` key, so its presence marks an envelope.
    const looksEnveloped = typeof raw === 'object' && raw !== null && 'status' in raw;
    if (!looksEnveloped) return;
  }
  const head = parseSgw(SgwEnvelopeHeadSchema, raw, label);
  if (head.isUnauthorized === true) throw new SgwApiError('auth', `${label}: SGW says unauthorized`);
  if (!head.status) throw new SgwApiError('server', `${label}: status false${head.message ? `: ${head.message}` : ''}`);
}

// ── Search ──────────────────────────────────────────────────────────────────

/**
 * Search rows carry no seller name, state or pickup flag: `sellerState` stays
 * unset, and `pickupOnly` is only known from the query's own filter
 * (`pickupOnly: true` -> true, `excludePickupOnly: true` -> false), else left
 * unset (unknown) until ItemDetail says otherwise. `shippingPrice` 0 means "calculated" (the site shows 0 for nearly
 * every row), so it maps to null; 0.01 is a real one-cent price.
 */
export function normalizeSearchRow(row: unknown, ctx: SearchNormalizeContext, label = 'search.row'): Listing {
  const r = parseSgw(SearchRowSchema, row, label);
  const endTimeMs = pacificToMs(r.endTime, `${label}.endTime`);
  const listing: Listing = {
    itemId: r.itemId,
    title: r.title,
    currentPrice: dollarsToCents(r.currentPrice, `${label}.currentPrice`),
    startingMinimumBid: dollarsToCents(r.minimumBid, `${label}.minimumBid`),
    numBids: r.numBids,
    endTime: iso(endTimeMs),
    endTimeRaw: r.endTime,
    sellerId: r.sellerId,
    source: 'api',
    observedAt: ctx.observedAt,
  };
  if (ctx.query.pickupOnly === true) listing.pickupOnly = true;
  else if (ctx.query.excludePickupOnly === true) listing.pickupOnly = false;
  if (r.categoryId !== undefined) listing.categoryId = r.categoryId;
  if (r.catFullName) listing.categoryPath = r.catFullName;
  if (r.shippingPrice !== undefined) {
    listing.shippingPrice = r.shippingPrice === null || r.shippingPrice === 0 ? null : dollarsToCents(r.shippingPrice);
  }
  if (r.buyNowPrice !== undefined) {
    listing.buyNowPrice = r.buyNowPrice === null || r.buyNowPrice === 0 ? null : dollarsToCents(r.buyNowPrice);
  }
  if (r.imageURL) listing.imageUrl = r.imageURL;
  if (ctx.authenticated && r.isFavorite !== undefined) listing.isFavorite = r.isFavorite;
  if (r.relistId !== undefined) listing.relistId = r.relistId === 0 ? null : r.relistId;
  return listing;
}

export interface NormalizedSearch {
  items: Listing[];
  total: number;
  page: number;
}

/** `ctx.query.page` is echoed back (the response does not carry it). */
export function normalizeSearch(raw: unknown, ctx: SearchNormalizeContext): NormalizedSearch {
  const r = parseSgw(SearchResponseSchema, raw, 'search');
  if (r.categoryListModel === null) {
    // A 200 with a null categoryListModel marks a server-side error, not an empty result.
    throw new SgwApiError('server', 'search: categoryListModel is null (server-side error)');
  }
  return {
    items: r.searchResults.items.map((row, i) =>
      normalizeSearchRow(row, ctx, `search.searchResults.items[${String(i)}]`),
    ),
    total: r.searchResults.itemCount,
    page: ctx.query.page,
  };
}

// ── ItemDetail ──────────────────────────────────────────────────────────────

/** "427|Travel/Luggage|428|Suitcases" -> "Travel/Luggage > Suitcases" (id|name pairs). */
function categoryPathOf(list: string): string | undefined {
  const parts = list.split('|');
  const names = parts.filter((_, i) => i % 2 === 1).filter((n) => n !== '');
  return names.length > 0 ? names.join(' > ') : undefined;
}

/** imageServer + the first `;`-separated path of imageUrlString (backslash separators). */
function imageUrlOf(server: string | null | undefined, paths: string | null | undefined): string | undefined {
  const first = paths?.split(';').find((p) => p.trim() !== '');
  if (first === undefined) return undefined;
  const rel = first.trim().replaceAll('\\', '/').replace(/^\/+/, '');
  if (/^https?:\/\//i.test(rel)) return rel;
  if (!server) return undefined;
  return `${server.endsWith('/') ? server : `${server}/`}${rel}`;
}

const UsStateRe = /^[A-Z]{2}$/;

/**
 * ItemDetail `serverTime` has no offset. In the fall-back hour the wall time
 * happens twice; `parsePacific` picks the earlier instant, so choose whichever
 * of the two candidates is nearest `nearMs` (when we received the reply).
 */
function serverTimeMs(raw: string, nearMs: number): number {
  let parsed;
  try {
    parsed = parsePacificDetailed(raw);
  } catch (e) {
    throw new SgwApiError('schema', `itemDetail.serverTime: not a Pacific time: ${raw}`, { cause: e });
  }
  if (!parsed.ambiguous) return parsed.ms;
  const later = parsed.ms + 3_600_000;
  return Math.abs(later - nearMs) < Math.abs(parsed.ms - nearMs) ? later : parsed.ms;
}

/**
 * `bidHistory` is the per-bid log (`bidHistory.bidComplete`), retracted bids
 * dropped, newest first. Its `bidAmount` is the bidder's OWN bid (their max);
 * `itemPrice` (not read) is the resulting price. While the auction is open the
 * leader's `bidAmount` is masked to the current price (the open fixture shows
 * 67.01 where the closed one shows 71 for the same bid), so amounts are only
 * exact once closed. `numBids > bidHistory.length` signals dropped (retracted)
 * bids. `minimumBid` is the NEXT acceptable bid.
 * `pickupState` (the seller's state) becomes `sellerState`, the field the
 * rules engine's `location` condition reads. `shippingPrice` 0 with
 * `allowShippingCalculation` is "calculated" -> null.
 */
export function normalizeItemDetail(raw: unknown, ctx: NormalizeContext): ItemDetail {
  const d = parseSgw(ItemDetailResponseSchema, raw, 'itemDetail');
  const endMs = pacificToMs(d.endTime, 'itemDetail.endTime');
  const serverMs = serverTimeMs(d.serverTime, ctx.observedAt);

  const bidHistory = d.bidHistory.bidComplete
    .map((b, i) => ({ b, ms: pacificToMs(b.bidTime, `itemDetail.bidHistory.bidComplete[${String(i)}].bidTime`) }))
    .filter(({ b }) => b.retracted !== true)
    .sort((x, y) => y.ms - x.ms)
    .map(({ b, ms }) => ({
      amount: dollarsToCents(b.bidAmount),
      time: iso(ms),
      timeRaw: b.bidTime,
      bidderMasked: b.bidderName,
    }));

  const detail: ItemDetail = {
    itemId: d.itemId,
    title: d.title,
    currentPrice: dollarsToCents(d.currentPrice, 'itemDetail.currentPrice'),
    startingMinimumBid: dollarsToCents(d.startingPrice, 'itemDetail.startingPrice'),
    numBids: d.numberOfBids,
    endTime: iso(endMs),
    endTimeRaw: d.endTime,
    sellerId: d.sellerId,
    pickupOnly: d.pickupOnly,
    source: 'api',
    observedAt: ctx.observedAt,
    minimumBid: dollarsToCents(d.minimumBid, 'itemDetail.minimumBid'),
    bidIncrement: dollarsToCents(d.bidIncrement, 'itemDetail.bidIncrement'),
    serverTime: iso(serverMs),
    serverTimeRaw: d.serverTime,
    isClosed: d.bidHistory.auctionClosed || d.isItemEndTimeExpire,
    isHighBidder: ctx.authenticated ? d.bidHistory.isHighBidderLogIn : null,
    inWatchlist: ctx.authenticated ? d.inWatchlist : null,
    bidHistory,
  };
  if (d.sellerCompanyName) detail.sellerName = d.sellerCompanyName;
  if (d.pickupState && UsStateRe.test(d.pickupState)) detail.sellerState = d.pickupState;
  if (d.categoryId !== undefined) detail.categoryId = d.categoryId;
  if (d.categoryParentList) {
    const path = categoryPathOf(d.categoryParentList);
    if (path !== undefined) detail.categoryPath = path;
  }
  detail.shippingPrice =
    d.shippingPrice === null || (d.shippingPrice === 0 && d.allowShippingCalculation === true)
      ? null
      : dollarsToCents(d.shippingPrice, 'itemDetail.shippingPrice');
  if (d.handlingPrice !== undefined && d.handlingPrice !== null) detail.handlingPrice = dollarsToCents(d.handlingPrice);
  if (d.buyNowPrice !== undefined)
    detail.buyNowPrice = d.buyNowPrice === null || d.buyNowPrice === 0 ? null : dollarsToCents(d.buyNowPrice);
  const image = imageUrlOf(d.imageServer, d.imageUrlString);
  if (image !== undefined) detail.imageUrl = image;
  return detail;
}

// ── Clock ───────────────────────────────────────────────────────────────────

/** "10/07/2026 20:09:15" (Pacific) -> epoch ms. 1 s resolution. */
export function normalizeCurrentTime(raw: unknown): EpochMs {
  checkEnvelope(raw, 'currentTime');
  const r = parseSgw(CurrentTimeResponseSchema, raw, 'currentTime');
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(r.data);
  if (m === null) throw new SgwApiError('schema', `currentTime.data: unreadable: ${r.data}`);
  return pacificToMs(`${m[3] ?? ''}-${m[1] ?? ''}-${m[2] ?? ''}T${m[4] ?? ''}`, 'currentTime.data');
}

// ── Seller ──────────────────────────────────────────────────────────────────

export function normalizeSellerInfo(raw: unknown): { sellerId: number; name: string; state?: string } {
  const s = parseSgw(SellerInfoResponseSchema, raw, 'sellerInfo');
  const out: { sellerId: number; name: string; state?: string } = { sellerId: s.sellerId, name: s.companyName };
  if (s.state && UsStateRe.test(s.state)) out.state = s.state;
  return out;
}

// ── Endpoints without a fixture yet (provisional schemas) ───────────────────

/** Open/closed comes from each row's `type` ("Open"/"Close"); `nowMs` is the fallback when `type` is missing or unknown. */
export function normalizeFavorites(raw: unknown, nowMs: EpochMs): Favorite[] {
  checkEnvelope(raw, 'favorites');
  const r = parseSgw(FavoritesResponseSchema, raw, 'favorites');
  return r.data.map((f, i) => {
    const endMs = pacificToMs(f.endTime, `favorites.data[${String(i)}].endTime`);
    return {
      itemId: f.itemId,
      watchlistId: f.watchlistId,
      notes: f.notes ?? '',
      endTime: iso(endMs),
      sellerId: f.sellerId,
      // The row's own `type` wins; endTime vs the clock only when it is missing or unknown.
      status:
        f.type === SGW_FIELDS.favoriteRow.statusClosed ? 'closed' : f.type === SGW_FIELDS.favoriteRow.statusOpen ? 'open' : endMs <= nowMs ? 'closed' : 'open',
    };
  });
}

function idList(csv: string | null | undefined): number[] {
  return (csv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s))
    .map(Number);
}

function priceCents(v: string | number | null | undefined): Cents | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  return typeof v === 'number' ? dollarsToCents(v) : (parseCents(v) ?? undefined);
}

/** Row fields with a URL param but no SearchQuery field: kept in `extra` when non-empty. */
const SAVED_EXTRA_FIELDS = ['selectedGroup', 'searchBuyNowOnly'] as const;
/** Same, but only meaningful for closed-auction searches. */
const SAVED_CLOSED_EXTRA_FIELDS = ['closedAuctionDaysBack', 'closedAuctionEndingDate'] as const;

/** Body field name -> URL param key, read from SGW_SEARCH_URL_PARAMS (the map the URL parser uses). */
function urlKeyOf(field: string): string | undefined {
  return Object.entries(SGW_SEARCH_URL_PARAMS).find(([, f]) => f === field)?.[0];
}

/**
 * SGW's saved-search rows carry NO name. The port's `name` is derived from
 * `searchText` (trimmed), falling back to `Search #<id>`; a legacy `searchName`
 * (T-24's old guess) wins when present. Filter fields map to SearchQuery the
 * way the URL parser does (booleans as-is, prices to cents through parseCents);
 * fields with a URL param but no SearchQuery field go to `extra`.
 */
export function normalizeSavedSearches(raw: unknown): Array<{ id: number; name: string; query: SearchQuery }> {
  checkEnvelope(raw, 'savedSearches');
  const r = parseSgw(SavedSearchesResponseSchema, raw, 'savedSearches');
  return r.data.map((s) => {
    const id = (s.savedSearchId ?? s.saveSearchId) as number;
    const query: SearchQuery = {
      searchText: (s.searchText ?? '').replaceAll('"', '').trim(),
      categoryIds: idList(s.selectedCategoryIds),
      sellerIds: idList(s.selectedSellerIds),
      page: 1,
    };
    const lo = priceCents(s.lowPrice);
    const hi = priceCents(s.highPrice);
    if (lo !== undefined) query.lowPrice = lo;
    if (hi !== undefined) query.highPrice = hi;
    if (typeof s.searchPickupOnly === 'boolean') query.pickupOnly = s.searchPickupOnly;
    if (typeof s.searchNoPickupOnly === 'boolean') query.excludePickupOnly = s.searchNoPickupOnly;
    if (typeof s.searchOneCentShippingOnly === 'boolean') query.oneCentShippingOnly = s.searchOneCentShippingOnly;
    if (typeof s.searchClosedAuctions === 'boolean') query.closedAuctions = s.searchClosedAuctions;
    if (typeof s.sortColumn === 'number') query.sortColumn = s.sortColumn;
    if (typeof s.sortDescending === 'boolean') query.sortDescending = s.sortDescending;
    if (s.layout === 'grid' || s.layout === 'list') query.layout = s.layout;

    const extra: Record<string, string> = {};
    const fields = query.closedAuctions === true ? [...SAVED_EXTRA_FIELDS, ...SAVED_CLOSED_EXTRA_FIELDS] : SAVED_EXTRA_FIELDS;
    for (const f of fields) {
      const v = (s as Record<string, unknown>)[f];
      const key = urlKeyOf(f);
      if (key !== undefined && (typeof v === 'string' || typeof v === 'number') && String(v) !== '') extra[key] = String(v);
    }
    if (Object.keys(extra).length > 0) query.extra = extra;

    const name = (s.searchName ?? '').trim() || query.searchText || `Search #${String(id)}`;
    return { id, name, query };
  });
}

// Labels come from SGW_FIELDS.shippingQuote (config.ts).
const SQ = SGW_FIELDS.shippingQuote;

/**
 * "¤11.04 (GROUND_HOME_DELIVERY)" / "$3.00" -> cents. Any 1-3 char currency sign
 * is allowed (the fixture shows the generic ¤); the "(SERVICE_LEVEL)" suffix is
 * ignored. null for anything that is not exactly one amount of at most 2 decimals.
 */
function quoteAmountCents(text: string): Cents | null {
  const m = /^[^\d\s-]{0,3}\s*(\d[\d,]*(?:\.\d+)?)(?:\s*\(.*\))?$/.exec(text.trim());
  return m?.[1] === undefined ? null : parseCents(m[1]);
}

/** The text after `label` on the first line that starts with it. */
function quoteLine(lines: string[], label: string): string | undefined {
  const line = lines.find((l) => l.startsWith(label));
  return line?.slice(label.length);
}

/**
 * `null` = no usable quote. The reply is a JSON string of HTML
 * (SGW_FIELDS.shippingQuote): Shipping and Handling are read by label from the
 * text form, as integer cents; Total is required and must equal their sum. A
 * missing or unparseable amount or a Total mismatch gives null, never a guess.
 * The address and carrier lines are never read. The object forms (T-24's old
 * guess) still work.
 */
export function normalizeShippingQuote(raw: unknown): { shipping: Cents; handling: Cents } | null {
  checkEnvelope(raw, 'shippingQuote', true);
  const q = parseSgw(ShippingQuoteResponseSchema, raw, 'shippingQuote');
  if (typeof q === 'string') {
    const lines = htmlToText(q).split('\n');
    const shipText = quoteLine(lines, SQ.shippingLabel);
    const handText = quoteLine(lines, SQ.handlingLabel);
    if (shipText === undefined || handText === undefined) return null;
    const shipping = quoteAmountCents(shipText);
    const handling = quoteAmountCents(handText);
    if (shipping === null || handling === null) return null;
    // The Total line is required: it is the cross-check on the two amounts.
    const totalText = quoteLine(lines, SQ.totalLabel);
    if (totalText === undefined) return null;
    const total = quoteAmountCents(totalText);
    if (total === null || total !== shipping + handling) return null;
    return { shipping, handling };
  }
  // TEMPORARY legacy object form (T-24's guess): remove once the fake server and
  // the api-adapter unit tests use the real HTML-string shape.
  // No shipping amount means no quote, even if a handling fee is present.
  if (q.shippingPrice == null) return null;
  return { shipping: dollarsToCents(q.shippingPrice), handling: dollarsToCents(q.handlingPrice ?? 0) };
}

export function normalizeShowBidModal(raw: unknown): { sellerId: number; minimumBid: Cents } {
  checkEnvelope(raw, 'showBidModal', true);
  const m = parseSgw(ShowBidModalResponseSchema, raw, 'showBidModal');
  return { sellerId: m.sellerId, minimumBid: dollarsToCents(m.minimumBid, 'showBidModal.minimumBid') };
}

/**
 * The raw half of a BidResult: SGW's own signals, with the message as text.
 * T-100 maps these to `BidResult.kind`.
 *
 * `statusFlag` is the boolean `status` (null if SGW sent a number, which goes to
 * `rawStatus`). `status: true` ALONE IS NEVER SUCCESS: SGW has answered
 * rejections with HTTP 200. The outcome is decided only by an explicit success
 * `result` code or a post-read of the item, never by `statusFlag`. `result` and
 * `isHighBidder` are read from `data` when the reply is enveloped.
 * `isUnauthorized` is reported, not thrown, so the caller can treat it as an
 * auth outcome of the bid.
 */
export function normalizePlaceBidRaw(raw: unknown): {
  statusFlag: boolean | null;
  rawStatus: number | null;
  rawResult: number | null;
  messageText: string;
  isHighBidder: boolean | null;
  isUnauthorized: boolean;
} {
  const p = parseSgw(PlaceBidResponseSchema, raw, 'placeBid');
  const inner: Record<string, unknown> =
    typeof p.data === 'object' && p.data !== null && !Array.isArray(p.data) ? (p.data as Record<string, unknown>) : {};
  return {
    statusFlag: typeof p.status === 'boolean' ? p.status : null,
    rawStatus: typeof p.status === 'number' ? p.status : null,
    rawResult: p.result ?? (typeof inner.result === 'number' && Number.isInteger(inner.result) ? inner.result : null),
    messageText: htmlToText(p.message ?? ''),
    isHighBidder: p.isHighBidder ?? (typeof inner.isHighBidder === 'boolean' ? inner.isHighBidder : null),
    isUnauthorized: p.isUnauthorized === true,
  };
}
