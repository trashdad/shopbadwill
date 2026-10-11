// T-52: the scheduler (`sbw:tick`, reconcile, catch-up), the DailyJob runner
// (one step per tick on lane `background`, drains on lane `interactive` for
// job.runNow), the step-executor registry, the job.* / watches.* / tracked.*
// handlers and the `sbw:job-progress` port.
//
// Everything runs through T-36's real composition root (startBackground) on
// fakes: FakeClock, FakeStorageAreas, FakeAlarms, FakeNotifier,
// FakePermissions and FakeHttp, which answers only what a test scripts, so an
// unexpected SGW request fails loudly. The real SgwApiAdapter and
// RequestScheduler sit between the runner and FakeHttp, so lane spacing,
// budgets and backoff are the production ones. No live network (R5).
import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import type { BackgroundContext, RuntimePort } from '../../src/background/context';
import { HANDLER_MODULES } from '../../src/background/handlers/index';
import { JOB_MODULES } from '../../src/background/jobs/index';
import {
  DailyJobRunner,
  isPolicySkip,
  MAX_FAVORITE_RETRIES_PER_RUN,
  PERMISSION_NOTIFICATION_ID,
  runFailures,
  runnerFor,
  SGW_HOST_ORIGINS,
} from '../../src/background/jobs/daily-job-runner';
import { CATCH_UP_GRACE_MS, schedulerFor, TICK_ALARM, TICK_PERIOD_MINUTES } from '../../src/background/jobs/scheduler';
import { FAVORITE_SKIP_PREFIX } from '../../src/background/jobs/steps/favorite';
import { createStepRegistry, STEP_MODULES, STEP_SKIP_PREFIX, type StepDeps } from '../../src/background/jobs/steps/index';
import { startBackground, type BackgroundBrowser, type BackgroundHandle } from '../../src/background/main';
import type { MessageResponse, RouterSender } from '../../src/background/router';
import { MAX_STEP_ATTEMPTS } from '../../src/domain/jobs/daily-job';
import type { Rule } from '../../src/domain/rules/schema';
import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import { STORAGE_KEYS, STORAGE_LIMITS } from '../../src/domain/storage/schema';
import type { AuditEntry } from '../../src/domain/audit/types';
import type { SgwSessionRecord, TrackedItem } from '../../src/domain/types';
import type { JobRun, Watch } from '../../src/domain/watches/schema';
import { PORT_NAMES } from '../../src/messaging/protocol';
import type { HttpRequest } from '../../src/ports/http';
import { loadFixture } from '../contract/sgw/fixtures';
import { FakeAlarms } from '../fakes/ports/fake-alarms';
import { FakeClock } from '../fakes/ports/fake-clock';
import { FakeHttp, type HttpStep } from '../fakes/ports/fake-http';
import { FakeKeepAlive } from '../fakes/ports/fake-keepalive';
import { FakeKeepAwake } from '../fakes/ports/fake-keepawake';
import { FakeNotifier } from '../fakes/ports/fake-notifier';
import { FakePermissions } from '../fakes/ports/fake-permissions';
import { FakeStorageAreas } from '../fakes/ports/fake-storage';

// ── Time ─────────────────────────────────────────────────────────────────────

