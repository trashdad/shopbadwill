// T-84: the snipe runner (src/background/jobs/snipe-runner.ts), its handlers
// (src/background/handlers/snipe.ts) and the SnipeHost factory
// (src/adapters/browser/snipe-host.ts), run inside the real background
// composition root (main.ts) over fakes.
//
// Everything is fake and deterministic: FakeClock, FakeStorageAreas, FakeAlarms
// (with a +45 s firing delay unless a test says otherwise), FakeHttp scripted as
// a tiny SGW (FakeSgw below; an unscripted request rejects, so nothing can leak
// to a real host), FakeNotifier, FakeKeepAwake and a counting KeepAlive.
//
// A "worker" is one startBackground() instance. `kill()` simulates the MV3
// worker dying: its timers stop, its listeners detach and every I/O it starts
// or awaits afterwards never settles. Storage, alarms, the clock and the fake
// server are shared and survive, as they do in the browser. A crash can be
// injected right after a chosen storage write (`crashAfterSet`), which is how
// "persist before send" and the outbox replay are proven.
import { createHash } from 'node:crypto';

import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import {
  BackgroundSnipeHost,
  createSnipeHost,
  hostVerdict,
  S7_HOST_VERDICT,
  type SnipeHostModule,
} from '../../src/adapters/browser/snipe-host';
import type { BackgroundContext, BackgroundModule, RuntimePort } from '../../src/background/context';
import { HANDLER_MODULES } from '../../src/background/handlers/index';
import { COMPANION_WAKE_MARGIN_MS } from '../../src/background/jobs/companion-sync';
import { JOB_MODULES } from '../../src/background/jobs/index';
import {
  getSnipeRunner,
  KEEP_ALIVE_INTERVAL_MS,
  POST_READ_FAST_ATTEMPTS,
  POST_READ_SLOW_ATTEMPTS,
  RUNNER_KEY,
  snipeAlarmName,
  snipeSeams,
  type CommitResult,
  type SendStrategy,
  type SnipeRunner,
} from '../../src/background/jobs/snipe-runner';
import { SWITCHES_LOAD_TIMEOUT_MS } from '../../src/background/switches';
import { startBackground, type BackgroundBrowser } from '../../src/background/main';
import type { MessageResponse, RouterSender } from '../../src/background/router';
import { BidNotSentError } from '../../src/adapters/sgw/bid';
import { normalizeItemDetail } from '../../src/adapters/sgw/normalize';
import type { AuditEntry } from '../../src/domain/audit/types';
import { bidAmount } from '../../src/domain/money';
import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import { exposure } from '../../src/domain/snipe/caps';
import { settledAsMissed } from '../../src/domain/snipe/outcome';
import { STORAGE_KEYS } from '../../src/domain/storage/schema';
import { formatPacificNaive } from '../../src/domain/time/pacific';
import type { Snipe, SnipeEvent } from '../../src/domain/snipe/types';
import type { HealthReport, SgwSessionRecord } from '../../src/domain/types';
import type { AlarmInfo, Alarms } from '../../src/ports/alarms';
import type { Clock } from '../../src/ports/clock';
import { HttpNetworkError } from '../../src/ports/errors';
import type { Http, HttpRequest, HttpResponse } from '../../src/ports/http';
import type { KeepAlive } from '../../src/ports/keep-alive';
import type { Notification, Notifier } from '../../src/ports/notifier';
import type { Storage, StorageAreas } from '../../src/ports/storage';
import { loadFixture } from '../contract/sgw/fixtures';
import { FakeAlarms } from '../fakes/ports/fake-alarms';
import { FakeClock } from '../fakes/ports/fake-clock';
import { FakeHttp, type HttpStep } from '../fakes/ports/fake-http';
import { FakeKeepAwake } from '../fakes/ports/fake-keepawake';
import { FakeNotifier } from '../fakes/ports/fake-notifier';
import { FakePermissions } from '../fakes/ports/fake-permissions';
import { FakeStorage, FakeStorageAreas } from '../fakes/ports/fake-storage';

// ── Constants ────────────────────────────────────────────────────────────────

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const EXT_ID = 'test-extension-id';
const EXT_ORIGIN = `chrome-extension://${EXT_ID}/`;
const UI: RouterSender = { id: EXT_ID, url: `${EXT_ORIGIN}dashboard.html` };
const API = 'https://buyerapi.shopgoodwill.com/api/';
const DETAIL_URL = `${API}ItemDetail/GetItemDetailModelByItemId/`;
const MODAL_URL = `${API}ItemBid/ShowBidModal`;
const PLACE_URL = `${API}ItemBid/PlaceBid`;

