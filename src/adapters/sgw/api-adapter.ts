// T-26: the ApiAdapter, PLAN §3.3 `SgwApi` over T-25's RequestScheduler.
//
// The single gateway for every request the extension makes to SGW's buyer
// API (PLAN §1.7). It builds each request from config.ts, hands it to the
// scheduler (lanes, budgets, spacing, backoff) and maps the reply through
// T-24's normalizers. Rules it enforces, for courtesy and safety:
//
// - Everything goes through `RequestScheduler.run`; the adapter has no Http.
// - `credentials: 'omit'` on every request, read or write: never a cookie (the
//   site's `Bid` cookie 403s a second bid, §1.7). The bearer goes to:
//   - endpoints config.ts marks `auth: 'required'`, and only while SgwSession
//     holds an unexpired token. Without one the call fails with `auth` and
//     nothing is sent;
//   - `auth: 'optional'` ones (itemDetail) on the snipe lane only, when a
//     usable token exists (ruling C6). Without one they stay anonymous.
//   Every other request is anonymous, even when a token exists.
// - Inputs are checked before anything is sent. Search filters per S-1:
//   SGW answers 400 to a non-numeric price, and silently ignores a meaningless
//   category filter, returning unfiltered rows. Double quotes in `searchText`
//   get a 403, so they are stripped. Booleans go as "true"/"false" strings.
//   Invalid input is SgwApiError('schema') with "invalid-query"/"invalid-input"
//   in the message: the frozen error kinds have no closer match, and it is
//   never reported to health.
// - Every write asks `GlobalSwitches.writesAllowed(feature)` first (ruling C1).
//   That is false for the kill switch, dry-run, a failed health check and a
//   bad session. A refusal sends nothing, records an audit intent (item,
//   action, why) and rejects with SgwApiError('paused', why). Callers ask
//   writesAllowed themselves first; this check is defense in depth. It is
//   asked again right before the send: a write that waited in its lane's
//   queue is re-checked before it goes (see WRITE_GATE_MAX_AGE_MS).
// - A reply that fails its schema throws SgwApiError('schema') and is
//   reported to health (`flagSchemaFailure`), so writes can fail closed.
import type { AuditLog } from '../../domain/audit/types';
import { formatCents } from '../../domain/money';
import { formatPacificNaive, parsePacific } from '../../domain/time/pacific';
import type {
  BidResult,
  Cents,
  ClockSample,
  EpochMs,
  Favorite,
  ItemDetail,
  ItemId,
  Lane,
  Listing,
  SearchQuery,
} from '../../domain/types';
import type { Clock } from '../../ports/clock';
import { SgwApiError, type SgwApiErrorKind } from '../../ports/errors';
import type { GlobalSwitches } from '../../ports/global-switches';
import type { HttpRequest, HttpResponse } from '../../ports/http';
import type { RequestScheduler, ScheduledRequest } from '../../ports/request-scheduler';
import type { SgwApi } from '../../ports/sgw-api';
import type { SgwSession } from '../../ports/sgw-session';
import { placeBid as placeBidPath } from './bid';
import type { SgwClockAdapter } from './clock-adapter';
import {
  SGW_API_BASE,
  SGW_ENDPOINTS,
  SGW_SEARCH_BODY_DEFAULTS,
  SGW_SEARCH_URL_PARAMS,
  SGW_SHIPPING_QUOTE_BODY_FIELDS,
  type SgwEndpoint,
  type SgwEndpointKey,
} from './config';
import {
  htmlToText,
  normalizeCurrentTime,
  normalizeFavorites,
  normalizeItemDetail,
  normalizeSavedSearches,
  normalizeSearch,
  normalizeShippingQuote,
  normalizeShowBidModal,
  type SearchNormalizeContext,
} from './normalize';
import { invalidSearchParams } from './query-url';
import { parseEndpoint } from './schemas';

// ── Policy ──────────────────────────────────────────────────────────────────

/** Every request's timeout: under the 30 s after which Chrome kills a worker's fetch (§1.3). */
export const REQUEST_TIMEOUT_MS = 20_000;

/**
 * ItemDetail cache policy (controller ruling R6). Neither the contract nor
 * Settings defines a TTL for this read, so:
 * - the key is the item id; only an OPEN auction is kept (a closed read is
 *   never cached), for DETAIL_CACHE_TTL_MS from when it was received;
 * - `opts.maxAgeMs` can shorten that (0 forces a read) but never lengthen it;
 * - from DETAIL_NO_CACHE_BEFORE_END_MS before the end onward, nothing is
 *   served from or stored in the cache: every call reads SGW. So a cached
 *   detail never crosses the item's end time, and the snipe window always
 *   sees live data;
 * - a stored time in the future (the clock moved back) counts as stale;
 * - snipe-lane reads (ruling C6) bypass the cache entirely: they never read
 *   from it and never write to it. They may carry the bearer, so an
 *   authenticated detail (isHighBidder, inWatchlist) never reaches another
 *   lane, and a snipe always sees live data.
 * The end time is SGW's clock and `now` is the local one; the 5-minute margin
 * also absorbs a local clock running up to 5 minutes slow.
 */
export const DETAIL_CACHE_TTL_MS = 60_000;
export const DETAIL_NO_CACHE_BEFORE_END_MS = 5 * 60_000;
/** Bound on the in-memory detail cache; the oldest entry goes first. */
export const DETAIL_CACHE_MAX_ENTRIES = 500;

