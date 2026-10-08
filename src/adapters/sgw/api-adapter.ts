// T-26: the ApiAdapter, PLAN §3.3 `SgwApi` over T-25's RequestScheduler.
//
// The single gateway for every request the extension makes to SGW's buyer
// API (PLAN §1.7). It builds each request from config.ts, hands it to the
// scheduler (lanes, budgets, spacing, backoff) and maps the reply through
// T-24's normalizers. Rules it enforces, for courtesy and safety:
//
// - Everything goes through `RequestScheduler.run`; the adapter has no Http.
// - `credentials: 'omit'` on every request, read or write: never a cookie (the
//   site's `Bid` cookie 403s a second bid, §1.7). The bearer goes only to the
//   endpoints config.ts marks `auth: 'required'`, and only while SgwSession
//   holds an unexpired token. Without one the call fails with `auth` and
//   nothing is sent. Anonymous reads never carry it, even when it exists.
// - Inputs are checked before anything is sent. Search filters per S-1:
//   SGW answers 400 to a non-numeric price, and silently ignores a meaningless
//   category filter, returning unfiltered rows. Double quotes in `searchText`
//   get a 403, so they are stripped. Booleans go as "true"/"false" strings.
//   Invalid input is SgwApiError('schema') with "invalid-query"/"invalid-input"
//   in the message: the frozen error kinds have no closer match, and it is
//   never reported to health.
// - Writes pass `gate()`: the kill switch first, then the feature's dry-run,
//   then GlobalSwitches.writesAllowed (health, session). A refusal sends
//   nothing, is audited and throws `paused`. The kill switch and dry-run are
//   read again right before the request leaves (`guard()` in build()), so
//   one flipped while the write waited in its lane still stops it.
// - A reply that fails its schema throws SgwApiError('schema') and is
//   reported to health (`flagSchemaFailure`), so writes can fail closed.
import type { AuditEntry, AuditLog } from '../../domain/audit/types';
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
 * - a stored time in the future (the clock moved back) counts as stale.
 * The end time is SGW's clock and `now` is the local one; the 5-minute margin
 * also absorbs a local clock running up to 5 minutes slow.
 */
export const DETAIL_CACHE_TTL_MS = 60_000;
export const DETAIL_NO_CACHE_BEFORE_END_MS = 5 * 60_000;
/** Bound on the in-memory detail cache; the oldest entry goes first. */
export const DETAIL_CACHE_MAX_ENTRIES = 500;

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

export type WriteFeature = 'favorites' | 'bidding';

/**
 * GlobalSwitches plus the two settings R4 tells apart. The frozen port only
 * answers writesAllowed(feature); the adapter also needs to know WHICH
 * refusal is in effect (a kill-switch block and a dry-run intent are audited
 * differently), and needs it synchronously to re-check inside build(). T-36's
 * switches implement this from their in-memory Settings copy.
 */
export interface WriteSwitches extends GlobalSwitches {
  /** `Settings.killSwitch` and `Settings.dryRun[feature]`, right now. */
  state(feature: WriteFeature): { killSwitch: boolean; dryRun: boolean };
}

/** A reply that failed its schema. */
export interface SchemaFailure {
  endpoint: SgwEndpointKey;
  message: string;
  at: EpochMs;
}

/**
 * Where schema failures are flagged. The SgwHealth port has no "flag" call,
 * so T-36 wires this to the health state that makes writesAllowed fail
 * closed. It must not throw (if it does, the schema error still surfaces).
 */
export interface SgwHealthFlag {
  flagSchemaFailure(f: SchemaFailure): void;
}

export interface ApiAdapterDeps {
  scheduler: RequestScheduler;
  clock: Clock;
  /** Bearer source (T-28). */
  session: Pick<SgwSession, 'current'>;
  switches: WriteSwitches;
  /** Records dry-run intents and blocked writes (T-35/T-41). */
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
}

/** What the PlaceBid path (bid.ts, T-100) gets from the adapter. */
export interface BidContext {
  readonly scheduler: RequestScheduler;
  readonly clock: Clock;
  /**
   * Builds a request the way every adapter request is built (`credentials:
   * 'omit'`, the bearer only for auth endpoints). Rejects with
   * SgwApiError('auth'), sending nothing, without a usable session.
   */
  prepare(endpoint: SgwEndpointKey, init?: SgwRequestInit): Promise<HttpRequest>;
  /** Call inside build(): throws SgwApiError('paused') if the kill switch or bidding dry-run came on meanwhile. */
  guardSend(): void;
  /** Reports a reply that failed its schema. */
  flagSchemaFailure(endpoint: SgwEndpointKey, error: SgwApiError): void;
}