const T0 = Date.UTC(2026, 9, 10, 15, 0, 0);
/** Auction end, SGW (server) time. */
const END = T0 + 2 * HOUR;
/** SGW's clock runs this far ahead of ours (S-7's fake setup). */
const SKEW = 1300;
const LATENCY = 150;
const ITEM = 702801256;
const SELLER = 955353;
const LEAD = 8000;
const MAX = 2000;
/** The planned fire, server time: end - lead - rtt/2 (T-81). */
const FIRE_SERVER = END - LEAD - LATENCY / 2;
const FIRE_LOCAL = FIRE_SERVER - SKEW;
const ALARM_DELAY = 45 * SEC;
/** "No bid was placed" style copy: never allowed once a bid may have gone out. */
const NO_BID_CLAIM = /no bid was placed|not bid|no bid sent|no bid was sent/i;

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
const SESSION_EXP = T0 + 30 * DAY;
const BEARER = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ BuyerId: '42', exp: Math.floor(SESSION_EXP / 1000), jti: 'token-1' })}.c2ln`;
const SESSION: SgwSessionRecord = { bearer: BEARER, capturedAt: T0 - MIN, expiresAt: SESSION_EXP, buyerId: '42', source: 'tap' };
const META = { schemaVersion: 1, installedAt: T0 - DAY, lastMigrationAt: T0 - DAY };

function settingsWith(opts: { live?: boolean; tier?: Settings['snipe']['tier']; enabled?: boolean } = {}): Settings {
  const s = defaultSettings();
  s.snipe.enabled = opts.enabled ?? true;
  if (opts.tier) s.snipe.tier = opts.tier;
  if (opts.live === true) s.dryRun = { favorites: false, calendar: false, bidding: false };
  return s;
}

const flush = async (rounds = 3): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);

// ── A tiny SGW over FakeHttp ─────────────────────────────────────────────────

interface SgwItem {
  endMs: number;
  price: number;
  minimumBid: number;
  numBids: number;
  closed: boolean;
  high: boolean;
}

interface PlaceBidSeen {
  at: number;
  body: { itemId: number; bidAmount: string; sellerId: number; quantity: number };
  /** The stored snipe at the moment PlaceBid left (persist-before-send). */
  stored: Snipe | undefined;
}

class FakeSgw {
  item: SgwItem = { endMs: END, price: 1000, minimumBid: 1100, numBids: 3, closed: false, high: false };
  skew = SKEW;
  latency = LATENCY;
  /** Replaces the next ItemDetail replies, in order. */
  readonly detailFaults: HttpStep[] = [];
  /** Replaces every ItemDetail reply while set. */
  detailDown: HttpStep | undefined;
  placeBidStep: HttpStep | undefined;
  readonly placeBids: PlaceBidSeen[] = [];
  readonly modals: number[] = [];
  readonly details: Array<{ at: number; auth: boolean }> = [];

  constructor(
    private readonly clock: FakeClock,
    http: FakeHttp,
    private readonly areas: FakeStorageAreas,
  ) {
    http.on(
      (r) => r.url.startsWith(DETAIL_URL),
      (req) => this.detail(req),
    );
    http.on(MODAL_URL, () => {
      this.modals.push(this.clock.now());
      return this.ok({ sellerId: SELLER, minimumBid: this.item.minimumBid / 100 });
    });
    http.on(PLACE_URL, (req) => {
      const stored = (this.areas.local.dump()[STORAGE_KEYS.snipes] as Record<string, Snipe> | undefined) ?? {};
      const body = JSON.parse(String(req.body)) as PlaceBidSeen['body'];
      this.placeBids.push({ at: this.clock.now(), body, stored: Object.values(stored).find((s) => s.itemId === body.itemId) });
      return this.placeBidStep ?? this.ok({ status: true, result: 0, message: 'Bid placed', isHighBidder: true });
    });
    http.on(`${API}Dashboard/GetCurrentTime`, () => this.ok(this.currentTime()));
  }

  serverNow(): number {
    return this.clock.now() + this.skew;
  }

  placeBidCount(): number {
    return this.placeBids.length;
  }

  private ok(body: unknown): HttpStep {
    return { status: 200, bodyText: JSON.stringify(body), latencyMs: this.latency };
  }

  private currentTime(): string {
    const p = formatPacificNaive(this.serverNow() + this.latency / 2);
    const [date = '', time = ''] = p.split('T');
    const [y, m, d] = date.split('-');
    return `${m ?? ''}/${d ?? ''}/${y ?? ''} ${time.slice(0, 8)}`;
  }

  private detail(req: HttpRequest): HttpStep {
    this.details.push({ at: this.clock.now(), auth: req.headers?.Authorization !== undefined });
    const fault = this.detailFaults.shift() ?? this.detailDown;
    if (fault) return fault;
    return { status: 200, bodyText: JSON.stringify(this.raw()), latencyMs: this.latency };
  }

  /** The ItemDetail reply SGW would send now. */
  raw(): Record<string, unknown> {
    const raw = structuredClone(loadFixture<Record<string, unknown>>('item-detail-open'));
    // SGW stamps serverTime mid-flight: the offset estimate is then exact.
    const server = this.serverNow() + this.latency / 2;
    const i = this.item;
    const closed = i.closed || server >= i.endMs;
    raw.itemId = ITEM;
    raw.sellerId = SELLER;
    raw.endTime = formatPacificNaive(i.endMs);
    raw.serverTime = formatPacificNaive(server);
    raw.currentPrice = i.price / 100;
    raw.minimumBid = i.minimumBid / 100;
    raw.numberOfBids = i.numBids;
    raw.isItemEndTimeExpire = closed;
    const history = raw.bidHistory as Record<string, unknown>;
    history.auctionClosed = closed;
    history.isHighBidderLogIn = i.high;
    return raw;
  }
}

// ── Shared browser state and killable workers ───────────────────────────────

interface Shared {
  clock: FakeClock;
  areas: FakeStorageAreas;
  alarms: FakeAlarms;
  http: FakeHttp;
  notifier: FakeNotifier;
  keepAwake: FakeKeepAwake;
  permissions: FakePermissions;
  sgw: FakeSgw;
  /** KeepAlive heartbeats (wall time), across workers. */
  pings: number[];
  keepAliveIntervals: number[];
}

function makeShared(opts: { alarmDelayMs?: number; settings?: Settings; seed?: Record<string, unknown> } = {}): Shared {
  const clock = new FakeClock(T0);
  const areas = new FakeStorageAreas();
  areas.local.seed({
    [STORAGE_KEYS.meta]: META,
    [STORAGE_KEYS.settings]: opts.settings ?? settingsWith({ live: true }),
    [STORAGE_KEYS.sgwSession]: SESSION,
    ...opts.seed,
  });
  const http = new FakeHttp(clock);
  return {
    clock,
    areas,
    alarms: new FakeAlarms(clock, { extraDelayMs: opts.alarmDelayMs ?? ALARM_DELAY }),
    http,
    notifier: new FakeNotifier(),
    keepAwake: new FakeKeepAwake({ available: true }),
    permissions: new FakePermissions(),
    sgw: new FakeSgw(clock, http, areas),
    pings: [],
    keepAliveIntervals: [],
  };
}

interface Life {
  dead: boolean;
  offs: Array<() => void>;
}

class WorkerClock implements Clock {
  private readonly ids = new Set<number>();
  constructor(
    private readonly base: FakeClock,
    private readonly life: Life,
  ) {}
  now(): number {
    return this.base.now();
  }
  monotonic(): number {
    return this.base.monotonic();
  }
  setTimeout(fn: () => void, ms: number): number {
    if (this.life.dead) return -1;
    const id = this.base.setTimeout(() => {
      this.ids.delete(id);
      if (!this.life.dead) fn();
    }, ms);
    this.ids.add(id);
    return id;
  }
  clearTimeout(id: number): void {
    this.ids.delete(id);
    this.base.clearTimeout(id);
  }
  kill(): void {
    for (const id of this.ids) this.base.clearTimeout(id);
    this.ids.clear();
  }
}

type CrashPredicate = (area: 'local' | 'session', entries: Record<string, unknown>) => boolean;

class WorkerStorage implements Storage {
  constructor(
    private readonly base: FakeStorage,
    private readonly area: 'local' | 'session',
    private readonly life: Life,
    private readonly crash: {
      after?: CrashPredicate;
      failAfter?: CrashPredicate;
      /** The matching write is refused: nothing is stored, and its promise rejects. */
      failBefore?: CrashPredicate;
      /** Fake ms a matching write takes to land (a slow disk); the worker's clock runs it. */
      slow?: (area: 'local' | 'session', entries: Record<string, unknown>) => number;
      later: (fn: () => void, ms: number) => void;
      kill: () => void;
    },
  ) {}
  get<T>(key: string): Promise<T | undefined> {
    if (this.life.dead) return never();
    return this.base.get<T>(key).then((v) => (this.life.dead ? never<T | undefined>() : v));
  }
  set(entries: Record<string, unknown>): Promise<void> {
    if (this.life.dead) return never();
    const delay = this.crash.slow?.(this.area, entries) ?? 0;
    if (delay > 0) {
      // Lands after `delay`; a worker that dies first never stores it.
      return new Promise<void>((resolve) => {
        this.crash.later(resolve, delay);
      }).then(() => this.store(entries));
    }
    return this.store(entries);
  }
  private store(entries: Record<string, unknown>): Promise<void> {
    if (this.life.dead) return never();
    // The write fails and nothing is stored (the worker lives on).
    if (this.crash.failBefore?.(this.area, entries) === true) {
      return Promise.reject(new Error('storage.local.set failed; nothing was stored'));
    }
    const p = this.base.set(entries);
    if (this.crash.after?.(this.area, entries) === true) {
      this.crash.kill();
      return never();
    }
    // The write is stored, but its promise reports a failure (the worker lives on).
    if (this.crash.failAfter?.(this.area, entries) === true) {
      return p.then(() => Promise.reject(new Error('storage.local.set failed after the write')));
    }
    return p.then(() => (this.life.dead ? never<undefined>() : undefined));
  }
  remove(keys: string[]): Promise<void> {
    if (this.life.dead) return never();
    return this.base.remove(keys).then(() => (this.life.dead ? never<undefined>() : undefined));
  }
  onChanged(cb: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => void): () => void {
    const off = this.base.onChanged((c) => {
      if (!this.life.dead) cb(c);
    });
    this.life.offs.push(off);
    return off;
  }
}

class CountingKeepAlive implements KeepAlive {
  private timer: number | undefined;
  constructor(
    private readonly clock: Clock,
    private readonly shared: Shared,
  ) {}
  start(intervalMs: number): void {
    this.stop();
    this.shared.keepAliveIntervals.push(intervalMs);
    const tick = (): void => {
      this.shared.pings.push(this.clock.now());
      this.timer = this.clock.setTimeout(tick, intervalMs);
    };
    this.timer = this.clock.setTimeout(tick, intervalMs);
  }
  stop(): void {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
    this.timer = undefined;
  }
}

interface FakeEvent<L extends (...args: never[]) => unknown> {
  readonly listeners: L[];
  addListener(l: L): void;
  removeListener(l: L): void;
}
function fakeEvent<L extends (...args: never[]) => unknown>(): FakeEvent<L> {
  const listeners: L[] = [];
  return {
    listeners,
    addListener: (l) => {
      listeners.push(l);
    },
    removeListener: (l) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
}
type MessageListener = (raw: unknown, sender: RouterSender, sendResponse: (r: unknown) => void) => boolean | undefined;

interface WorkerOptions {
  crashAfterSet?: CrashPredicate;
  /** Fake ms the matching write takes before it is stored. */
  slowSet?: (area: 'local' | 'session', entries: Record<string, unknown>) => number;
  /** The matching write is stored, then reported as failed (the worker stays alive). */
  failAfterSet?: CrashPredicate;
  /** The matching write fails and is NOT stored (the worker stays alive). */
  failSet?: CrashPredicate;
  jobModules?: Record<string, BackgroundModule>;
}

class Worker {
  readonly life: Life = { dead: false, offs: [] };
  readonly clock: WorkerClock;
  readonly onMessage = fakeEvent<MessageListener>();
  readonly onConnect = fakeEvent<(port: RuntimePort) => void>();
  readonly alarmListeners = new Set<(a: AlarmInfo) => void>();
  readonly logs: string[] = [];
  readonly ready: Promise<BackgroundContext>;
  /** Settles when the worker is killed (work it was doing never settles). */
  readonly died: Promise<void>;
  private markDead: () => void = () => undefined;

  constructor(
    readonly shared: Shared,
    opts: WorkerOptions = {},
  ) {
    const life = this.life;
    this.died = new Promise<void>((resolve) => {
      this.markDead = resolve;
    });
    this.clock = new WorkerClock(shared.clock, life);
    const crash = {
      kill: () => {
        this.kill();
      },
      ...(opts.crashAfterSet ? { after: opts.crashAfterSet } : {}),
      ...(opts.failAfterSet ? { failAfter: opts.failAfterSet } : {}),
      ...(opts.failSet ? { failBefore: opts.failSet } : {}),
      ...(opts.slowSet ? { slow: opts.slowSet } : {}),
      later: (fn: () => void, ms: number) => {
        this.clock.setTimeout(fn, ms);
      },
    };
    const areas: StorageAreas = {
      local: new WorkerStorage(shared.areas.local, 'local', life, crash),
      session: new WorkerStorage(shared.areas.session, 'session', life, crash),
    };
    const http: Http = {
      send: (req: HttpRequest): Promise<HttpResponse> => {
        if (life.dead) return never();
        return shared.http.send(req).then(
          (r) => (life.dead ? never<HttpResponse>() : r),
          (e: unknown) => (life.dead ? never<HttpResponse>() : Promise.reject(e instanceof Error ? e : new Error(String(e)))),
        );
      },
    };
    const alarms: Alarms = {
      create: (name, o) => (life.dead ? never() : shared.alarms.create(name, o)),
      clear: (name) => (life.dead ? never() : shared.alarms.clear(name)),
      getAll: () => (life.dead ? never() : shared.alarms.getAll()),
      onAlarm: (cb) => {
        const guarded = (a: AlarmInfo): void => {
          if (!life.dead) cb(a);
        };
        this.alarmListeners.add(guarded);
        const off = shared.alarms.onAlarm(guarded);
        life.offs.push(off);
        return () => {
          off();
          this.alarmListeners.delete(guarded);
        };
      },
    };
    const notifier: Notifier = {
      supportsActions: true,
      notify: (n: Notification) => (life.dead ? never() : shared.notifier.notify(n)),
      onAction: (cb) => {
        const off = shared.notifier.onAction(cb);
        life.offs.push(off);
        return off;
      },
    };
    const browser = {
      runtime: {
        id: EXT_ID,
        getURL: (p: string) => EXT_ORIGIN + p.replace(/^\//, ''),
        sendMessage: () => Promise.reject(new Error('Receiving end does not exist.')),
        onMessage: this.onMessage,
        onConnect: this.onConnect,
        onStartup: fakeEvent<() => void>(),
        onInstalled: fakeEvent<(d: { reason: string; previousVersion?: string }) => void>(),
      },
      commands: { onCommand: fakeEvent<(command: string) => void>() },
      tabs: { query: () => Promise.resolve([]), sendMessage: () => Promise.resolve(undefined) },
      storage: fakeBrowser.storage,
      alarms: fakeBrowser.alarms,
    } satisfies BackgroundBrowser;
    const handle = startBackground({
      browser,
      ports: {
        clock: this.clock,
        storage: areas,
        http,
        alarms,
        notifier,
        permissions: shared.permissions,
        keepAwake: shared.keepAwake,
        keepAlive: new CountingKeepAlive(this.clock, shared),
        random: () => 0,
      },
      log: (m) => {
        this.logs.push(m);
      },
      handlerModules: HANDLER_MODULES,
      jobModules: { ...JOB_MODULES, ...opts.jobModules },
    });
    this.ready = handle.ready;
  }

  kill(): void {
    if (this.life.dead) return;
    this.life.dead = true;
    this.clock.kill();
    for (const off of this.life.offs.splice(0)) off();
    this.markDead();
  }

  /** Delivers an alarm to this worker as the browser would (used to duplicate one). */
  deliverAlarm(name: string): void {
    for (const cb of [...this.alarmListeners]) cb({ name, scheduledTime: this.shared.clock.now() });
  }

  send(type: string, payload?: unknown): Promise<MessageResponse> {
    const listener = this.onMessage.listeners[0];
    if (listener === undefined) throw new Error('no onMessage listener');
    return new Promise<MessageResponse>((resolve) => {
      listener({ v: 1, type, reqId: `req-${type}`, ...(payload === undefined ? {} : { payload }) }, UI, (r) => {
        resolve(r as MessageResponse);
      });
    });
  }

  async ok<T = unknown>(type: string, payload?: unknown): Promise<T> {
    const p = this.send(type, payload);
    let done = false;
    for (let i = 0; i < 50 && !done; i++) {
      done = await Promise.race([p.then(() => true), flush(1).then(() => false)]);
      // A handler may wait on a fake HTTP reply: let time run.
      if (!done) this.shared.clock.advance(50);
    }
    if (!done) throw new Error(`${type}: no reply (the worker ${this.life.dead ? 'died' : 'hung'})`);
    const r = await p;
    if (!r.ok) throw new Error(`${type} failed: ${r.error.code}: ${r.error.message}`);
    return r.reply as T;
  }
}

/** The earliest wall time at which a live timer or an alarm is due. */
/** Only the snipe runner's alarms; other registered modules (T-52's `sbw:tick`) keep their own. */
async function snipeAlarms(shared: Shared): Promise<Awaited<ReturnType<FakeAlarms['getAll']>>> {
  return (await shared.alarms.getAll()).filter((a) => a.name.startsWith('sbw:snipe:'));
}

function nextDue(shared: Shared): number | undefined {
  const timers = (shared.clock as unknown as { timers: Map<number, { at: number }> }).timers;
  let min: number | undefined;
  for (const t of timers.values()) {
    const wall = shared.clock.now() + (t.at - shared.clock.monotonic());
    if (min === undefined || wall < min) min = wall;
  }
  const a = shared.alarms.nextDue();
  if (a !== undefined && (min === undefined || a < min)) min = a;
  return min;
}

/** Runs fake time to `target`, one due event at a time, letting async work settle between events. */
async function runTo(shared: Shared, target: number): Promise<void> {
  for (let guard = 0; guard < 200_000; guard++) {
    await flush();
    const now = shared.clock.now();
    const due = nextDue(shared);
    if (due === undefined || due > target) {
      if (target > now) shared.clock.advance(target - now);
      await flush();
      return;
    }
    shared.clock.advance(Math.max(0, due - now));
  }
  throw new Error('runTo: too many events');
}

async function boot(shared: Shared, opts: WorkerOptions = {}): Promise<{ w: Worker; ctx: BackgroundContext }> {
  const w = new Worker(shared, opts);
  const ctx = await w.ready;
  await flush();
  return { w, ctx };
}

function armPayload(over: Partial<Snipe> = {}): Record<string, unknown> {
  return {
    id: 's1',
    itemId: ITEM,
    title: 'Pyrex bowl',
    endTime: new Date(END).toISOString(),
    endTimeAtArm: new Date(END).toISOString(),
    maxBid: MAX,
    leadMs: LEAD,
    fallback: 'early-proxy',
    dryRun: false,
    attempt: {},
    ...over,
  };
}

async function arm(w: Worker, over: Partial<Snipe> = {}, typedConfirmation?: string): Promise<Snipe> {
  return w.ok<Snipe>('snipe.arm', { snipe: armPayload(over), ...(typedConfirmation === undefined ? {} : { typedConfirmation }) });
}

function completedDryRuns(shared: Shared): number {
  return (shared.areas.local.dump()[STORAGE_KEYS.settings] as Settings).snipe.completedDryRuns;
}

function stored(shared: Shared, id = 's1'): Snipe {
  const all = shared.areas.local.dump()[STORAGE_KEYS.snipes] as Record<string, Snipe> | undefined;
  const s = all?.[id];
  if (s === undefined) throw new Error(`no stored snipe ${id}`);
  return s;
}

function audits(shared: Shared): AuditEntry[] {
  return Object.entries(shared.areas.local.dump())
    .filter(([k]) => k.startsWith('sbw:audit:'))
    .flatMap(([, v]) => v as AuditEntry[])
    .sort((a, b) => a.seq - b.seq);
}

function kinds(shared: Shared): string[] {
  return audits(shared).map((a) => a.kind);
}

function transitions(s: Snipe): string[] {
  return s.history.map((h) => `${h.from}>${h.to}`);
}

function wakeAt(): number {
  return END - LEAD - 5 * MIN;
}

beforeEach(() => {
  // The session adapter hashes token ids with crypto.subtle.digest, which settles on a real
  // thread-pool turn; a microtask-only digest keeps fake time deterministic.
  vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation((_alg, data) => {
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    const out = createHash('sha256').update(bytes).digest();
    return Promise.resolve(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
  });
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── Brief: tests first ───────────────────────────────────────────────────────

describe('T-84 brief', () => {
  it('a wake alarm delayed 45 s still fires on time (the margin is 5 min)', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, END + 2 * MIN);

    const s = stored(shared);
    const wake = s.history.find((h) => h.to === 'waking');
    expect(wake?.at).toBeGreaterThanOrEqual(wakeAt() + ALARM_DELAY);
    const fire = s.history.find((h) => h.to === 'firing');
    expect(fire).toBeDefined();
    expect(Math.abs((fire?.at ?? 0) - FIRE_LOCAL)).toBeLessThanOrEqual(5);
    expect(s.fireAt).toBe(FIRE_SERVER);
    expect(Math.abs((s.measured?.firedAt ?? 0) - FIRE_SERVER)).toBeLessThanOrEqual(5);
    // One bid, for the max, and it left after ShowBidModal with >= 1 s on the snipe lane.
    expect(shared.sgw.placeBids).toHaveLength(1);
    expect(shared.sgw.placeBids[0]?.body).toEqual({ itemId: ITEM, bidAmount: '20.00', sellerId: SELLER, quantity: 1 });
    expect(shared.sgw.modals).toHaveLength(1);
    expect(Math.abs((shared.sgw.modals[0] ?? 0) - FIRE_LOCAL)).toBeLessThanOrEqual(5);
    expect((shared.sgw.placeBids[0]?.at ?? 0) - (shared.sgw.modals[0] ?? 0)).toBeGreaterThanOrEqual(1000 + LATENCY);
    expect(s.state).toBe('resolved');
    expect(transitions(s)).toEqual(['draft>armed', 'armed>waking', 'waking>verified', 'verified>firing', 'firing>sent', 'sent>sent', 'sent>resolved']);
  });

  it('a worker restart between wake and fire resumes and fires once', async () => {
    const shared = makeShared();
    const first = await boot(shared);
    await arm(first.w);
    await runTo(shared, wakeAt() + ALARM_DELAY + 25 * SEC);
    expect(stored(shared).state).toBe('waking');
    first.w.kill();

    // The next alarm (the window's recovery alarm, or any other) starts a fresh worker.
    await runTo(shared, wakeAt() + ALARM_DELAY + 26 * SEC);
    await boot(shared);
    await runTo(shared, END + 2 * MIN);

    const s = stored(shared);
    expect(shared.sgw.placeBids).toHaveLength(1);
    expect(s.history.filter((h) => h.to === 'firing')).toHaveLength(1);
    expect(s.history.filter((h) => h.to === 'waking')).toHaveLength(1);
    expect(s.state).toBe('resolved');
    expect(Math.abs((s.measured?.firedAt ?? 0) - FIRE_SERVER)).toBeLessThanOrEqual(5);
  });

  it('a worker restart between verify and fire resumes and fires once', async () => {
    const shared = makeShared();
    const first = await boot(shared);
    await arm(first.w);
    await runTo(shared, END - SKEW - 30 * SEC);
    expect(stored(shared).state).toBe('verified');
    first.w.kill();
    await boot(shared);
    await runTo(shared, END + 2 * MIN);

    const s = stored(shared);
    expect(shared.sgw.placeBids).toHaveLength(1);
    expect(s.history.filter((h) => h.to === 'firing')).toHaveLength(1);
    expect(s.state).toBe('resolved');
  });

  it('a restart after `sent` never sends again', async () => {
    const shared = makeShared();
    const first = await boot(shared);
    await arm(first.w);
    // The worker dies once PlaceBid has left, before its reply.
    await runTo(shared, FIRE_LOCAL + LATENCY + 1000 + 10);
    expect(shared.sgw.placeBids).toHaveLength(1);
    first.w.kill();
    await boot(shared);
    await runTo(shared, END + 10 * MIN);

    const s = stored(shared);
    expect(shared.sgw.placeBids).toHaveLength(1);
    expect(s.state).toBe('resolved');
    // The lost reply makes it ambiguous: the post-read settles it, never a resend.
    expect(s.attempt.ambiguous).toBe(true);
    expect(s.outcomeDetail ?? '').not.toMatch(NO_BID_CLAIM);
  });

  it('KeepAlive ticks at least once per 25 s during the window', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, END + 2 * MIN);

    const s = stored(shared);
    const from = s.history.find((h) => h.to === 'waking')?.at ?? 0;
    const to = s.history.find((h) => h.to === 'resolved')?.at ?? 0;
    expect(to - from).toBeGreaterThan(4 * MIN);
    expect(shared.keepAliveIntervals).toEqual([KEEP_ALIVE_INTERVAL_MS]);
    expect(KEEP_ALIVE_INTERVAL_MS).toBe(20_000);
    const inWindow = shared.pings.filter((t) => t >= from && t <= to);
    expect(inWindow.length).toBeGreaterThanOrEqual(Math.floor((to - from) / 25_000));
    // No gap longer than 25 s between wake and resolution.
    const marks = [from, ...inWindow, to];
    for (let i = 1; i < marks.length; i++) expect((marks[i] ?? 0) - (marks[i - 1] ?? 0)).toBeLessThanOrEqual(25_000);
    // Released afterwards: no more heartbeats.
    const after = shared.pings.filter((t) => t > to + 30 * SEC);
    expect(after).toEqual([]);
  });

  it('a health failure during the window kills the snipe and applies the fallback', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, wakeAt() + ALARM_DELAY + 10 * SEC);
    expect(stored(shared).state).toBe('waking');

    const failing: HealthReport = {
      ok: false,
      checkedAt: shared.clock.now(),
      configVersion: 'test',
      checks: [{ name: 'detail-schema', ok: false, detail: 'drift' }],
    };
    await shared.areas.local.set({ [STORAGE_KEYS.healthReport]: failing });
    await runTo(shared, END + 2 * MIN);

    const s = stored(shared);
    expect(s.state).toBe('killed');
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(shared.sgw.modals).toHaveLength(0);
    // The fallback was decided on the snipe before the kill: early proxy, degraded because writes are blocked.
    const fb = audits(shared).find((a) => a.kind === 'snipe.fallback');
    expect(fb?.details).toMatchObject({ reason: 'anomaly', requested: 'early-proxy', applied: 'skip', degradedBecause: 'writes-blocked' });
    expect(s.outcome).toBe('skipped');
    const disarm = audits(shared).find((a) => a.kind === 'snipe.disarm');
    expect(disarm?.details).toMatchObject({ by: 'anomaly', to: 'killed' });
    expect(String(disarm?.details.why)).toMatch(/health/);
  });

  it('the kill switch mid-window stops the snipe: no bid', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, END - SKEW - 20 * SEC);
    expect(stored(shared).state).toBe('verified');

    const killedAt = shared.clock.now();
    await w.ok('kill.set', { on: true });
    await runTo(shared, END + 2 * MIN);

    const s = stored(shared);
    expect(s.state).toBe('killed');
    expect(s.outcome).toBe('killed');
    // Stopped at once, not at the fire: the window ends with the kill.
    expect(transitions(s).at(-1)).toBe('verified>killed');
    expect((s.history.at(-1)?.at ?? 0) - killedAt).toBeLessThan(SEC);
    expect(shared.pings.filter((t) => t > killedAt + SEC)).toEqual([]);
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(shared.sgw.modals).toHaveLength(0);
    expect(audits(shared).some((a) => a.kind === 'snipe.fallback')).toBe(false);
  });
});

// ── Carries (T-84-carries.md): each fails if its rule is broken ──────────────

const net = (): HttpStep => ({ error: new HttpNetworkError('SGW unreachable'), latencyMs: LATENCY });

const snipesIn = (entries: Record<string, unknown>): Record<string, Snipe> | undefined =>
  entries[STORAGE_KEYS.snipes] as Record<string, Snipe> | undefined;

/** Crash right after the write that stores s1 in `state` (for `sent`: before any reply). */
function crashOn(state: Snipe['state']): CrashPredicate {
  return (area, entries) => {
    const s = snipesIn(entries)?.s1;
    if (area !== 'local' || s?.state !== state) return false;
    return state !== 'sent' || (s.attempt.reply === undefined && s.attempt.ambiguous !== true);
  };
}

interface RunnerRecordView {
  entries: Record<string, { outbox: Array<{ kind: string }>; atRisk?: string } | undefined>;
}

function runnerRecord(shared: Shared): RunnerRecordView {
  return shared.areas.local.dump()[RUNNER_KEY] as RunnerRecordView;
}

/**
 * T-84c: the runner's PRIVATE commit, reached only from this test file (the CAS
 * race, the R4 property's internal events). Production has no such way in:
 * `dispatch` takes only disarm and arm, `endedEarly` only T-103's two ended
 * events. Same as the runner's own internal commits: no allow-list, then a drive.
 */
async function feedInternal(runner: SnipeRunner, id: string, e: SnipeEvent, expectVersion?: number): Promise<CommitResult> {
  const internals = runner as unknown as { commit(id: string, e: SnipeEvent, opts: { expectVersion?: number }): Promise<CommitResult> };
  const r = await internals.commit(id, e, expectVersion === undefined ? {} : { expectVersion });
  if (r.kind === 'accepted') void runner.drive(id);
  return r;
}

function probe(register: (ctx: BackgroundContext) => void): Record<string, BackgroundModule> {
  return { './zz-probe.ts': { register } };
}

describe('money safety carries', () => {
  it('persist before send: PlaceBid leaves only after `sent` and its key are stored', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, END + 2 * MIN);
    const seen = shared.sgw.placeBids[0];
    expect(seen?.stored?.state).toBe('sent');
    expect(seen?.stored?.attempt.idempotencyKey).toMatch(/^s1:/);
    expect(seen?.stored?.attempt.sentAt).toBeDefined();
    expect(stored(shared).attempt.idempotencyKey).toBe(seen?.stored?.attempt.idempotencyKey);
  });

  it('persist before send: a crash between storing `sent` and the send sends nothing, then or after the restart', async () => {
    const shared = makeShared();
    const first = await boot(shared, { crashAfterSet: crashOn('sent') });
    await arm(first.w);
    await runTo(shared, FIRE_LOCAL + 5 * SEC);
    expect(first.w.life.dead).toBe(true);
    expect(stored(shared).state).toBe('sent');
    expect(stored(shared).attempt.idempotencyKey).toMatch(/^s1:/);
    expect(shared.sgw.modals).toHaveLength(0);
    expect(shared.sgw.placeBids).toHaveLength(0);

    await boot(shared);
    await runTo(shared, END + 10 * MIN);
    const s = stored(shared);
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(shared.sgw.modals).toHaveLength(0);
    expect(s.state).toBe('resolved');
    expect(s.attempt.ambiguous).toBe(true);
    expect(s.history.filter((h) => h.to === 'sent' && h.from !== 'sent')).toHaveLength(1);
    expect(s.outcomeDetail ?? '').not.toMatch(NO_BID_CLAIM);
  });

  it('compare-and-set: two contexts reducing the same version apply one event; the loser re-reduces and is refused', async () => {
    const shared = makeShared({ alarmDelayMs: 0 });
    const { w, ctx } = await boot(shared);
    await arm(w);
    await runTo(shared, wakeAt() - 30 * SEC);
    const runner = getSnipeRunner(ctx);
    if (runner === undefined) throw new Error('no runner');
    const v = stored(shared).history.length;
    const now = shared.clock.now();
    // The internal path (T-84c): outside dispatch refuses everything but disarm (and arm).
    const [a, b] = await Promise.all([feedInternal(runner, 's1', { type: 'wake', now }, v), feedInternal(runner, 's1', { type: 'wake', now }, v)]);
    expect([a.kind, b.kind].sort()).toEqual(['accepted', 'rejected']);
    const lost = a.kind === 'rejected' ? a : b;
    expect(lost.kind === 'rejected' ? lost.rejection.reason : '').toBe('step-passed');
    expect(runner.stats.casLost).toBe(1);

    await runTo(shared, END + 2 * MIN);
    const s = stored(shared);
    expect(s.history.filter((h) => h.to === 'waking')).toHaveLength(1);
    expect(s.history.filter((h) => h.to === 'firing')).toHaveLength(1);
    expect(shared.sgw.placeBids).toHaveLength(1);
  });

  it('compare-and-set: duplicate and concurrent alarms at the wake start one window and send one bid', async () => {
    const shared = makeShared({ alarmDelayMs: 0 });
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, wakeAt() - 1);
    shared.clock.advance(1); // the real wake alarm fires...
    w.deliverAlarm(snipeAlarmName('s1', 'wake')); // ...and is delivered again, twice,
    w.deliverAlarm(snipeAlarmName('s1', 'wake'));
    w.deliverAlarm(snipeAlarmName('s1', 'recover')); // with a recovery alarm and the preflight alarm
    w.deliverAlarm(snipeAlarmName('s1', 'preflight'));
    await runTo(shared, END + 2 * MIN);

    const s = stored(shared);
    expect(s.history.filter((h) => h.to === 'waking')).toHaveLength(1);
    expect(s.history.filter((h) => h.to === 'firing')).toHaveLength(1);
    expect(shared.sgw.placeBids).toHaveLength(1);
    // Three wake samples and one verify: no duplicated window reads.
    expect(shared.sgw.details.filter((d) => d.auth && d.at < FIRE_LOCAL)).toHaveLength(4);
  });

  it('effects outbox: a crash after `fire` is stored replays the bid exactly once through `sent`', async () => {
    const shared = makeShared();
    const first = await boot(shared, { crashAfterSet: crashOn('firing') });
    await arm(first.w);
    await runTo(shared, FIRE_LOCAL + 100);
    expect(first.w.life.dead).toBe(true);
    expect(stored(shared).state).toBe('firing');
    expect(runnerRecord(shared).entries.s1?.outbox.map((e) => e.kind)).toEqual(['placeBid', 'audit']);
    expect(shared.sgw.placeBids).toHaveLength(0);

    await boot(shared);
    await runTo(shared, END + 2 * MIN);
    const s = stored(shared);
    expect(shared.sgw.placeBids).toHaveLength(1);
    expect(shared.sgw.placeBids[0]?.stored?.state).toBe('sent');
    expect(s.state).toBe('resolved');
    expect(kinds(shared).filter((k) => k === 'bid.fire')).toHaveLength(1);
    expect(kinds(shared).filter((k) => k === 'bid.sent')).toHaveLength(1);
    expect(runnerRecord(shared).entries.s1).toBeUndefined();
  });

  it('effects outbox: a stale money effect replayed after `sent` is refused (already-sent) and dropped', async () => {
    const shared = makeShared();
    const first = await boot(shared);
    await arm(first.w);
    await runTo(shared, FIRE_LOCAL + LATENCY + 1000 + 10);
    expect(shared.sgw.placeBids).toHaveLength(1);
    first.w.kill();
    // A replay: the money effect shows up again in the outbox of the sent snipe.
    const rec = runnerRecord(shared);
    const entry = rec.entries.s1;
    if (entry === undefined) throw new Error('no runner entry');
    entry.outbox.unshift({ kind: 'placeBid', snipeId: 's1', amount: MAX } as unknown as { kind: string });
    shared.areas.local.seed({ [RUNNER_KEY]: rec });

    await boot(shared);
    await runTo(shared, END + 10 * MIN);
    expect(shared.sgw.placeBids).toHaveLength(1);
    expect(shared.sgw.modals).toHaveLength(1);
    expect(stored(shared).state).toBe('resolved');
    expect(runnerRecord(shared).entries.s1).toBeUndefined();
  });

  it('effects outbox: notifications and audit entries pending at a crash are delivered after the restart', async () => {
    const shared = makeShared();
    // Crash right after the post-read resolves the snipe: its outcome notice is still in the outbox.
    const first = await boot(shared, { crashAfterSet: crashOn('resolved') });
    await arm(first.w);
    await runTo(shared, END + 2 * MIN);
    expect(first.w.life.dead).toBe(true);
    expect(stored(shared).state).toBe('resolved');
    const before = shared.notifier.sent.length;
    expect(kinds(shared)).not.toContain('snipe.post-read');

    await boot(shared);
    await runTo(shared, END + 3 * MIN);
    expect(kinds(shared).filter((k) => k === 'snipe.post-read')).toHaveLength(1);
    expect(shared.notifier.sent.length).toBe(before + 1);
    expect(runnerRecord(shared).entries.s1).toBeUndefined();
  });

  it('a `sent` snipe always exits: bounded outcome reads, then Unconfirmed (never "Not bid"), and a later read settles it', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, FIRE_LOCAL + 3 * SEC);
    expect(stored(shared).state).toBe('sent');
    shared.sgw.detailDown = net();
    const readsBefore = shared.sgw.details.length;

    await runTo(shared, END + 45 * MIN);
    expect(stored(shared).state).toBe('sent');
    // Exactly the fast attempts, over at most 30 min.
    const reads = shared.sgw.details.slice(readsBefore);
    expect(POST_READ_FAST_ATTEMPTS).toBe(3);
    expect(reads).toHaveLength(POST_READ_FAST_ATTEMPTS);
    expect((reads[2]?.at ?? 0) - (reads[0]?.at ?? 0)).toBeLessThanOrEqual(30 * MIN);
    const notice = shared.notifier.sent.find((n) => n.notification.title.startsWith('Unconfirmed'));
    expect(notice?.notification.message).toMatch(/check the item/i);
    expect(notice?.notification.message).not.toMatch(NO_BID_CLAIM);
    expect(kinds(shared)).toContain('snipe.unconfirmed');
    // The window is released while it waits: no heartbeats, no recovery alarm.
    expect(shared.pings.filter((t) => t > END + 10 * MIN)).toEqual([]);
    const names = (await shared.alarms.getAll()).map((a) => a.name);
    expect(names).toContain(snipeAlarmName('s1', 'postread'));
    expect(names).not.toContain(snipeAlarmName('s1', 'recover'));
    expect(shared.sgw.placeBids).toHaveLength(1);

    shared.sgw.detailDown = undefined;
    await runTo(shared, END + 8 * HOUR);
    expect(stored(shared).state).toBe('resolved');
    expect(shared.sgw.placeBids).toHaveLength(1);
    expect(await snipeAlarms(shared)).toEqual([]);
  });

  it('fallbackDecision comes before the kill: an anomaly in the window places the early proxy once, through `sent`', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, wakeAt() + ALARM_DELAY - SEC);
    expect(stored(shared).state).toBe('armed');
    shared.sgw.detailFaults.push(net(), net(), net());
    await runTo(shared, END + 10 * MIN);

    const s = stored(shared);
    expect(transitions(s).slice(0, 4)).toEqual(['draft>armed', 'armed>waking', 'waking>fallback-applied', 'fallback-applied>sent']);
    expect(s.state).toBe('resolved');
    const k = kinds(shared);
    expect(k.indexOf('snipe.fallback')).toBeGreaterThan(-1);
    expect(k.indexOf('snipe.fallback')).toBeLessThan(k.indexOf('snipe.disarm'));
    const fb = audits(shared).find((a) => a.kind === 'snipe.fallback');
    expect(fb?.details).toMatchObject({ reason: 'anomaly', requested: 'early-proxy', applied: 'early-proxy', amount: MAX });
    expect(String(audits(shared).find((a) => a.kind === 'snipe.disarm')?.details.why)).toMatch(/repeated errors/);
    expect(shared.sgw.placeBids).toHaveLength(1);
    expect(shared.sgw.placeBids[0]?.body.bidAmount).toBe('20.00');
    expect(shared.sgw.placeBids[0]?.stored?.state).toBe('sent');
  });

  it('the kill switch while an early proxy waits: nothing is sent and the snipe is closed', async () => {
    const shared = makeShared();
    const first = await boot(shared, { crashAfterSet: crashOn('fallback-applied') });
    await arm(first.w);
    await runTo(shared, wakeAt() + ALARM_DELAY - SEC);
    shared.sgw.detailFaults.push(net(), net(), net());
    await runTo(shared, wakeAt() + ALARM_DELAY + 50 * SEC);
    expect(first.w.life.dead).toBe(true);
    expect(stored(shared).state).toBe('fallback-applied');
    // The user hits the kill switch before the restart.
    const settings = shared.areas.local.dump()[STORAGE_KEYS.settings] as Settings;
    shared.areas.local.seed({ [STORAGE_KEYS.settings]: { ...settings, killSwitch: true } });

    await boot(shared);
    await runTo(shared, END + 2 * MIN);
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(shared.sgw.modals).toHaveLength(0);
    expect(stored(shared).state).toBe('killed');
    expect(String(audits(shared).find((a) => a.kind === 'bid.not-sent')?.details.why)).toMatch(/kill switch/);
  });

  it('a restart after the fire moment with the bid unsent sends nothing and closes the snipe', async () => {
    const shared = makeShared();
    const first = await boot(shared, { crashAfterSet: crashOn('firing') });
    await arm(first.w);
    await runTo(shared, FIRE_LOCAL + 100);
    expect(first.w.life.dead).toBe(true);
    await runTo(shared, END + 30 * SEC);

    await boot(shared);
    await runTo(shared, END + 2 * MIN);
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(shared.sgw.modals).toHaveLength(0);
    expect(stored(shared).state).toBe('killed');
    expect(String(audits(shared).find((a) => a.kind === 'bid.not-sent')?.details.why)).toMatch(/too late/);
  });

  it('PlaceBid contract: a rejection that may have reached SGW is ambiguous, read first, never resent', async () => {
    const shared = makeShared();
    shared.sgw.placeBidStep = { status: 503 };
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, END + 10 * MIN);
    const s = stored(shared);
    expect(shared.sgw.placeBids).toHaveLength(1);
    expect(s.attempt.ambiguous).toBe(true);
    expect(s.attempt.notSent).not.toBe(true);
    expect(s.state).toBe('resolved');
    expect(s.outcomeDetail ?? '').not.toMatch(NO_BID_CLAIM);
    // Never a "No bid was sent" notification when PlaceBid may have left.
    expect(shared.notifier.sent.some((n) => n.notification.title.startsWith('Not bid'))).toBe(false);
    expect(shared.notifier.sent.some((n) => /No bid was sent/i.test(n.notification.message))).toBe(false);
    expect(shared.http.requests.filter((r) => r.url.startsWith(PLACE_URL))).toHaveLength(1);
    expect(kinds(shared)).toContain('bid.ambiguous');
    expect(kinds(shared)).not.toContain('bid.not-sent');
  });

  it('PlaceBid contract: a provably unsent bid (ShowBidModal failed) resolves as not-sent: one send attempt, zero PlaceBid on the wire', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, FIRE_LOCAL - 10);
    // Break ShowBidModal: bid.ts throws BidNotSentError, so nothing was ever sent.
    shared.http.on(MODAL_URL, { status: 500, latencyMs: LATENCY });
    await runTo(shared, END + 10 * MIN);
    expect(shared.sgw.placeBids).toHaveLength(0);
    // ShowBidModal's 500 is a BidNotSentError, so the idempotent strategy retries
    // once. That 500 puts the snipe lane in backoff, and the retry's ShowBidModal
    // is refused before a request is built. One modal read on the wire, no PlaceBid.
    expect(shared.http.requests.filter((r) => r.url.startsWith(MODAL_URL))).toHaveLength(1);
    expect(shared.http.requests.filter((r) => r.url.startsWith(PLACE_URL))).toHaveLength(0);
    const s = stored(shared);
    expect(s.state).toBe('resolved');
    expect(s.attempt.notSent).toBe(true);
    expect(s.attempt.ambiguous).not.toBe(true);
    expect(s.outcome).toBe('network');
    expect(s.outcomeDetail ?? '').toMatch(/provably never went out/);
    expect(kinds(shared).filter((k) => k === 'bid.sent')).toHaveLength(1);
    expect(kinds(shared)).not.toContain('bid.ambiguous');
    expect(kinds(shared)).not.toContain('snipe.post-read');
    const notSent = audits(shared).find((a) => a.kind === 'bid.not-sent');
    expect(notSent?.details).toMatchObject({ event: 'not-sent', from: 'sent', to: 'resolved' });
    expect(String(notSent?.details.reason).length).toBeGreaterThan(0);
    const notice = shared.notifier.sent.find((n) => n.notification.title.startsWith('Not bid'));
    expect(notice?.notification.message).toMatch(NO_BID_CLAIM);
  });
});

describe('money path edges (final check)', () => {
  it('persist before send: with a slow storage write, ShowBidModal and PlaceBid wait until `sent` is stored', async () => {
    const shared = makeShared();
    const { w } = await boot(shared, { slowSet: (area, entries) => (crashOn('sent')(area, entries) ? 3 * SEC : 0) });
    await arm(w);
    await runTo(shared, FIRE_LOCAL + 2 * SEC);
    // The `sent` write has not landed yet: nothing has left.
    expect(stored(shared).state).toBe('firing');
    expect(shared.sgw.modals).toHaveLength(0);
    expect(shared.sgw.placeBids).toHaveLength(0);

    await runTo(shared, END + 2 * MIN);
    expect(shared.sgw.modals[0]).toBeGreaterThanOrEqual(FIRE_LOCAL + 3 * SEC);
    expect(shared.sgw.placeBids).toHaveLength(1);
    expect(shared.sgw.placeBids[0]?.stored?.state).toBe('sent');
    expect(shared.sgw.placeBids[0]?.stored?.attempt.idempotencyKey).toMatch(/^s1:/);
    expect(stored(shared).state).toBe('resolved');
  });

  it('a `sent` write that is stored but reports a failure sends nothing, and the snipe still exits through the outcome read', async () => {
    const shared = makeShared();
    let armed = true;
    const { w } = await boot(shared, {
      failAfterSet: (area, entries) => {
        if (!armed || !crashOn('sent')(area, entries)) return false;
        armed = false;
        return true;
      },
    });
    await arm(w);
    await runTo(shared, FIRE_LOCAL + 5 * SEC);
    expect(w.life.dead).toBe(false);
    expect(stored(shared).state).toBe('sent');
    // The write's outcome is unknown to the runner: it never sends on it.
    expect(shared.sgw.modals).toHaveLength(0);
    expect(shared.sgw.placeBids).toHaveLength(0);

    // Same worker: the stored `sent` with no reply is ambiguous, read, and settled. It never stays `sent`.
    await runTo(shared, END + 10 * MIN);
    const s = stored(shared);
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(s.state).toBe('resolved');
    expect(s.attempt.ambiguous).toBe(true);
    expect(s.history.filter((h) => h.to === 'sent' && h.from !== 'sent')).toHaveLength(1);
  });

  it('a money effect whose amount is not the snipe max is never sent: the amount comes only from Snipe.maxBid', async () => {
    const shared = makeShared();
    const first = await boot(shared, { crashAfterSet: crashOn('firing') });
    await arm(first.w);
    await runTo(shared, FIRE_LOCAL + 100);
    expect(first.w.life.dead).toBe(true);
    const rec = runnerRecord(shared);
    const entry = rec.entries.s1;
    if (entry === undefined) throw new Error('no runner entry');
    entry.outbox = entry.outbox.map((e) => (e.kind === 'placeBid' ? { ...e, amount: MAX * 10 } : e));
    shared.areas.local.seed({ [RUNNER_KEY]: rec });

    await boot(shared);
    await runTo(shared, END + 2 * MIN);
    expect(shared.sgw.modals).toHaveLength(0);
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(stored(shared).state).toBe('killed');
    expect(String(audits(shared).find((a) => a.kind === 'bid.not-sent')?.details.why)).toMatch(/amount/);
  });

  it('the kill switch during a window read stops the snipe at once, without waiting for the read', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    const verifyAt = END - SKEW - 60 * SEC;
    await runTo(shared, verifyAt - 10);
    expect(stored(shared).state).toBe('waking');
    shared.sgw.detailFaults.push({ hang: true });
    await runTo(shared, verifyAt + 100);
    expect(shared.sgw.details.at(-1)?.at).toBeGreaterThanOrEqual(verifyAt);
    expect(stored(shared).state).toBe('waking');

    const killedAt = shared.clock.now();
    await w.ok('kill.set', { on: true });
    await flush();
    const s = stored(shared);
    expect(transitions(s).at(-1)).toBe('waking>killed');
    expect((s.history.at(-1)?.at ?? 0) - killedAt).toBeLessThan(SEC);
    expect(s.history.at(-1)?.why).toBe('disarm:kill');

    await runTo(shared, END + 2 * MIN);
    expect(stored(shared).state).toBe('killed');
    expect(audits(shared).find((a) => a.kind === 'snipe.disarm')?.details).toMatchObject({ by: 'kill' });
    expect(shared.sgw.modals).toHaveLength(0);
    expect(shared.sgw.placeBids).toHaveLength(0);
  });

  it('a health failure during a window read that then succeeds still stops the snipe before the fire', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    const verifyAt = END - SKEW - 60 * SEC;
    await runTo(shared, verifyAt - 10);
    expect(stored(shared).state).toBe('waking');
    shared.sgw.latency = 1500; // a slow but usable verify read (under the 2 s latency bound)
    await runTo(shared, verifyAt + 500);
    expect(stored(shared).state).toBe('waking');
    await shared.areas.local.set({
      [STORAGE_KEYS.healthReport]: { ok: false, checkedAt: shared.clock.now(), configVersion: 'test', checks: [{ name: 'detail-schema', ok: false, detail: 'drift' }] },
    });
    await runTo(shared, verifyAt + 3 * SEC);
    shared.sgw.latency = LATENCY;
    await runTo(shared, END + 2 * MIN);

    const s = stored(shared);
    expect(s.state).toBe('killed');
    expect(s.history.some((h) => h.to === 'firing')).toBe(false);
    expect(shared.sgw.modals).toHaveLength(0);
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(String(audits(shared).find((a) => a.kind === 'snipe.disarm')?.details.why)).toMatch(/health/);
  });

  it('the kill switch between ShowBidModal and PlaceBid: nothing on the wire, and the proven-unsent bid resolves, never killed', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, FIRE_LOCAL + 600);
    expect(stored(shared).state).toBe('sent');
    expect(shared.sgw.modals).toHaveLength(1);
    expect(shared.sgw.placeBids).toHaveLength(0);

    await w.ok('kill.set', { on: true });
    await runTo(shared, END + 10 * MIN);
    const s = stored(shared);
    expect(shared.sgw.placeBids).toHaveLength(0);
    // The write gate throws before http.send, so no PlaceBid byte is on the wire.
    expect(shared.http.requests.filter((r) => r.url.startsWith(PLACE_URL))).toHaveLength(0);
    expect(s.state).toBe('resolved');
    // The write gate refused before any byte left: bid.ts proved it, so the
    // snipe resolves through `not-sent` instead of a read.
    expect(s.attempt.notSent).toBe(true);
    expect(s.attempt.ambiguous).not.toBe(true);
    expect(s.history.some((h) => h.to === 'killed')).toBe(false);
    expect(kinds(shared)).not.toContain('snipe.post-read');
    const notSent = audits(shared).find((a) => a.kind === 'bid.not-sent');
    expect(notSent?.details).toMatchObject({ event: 'not-sent', from: 'sent', to: 'resolved' });
    expect(String(notSent?.details.reason)).toBe('kill switch is on');
    const notice = shared.notifier.sent.find((n) => n.notification.title.startsWith('Not bid'));
    expect(notice?.notification.message).toMatch(/No bid was sent \(kill switch is on\)/);
    expect(notice?.notification.message).not.toMatch(/may have been placed/i);
  });
});

describe('dry run (C4)', () => {
  it('dry run: the audit entry and one harmless itemDetail read at fire time, zero ShowBidModal or PlaceBid', async () => {
    const shared = makeShared({ settings: settingsWith() });
    const done: Snipe[] = [];
    const { w } = await boot(shared, {
      jobModules: probe((ctx) => {
        snipeSeams(ctx).onDryRunComplete((s) => done.push(s));
      }),
    });
    const armed = await arm(w, { dryRun: false });
    expect(armed.dryRun).toBe(true); // the global bidding dry run makes every snipe a dry run
    await runTo(shared, END + 2 * MIN);

    const s = stored(shared);
    expect(s.state).toBe('resolved');
    expect(s.outcome).toBe('dry-run');
    expect(shared.sgw.modals).toHaveLength(0);
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(kinds(shared)).toContain('bid.dry-run');
    expect(kinds(shared)).not.toContain('bid.sent');
    expect(shared.sgw.details.filter((d) => d.auth && Math.abs(d.at - FIRE_LOCAL) <= 5)).toHaveLength(1);
    expect(Math.abs((s.measured?.firedAt ?? 0) - FIRE_SERVER)).toBeLessThanOrEqual(5);
    expect(s.measured?.responseAt).toBeDefined();
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ id: 's1', outcome: 'dry-run' });
    await flush(8);
    expect(completedDryRuns(shared)).toBe(1);
  });

  it('a completed dry run increments completedDryRuns once, and a restart does not count it again', async () => {
    const shared = makeShared({ settings: settingsWith() });
    const first = await boot(shared);
    await arm(first.w);
    await runTo(shared, END + 2 * MIN);
    await flush(8);
    expect(stored(shared)).toMatchObject({ state: 'resolved', outcome: 'dry-run', dryRun: true });
    expect(completedDryRuns(shared)).toBe(1);

    first.w.kill();
    await boot(shared);
    await runTo(shared, END + 4 * MIN);
    await flush(8);
    expect(completedDryRuns(shared)).toBe(1);
  });

  it('a killed dry run does not increment completedDryRuns', async () => {
    const shared = makeShared({ settings: settingsWith() });
    const { w } = await boot(shared);
    await arm(w);
    await w.ok('snipe.disarm', { id: 's1' });
    await runTo(shared, END + 2 * MIN);
    await flush(8);
    expect(stored(shared)).toMatchObject({ state: 'killed', dryRun: true });
    expect(completedDryRuns(shared)).toBe(0);
  });

  it('a live snipe does not increment completedDryRuns', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, END + 2 * MIN);
    await flush(8);
    expect(stored(shared).dryRun).toBe(false);
    expect(stored(shared).state).toBe('resolved');
    expect(completedDryRuns(shared)).toBe(0);
  });

  it('dry run: a pending placeBid schema failure is the live health verdict, so the fallback is not "would have placed"', async () => {
    const shared = makeShared({ settings: settingsWith() });
    const { w, ctx } = await boot(shared);
    await arm(w);
    await runTo(shared, wakeAt() + ALARM_DELAY + 10 * SEC);
    expect(stored(shared)).toMatchObject({ state: 'waking', dryRun: true });
    ctx.switches.flagSchemaFailure({ endpoint: 'placeBid', message: 'drift', at: shared.clock.now() });
    shared.sgw.detailFaults.push(net(), net(), net());
    await runTo(shared, END + 2 * MIN);

    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(shared.sgw.modals).toHaveLength(0);
    const fb = audits(shared).find((a) => a.kind === 'snipe.fallback');
    expect(fb?.details).toMatchObject({ writesAllowed: false, degradedBecause: 'writes-blocked', applied: 'skip' });
    const said = shared.notifier.sent.map((n) => n.notification.message).join('\n');
    expect(said).not.toMatch(/would have placed/i);
  });

  it('dry run: a favorites-only pending schema failure still counts bidding writes as allowed', async () => {
    const shared = makeShared({ settings: settingsWith() });
    const { w, ctx } = await boot(shared);
    await arm(w);
    await runTo(shared, wakeAt() + ALARM_DELAY + 10 * SEC);
    ctx.switches.flagSchemaFailure({ endpoint: 'addFavorite', message: 'drift', at: shared.clock.now() });
    shared.sgw.detailFaults.push(net(), net(), net());
    await runTo(shared, END + 2 * MIN);

    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(shared.sgw.modals).toHaveLength(0);
    const fb = audits(shared).find((a) => a.kind === 'snipe.fallback');
    expect(fb?.details).toMatchObject({ writesAllowed: true, applied: 'early-proxy' });
    expect(shared.notifier.sent.find((n) => n.notification.title.startsWith('Dry run'))?.notification.message).toMatch(/would have placed/);
  });

  it('an invalid sbw:snipeRunner fails closed: a stored firing bid is not replayed', async () => {
    const shared = makeShared();
    const first = await boot(shared, { crashAfterSet: crashOn('firing') });
    await arm(first.w);
    await runTo(shared, FIRE_LOCAL + 100);
    expect(stored(shared).state).toBe('firing');
    expect(runnerRecord(shared).entries.s1?.outbox.map((e) => e.kind)).toContain('placeBid');
    shared.areas.local.seed({ [RUNNER_KEY]: { version: 1, entries: { s1: { outbox: 'not-an-array' } } } });

    await boot(shared);
    await runTo(shared, END + 2 * MIN);
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(shared.sgw.modals).toHaveLength(0);
    expect(stored(shared).state).toBe('killed');
  });

  it('dry run: a fallback is decided with writesAllowed ignoring the dry run ("would have placed"), and sends nothing', async () => {
    const shared = makeShared({ settings: settingsWith() });
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, wakeAt() + ALARM_DELAY - SEC);
    shared.sgw.detailFaults.push(net(), net(), net());
    await runTo(shared, END + 2 * MIN);

    const s = stored(shared);
    expect(s.outcome).toBe('dry-run');
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(shared.sgw.modals).toHaveLength(0);
    const fb = audits(shared).find((a) => a.kind === 'snipe.fallback');
    expect(fb?.details).toMatchObject({ applied: 'early-proxy', writesAllowed: true });
    expect(fb?.dryRun).toBe(true);
    const notice = shared.notifier.sent.find((n) => n.notification.title.startsWith('Dry run'));
    expect(notice?.notification.message).toMatch(/would have placed your max \$20\.00/);
  });

  it('dry run: the kill switch still stops it', async () => {
    const shared = makeShared({ settings: settingsWith() });
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, END - SKEW - 20 * SEC);
    await w.ok('kill.set', { on: true });
    const reads = shared.sgw.details.length;
    await runTo(shared, END + 2 * MIN);
    expect(stored(shared).state).toBe('killed');
    expect(shared.sgw.details).toHaveLength(reads);
  });
});

describe('lanes, preflight and health alarms', () => {
  it('health alarms call AuthHealth with no SGW request; a failure marks the snipe at risk and alerts, without a disarm', async () => {
    const shared = makeShared();
    const calls: string[] = [];
    const { w } = await boot(shared, {
      jobModules: probe((ctx) => {
        snipeSeams(ctx).setAuthHealth({
          check: (_s, which) => {
            calls.push(which);
            return Promise.resolve({ ok: false, reason: 'session-expiring', detail: 'Your ShopGoodwill login runs out before the auction ends.' });
          },
        });
      }),
    });
    await arm(w);
    const requests = shared.http.requests.length;
    await runTo(shared, END - HOUR + ALARM_DELAY + SEC);
    expect(calls).toEqual(['1h']);
    expect(shared.http.requests.length).toBe(requests);
    expect(stored(shared).state).toBe('armed');
    expect(kinds(shared)).toContain('snipe.at-risk');
    expect(shared.notifier.sent.some((n) => n.notification.title.startsWith('Snipe at risk'))).toBe(true);

    await runTo(shared, END + 2 * MIN);
    expect(stored(shared).state).toBe('resolved');
    expect(shared.sgw.placeBids).toHaveLength(1);
  });

  it('lanes: the preflight reads on lane background (anonymous), the snipe lane is used only from the wake', async () => {
    const shared = makeShared();
    const { w, ctx } = await boot(shared);
    await arm(w);
    await runTo(shared, END - 15 * MIN + ALARM_DELAY + 30 * SEC);
    expect(kinds(shared)).toContain('snipe.preflight');
    expect(ctx.scheduler.stats().lanes.background.usedToday).toBe(1);
    expect(ctx.scheduler.stats().lanes.snipe.usedToday).toBe(0);
    const preflightRead = shared.sgw.details.find((d) => d.at >= END - 15 * MIN);
    expect(preflightRead?.auth).toBe(false);
    expect(shared.notifier.sent.some((n) => n.notification.title.startsWith('Snipe soon'))).toBe(true);

    await runTo(shared, END + 2 * MIN);
    const wake = stored(shared).history.find((h) => h.to === 'waking')?.at ?? Infinity;
    const snipeLane = shared.sgw.details.filter((d) => d.auth);
    expect(snipeLane.length).toBeGreaterThan(0);
    for (const d of snipeLane) expect(d.at).toBeGreaterThanOrEqual(wake);
  });

  it('a preflight that is not due (the end moved later) re-schedules the :preflight alarm; the wake then reports extended', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    shared.sgw.item.endMs = END + 30 * MIN;
    await runTo(shared, END - 15 * MIN + ALARM_DELAY + 5 * SEC);
    const pre = (await shared.alarms.getAll()).find((a) => a.name === snipeAlarmName('s1', 'preflight'));
    expect(pre?.scheduledTime).toBe(END + 30 * MIN - 15 * MIN - SKEW);
    expect(kinds(shared)).not.toContain('snipe.preflight');
    expect(stored(shared).state).toBe('armed');

    await runTo(shared, END + 2 * MIN);
    const s = stored(shared);
    expect(s.outcome).toBe('extended');
    expect(kinds(shared)).toContain('snipe.rearm-proposed');
    expect(shared.sgw.placeBids).toHaveLength(0);
    // Never re-armed automatically.
    expect(Object.keys(shared.areas.local.dump()[STORAGE_KEYS.snipes] as object)).toEqual(['s1']);
  });

  it('a failed preflight goes to the reducer (its fallback), never preflight()s own effects', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    // Signed out before T-15 min.
    await shared.areas.local.remove([STORAGE_KEYS.sgwSession]);
    await runTo(shared, END + 2 * MIN);
    const s = stored(shared);
    expect(transitions(s)).toEqual(['draft>armed', 'armed>resolved']);
    expect(s.outcome).toBe('skipped');
    expect(kinds(shared)).toContain('snipe.preflight-failed');
    expect(kinds(shared)).not.toContain('snipe.preflight');
    const fb = audits(shared).find((a) => a.kind === 'snipe.fallback');
    expect(fb?.details).toMatchObject({ reason: 'auth', applied: 'skip', degradedBecause: 'auth' });
    expect(shared.sgw.placeBids).toHaveLength(0);
  });

  it('reconcile re-creates the alarms of an armed snipe after a browser restart lost them', async () => {
    const shared = makeShared();
    const first = await boot(shared);
    await arm(first.w);
    await runTo(shared, T0 + 10 * MIN);
    first.w.kill();
    for (const a of await shared.alarms.getAll()) await shared.alarms.clear(a.name);

    await boot(shared);
    const names = (await snipeAlarms(shared)).map((a) => a.name).sort();
    expect(names).toEqual([snipeAlarmName('s1', 'health1'), snipeAlarmName('s1', 'preflight'), snipeAlarmName('s1', 'wake')].sort());
    await runTo(shared, END + 2 * MIN);
    expect(stored(shared).state).toBe('resolved');
    expect(shared.sgw.placeBids).toHaveLength(1);
  });

  it('KeepAwake (tier T1, power granted) is held from arm to the end, and the preflight sees it held', async () => {
    const shared = makeShared({ settings: settingsWith({ live: true, tier: 'T1' }) });
    await shared.permissions.request({ permissions: ['power'] });
    const { w } = await boot(shared);
    // T-111c: the startup releases a possible leftover first (nothing needed it); counted from here.
    const atBoot = shared.keepAwake.releases;
    await arm(w);
    await flush();
    expect(shared.keepAwake.isHeld).toBe(true);
    await runTo(shared, END + 2 * MIN);
    expect(kinds(shared)).toContain('snipe.preflight');
    expect(shared.keepAwake.isHeld).toBe(false);
    expect(shared.keepAwake.releases - atBoot).toBe(1);
  });

  it('KeepAwake is not touched below tier T1', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, END + 2 * MIN);
    expect(shared.keepAwake.holds).toEqual([]);
  });

  // T-111b: the companion is not under test here (companion.test.ts covers it); without a profile its
  // preflight hook would fail the snipe as keep-awake before the wake.
  const noCompanion = (): Record<string, BackgroundModule> => ({ './companion-sync.ts': { register: () => undefined } });

  /** T-111's companion wake: the runner's T-5 min wake minus the margin (about T-8 min). */
  const companionWake = (): number => wakeAt() - COMPANION_WAKE_MARGIN_MS;

  it('KeepAwake under tier T2 (power granted) is held from the companion wake (T-8 min) to the end; the preflight sees it not required', async () => {
    const shared = makeShared({ settings: settingsWith({ live: true, tier: 'T2' }) });
    await shared.permissions.request({ permissions: ['power'] });
    // The stored state each time the runner takes the hold.
    const heldIn: string[] = [];
    const hold = shared.keepAwake.hold.bind(shared.keepAwake);
    vi.spyOn(shared.keepAwake, 'hold').mockImplementation((reason) => {
      heldIn.push(stored(shared).state);
      return hold(reason);
    });
    const { w } = await boot(shared, { jobModules: noCompanion() });
    // T-111c: the startup releases a possible leftover first (nothing needed it); counted from here.
    const atBoot = shared.keepAwake.releases;
    await arm(w);
    await flush();
    // Not at arm: a hold from arm would keep the computer from sleeping at all.
    expect(shared.keepAwake.holds).toEqual([]);
    // Nor through the T-15 min preflight (it passes, keep-awake not required), up to the companion wake.
    await runTo(shared, companionWake() - 5 * SEC);
    expect(stored(shared).state).toBe('armed');
    expect(kinds(shared)).toContain('snipe.preflight');
    expect(kinds(shared)).not.toContain('snipe.preflight-failed');
    expect(shared.keepAwake.holds).toEqual([]);
    // The companion wake takes it, the snipe still armed (this browser kept running: its alarm drives the step).
    await runTo(shared, companionWake() + ALARM_DELAY + 5 * SEC);
    expect(stored(shared).state).toBe('armed');
    expect(shared.keepAwake.isHeld).toBe(true);
    expect(heldIn).toEqual(['armed']);
    // Still held at the T-5 min wake ...
    await runTo(shared, wakeAt() + ALARM_DELAY + SEC);
    expect(stored(shared).state).toBe('waking');
    expect(shared.keepAwake.isHeld).toBe(true);
    // ... and at the fire.
    await runTo(shared, FIRE_LOCAL + 2 * SEC);
    expect(shared.sgw.placeBids).toHaveLength(1);
    expect(shared.keepAwake.isHeld).toBe(true);
    expect(shared.keepAwake.releases - atBoot).toBe(0);
    // The resolve releases it.
    await runTo(shared, END + 2 * MIN);
    const s = stored(shared);
    expect(s.state).toBe('resolved');
    expect(transitions(s)).toEqual(['draft>armed', 'armed>waking', 'waking>verified', 'verified>firing', 'firing>sent', 'sent>sent', 'sent>resolved']);
    expect(shared.sgw.placeBids).toHaveLength(1);
    expect(shared.keepAwake.holds).toEqual(['snipe s1']);
    expect(shared.keepAwake.isHeld).toBe(false);
    expect(shared.keepAwake.releases - atBoot).toBe(1);
  });

  it('KeepAwake under tier T2: the browser the companion starts at T-8 min holds before the late preflight, which sees it held', async () => {
    const shared = makeShared({ settings: settingsWith({ live: true, tier: 'T2' }) });
    await shared.permissions.request({ permissions: ['power'] });
    const first = await boot(shared, { jobModules: noCompanion() });
    // T-111c: the first startup releases a possible leftover (nothing needed it); counted from here.
    const atBoot = shared.keepAwake.releases;
    await arm(first.w);
    // The computer sleeps before the T-15 min preflight: no worker until the companion wakes it.
    await runTo(shared, END - 20 * MIN);
    first.w.kill();
    await runTo(shared, companionWake());
    expect(shared.keepAwake.holds).toEqual([]);
    expect(kinds(shared)).not.toContain('snipe.preflight');
    // The companion's browser start: the new worker holds, then runs the missed preflight, which passes.
    await boot(shared, { jobModules: noCompanion() });
    await runTo(shared, companionWake() + 5 * SEC);
    expect(stored(shared).state).toBe('armed');
    expect(shared.keepAwake.isHeld).toBe(true);
    expect(kinds(shared)).toContain('snipe.preflight');
    expect(kinds(shared)).not.toContain('snipe.preflight-failed');
    await runTo(shared, END + 2 * MIN);
    const s = stored(shared);
    expect(s.state).toBe('resolved');
    expect(transitions(s)).toContain('armed>waking');
    expect(shared.sgw.placeBids).toHaveLength(1);
    expect(shared.keepAwake.holds).toEqual(['snipe s1']);
    expect(shared.keepAwake.isHeld).toBe(false);
    expect(shared.keepAwake.releases - atBoot).toBe(1);
  });

  it.each([
    ['without `power`', { power: false, available: true }],
    ['without the power API (Firefox)', { power: true, available: false }],
  ])('KeepAwake under tier T2 %s is never held, and the snipe still fires', async (_name, opts) => {
    const shared = makeShared({ settings: settingsWith({ live: true, tier: 'T2' }) });
    shared.keepAwake = new FakeKeepAwake({ available: opts.available });
    if (opts.power) await shared.permissions.request({ permissions: ['power'] });
    const { w } = await boot(shared, { jobModules: noCompanion() });
    await arm(w);
    await runTo(shared, END + 2 * MIN);
    const s = stored(shared);
    expect(transitions(s)).toContain('armed>waking');
    expect(s.state).toBe('resolved');
    expect(shared.sgw.placeBids).toHaveLength(1);
    expect(shared.keepAwake.holds).toEqual([]);
  });

  // T-111c: Chrome keeps power.requestKeepAwake per extension, not per worker (the shared
  // FakeKeepAwake outlives each worker the same way), so a worker that dies holding it leaves it.
  describe('T-111c: a hold a dead worker left is released at startup unless a snipe needs it', () => {
    /** A dead worker's leftover hold, for a snipe whose record no longer needs it. */
    const leftover = (shared: Shared): Promise<void> => shared.keepAwake.hold('snipe s0');

    it('a leftover hold with no snipe in its window (T1, the only snipe resolved) is released', async () => {
      const shared = makeShared({ settings: settingsWith({ live: true, tier: 'T1' }) });
      await shared.permissions.request({ permissions: ['power'] });
      const first = await boot(shared);
      await arm(first.w);
      await runTo(shared, END + 2 * MIN);
      expect(stored(shared).state).toBe('resolved');
      await leftover(shared);
      first.w.kill();
      const before = shared.keepAwake.releases;

      await boot(shared);
      expect(shared.keepAwake.isHeld).toBe(false);
      expect(shared.keepAwake.releases).toBe(before + 1);
    });

    it('a T1 snipe still armed keeps it: never released at startup', async () => {
      const shared = makeShared({ settings: settingsWith({ live: true, tier: 'T1' }) });
      await shared.permissions.request({ permissions: ['power'] });
      const first = await boot(shared);
      await arm(first.w);
      await runTo(shared, T0 + 10 * MIN);
      expect(shared.keepAwake.isHeld).toBe(true);
      first.w.kill();
      const before = shared.keepAwake.releases;

      await boot(shared);
      expect(stored(shared).state).toBe('armed');
      expect(shared.keepAwake.isHeld).toBe(true);
      expect(shared.keepAwake.releases).toBe(before);
      await runTo(shared, END + 2 * MIN);
      expect(stored(shared).state).toBe('resolved');
      expect(shared.sgw.placeBids).toHaveLength(1);
      expect(shared.keepAwake.isHeld).toBe(false);
    });

    it('a T2 snipe before its companion wake does not need it: released, and the wake takes it again', async () => {
      const shared = makeShared({ settings: settingsWith({ live: true, tier: 'T2' }) });
      await shared.permissions.request({ permissions: ['power'] });
      const first = await boot(shared, { jobModules: noCompanion() });
      await arm(first.w);
      await runTo(shared, T0 + 10 * MIN);
      await leftover(shared);
      first.w.kill();

      await boot(shared, { jobModules: noCompanion() });
      expect(stored(shared).state).toBe('armed');
      expect(shared.keepAwake.isHeld).toBe(false);
      await runTo(shared, companionWake() + ALARM_DELAY + 5 * SEC);
      expect(shared.keepAwake.isHeld).toBe(true);
      await runTo(shared, END + 2 * MIN);
      expect(stored(shared).state).toBe('resolved');
      expect(shared.sgw.placeBids).toHaveLength(1);
    });

    it('a T2 snipe past its companion wake keeps it: never released at startup', async () => {
      const shared = makeShared({ settings: settingsWith({ live: true, tier: 'T2' }) });
      await shared.permissions.request({ permissions: ['power'] });
      const first = await boot(shared, { jobModules: noCompanion() });
      await arm(first.w);
      await runTo(shared, companionWake() + ALARM_DELAY + 5 * SEC);
      expect(stored(shared).state).toBe('armed');
      expect(shared.keepAwake.isHeld).toBe(true);
      first.w.kill();
      const before = shared.keepAwake.releases;

      await boot(shared, { jobModules: noCompanion() });
      expect(shared.keepAwake.isHeld).toBe(true);
      expect(shared.keepAwake.releases).toBe(before);
      await runTo(shared, END + 2 * MIN);
      expect(stored(shared).state).toBe('resolved');
      expect(shared.sgw.placeBids).toHaveLength(1);
      expect(shared.keepAwake.isHeld).toBe(false);
    });

    it('reconcile never releases a hold this worker took, even when the stored snipes no longer ask for one', async () => {
      const shared = makeShared({ settings: settingsWith({ live: true, tier: 'T1' }) });
      await shared.permissions.request({ permissions: ['power'] });
      const { w, ctx } = await boot(shared);
      await arm(w);
      await flush();
      expect(shared.keepAwake.isHeld).toBe(true);
      // Tier T0 mid-snipe: no stored snipe asks for a hold, but this worker's record says it holds one.
      await w.ok('settings.set', { snipe: { ...settingsWith({ live: true, tier: 'T1' }).snipe, tier: 'T0' } });
      expect(stored(shared).state).toBe('armed');
      const runner = getSnipeRunner(ctx);
      if (runner === undefined) throw new Error('no runner');
      const before = shared.keepAwake.releases;
      await runner.reconcile();
      expect(shared.keepAwake.isHeld).toBe(true);
      expect(shared.keepAwake.releases).toBe(before);
    });
  });
});

describe('live safety', () => {
  it('turning the global bidding dry run on mid-window stops a live snipe: no PlaceBid', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, END - SKEW - 30 * SEC);
    expect(stored(shared).state).toBe('verified');
    const switchedAt = shared.clock.now();
    await w.ok('settings.set', { dryRun: { favorites: false, calendar: false, bidding: true } });
    await flush();
    // The live snipe's window check sees the dry run at once (it never asks with ignoreDryRun).
    const s = stored(shared);
    expect(transitions(s).at(-1)).toBe('verified>killed');
    expect((s.history.at(-1)?.at ?? 0) - switchedAt).toBeLessThan(SEC);
    await runTo(shared, END + 2 * MIN);
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(shared.sgw.modals).toHaveLength(0);
    expect(stored(shared).state).toBe('killed');
    expect(String(audits(shared).find((a) => a.kind === 'snipe.disarm')?.details.why)).toMatch(/dry run/);
  });

  it('a session lost mid-window is an anomaly: killed, fallback reason auth, no bid', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, END - SKEW - 30 * SEC);
    await shared.areas.local.remove([STORAGE_KEYS.sgwSession]);
    await runTo(shared, END + 2 * MIN);
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(stored(shared).state).toBe('killed');
    expect(audits(shared).find((a) => a.kind === 'snipe.fallback')?.details).toMatchObject({ reason: 'auth', applied: 'skip' });
  });

  it('a favorites-only sticky schema failure does not stop a snipe (bidding stays allowed)', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, END - SKEW - 30 * SEC);
    const at = shared.clock.now();
    await shared.areas.local.set({
      [STORAGE_KEYS.healthProbe]: { probedAt: at, lastGoodProbeAt: {}, sticky: [{ endpoint: 'addFavorite', at, detail: 'drift' }] },
      [STORAGE_KEYS.healthReport]: {
        ok: false,
        checkedAt: at,
        configVersion: 'test',
        checks: [{ name: 'detail-schema', ok: false, detail: 'sticky schema failure: addFavorite: drift' }],
      },
    });
    await runTo(shared, END + 2 * MIN);
    expect(shared.sgw.placeBids).toHaveLength(1);
    expect(stored(shared).state).toBe('resolved');
  });
});

describe('snipe handlers', () => {
  it('snipe.arm resets the runner-owned fields and reads the item itself', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    const armed = await arm(w, {
      title: 'from the UI',
      endTime: new Date(END + DAY).toISOString(),
      attempt: { sentAt: T0, idempotencyKey: 'forged' },
      fireAt: T0,
      wakeAlarm: 'x',
      measured: { offsetMs: 99 },
      outcome: 'won',
      outcomeDetail: 'forged',
    });
    expect(armed.state).toBe('armed');
    expect(armed.attempt).toEqual({});
    expect(armed.endTime).toBe(new Date(END).toISOString());
    expect(armed.endTimeAtArm).toBe(armed.endTime);
    expect(armed.sellerId).toBe(SELLER);
    expect(armed.fireAt).toBe(END - LEAD);
    expect(armed).not.toHaveProperty('measured');
    expect(armed).not.toHaveProperty('outcome');
    expect(armed).not.toHaveProperty('wakeAlarm');
    expect(armed.history).toHaveLength(1);
    expect(await w.ok<Snipe[]>('snipe.list')).toEqual([armed]);
  });

  it('snipe.arm refuses: sniping off, no session, a session ending too soon (S-2), the same item twice, a reused id, a typo', async () => {
    const off = makeShared({ settings: settingsWith({ live: true, enabled: false }) });
    const a = await boot(off);
    await expect(arm(a.w)).rejects.toThrow(/turned off/);

    const noSession = makeShared();
    await noSession.areas.local.remove([STORAGE_KEYS.sgwSession]);
    const b = await boot(noSession);
    await expect(arm(b.w)).rejects.toThrow(/Sign in/);

    const short = makeShared({ seed: { [STORAGE_KEYS.sgwSession]: { ...SESSION, expiresAt: END + 10 * MIN } } });
    const c = await boot(short);
    await expect(arm(c.w)).rejects.toThrow(/expires/);

    const shared = makeShared();
    const d = await boot(shared);
    await arm(d.w);
    await expect(arm(d.w, { id: 's2' })).rejects.toThrow(/already has an open snipe/);
    await d.w.ok('snipe.disarm', { id: 's1' });
    await expect(arm(d.w)).rejects.toThrow(/already exists/);
    await expect(arm(d.w, { id: 's3', maxBid: 4000 })).rejects.toThrow(/Type the amount/);
    const ok = await arm(d.w, { id: 's3', maxBid: 4000 }, '$40');
    expect(ok.maxBid).toBe(4000);
  });

  it('snipe.arm while the kill switch is on is refused cleanly: nothing is armed and then stopped', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await w.ok('kill.set', { on: true });
    await expect(arm(w)).rejects.toThrow(/kill switch is on/);
    expect(shared.areas.local.dump()[STORAGE_KEYS.snipes]).toBeUndefined();
  });

  it('a kill that lands while snipe.arm reads the item still refuses the arm: nothing is stored, so nothing is stopped', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    const armed = w.send('snipe.arm', { snipe: armPayload() });
    await flush();
    // The handler's check passed (kill was off); the arm now waits on its item read.
    expect(shared.http.requests.some((r) => r.url.startsWith(DETAIL_URL))).toBe(true);
    const kill = w.send('kill.set', { on: true });
    for (let i = 0; i < 40; i++) {
      shared.clock.advance(50);
      await flush(1);
    }
    const r = await armed;
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/kill switch is on/);
    expect((await kill).ok).toBe(true);
    expect(shared.areas.local.dump()[STORAGE_KEYS.snipes]).toBeUndefined();
  });

  it('the runner itself refuses an arm under the kill switch, before any SGW read (a caller that skips the handler)', async () => {
    const shared = makeShared();
    const { w, ctx } = await boot(shared);
    await w.ok('kill.set', { on: true });
    const runner = getSnipeRunner(ctx);
    if (runner === undefined) throw new Error('no runner');
    const input = { id: 's1', itemId: ITEM, title: 'Pyrex bowl', maxBid: MAX, leadMs: LEAD, fallback: 'early-proxy' as const, dryRun: false };
    await expect(runner.arm(input)).rejects.toThrow(/kill switch is on/);
    expect(shared.http.requests.filter((r) => r.url.startsWith(DETAIL_URL))).toHaveLength(0);
    expect(shared.areas.local.dump()[STORAGE_KEYS.snipes]).toBeUndefined();
  });

  it('snipe.arm refuses one cent over the per-item cap and over the daily cap still remaining', async () => {
    const withCaps = (caps: Partial<Settings['snipe']['caps']>): Settings => {
      const s = settingsWith({ live: true });
      s.snipe.caps = { ...s.snipe.caps, ...caps };
      return s;
    };

    // The item's next bid is $11.00. Exactly $15.00 is the cap; $15.01 is not.
    const perItem = makeShared({ settings: withCaps({ perItemMax: 1500, perDayMax: 100_000, openExposureMax: 200_000 }) });
    const itemWorker = await boot(perItem);
    await expect(arm(itemWorker.w, { maxBid: 1501 })).rejects.toThrow(/per-item/);
    const atItemCap = await arm(itemWorker.w, { maxBid: 1500 });
    expect(atItemCap.maxBid).toBe(1500);

    // Estimates ride on the draft. $15.00 + $4.00 shipping + $1.00 handling is
    // the $20.00 day; one extra cent of bid does not fit. maxBid alone is under
    // the day, so a check that ignores shipping would let it through.
    const perDay = makeShared({ settings: withCaps({ perItemMax: 50_000, perDayMax: 2000, openExposureMax: 200_000 }) });
    const dayWorker = await boot(perDay);
    const estimates = { estShipping: 400, estHandling: 100 };
    await expect(arm(dayWorker.w, { maxBid: 1501, ...estimates })).rejects.toThrow(/per-day/);
    const atDayCap = await arm(dayWorker.w, { maxBid: 1500, ...estimates });
    expect(atDayCap.maxBid).toBe(1500);
  });

  it('snipe.disarm: before the fire it kills; after `sent` the reducer refuses it (a bid may be out)', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, FIRE_LOCAL + 3 * SEC);
    expect(stored(shared).state).toBe('sent');
    const r = await w.send('snipe.disarm', { id: 's1' });
    expect(r.ok).toBe(false);
    expect(r.ok ? '' : r.error.message).toMatch(/may already be out/);
    expect(stored(shared).state).toBe('sent');

    const other = makeShared();
    const o = await boot(other);
    await arm(o.w);
    await o.w.ok('snipe.disarm', { id: 's1' });
    expect(stored(other)).toMatchObject({ state: 'killed', outcome: 'killed' });
    await runTo(other, END + 2 * MIN);
    expect(other.sgw.details).toHaveLength(1);
    expect(await snipeAlarms(other)).toEqual([]);
  });

  it('snipe.prepare returns the detail, the estimated all-in and the caps for the next acceptable bid', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    const r = await w.ok<{ detail: { itemId: number; minimumBid: number }; estAllIn: number | null; caps: { ok: boolean } }>('snipe.prepare', {
      itemId: ITEM,
    });
    expect(r.detail).toMatchObject({ itemId: ITEM, minimumBid: 1100 });
    expect(r.caps.ok).toBe(true);
    expect(r.estAllIn === null || r.estAllIn >= 1100).toBe(true);
  });
});

describe('seams (I-12)', () => {
  it('a registered SendStrategy does the send (T-101), after `sent` is stored, with the stored key', async () => {
    const shared = makeShared();
    const seen: Array<{ amount: number; key: string; storedKey: string | undefined; state: string | undefined; serverNow: number }> = [];
    const strategy: SendStrategy = {
      send: async (req, deps) => {
        const s = (shared.areas.local.dump()[STORAGE_KEYS.snipes] as Record<string, Snipe | undefined>).s1;
        seen.push({ amount: req.amount, key: req.idempotencyKey, storedKey: s?.attempt.idempotencyKey, state: s?.state, serverNow: deps.serverNow() });
        const result = await deps.api.placeBid(
          { itemId: req.snipe.itemId, sellerId: req.sellerId, bidAmount: req.amount, quantity: 1 },
          { idempotencyKey: req.idempotencyKey, timeoutMs: req.timeoutMs },
        );
        return { kind: 'result', result };
      },
    };
    const { w } = await boot(shared, {
      jobModules: probe((ctx) => {
        snipeSeams(ctx).setSendStrategy(strategy);
      }),
    });
    await arm(w);
    await runTo(shared, END + 2 * MIN);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ amount: MAX, state: 'sent' });
    expect(seen[0]?.storedKey).toBe(seen[0]?.key);
    expect(Math.abs((seen[0]?.serverNow ?? 0) - FIRE_SERVER)).toBeLessThanOrEqual(5);
    expect(shared.sgw.placeBids).toHaveLength(1);
  });

  it('ArmHooks: beforeArm can veto; afterArm and afterTransition see every step; a preflight hook failure reaches the reducer', async () => {
    const shared = makeShared();
    const steps: string[] = [];
    const { w } = await boot(shared, {
      jobModules: probe((ctx) => {
        snipeSeams(ctx).addArmHooks({
          beforeArm: (s) => (s.id === 'veto' ? { veto: 'Bid group rule: too close to another end.' } : undefined),
          afterArm: (s) => {
            steps.push(`armed:${s.id}`);
          },
          afterTransition: (next, prev) => {
            steps.push(`${prev.state}>${next.state}`);
          },
          preflight: () => ({ reason: 'keep-awake', detail: 'The companion is not reachable.' }),
        });
      }),
    });
    await expect(arm(w, { id: 'veto' })).rejects.toThrow(/Bid group rule/);
    await arm(w);
    await runTo(shared, END + 10 * MIN);
    // keep-awake applies the fallback: the early proxy is placed and settled.
    expect(steps.slice(0, 3)).toEqual(['armed:s1', 'armed>fallback-applied', 'fallback-applied>sent']);
    expect(steps.at(-1)).toBe('sent>resolved');
    expect(shared.sgw.placeBids).toHaveLength(1);
  });

  it("T-87e: a preflight hook's failure detail is what the user is told, not the generic keep-awake copy", async () => {
    const shared = makeShared();
    const detail = 'T2: the wake companion did not answer (is it installed and running?), so nothing will wake this computer before the auction ends.';
    const { w } = await boot(shared, {
      jobModules: probe((ctx) => {
        snipeSeams(ctx).addArmHooks({ preflight: () => ({ reason: 'keep-awake', detail }) });
      }),
    });
    await arm(w, { fallback: 'skip' });
    await runTo(shared, END + 2 * MIN);
    const s = stored(shared);
    expect(s).toMatchObject({ state: 'resolved', outcome: 'skipped' });
    expect(shared.sgw.placeBids).toHaveLength(0);
    const told = shared.notifier.sent.filter((n) => n.notification.title.startsWith('Snipe skipped'));
    expect(told).toHaveLength(1);
    expect(told[0]?.notification.message).toContain(detail);
    expect(told[0]?.notification.message).not.toMatch(/Keep-awake is not held/);
    expect(s.outcomeDetail).toContain(detail);
  });

  it('the SnipeHost factory is keyed by the S-7 verdict and loads registered implementations', () => {
    const deps = { clock: new FakeClock(T0), log: () => undefined };
    expect(S7_HOST_VERDICT).toEqual({ chrome: 'background', firefox: 'runner-page' });
    expect(hostVerdict(false)).toBe('background');
    expect(hostVerdict(true)).toBe('runner-page');
    const bg = createSnipeHost(deps, { verdict: 'background', modules: {} });
    expect(bg).toMatchObject({ implementation: 'background', degraded: false });
    expect(bg.host).toBeInstanceOf(BackgroundSnipeHost);
    // Firefox without T-116's page: the background stands in, and says so.
    expect(createSnipeHost(deps, { verdict: 'runner-page', modules: {} })).toMatchObject({ implementation: 'background', degraded: true });
    const page: SnipeHostModule = {
      snipeHost: { verdict: 'runner-page', create: () => ({ acquire: () => Promise.resolve(), release: () => Promise.resolve() }) },
    };
    const picked = createSnipeHost(deps, { verdict: 'runner-page', modules: { './snipe-host-page.ts': page } });
    expect(picked).toMatchObject({ implementation: './snipe-host-page.ts', degraded: false });
    expect(createSnipeHost(deps, { verdict: 'background', modules: { './snipe-host-page.ts': page } }).implementation).toBe('background');
  });

  it('a Firefox build without the runner page uses the background host and audits it as degraded', async () => {
    vi.stubEnv('FIREFOX', 'true');
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, END + 2 * MIN);
    const deg = audits(shared).find((a) => a.kind === 'snipe.host-degraded');
    expect(deg?.details).toMatchObject({ verdict: 'runner-page', implementation: 'background' });
    expect(shared.sgw.placeBids).toHaveLength(1);
  });

  it('the sbw:snipe-countdown port streams { snipeId, serverNow, fireAt, state } every second while connected', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    const got: unknown[] = [];
    const disconnect = fakeEvent<() => void>();
    const port: RuntimePort = {
      name: 'sbw:snipe-countdown',
      // T-118 (L9): the countdown is served only to the extension's own pages.
      sender: { id: 'sbwtestid', url: 'chrome-extension://sbwtestid/sidepanel.html' },
      postMessage: (m) => {
        got.push(m);
      },
      disconnect: () => undefined,
      onMessage: fakeEvent<(m: unknown) => void>(),
      onDisconnect: disconnect,
    };
    for (const l of w.onConnect.listeners) l(port);
    await runTo(shared, shared.clock.now() + 3 * SEC);
    expect(got.length).toBeGreaterThanOrEqual(3);
    expect(got[0]).toEqual({ snipeId: 's1', serverNow: null, fireAt: END - LEAD, state: 'armed' });
    for (const l of disconnect.listeners) l();
    const n = got.length;
    await runTo(shared, shared.clock.now() + 3 * SEC);
    expect(got.length).toBe(n);
  });
});

// ── R4: the reviewer's runner model, as a property of the real runner ────────
//
// Port of the T-80 reviewer's model (session scratchpad t80rr/runner-model.test.ts)
// to the real thing: real storage writes (CAS on history.length, the outbox,
// persist-before-send), crashes at random storage writes and at random times,
// restarts that recover from storage alone, duplicate alarm deliveries, stale
// and replayed events from a second context, kill-switch and health flips, and
// SGW faults (detail, ShowBidModal, PlaceBid: errors, 5xx, hangs). Checks after
// every action: at most one PlaceBid on the wire, for exactly the max, each one
// leaving only after `sent` and its key were stored and never under the kill
// switch; none in a dry run; a bid that went out is never killed or reported as
// "no bid"; and, once healed, every snipe reaches a terminal state.

const PROP_RUNS = Number(process.env.SBW_PROP_RUNS ?? (process.env.SBW_LONG_PROPS !== undefined && process.env.SBW_LONG_PROPS !== '' ? 10_000 : 2_000));
const PROP_SEED = Number(process.env.SBW_PROP_SEED ?? '8484');

type Phase = 'arm' | 'health1' | 'preflight' | 'wake' | 'sample' | 'verify' | 'prefire' | 'fire' | 'sending' | 'reply' | 'postread' | 'late';

function phaseAt(p: Phase): number {
  switch (p) {
    case 'arm':
      return T0 + MIN;
    case 'health1':
      return END - HOUR + ALARM_DELAY;
    case 'preflight':
      return END - 15 * MIN + ALARM_DELAY;
    case 'wake':
      return wakeAt() + ALARM_DELAY;
    case 'sample':
      return wakeAt() + ALARM_DELAY + 25 * SEC;
    case 'verify':
      return END - SKEW - 60 * SEC;
    case 'prefire':
      return FIRE_LOCAL - 3 * SEC;
    case 'fire':
      return FIRE_LOCAL;
    case 'sending':
      return FIRE_LOCAL + LATENCY + 1000;
    case 'reply':
      return FIRE_LOCAL + 2 * LATENCY + 1000;
    case 'postread':
      return END - SKEW + 5 * SEC;
    case 'late':
      return END + 40 * MIN;
  }
}

type StaleType = 'wake' | 'fire' | 'sent' | 'ambiguous' | 'result' | 'post-read' | 'verified' | 'verify-failed' | 'disarm' | 'apply-fallback' | 'preflight-failed';
type FaultStep = 'net' | '503' | 'hang' | 'ok';

type PropAction =
  | { a: 'advance'; to: Phase; jitter: number }
  | { a: 'crashNow' }
  | { a: 'crashAtWrite'; n: number }
  | { a: 'restart' }
  | { a: 'dupAlarm'; kind: 'wake' | 'recover' | 'preflight' | 'postread' | 'health1'; times: number }
  | { a: 'dispatch'; type: StaleType; shift: number; stale: boolean; twice: boolean }
  | { a: 'kill'; on: boolean }
  | { a: 'health'; ok: boolean }
  | { a: 'fault'; target: 'detail' | 'modal' | 'place'; step: FaultStep; count: number };

const PHASES: Phase[] = ['arm', 'health1', 'preflight', 'wake', 'sample', 'verify', 'prefire', 'fire', 'sending', 'reply', 'postread', 'late'];

const arbAction: fc.Arbitrary<PropAction> = fc.oneof(
  { weight: 10, arbitrary: fc.record({ a: fc.constant('advance' as const), to: fc.constantFrom(...PHASES), jitter: fc.oneof(fc.integer({ min: -3000, max: 3000 }), fc.constantFrom(0, 1, 999, 20_000)) }) },
  { weight: 2, arbitrary: fc.constant({ a: 'crashNow' as const }) },
  { weight: 3, arbitrary: fc.record({ a: fc.constant('crashAtWrite' as const), n: fc.integer({ min: 1, max: 12 }) }) },
  { weight: 4, arbitrary: fc.constant({ a: 'restart' as const }) },
  { weight: 2, arbitrary: fc.record({ a: fc.constant('dupAlarm' as const), kind: fc.constantFrom('wake' as const, 'recover' as const, 'preflight' as const, 'postread' as const, 'health1' as const), times: fc.integer({ min: 1, max: 3 }) }) },
  {
    weight: 3,
    arbitrary: fc.record({
      a: fc.constant('dispatch' as const),
      type: fc.constantFrom<StaleType>('wake', 'fire', 'sent', 'ambiguous', 'result', 'post-read', 'verified', 'verify-failed', 'disarm', 'apply-fallback', 'preflight-failed'),
      shift: fc.constantFrom(0, 0, -60_000, 1000, 60_000),
      stale: fc.boolean(),
      twice: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ a: fc.constant('kill' as const), on: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ a: fc.constant('health' as const), ok: fc.boolean() }) },
  {
    weight: 2,
    arbitrary: fc.record({
      a: fc.constant('fault' as const),
      target: fc.constantFrom('detail' as const, 'modal' as const, 'place' as const),
      step: fc.constantFrom<FaultStep>('net', '503', 'hang', 'ok'),
      count: fc.integer({ min: 1, max: 3 }),
    }),
  },
);

const arbStart = fc.record({
  dryRun: fc.integer({ min: 0, max: 4 }).map((n) => n === 0),
  fallback: fc.constantFrom('early-proxy' as const, 'skip' as const),
  maxBid: fc.integer({ min: 1200, max: 4900 }),
});

function faultStep(step: FaultStep): HttpStep {
  switch (step) {
    case 'net':
      return net();
    case '503':
      return { status: 503, latencyMs: LATENCY };
    case 'hang':
      return { hang: true };
    case 'ok':
      return { status: 200, bodyText: JSON.stringify({ status: true, result: 0, message: 'Bid placed', isHighBidder: true }), latencyMs: LATENCY };
  }
}

interface PropWorld {
  shared: Shared;
  w: Worker;
  ctx: BackgroundContext;
  maxBid: number;
  dryRun: boolean;
  writes: { left: number | undefined };
  modalFaults: HttpStep[];
  placeFaults: HttpStep[];
  stats: Record<string, number>;
}

function bump(w: PropWorld, k: string): void {
  w.stats[k] = (w.stats[k] ?? 0) + 1;
}

async function propBoot(world: Omit<PropWorld, 'w' | 'ctx'> & Partial<Pick<PropWorld, 'w' | 'ctx'>>): Promise<{ w: Worker; ctx: BackgroundContext }> {
  const writes = world.writes;
  return boot(world.shared, {
    crashAfterSet: (area, entries) => {
      if (area !== 'local' || writes.left === undefined) return false;
      writes.left -= 1;
      if (writes.left > 0) return false;
      writes.left = undefined;
      const s = snipesIn(entries)?.s1;
      if (s !== undefined) {
        const k = `crashAfterPersist:${s.state}${s.state === 'sent' && s.attempt.reply === undefined && s.attempt.ambiguous !== true ? ':unsent' : ''}`;
        world.stats[k] = (world.stats[k] ?? 0) + 1;
      }
      return true;
    },
  });
}

function stalEvent(world: PropWorld, type: StaleType, now: number): SnipeEvent {
  const detail = normalizeItemDetail(world.shared.sgw.raw(), { observedAt: now, authenticated: true });
  switch (type) {
    case 'wake':
    case 'fire':
    case 'ambiguous':
      return { type, now };
    case 'sent':
      return { type, now, key: `replay-${String(now)}` };
    case 'result':
      return {
        type,
        now,
        result: { kind: 'rejected-unknown', rawStatus: null, rawResult: 0, messageText: 'replayed', isHighBidder: null, observedAt: now },
      };
    case 'post-read':
      return { type, now, detail };
    case 'verified':
      return { type, now, detail, offsetMs: SKEW, rttMs: LATENCY };
    case 'verify-failed':
      return { type, now, reason: 'network' };
    case 'disarm':
      return { type, now, by: 'anomaly', why: 'replayed' };
    case 'apply-fallback':
      return { type, now, mode: 'early-proxy' };
    case 'preflight-failed':
      return { type, now, reason: 'clock' };
  }
}

function checkWorld(world: PropWorld): void {
  const { shared } = world;
  const bids = shared.sgw.placeBids;
  // At most one wire send per snipe, for exactly the max.
  expect(bids.length).toBeLessThanOrEqual(1);
  for (const b of bids) {
    // It leaves before the end (server time).
    expect(b.at + SKEW).toBeLessThan(END);
    expect(b.body.bidAmount).toBe(bidAmount(world.maxBid));
    expect(b.body.itemId).toBe(ITEM);
    // Persist before send: `sent` and its key were stored when it left.
    expect(b.stored?.state).toBe('sent');
    expect(b.stored?.attempt.idempotencyKey).toBeDefined();
  }
  if (world.dryRun) {
    expect(bids).toHaveLength(0);
    expect(shared.sgw.modals).toHaveLength(0);
  }
  const all = shared.areas.local.dump()[STORAGE_KEYS.snipes] as Record<string, Snipe> | undefined;
  const s = all?.s1;
  if (s === undefined) return;
  expect(s.maxBid).toBe(world.maxBid);
  expect(s.history.filter((h) => h.to === 'sent' && h.from !== 'sent').length).toBeLessThanOrEqual(1);
  if (s.attempt.ambiguous === true) expect(s.attempt.reply).toBeUndefined();
  if (s.attempt.notSent === true) expect(bids).toHaveLength(0);
  if (bids.length > 0) {
    // A bid that may be live is never killed, nor reported as "no bid".
    expect(['sent', 'resolved']).toContain(s.state);
    expect(s.attempt.notSent).not.toBe(true);
    expect(shared.notifier.sent.some((n) => /No bid was sent/i.test(n.notification.message))).toBe(false);
    if (s.state === 'resolved') {
      expect(['killed', 'cap-blocked', 'skipped', 'dry-run']).not.toContain(s.outcome);
      expect(s.outcomeDetail ?? '').not.toMatch(NO_BID_CLAIM);
    }
  }
  if (s.attempt.sentAt !== undefined) expect(['sent', 'resolved']).toContain(s.state);
  // m2: a snipe fires only in [fireAt - 2 s, end), server time.
  const fired = s.measured?.firedAt;
  if (fired !== undefined && s.fireAt !== undefined) {
    expect(fired).toBeGreaterThanOrEqual(s.fireAt - 2000);
    expect(fired).toBeLessThan(END);
  }
}

async function propRun(start: { dryRun: boolean; fallback: Snipe['fallback']; maxBid: number }, actions: readonly PropAction[], agg: Record<string, number>): Promise<void> {
  const shared = makeShared({ settings: settingsWith({ live: !start.dryRun }) });
  const killOnAtSend: boolean[] = [];
  const modalFaults: HttpStep[] = [];
  const placeFaults: HttpStep[] = [];
  // Faults are queued per endpoint; the kill switch at every PlaceBid is recorded.
  shared.http.on(MODAL_URL, () => {
    shared.sgw.modals.push(shared.clock.now());
    return modalFaults.shift() ?? { status: 200, bodyText: JSON.stringify({ sellerId: SELLER, minimumBid: shared.sgw.item.minimumBid / 100 }), latencyMs: LATENCY };
  });
  shared.http.on(PLACE_URL, (req) => {
    const dump = shared.areas.local.dump();
    killOnAtSend.push((dump[STORAGE_KEYS.settings] as Settings).killSwitch);
    const body = JSON.parse(String(req.body)) as PlaceBidSeen['body'];
    const st = (dump[STORAGE_KEYS.snipes] as Record<string, Snipe> | undefined)?.s1;
    shared.sgw.placeBids.push({ at: shared.clock.now(), body, stored: st });
    return placeFaults.shift() ?? faultStep('ok');
  });
  const base = { shared, maxBid: start.maxBid, dryRun: start.dryRun, writes: { left: undefined as number | undefined }, modalFaults, placeFaults, stats: {} };
  const first = await propBoot(base);
  const world: PropWorld = { ...base, ...first };
  await arm(world.w, { maxBid: start.maxBid, fallback: start.fallback, dryRun: start.dryRun }, bidAmount(start.maxBid));
  world.dryRun = stored(shared).dryRun;

  const restart = async (): Promise<void> => {
    if (!world.w.life.dead) return;
    world.writes.left = undefined;
    const next = await propBoot(world);
    world.w = next.w;
    world.ctx = next.ctx;
    bump(world, 'restart');
  };

  for (const act of actions) {
    switch (act.a) {
      case 'advance': {
        const to = Math.max(shared.clock.now(), phaseAt(act.to) + act.jitter);
        await runTo(shared, to);
        break;
      }
      case 'crashNow':
        if (!world.w.life.dead) bump(world, 'crash');
        world.w.kill();
        break;
      case 'crashAtWrite':
        if (!world.w.life.dead) world.writes.left = act.n;
        break;
      case 'restart':
        await restart();
        break;
      case 'dupAlarm':
        if (world.w.life.dead) break;
        for (let i = 0; i < act.times; i++) world.w.deliverAlarm(snipeAlarmName('s1', act.kind));
        bump(world, 'dupAlarm');
        await flush();
        break;
      case 'dispatch': {
        if (world.w.life.dead) break;
        const runner = getSnipeRunner(world.ctx);
        const s = shared.areas.local.dump()[STORAGE_KEYS.snipes] as Record<string, Snipe> | undefined;
        const cur = s?.s1;
        if (runner === undefined || cur === undefined) break;
        const e = stalEvent(world, act.type, shared.clock.now() + act.shift);
        const version = act.stale ? Math.max(0, cur.history.length - 1) : cur.history.length;
        // T-84c: `disarm` still exercises the outside path, and the attempt
        // events stay on it too (they were, and are, refused there). The other
        // events are fed through the internal path, as the runner's own logic
        // would feed them.
        const outsideAttempt = act.type === 'sent' || act.type === 'result' || act.type === 'ambiguous' || act.type === 'post-read';
        const send = async (): Promise<CommitResult> =>
          act.type === 'disarm' || outsideAttempt ? runner.dispatch('s1', e, version) : feedInternal(runner, 's1', e, version);
        const runs = act.twice ? [send(), send()] : [send()];
        const results = await Promise.race([Promise.all(runs), world.w.died.then(() => [])]);
        for (const r of results) bump(world, `dispatch:${r.kind}`);
        await flush();
        break;
      }
      case 'kill':
        if (world.w.life.dead) break;
        // A crash armed for the next write may kill the worker mid-persist: then there is no reply.
        await world.w.ok('kill.set', { on: act.on }).catch(() => undefined);
        bump(world, act.on ? 'killOn' : 'killOff');
        break;
      case 'health': {
        const at = shared.clock.now();
        await shared.areas.local.set({
          [STORAGE_KEYS.healthReport]: { ok: act.ok, checkedAt: at, configVersion: 'test', checks: [{ name: 'detail-schema', ok: act.ok, ...(act.ok ? {} : { detail: 'drift' }) }] },
        });
        await flush();
        break;
      }
      case 'fault': {
        const q = act.target === 'detail' ? shared.sgw.detailFaults : act.target === 'modal' ? modalFaults : placeFaults;
        for (let i = 0; i < act.count; i++) q.push(act.target === 'place' || act.step !== 'ok' ? faultStep(act.step) : faultStep('net'));
        break;
      }
    }
    checkWorld(world);
    expect(killOnAtSend.every((k) => !k)).toBe(true);
  }

  // Heal: faults cleared, a live worker, health ok; every snipe must reach a terminal state.
  shared.sgw.detailFaults.length = 0;
  modalFaults.length = 0;
  placeFaults.length = 0;
  world.writes.left = undefined;
  await shared.areas.local.set({ [STORAGE_KEYS.healthReport]: { ok: true, checkedAt: shared.clock.now(), configVersion: 'test', checks: [] } });
  await restart();
  await runTo(shared, Math.max(shared.clock.now(), END) + 8 * HOUR);
  checkWorld(world);
  const final = stored(shared);
  expect(['resolved', 'killed']).toContain(final.state);
  expect(runnerRecord(shared).entries.s1).toBeUndefined();

  for (const [k, v] of Object.entries(world.stats)) agg[k] = (agg[k] ?? 0) + v;
  agg.runs = (agg.runs ?? 0) + 1;
  const wires = shared.sgw.placeBids.length;
  if (wires > 0) agg.runsWithWire = (agg.runsWithWire ?? 0) + 1;
  if (wires > 0 && final.history.some((h) => h.from === 'fallback-applied' && h.to === 'sent')) agg.proxyWires = (agg.proxyWires ?? 0) + 1;
  if (final.attempt.ambiguous === true) agg.ambiguous = (agg.ambiguous ?? 0) + 1;
  agg[`final:${final.state}:${final.outcome ?? '?'}`] = (agg[`final:${final.state}:${final.outcome ?? '?'}`] ?? 0) + 1;
}

describe('R4: the runner model as a property of the real runner', () => {
  it(`at most one wire send per snipe across crashes, restarts, replays and duplicate alarms (${String(PROP_RUNS)} runs)`, { timeout: 3_600_000 }, async () => {
    const agg: Record<string, number> = {};
    await fc.assert(
      fc.asyncProperty(arbStart, fc.array(arbAction, { minLength: 8, maxLength: 24 }), async (start, actions) => {
        vi.restoreAllMocks();
        vi.spyOn(globalThis.crypto.subtle, 'digest').mockImplementation((_alg, data) => {
          const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
          const out = createHash('sha256').update(bytes).digest();
          return Promise.resolve(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
        });
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        await propRun(start, actions, agg);
      }),
      { numRuns: PROP_RUNS, seed: PROP_SEED },
    );
    if (process.env.SBW_PROP_STATS !== undefined) {
      process.stdout.write(`${Object.keys(agg).sort().map((k) => `${k}=${String(agg[k])}`).join(' ')}\n`);
    }
    expect(agg.runs).toBe(PROP_RUNS);
    // The runs reach the money path, including crashes around it and early proxies.
    expect(agg.runsWithWire ?? 0).toBeGreaterThan(PROP_RUNS / 20);
    expect(agg.proxyWires ?? 0).toBeGreaterThan(0);
    expect(agg.ambiguous ?? 0).toBeGreaterThan(0);
    expect(agg.restart ?? 0).toBeGreaterThan(PROP_RUNS / 10);
    expect(agg['dispatch:accepted'] ?? 0).toBeGreaterThan(0);
    // Crashes land right after the money transitions were stored, and before any reply.
    expect(agg['crashAfterPersist:firing'] ?? 0).toBeGreaterThan(0);
    expect(agg['crashAfterPersist:sent:unsent'] ?? 0).toBeGreaterThan(0);
    expect(agg['crashAfterPersist:fallback-applied'] ?? 0).toBeGreaterThan(0);
  });
});

describe('auto-kill on anomalies (clock, latency, schema drift)', () => {
  it('latency: a 60-second check slower than 2 s is an anomaly, and the fallback applies', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, wakeAt() + ALARM_DELAY - SEC);
    shared.sgw.latency = 2500;
    await runTo(shared, END + 10 * MIN);
    const fb = audits(shared).find((a) => a.kind === 'snipe.fallback');
    expect(fb?.details).toMatchObject({ reason: 'anomaly', applied: 'early-proxy' });
    expect(String(audits(shared).find((a) => a.kind === 'snipe.disarm')?.details.why)).toMatch(/latency/);
    expect(transitions(stored(shared))).toContain('waking>fallback-applied');
    expect(shared.sgw.placeBids).toHaveLength(1);
  });

  it('clock: SGW more than 5 minutes off applies the fallback instead of firing on a bad clock', async () => {
    const shared = makeShared();
    shared.sgw.skew = 6 * MIN;
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, END + 10 * MIN);
    const fb = audits(shared).find((a) => a.kind === 'snipe.fallback');
    expect(fb?.details.reason).toBe('clock');
    expect(stored(shared).history.some((h) => h.to === 'firing')).toBe(false);
  });

  it('schema drift on a window read is an anomaly: killed, and the fallback degrades (writes now blocked)', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, wakeAt() + ALARM_DELAY - SEC);
    shared.sgw.detailFaults.push({ status: 200, bodyText: JSON.stringify({ drifted: true }), latencyMs: LATENCY });
    await runTo(shared, END + 2 * MIN);
    const s = stored(shared);
    expect(s.state).toBe('killed');
    expect(String(audits(shared).find((a) => a.kind === 'snipe.disarm')?.details.why)).toMatch(/schema drift/);
    expect(audits(shared).find((a) => a.kind === 'snipe.fallback')?.details).toMatchObject({ applied: 'skip', degradedBecause: 'writes-blocked' });
    expect(shared.sgw.placeBids).toHaveLength(0);
  });

  it('the price passed the max at the verify: no bid (skipped), and no fallback', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, END - SKEW - 2 * MIN);
    shared.sgw.item = { ...shared.sgw.item, price: 2500, minimumBid: 2600 };
    await runTo(shared, END + 2 * MIN);
    const s = stored(shared);
    expect(s).toMatchObject({ state: 'resolved', outcome: 'skipped' });
    expect(audits(shared).some((a) => a.kind === 'snipe.fallback')).toBe(false);
    expect(shared.sgw.placeBids).toHaveLength(0);
  });

  it('already the high bidder at the verify: no bid needed', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, END - SKEW - 2 * MIN);
    shared.sgw.item.high = true;
    await runTo(shared, END + 2 * MIN);
    expect(stored(shared)).toMatchObject({ state: 'resolved', outcome: 'skipped' });
    expect(shared.sgw.placeBids).toHaveLength(0);
  });
});

// ── T-84b: give-up settles through post-read-failed (brief item 1) ────────────

describe('T-84b: the 7-day give-up settles a sent snipe (post-read-failed)', () => {
  it('the give-up leaves a terminal snipe with exposure released and one final notification (the reducer\'s)', async () => {
    const shared = makeShared();
    // The worker dies right after `sent` is stored, before any PlaceBid: the
    // reply is lost, so the restart treats it as ambiguous (never a "no bid" claim).
    const first = await boot(shared, { crashAfterSet: crashOn('sent') });
    await arm(first.w);
    await runTo(shared, FIRE_LOCAL + 100);
    expect(first.w.life.dead).toBe(true);
    expect(stored(shared).state).toBe('sent');
    await boot(shared);
    await runTo(shared, FIRE_LOCAL + 5 * SEC);
    expect(stored(shared)).toMatchObject({ state: 'sent', attempt: { ambiguous: true } });
    shared.sgw.detailDown = net();
    const readsBefore = shared.sgw.details.length;
    expect(exposure([stored(shared)]).count).toBe(1); // a sent snipe still counts

    // The fast attempts fail: the early heads-up alert goes out, and the snipe stays sent.
    await runTo(shared, END + 45 * MIN);
    expect(stored(shared).state).toBe('sent');
    expect(shared.notifier.sent.find((n) => n.notification.title.startsWith('Unconfirmed'))?.notification.message).toMatch(/after 3 tries/);
    const notesBefore = shared.notifier.sent.length;

    // The slow retries fail for 7 days: the runner gives up through the reducer.
    await runTo(shared, END + 7 * DAY + 2 * HOUR);
    const s = stored(shared);
    expect(s.state).toBe('resolved');
    expect(s.attempt.ambiguous).toBe(true);
    expect(kinds(shared)).toContain('snipe.post-read-failed');
    expect(shared.sgw.details.length - readsBefore).toBe(POST_READ_FAST_ATTEMPTS + POST_READ_SLOW_ATTEMPTS);
    // Terminal: no more exposure, no snipe alarms, the runner entry is gone.
    expect(exposure([s]).count).toBe(0);
    expect(await snipeAlarms(shared)).toEqual([]);
    expect(runnerRecord(shared).entries.s1).toBeUndefined();
    // One final notification at the give-up, and it is the reducer's effect:
    // the classification heading, no "after N tries" runner card, no "no bid" claim.
    const after = shared.notifier.sent.slice(notesBefore);
    const snipeNotes = after.filter((n) => n.notification.title.includes(stored(shared).title));
    expect(snipeNotes).toHaveLength(1);
    expect(snipeNotes[0]?.notification.title).toBe(`Unconfirmed: ${stored(shared).title}`);
    expect(snipeNotes[0]?.notification.message).toMatch(/Check ShopGoodwill/i);
    expect(snipeNotes[0]?.notification.message).not.toMatch(/tries/i);
    expect(snipeNotes[0]?.notification.message).not.toMatch(NO_BID_CLAIM);
  });

  it('an accepted, leading reply makes both alerts say "Leading", never "Won" or "Not bid"', async () => {
    const shared = makeShared();
    const strategy: SendStrategy = {
      // T-101's seam: the accepted, leading reply (the fake SGW has no catalogue entry for it).
      send: (_req, deps) =>
        Promise.resolve({
          kind: 'result',
          result: {
            kind: 'accepted',
            rawStatus: null,
            rawResult: null,
            messageText: 'Bid placed',
            isHighBidder: true,
            observedAt: deps.clock.now(),
          },
        }),
    };
    const { w } = await boot(shared, {
      jobModules: probe((ctx) => {
        snipeSeams(ctx).setSendStrategy(strategy);
      }),
    });
    await arm(w);
    await runTo(shared, FIRE_LOCAL + 3 * SEC);
    expect(stored(shared)).toMatchObject({ state: 'sent', attempt: { reply: { kind: 'accepted' } } });
    shared.sgw.detailDown = net();

    // The early heads-up alert after the fast retries: the SAME classification as the reducer's.
    await runTo(shared, END + 45 * MIN);
    const early = shared.notifier.sent.find((n) => n.notification.title.startsWith('Leading'));
    expect(early?.notification.title).toBe(`Leading: ${stored(shared).title}`);
    expect(early?.notification.message).toMatch(/Leading when the bid went in/);
    expect(early?.notification.message).toMatch(/after 3 tries/);

    // The final notification at the give-up: the reducer's, from its effects.
    await runTo(shared, END + 7 * DAY + 2 * HOUR);
    const s = stored(shared);
    expect(s.state).toBe('resolved');
    expect(s.outcome).toBe('won');
    expect(kinds(shared)).toContain('snipe.post-read-failed');
    const finals = shared.notifier.sent.filter(
      (n) => n.notification.title.startsWith('Leading') && !/tries/.test(n.notification.message),
    );
    expect(finals).toHaveLength(1);
    expect(finals[0]?.notification.message).toMatch(/Leading when the bid went in/);
    for (const n of shared.notifier.sent) {
      expect(n.notification.title).not.toMatch(/^Won/);
      expect(n.notification.title).not.toMatch(/^Not bid/);
    }
  });

  it('a later successful read before the give-up still settles normally (post-read, never the give-up)', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, FIRE_LOCAL + 3 * SEC);
    expect(stored(shared).state).toBe('sent');
    shared.sgw.detailDown = net();
    await runTo(shared, END + 45 * MIN);
    expect(stored(shared).state).toBe('sent');

    // Storage heals long before the 7 days: the next slow read settles it.
    shared.sgw.detailDown = undefined;
    await runTo(shared, END + 20 * HOUR);
    expect(stored(shared).state).toBe('resolved');
    expect(kinds(shared)).toContain('snipe.post-read');
    expect(kinds(shared)).not.toContain('snipe.post-read-failed');
    expect(shared.sgw.placeBids).toHaveLength(1);
  });
});

// ── T-84b: a provably unsent bid resolves through not-sent (brief item 2) ─────

describe('T-84b: the SendStrategy seam routes not-sent', () => {
  it('a SendStrategy reporting not-sent resolves the snipe as not-sent (the default never retries)', async () => {
    const shared = makeShared();
    const strategy: SendStrategy = {
      send: () => Promise.resolve({ kind: 'not-sent', error: new Error('the write gate refused before any byte left') }),
    };
    const { w } = await boot(shared, {
      jobModules: probe((ctx) => {
        snipeSeams(ctx).setSendStrategy(strategy);
      }),
    });
    await arm(w);
    await runTo(shared, END + 2 * MIN);
    expect(shared.sgw.modals).toHaveLength(0);
    expect(shared.sgw.placeBids).toHaveLength(0);
    const s = stored(shared);
    expect(s.state).toBe('resolved');
    expect(s.attempt.notSent).toBe(true);
    expect(s.outcome).toBe('network');
    expect(s.outcomeDetail ?? '').toMatch(/provably never went out/);
    const notice = shared.notifier.sent.find((n) => n.notification.title.startsWith('Not bid'));
    expect(notice?.notification.message).toMatch(/No bid was sent/);
    expect(notice?.notification.message).toMatch(/write gate refused/);
  });

  it('a SendStrategy that throws BidNotSentError resolves as not-sent, and a generic throw stays ambiguous', async () => {
    const provable = makeShared();
    const { w: proved } = await boot(provable, {
      jobModules: probe((ctx) => {
        snipeSeams(ctx).setSendStrategy({
          send: () => Promise.reject(new BidNotSentError('paused', 'kill switch is on')),
        });
      }),
    });
    await arm(proved);
    await runTo(provable, END + 2 * MIN);
    expect(provable.sgw.placeBids).toHaveLength(0);
    expect(provable.http.requests.filter((r) => r.url.startsWith(PLACE_URL))).toHaveLength(0);
    expect(stored(provable)).toMatchObject({ state: 'resolved', outcome: 'network', attempt: { notSent: true } });
    expect(provable.notifier.sent.find((n) => n.notification.title.startsWith('Not bid'))?.notification.message).toMatch(
      /No bid was sent \(kill switch is on\)/,
    );

    const lost = makeShared();
    const { w } = await boot(lost, {
      jobModules: probe((ctx) => {
        snipeSeams(ctx).setSendStrategy({
          send: () => Promise.reject(new Error('socket hang up')),
        });
      }),
    });
    await arm(w);
    await runTo(lost, END + 10 * MIN);
    const s = stored(lost);
    expect(lost.sgw.placeBids).toHaveLength(0);
    expect(s.state).toBe('resolved');
    expect(s.attempt.ambiguous).toBe(true);
    expect(s.attempt.notSent).not.toBe(true);
    expect(lost.notifier.sent.some((n) => /No bid was sent/i.test(n.notification.message))).toBe(false);
    expect(kinds(lost)).toContain('bid.ambiguous');
    expect(kinds(lost)).not.toContain('bid.not-sent');
  });
});

// ── T-84b: verify-read order (brief item 3) ───────────────────────────────────

describe('T-84b: content exits win over the latency anomaly at the verify', () => {
  it('a slow verify read showing price-over-max aborts on price, with no early proxy', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, END - SKEW - 2 * MIN);
    expect(stored(shared).state).toBe('waking');
    shared.sgw.latency = 2500; // over MAX_RTT_MS
    shared.sgw.item = { ...shared.sgw.item, price: 2500, minimumBid: 2600 };
    await runTo(shared, END + 2 * MIN);

    const s = stored(shared);
    expect(s).toMatchObject({ state: 'resolved', outcome: 'skipped' });
    // The price exit, never the latency anomaly: no fallback, no disarm, nothing on the wire.
    expect(audits(shared).some((a) => a.kind === 'snipe.fallback')).toBe(false);
    expect(audits(shared).some((a) => a.kind === 'snipe.disarm')).toBe(false);
    expect(shared.sgw.modals).toHaveLength(0);
    expect(shared.sgw.placeBids).toHaveLength(0);
    const notice = shared.notifier.sent.find((n) => n.notification.title.startsWith('Not bid'));
    expect(notice?.notification.message).toMatch(/above your max/);
  });

  it('a slow verify read of a closed auction aborts as ended, with no early proxy', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, END - SKEW - 2 * MIN);
    expect(stored(shared).state).toBe('waking');
    shared.sgw.latency = 2500;
    shared.sgw.item.closed = true;
    await runTo(shared, END + 2 * MIN);

    const s = stored(shared);
    expect(s).toMatchObject({ state: 'resolved', outcome: 'ended' });
    expect(audits(shared).some((a) => a.kind === 'snipe.fallback')).toBe(false);
    expect(audits(shared).some((a) => a.kind === 'snipe.disarm')).toBe(false);
    expect(shared.sgw.modals).toHaveLength(0);
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(shared.notifier.sent.some((n) => n.notification.title.startsWith('Ended'))).toBe(true);
  });

  it('a slow verify read of a later end aborts as extended, with no early proxy', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, END - SKEW - 2 * MIN);
    expect(stored(shared).state).toBe('waking');
    shared.sgw.latency = 2500;
    shared.sgw.item.endMs = END + 30 * MIN;
    await runTo(shared, END + 2 * MIN);

    const s = stored(shared);
    expect(s).toMatchObject({ state: 'resolved', outcome: 'extended' });
    expect(audits(shared).some((a) => a.kind === 'snipe.fallback')).toBe(false);
    expect(audits(shared).some((a) => a.kind === 'snipe.disarm')).toBe(false);
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(shared.sgw.modals).toHaveLength(0);
  });

  it('a slow verify read where the user is already high aborts as already-high, with no early proxy', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w);
    await runTo(shared, END - SKEW - 2 * MIN);
    expect(stored(shared).state).toBe('waking');
    shared.sgw.latency = 2500;
    shared.sgw.item.high = true;
    await runTo(shared, END + 2 * MIN);

    expect(stored(shared)).toMatchObject({ state: 'resolved', outcome: 'skipped' });
    expect(audits(shared).some((a) => a.kind === 'snipe.fallback')).toBe(false);
    expect(audits(shared).some((a) => a.kind === 'snipe.disarm')).toBe(false);
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(shared.notifier.sent.find((n) => n.notification.title.startsWith('No bid needed'))?.notification.message).toMatch(
      /already the high bidder/i,
    );
  });
});

// ── T-84b: dispatch refuses attempt events from outside (brief item 4) ────────

describe('T-84b: dispatch refuses attempt events from outside', () => {
  it('an outside result or post-read-failed is refused and changes nothing', async () => {
    const shared = makeShared();
    const { w, ctx } = await boot(shared);
    await arm(w);
    await runTo(shared, FIRE_LOCAL + 3 * SEC);
    expect(stored(shared).state).toBe('sent');
    const runner = getSnipeRunner(ctx);
    if (runner === undefined) throw new Error('no runner');
    const before = stored(shared);
    const now = shared.clock.now();
    const detail = normalizeItemDetail(shared.sgw.raw(), { observedAt: now, authenticated: true });
    const attempts: SnipeEvent[] = [
      { type: 'sent', now, key: 'outside' },
      {
        type: 'result',
        now,
        result: { kind: 'accepted', rawStatus: null, rawResult: null, messageText: 'outside', isHighBidder: true, observedAt: now },
      },
      { type: 'ambiguous', now },
      { type: 'post-read', now, detail },
      { type: 'post-read-failed', now },
      { type: 'not-sent', now, reason: 'outside' },
    ];
    for (const e of attempts) {
      const r = await runner.dispatch('s1', e);
      expect(r.kind).toBe('rejected');
      if (r.kind === 'rejected') expect(r.rejection.reason).toBe('invalid-event');
    }
    expect(stored(shared)).toEqual(before);
    expect(stored(shared).state).toBe('sent');
    // disarm is not an attempt event. On a sent snipe the reducer refuses it; the runner does not.
    const disarm = await runner.dispatch('s1', { type: 'disarm', now, by: 'user', why: 'stop' });
    expect(disarm.kind).toBe('rejected');
    if (disarm.kind === 'rejected') expect(disarm.rejection.reason).toBe('already-sent');
    expect(stored(shared)).toEqual(before);
    // The runner's own outcome read still settles it.
    await runTo(shared, END + 2 * MIN);
    expect(stored(shared).state).toBe('resolved');
    expect(shared.sgw.placeBids).toHaveLength(1);
  });

  it('an outside disarm of an armed snipe still stops it, and sends nothing', async () => {
    const shared = makeShared();
    const { w, ctx } = await boot(shared);
    await arm(w);
    expect(stored(shared).state).toBe('armed');
    const runner = getSnipeRunner(ctx);
    if (runner === undefined) throw new Error('no runner');
    const r = await runner.dispatch('s1', { type: 'disarm', now: shared.clock.now(), by: 'user', why: 'the user stopped it' });
    expect(r.kind).toBe('accepted');
    await flush();
    expect(stored(shared).state).toBe('killed');
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(shared.sgw.modals).toHaveLength(0);
    expect(shared.http.requests.filter((req) => req.url.startsWith(PLACE_URL))).toHaveLength(0);
  });
});

// ── T-84c: dispatch allow-list (brief item 1) ────────────────────────────────

describe('T-84c: dispatch allow-list', () => {
  it('an outside wake, verified, verify-failed, fire, preflight-failed or apply-fallback is refused, and the state is unchanged', async () => {
    const shared = makeShared();
    const { w, ctx } = await boot(shared);
    await arm(w);
    await runTo(shared, END - SKEW - 30 * SEC); // the verify read is done: 'verified'
    expect(stored(shared).state).toBe('verified');
    const runner = getSnipeRunner(ctx);
    if (runner === undefined) throw new Error('no runner');
    const before = stored(shared);
    const now = shared.clock.now();
    const detail = normalizeItemDetail(shared.sgw.raw(), { observedAt: now, authenticated: true });
    const outside: SnipeEvent[] = [
      { type: 'wake', now },
      { type: 'verified', now, detail, offsetMs: SKEW, rttMs: LATENCY },
      { type: 'verify-failed', now, reason: 'network' },
      { type: 'fire', now },
      { type: 'preflight-failed', now, reason: 'clock' },
      { type: 'apply-fallback', now, mode: 'skip' },
    ];
    for (const e of outside) {
      const r = await runner.dispatch('s1', e);
      expect(r.kind).toBe('rejected');
      if (r.kind === 'rejected') expect(r.rejection.reason).toBe('invalid-event');
    }
    expect(stored(shared)).toEqual(before);
    // The runner's own path still fires and sends exactly one bid.
    await runTo(shared, END + 2 * MIN);
    expect(stored(shared).state).toBe('resolved');
    expect(shared.sgw.placeBids).toHaveLength(1);
  });

  it('no other module can feed fire, sent or result: there is no unguarded feed, and the ended-early path takes only its two ended events', async () => {
    const shared = makeShared();
    const { w, ctx } = await boot(shared);
    await arm(w);
    await runTo(shared, END - SKEW - 30 * SEC);
    expect(stored(shared).state).toBe('verified');
    const runner = getSnipeRunner(ctx);
    if (runner === undefined) throw new Error('no runner');
    // The public ways to commit an event: dispatch (disarm, arm) and endedEarly (T-103's post-end).
    expect('feed' in runner).toBe(false);
    const before = stored(shared);
    const now = shared.clock.now();
    const detail = normalizeItemDetail(shared.sgw.raw(), { observedAt: now, authenticated: true });
    const notEnded: SnipeEvent[] = [
      { type: 'fire', now },
      { type: 'sent', now, key: 'outside' },
      {
        type: 'result',
        now,
        result: { kind: 'accepted', rawStatus: null, rawResult: null, messageText: 'outside', isHighBidder: true, observedAt: now },
      },
      { type: 'ambiguous', now },
      { type: 'post-read', now, detail },
      { type: 'post-read-failed', now },
      { type: 'not-sent', now, reason: 'outside' },
      { type: 'wake', now },
      { type: 'verified', now, detail, offsetMs: SKEW, rttMs: LATENCY },
      { type: 'verify-failed', now, reason: 'network' },
      { type: 'preflight-failed', now, reason: 'clock' },
      { type: 'apply-fallback', now, mode: 'skip' },
      { type: 'arm', now },
      { type: 'disarm', now, by: 'user', why: 'outside' },
    ];
    for (const e of notEnded) {
      const r = await runner.endedEarly('s1', e);
      expect(r.kind).toBe('rejected');
      if (r.kind === 'rejected') expect(r.rejection.reason).toBe('invalid-event');
    }
    expect(stored(shared)).toEqual(before);
    await runTo(shared, END + 2 * MIN);
    expect(stored(shared).state).toBe('resolved');
    expect(shared.sgw.placeBids).toHaveLength(1);
  });
});

// ── T-84c: at-risk notifications (brief items 3 and 4) ───────────────────────

/** A snipe ending at Oct 12 03:00Z: the 24 h check runs at Oct 11 03:00Z, the 1 h check at Oct 12 02:00Z. */
const LONG_END = Date.UTC(2026, 9, 12, 3, 0, 0);
/** A snipe ending at Oct 11 03:00Z: the 1 h check runs at Oct 11 02:00Z (inside quiet hours). */
const SHORT_END = Date.UTC(2026, 9, 11, 3, 0, 0);
const QUIET_24_CHECK = Date.UTC(2026, 9, 11, 3, 0, 0);
const QUIET_END = Date.UTC(2026, 9, 11, 7, 0, 0);
const LONG_1H_CHECK = Date.UTC(2026, 9, 12, 2, 0, 0);

const AUTH_FAIL = { ok: false as const, reason: 'logged-out', detail: 'You are not signed in to ShopGoodwill. Sign in to ShopGoodwill in this browser.' };
const AUTH_OK = { ok: true as const };

function quietSettings(): Settings {
  const s = settingsWith({ live: true });
  s.locale.timeZone = 'UTC';
  s.notifications.quietHours = { from: '22:00', to: '07:00' };
  return s;
}

describe('T-84c: at-risk notifications and quiet hours', () => {
  it('a 24 h failure at 3 AM inside quiet hours is delivered at the quiet-hours end', async () => {
    const shared = makeShared({ settings: quietSettings() });
    const { w } = await boot(shared, {
      jobModules: probe((ctx) => {
        snipeSeams(ctx).setAuthHealth({ check: () => Promise.resolve(AUTH_FAIL) });
      }),
    });
    const sentAt: number[] = [];
    const realNotify = shared.notifier.notify.bind(shared.notifier);
    shared.notifier.notify = (n) => {
      sentAt.push(shared.clock.now());
      return realNotify(n);
    };
    shared.sgw.item.endMs = LONG_END;
    await arm(w);
    await runTo(shared, QUIET_24_CHECK + ALARM_DELAY + SEC);
    // Inside quiet hours: the failure is audited, the alert waits for 07:00.
    expect(kinds(shared)).toContain('snipe.at-risk');
    expect(shared.notifier.sent.filter((n) => n.notification.title.startsWith('Snipe at risk'))).toHaveLength(0);
    const deferred = (await snipeAlarms(shared)).find((a) => a.name === snipeAlarmName('s1', 'atrisk-defer'));
    expect(deferred?.scheduledTime).toBe(QUIET_END);
    await runTo(shared, QUIET_END + ALARM_DELAY + SEC);
    const alerts = shared.notifier.sent.filter((n) => n.notification.title.startsWith('Snipe at risk'));
    expect(alerts).toHaveLength(1);
    expect(sentAt[0]).toBeGreaterThanOrEqual(QUIET_END);
  });

  it('a 1 h failure inside quiet hours is delivered at once', async () => {
    const shared = makeShared({ settings: quietSettings() });
    const { w } = await boot(shared, {
      jobModules: probe((ctx) => {
        snipeSeams(ctx).setAuthHealth({ check: () => Promise.resolve(AUTH_FAIL) });
      }),
    });
    shared.sgw.item.endMs = SHORT_END;
    await arm(w);
    await runTo(shared, SHORT_END - HOUR + ALARM_DELAY + SEC); // Oct 11 02:00:45Z, inside quiet hours
    const alerts = shared.notifier.sent.filter((n) => n.notification.title.startsWith('Snipe at risk'));
    expect(alerts).toHaveLength(1);
    expect((await snipeAlarms(shared)).some((a) => a.name === snipeAlarmName('s1', 'atrisk-defer'))).toBe(false);
  });

  it('fail at 24 h, pass at 1 h: atRisk is cleared', async () => {
    const shared = makeShared();
    const { w } = await boot(shared, {
      jobModules: probe((ctx) => {
        snipeSeams(ctx).setAuthHealth({ check: (_s, which) => Promise.resolve(which === '24h' ? AUTH_FAIL : AUTH_OK) });
      }),
    });
    shared.sgw.item.endMs = LONG_END;
    await arm(w);
    await runTo(shared, QUIET_24_CHECK + ALARM_DELAY + SEC);
    expect(runnerRecord(shared).entries.s1?.atRisk).toBe('health24:logged-out');
    expect(shared.notifier.sent.filter((n) => n.notification.title.startsWith('Snipe at risk'))).toHaveLength(1);
    await runTo(shared, LONG_1H_CHECK + ALARM_DELAY + SEC);
    expect(runnerRecord(shared).entries.s1?.atRisk).toBeUndefined();
    expect(shared.notifier.sent.filter((n) => n.notification.title.startsWith('Snipe at risk'))).toHaveLength(1);
  });

  it('fail at 24 h, fail again at 1 h: notified twice, once per check', async () => {
    const shared = makeShared();
    const { w } = await boot(shared, {
      jobModules: probe((ctx) => {
        snipeSeams(ctx).setAuthHealth({ check: () => Promise.resolve(AUTH_FAIL) });
      }),
    });
    shared.sgw.item.endMs = LONG_END;
    await arm(w);
    await runTo(shared, QUIET_24_CHECK + ALARM_DELAY + SEC);
    await runTo(shared, LONG_1H_CHECK + ALARM_DELAY + SEC);
    const alerts = shared.notifier.sent.filter((n) => n.notification.title.startsWith('Snipe at risk'));
    expect(alerts).toHaveLength(2);
    expect(kinds(shared).filter((k) => k === 'snipe.at-risk')).toHaveLength(2);
  });
});

// ── T-84c review: midnight, DST, the alarm delay, duplicate deliveries ───────

/** Wall times at which a "Snipe at risk" alert was sent. */
function trackAtRiskTimes(shared: Shared): number[] {
  const at: number[] = [];
  const realNotify = shared.notifier.notify.bind(shared.notifier);
  shared.notifier.notify = (n) => {
    if (n.title.startsWith('Snipe at risk')) at.push(shared.clock.now());
    return realNotify(n);
  };
  return at;
}

const failingAuth = (): Record<string, BackgroundModule> =>
  probe((ctx) => {
    snipeSeams(ctx).setAuthHealth({ check: () => Promise.resolve(AUTH_FAIL) });
  });

describe('T-84c review: the 24 h at-risk alert across midnight and DST, and never twice per check', () => {
  it('a 24 h failure at 23:00, before midnight, waits for 07:00 the next morning', async () => {
    const end = Date.UTC(2026, 9, 11, 23, 0, 0); // the 24 h check runs Oct 10 ~23:00Z
    const morning = Date.UTC(2026, 9, 11, 7, 0, 0);
    const shared = makeShared({ settings: quietSettings() });
    const { w } = await boot(shared, { jobModules: failingAuth() });
    const sentAt = trackAtRiskTimes(shared);
    shared.sgw.item.endMs = end;
    await arm(w);
    await runTo(shared, end - DAY + ALARM_DELAY + SEC);
    expect(kinds(shared)).toContain('snipe.at-risk');
    expect(sentAt).toHaveLength(0);
    const deferred = (await snipeAlarms(shared)).find((a) => a.name === snipeAlarmName('s1', 'atrisk-defer'));
    expect(deferred?.scheduledTime).toBe(morning);
    await runTo(shared, morning + ALARM_DELAY + SEC);
    expect(sentAt).toHaveLength(1);
    expect(sentAt[0]).toBeGreaterThanOrEqual(morning);
    expect(sentAt[0]).toBeLessThan(end - HOUR);
  });

  it('across the fall-back night (America/New_York), the 24 h alert waits for the real 07:00 EST', async () => {
    // Nov 1 2026: 02:00 EDT falls back to 01:00 EST. The 24 h check runs at 23:30 EDT on
    // Oct 31 (03:30Z); 07:00 EST is 12:00Z (07:00 EDT would be 11:00Z).
    const end = Date.UTC(2026, 10, 2, 3, 30, 0);
    const morning = Date.UTC(2026, 10, 1, 12, 0, 0);
    const settings = quietSettings();
    settings.locale.timeZone = 'America/New_York';
    const shared = makeShared({ settings });
    shared.clock.set(Date.UTC(2026, 9, 31, 12, 0, 0)); // before the boot: nothing is scheduled yet
    const { w } = await boot(shared, { jobModules: failingAuth() });
    const sentAt = trackAtRiskTimes(shared);
    shared.sgw.item.endMs = end;
    await arm(w);
    await runTo(shared, end - DAY + ALARM_DELAY + SEC);
    expect(kinds(shared)).toContain('snipe.at-risk');
    expect(sentAt).toHaveLength(0);
    const deferred = (await snipeAlarms(shared)).find((a) => a.name === snipeAlarmName('s1', 'atrisk-defer'));
    expect(deferred?.scheduledTime).toBe(morning);
    await runTo(shared, morning - MIN);
    expect(sentAt).toHaveLength(0);
    await runTo(shared, morning + ALARM_DELAY + SEC);
    expect(sentAt).toHaveLength(1);
    expect(sentAt[0]).toBeGreaterThanOrEqual(morning);
  });

  it('a deferral that would land within 1 h of the end once its alarm fires 60 s late goes out at once', async () => {
    // Quiet 02:30-01:59 (UTC): the 24 h check (Oct 11 ~03:01Z) is inside it and the window ends
    // Oct 12 01:59Z. Deferred, a 60 s-late alarm would deliver at 02:00Z: not more than 1 h before the end.
    const settings = quietSettings();
    settings.notifications.quietHours = { from: '02:30', to: '01:59' };
    const shared = makeShared({ settings, alarmDelayMs: 60 * SEC });
    const { w } = await boot(shared, { jobModules: failingAuth() });
    const sentAt = trackAtRiskTimes(shared);
    shared.sgw.item.endMs = LONG_END;
    await arm(w);
    await runTo(shared, LONG_1H_CHECK + 30 * SEC); // before the 1 h check's alarm (02:00:58.7Z)
    expect(sentAt).toHaveLength(1);
    expect(sentAt[0]).toBeLessThan(LONG_END - SKEW - HOUR);
  });

  it('duplicate or late deliveries of the 24 h, deferred and 1 h alarms never alert twice for the same check', async () => {
    const shared = makeShared({ settings: quietSettings() });
    const { w } = await boot(shared, { jobModules: failingAuth() });
    const sentAt = trackAtRiskTimes(shared);
    shared.sgw.item.endMs = LONG_END;
    await arm(w);
    await runTo(shared, QUIET_24_CHECK + ALARM_DELAY + SEC);
    expect(sentAt).toHaveLength(0); // deferred to 07:00
    // A duplicate 24 h alarm while the alert is deferred: nothing more is said or scheduled.
    w.deliverAlarm(snipeAlarmName('s1', 'health24'));
    await flush();
    expect(sentAt).toHaveLength(0);
    // The deferred delivery, duplicated, at the same moment: one alert.
    w.deliverAlarm(snipeAlarmName('s1', 'atrisk-defer'));
    w.deliverAlarm(snipeAlarmName('s1', 'atrisk-defer'));
    await flush(10);
    expect(sentAt).toHaveLength(1);
    // Its real alarm at 07:00 is then a late duplicate.
    await runTo(shared, QUIET_END + ALARM_DELAY + SEC);
    expect(sentAt).toHaveLength(1);
    // The 1 h check, duplicated at the same moment: one more alert, for the 1 h check.
    await runTo(shared, LONG_1H_CHECK - MIN);
    w.deliverAlarm(snipeAlarmName('s1', 'health1'));
    w.deliverAlarm(snipeAlarmName('s1', 'health1'));
    await flush(10);
    expect(sentAt).toHaveLength(2);
    await runTo(shared, LONG_1H_CHECK + ALARM_DELAY + SEC);
    expect(sentAt).toHaveLength(2);
    expect(runnerRecord(shared).entries.s1?.atRisk).toBe('health1:logged-out');
    // A deferred 24 h delivery that arrives after the 1 h check says nothing.
    w.deliverAlarm(snipeAlarmName('s1', 'atrisk-defer'));
    await flush(10);
    expect(sentAt).toHaveLength(2);
    expect(runnerRecord(shared).entries.s1?.atRisk).toBe('health1:logged-out');
  });
});

// ── T-84b: slow storage start copy (brief item 5) ─────────────────────────────

describe('T-84b: a slow storage start fails closed with plain copy', () => {
  it('the disarm notification says the storage did not start in time and never claims a bid was placed', async () => {
    const shared = makeShared();
    const first = await boot(shared);
    await arm(first.w);
    await runTo(shared, END - SKEW - 30 * SEC);
    expect(stored(shared).state).toBe('verified');
    first.w.kill();

    // The next worker's storage answers only after 6 s: the 5 s switch-snapshot deadline passes first.
    const realGet = shared.areas.local.get.bind(shared.areas.local);
    let delayed = true;
    shared.areas.local.get = async <T>(key: string): Promise<T | undefined> => {
      if (delayed && key === STORAGE_KEYS.settings) {
        delayed = false;
        await new Promise<void>((resolve) => {
          shared.clock.setTimeout(resolve, 6 * SEC);
        });
      }
      return realGet<T>(key);
    };

    const pending = boot(shared);
    // Let migrate and the switch-snapshot load start (and its 5 s deadline timer register) before advancing.
    await flush(6);
    shared.clock.advance(SWITCHES_LOAD_TIMEOUT_MS + 2 * SEC);
    await flush();
    await pending;
    await flush(5);

    const s = stored(shared);
    expect(s.state).toBe('killed');
    expect(s.outcome).toBe('skipped');
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(shared.sgw.modals).toHaveLength(0);
    const notice = shared.notifier.sent.find((n) => n.notification.title.startsWith('Snipe skipped'));
    expect(notice?.notification.message).toMatch(/did not start in time/);
    expect(notice?.notification.message).toMatch(/skipped for safety/);
    expect(notice?.notification.message).toMatch(/No bid was placed/);
    expect(String(audits(shared).find((a) => a.kind === 'snipe.disarm')?.details.why)).toMatch(/did not start in time/);
    // The honest denial is the only "placed" sentence. A claim that a bid went out fails this.
    const denialStripped = (notice?.notification.message ?? '').replace(/No bid was placed\./g, '');
    expect(denialStripped).not.toMatch(/bid was placed|placing your max|you (won|lead)|early proxy bid instead/i);
  });
});

describe('T-84b: a dry-run measure give-up has no money effect', () => {
  it('giving up on the dry-run measure read resolves as dry-run and sends nothing', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await arm(w, { dryRun: true });
    await runTo(shared, FIRE_LOCAL - 10);
    expect(stored(shared).state).toBe('verified');
    expect(stored(shared).dryRun).toBe(true);
    shared.sgw.detailDown = net();
    await runTo(shared, END + 45 * MIN);

    const s = stored(shared);
    expect(s).toMatchObject({ state: 'resolved', outcome: 'dry-run' });
    expect(kinds(shared)).toContain('snipe.post-read-failed');
    expect(kinds(shared)).not.toContain('bid.sent');
    expect(kinds(shared)).not.toContain('snipe.fallback');
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(shared.sgw.modals).toHaveLength(0);
    expect(shared.http.requests.filter((r) => r.url.startsWith(PLACE_URL))).toHaveLength(0);
    expect(shared.http.requests.filter((r) => r.url.startsWith(MODAL_URL))).toHaveLength(0);
    const notice = shared.notifier.sent.find((n) => n.notification.title.startsWith('Dry run'));
    expect(notice?.notification.title).toBe(`Dry run: ${s.title}`);
    expect(notice?.notification.message).toMatch(/would have bid/i);
    expect(notice?.notification.message).toMatch(/measure failed/i);
    expect(notice?.notification.message).not.toMatch(/may have been placed|No bid was sent/i);
    expect(shared.notifier.sent.some((n) => n.notification.title.startsWith('Unconfirmed'))).toBe(false);
    expect(exposure([s]).count).toBe(0);
  });
});

// ── T-84b final check (Opus) ──────────────────────────────────────────────────

describe('T-84b final check: a failed not-sent write', () => {
  it('a not-sent write that fails (nothing stored) still resolves as not-sent in the same worker: never ambiguous, never resent, never an outbid', async () => {
    const shared = makeShared();
    let failing = true;
    const { w } = await boot(shared, {
      // The first `not-sent` write fails and nothing is stored: the snipe stays `sent` with no reply.
      failSet: (area, entries) => {
        const s = snipesIn(entries)?.s1;
        if (!failing || area !== 'local' || s?.attempt.notSent !== true) return false;
        failing = false;
        return true;
      },
    });
    await arm(w);
    await runTo(shared, FIRE_LOCAL - 10);
    // ShowBidModal fails: bid.ts throws BidNotSentError, so PlaceBid never left.
    shared.http.on(MODAL_URL, { status: 500, latencyMs: LATENCY });
    await runTo(shared, FIRE_LOCAL + 5 * SEC);
    expect(failing).toBe(false);
    expect(w.life.dead).toBe(false);
    expect(stored(shared).state).toBe('sent');
    expect(stored(shared).attempt.notSent).not.toBe(true);

    await runTo(shared, END + 10 * MIN);
    const s = stored(shared);
    // Nothing was ever resent: one modal read, no PlaceBid byte.
    expect(shared.http.requests.filter((r) => r.url.startsWith(MODAL_URL))).toHaveLength(1);
    expect(shared.http.requests.filter((r) => r.url.startsWith(PLACE_URL))).toHaveLength(0);
    expect(s.history.filter((h) => h.to === 'sent' && h.from !== 'sent')).toHaveLength(1);
    // The worker still knows the bid provably never left: not-sent, never the ambiguous read.
    expect(s.state).toBe('resolved');
    expect(s.attempt.notSent).toBe(true);
    expect(s.attempt.ambiguous).not.toBe(true);
    expect(s.outcome).toBe('network');
    expect(kinds(shared)).not.toContain('bid.ambiguous');
    expect(kinds(shared)).not.toContain('snipe.post-read');
    const notice = shared.notifier.sent.find((n) => n.notification.title.startsWith('Not bid'));
    expect(notice?.notification.message).toMatch(/No bid was sent/);
    // Honest copy: no claim that a bid went out, was outbid, or may have been placed.
    for (const n of shared.notifier.sent) {
      expect(n.notification.title).not.toMatch(/^(Lost|Won|Leading|Outbid|Unconfirmed)\b/);
      expect(n.notification.message).not.toMatch(/Lost: outbid|Currently outbid|Outbid when|may have been placed|bid response was lost/i);
    }
  });
});

describe('T-118 F4: arming without the notifications permission warns and audits, never blocks', () => {
  it('a snipe armed while notifications are not allowed arms and records snipe.notify-off', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    const armed = await arm(w);
    expect(armed.state).toBe('armed');
    const off = audits(shared).filter((a) => a.kind === 'snipe.notify-off');
    expect(off).toHaveLength(1);
    expect(off[0]?.ref).toBe('s1');
    expect(off[0]?.itemId).toBe(ITEM);
  });

  it('with notifications allowed, nothing extra is audited', async () => {
    const shared = makeShared();
    await shared.permissions.request({ permissions: ['notifications'] });
    const { w } = await boot(shared);
    await arm(w);
    expect(kinds(shared)).not.toContain('snipe.notify-off');
  });

  it('a permissions check that throws still arms (fail open on the warning, never on the arm)', async () => {
    const shared = makeShared();
    shared.permissions.contains = () => Promise.reject(new Error('no API'));
    const { w } = await boot(shared);
    const armed = await arm(w);
    expect(armed.state).toBe('armed');
    expect(kinds(shared)).toContain('snipe.notify-off');
  });
});

describe('T-121: a snipe the browser slept through an on-time end is Missed, not Ended early', () => {
  /** Arms, lets the computer sleep from `sleepAt` until `wakeAt`, then starts a fresh worker (the browser coming back). */
  async function sleepThrough(shared: Shared, sleepAt: number, resumeAt: number): Promise<{ stamps: string[] }> {
    const first = await boot(shared);
    await arm(first.w);
    await runTo(shared, sleepAt);
    first.w.kill();
    // Asleep: no worker runs; whatever alarms fall due are lost with it.
    await runTo(shared, resumeAt);
    const { ctx } = await boot(shared);
    const stamps: string[] = [];
    snipeSeams(ctx).setCalendarStamper({
      stamp: (_s, outcome) => {
        stamps.push(outcome);
        return Promise.resolve();
      },
    });
    await runTo(shared, END + 2 * MIN);
    return { stamps };
  }

  it('asleep from before the wake until after the end: the verify read on resume shows the on-time close; Missed, MISSED stamp, nothing sent', async () => {
    const shared = makeShared();
    const { stamps } = await sleepThrough(shared, END - 20 * MIN, END + 40 * SEC);

    const s = stored(shared);
    expect(s).toMatchObject({ state: 'resolved', outcome: 'skipped' });
    expect(settledAsMissed(s)).toBe(true);
    expect(s.outcomeDetail).toBe('Missed: the browser was not awake when the auction ended; no bid sent.');
    expect(transitions(s)).toEqual(['draft>armed', 'armed>waking', 'waking>resolved']);
    // Nothing on the wire, and no early proxy: the auction was already over.
    expect(shared.sgw.modals).toHaveLength(0);
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(kinds(shared)).not.toContain('snipe.fallback');
    const titles = shared.notifier.sent.map((n) => n.notification.title);
    expect(titles).toEqual([`Missed: ${s.title}`]);
    expect(shared.notifier.sent[0]?.notification.message).toMatch(/^The browser was not awake when the auction ended/);
    expect(titles.some((t) => /ended early/i.test(t))).toBe(false);
    expect(stamps).toEqual(['missed']);
  });

  it('asleep after the verify, through the fire and the end: still the fire-after-end Missed copy (T-87c), unchanged', async () => {
    const shared = makeShared();
    await sleepThrough(shared, END - SKEW - 30 * SEC, END + 40 * SEC);

    const s = stored(shared);
    expect(s).toMatchObject({ state: 'resolved', outcome: 'skipped' });
    expect(shared.sgw.placeBids).toHaveLength(0);
    expect(shared.notifier.sent.map((n) => n.notification.title)).toContain(`Missed: the browser wasn't running at the end: ${s.title}`);
  });

  it('an auction SGW closed before its end, seen by an awake runner, stays Ended early', async () => {
    const shared = makeShared();
    const { w, ctx } = await boot(shared);
    const stamps: string[] = [];
    snipeSeams(ctx).setCalendarStamper({
      stamp: (_s, outcome) => {
        stamps.push(outcome);
        return Promise.resolve();
      },
    });
    await arm(w);
    await runTo(shared, END - SKEW - 2 * MIN);
    shared.sgw.item.closed = true; // withdrawn in the window, before the end
    await runTo(shared, END + 2 * MIN);

    const s = stored(shared);
    expect(s).toMatchObject({ state: 'resolved', outcome: 'ended' });
    expect(settledAsMissed(s)).toBe(false);
    expect(shared.notifier.sent.map((n) => n.notification.title)).toContain(`Ended early: ${s.title}`);
    expect(stamps).toEqual(['ended-early']);
  });
});