/**
 * The guarded send (`guardedRun`, every write; bids via `BidContext.sendWrite`).
 * The writesAllowed verdict a write goes out under is never older than
 * WRITE_GATE_MAX_AGE_MS (monotonic clock). The frozen ScheduledRequest.build()
 * is synchronous, so the async `writesAllowed` cannot run inside it; instead:
 * - `writesAllowed` is asked when the write is requested. While the write
 *   waits in its lane's queue, it is asked again every
 *   WRITE_GATE_MAX_AGE_MS / 2 on a clock timer. That is a local call: no
 *   network. The timer is cleared when the write settles.
 * - build() checks the latest verdict right before the send:
 *   - `ok:false` refuses the write: it is audited with `why`, nothing is sent,
 *     and it rejects `paused(why)`;
 *   - a verdict older than WRITE_GATE_MAX_AGE_MS (only if the refreshes fell
 *     behind) also refuses it, without sending, budget or gap. The adapter
 *     then asks again, re-prepares the request (fresh bearer and expiry), and
 *     re-queues it.
 * - After WRITE_GATE_MAX_ATTEMPTS stale turns it gives up. It audits
 *   `write.blocked` with reason `lane-busy` and rejects `paused`, with
 *   `retryAfterMs` taken from the lane's `nextAllowedAt`. It is never silent.
 */
export const WRITE_GATE_MAX_AGE_MS = 1000;
export const WRITE_GATE_MAX_ATTEMPTS = 3;

/** SgwApi.saveFavoriteNote: "≤ 256 chars enforced" (§3.3), counted in UTF-16 units like .NET. */
export const FAVORITE_NOTE_MAX_CHARS = 256;

/**
 * Lanes for the methods whose port signature takes none (R5):
 * - Favorite writes: `background`. The daily job is where they come from (§9),
 *   and that keeps an unattended run at one request per 120 s.
 * - ShowBidModal: `snipe`. It is read at fire time, just before PlaceBid (§9).
 * - Clock samples: `interactive` at a high priority, so they are not stuck
 *   behind queued badge reads. RTT is timed around the HTTP call itself, not
 *   the queue.
 */
export const WRITE_LANE: Lane = 'background';
export const BID_MODAL_LANE: Lane = 'snipe';
export const CLOCK_LANE: Lane = 'interactive';
export const CLOCK_PRIORITY = 10;

/**
 * CalculateShipping `country` for a US ZIP. ASSUMPTION (evidence=bundle): the
 * site sends its country select's value. The reply shape is also provisional
 * (USER STEP S-1, step 8).
 */
export const SHIPPING_COUNTRY = 'US';

// ── Dependencies ────────────────────────────────────────────────────────────

/** A reply that failed its schema. */
export interface SchemaFailure {
  endpoint: SgwEndpointKey;
  message: string;
  at: EpochMs;
}

/**
 * Where schema failures are flagged (ruling C2). The SgwHealth port has no
 * "flag" call, so this is injected. T-36 wires it so that a schema failure
 * makes `GlobalSwitches.writesAllowed` fail closed. In practice that means
 * persisting a failing health marker or HealthReport, which T-30 owns.
 * It must not throw. If it does, the schema error still surfaces.
 */
export interface SgwHealthFlag {
  flagSchemaFailure(f: SchemaFailure): void;
}

export interface ApiAdapterDeps {
  scheduler: RequestScheduler;
  clock: Clock;
  /**
   * Bearer source (T-28). `reportRejected` is called once when a request that
   * carried the bearer comes back unauthorized (T-28 contract change). It is
   * required: a forgotten wiring would silently skip the expired marking.
   */
  session: Pick<SgwSession, 'current' | 'reportRejected'>;
  /** The frozen port, asked before every write (ruling C1). */
  switches: GlobalSwitches;
  /** Records refused-write intents (T-35/T-41). */
  audit: Pick<AuditLog, 'append'>;
  health: SgwHealthFlag;
  /** T-29's sample builders. */
  sgwClock: Pick<SgwClockAdapter, 'sampleFromServerTime' | 'sampleFromGetCurrentTime'>;
}

/** How a request differs from its config.ts endpoint entry. */
export interface SgwRequestInit {
  /** Values for `{name}` placeholders in the path. */
  path?: Readonly<Record<string, string | number>>;
  /** Query values; only the names config.ts lists for the endpoint are sent, in its order. */
  query?: Readonly<Record<string, string | number>>;
  /** JSON body for `body: 'json'` endpoints (default `{}`); `body: 'none'` endpoints send none. */
  body?: unknown;
  timeoutMs?: number;
  /** The lane the request runs on. An `auth: 'optional'` endpoint carries the bearer only on `snipe` (ruling C6). */
  lane?: Lane;
}

/**
 * What the PlaceBid path (bid.ts, T-100) gets from the adapter. It has no
 * scheduler: the only way to send the bid is `sendWrite`, so the write gate
 * cannot be bypassed.
 */