// ── Adapter ─────────────────────────────────────────────────────────────────

type WriteKind = 'favorite.add' | 'favorite.remove' | 'favorite.note' | 'bid.place';
const WRITE_ACTION: Record<WriteKind, string> = {
  'favorite.add': 'add',
  'favorite.remove': 'remove',
  'favorite.note': 'note',
  'bid.place': 'bid',
};
type AckEndpoint = 'addFavorite' | 'removeFavorite' | 'saveFavoriteNote';
type NewAuditEntry = Omit<AuditEntry, 'seq' | 'at'>;

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
  /** Runs inside build(), right before the request leaves; may throw to stop it. */
  beforeSend?: () => void;
}

const US_ZIP = /^\d{5}(-\d{4})?$/;

export class SgwApiAdapter implements SgwApi {
  private readonly details = new Map<ItemId, CachedDetail>();
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

  /** Anonymous (config.ts): `isHighBidder` and `inWatchlist` come back null. Cache policy: DETAIL_CACHE_TTL_MS. */
  async itemDetail(itemId: ItemId, lane: Lane, opts?: { maxAgeMs?: number }): Promise<ItemDetail> {
    assertItemId('itemDetail', itemId);
    const cached = this.fromCache(itemId, opts?.maxAgeMs);
    if (cached !== undefined) return cached;
    const read = await this.readDetail(itemId, lane);
    return structuredClone(read.detail);
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
    await this.write('favorites', 'favorite.add', { itemId }, 'addFavorite', { query: { itemId } });
  }

  async removeFavorite(itemId: ItemId): Promise<void> {
    assertItemId('removeFavorite', itemId);
    await this.write('favorites', 'favorite.remove', { itemId }, 'removeFavorite', { query: { itemId } });
  }

  /** The note text is sent to SGW but never written to the audit log. */
  async saveFavoriteNote(watchlistId: number, notes: string): Promise<void> {
    if (!isPositiveInt(watchlistId)) throw invalidInput('saveFavoriteNote', 'watchlistId must be a positive integer');
    if (notes.length > FAVORITE_NOTE_MAX_CHARS) {
      throw invalidInput('saveFavoriteNote', `notes are limited to ${String(FAVORITE_NOTE_MAX_CHARS)} characters (got ${String(notes.length)})`);
    }
    await this.write('favorites', 'favorite.note', { ref: `watchlist:${String(watchlistId)}` }, 'saveFavoriteNote', {
      body: { notes, watchlistId },
    });
  }

  /** Gated here, then handed to bid.ts (a stub that throws `paused` until T-100). */
  async placeBid(
    req: { itemId: ItemId; sellerId: number; bidAmount: Cents; quantity: 1 },
    opts: { idempotencyKey: string; timeoutMs: number },
  ): Promise<BidResult> {
    assertItemId('placeBid', req.itemId);
    const target = { itemId: req.itemId };
    await this.gate('bidding', 'bid.place', target);
    const ctx: BidContext = {
      scheduler: this.deps.scheduler,
      clock: this.deps.clock,
      prepare: (endpoint, init) => this.prepare(endpoint, init),
      guardSend: () => {
        this.guard('bidding', 'bid.place', target);
      },
      flagSchemaFailure: (endpoint, error) => {
        this.flagSchemaFailure(endpoint, error);
      },
    };
    return placeBidPath(ctx, req, opts);
  }

  private async write(
    feature: WriteFeature,
    kind: WriteKind,
    target: WriteTarget,
    endpoint: AckEndpoint,
    init: SgwRequestInit,
  ): Promise<void> {
    await this.gate(feature, kind, target);
    const request = await this.prepare(endpoint, init);
    await this.run(
      endpoint,
      WRITE_LANE,
      request,
      (_res, raw) => {
        ack(endpoint, raw);
      },
      {
        beforeSend: () => {
          this.guard(feature, kind, target);
        },
      },
    );
  }

  /**
   * R4, in this order: the kill switch, the feature's dry-run, then
   * writesAllowed (health, session). Any refusal sends nothing, is audited
   * and throws `paused`, which is what the port says a dry-run write does.
   * A dry-run intent records only the item (or ref) and the action.
   */
  private async gate(feature: WriteFeature, kind: WriteKind, target: WriteTarget): Promise<void> {
    const { killSwitch, dryRun } = this.deps.switches.state(feature);
    if (killSwitch) {
      await this.audit(blocked(kind, target, 'kill-switch'));
      throw new SgwApiError('paused', `${kind}: the kill switch is on; nothing was sent`);
    }
    if (dryRun) {
      await this.audit(intent(kind, target));
      throw new SgwApiError('paused', `${kind}: dry run; the intent was recorded, nothing was sent`);
    }
    const verdict = await this.deps.switches.writesAllowed(feature);
    if (!verdict.ok) {
      const why = verdict.why ?? 'writes are not allowed';
      await this.audit(blocked(kind, target, why));
      throw new SgwApiError('paused', `${kind}: ${why}; nothing was sent`);
    }
  }

