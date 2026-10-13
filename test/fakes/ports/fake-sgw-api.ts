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
} from '../../../src/domain/types';
import { SgwApiError, type SgwApiErrorKind } from '../../../src/ports/errors';
import type { GlobalSwitches } from '../../../src/ports/global-switches';
import type { SgwApi } from '../../../src/ports/sgw-api';
import type { FakeClock } from './fake-clock';

export type SgwApiMethod = keyof SgwApi;

type PlaceBidReq = Parameters<SgwApi['placeBid']>[0];

export interface FakeSgwApiOptions {
  clock: FakeClock;
  /** When given, write methods throw SgwApiError('paused') if writesAllowed is not ok, as the real adapter does. */
  switches?: GlobalSwitches;
}

/**
 * In-memory SgwApi. Seed the public fields (`listings`, `details`, `favoriteList`,
 * `savedSearchList`, `shipping`), script failures with `failNext`, and read
 * `calls` / `bids` afterwards. placeBid is idempotent per `idempotencyKey`: a
 * repeated key returns the first result and records no second bid.
 */
export class FakeSgwApi implements SgwApi {
  listings: Listing[] = [];
  details = new Map<ItemId, ItemDetail>();
  favoriteList: Favorite[] = [];
  savedSearchList: Array<{ id: number; name: string; query: SearchQuery }> = [];
  shipping = new Map<string, { shipping: Cents; handling: Cents } | null>();
  /** Added to the FakeClock for serverTimeSample(). */
  serverOffsetMs = 0;
  rttMs = 40;
  /** Result for placeBid; a function can decide per request. */
  bidResult: BidResult | ((req: PlaceBidReq) => BidResult) | undefined;
  readonly calls: Array<{ method: SgwApiMethod; args: unknown[] }> = [];
  /** Distinct bids that reached the "server" (one per idempotency key). */
  readonly bids: Array<{ req: PlaceBidReq; idempotencyKey: string }> = [];
  readonly notes = new Map<number, string>();
  private readonly clock: FakeClock;
  private readonly switches: GlobalSwitches | undefined;
  private readonly failures = new Map<SgwApiMethod, SgwApiError[]>();
  private readonly bidResultsByKey = new Map<string, BidResult>();

  constructor(opts: FakeSgwApiOptions) {
    this.clock = opts.clock;
    this.switches = opts.switches;
  }

  /** Makes the next call to `method` reject with SgwApiError(kind); stacks FIFO. */
  failNext(method: SgwApiMethod, kind: SgwApiErrorKind, opts?: { status?: number; retryAfterMs?: number }): void {
    const queue = this.failures.get(method) ?? [];
    queue.push(new SgwApiError(kind, undefined, opts));
    this.failures.set(method, queue);
  }

  search(q: SearchQuery, lane: Lane): Promise<{ items: Listing[]; total: number; page: number }> {
    return this.run('search', [q, lane], () => {
      const start = (q.page - 1) * 40;
      return { items: structuredClone(this.listings.slice(start, start + 40)), total: this.listings.length, page: q.page };
    });
  }

  itemDetail(itemId: ItemId, lane: Lane, opts?: { maxAgeMs?: number }): Promise<ItemDetail> {
    return this.run('itemDetail', [itemId, lane, opts], () => {
      const d = this.details.get(itemId);
      if (d === undefined) throw new SgwApiError('server', `FakeSgwApi: no detail seeded for ${String(itemId)}`, { status: 404 });
      return structuredClone(d);
    });
  }

  shippingQuote(itemId: ItemId, zip: string, lane: Lane): Promise<{ shipping: Cents; handling: Cents } | null> {
    return this.run('shippingQuote', [itemId, zip, lane], () => structuredClone(this.shipping.get(`${String(itemId)}:${zip}`) ?? null));
  }

  favorites(type: 'open' | 'close' | 'all', lane: Lane): Promise<Favorite[]> {
    return this.run('favorites', [type, lane], () =>
      structuredClone(this.favoriteList.filter((f) => type === 'all' || f.status === (type === 'open' ? 'open' : 'closed'))),
    );
  }