export interface BidContext {
  readonly clock: Clock;
  /** The adapter's own ShowBidModal read (snipe lane, bearer), made just before the bid. */
  showBidModal(itemId: ItemId): Promise<{ sellerId: number; minimumBid: Cents }>;
  /**
   * Builds a request the way every adapter request is built (`credentials:
   * 'omit'`, the bearer only for auth endpoints). Rejects with
   * SgwApiError('auth'), sending nothing, without a usable session.
   */
  prepare(endpoint: SgwEndpointKey, init?: SgwRequestInit): Promise<HttpRequest>;
  /**
   * THE way to send the bid (T-100): the adapter's guarded send with feature
   * `'bidding'`, audit kind `bid.place` and lane `'snipe'`. It asks
   * writesAllowed when called, keeps the verdict fresh while the bid is
   * queued, re-checks it right before the send, and re-prepares the request
   * on a retry (see WRITE_GATE_MAX_AGE_MS). A refusal is audited, sends
   * nothing and rejects `paused`. Schema failures are flagged to health.
   */
  sendWrite<T>(endpoint: SgwEndpointKey, init: SgwRequestInit, parse: (res: HttpResponse, raw: unknown) => T): Promise<T>;
  /** Reports a reply that failed its schema (sendWrite already does this for its own replies). */
  flagSchemaFailure(endpoint: SgwEndpointKey, error: SgwApiError): void;
}

// ── Adapter ─────────────────────────────────────────────────────────────────

type WriteFeature = 'favorites' | 'bidding';
type WriteKind = 'favorite.add' | 'favorite.remove' | 'favorite.note' | 'bid.place';
const WRITE_ACTION: Record<WriteKind, string> = {
  'favorite.add': 'add',
  'favorite.remove': 'remove',
  'favorite.note': 'note',
  'bid.place': 'bid',
};
type AckEndpoint = 'addFavorite' | 'removeFavorite' | 'saveFavoriteNote';

/** The object of a write, as audited: the item, or a ref for a note. */
interface WriteTarget {
  itemId?: ItemId;
  ref?: string;
}

interface CachedDetail {
  detail: ItemDetail;
  storedAt: EpochMs;
  endMs: EpochMs;
}

interface DetailRead {
  detail: ItemDetail;
  /** The real times around the HTTP call (Http's startedAt/endedAt). */
  sentAt: EpochMs;
  receivedAt: EpochMs;
}

interface RunOptions {
  priority?: number;
  /** Runs inside build(), right before the request leaves; may throw to stop it (nothing is sent). */
  beforeSend?: () => void;
}

/** A writesAllowed answer and when it was asked (monotonic clock). */
type Verdict = { ok: true; at: number } | { ok: false; why: string; at: number };

/** build() refused a write whose latest verdict is stale (the refreshes fell behind). Never escapes the adapter. */
class StaleWriteGate extends Error {
  override readonly name = 'StaleWriteGate';
}

/** build() refused a write whose latest verdict is ok:false. Never escapes the adapter. */
class RefusedWrite extends Error {
  override readonly name = 'RefusedWrite';
  constructor(readonly why: string) {
    super(why);
  }
}

const US_ZIP = /^\d{5}(-\d{4})?$/;

export class SgwApiAdapter implements SgwApi {
  private readonly details = new Map<ItemId, CachedDetail>();
  /** M1: in-flight non-snipe itemDetail reads, keyed `${lane}:${itemId}`, so concurrent misses share one request. */
  private readonly detailReads = new Map<string, Promise<DetailRead>>();
  /** The last item read while open: serverTimeSample prefers its ItemDetail serverTime. */
  private clockItem: { itemId: ItemId; endMs: EpochMs } | undefined;

  constructor(private readonly deps: ApiAdapterDeps) {}

  // ── Reads ─────────────────────────────────────────────────────────────

  async search(q: SearchQuery, lane: Lane): Promise<{ items: Listing[]; total: number; page: number }> {
    const body = searchBody(q, this.deps.clock.now());
    const query: SearchNormalizeContext['query'] = { page: q.page };
    if (q.pickupOnly !== undefined) query.pickupOnly = q.pickupOnly;
    if (q.excludePickupOnly !== undefined) query.excludePickupOnly = q.excludePickupOnly;
    const request = await this.prepare('search', { body });
    return this.run('search', lane, request, (res, raw) =>
      normalizeSearch(raw, { observedAt: res.endedAt, authenticated: false, query }),
    );
  }

  /**
   * `auth: 'optional'` (ruling C6). On the snipe lane the read carries the
   * bearer when a usable token exists, so `isHighBidder` and `inWatchlist` are
   * real, and it bypasses the cache both ways. On every other lane it is
   * anonymous (those two fields come back null) and cached per
   * DETAIL_CACHE_TTL_MS.
   *
   * M1: concurrent misses on the same (lane, item) share one in-flight read.
   * Each caller gets its own copy, and a failure rejects every one of them.
   * The key includes the lane, so a read queued on the background lane never
   * makes an interactive caller wait. Snipe reads are never shared.
   */
  async itemDetail(itemId: ItemId, lane: Lane, opts?: { maxAgeMs?: number }): Promise<ItemDetail> {
    assertItemId('itemDetail', itemId);
    if (lane === 'snipe') return structuredClone((await this.readDetail(itemId, lane)).detail);
    const cached = this.fromCache(itemId, opts?.maxAgeMs);
    if (cached !== undefined) return cached;
    const key = `${lane}:${String(itemId)}`;
    let shared = this.detailReads.get(key);
    if (shared === undefined) {
      const read = this.readDetail(itemId, lane);
      const drop = (): void => {
        if (this.detailReads.get(key) === read) this.detailReads.delete(key);
      };
      read.then(drop, drop);
      this.detailReads.set(key, read);
      shared = read;
    }
    return structuredClone((await shared).detail);
  }

