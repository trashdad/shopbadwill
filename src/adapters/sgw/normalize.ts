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
import { parsePacific } from '../../domain/time/pacific';
import type { Cents, EpochMs, Favorite, ItemDetail, ItemId, Listing, SearchQuery } from '../../domain/types';
import { SgwApiError } from '../../ports/errors';
import {
  CurrentTimeResponseSchema,
  FavoritesResponseSchema,
  ItemDetailResponseSchema,
  PlaceBidResponseSchema,
  SavedSearchesResponseSchema,
  SearchResponseSchema,
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
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * HTML -> plain text, for SGW's `message` fields. Block tags become line
 * breaks, other tags vanish, entities are decoded, whitespace is collapsed.
 * Tags are removed before entities are decoded, so `&lt;b&gt;` stays the
 * literal text "<b>". The result is for text rendering only, never innerHTML.
 */
export function htmlToText(html: string): string {
  const noBlocks = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\b[^>]*>|<\/(p|div|li|tr|h[1-6]|ul|ol|table)\s*>/gi, '\n');
  const text = decodeEntities(noBlocks.replace(/<[^>]*>/g, ''));
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

// ── Search ──────────────────────────────────────────────────────────────────

/**
 * Search rows carry no seller name, state or pickup flag: `sellerState` stays
 * unset and `pickupOnly` is false until ItemDetail / GetSellerInfo says
 * otherwise. `shippingPrice` 0 means "calculated" (the site shows 0 for nearly
 * every row), so it maps to null; 0.01 is a real one-cent price.
 */
export function normalizeSearchRow(row: unknown, ctx: NormalizeContext, label = 'search.row'): Listing {
  const r = parseSgw(SearchResponseSchema.shape.searchResults.shape.items.element, row, label);
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
    pickupOnly: false,
    source: 'api',
    observedAt: ctx.observedAt,
  };
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

/** `page` is the request's page (the response does not echo it). */
export function normalizeSearch(raw: unknown, page: number, ctx: NormalizeContext): NormalizedSearch {
  const r = parseSgw(SearchResponseSchema, raw, 'search');
  if (r.categoryListModel === null) {
    // A 200 with a null categoryListModel marks a server-side error, not an empty result.
    throw new SgwApiError('server', 'search: categoryListModel is null (server-side error)');
  }
  return {
    items: r.searchResults.items.map((row, i) => normalizeSearchRow(row, ctx, `search.searchResults.items[${String(i)}]`)),
    total: r.searchResults.itemCount,
    page,
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
 * `bidHistory` is the per-bid log (`bidHistory.bidComplete`), retracted bids
 * dropped, newest first. `minimumBid` is the NEXT acceptable bid.
 * `pickupState` (the seller's state) becomes `sellerState`, the field the
 * rules engine's `location` condition reads. `shippingPrice` 0 with
 * `allowShippingCalculation` is "calculated" -> null.
 */
export function normalizeItemDetail(raw: unknown, ctx: NormalizeContext): ItemDetail {
  const d = parseSgw(ItemDetailResponseSchema, raw, 'itemDetail');
  const endMs = pacificToMs(d.endTime, 'itemDetail.endTime');
  const serverMs = pacificToMs(d.serverTime, 'itemDetail.serverTime');

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
    startingMinimumBid: dollarsToCents(d.startingPrice ?? d.currentPrice, 'itemDetail.startingPrice'),
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
  if (d.buyNowPrice !== undefined) detail.buyNowPrice = d.buyNowPrice === null || d.buyNowPrice === 0 ? null : dollarsToCents(d.buyNowPrice);
  const image = imageUrlOf(d.imageServer, d.imageUrlString);
  if (image !== undefined) detail.imageUrl = image;
  return detail;
}

// ── Clock ───────────────────────────────────────────────────────────────────

/** "10/07/2026 20:09:15" (Pacific) -> epoch ms. 1 s resolution. */
export function normalizeCurrentTime(raw: unknown): EpochMs {
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

/** `nowMs` decides open/closed per row: the response carries no status. */
export function normalizeFavorites(raw: unknown, nowMs: EpochMs): Favorite[] {
  const r = parseSgw(FavoritesResponseSchema, raw, 'favorites');
  return r.data.map((f, i) => {
    const endMs = pacificToMs(f.endTime, `favorites.data[${String(i)}].endTime`);
    return {
      itemId: f.itemId,
      watchlistId: f.watchlistId,
      notes: f.notes ?? '',
      endTime: iso(endMs),
      sellerId: f.sellerId,
      status: endMs <= nowMs ? 'closed' : 'open',
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

export function normalizeSavedSearches(raw: unknown): Array<{ id: number; name: string; query: SearchQuery }> {
  const r = parseSgw(SavedSearchesResponseSchema, raw, 'savedSearches');
  return r.data.map((s) => {
    const query: SearchQuery = {
      searchText: s.searchText ?? '',
      categoryIds: idList(s.selectedCategoryIds),
      sellerIds: idList(s.selectedSellerIds),
      page: 1,
    };
    const lo = priceCents(s.lowPrice);
    const hi = priceCents(s.highPrice);
    if (lo !== undefined) query.lowPrice = lo;
    if (hi !== undefined) query.highPrice = hi;
    return { id: s.saveSearchId, name: s.searchName, query };
  });
}

/** `null` when SGW returned no quote (neither amount present). */
export function normalizeShippingQuote(raw: unknown): { shipping: Cents; handling: Cents } | null {
  const q = parseSgw(ShippingQuoteResponseSchema, raw, 'shippingQuote');
  if (q.shippingPrice == null && q.handlingPrice == null) return null;
  return { shipping: dollarsToCents(q.shippingPrice ?? 0), handling: dollarsToCents(q.handlingPrice ?? 0) };
}

export function normalizeShowBidModal(raw: unknown): { sellerId: number; minimumBid: Cents } {
  const m = parseSgw(ShowBidModalResponseSchema, raw, 'showBidModal');
  return { sellerId: m.sellerId, minimumBid: dollarsToCents(m.minimumBid, 'showBidModal.minimumBid') };
}

/**
 * The raw half of a BidResult: SGW's codes and the message as text. T-100 maps
 * these to `BidResult.kind`. `rawStatus` is null unless SGW sent a number.
 */
export function normalizePlaceBidRaw(raw: unknown): {
  rawStatus: number | null;
  rawResult: number | null;
  messageText: string;
  isHighBidder: boolean | null;
} {
  const p = parseSgw(PlaceBidResponseSchema, raw, 'placeBid');
  return {
    rawStatus: typeof p.status === 'number' ? p.status : null,
    rawResult: p.result ?? null,
    messageText: htmlToText(p.message ?? ''),
    isHighBidder: p.isHighBidder ?? null,
  };
}

export type { ItemId };
