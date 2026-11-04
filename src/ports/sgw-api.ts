// Contract v1 (T-02): PLAN §3.3 SgwApi port. Implemented by T-26
// (src/adapters/sgw/api-adapter.ts) over the RequestScheduler; `placeBid` by
// T-100 (src/adapters/sgw/bid.ts). Failures throw SgwApiError (./errors.ts).
//
// Write methods throw SgwApiError{kind:'paused'} when the kill switch, the
// feature's dryRun, or a failed healthCheck() is in effect. The adapter, not
// the caller, enforces this.
import type {
  BidResult,
  Cents,
  ClockSample,
  Favorite,
  ItemDetail,
  ItemId,
  Lane,
  Listing,
  SearchQuery,
} from '../domain/types';

export interface SgwApi {
  search(q: SearchQuery, lane: Lane): Promise<{ items: Listing[]; total: number; page: number }>;
  itemDetail(itemId: ItemId, lane: Lane, opts?: { maxAgeMs?: number }): Promise<ItemDetail>;
  /** Shape per S-1. */
  shippingQuote(itemId: ItemId, zip: string, lane: Lane): Promise<{ shipping: Cents; handling: Cents } | null>;
  /** Auth. */
  favorites(type: 'open' | 'close' | 'all', lane: Lane): Promise<Favorite[]>;
  /** Auth, write. */
  addFavorite(itemId: ItemId): Promise<void>;
  /** Auth, write. */
  removeFavorite(itemId: ItemId): Promise<void>;
  /** Auth, write; ≤ 256 chars enforced. */
  saveFavoriteNote(watchlistId: number, notes: string): Promise<void>;
  /** Auth. */
  savedSearches(lane: Lane): Promise<Array<{ id: number; name: string; query: SearchQuery }>>;
  /** Auth, read. */
  showBidModal(itemId: ItemId): Promise<{ sellerId: number; minimumBid: Cents }>;
  /** Auth, WRITE, money. */
  placeBid(
    req: { itemId: ItemId; sellerId: number; bidAmount: Cents; quantity: 1 },
    opts: { idempotencyKey: string; timeoutMs: number },
  ): Promise<BidResult>;
  /** Prefers the ItemDetail serverTime of a known item. */
  serverTimeSample(): Promise<ClockSample>;
}

/** SGW search URL → SearchQuery (unknown params kept in `extra`). Implemented by T-50 (src/adapters/sgw/query-url.ts, I-26). */
export type SearchQueryFromUrl = (url: string) => SearchQuery | null;
/** SearchQuery → SGW search URL. Implemented by T-50. */
export type SearchQueryToUrl = (q: SearchQuery) => string;