  async shippingQuote(itemId: ItemId, zip: string, lane: Lane): Promise<{ shipping: Cents; handling: Cents } | null> {
    assertItemId('shippingQuote', itemId);
    const zipCode = zip.trim();
    if (!US_ZIP.test(zipCode)) throw invalidInput('shippingQuote', 'zip must be a US ZIP code (12345 or 12345-6789)');
    const values: Record<(typeof SGW_SHIPPING_QUOTE_BODY_FIELDS)[number], string | number> = {
      itemId,
      country: SHIPPING_COUNTRY,
      province: '',
      zipCode,
      quantity: 1,
      clientIP: '',
    };
    const body = Object.fromEntries(SGW_SHIPPING_QUOTE_BODY_FIELDS.map((k) => [k, values[k]]));
    const request = await this.prepare('shippingQuote', { body });
    return this.run('shippingQuote', lane, request, (_res, raw) => normalizeShippingQuote(raw));
  }

  async favorites(type: 'open' | 'close' | 'all', lane: Lane): Promise<Favorite[]> {
    const request = await this.prepare('favorites', { query: { Type: type }, body: {} });
    return this.run('favorites', lane, request, (res, raw) => normalizeFavorites(raw, res.endedAt));
  }

  async savedSearches(lane: Lane): Promise<Array<{ id: number; name: string; query: SearchQuery }>> {
    const request = await this.prepare('savedSearches');
    return this.run('savedSearches', lane, request, (_res, raw) => normalizeSavedSearches(raw));
  }

  async showBidModal(itemId: ItemId): Promise<{ sellerId: number; minimumBid: Cents }> {
    assertItemId('showBidModal', itemId);
    const request = await this.prepare('showBidModal', { query: { itemId } });
    return this.run('showBidModal', BID_MODAL_LANE, request, (_res, raw) => normalizeShowBidModal(raw));
  }

  /**
   * One fresh read, never the cache: the ItemDetail of the last item read
   * while open (ms precision, S-1), else Dashboard/GetCurrentTime (1 s).
   * `sentAt`/`receivedAt` are the Http port's own times around the call.
   * When T-29's helper refuses the sample (an ambiguous fall-back-hour time,
   * or a clock that moved backwards), this rejects with `server`: the frozen
   * port returns a ClockSample, so there is no null to pass through.
   */
  async serverTimeSample(): Promise<ClockSample> {
    const known = this.clockItem;
    let sample: ClockSample | null;
    if (known !== undefined && known.endMs > this.deps.clock.now()) {
      const read = await this.readDetail(known.itemId, CLOCK_LANE, CLOCK_PRIORITY);
      sample = this.deps.sgwClock.sampleFromServerTime(read.detail.serverTimeRaw, read.sentAt, read.receivedAt);
    } else {
      this.clockItem = undefined;
      const request = await this.prepare('currentTime');
      const read = await this.run(
        'currentTime',
        CLOCK_LANE,
        request,
        (res, raw) => {
          normalizeCurrentTime(raw); // validates the envelope and the "MM/dd/yyyy HH:mm:ss" data
          return { data: (raw as { data: string }).data, sentAt: res.startedAt, receivedAt: res.endedAt };
        },
        { priority: CLOCK_PRIORITY },
      );
      sample = this.deps.sgwClock.sampleFromGetCurrentTime(read.data, read.sentAt, read.receivedAt);
    }
    if (sample === null) {
      throw new SgwApiError(
        'server',
        'serverTimeSample: no usable clock sample (ambiguous server time, or the local clock moved backwards)',
      );
    }
    return sample;
  }

  // ── Writes (gated) ────────────────────────────────────────────────────

  async addFavorite(itemId: ItemId): Promise<void> {
    assertItemId('addFavorite', itemId);
    await this.guardedRun('favorites', 'favorite.add', { itemId }, 'addFavorite', WRITE_LANE, { query: { itemId } }, ackOf('addFavorite'));
  }

  async removeFavorite(itemId: ItemId): Promise<void> {
    assertItemId('removeFavorite', itemId);
    await this.guardedRun('favorites', 'favorite.remove', { itemId }, 'removeFavorite', WRITE_LANE, { query: { itemId } }, ackOf('removeFavorite'));
  }

  /** The note text is sent to SGW but never written to the audit log. */
  async saveFavoriteNote(watchlistId: number, notes: string): Promise<void> {
    if (!isPositiveInt(watchlistId)) throw invalidInput('saveFavoriteNote', 'watchlistId must be a positive integer');
    if (notes.length > FAVORITE_NOTE_MAX_CHARS) {
      throw invalidInput('saveFavoriteNote', `notes are limited to ${String(FAVORITE_NOTE_MAX_CHARS)} characters (got ${String(notes.length)})`);
    }
    await this.guardedRun(
      'favorites',
      'favorite.note',
      { ref: `watchlist:${String(watchlistId)}` },
      'saveFavoriteNote',
      WRITE_LANE,
      { body: { notes, watchlistId } },
      ackOf('saveFavoriteNote'),
    );
  }

  /**
   * Asks writesAllowed('bidding') here, then hands bid.ts a BidContext whose
   * `sendWrite` is the guarded send for this bid. bid.ts (T-100) reads
   * ShowBidModal, then sends PlaceBid through `sendWrite`.
   */
  async placeBid(
    req: { itemId: ItemId; sellerId: number; bidAmount: Cents; quantity: 1 },
    opts: { idempotencyKey: string; timeoutMs: number },
  ): Promise<BidResult> {
    assertItemId('placeBid', req.itemId);
    const target = { itemId: req.itemId };
    const verdict = await this.ask('bidding');
    if (!verdict.ok) throw await this.refuse('bid.place', target, verdict.why);
    const ctx: BidContext = {
      clock: this.deps.clock,
      showBidModal: (itemId) => this.showBidModal(itemId),
      prepare: (endpoint, init) => this.prepare(endpoint, init),
      sendWrite: (endpoint, init, parse) => this.guardedRun('bidding', 'bid.place', target, endpoint, 'snipe', init, parse),
      flagSchemaFailure: (endpoint, error) => {
        this.flagSchemaFailure(endpoint, error);
      },
    };
    return placeBidPath(ctx, req, opts);
  }