  addFavorite(itemId: ItemId): Promise<void> {
    return this.write('addFavorite', 'favorites', [itemId], () => {
      if (this.favoriteList.some((f) => f.itemId === itemId)) return;
      const d = this.details.get(itemId);
      this.favoriteList.push({
        itemId,
        watchlistId: 1000 + this.favoriteList.length,
        notes: '',
        endTime: d?.endTime ?? new Date(this.clock.now() + 3_600_000).toISOString(),
        sellerId: d?.sellerId ?? 0,
        status: 'open',
      });
    });
  }

  removeFavorite(itemId: ItemId): Promise<void> {
    return this.write('removeFavorite', 'favorites', [itemId], () => {
      this.favoriteList = this.favoriteList.filter((f) => f.itemId !== itemId);
    });
  }

  saveFavoriteNote(watchlistId: number, notes: string): Promise<void> {
    return this.write('saveFavoriteNote', 'favorites', [watchlistId, notes], () => {
      if (notes.length > 256) throw new SgwApiError('schema', 'note longer than 256 characters');
      this.notes.set(watchlistId, notes);
      const f = this.favoriteList.find((x) => x.watchlistId === watchlistId);
      if (f) f.notes = notes;
    });
  }

  savedSearches(lane: Lane): Promise<Array<{ id: number; name: string; query: SearchQuery }>> {
    return this.run('savedSearches', [lane], () => structuredClone(this.savedSearchList));
  }

  showBidModal(itemId: ItemId): Promise<{ sellerId: number; minimumBid: Cents }> {
    return this.run('showBidModal', [itemId], () => {
      const d = this.details.get(itemId);
      if (d === undefined) throw new SgwApiError('server', `FakeSgwApi: no detail seeded for ${String(itemId)}`, { status: 404 });
      return { sellerId: d.sellerId, minimumBid: d.minimumBid };
    });
  }

  placeBid(req: PlaceBidReq, opts: { idempotencyKey: string; timeoutMs: number }): Promise<BidResult> {
    return this.write('placeBid', 'bidding', [req, opts], () => {
      const prior = this.bidResultsByKey.get(opts.idempotencyKey);
      if (prior) return structuredClone(prior);
      const scripted = typeof this.bidResult === 'function' ? this.bidResult(req) : this.bidResult;
      const result: BidResult = scripted ?? {
        kind: 'accepted',
        rawStatus: 200,
        rawResult: 1,
        messageText: 'Your bid was placed.',
        isHighBidder: true,
        observedAt: this.clock.now(),
      };
      this.bids.push({ req: structuredClone(req), idempotencyKey: opts.idempotencyKey });
      this.bidResultsByKey.set(opts.idempotencyKey, result);
      return structuredClone(result);
    });
  }

  serverTimeSample(): Promise<ClockSample> {
    return this.run('serverTimeSample', [], () => {
      const receivedAt = this.clock.now();
      return {
        serverMs: receivedAt + this.serverOffsetMs,
        sentAt: receivedAt - this.rttMs,
        receivedAt,
        rttMs: this.rttMs,
        source: 'getCurrentTime' as const,
      };
    });
  }

  private async write<T>(method: SgwApiMethod, feature: 'favorites' | 'bidding', args: unknown[], body: () => T): Promise<T> {
    if (this.switches) {
      const verdict = await this.switches.writesAllowed(feature);
      if (!verdict.ok) {
        this.calls.push({ method, args: structuredClone(args) });
        throw new SgwApiError('paused', verdict.why);
      }
    }
    return this.run(method, args, body);
  }

  private run<T>(method: SgwApiMethod, args: unknown[], body: () => T): Promise<T> {
    this.calls.push({ method, args: structuredClone(args) });
    const injected = this.failures.get(method)?.shift();
    if (injected !== undefined) return Promise.reject(injected);
    try {
      return Promise.resolve(body());
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }
}