  /** The kill switch and dry-run again, synchronously, inside build() (the write may have waited in its lane). */
  private guard(feature: WriteFeature, kind: WriteKind, target: WriteTarget): void {
    const { killSwitch, dryRun } = this.deps.switches.state(feature);
    if (!killSwitch && !dryRun) return;
    void this.audit(killSwitch ? blocked(kind, target, 'kill-switch') : intent(kind, target));
    throw new SgwApiError(
      'paused',
      `${kind}: ${killSwitch ? 'the kill switch' : 'dry run'} came on while the write waited; nothing was sent`,
    );
  }

  private async audit(entry: NewAuditEntry): Promise<void> {
    try {
      await this.deps.audit.append(entry);
    } catch {
      // The refusal stands even if the log cannot be written.
    }
  }

  // ── ItemDetail cache (R6, see DETAIL_CACHE_TTL_MS) ────────────────────

  private async readDetail(itemId: ItemId, lane: Lane, priority?: number): Promise<DetailRead> {
    const request = await this.prepare('itemDetail', { path: { itemId } });
    const read = await this.run(
      'itemDetail',
      lane,
      request,
      (res, raw): DetailRead => {
        const detail = normalizeItemDetail(raw, { observedAt: res.endedAt, authenticated: false });
        if (detail.itemId !== itemId) {
          throw new SgwApiError('schema', `itemDetail: asked for item ${String(itemId)}, got ${String(detail.itemId)}`);
        }
        return { detail, sentAt: res.startedAt, receivedAt: res.endedAt };
      },
      priority === undefined ? {} : { priority },
    );
    this.remember(read.detail);
    return read;
  }

  private remember(detail: ItemDetail): void {
    const now = this.deps.clock.now();
    const endMs = parsePacific(detail.endTimeRaw);
    if (!detail.isClosed && endMs > now) this.clockItem = { itemId: detail.itemId, endMs };
    else if (this.clockItem?.itemId === detail.itemId) this.clockItem = undefined;

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

  /** Builds the request from config.ts: `credentials: 'omit'` always, the bearer only where auth is required. */
  private async prepare(endpoint: SgwEndpointKey, init: SgwRequestInit = {}): Promise<HttpRequest> {
    const ep: SgwEndpoint = SGW_ENDPOINTS[endpoint];
    const headers: Record<string, string> = {};
    if (ep.auth === 'required') headers.Authorization = `Bearer ${await this.bearer(endpoint)}`;
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
  private async bearer(endpoint: SgwEndpointKey): Promise<string> {
    const session = await this.deps.session.current();
    if (session === null || session.bearer === '') {
      throw new SgwApiError('auth', `${endpoint}: no SGW session; sign in on shopgoodwill.com`);
    }
    if (session.expiresAt <= this.deps.clock.now()) {
      throw new SgwApiError('auth', `${endpoint}: the SGW session has expired; sign in on shopgoodwill.com`);
    }
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
      throw e;
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

/** Add/remove/note replies: only the envelope head matters (provisional schema, T-24). */
function ack(endpoint: AckEndpoint, raw: unknown): void {
  const head = parseEndpoint(endpoint, raw);
  if (head.isUnauthorized === true) throw new SgwApiError('auth', `${endpoint}: SGW says unauthorized`);
  if (!head.status) {
    const message = htmlToText(head.message ?? '');
    throw new SgwApiError('server', `${endpoint}: status false${message === '' ? '' : `: ${message}`}`);
  }
}

function intent(kind: WriteKind, target: WriteTarget): NewAuditEntry {
  return { actor: 'system', kind, ...target, dryRun: true, details: { action: WRITE_ACTION[kind] } };
}

function blocked(kind: WriteKind, target: WriteTarget, reason: string): NewAuditEntry {
  return { actor: 'system', kind: 'write.blocked', ...target, details: { action: kind, reason } };
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

/**
 * The ItemListing body: SGW_SEARCH_BODY_DEFAULTS in the site's key order with
 * the query's values. Never forwards `q.extra`: those keys are kept for the
 * URL round trip only (T-50). One whose name is a mapped param means its
 * value did not parse, and is refused here (R1).
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
    layout: q.layout ?? SGW_SEARCH_BODY_DEFAULTS.layout,
    // R2: double quotes make buyerapi answer 403.
    searchText: q.searchText.replaceAll('"', '').trim(),
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