  /**
   * The guarded send used by every write (I1, I2, M2; see WRITE_GATE_MAX_AGE_MS):
   * - writesAllowed is asked when the write is requested;
   * - while the write is queued, it is asked again every
   *   WRITE_GATE_MAX_AGE_MS / 2 on a clock timer, cleared when the write
   *   settles;
   * - build() refuses on the latest verdict (`ok:false`), or, only if the
   *   refreshes fell behind, on a stale verdict. In the stale case it asks
   *   again, re-prepares (bearer and expiry) and re-queues;
   * - after WRITE_GATE_MAX_ATTEMPTS stale turns it gives up, audited as
   *   `lane-busy`.
   */
  private async guardedRun<T>(
    feature: WriteFeature,
    kind: WriteKind,
    target: WriteTarget,
    endpoint: SgwEndpointKey,
    lane: Lane,
    init: SgwRequestInit,
    parse: (res: HttpResponse, raw: unknown) => T,
  ): Promise<T> {
    const { clock } = this.deps;
    let verdict = await this.ask(feature); // when the write is requested
    if (!verdict.ok) throw await this.refuse(kind, target, verdict.why);
    /** Keeps the newest-asked answer (answers can land out of order); returns the latest verdict. */
    const adopt = (v: Verdict): Verdict => {
      if (v.at >= verdict.at) verdict = v;
      return verdict;
    };
    let settled = false;
    let timer: number | undefined;
    const keepFresh = (): void => {
      timer = clock.setTimeout(() => {
        timer = undefined;
        if (settled) return;
        this.ask(feature).then(adopt, () => undefined); // a failed ask just leaves the verdict to go stale
        keepFresh();
      }, WRITE_GATE_MAX_AGE_MS / 2);
    };
    keepFresh();
    try {
      for (let attempt = 1; ; attempt += 1) {
        const request = await this.prepare(endpoint, { ...init, lane }); // M2: bearer and expiry on every attempt
        try {
          return await this.run(endpoint, lane, request, parse, {
            beforeSend: () => {
              if (!verdict.ok) throw new RefusedWrite(verdict.why);
              if (clock.monotonic() - verdict.at > WRITE_GATE_MAX_AGE_MS) throw new StaleWriteGate();
            },
          });
        } catch (e) {
          if (e instanceof RefusedWrite) throw await this.refuse(kind, target, e.why);
          if (!(e instanceof StaleWriteGate)) throw e;
          if (attempt >= WRITE_GATE_MAX_ATTEMPTS) throw await this.laneBusy(kind, target, lane);
        }
        const latest = adopt(await this.ask(feature)); // the refreshes fell behind: ask now, before re-queueing
        if (!latest.ok) throw await this.refuse(kind, target, latest.why);
      }
    } finally {
      settled = true;
      if (timer !== undefined) clock.clearTimeout(timer);
    }
  }

  /**
   * One writesAllowed answer (ruling C1: the frozen port only; false for the
   * kill switch, dry-run, a failed health check and a bad session), stamped
   * with when it was asked.
   */
  private async ask(feature: WriteFeature): Promise<Verdict> {
    const at = this.deps.clock.monotonic();
    const v = await this.deps.switches.writesAllowed(feature);
    return v.ok ? { ok: true, at } : { ok: false, why: v.why ?? 'writes are not allowed', at };
  }

  /**
   * A refused write: an audit intent (item or ref, action, why: never the
   * note text) and SgwApiError('paused', why). Nothing was sent.
   */
  private async refuse(kind: WriteKind, target: WriteTarget, why: string): Promise<SgwApiError> {
    await this.audit({ actor: 'system', kind, ...target, details: { action: WRITE_ACTION[kind], why } });
    return new SgwApiError('paused', why);
  }

  /** The give-up: `write.blocked` / `lane-busy` audited, `paused` with retryAfterMs from the lane's nextAllowedAt. */
  private async laneBusy(kind: WriteKind, target: WriteTarget, lane: Lane): Promise<SgwApiError> {
    await this.audit({ actor: 'system', kind: 'write.blocked', ...target, details: { action: kind, reason: 'lane-busy' } });
    const retryAfterMs = Math.max(0, this.deps.scheduler.stats().lanes[lane].nextAllowedAt - this.deps.clock.now());
    return new SgwApiError(
      'paused',
      `${kind}: its verdict went stale ${String(WRITE_GATE_MAX_ATTEMPTS)} times while the ${lane} lane was busy; nothing was sent`,
      { retryAfterMs },
    );
  }

  private async audit(entry: Parameters<AuditLog['append']>[0]): Promise<void> {
    try {
      await this.deps.audit.append(entry);
    } catch {
      // The refusal stands even if the log cannot be written.
    }
  }

  // ── ItemDetail cache (R6, see DETAIL_CACHE_TTL_MS) ────────────────────