/** Saturday 2026-10-10 11:00 in New York (EDT, UTC-4). */
const T0 = Date.UTC(2026, 9, 10, 15, 0, 0);
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TICK = TICK_PERIOD_MINUTES * MIN;
/** The next 07:00 New York after T0 (the default dailyRun.localTime). */
const NEXT_SLOT = Date.UTC(2026, 9, 11, 11, 0, 0);
/** Every item in these tests ends here (Pacific naive, as SGW sends it). */
const ITEM_END_RAW = '2026-10-20T12:00:00';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const API = 'https://buyerapi.shopgoodwill.com/api/';
const EXT_ID = 'test-extension-id';
const EXT_ORIGIN = `chrome-extension://${EXT_ID}/`;
const UI: RouterSender = { id: EXT_ID, url: `${EXT_ORIGIN}options.html` };

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
const SESSION_EXP = T0 + 30 * DAY;
const BEARER = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ BuyerId: '42', exp: Math.floor(SESSION_EXP / 1000), jti: 'j1' })}.c2ln`;
const SESSION: SgwSessionRecord = { bearer: BEARER, capturedAt: T0 - MIN, expiresAt: SESSION_EXP, buyerId: '42', source: 'tap' };
const META = { schemaVersion: 1, installedAt: T0 - DAY, lastMigrationAt: T0 - DAY };

type Row = Record<string, unknown>;

/** One ItemListing row (dollars, Pacific naive end time). */
function row(itemId: number, dollars = 12): Row {
  const raw = loadFixture<{ searchResults: { items: Row[] } }>('search-grid-p1');
  const base = raw.searchResults.items[0] ?? {};
  return { ...base, itemId, title: `Pyrex bowl ${String(itemId)}`, currentPrice: dollars, minimumBid: dollars, endTime: ITEM_END_RAW };
}

function searchReply(rows: Row[], total: number = rows.length): unknown {
  const raw = loadFixture<{ searchResults: { items: Row[]; itemCount: number } }>('search-grid-p1');
  raw.searchResults.items = rows;
  raw.searchResults.itemCount = total;
  return raw;
}

/** `count` rows with ids from `first`. */
function rows(first: number, count: number, dollars = 12): Row[] {
  return Array.from({ length: count }, (_, i) => row(first + i, dollars));
}

/** An open item's detail; $5, like the rows the cheap rule selects. */
function detailReply(itemId: number, dollars = 5): unknown {
  const raw = loadFixture<Record<string, unknown> & { bidHistory: Record<string, unknown> }>('item-detail-open');
  raw.itemId = itemId;
  raw.currentPrice = dollars;
  raw.minimumBid = dollars;
  raw.title = `Pyrex bowl ${String(itemId)}`;
  raw.endTime = ITEM_END_RAW;
  raw.serverTime = '2026-10-10T08:00:00.000';
  raw.isItemEndTimeExpire = false;
  raw.bidHistory.auctionClosed = false;
  return raw;
}

function favoritesReply(itemIds: number[] = []): unknown {
  const raw = loadFixture<{ data: Array<Record<string, unknown>> }>('favorites-all');
  const first = raw.data[0] ?? {};
  raw.data = itemIds.map((itemId, i) => ({ ...first, itemId, watchlistId: 9000 + i, endTime: ITEM_END_RAW }));
  return raw;
}

const ACK = { status: true, message: 'Ok', isUnauthorized: false, type: null, primaryKey: null, data: null };

const ok = (body: unknown): HttpStep => ({ status: 200, bodyText: JSON.stringify(body) });

/** Watch rule that holds for every row priced at or below `maxCents`. */
function priceRule(id: string, maxCents: number): Rule {
  return { id, name: id, enabled: true, action: 'watch', all: [{ kind: 'price', max: maxCents }], createdAt: T0 - DAY, updatedAt: T0 - DAY };
}
const RULE_ALL = priceRule('r-all', 1_000_000);
/** Matches nothing these fixtures return ($12 rows). */
const RULE_NONE = priceRule('r-none', 1);
/** Matches the $5 rows only. */
const RULE_CHEAP = priceRule('r-cheap', 600);

function watch(id: string, over: Partial<Watch> = {}): Watch {
  return {
    id,
    name: id,
    enabled: true,
    query: { searchText: id, categoryIds: [], sellerIds: [], page: 1 },
    ruleIds: [RULE_NONE.id],
    maxPages: 1,
    favoriteMode: 'sgw',
    calendar: false,
    notify: false,
    nextRunAt: NEXT_SLOT,
    seenItemIds: [],
    ...over,
  };
}

function liveSettings(over: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), dryRun: { favorites: false, calendar: false, bidding: false }, ...over };
}

function trackedItem(itemId: number, over: Partial<TrackedItem> = {}): TrackedItem {
  return {
    itemId,
    title: `Pyrex bowl ${String(itemId)}`,
    endTime: '2026-10-20T19:00:00.000Z',
    sellerId: 1,
    reasons: [{ kind: 'watch', id: 'w1' }],
    favoriteState: 'none',
    calendar: false,
    addedAt: T0 - DAY,
    updatedAt: T0 - DAY,
    ...over,
  };
}

function oldRun(i: number): JobRun {
  return {
    id: `run-old-${String(i)}`,
    trigger: 'scheduled',
    startedAt: T0 - (40 - i) * DAY,
    finishedAt: T0 - (40 - i) * DAY + MIN,
    status: 'done',
    steps: [],
    cursor: 0,
    results: { newMatches: [], favorited: [], calendarUpserts: [], errors: [] },
    candidates: [],
  };
}

// ── The browser slice main.ts touches directly ──────────────────────────────

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

function makeBrowser() {
  const onMessage = fakeEvent<MessageListener>();
  const onConnect = fakeEvent<(port: RuntimePort) => void>();
  const onStartup = fakeEvent<() => void>();
  const onInstalled = fakeEvent<(d: { reason: string; previousVersion?: string }) => void>();
  const browser = {
    runtime: {
      id: EXT_ID,
      getURL: (p: string) => EXT_ORIGIN + p.replace(/^\//, ''),
      sendMessage: vi.fn<(message: unknown) => Promise<unknown>>(() => Promise.reject(new Error('Receiving end does not exist.'))),
      onMessage,
      onConnect,
      onStartup,
      onInstalled,
    },
    commands: { onCommand: fakeEvent<(command: string) => void>() },
    tabs: {
      query: vi.fn<(q: { url: string[] }) => Promise<Array<{ id?: number }>>>(() => Promise.resolve([])),
      sendMessage: vi.fn<(tabId: number, message: unknown) => Promise<unknown>>(() => Promise.resolve(undefined)),
    },
    storage: fakeBrowser.storage,
    alarms: fakeBrowser.alarms,
  } satisfies BackgroundBrowser;
  return { browser, onMessage, onConnect, onStartup, onInstalled };
}

// ── Harness ──────────────────────────────────────────────────────────────────

/** One SGW request as the fake site saw it. */
interface Sent {
  at: number;
  endpoint: 'search' | 'detail' | 'favorites' | 'addFavorite' | 'savedSearches';
  searchText?: string;
  page?: number;
  itemId?: number;
}

interface Site {
  /** Search replies by searchText → page → reply (default: an empty page). */
  search: (searchText: string, page: number) => HttpStep;
  detail: (itemId: number) => HttpStep;
  favorites: () => HttpStep;
  addFavorite: (itemId: number) => HttpStep;
  savedSearches: () => HttpStep;
}

interface BootOptions {
  areas?: FakeStorageAreas;
  clock?: FakeClock;
  settings?: Settings;
  watches?: Watch[];
  rules?: Rule[];
  seed?: Record<string, unknown>;
  site?: Partial<Site>;
  /** Host permissions granted (default: both SGW origins). */
  granted?: boolean;
  /** Skip seeding storage (a restart over existing storage). */
  restart?: boolean;
  sent?: Sent[];
}

/** Drains pending promise callbacks (no fake time passes). */
const flush = async (rounds = 4): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

function boot(opts: BootOptions = {}) {
  const clock = opts.clock ?? new FakeClock(T0);
  const areas = opts.areas ?? new FakeStorageAreas();
  if (opts.restart !== true) {
    areas.local.seed({
      [STORAGE_KEYS.meta]: META,
      [STORAGE_KEYS.settings]: opts.settings ?? defaultSettings(),
      [STORAGE_KEYS.sgwSession]: SESSION,
      [STORAGE_KEYS.rules]: opts.rules ?? [RULE_ALL, RULE_NONE, RULE_CHEAP],
      [STORAGE_KEYS.watches]: opts.watches ?? [],
      ...opts.seed,
    });
  }
  const sent: Sent[] = opts.sent ?? [];
  const site: Site = {
    search: () => ok(searchReply([])),
    detail: (itemId) => ok(detailReply(itemId)),
    favorites: () => ok(favoritesReply()),
    addFavorite: () => ok(ACK),
    savedSearches: () => ok(loadFixture('saved-searches')),
    ...opts.site,
  };
  const http = new FakeHttp(clock);
  http.on(`${API}Search/ItemListing`, (req: HttpRequest) => {
    const body = JSON.parse(req.body ?? '{}') as { searchText: string; page: string };
    sent.push({ at: clock.now(), endpoint: 'search', searchText: body.searchText, page: Number(body.page) });
    return site.search(body.searchText, Number(body.page));
  });
  http.on(`${API}ItemDetail/GetItemDetailModelByItemId/`, (req: HttpRequest) => {
    const itemId = Number(req.url.split('/').pop());
    sent.push({ at: clock.now(), endpoint: 'detail', itemId });
    return site.detail(itemId);
  });
  http.on(`${API}Favorite/GetAllFavoriteItemsByType`, () => {
    sent.push({ at: clock.now(), endpoint: 'favorites' });
    return site.favorites();
  });
  http.on(`${API}Favorite/AddToFavorite`, (req: HttpRequest) => {
    const itemId = Number(new URL(req.url).searchParams.get('itemId'));
    sent.push({ at: clock.now(), endpoint: 'addFavorite', itemId });
    return site.addFavorite(itemId);
  });
  http.on(`${API}SaveSearches/GetSaveSearches`, () => {
    sent.push({ at: clock.now(), endpoint: 'savedSearches' });
    return site.savedSearches();
  });
  const alarms = new FakeAlarms(clock);
  const notifier = new FakeNotifier();
  const permissions = new FakePermissions(opts.granted === false ? {} : { origins: [...SGW_HOST_ORIGINS] });
  const fb = makeBrowser();
  const log = vi.fn();
  const handle: BackgroundHandle = startBackground({
    browser: fb.browser,
    ports: {
      clock,
      storage: areas,
      http,
      alarms,
      notifier,
      permissions,
      keepAwake: new FakeKeepAwake(),
      keepAlive: new FakeKeepAlive(clock),
      random: () => 0,
    },
    log,
  });

  const send = (type: string, payload?: unknown, sender: RouterSender = UI): Promise<MessageResponse> => {
    const listener = fb.onMessage.listeners[0];
    if (listener === undefined) throw new Error('main.ts installed no onMessage listener');
    return new Promise<MessageResponse>((resolve) => {
      listener({ v: 1, type, reqId: `req-${type}`, ...(payload === undefined ? {} : { payload }) }, sender, (r) => {
        resolve(r as MessageResponse);
      });
    });
  };
  const reply = async (type: string, payload?: unknown): Promise<unknown> => {
    const r = await send(type, payload);
    if (!r.ok) throw new Error(`${type} failed: ${r.error.code}: ${r.error.message}`);
    return r.reply;
  };
  const audit = (): AuditEntry[] =>
    Object.entries(areas.local.dump())
      .filter(([k]) => k.startsWith('sbw:audit:'))
      .flatMap(([, v]) => v as AuditEntry[])
      .sort((a, b) => a.seq - b.seq);
  const runs = (): JobRun[] => (areas.local.dump()[STORAGE_KEYS.jobRuns] as JobRun[] | undefined) ?? [];
  const lastRun = (): JobRun | undefined => runs().at(-1);
  const watches = (): Watch[] => (areas.local.dump()[STORAGE_KEYS.watches] as Watch[] | undefined) ?? [];
  const tracked = (): Record<string, TrackedItem> =>
    (areas.local.dump()[STORAGE_KEYS.tracked] as Record<string, TrackedItem> | undefined) ?? {};
  /** Moves fake time forward in `step` slices, letting async work settle in between. */
  const advance = async (ms: number, step = SEC): Promise<void> => {
    await flush();
    for (let t = 0; t < ms; t += step) {
      clock.advance(Math.min(step, ms - t));
      await flush();
    }
  };
  const sgw = (endpoint?: Sent['endpoint']): Sent[] => sent.filter((s) => endpoint === undefined || s.endpoint === endpoint);

  return { clock, areas, http, alarms, notifier, permissions, fb, log, handle, send, reply, audit, runs, lastRun, watches, tracked, advance, sgw, sent };
}

type Harness = ReturnType<typeof boot>;

/** Boots and waits until every module registered and the first reconcile settled. */
async function ready(opts: BootOptions = {}): Promise<Harness & { ctx: BackgroundContext }> {
  const h = boot(opts);
  const ctx = await h.handle.ready;
  await flush();
  return { ...h, ctx };
}

function fakePort(name: string, url = `${EXT_ORIGIN}sidepanel.html`, tab?: unknown) {
  const posted: unknown[] = [];
  const disconnectListeners: Array<() => void> = [];
  const disconnect = vi.fn<() => void>();
  const port: RuntimePort = {
    name,
    sender: tab === undefined ? { id: EXT_ID, url } : { id: EXT_ID, url, tab },
    postMessage: (m) => {
      posted.push(structuredClone(m));
    },
    disconnect,
    onMessage: { addListener: () => undefined, removeListener: () => undefined },
    onDisconnect: {
      addListener: (l) => {
        disconnectListeners.push(l);
      },
      removeListener: () => undefined,
    },
  };
  const close = (): void => {
    for (const l of disconnectListeners) l();
  };
  return { port, posted, close, disconnect };
}

// SgwSessionAdapter.current() hashes with crypto.subtle.digest, which settles on
// a real thread-pool hop, so every authenticated request (favorites list,
// AddToFavorite, saved searches) would need a varying number of real event-loop
// turns. The same SHA-256, computed synchronously, keeps every chain on
// microtasks and the fake-time tests deterministic.
beforeEach(() => {
  vi.spyOn(crypto.subtle, 'digest').mockImplementation((_algorithm, data) => {
    const bytes = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
    const out = createHash('sha256').update(bytes).digest();
    return Promise.resolve(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Brief: tests first ───────────────────────────────────────────────────────

describe('T-52 brief', () => {
  it('a watch due 3 days ago runs once (catch-up), not three times', async () => {
    const h = await ready({ watches: [watch('w1', { nextRunAt: T0 - 3 * DAY })] });
    await h.advance(3 * HOUR, 5 * SEC);

    expect(h.sgw('search')).toHaveLength(1);
    expect(h.runs()).toHaveLength(1);
    expect(h.lastRun()).toMatchObject({ trigger: 'catch-up', status: 'done' });
    const [w] = h.watches();
    expect(w?.nextRunAt).toBe(NEXT_SLOT);
    expect(w?.lastRunAt).toBeGreaterThan(T0);
    // A run due within the grace period is a plain scheduled run.
    const h2 = await ready({ watches: [watch('w1', { nextRunAt: T0 - CATCH_UP_GRACE_MS + MIN })] });
    await h2.advance(TICK + 10 * SEC);
    expect(h2.lastRun()?.trigger).toBe('scheduled');
  });

  it('a browser restart mid-run resumes at cursor', async () => {
    const full = (text: string, page: number): HttpStep => ok(searchReply(rows(page * 1000, 40), 400));
    const sent: Sent[] = [];
    const h = await ready({ watches: [watch('w1', { nextRunAt: T0 - MIN, maxPages: 3 })], site: { search: full }, sent });
    await h.advance(2 * TICK + 10 * SEC); // two ticks: pages 1 and 2
    expect(h.sgw('search').map((s) => s.page)).toEqual([1, 2]);
    expect(h.lastRun()).toMatchObject({ status: 'running', cursor: 2 });

    // Restart: a new worker over the same storage; the old one never runs again
    // (its clock is no longer advanced). Firefox drops alarms: reconcile re-creates them.
    const h2 = await ready({ areas: h.areas, clock: new FakeClock(h.clock.now()), restart: true, site: { search: full }, sent });
    expect(await h2.alarms.getAll()).toEqual([expect.objectContaining({ name: TICK_ALARM, periodInMinutes: TICK_PERIOD_MINUTES })]);
    expect(sent).toHaveLength(2); // restart itself sent nothing
    await h2.advance(2 * TICK + 10 * SEC);
    expect(sent.map((s) => s.endpoint === 'search' ? `search p${String(s.page)}` : s.endpoint)).toEqual([
      'search p1',
      'search p2',
      'search p3',
      'favorites',
    ]);
    expect(h2.runs()).toHaveLength(1);
    expect(h2.lastRun()).toMatchObject({ status: 'done', cursor: 4 });
  });

  it('each tick issues at most one SGW request, at least 120 s apart on lane background', async () => {
    const site: Partial<Site> = {
      search: (_text, page) => (page === 1 ? ok(searchReply([...rows(100, 38), row(201, 5), row(202, 5)], 50)) : ok(searchReply(rows(300, 10), 50))),
    };
    const h = await ready({ watches: [watch('w1', { nextRunAt: T0 - MIN, maxPages: 3, ruleIds: [RULE_CHEAP.id] })], site });
    const perTick: number[] = [];
    for (let i = 0; i < 8; i++) {
      const before = h.sent.length;
      await h.advance(TICK);
      perTick.push(h.sent.length - before);
    }
    expect(perTick.every((n) => n <= 1)).toBe(true);
    // page 1, page 2 (short: paging stops), the favorites list, two details.
    expect(h.sent.map((s) => s.endpoint)).toEqual(['search', 'search', 'favorites', 'detail', 'detail']);
    for (let i = 1; i < h.sent.length; i++) {
      expect((h.sent[i]?.at ?? 0) - (h.sent[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(120 * SEC);
    }
    expect(h.ctx.scheduler.stats().lanes.background.usedToday).toBe(5);
    expect(h.ctx.scheduler.stats().lanes.interactive.usedToday).toBe(0);
  });

  it('job.runNow completes a 10-step run in < 15 s of fake time, on lane interactive', async () => {
    const full = (_text: string, page: number): HttpStep => ok(searchReply(rows(page * 1000, 40), 400));
    const watches = ['w1', 'w2', 'w3'].map((id) => watch(id, { maxPages: 3 }));
    const h = await ready({ watches, site: { search: full } });
    const start = h.clock.now();
    expect(await h.send('job.runNow', {})).toEqual({ ok: true });
    await h.advance(15 * SEC, 100);

    const run = h.lastRun();
    expect(run?.steps).toHaveLength(10);
    expect(run).toMatchObject({ trigger: 'manual', status: 'done', cursor: 10 });
    expect((run?.finishedAt ?? Infinity) - start).toBeLessThan(15 * SEC);
    expect(h.sent).toHaveLength(10);
    expect(h.ctx.scheduler.stats().lanes.interactive.usedToday).toBe(10);
    expect(h.ctx.scheduler.stats().lanes.background.usedToday).toBe(0);
  });

  it('a revoked host permission skips the run, with a notification and an audit entry', async () => {
    const h = await ready({ watches: [watch('w1', { nextRunAt: T0 - MIN })], granted: false });
    await h.advance(2 * TICK);
    expect(h.sent).toEqual([]);
    expect(h.runs()).toEqual([]);
    expect(h.notifier.sent).toEqual([expect.objectContaining({ id: PERMISSION_NOTIFICATION_ID })]);
    expect(h.audit()).toContainEqual(
      expect.objectContaining({ actor: 'daily-job', kind: 'job.skipped', details: expect.objectContaining({ reason: 'host-permission' }) as unknown }),
    );
    // Skipped, not deferred: the watch waits for its next daily slot.
    expect(h.watches()[0]).toMatchObject({ nextRunAt: NEXT_SLOT, lastError: expect.stringContaining('permission') as unknown });
    // Run now is refused with a clear reply.
    const r = await h.send('job.runNow', {});
    expect(r).toMatchObject({ ok: false, error: { message: expect.stringContaining('shopgoodwill.com') as unknown } });
    expect(h.sent).toEqual([]);
  });

  it('a host permission revoked mid-run fails the run at the next step', async () => {
    const full = (_text: string, page: number): HttpStep => ok(searchReply(rows(page * 1000, 40), 400));
    const h = await ready({ watches: [watch('w1', { nextRunAt: T0 - MIN, maxPages: 3 })], site: { search: full } });
    await h.advance(TICK);
    expect(h.sent).toHaveLength(1);
    h.permissions.revoke({ origins: [...SGW_HOST_ORIGINS] });
    await h.advance(2 * TICK);
    expect(h.sent).toHaveLength(1);
    expect(h.lastRun()).toMatchObject({ status: 'failed', cursor: 1 });
    expect(h.lastRun()?.finishedAt).toBeDefined();
    expect(h.notifier.sent.map((n) => n.id)).toContain(PERMISSION_NOTIFICATION_ID);
  });
});

// ── R2: zero SGW requests on startup, install or reconcile ──────────────────

describe('R2: only ticks and job.runNow make SGW requests', () => {
  it('startup, onInstalled, onStartup and reconcile() send nothing, even with a watch due; the first tick sends one', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no network in tests')));
    vi.stubGlobal('fetch', fetchSpy);
    const h = boot({ watches: [watch('w1', { nextRunAt: T0 - 3 * DAY })] });
    for (const l of h.fb.onInstalled.listeners) l({ reason: 'install' });
    for (const l of h.fb.onStartup.listeners) l();
    const ctx = await h.handle.ready;
    for (const l of h.fb.onInstalled.listeners) l({ reason: 'update', previousVersion: '0.0.1' });
    for (const l of h.fb.onStartup.listeners) l();
    await schedulerFor(ctx).reconcile(h.clock.now());
    await schedulerFor(ctx).reconcile(h.clock.now());
    await h.advance(TICK - 5 * SEC);

    expect(h.http.requests).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    // reconcile planned the run (persisted, nothing executed) and created the one tick alarm.
    expect(h.runs()).toHaveLength(1);
    expect(h.lastRun()).toMatchObject({ status: 'running', cursor: 0 });
    expect(await h.alarms.getAll()).toEqual([{ name: TICK_ALARM, scheduledTime: T0 + TICK, periodInMinutes: TICK_PERIOD_MINUTES }]);

    await h.advance(10 * SEC);
    expect(h.http.requests).toHaveLength(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reconcile re-creates a lost tick alarm and leaves an existing one alone', async () => {
    const h = await ready();
    expect(await h.alarms.getAll()).toHaveLength(1);
    await h.alarms.clear(TICK_ALARM);
    await schedulerFor(h.ctx).reconcile(h.clock.now());
    const [alarm] = await h.alarms.getAll();
    expect(alarm).toMatchObject({ name: TICK_ALARM, periodInMinutes: TICK_PERIOD_MINUTES });
    const create = vi.spyOn(h.alarms, 'create');
    await schedulerFor(h.ctx).reconcile(h.clock.now());
    expect(create).not.toHaveBeenCalled();
  });
});

// ── R3: never two runs at once ──────────────────────────────────────────────

describe('R3: one run at a time', () => {
  it('job.runNow while a scheduled run is active joins it and drains it on lane interactive', async () => {
    const full = (_text: string, page: number): HttpStep => ok(searchReply(rows(page * 1000, 40), 400));
    const h = await ready({ watches: [watch('w1', { nextRunAt: T0 - MIN, maxPages: 3 }), watch('w2')], site: { search: full } });
    await h.advance(TICK);
    expect(h.sent).toHaveLength(1);
    expect(h.lastRun()).toMatchObject({ trigger: 'scheduled', status: 'running', cursor: 1 });

    expect(await h.send('job.runNow', { watchIds: ['w2'] })).toEqual({ ok: true });
    await h.advance(5 * SEC, 100);
    expect(h.runs()).toHaveLength(1);
    expect(h.lastRun()).toMatchObject({ trigger: 'scheduled', status: 'done', cursor: 4 });
    expect(h.sent.map((s) => s.endpoint)).toEqual(['search', 'search', 'search', 'favorites']);
    const lanes = h.ctx.scheduler.stats().lanes;
    expect(lanes.background.usedToday).toBe(1);
    expect(lanes.interactive.usedToday).toBe(3);
    // w2 was not added to the joined run.
    expect(h.lastRun()?.steps.some((s) => s.kind === 'search' && s.watchId === 'w2')).toBe(false);
  });

  it('overlapping ticks execute one step: the second tick finds the runner busy', async () => {
    const slow = (_text: string, page: number): HttpStep => ({ status: 200, bodyText: JSON.stringify(searchReply(rows(page * 1000, 40), 400)), latencyMs: 5 * SEC });
    const h = await ready({ watches: [watch('w1', { nextRunAt: T0 - MIN, maxPages: 3 })], site: { search: slow } });
    const runner = runnerFor(h.ctx);
    const first = runner.tick();
    const second = runner.tick();
    expect(await second).toBe('busy');
    await h.advance(6 * SEC);
    expect(await first).toBe('stepped');
    expect(h.sent).toHaveLength(1);
    expect(h.lastRun()?.cursor).toBe(1);

    // Two scheduler ticks at once (an alarm delivered twice), then the alarm's own
    // tick while that step still waits for its 120 s gap: one step between them.
    const sched = schedulerFor(h.ctx);
    const both = Promise.all([sched.onTick(), sched.onTick()]);
    await h.advance(130 * SEC);
    await both;
    expect(h.sent).toHaveLength(2);
    expect(h.lastRun()?.cursor).toBe(2);
  });

  it('compare-and-set: a second runner instance cannot apply a step over the first one', async () => {
    const full = (_text: string, page: number): HttpStep => ok(searchReply(rows(page * 1000, 40), 400));
    const h = await ready({ watches: [watch('w1', { nextRunAt: T0 - MIN, maxPages: 3 })], site: { search: full } });
    const a = runnerFor(h.ctx);
    const b = new DailyJobRunner(h.ctx, { log: () => undefined });
    const results = Promise.all([a.tick(), b.tick()]);
    await h.advance(3 * MIN);
    expect((await results).sort()).toEqual(['conflict', 'stepped']);
    expect(h.lastRun()?.cursor).toBe(1);
    expect(h.lastRun()?.results.errors).toEqual([]);
  });

  it('job.runNow with no run active starts a manual run of the requested watches', async () => {
    const h = await ready({ watches: [watch('w1'), watch('w2'), watch('w3', { enabled: false })] });
    await h.reply('job.runNow', { watchIds: ['w2'] });
    await h.advance(3 * SEC, 100);
    expect(h.sgw('search').map((s) => s.searchText)).toEqual(['w2']);
    expect(h.lastRun()).toMatchObject({ trigger: 'manual', status: 'done' });
    // Not due yet: a manual run leaves the daily slot alone.
    expect(h.watches().find((w) => w.id === 'w2')?.nextRunAt).toBe(NEXT_SLOT);
    expect(await h.send('job.runNow', { watchIds: ['w3'] })).toMatchObject({ ok: false });
  });
});

// ── R4: carries ─────────────────────────────────────────────────────────────

describe('carries: DailyJob wiring', () => {
  it('searchPageSize is 40: a short page stops paging; invalid query params plan no search', async () => {
    const h = await ready({
      watches: [
        watch('w1', { nextRunAt: T0 - MIN, maxPages: 3 }),
        watch('w2', { nextRunAt: T0 - MIN, query: { searchText: 'w2', categoryIds: [], sellerIds: [], page: 1, extra: { lp: 'cheap' } } }),
      ],
      site: { search: () => ok(searchReply(rows(1, 39), 1000)) },
    });
    await h.advance(3 * TICK);
    expect(h.sgw('search').map((s) => `${s.searchText ?? ''} p${String(s.page)}`)).toEqual(['w1 p1']);
    expect(h.lastRun()?.status).toBe('done');
    expect(h.lastRun()?.results.errors).toContainEqual(expect.objectContaining({ message: 'watch w2: invalid search params: lp' }));
    expect(h.watches().find((w) => w.id === 'w2')?.lastError).toBe('watch w2: invalid search params: lp');
    expect(h.watches().find((w) => w.id === 'w1')?.lastError).toBeUndefined();
  });

  it('settings reach the job: calendar.enabled plans calendarUpsert, run by the no-op executor that audits the skip', async () => {
    const settings = { ...defaultSettings(), calendar: { ...defaultSettings().calendar, enabled: true } };
    const h = await ready({
      settings,
      watches: [watch('w1', { nextRunAt: T0 - MIN, ruleIds: [RULE_CHEAP.id], favoriteMode: 'local', calendar: true })],
      site: { search: () => ok(searchReply([row(7, 5)], 1)) },
    });
    await h.advance(6 * TICK);
    const run = h.lastRun();
    expect(run?.steps.map((s) => s.kind)).toEqual(['search', 'favoritesList', 'detail', 'calendarUpsert']);
    expect(run?.status).toBe('done');
    expect(h.audit()).toContainEqual(
      expect.objectContaining({ kind: 'job.step.skipped', itemId: 7, details: expect.objectContaining({ step: 'calendarUpsert' }) as unknown }),
    );
    // A no-op skip is not a failure.
    expect(runFailures(run as JobRun)).toEqual([]);
    expect(h.tracked()['7']).toMatchObject({ calendar: true, reasons: [{ kind: 'watch', id: 'w1' }], favoriteState: 'none' });
  });

  it('seenUpdates: matched and rejected items join the watch seen ring at the end of the run; a seen item is not fetched again', async () => {
    const site: Partial<Site> = { search: () => ok(searchReply([row(1, 5), row(2, 5), row(3, 12)], 3)) };
    const h = await ready({ watches: [watch('w1', { nextRunAt: T0 - MIN, ruleIds: [RULE_CHEAP.id], favoriteMode: 'local' })], site });
    await h.advance(4 * TICK);
    expect(h.lastRun()?.status).toBe('done');
    expect([...(h.watches()[0]?.seenItemIds ?? [])].sort()).toEqual([1, 2]);
    // The next run sees the same rows and selects nothing new.
    await h.reply('job.runNow', {});
    await h.advance(5 * SEC, 100);
    expect(h.runs()).toHaveLength(2);
    expect(h.lastRun()?.results.newMatches).toEqual([]);
  });

  it('a scheduler pause executes no step and consumes no retry; after it ends the run continues', async () => {
    const full = (_text: string, page: number): HttpStep => ok(searchReply(rows(page * 1000, 40), 400));
    const h = await ready({ watches: [watch('w1', { nextRunAt: T0 - MIN, maxPages: 2 })], site: { search: full } });
    h.ctx.scheduler.pause('test pause');
    await h.advance(5 * TICK);
    expect(h.sent).toEqual([]);
    expect(h.lastRun()).toMatchObject({ status: 'running', cursor: 0 });
    expect(h.lastRun()?.results.errors).toEqual([]);
    h.ctx.scheduler.resume();
    await h.advance(3 * TICK + 10 * SEC);
    expect(h.lastRun()).toMatchObject({ status: 'done' });
    expect(h.lastRun()?.results.errors).toEqual([]);
  });

  it('a retryable failure pauses the run; resume(run) retries once the lane backoff ends; three failures skip the step', async () => {
    let calls = 0;
    const flaky = (): HttpStep => {
      calls++;
      return calls === 1 ? { status: 500, bodyText: 'oops' } : ok(searchReply(rows(1, 3), 3));
    };
    const h = await ready({ watches: [watch('w1', { nextRunAt: T0 - MIN })], site: { search: flaky } });
    await h.advance(TICK);
    expect(h.lastRun()).toMatchObject({ status: 'paused', cursor: 0 });
    await h.advance(3 * TICK);
    expect(h.lastRun()).toMatchObject({ status: 'done' });
    expect(h.lastRun()?.results.errors.filter((e) => e.message.startsWith('search: '))).toHaveLength(1);

    const down = await ready({ watches: [watch('w1', { nextRunAt: T0 - MIN })], site: { search: () => ({ status: 503, bodyText: 'down' }) } });
    await down.advance(30 * TICK);
    expect(down.sgw('search')).toHaveLength(MAX_STEP_ATTEMPTS);
    expect(down.lastRun()?.status).toBe('done');
    expect(down.lastRun()?.results.errors.filter((e) => e.step === 0)).toHaveLength(MAX_STEP_ATTEMPTS);
    expect(down.watches()[0]?.lastError).toMatch(/^search: /);
  });

  it('archiving compacts candidates (ids, statuses, notes) and keeps the last 30 runs', async () => {
    const site: Partial<Site> = { search: () => ok(searchReply([row(1, 5), row(2, 5)], 2)) };
    const old = Array.from({ length: STORAGE_LIMITS.jobRunsKept }, (_, i) => oldRun(i));
    const h = await ready({
      watches: [watch('w1', { nextRunAt: T0 - MIN, ruleIds: [RULE_CHEAP.id] })],
      seed: { [STORAGE_KEYS.jobRuns]: old },
      site,
    });
    expect(h.runs()).toHaveLength(STORAGE_LIMITS.jobRunsKept);
    expect(h.runs()[0]?.id).toBe('run-old-1');
    await h.advance(8 * TICK);
    const run = h.lastRun();
    expect(run?.status).toBe('done');
    expect(h.runs()).toHaveLength(STORAGE_LIMITS.jobRunsKept);
    expect(run?.candidates?.length).toBe(2);
    for (const c of run?.candidates ?? []) {
      expect(Object.keys(c).sort()).toEqual(expect.arrayContaining(['endTime', 'itemId', 'status', 'watchIds']));
      expect(c).not.toHaveProperty('row');
      expect(c).not.toHaveProperty('detail');
      expect(c).not.toHaveProperty('quote');
    }
  });

  it('archiving compacts candidates a run ended with still pending (row dropped, status kept)', async () => {
    const site: Partial<Site> = { search: () => ok(searchReply([row(1, 5), row(2, 5)], 2)) };
    const h = await ready({ watches: [watch('w1', { nextRunAt: T0 - MIN, ruleIds: [RULE_CHEAP.id] })], site });
    await h.advance(TICK);
    expect(h.lastRun()?.candidates?.[0]).toHaveProperty('row'); // in progress: the row is kept for the strict pass
    h.permissions.revoke({ origins: [...SGW_HOST_ORIGINS] });
    await h.advance(TICK);
    const run = h.lastRun();
    expect(run?.status).toBe('failed');
    expect(run?.candidates?.map((c) => c.status)).toEqual(['pending', 'pending']);
    for (const c of run?.candidates ?? []) expect(c).not.toHaveProperty('row');
    // Nothing was decided, so nothing joins the seen ring (tomorrow's run retries them).
    expect(h.watches()[0]?.seenItemIds).toEqual([]);
    expect(h.watches()[0]?.lastError).toMatch(/^run: host permission/);
  });

  it('policy skips (dry-run favorites) are not failures in totals, lastError or the run audit', async () => {
    const site: Partial<Site> = { search: () => ok(searchReply([row(1, 5)], 1)) };
    const h = await ready({ watches: [watch('w1', { nextRunAt: T0 - MIN, ruleIds: [RULE_CHEAP.id] })], site });
    await h.advance(5 * TICK);
    const run = h.lastRun() as JobRun;
    expect(run.status).toBe('done');
    expect(run.results.errors.map((e) => e.message)).toEqual([`favorite: ${FAVORITE_SKIP_PREFIX}dry-run`]);
    expect(isPolicySkip(run.results.errors[0]?.message ?? '')).toBe(true);
    expect(isPolicySkip('search: SGW answered 500')).toBe(false);
    expect(runFailures(run)).toEqual([]);
    expect(h.watches()[0]?.lastError).toBeUndefined();
    expect(h.audit()).toContainEqual(
      expect.objectContaining({ kind: 'job.run.done', details: expect.objectContaining({ failures: 0, skips: 1, newMatches: 1 }) as unknown }),
    );
  });
});

describe('carries: favorites (writes through T-53)', () => {
  it('dry-run (the default): matches are tracked and audited as dry-run favorites; zero AddToFavorite calls', async () => {
    const site: Partial<Site> = { search: () => ok(searchReply([row(11, 5), row(12, 5), row(13, 12)], 3)) };
    const h = await ready({ watches: [watch('w1', { nextRunAt: T0 - MIN, ruleIds: [RULE_CHEAP.id] })], site });
    await h.advance(8 * TICK);
    expect(h.lastRun()?.status).toBe('done');
    expect(h.sgw('addFavorite')).toEqual([]);
    const dry = h.audit().filter((e) => e.kind === 'favorite.add' && e.dryRun === true);
    expect(dry.map((e) => e.itemId).sort()).toEqual([11, 12]);
    expect(Object.keys(h.tracked()).sort()).toEqual(['11', '12']);
    expect(h.tracked()['11']).toMatchObject({ reasons: [{ kind: 'watch', id: 'w1' }], favoriteState: 'none', calendar: false, title: 'Pyrex bowl 11' });
  });

  it('live: exactly one AddToFavorite per matched item, the item marked favorited with an undo', async () => {
    const site: Partial<Site> = { search: () => ok(searchReply([row(11, 5), row(12, 5)], 2)) };
    const h = await ready({ settings: liveSettings(), watches: [watch('w1', { nextRunAt: T0 - MIN, ruleIds: [RULE_CHEAP.id] })], site });
    await h.advance(10 * TICK);
    expect(h.lastRun()?.status).toBe('done');
    expect(h.sgw('addFavorite').map((s) => s.itemId).sort()).toEqual([11, 12]);
    expect(h.lastRun()?.results.favorited.sort()).toEqual([11, 12]);
    expect(h.tracked()['11']?.favoriteState).toBe('favorited');
    expect(h.audit()).toContainEqual(expect.objectContaining({ kind: 'favorite.add', itemId: 11, undo: { kind: 'unfavorite', ref: 'removeFavorite:11' } }));
  });

  it('desired(failed) → add on the NEXT run, and at most one favorite step per item per run', async () => {
    // Item 11 failed last run for w1. This run, w2 newly matches the same item.
    const site: Partial<Site> = { search: (text) => (text === 'w2' ? ok(searchReply([row(11, 5)], 1)) : ok(searchReply([], 0))) };
    const h = await ready({
      settings: liveSettings(),
      watches: [watch('w1', { nextRunAt: T0 - MIN, seenItemIds: [11] }), watch('w2', { nextRunAt: T0 - MIN, ruleIds: [RULE_CHEAP.id] })],
      seed: { [STORAGE_KEYS.tracked]: { 11: trackedItem(11, { favoriteState: 'failed' }) } },
      site,
    });
    await h.advance(10 * TICK);
    const run = h.lastRun() as JobRun;
    expect(run.status).toBe('done');
    const favSteps = run.steps.filter((s) => s.kind === 'favorite');
    expect(favSteps).toHaveLength(2); // the retry planned from desired(), and w2's new match
    expect(h.sgw('addFavorite').map((s) => s.itemId)).toEqual([11]);
    expect(run.results.errors.map((e) => e.message)).toContain(`favorite: ${FAVORITE_SKIP_PREFIX}already handled in this run`);
    expect(h.tracked()['11']).toMatchObject({ favoriteState: 'favorited' });
    expect(h.tracked()['11']?.reasons).toEqual(expect.arrayContaining([{ kind: 'watch', id: 'w1' }, { kind: 'watch', id: 'w2' }]));
  });

  it('late adds (T-56 carry): a match ending in 30 min reaches the new-matches hook right after its detail step, not at run end', async () => {
    const endsSoon = '2026-10-10T08:40:00'; // Pacific: 40 min after T0, ~34 min after the detail read
    const site: Partial<Site> = {
      search: () => ok(searchReply([{ ...row(7, 5), endTime: endsSoon }], 1)),
      detail: (itemId) => ok({ ...(detailReply(itemId) as object), endTime: endsSoon }),
    };
    const h = await ready({ watches: [watch('w1', { nextRunAt: T0 - MIN, ruleIds: [RULE_CHEAP.id], notify: true })], site });
    const calls: Array<{ status: string; cursor: number; itemIds: number[]; tracked: boolean }> = [];
    runnerFor(h.ctx).onNewMatches((run, itemIds) => {
      calls.push({ status: run.status, cursor: run.cursor, itemIds, tracked: h.tracked()['7'] !== undefined });
    });
    await h.advance(2 * TICK + 10 * SEC); // search, favorites list
    expect(calls).toEqual([]);
    await h.advance(TICK); // the detail read: strict match
    expect(h.sent.at(-1)).toMatchObject({ endpoint: 'detail', itemId: 7 });
    expect(calls).toEqual([{ status: 'running', cursor: 3, itemIds: [7], tracked: true }]);
    expect(h.lastRun()?.status).toBe('running'); // the favorite step (and run end) still to come
    await h.advance(3 * TICK);
    expect(h.lastRun()?.status).toBe('done');
    expect(calls).toHaveLength(1);
    // A failing subscriber is logged, never breaks the run.
    runnerFor(h.ctx).onNewMatches(() => {
      throw new Error('boom');
    });
  });

  it(`retries planned from desired() are capped at ${String(MAX_FAVORITE_RETRIES_PER_RUN)} per run, soonest-ending first`, async () => {
    const tracked: Record<number, TrackedItem> = {};
    for (let i = 0; i < MAX_FAVORITE_RETRIES_PER_RUN + 5; i++) {
      tracked[500 + i] = trackedItem(500 + i, { endTime: new Date(T0 + (i + 1) * HOUR).toISOString() });
    }
    const h = await ready({ watches: [watch('w1', { nextRunAt: T0 - MIN })], seed: { [STORAGE_KEYS.tracked]: tracked } });
    await h.advance(TICK);
    const favs = (h.lastRun()?.steps ?? []).filter((s) => s.kind === 'favorite');
    expect(favs).toHaveLength(MAX_FAVORITE_RETRIES_PER_RUN);
    expect(favs[0]).toMatchObject({ itemId: 500, watchId: 'w1' });
  });

  it('an sgw-late window that opens between daily runs gets its favorite on a tick (one sweep per window)', async () => {
    const lateWatch = watch('w1', { favoriteMode: 'sgw-late', favoriteWithinHours: 6 });
    const end = T0 + 6 * HOUR + 10 * MIN; // window opens 10 min after T0
    const h = await ready({
      watches: [lateWatch],
      seed: {
        [STORAGE_KEYS.tracked]: { 21: trackedItem(21, { endTime: new Date(end).toISOString() }) },
        [STORAGE_KEYS.jobRuns]: [{ ...oldRun(1), startedAt: T0 - 2 * HOUR }],
      },
    });
    await h.advance(5 * MIN);
    expect(h.runs()).toHaveLength(1); // window still closed
    await h.advance(10 * MIN);
    expect(h.runs()).toHaveLength(2);
    expect(h.lastRun()?.steps).toEqual([{ kind: 'favorite', itemId: 21, watchId: 'w1' }]);
    expect(h.lastRun()?.status).toBe('done');
    expect(h.audit()).toContainEqual(expect.objectContaining({ kind: 'favorite.add', itemId: 21, dryRun: true }));
    await h.advance(20 * MIN);
    expect(h.runs()).toHaveLength(2);
  });
});

describe('carries: saved watches (watches.save / watches.importSaved)', () => {
  it('watches.save sets page 1, drops stale catIds/cln, keeps runner-owned fields, schedules a new watch', async () => {
    const h = await ready({ watches: [watch('w1', { seenItemIds: [5, 6], lastRunAt: T0 - DAY, nextRunAt: NEXT_SLOT - HOUR })] });
    const query = { searchText: 'pyrex', categoryIds: [], sellerIds: [], page: 3, extra: { catIds: '12', cln: '2', sus: 'true' } };
    await h.reply('watches.save', { ...watch('w1'), name: 'renamed', query, seenItemIds: [], nextRunAt: 0 });
    await h.reply('watches.save', { ...watch('w2'), query: { ...query, extra: { catIds: '1', cln: '1' } }, seenItemIds: [9], nextRunAt: 0 });
    const [w1, w2] = h.watches();
    expect(w1).toMatchObject({ name: 'renamed', seenItemIds: [5, 6], lastRunAt: T0 - DAY, nextRunAt: NEXT_SLOT - HOUR });
    expect(w1?.query).toEqual({ searchText: 'pyrex', categoryIds: [], sellerIds: [], page: 1, extra: { sus: 'true' } });
    expect(w2).toMatchObject({ seenItemIds: [], nextRunAt: NEXT_SLOT });
    expect(w2?.query).not.toHaveProperty('extra');
    expect(await h.reply('watches.list')).toEqual(h.watches());

    const bad = await h.send('watches.save', { ...watch('w3'), query: { ...query, extra: { lp: 'cheap' } } });
    expect(bad).toMatchObject({ ok: false, error: { message: expect.stringContaining('lp') as unknown } });
    await h.reply('watches.delete', { id: 'w2' });
    expect(h.watches().map((w) => w.id)).toEqual(['w1']);
  });

  it('watches.importSaved maps saved searches to disabled watches (lane interactive), skipping duplicates by query', async () => {
    const existing = watch('mine', { query: { searchText: 'g7x', categoryIds: [], sellerIds: [], page: 2, lowPrice: 0, highPrice: 99999900, pickupOnly: false, excludePickupOnly: false, oneCentShippingOnly: false, closedAuctions: false, sortColumn: 1, sortDescending: false, layout: 'grid' } });
    const h = await ready({ watches: [existing] });
    expect(await h.reply('watches.importSaved')).toEqual({ imported: 6, skipped: 1 });
    expect(h.sgw('savedSearches')).toHaveLength(1);
    expect(h.ctx.scheduler.stats().lanes.interactive.usedToday).toBe(1);
    const imported = h.watches().filter((w) => w.id !== 'mine');
    expect(imported).toHaveLength(6);
    for (const w of imported) {
      expect(w).toMatchObject({ enabled: false, ruleIds: [], maxPages: 1, favoriteMode: 'sgw', nextRunAt: NEXT_SLOT, seenItemIds: [] });
      expect(w.query.page).toBe(1);
      expect(w.id).toMatch(/^sgw-saved-\d+$/);
    }
    // Importing again adds nothing (the interactive lane spaces the two reads 1 s apart).
    const again = h.reply('watches.importSaved');
    await h.advance(2 * SEC, 100);
    expect(await again).toEqual({ imported: 0, skipped: 7 });
  });

  it('watches.importSaved (T-55 carry): dedupes within one import by query hash; an unsearchable one is skipped and audited by id only', async () => {
    const h = await ready();
    const q = (searchText: string, over: Partial<Watch['query']> = {}): Watch['query'] => ({ searchText, categoryIds: [], sellerIds: [], page: 1, ...over });
    vi.spyOn(h.ctx.api, 'savedSearches').mockResolvedValue([
      { id: 1, name: 'pyrex', query: q('pyrex', { page: 4, extra: { catIds: '9', cln: '2' } }) },
      // The same search saved twice (another page, stale params): one watch.
      { id: 2, name: 'pyrex again', query: q('pyrex', { extra: { cln: '1' } }) },
      { id: 3, name: 'secret terms', query: q('secret terms', { extra: { lp: 'cheap' } }) },
    ]);
    expect(await h.reply('watches.importSaved')).toEqual({ imported: 1, skipped: 2 });
    expect(h.watches()).toEqual([expect.objectContaining({ id: 'sgw-saved-1', name: 'pyrex', query: q('pyrex'), ruleIds: [], favoriteMode: 'sgw' })]);
    const skipped = h.audit().filter((e) => e.kind === 'watches.import.skipped');
    expect(skipped).toEqual([expect.objectContaining({ details: { savedSearchId: 3, reason: 'invalid search params' } })]);
    expect(JSON.stringify(h.audit())).not.toContain('secret');
    // Idempotent: the same saved searches again add nothing.
    expect(await h.reply('watches.importSaved')).toEqual({ imported: 0, skipped: 3 });
    expect(h.watches()).toHaveLength(1);
  });
});

describe('carries: step-executor registry (I-07)', () => {
  it('loads ./*.ts by import.meta.glob: favorite, search, favorites-list and detail export {kind, run}', () => {
    expect(Object.keys(STEP_MODULES).sort()).toEqual(expect.arrayContaining(['./detail.ts', './favorite.ts', './favorites-list.ts', './search.ts']));
    expect(Object.keys(STEP_MODULES)).not.toContain('./index.ts');
    const registry = createStepRegistry();
    expect([...registry.kinds].sort()).toEqual(['detail', 'favorite', 'favoritesList', 'search']);
    expect(registry.failed).toEqual([]);
  });

  it('a module without a valid default export is reported; a duplicate kind keeps the first', () => {
    const run = () => Promise.resolve({ kind: 'notifyDigest', done: true } as const);
    const registry = createStepRegistry({
      './a.ts': { default: { kind: 'notifyDigest', run } },
      './b.ts': { default: { kind: 'notifyDigest', run } },
      './c.ts': {},
      './d.ts': { default: { kind: 'nope', run } },
    });
    expect([...registry.kinds]).toEqual(['notifyDigest']);
    expect(registry.failed.map((f) => f.file)).toEqual(['./b.ts', './c.ts', './d.ts']);
  });

  it('a kind with no module runs a no-op executor that audits the skip', async () => {
    const h = await ready();
    const deps = stepDeps(h.ctx, 'background');
    const out = await createStepRegistry({}).executorFor('notifyDigest').run({ kind: 'notifyDigest' }, deps);
    expect(out).toEqual({ kind: 'error', message: `${STEP_SKIP_PREFIX}no executor for 'notifyDigest' steps`, retryable: false });
    expect(h.audit()).toContainEqual(expect.objectContaining({ actor: 'daily-job', kind: 'job.step.skipped', details: { step: 'notifyDigest', why: 'no executor' } }));
    expect(h.sent).toEqual([]);
  });

  it('search: invalid params are rejected by SgwApi.search before any HTTP call; the pickup filter reaches normalizeSearch', async () => {
    const h = await ready({
      watches: [
        watch('bad', { query: { searchText: 'x', categoryIds: [], sellerIds: [], page: 1, extra: { c: 'abc' } } }),
        watch('pickup', { query: { searchText: 'pickup', categoryIds: [], sellerIds: [], page: 1, pickupOnly: true } }),
      ],
      site: { search: () => ok(searchReply([row(1)], 1)) },
    });
    const search = createStepRegistry().executorFor('search');
    const deps = stepDeps(h.ctx, 'interactive');
    const bad = await search.run({ kind: 'search', watchId: 'bad', page: 1 }, deps).catch((e: unknown) => e);
    expect(bad).toMatchObject({ kind: 'schema', message: expect.stringContaining('invalid-query') as unknown });
    expect(h.sent).toEqual([]);
    const out = await search.run({ kind: 'search', watchId: 'pickup', page: 2 }, deps);
    expect(out).toMatchObject({ kind: 'search', total: 1, items: [expect.objectContaining({ itemId: 1, pickupOnly: true })] });
    expect(h.sgw('search')).toEqual([expect.objectContaining({ searchText: 'pickup', page: 2 })]);
  });

  it('favoritesList caches the list and marks listed tracked items favorited (never downgrades)', async () => {
    const h = await ready({
      seed: { [STORAGE_KEYS.tracked]: { 31: trackedItem(31), 32: trackedItem(32, { favoriteState: 'favorited' }) } },
      site: { favorites: () => ok(favoritesReply([31])) },
    });
    const out = await createStepRegistry().executorFor('favoritesList').run({ kind: 'favoritesList' }, stepDeps(h.ctx, 'interactive'));
    expect(out).toMatchObject({ kind: 'favoritesList', items: [expect.objectContaining({ itemId: 31 })] });
    expect(h.areas.local.dump()[STORAGE_KEYS.favoritesCache]).toMatchObject({ fetchedAt: T0, items: [expect.objectContaining({ itemId: 31 })] });
    expect(h.tracked()['31']?.favoriteState).toBe('favorited');
    expect(h.tracked()['32']?.favoriteState).toBe('favorited');
  });

  it('detail reads the item on the given lane', async () => {
    const h = await ready();
    const out = await createStepRegistry().executorFor('detail').run({ kind: 'detail', itemId: 41, reason: 'new-match' }, stepDeps(h.ctx, 'background'));
    expect(out).toMatchObject({ kind: 'detail', detail: expect.objectContaining({ itemId: 41, isClosed: false }) as unknown });
    expect(h.ctx.scheduler.stats().lanes.background.usedToday).toBe(1);
  });
});

describe('carries: scheduler and registration', () => {
  it('registers through T-36 self-registration; drives ctx.ticks (the heartbeat) on every tick', async () => {
    expect(Object.keys(JOB_MODULES)).toEqual(expect.arrayContaining(['./scheduler.ts', './daily-job-runner.ts']));
    expect(Object.keys(HANDLER_MODULES)).toEqual(expect.arrayContaining(['./job.ts', './watches.ts', './tracked.ts']));
    const h = await ready();
    expect(h.ctx.startup.registered.failed).toEqual([]);
    expect(runnerFor(h.ctx)).toBe(runnerFor(h.ctx));
    expect(schedulerFor(h.ctx)).toBe(schedulerFor(h.ctx));
    const extra = vi.fn();
    h.ctx.ticks.onTick(extra);
    await h.advance(2 * TICK);
    expect(extra).toHaveBeenCalledTimes(2);
    expect((h.areas.local.dump()[STORAGE_KEYS.awake] as number[] | undefined)?.length).toBeGreaterThan(0);
  });

  it('dueWatches: enabled watches whose nextRunAt has passed; dailyRun.enabled false starts no scheduled run', async () => {
    const watches = [watch('due', { nextRunAt: T0 - MIN }), watch('later'), watch('off', { enabled: false, nextRunAt: T0 - MIN })];
    const h = await ready({ watches, settings: { ...defaultSettings(), dailyRun: { enabled: false, localTime: '07:00', catchUp: true } } });
    expect((await schedulerFor(h.ctx).dueWatches(h.clock.now())).map((w) => w.id)).toEqual(['due']);
    await h.advance(2 * TICK);
    expect(h.runs()).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('catchUp off: an overdue watch is skipped to its next slot (audited); one within the grace period runs', async () => {
    const h = await ready({
      settings: { ...defaultSettings(), dailyRun: { enabled: true, localTime: '07:00', catchUp: false } },
      watches: [watch('old', { nextRunAt: T0 - 3 * DAY }), watch('fresh', { nextRunAt: T0 - MIN })],
    });
    await h.advance(2 * TICK);
    expect(h.sgw('search').map((s) => s.searchText)).toEqual(['fresh']);
    expect(h.watches().map((w) => w.nextRunAt)).toEqual([NEXT_SLOT, NEXT_SLOT]);
    expect(h.audit()).toContainEqual(expect.objectContaining({ kind: 'job.skipped', details: expect.objectContaining({ reason: 'catch-up-off', watchId: 'old' }) as unknown }));
  });

  it('a nextRunAt beyond the next daily slot (the run time moved earlier) is pulled back to it', async () => {
    const h = await ready({ watches: [watch('w1', { nextRunAt: NEXT_SLOT + 5 * DAY })] });
    expect(h.watches()[0]?.nextRunAt).toBe(NEXT_SLOT);
  });

  it('a watch with no enabled watch rule is not searched (courtesy) and says why', async () => {
    const h = await ready({ watches: [watch('w1', { nextRunAt: T0 - MIN, ruleIds: ['missing'] })] });
    await h.advance(2 * TICK);
    expect(h.sent).toEqual([]);
    expect(h.watches()[0]).toMatchObject({ nextRunAt: NEXT_SLOT, lastError: expect.stringContaining('no enabled watch rule') as unknown });
  });
});

describe('job.status, tracked.* and the sbw:job-progress port', () => {
  it('job.status answers null, then the active run, then the latest run', async () => {
    const full = (_text: string, page: number): HttpStep => ok(searchReply(rows(page * 1000, 40), 400));
    const h = await ready({ watches: [watch('w1', { maxPages: 2 })], site: { search: full } });
    expect(await h.reply('job.status')).toBeNull();
    await h.reply('job.runNow', {});
    expect(await h.reply('job.status')).toMatchObject({ status: 'running', trigger: 'manual' });
    await h.advance(5 * SEC, 100);
    expect(await h.reply('job.status')).toMatchObject({ status: 'done' });
  });

  it('tracked.list answers the tracked items soonest-ending first; tracked.remove deletes one', async () => {
    const h = await ready({
      seed: {
        [STORAGE_KEYS.tracked]: {
          1: trackedItem(1, { endTime: '2026-10-21T00:00:00.000Z' }),
          2: trackedItem(2, { endTime: '2026-10-20T00:00:00.000Z' }),
        },
      },
    });
    expect(((await h.reply('tracked.list')) as TrackedItem[]).map((t) => t.itemId)).toEqual([2, 1]);
    await h.reply('tracked.remove', { itemId: 2 });
    expect(Object.keys(h.tracked())).toEqual(['1']);
  });

  it('streams the run on connect and after every step; refuses content-script ports', async () => {
    const full = (_text: string, page: number): HttpStep => ok(searchReply(rows(page * 1000, 40), 400));
    const h = await ready({ watches: [watch('w1', { nextRunAt: T0 - MIN, maxPages: 2 })], site: { search: full } });
    const ui = fakePort(PORT_NAMES.jobProgress);
    const content = fakePort(PORT_NAMES.jobProgress, 'https://shopgoodwill.com/item/1', { id: 3 });
    for (const l of h.fb.onConnect.listeners) {
      l(ui.port);
      l(content.port);
    }
    await flush();
    expect(ui.posted).toHaveLength(1);
    expect(ui.posted[0]).toMatchObject({ status: 'running', cursor: 0 });
    expect(content.posted).toEqual([]);
    expect(content.disconnect).toHaveBeenCalled();
    await h.advance(TICK);
    expect(ui.posted.at(-1)).toMatchObject({ cursor: 1 });
    ui.close();
    const count = ui.posted.length;
    await h.advance(TICK);
    expect(ui.posted).toHaveLength(count);
  });
});

/** StepDeps for calling an executor directly. */
function stepDeps(ctx: BackgroundContext, lane: 'background' | 'interactive'): StepDeps {
  return {
    api: ctx.api,
    repo: ctx.repo,
    audit: ctx.audit,
    switches: ctx.switches,
    lane,
    run: {
      id: 'run-test',
      trigger: 'manual',
      startedAt: T0,
      status: 'running',
      steps: [],
      cursor: 0,
      results: { newMatches: [], favorited: [], calendarUpserts: [], errors: [] },
    },
    ctx,
  };
}