  /** A live read. Snipe-lane reads (maybe authenticated) are never stored in the cache. */
  private async readDetail(itemId: ItemId, lane: Lane, priority?: number): Promise<DetailRead> {
    const request = await this.prepare('itemDetail', { path: { itemId }, lane });
    const authenticated = request.headers?.Authorization !== undefined;
    const read = await this.run(
      'itemDetail',
      lane,
      request,
      (res, raw): DetailRead => {
        const detail = normalizeItemDetail(raw, { observedAt: res.endedAt, authenticated });
        if (detail.itemId !== itemId) {
          throw new SgwApiError('schema', `itemDetail: asked for item ${String(itemId)}, got ${String(detail.itemId)}`);
        }
        return { detail, sentAt: res.startedAt, receivedAt: res.endedAt };
      },
      priority === undefined ? {} : { priority },
    );
    this.remember(read.detail, lane !== 'snipe');
    return read;
  }

  /** Updates the clock item and, unless `cache` is false (snipe lane), the cache entry. */
  private remember(detail: ItemDetail, cache: boolean): void {
    const now = this.deps.clock.now();
    const endMs = parsePacific(detail.endTimeRaw);
    if (!detail.isClosed && endMs > now) this.clockItem = { itemId: detail.itemId, endMs };
    else if (this.clockItem?.itemId === detail.itemId) this.clockItem = undefined;

    if (!cache) return;
    this.details.delete(detail.itemId);
    if (detail.isClosed || now >= endMs - DETAIL_NO_CACHE_BEFORE_END_MS) return;
    if (this.details.size >= DETAIL_CACHE_MAX_ENTRIES) {
      const oldest = this.details.keys().next();
      if (oldest.done !== true) this.details.delete(oldest.value);
    }
    this.details.set(detail.itemId, { detail, storedAt: now, endMs });
  }

  private fromCache(itemId: ItemId, maxAgeMs: number | undefined): ItemDetail | undefined {
    const entry = this.details.get(itemId);
    if (entry === undefined) return undefined;
    const now = this.deps.clock.now();
    const age = now - entry.storedAt;
    if (age < 0 || age >= DETAIL_CACHE_TTL_MS || now >= entry.endMs - DETAIL_NO_CACHE_BEFORE_END_MS) {
      this.details.delete(itemId);
      return undefined;
    }
    const limit = maxAgeMs !== undefined && Number.isFinite(maxAgeMs) ? Math.max(0, maxAgeMs) : DETAIL_CACHE_TTL_MS;
    return age < limit ? structuredClone(entry.detail) : undefined;
  }

  // ── Requests ──────────────────────────────────────────────────────────

  /**
   * Builds the request from config.ts. `credentials: 'omit'` always. The
   * bearer goes to `auth: 'required'` endpoints (or SgwApiError('auth')), and
   * to `auth: 'optional'` ones only on the snipe lane with a usable token.
   */
  private async prepare(endpoint: SgwEndpointKey, init: SgwRequestInit = {}): Promise<HttpRequest> {
    const ep: SgwEndpoint = SGW_ENDPOINTS[endpoint];
    const headers: Record<string, string> = {};
    if (ep.auth === 'required') {
      headers.Authorization = `Bearer ${await this.requiredBearer(endpoint)}`;
    } else if (ep.auth === 'optional' && init.lane === 'snipe') {
      const bearer = await this.usableBearer();
      if (bearer !== undefined) headers.Authorization = `Bearer ${bearer}`;
    }
    let url =
      SGW_API_BASE +
      ep.path.replace(/\{(\w+)\}/g, (_whole, name: string) => {
        const value = init.path?.[name];
        if (value === undefined) throw new Error(`${endpoint}: missing path parameter ${name}`);
        return encodeURIComponent(String(value));
      });
    if (ep.query !== undefined) {
      const qs = new URLSearchParams();
      for (const name of ep.query) {
        const value = init.query?.[name];
        if (value !== undefined) qs.append(name, String(value));
      }
      const text = qs.toString();
      if (text !== '') url += `?${text}`;
    }
    const request: HttpRequest = {
      url,
      method: ep.method,
      headers,
      timeoutMs: init.timeoutMs ?? REQUEST_TIMEOUT_MS,
      credentials: 'omit',
    };
    if (ep.body === 'json') {
      headers['Content-Type'] = 'application/json';
      request.body = JSON.stringify(init.body ?? {});
    }
    return request;
  }

  /** The session's bearer, or SgwApiError('auth') before anything is sent. Never logged. */
  private async requiredBearer(endpoint: SgwEndpointKey): Promise<string> {
    const session = await this.deps.session.current();
    if (session === null || session.bearer === '') {
      throw new SgwApiError('auth', `${endpoint}: no SGW session; sign in on shopgoodwill.com`);
    }
    if (session.expiresAt <= this.deps.clock.now()) {
      throw new SgwApiError('auth', `${endpoint}: the SGW session has expired; sign in on shopgoodwill.com`);
    }
    return session.bearer;
  }

  /**
   * The bearer if the session has an unexpired one, else undefined (never
   * throws). A token known to be expired is not sent: it would only earn a 401.
   */
  private async usableBearer(): Promise<string | undefined> {
    const session = await this.deps.session.current();
    if (session === null || session.bearer === '' || session.expiresAt <= this.deps.clock.now()) return undefined;
    return session.bearer;
  }

  /** Hands one request to the scheduler; a schema failure is flagged to health on its way out. */
  private async run<T>(
    endpoint: SgwEndpointKey,
    lane: Lane,
    request: HttpRequest,
    parse: (res: HttpResponse, raw: unknown) => T,
    opts: RunOptions = {},
  ): Promise<T> {
    const scheduled: ScheduledRequest<T> = {
      lane,
      endpoint,
      build: () => {
        opts.beforeSend?.();
        return { ...request, headers: { ...request.headers } };
      },
      parse: (res) => parse(res, decode(endpoint, res)),
    };
    if (opts.priority !== undefined) scheduled.priority = opts.priority;
    try {
      return await this.deps.scheduler.run(scheduled);
    } catch (e) {
      if (e instanceof SgwApiError && e.kind === 'schema') this.flagSchemaFailure(endpoint, e);
      if (e instanceof SgwApiError && e.kind === 'auth' && request.headers?.Authorization !== undefined) {
        await this.reportRejected();
      }
      throw e;
    }
  }

  /** The bearer was refused (401 / isUnauthorized): tell the session once. A failing session must not hide the auth error. */
  private async reportRejected(): Promise<void> {
    try {
      await this.deps.session.reportRejected();
    } catch {
      // ignored on purpose
    }
  }

  private flagSchemaFailure(endpoint: SgwEndpointKey, error: SgwApiError): void {
    try {
      this.deps.health.flagSchemaFailure({ endpoint, message: error.message, at: this.deps.clock.now() });
    } catch {
      // A broken sink must not hide the schema error itself.
    }
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isPositiveInt(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

function invalidInput(method: string, detail: string): SgwApiError {
  return new SgwApiError('schema', `${method}: invalid-input: ${detail}`);
}

function invalidQuery(detail: string): SgwApiError {
  return new SgwApiError('schema', `search: invalid-query: ${detail}`);
}

function assertItemId(method: string, itemId: ItemId): void {
  if (!isPositiveInt(itemId)) throw invalidInput(method, `itemId must be a positive integer, got ${String(itemId)}`);
}

/** The scheduler handles 401/403/429/5xx itself; this covers anything else that is not 2xx (400, 404). */
function statusKind(status: number): SgwApiErrorKind {
  if (status === 401) return 'auth';
  if (status === 403) return 'blocked';
  if (status === 429) return 'rate-limited';
  return 'server';
}

/** Status check, then JSON. A body that is not JSON is a schema failure. */
function decode(endpoint: SgwEndpointKey, res: HttpResponse): unknown {
  if (res.status < 200 || res.status > 299) {
    throw new SgwApiError(statusKind(res.status), `${endpoint}: SGW answered ${String(res.status)}`, { status: res.status });
  }
  try {
    return JSON.parse(res.bodyText) as unknown;
  } catch (e) {
    throw new SgwApiError('schema', `${endpoint}: the reply is not JSON`, { status: res.status, cause: e });
  }
}

/** The parser for add/remove/note replies: only the envelope head matters (provisional schema, T-24). */
function ackOf(endpoint: AckEndpoint): (res: HttpResponse, raw: unknown) => void {
  return (_res, raw) => {
    const head = parseEndpoint(endpoint, raw);
    if (head.isUnauthorized === true) throw new SgwApiError('auth', `${endpoint}: SGW says unauthorized`);
    if (!head.status) {
      const message = htmlToText(head.message ?? '');
      throw new SgwApiError('server', `${endpoint}: status false${message === '' ? '' : `: ${message}`}`);
    }
  };
}

/**
 * Double quotes in `searchText` make buyerapi answer 403 (S-1 #7's notes).
 * S-1 verified only the ASCII `"`. The curly quotes U+201C and U+201D and the
 * fullwidth U+FF02 are stripped too, defensively.
 */
const QUOTES = /["“”＂]/g;

function stripQuotes(text: string): string {
  return text.replace(QUOTES, '');
}

// ── Search body (R1, R2) ────────────────────────────────────────────────────

function flag(b: boolean | undefined): 'true' | 'false' {
  return b === true ? 'true' : 'false';
}

/** Cents → the dollar string SGW parses: "10" for whole dollars, else "12.99". */
function dollars(name: string, cents: Cents): string {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw invalidQuery(`${name} must be a whole number of cents >= 0, got ${String(cents)}`);
  }
  return cents % 100 === 0 ? String(cents / 100) : formatCents(cents);
}

function idList(name: string, ids: readonly number[]): string {
  for (const id of ids) {
    if (!isPositiveInt(id)) throw invalidQuery(`${name} must be positive integers, got ${String(id)}`);
  }
  return ids.join(',');
}

/** Pacific "today" as M/d/yyyy, what the site sends in `closedAuctionEndingDate`. */
function pacificToday(now: EpochMs): string {
  const [y = '', m = '', d = ''] = formatPacificNaive(now).slice(0, 10).split('-');
  return `${String(Number(m))}/${String(Number(d))}/${y}`;
}

type BodyField = keyof typeof SGW_SEARCH_BODY_DEFAULTS;

/**
 * Body fields the adapter always sets itself, never from `extra`:
 * - `pageSize`: always 40 rows per page (§3.3);
 * - `closedAuctionEndingDate`: Pacific today. A saved URL's date goes stale.
 */
const ADAPTER_OWNED_FIELDS: ReadonlySet<string> = new Set<BodyField>(['pageSize', 'closedAuctionEndingDate']);

function parseBool(v: string): boolean | undefined {
  const t = v.toLowerCase();
  return t === 'true' ? true : t === 'false' ? false : undefined;
}

/**
 * One `extra` value, coerced the way SGW_SEARCH_BODY_DEFAULTS types its field.
 * Throws invalid-query when it cannot be (R1: nothing is sent):
 * - a JSON boolean default becomes a JSON boolean;
 * - a "true"/"false" default becomes that string;
 * - a JSON number default becomes a safe integer >= 0;
 * - a numeric-string default becomes a digit string;
 * - an empty-string default depends on the field:
 *   - `searchBuyNowOnly`: "", "true" or "false";
 *   - `catIds`: positive ids, comma-separated;
 *   - anything else: free text with double quotes stripped (they 403).
 */
function coerceExtra(key: string, field: BodyField, raw: string): string | number | boolean {
  const value = raw.trim();
  const bad = (expected: string): SgwApiError => invalidQuery(`${key} (${field}) must be ${expected}, got ${JSON.stringify(raw)}`);
  const def: string | number | boolean = SGW_SEARCH_BODY_DEFAULTS[field];
  if (typeof def === 'boolean') {
    const b = parseBool(value);
    if (b === undefined) throw bad('true or false');
    return b;
  }
  if (typeof def === 'number') {
    const n = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(n)) throw bad('a whole number');
    return n;
  }
  if (def === 'true' || def === 'false') {
    const b = parseBool(value);
    if (b === undefined) throw bad('true or false');
    return flag(b);
  }
  if (/^\d+$/.test(def)) {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw bad('a whole number');
    return String(Number(value));
  }
  if (field === 'searchBuyNowOnly') {
    if (value === '') return '';
    const b = parseBool(value);
    if (b === undefined) throw bad('empty, true or false');
    return flag(b);
  }
  if (field === 'catIds') {
    if (value === '') return '';
    const ids = value.split(',').map((s) => s.trim());
    if (!ids.every((s) => /^\d+$/.test(s) && isPositiveInt(Number(s)))) throw bad('positive ids, comma-separated');
    return ids.map(Number).join(',');
  }
  return stripQuotes(value);
}

/**
 * Ruling C7: the `extra` keys that SGW_SEARCH_URL_PARAMS knows but that are not
 * named query fields (`sus`, `sis`, `scs`, `sbn`, `cadb`, `mci`, …), mapped to
 * their body fields and coerced. Not sent:
 * - keys SGW_SEARCH_URL_PARAMS does not know (URL round trip only, T-50);
 * - params with no body default to type them by (`ihp`: isFromHomePage);
 * - ADAPTER_OWNED_FIELDS.
 * Named params in `extra` were already refused (R1).
 */
function extraFields(extra: Readonly<Record<string, string>> | undefined): Partial<Record<BodyField, string | number | boolean>> {
  const out: Partial<Record<BodyField, string | number | boolean>> = {};
  for (const [key, raw] of Object.entries(extra ?? {})) {
    if (!Object.hasOwn(SGW_SEARCH_URL_PARAMS, key)) continue;
    const field: string = SGW_SEARCH_URL_PARAMS[key as keyof typeof SGW_SEARCH_URL_PARAMS];
    if (ADAPTER_OWNED_FIELDS.has(field) || !Object.hasOwn(SGW_SEARCH_BODY_DEFAULTS, field)) continue;
    out[field as BodyField] = coerceExtra(key, field as BodyField, raw);
  }
  return out;
}

/**
 * The ItemListing body: SGW_SEARCH_BODY_DEFAULTS in the site's key order with
 * the query's values. Known `extra` params go in through extraFields (C7). An
 * `extra` key that is a named param means its value did not parse, so it is
 * refused here (R1).
 */
function searchBody(q: SearchQuery, now: EpochMs): Record<string, unknown> {
  const unparsed = invalidSearchParams(q);
  if (unparsed.length > 0) throw invalidQuery(`unparseable URL params: ${unparsed.join(', ')}`);
  if (!isPositiveInt(q.page)) throw invalidQuery(`page must be a positive integer, got ${String(q.page)}`);
  if (q.sortColumn !== undefined && !(Number.isSafeInteger(q.sortColumn) && q.sortColumn >= 0)) {
    throw invalidQuery(`sortColumn must be an integer >= 0, got ${String(q.sortColumn)}`);
  }
  return {
    ...SGW_SEARCH_BODY_DEFAULTS,
    ...extraFields(q.extra),
    layout: q.layout ?? SGW_SEARCH_BODY_DEFAULTS.layout,
    // R2 (and M3): double quotes make buyerapi answer 403; see stripQuotes.
    searchText: stripQuotes(q.searchText).trim(),
    selectedCategoryIds: idList('categoryIds', q.categoryIds),
    selectedSellerIds: idList('sellerIds', q.sellerIds),
    lowPrice: q.lowPrice === undefined ? SGW_SEARCH_BODY_DEFAULTS.lowPrice : dollars('lowPrice', q.lowPrice),
    highPrice: q.highPrice === undefined ? SGW_SEARCH_BODY_DEFAULTS.highPrice : dollars('highPrice', q.highPrice),
    searchPickupOnly: flag(q.pickupOnly),
    searchNoPickupOnly: flag(q.excludePickupOnly),
    searchOneCentShippingOnly: flag(q.oneCentShippingOnly),
    searchDescriptions: flag(q.searchDescriptions),
    searchClosedAuctions: flag(q.closedAuctions),
    closedAuctionEndingDate: pacificToday(now),
    sortColumn: q.sortColumn === undefined ? SGW_SEARCH_BODY_DEFAULTS.sortColumn : String(q.sortColumn),
    page: String(q.page),
    sortDescending: flag(q.sortDescending),
  };
}
