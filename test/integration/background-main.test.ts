// T-36: the background composition root (src/background/main.ts), GlobalSwitches
// (src/background/switches.ts), the core handlers and self-registration.
//
// Everything runs on fakes: FakeClock, FakeStorageAreas, FakeHttp (which
// answers nothing unless a test scripts it, so an unexpected request fails
// loudly), FakeAlarms, FakeNotifier, FakePermissions. The browser slice that
// main.ts touches directly (runtime events, commands, tabs) is a hand-written
// fake below, because WXT's fakeBrowser does not mock onConnect or commands;
// its storage and alarms come from fakeBrowser for the test-hook slice.
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { HANDLER_MODULES } from '../../src/background/handlers/index';
import { JOB_MODULES } from '../../src/background/jobs/index';
import type { BackgroundContext, BackgroundModule, ModuleMap, RuntimePort } from '../../src/background/context';
import {
  KILL_COMMAND,
  MIGRATE_TIMEOUT_MS,
  STARTUP_DEADLINE_MS,
  startBackground,
  type BackgroundBrowser,
  type BackgroundHandle,
} from '../../src/background/main';
import type { MessageResponse, RouterSender } from '../../src/background/router';
import {
  HEALTH_WINDOW_MS,
  SWITCHES_LOAD_TIMEOUT_MS,
  SWITCHES_RETRY_MS,
  WRITE_FEATURES,
  type Switches,
} from '../../src/background/switches';
import { HEALTH_REPROBE_MIN_MS, UNKNOWN_PREFIX } from '../../src/adapters/sgw/health';
import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import { STORAGE_KEYS } from '../../src/domain/storage/schema';
import type { SgwEndpointKey } from '../../src/adapters/sgw/config';
import type { HealthReport, Listing, SgwSessionRecord } from '../../src/domain/types';
import type { AuditEntry } from '../../src/domain/audit/types';
import { loadFixture } from '../contract/sgw/fixtures';
import { FakeAlarms } from '../fakes/ports/fake-alarms';
import { FakeClock } from '../fakes/ports/fake-clock';
import { FakeHttp } from '../fakes/ports/fake-http';
import { FakeKeepAlive } from '../fakes/ports/fake-keepalive';
import { FakeKeepAwake } from '../fakes/ports/fake-keepawake';
import { FakeNotifier } from '../fakes/ports/fake-notifier';
import { FakePermissions } from '../fakes/ports/fake-permissions';
import { FakeStorageAreas } from '../fakes/ports/fake-storage';

// ── Constants and helpers ────────────────────────────────────────────────────

const EXT_ID = 'test-extension-id';
const EXT_ORIGIN = `chrome-extension://${EXT_ID}/`;
const T0 = Date.UTC(2026, 9, 10, 15, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const API = 'https://buyerapi.shopgoodwill.com/api/';

const UI: RouterSender = { id: EXT_ID, url: `${EXT_ORIGIN}options.html` };
const CONTENT: RouterSender = { id: EXT_ID, url: 'https://shopgoodwill.com/categories/listing', tab: { id: 7 } };

/** Drains pending promise callbacks (no fake time passes). */
const flush = async (rounds = 5): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

/** A JWT shaped like SGW's: BuyerId, exp (seconds), jti. */
function jwt(claims: { BuyerId: string; exp: number; jti?: string }): string {
  return `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}.c2lnbmF0dXJl`;
}

const SESSION_EXP = T0 + 30 * DAY;
const BEARER = jwt({ BuyerId: '42', exp: Math.floor(SESSION_EXP / 1000), jti: 'token-1' });
const SESSION: SgwSessionRecord = { bearer: BEARER, capturedAt: T0 - MIN, expiresAt: SESSION_EXP, buyerId: '42', source: 'tap' };
const META = { schemaVersion: 1, installedAt: T0 - DAY, lastMigrationAt: T0 - DAY };

/** Settings with every write path live (dry-run off). */
function liveSettings(over: Partial<Settings> = {}): Settings {
  return { ...defaultSettings(), dryRun: { favorites: false, calendar: false, bidding: false }, ...over };
}

function report(ok: boolean, checkedAt: number): HealthReport {
  return {
    ok,
    checkedAt,
    configVersion: 'test',
    checks: [{ name: 'search-schema', ok, ...(ok ? {} : { detail: 'drift' }) }],
  };
}

function listing(itemId: number, over: Partial<Listing> = {}): Listing {
  return {
    itemId,
    title: `Item ${String(itemId)}`,
    currentPrice: 1299,
    startingMinimumBid: 1299,
    numBids: 0,
    endTime: new Date(T0 + DAY).toISOString(),
    endTimeRaw: '2026-10-11T08:00:00',
    sellerId: 123,
    source: 'tap',
    observedAt: T0,
    ...over,
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
  const onCommand = fakeEvent<(command: string) => void>();
  const runtimeSend = vi.fn<(message: unknown) => Promise<unknown>>(() =>
    Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')),
  );
  const tabsQuery = vi.fn<(q: { url: string[] }) => Promise<Array<{ id?: number }>>>(() => Promise.resolve([{ id: 7 }, { id: 9 }]));
  const tabsSend = vi.fn<(tabId: number, message: unknown) => Promise<unknown>>(() => Promise.resolve(undefined));
  const browser = {
    runtime: {
      id: EXT_ID,
      getURL: (p: string) => EXT_ORIGIN + p.replace(/^\//, ''),
      sendMessage: runtimeSend,
      onMessage,
      onConnect,
      onStartup,
      onInstalled,
    },
    commands: { onCommand },
    tabs: { query: tabsQuery, sendMessage: tabsSend },
    storage: fakeBrowser.storage,
    alarms: fakeBrowser.alarms,
  } satisfies BackgroundBrowser;
  return { browser, onMessage, onConnect, onStartup, onInstalled, onCommand, runtimeSend, tabsQuery, tabsSend };
}

// ── Harness ──────────────────────────────────────────────────────────────────

interface BootOptions {
  areas?: FakeStorageAreas;
  clock?: FakeClock;
  seed?: Record<string, unknown>;
  seedSession?: Record<string, unknown>;
  handlerModules?: ModuleMap;
  jobModules?: ModuleMap;
  /** Skip the default seeds (meta, live settings, a valid session). */
  bare?: boolean;
}

function boot(opts: BootOptions = {}) {
  const clock = opts.clock ?? new FakeClock(T0);
  const areas = opts.areas ?? new FakeStorageAreas();
  if (opts.bare !== true) {
    areas.local.seed({
      [STORAGE_KEYS.meta]: META,
      [STORAGE_KEYS.settings]: liveSettings(),
      [STORAGE_KEYS.sgwSession]: SESSION,
    });
  }
  if (opts.seed) areas.local.seed(opts.seed);
  if (opts.seedSession) areas.session.seed(opts.seedSession);
  const http = new FakeHttp(clock);
  const alarms = new FakeAlarms(clock);
  const notifier = new FakeNotifier();
  const permissions = new FakePermissions();
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
    ...(opts.handlerModules ? { handlerModules: opts.handlerModules } : {}),
    ...(opts.jobModules ? { jobModules: opts.jobModules } : {}),
  });

  /** Delivers one runtime message through the listener main.ts installed. */
  const send = (type: string, payload?: unknown, sender: RouterSender = UI): Promise<MessageResponse> => {
    const listener = fb.onMessage.listeners[0];
    if (listener === undefined) throw new Error('main.ts installed no onMessage listener');
    return new Promise<MessageResponse>((resolve) => {
      listener({ v: 1, type, reqId: `req-${type}`, ...(payload === undefined ? {} : { payload }) }, sender, (r) => {
        resolve(r as MessageResponse);
      });
    });
  };
  const ok = async (type: string, payload?: unknown, sender: RouterSender = UI): Promise<unknown> => {
    const r = await send(type, payload, sender);
    if (!r.ok) throw new Error(`${type} failed: ${r.error.code}: ${r.error.message}`);
    return r.reply;
  };
  const audit = (): AuditEntry[] =>
    Object.entries(areas.local.dump())
      .filter(([k]) => k.startsWith('sbw:audit:'))
      .flatMap(([, v]) => v as AuditEntry[]);
  const broadcasts = (type: string): unknown[] =>
    fb.runtimeSend.mock.calls.map(([m]) => m).filter((m) => (m as { type?: string }).type === type);

  return { clock, areas, http, alarms, notifier, permissions, fb, log, handle, send, ok, audit, broadcasts };
}

async function verdicts(s: Switches): Promise<Record<string, { ok: boolean; why?: string }>> {
  const out: Record<string, { ok: boolean; why?: string }> = {};
  for (const f of WRITE_FEATURES) out[f] = await s.writesAllowed(f);
  return out;
}

const ALL_OK = { favorites: { ok: true }, calendar: { ok: true }, bidding: { ok: true } };
/** The features that write to the user's SGW account (calendar writes go to Google). */
const SGW_FEATURES = ['favorites', 'bidding'] as const;

/** A valid search reply with no rows (T-30 then has no item to probe: detail is unknown, never failing). */
function emptySearch(): unknown {
  const raw = loadFixture<{ searchResults: { items: unknown[] } }>('search-grid-p1');
  raw.searchResults.items = [];
  return raw;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ── Brief: tests first ───────────────────────────────────────────────────────

describe('T-36 brief', () => {
  it('startup runs migrate, loads the switches, loads the scheduler, then registers handlers; nothing is served before', async () => {
    const areas = new FakeStorageAreas();
    const order: string[] = [];
    const realGet = areas.local.get.bind(areas.local);
    const realSet = areas.local.set.bind(areas.local);
    const metaGate = deferred();
    areas.local.get = async <T>(key: string): Promise<T | undefined> => {
      order.push(`get ${key}`);
      if (key === STORAGE_KEYS.meta) await metaGate.promise;
      return realGet<T>(key);
    };
    areas.local.set = (entries: Record<string, unknown>) => {
      for (const k of Object.keys(entries)) order.push(`set ${k}`);
      return realSet(entries);
    };
    let sawAtRegister: { loaded: boolean; meta: unknown } | undefined;
    const probe: BackgroundModule = {
      register: (ctx) => {
        order.push('register');
        sawAtRegister = { loaded: ctx.switches.loaded, meta: areas.local.dump()[STORAGE_KEYS.meta] };
      },
    };
    const h = boot({ areas, handlerModules: { ...HANDLER_MODULES, './zz-probe.ts': probe } });

    // MV3: the raw listeners exist synchronously (an event that woke the worker is not lost)...
    expect(h.fb.onMessage.listeners).toHaveLength(1);
    expect(h.fb.onCommand.listeners).toHaveLength(1);
    expect(h.fb.onConnect.listeners).toHaveLength(1);
    // ...but a message sent now waits for startup instead of meeting half-built state.
    const early = h.send('settings.get');
    let earlyDone = false;
    void early.then(() => (earlyDone = true));
    await flush();
    expect(earlyDone).toBe(false);
    expect(order).toEqual([`get ${STORAGE_KEYS.meta}`]);

    metaGate.resolve();
    const ctx = await h.handle.ready;
    const reply = await early;
    expect(reply).toMatchObject({ ok: true, reply: { killSwitch: false } });

    const at = (entry: string): number => order.indexOf(entry);
    expect(at(`get ${STORAGE_KEYS.meta}`)).toBe(0);
    expect(at(`get ${STORAGE_KEYS.settings}`)).toBeGreaterThan(at(`get ${STORAGE_KEYS.meta}`));
    expect(at(`get ${STORAGE_KEYS.requestBudget}`)).toBeGreaterThan(at(`get ${STORAGE_KEYS.settings}`));
    expect(at('register')).toBeGreaterThan(at(`get ${STORAGE_KEYS.requestSchedulerState}`));
    expect(sawAtRegister).toEqual({ loaded: true, meta: META });
    expect(ctx.startup.migration?.health).toBe('ok');
  });

  it('a module added under handlers/ (or jobs/) with register(ctx) is picked up without editing main.ts', async () => {
    // The registries are live globs over the folders: every file there is loaded.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const filesIn = (dir: string): string[] =>
      readdirSync(path.join(here, '../../src/background', dir))
        .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
        .map((f) => `./${f}`)
        .sort();
    expect(Object.keys(HANDLER_MODULES).sort()).toEqual(filesIn('handlers'));
    expect(Object.keys(JOB_MODULES).sort()).toEqual(filesIn('jobs'));
    for (const [file, mod] of [...Object.entries(HANDLER_MODULES), ...Object.entries(JOB_MODULES)]) {
      expect(typeof mod.register, `${file} exports register(ctx)`).toBe('function');
    }

    // A new module in the map is registered with the context, and its handler serves.
    const handlerProbe = vi.fn((ctx: BackgroundContext) => {
      ctx.router.register('ui.openSnipe', () => undefined);
    });
    const jobProbe = vi.fn();
    const h = boot({
      handlerModules: { ...HANDLER_MODULES, './new-feature.ts': { register: handlerProbe } },
      jobModules: { ...JOB_MODULES, './new-job.ts': { register: jobProbe } },
    });
    const ctx = await h.handle.ready;
    expect(handlerProbe).toHaveBeenCalledExactlyOnceWith(ctx);
    expect(jobProbe).toHaveBeenCalledExactlyOnceWith(ctx);
    expect(ctx.startup.registered).toEqual(
      expect.objectContaining({
        handlers: expect.arrayContaining(['./new-feature.ts', './rules.ts', './settings.ts', './favorites.ts', './audit.ts']) as unknown,
        jobs: expect.arrayContaining(['./new-job.ts', './heartbeat.ts']) as unknown,
        failed: [],
      }),
    );
    expect(await h.send('ui.openSnipe', { itemId: 1 }, CONTENT)).toEqual({ ok: true });
    // The pre-existing modules registered too (T-53, T-58).
    expect((await h.send('audit.list', { limit: 5 })).ok).toBe(true);
  });

  it('a module without register(ctx), or one that throws, is reported and the rest still register', async () => {
    const good = vi.fn();
    const h = boot({
      handlerModules: {
        './a-broken.ts': {
          register: () => {
            throw new Error('boom');
          },
        },
        './b-helper.ts': {},
        './c-good.ts': { register: good },
      },
      jobModules: {},
    });
    const ctx = await h.handle.ready;
    expect(good).toHaveBeenCalledOnce();
    expect(ctx.startup.registered.failed).toEqual([
      { kind: 'handlers', file: './a-broken.ts', error: 'boom' },
      { kind: 'handlers', file: './b-helper.ts', error: 'module does not export register(ctx)' },
    ]);
    expect(h.log).toHaveBeenCalled();
  });

  it('a settings.set interceptor can veto the write', async () => {
    const seen: unknown[] = [];
    const gate: BackgroundModule = {
      register: (ctx) => {
        ctx.interceptors.settingsSet.add((change) => {
          seen.push({ patch: change.patch, before: change.current.dryRun.bidding, after: change.next.dryRun.bidding });
          return !change.next.dryRun.bidding && change.current.dryRun.bidding
            ? { veto: 'Complete 5 dry-run snipes before bidding live.' }
            : undefined;
        });
      },
    };
    const h = boot({
      seed: { [STORAGE_KEYS.settings]: defaultSettings() },
      handlerModules: { ...HANDLER_MODULES, './zz-live-gate.ts': gate },
    });
    await h.handle.ready;
    const before = h.areas.local.dump()[STORAGE_KEYS.settings];

    const vetoed = await h.send('settings.set', { dryRun: { favorites: true, calendar: true, bidding: false } });
    expect(vetoed).toEqual({
      ok: false,
      error: { code: 'handler_error', message: 'Complete 5 dry-run snipes before bidding live.' },
    });
    expect(h.areas.local.dump()[STORAGE_KEYS.settings]).toEqual(before);
    expect(seen).toHaveLength(1);

    // A change the interceptor allows goes through.
    await h.ok('settings.set', { considerateMode: 'tight' });
    expect((h.areas.local.dump()[STORAGE_KEYS.settings] as Settings).considerateMode).toBe('tight');
    expect(seen).toHaveLength(2);
  });

  it('page.token reaches SessionAdapter.observe', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    await ctx.session.clear(); // logged out: any well-formed token for a buyer is accepted
    const observe = vi.spyOn(ctx.session, 'observe');
    const fresh = jwt({ BuyerId: '42', exp: Math.floor((T0 + 20 * DAY) / 1000), jti: 'token-2' });

    await h.ok('page.token', { bearer: fresh, capturedAt: T0 - 5 }, CONTENT);
    expect(observe).toHaveBeenCalledExactlyOnceWith({ bearer: fresh, capturedAt: T0 - 5, source: 'tap' });
    expect(await ctx.session.state()).toBe('ok');
    expect((h.areas.local.dump()[STORAGE_KEYS.sgwSession] as SgwSessionRecord).bearer).toBe(fresh);
  });

  it('kill.set flips writesAllowed for all features and audits', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    expect(await verdicts(ctx.switches)).toEqual(ALL_OK);

    await h.ok('kill.set', { on: true });
    for (const f of WRITE_FEATURES) {
      expect(await ctx.switches.writesAllowed(f)).toEqual({ ok: false, why: 'kill switch is on' });
    }
    expect((h.areas.local.dump()[STORAGE_KEYS.settings] as Settings).killSwitch).toBe(true);
    expect(h.audit().filter((e) => e.kind === 'kill.on')).toEqual([
      expect.objectContaining({ actor: 'user', kind: 'kill.on', details: { source: 'kill.set' } }),
    ]);
    expect(h.broadcasts('switches.changed').at(-1)).toMatchObject({
      v: 1,
      type: 'switches.changed',
      payload: { killSwitch: true, writesAllowed: { favorites: false, calendar: false, bidding: false } },
    });
    // Content scripts (the overlay) get it too, on every SGW tab.
    await flush();
    expect(h.fb.tabsQuery).toHaveBeenCalledWith({ url: ['https://shopgoodwill.com/*'] });
    expect(h.fb.tabsSend).toHaveBeenCalledWith(7, expect.objectContaining({ type: 'switches.changed' }));

    await h.ok('kill.set', { on: false });
    expect(await verdicts(ctx.switches)).toEqual(ALL_OK);
    expect(h.audit().map((e) => e.kind)).toEqual(expect.arrayContaining(['kill.on', 'kill.off']));
  });

  it('writesAllowed is false after a failed HealthReport (moved from T-30; the real SgwHealth), until a good one or 24 h pass', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: true });

    // SGW's search reply drifted: T-30's probe fails search-schema.
    h.http.on(`${API}Search/ItemListing`, { status: 200, bodyText: JSON.stringify({ drifted: true }) });
    const failed = await ctx.health.run('anonymous');
    expect(failed.ok).toBe(false);
    expect(failed.checks.find((c) => c.name === 'search-schema')?.ok).toBe(false);
    for (const f of WRITE_FEATURES) {
      expect(await ctx.switches.writesAllowed(f)).toEqual({ ok: false, why: 'health check failed' });
    }
    await flush();
    expect((h.areas.local.dump()[STORAGE_KEYS.healthReport] as HealthReport).ok).toBe(false);

    // The site answers validly again: a full run 10 min later re-probes and passes.
    h.http.on(`${API}Search/ItemListing`, { status: 200, bodyText: JSON.stringify(emptySearch()) });
    h.clock.advance(HEALTH_REPROBE_MIN_MS);
    const good = await ctx.health.run('full');
    expect(good.ok).toBe(true);
    await flush();
    expect(await verdicts(ctx.switches)).toEqual(ALL_OK);

    // A failing report older than 24 h no longer blocks.
    await h.areas.local.set({ [STORAGE_KEYS.healthReport]: report(false, h.clock.now() + 1) });
    expect((await ctx.switches.writesAllowed('favorites')).ok).toBe(false);
    h.clock.advance(HEALTH_WINDOW_MS);
    expect((await ctx.switches.writesAllowed('favorites')).ok).toBe(false);
    h.clock.advance(2);
    expect(await ctx.switches.writesAllowed('favorites')).toEqual({ ok: true });
  });

  it('a failed HealthReport stored by T-30 survives a restart (sbw:healthReport is loaded at startup)', async () => {
    const h = boot({ seed: { [STORAGE_KEYS.healthReport]: report(false, T0 - HOUR) } });
    const ctx = await h.handle.ready;
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: false, why: 'health check failed' });
  });

  it('quick.hideSeller creates a rule and broadcasts rules.changed', async () => {
    const h = boot();
    await h.handle.ready;
    await h.ok('quick.hideSeller', { sellerId: 123, sellerName: 'Goodwill of Example' }, CONTENT);

    const rules = h.areas.local.dump()[STORAGE_KEYS.rules] as Array<Record<string, unknown>>;
    expect(rules).toEqual([
      {
        id: 'quick:seller:123',
        name: 'Hide seller: Goodwill of Example',
        enabled: true,
        action: 'hide',
        all: [{ kind: 'seller', mode: 'include', sellerIds: [123], sellerNames: [] }],
        createdAt: T0,
        updatedAt: T0,
      },
    ]);
    expect(h.broadcasts('rules.changed')).toEqual([{ v: 1, type: 'rules.changed', reqId: expect.any(String) as unknown }]);
    await flush();
    expect(h.fb.tabsSend).toHaveBeenCalledWith(9, expect.objectContaining({ type: 'rules.changed' }));

    // The rule now hides that seller's listings.
    const evaluated = (await h.ok('rules.evaluate', { listings: [listing(1), listing(2, { sellerId: 5 })] }, CONTENT)) as Array<{
      decision: string;
    }>;
    expect(evaluated.map((r) => r.decision)).toEqual(['hide', 'none']);

    // Hiding the same seller again does not duplicate the rule.
    await h.ok('quick.hideSeller', { sellerId: 123, sellerName: 'Goodwill of Example' }, CONTENT);
    expect(h.areas.local.dump()[STORAGE_KEYS.rules]).toHaveLength(1);
  });
});

// ── GlobalSwitches (R2) ──────────────────────────────────────────────────────

describe('GlobalSwitches: an in-memory snapshot (R2)', () => {
  it('writesAllowed makes no storage, session or browser call per invocation', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    const spies = [
      vi.spyOn(h.areas.local, 'get'),
      vi.spyOn(h.areas.session, 'get'),
      vi.spyOn(ctx.session, 'state'),
      vi.spyOn(ctx.session, 'current'),
      vi.spyOn(ctx.health, 'last'),
    ];
    const answers = await Promise.all(Array.from({ length: 300 }, (_, i) => ctx.switches.writesAllowed(WRITE_FEATURES[i % 3] ?? 'bidding')));
    expect(answers.every((a) => a.ok)).toBe(true);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    // The answer is ready on the next microtask, never behind I/O.
    let settled = false;
    void ctx.switches.writesAllowed('bidding').then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(true);
  });

  it('fails closed before the snapshot is loaded', () => {
    const h = boot();
    expect(h.handle.switches.loaded).toBe(false);
    expect(h.handle.switches.verdictNow('favorites')).toEqual({ ok: false, why: 'starting: the switch state is not loaded yet' });
  });

  it.each([
    ['the kill switch', { [STORAGE_KEYS.settings]: liveSettings({ killSwitch: true }) }, {}, WRITE_FEATURES, 'kill switch is on'],
    [
      'dryRun.bidding (bidding only)',
      { [STORAGE_KEYS.settings]: liveSettings({ dryRun: { favorites: false, calendar: false, bidding: true } }) },
      {},
      ['bidding'],
      'dry run',
    ],
    [
      'dryRun.favorites (favorites only)',
      { [STORAGE_KEYS.settings]: liveSettings({ dryRun: { favorites: true, calendar: false, bidding: false } }) },
      {},
      ['favorites'],
      'dry run',
    ],
    ['a failed health report within 24 h', { [STORAGE_KEYS.healthReport]: report(false, T0 - 23 * HOUR) }, {}, WRITE_FEATURES, 'health check failed'],
    ['a failed runtime health report', {}, { [STORAGE_KEYS.runtimeHealth]: report(false, T0 - MIN) }, WRITE_FEATURES, 'health check failed'],
    // Calendar writes go to Google: the SGW session never blocks them (T-36 ruling).
    ['no SGW session (logged-out; SGW writes only)', { [STORAGE_KEYS.sgwSession]: undefined }, {}, SGW_FEATURES, 'SGW session is logged-out'],
    [
      'an expired SGW session (SGW writes only)',
      { [STORAGE_KEYS.sgwSession]: { ...SESSION, expiresAt: T0 - 1 } },
      {},
      SGW_FEATURES,
      'SGW session is expired',
    ],
    ['meta-corrupt storage', { [STORAGE_KEYS.meta]: 'garbage', [STORAGE_KEYS.rules]: 'not an array' }, {}, WRITE_FEATURES, 'storage needs repair'],
  ] as const)('blocks writes on %s', async (_name, seed, seedSession, blocked, why) => {
    const areas = new FakeStorageAreas();
    areas.local.seed({ [STORAGE_KEYS.meta]: META, [STORAGE_KEYS.settings]: liveSettings(), [STORAGE_KEYS.sgwSession]: SESSION });
    for (const [k, v] of Object.entries(seed) as Array<[string, unknown]>) {
      if (v === undefined) void areas.local.remove([k]);
      else areas.local.seed({ [k]: v });
    }
    const h = boot({ areas, bare: true, seedSession });
    const ctx = await h.handle.ready;
    for (const f of WRITE_FEATURES) {
      const v = await ctx.switches.writesAllowed(f);
      if ((blocked as readonly string[]).includes(f)) {
        expect(v.ok, f).toBe(false);
        expect(v.why, f).toContain(why);
      } else {
        expect(v, f).toEqual({ ok: true });
      }
    }
  });

  it('calendar is exempt from the SGW session, but not from SGW health, the kill switch or dryRun.calendar (T-36 ruling)', async () => {
    const h = boot({ seed: { [STORAGE_KEYS.sgwSession]: { ...SESSION, expiresAt: T0 - 1 } } });
    const ctx = await h.handle.ready;
    expect(await ctx.session.state()).toBe('expired');
    expect(await verdicts(ctx.switches)).toEqual({
      favorites: { ok: false, why: 'SGW session is expired' },
      calendar: { ok: true },
      bidding: { ok: false, why: 'SGW session is expired' },
    });
    await h.areas.local.remove([STORAGE_KEYS.sgwSession]);
    expect(await ctx.switches.writesAllowed('calendar')).toEqual({ ok: true });
    expect(ctx.switches.view().writesAllowed).toEqual({ favorites: false, calendar: true, bidding: false });

    // SGW health still blocks calendar: drifted SGW data could carry wrong end times.
    await h.areas.local.set({ [STORAGE_KEYS.healthReport]: report(false, h.clock.now()) });
    expect(await ctx.switches.writesAllowed('calendar')).toEqual({ ok: false, why: 'health check failed' });
    await h.areas.local.set({ [STORAGE_KEYS.healthReport]: report(true, h.clock.now() + 1) });
    expect(await ctx.switches.writesAllowed('calendar')).toEqual({ ok: true });

    await h.ok('settings.set', { dryRun: { favorites: false, calendar: true, bidding: false } });
    expect(await ctx.switches.writesAllowed('calendar')).toEqual({ ok: false, why: 'dry run' });
    await h.ok('settings.set', { dryRun: { favorites: false, calendar: false, bidding: false } });
    await h.ok('kill.set', { on: true });
    expect(await ctx.switches.writesAllowed('calendar')).toEqual({ ok: false, why: 'kill switch is on' });
  });

  it('an expiring session (< 72 h left) still writes; an older failing report does not block', async () => {
    const h = boot({
      seed: {
        [STORAGE_KEYS.sgwSession]: {
          ...SESSION,
          bearer: jwt({ BuyerId: '42', exp: Math.floor((T0 + 10 * HOUR) / 1000), jti: 'soon' }),
          expiresAt: T0 + 10 * HOUR,
        },
        [STORAGE_KEYS.healthReport]: report(false, T0 - HEALTH_WINDOW_MS - 1),
      },
    });
    const ctx = await h.handle.ready;
    expect(await ctx.session.state()).toBe('expiring');
    expect(await verdicts(ctx.switches)).toEqual(ALL_OK);
    // Time alone expires the session: no storage read needed.
    h.clock.advance(10 * HOUR);
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: false, why: 'SGW session is expired' });
  });

  it('follows storage.onChanged: settings, health reports and the session record', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    expect(await verdicts(ctx.switches)).toEqual(ALL_OK);

    // Another context changes the settings.
    await h.areas.local.set({ [STORAGE_KEYS.settings]: liveSettings({ dryRun: { favorites: false, calendar: true, bidding: false } }) });
    expect(await ctx.switches.writesAllowed('calendar')).toEqual({ ok: false, why: 'dry run' });
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: true });

    // T-30 stores a failing report.
    await h.areas.local.set({ [STORAGE_KEYS.healthReport]: report(false, h.clock.now()) });
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: false, why: 'health check failed' });
    await h.areas.session.set({ [STORAGE_KEYS.runtimeHealth]: report(true, h.clock.now() + 1) });
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: true });

    // The session is cleared (logout): blocked at once, before any re-check.
    await h.areas.local.remove([STORAGE_KEYS.sgwSession]);
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: false, why: 'SGW session is logged-out' });

    // A new token arrives: still blocked until the session confirms it, then allowed.
    await ctx.session.observe({ bearer: BEARER, capturedAt: h.clock.now(), source: 'tap' });
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: false, why: 'SGW session is logged-out' });
    // The re-check hashes the token (crypto.subtle), so wait for it rather than for a fixed number of ticks.
    await vi.waitFor(async () => {
      expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: true });
    });

    // SGW rejected the held token (a 401): blocked at once.
    await ctx.session.reportRejected(BEARER);
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: false, why: 'SGW session is expired' });
    await flush();
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: false, why: 'SGW session is expired' });
  });

  it('broadcasts switches.changed when a dry-run switch changes through settings.set', async () => {
    const h = boot();
    await h.handle.ready;
    await h.ok('settings.set', { dryRun: { favorites: true, calendar: false, bidding: false } });
    expect(h.broadcasts('switches.changed').at(-1)).toMatchObject({
      payload: { killSwitch: false, writesAllowed: { favorites: false, calendar: true, bidding: true } },
    });
  });
});

// ── Kill switch (R3) ─────────────────────────────────────────────────────────

describe('kill switch (R3)', () => {
  it('is immediate in memory, before it is persisted; a failed persist still blocks', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    const realSet = h.areas.local.set.bind(h.areas.local);
    const hold = deferred();
    h.areas.local.set = async (entries) => {
      if (STORAGE_KEYS.settings in entries) {
        await hold.promise;
        throw new Error('storage crashed mid-persist');
      }
      return realSet(entries);
    };
    const pending = h.send('kill.set', { on: true });
    // The persist has not finished (and will fail), but writes are already blocked.
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: false, why: 'kill switch is on' });
    hold.resolve();
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(await verdicts(ctx.switches)).toEqual({
      favorites: { ok: false, why: 'kill switch is on' },
      calendar: { ok: false, why: 'kill switch is on' },
      bidding: { ok: false, why: 'kill switch is on' },
    });
  });

  it(`the ${KILL_COMMAND} command (Alt+Shift+K) turns the kill switch on, persists and audits it; other commands are ignored`, async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    const fire = (command: string): void => {
      for (const l of h.fb.onCommand.listeners) l(command);
    };
    fire('some-other-command');
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: true });

    fire(KILL_COMMAND);
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: false, why: 'kill switch is on' });
    await flush();
    expect((h.areas.local.dump()[STORAGE_KEYS.settings] as Settings).killSwitch).toBe(true);
    expect(h.audit()).toContainEqual(expect.objectContaining({ kind: 'kill.on', details: { source: 'shortcut' } }));
    // Pressing it again never turns the kill switch off.
    fire(KILL_COMMAND);
    await flush();
    expect(ctx.switches.view().killSwitch).toBe(true);
  });

  it('the shortcut works before startup finishes, and is persisted only after migrate', async () => {
    const areas = new FakeStorageAreas();
    const realGet = areas.local.get.bind(areas.local);
    const metaGate = deferred();
    areas.local.get = async <T>(key: string): Promise<T | undefined> => {
      if (key === STORAGE_KEYS.meta) await metaGate.promise;
      return realGet<T>(key);
    };
    const h = boot({ areas });
    for (const l of h.fb.onCommand.listeners) l(KILL_COMMAND);
    expect(h.handle.switches.view().killSwitch).toBe(true);
    await flush();
    expect((areas.local.dump()[STORAGE_KEYS.settings] as Settings).killSwitch).toBe(false);
    metaGate.resolve();
    const ctx = await h.handle.ready;
    await flush();
    expect((areas.local.dump()[STORAGE_KEYS.settings] as Settings).killSwitch).toBe(true);
    expect(await ctx.switches.writesAllowed('favorites')).toEqual({ ok: false, why: 'kill switch is on' });
    // Announced once serving (an early change has no subscriber yet).
    expect(h.broadcasts('switches.changed').at(-1)).toMatchObject({ payload: { killSwitch: true } });
  });

  it('on restart the persisted kill switch is loaded before any handler serves', async () => {
    const areas = new FakeStorageAreas();
    const first = boot({ areas });
    await first.handle.ready;
    await first.ok('kill.set', { on: true });

    // A new worker over the same storage; a message arrives before it is ready.
    const second = boot({ areas, bare: true });
    const early = second.send('settings.get');
    const ctx = await second.handle.ready;
    expect(await early).toMatchObject({ ok: true, reply: { killSwitch: true } });
    expect(await ctx.switches.writesAllowed('favorites')).toEqual({ ok: false, why: 'kill switch is on' });
    // settings.set can never resume automation, even with a stale whole-settings object.
    await second.ok('settings.set', { killSwitch: false, considerateMode: 'tight' });
    expect((areas.local.dump()[STORAGE_KEYS.settings] as Settings).killSwitch).toBe(true);
    expect(ctx.switches.view().killSwitch).toBe(true);
  });
});

// ── Startup order and readiness (R4) ─────────────────────────────────────────

describe('startup and readiness (R4)', () => {
  it(`rejects queued and new messages with a "starting" error when startup takes longer than ${String(STARTUP_DEADLINE_MS)} ms`, async () => {
    const areas = new FakeStorageAreas();
    const realGet = areas.local.get.bind(areas.local);
    const metaGate = deferred();
    areas.local.get = async <T>(key: string): Promise<T | undefined> => {
      if (key === STORAGE_KEYS.meta) await metaGate.promise;
      return realGet<T>(key);
    };
    const h = boot({ areas });
    const early = h.send('settings.get');
    h.clock.advance(STARTUP_DEADLINE_MS);
    const starting = { ok: false, error: { code: 'handler_error', message: expect.stringContaining('starting') as unknown } };
    expect(await early).toEqual(starting);
    expect(await h.send('health.get')).toEqual(starting);

    // Once startup finishes, messages are served again.
    metaGate.resolve();
    await h.handle.ready;
    expect((await h.send('settings.get')).ok).toBe(true);
  });

  it('alarms, ports and lifecycle events that arrive before ready are replayed to modules; unknown port names are left alone', async () => {
    const areas = new FakeStorageAreas();
    const realGet = areas.local.get.bind(areas.local);
    const metaGate = deferred();
    areas.local.get = async <T>(key: string): Promise<T | undefined> => {
      if (key === STORAGE_KEYS.meta) await metaGate.promise;
      return realGet<T>(key);
    };
    const seen: string[] = [];
    const job: BackgroundModule = {
      register: (ctx) => {
        ctx.alarms.onAlarm((a) => seen.push(`alarm ${a.name}`));
        ctx.lifecycle.onStartup(() => seen.push('startup'));
        ctx.lifecycle.onInstalled((d) => seen.push(`installed ${d.reason}`));
        ctx.ports.serve('sbw:job-progress', (p) => seen.push(`port ${p.name}`));
      },
    };
    const h = boot({ areas, jobModules: { './zz-job.ts': job } });
    await h.alarms.create('sbw:tick', { delayInMinutes: 1 });
    h.clock.advance(MIN);
    for (const l of h.fb.onStartup.listeners) l();
    for (const l of h.fb.onInstalled.listeners) l({ reason: 'update' });
    const port = (name: string) => {
      const disconnect = vi.fn<() => void>();
      const postMessage = vi.fn<(m: unknown) => void>();
      const p: RuntimePort = {
        name,
        sender: { id: EXT_ID, url: `${EXT_ORIGIN}sidebar.html` },
        postMessage,
        disconnect,
        onMessage: { addListener: () => undefined, removeListener: () => undefined },
        onDisconnect: { addListener: () => undefined, removeListener: () => undefined },
      };
      return { port: p, disconnect, postMessage };
    };
    const progress = port('sbw:job-progress');
    const testHook = port('sbw:test:state');
    for (const l of h.fb.onConnect.listeners) {
      l(progress.port);
      l(testHook.port);
    }
    expect(seen).toEqual([]);

    metaGate.resolve();
    await h.handle.ready;
    await flush();
    expect(seen).toEqual(['alarm sbw:tick', 'startup', 'installed update', 'port sbw:job-progress']);
    expect(testHook.disconnect).not.toHaveBeenCalled();
    expect(testHook.postMessage).not.toHaveBeenCalled();
    expect(progress.disconnect).not.toHaveBeenCalled();

    // After ready, events go straight through.
    await h.alarms.create('sbw:tick', { delayInMinutes: 1 });
    h.clock.advance(MIN);
    expect(seen.at(-1)).toBe('alarm sbw:tick');
  });

  it('under SBW_TEST installs T-12 test hooks, whose ports the background ignores', async () => {
    vi.stubEnv('SBW_TEST', '1');
    const h = boot();
    await h.handle.ready;
    // test hooks add their own onConnect listener next to the background's.
    expect(h.fb.onConnect.listeners.length).toBe(2);
  });
});

// ── Wiring ───────────────────────────────────────────────────────────────────

describe('wiring', () => {
  it('startup makes zero network requests (R7)', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('no network in tests')));
    vi.stubGlobal('fetch', fetchSpy);
    const h = boot();
    // Lifecycle events before ready (replayed) and after.
    for (const l of h.fb.onInstalled.listeners) l({ reason: 'install' });
    for (const l of h.fb.onStartup.listeners) l();
    const ctx = await h.handle.ready;
    for (const l of h.fb.onInstalled.listeners) l({ reason: 'update', previousVersion: '0.0.0' });
    for (const l of h.fb.onStartup.listeners) l();
    await flush();
    h.clock.advance(10 * MIN);
    await flush();
    expect(h.http.requests).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(Object.values(ctx.scheduler.stats().lanes).map((l) => l.usedToday)).toEqual([0, 0, 0, 0]);
    // T-52: reconcile() creates the one `sbw:tick` alarm (no request, R7 still holds).
    expect(await h.alarms.getAll()).toEqual([expect.objectContaining({ name: 'sbw:tick', periodInMinutes: 2 })]);
    expect(h.notifier.sent).toEqual([]);
  });

  it('meta-corrupt storage blocks every write and shows in health.get', async () => {
    const h = boot({ bare: true, seed: { [STORAGE_KEYS.meta]: 'garbage', [STORAGE_KEYS.rules]: 'not an array', [STORAGE_KEYS.settings]: liveSettings() } });
    const ctx = await h.handle.ready;
    expect(ctx.startup.migration?.health).toBe('meta-corrupt');
    for (const f of WRITE_FEATURES) expect((await ctx.switches.writesAllowed(f)).why).toContain('storage needs repair');
    const health = (await h.ok('health.get')) as { sgw: HealthReport | null };
    expect(health.sgw?.ok).toBe(false);
  });

  it('a schema failure blocks writes at once, T-30 keeps it sticky, and a valid reply from the same endpoint clears it', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    const query = { searchText: 'pyrex', categoryIds: [], sellerIds: [], page: 1 };
    h.http.on(`${API}Search/ItemListing`, { status: 200, bodyText: JSON.stringify({ unexpected: true }) });
    await expect(ctx.api.search(query, 'interactive')).rejects.toMatchObject({ kind: 'schema' });
    // Fail closed before T-30 has stored anything.
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: false, why: 'health check failed' });

    await flush();
    const stored = h.areas.local.dump()[STORAGE_KEYS.healthReport] as HealthReport;
    expect(stored.ok).toBe(false);
    expect(stored.checks.find((c) => c.name === 'search-schema')).toMatchObject({ ok: false, detail: expect.stringContaining('sticky schema failure: search') as unknown });
    expect(h.audit()).toContainEqual(
      expect.objectContaining({ actor: 'health', kind: 'health.fail', details: expect.objectContaining({ checks: 'search-schema' }) as unknown }),
    );
    expect(((await h.ok('health.get')) as { sgw: HealthReport | null }).sgw).toMatchObject({ ok: false });

    // Another endpoint answering validly does not clear it...
    h.http.on(`${API}Favorite/GetAllFavoriteItemsByType`, { status: 200, bodyText: JSON.stringify(loadFixture('favorites-all')) });
    h.clock.advance(2 * MIN);
    await ctx.api.favorites('all', 'interactive');
    await flush();
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: false, why: 'health check failed' });

    // ...a valid search reply does (onSchemaOk -> recordSchemaSuccess).
    h.http.on(`${API}Search/ItemListing`, { status: 200, bodyText: JSON.stringify(emptySearch()) });
    h.clock.advance(2 * MIN);
    await ctx.api.search(query, 'interactive');
    await flush();
    expect((h.areas.local.dump()[STORAGE_KEYS.healthReport] as HealthReport).ok).toBe(true);
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: true });
  });

  it('a 401 to a request that carried the bearer expires the session and blocks writes (T-28 reportRejected)', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    h.http.on(API, { status: 401 });
    await expect(ctx.api.favorites('all', 'interactive')).rejects.toMatchObject({ kind: 'auth' });
    await flush();
    expect(await ctx.session.state()).toBe('expired');
    expect(await ctx.switches.writesAllowed('favorites')).toEqual({ ok: false, why: 'SGW session is expired' });
  });

  it('health.get answers the session, Google status (sbw:googleClient) and the request budget', async () => {
    const h = boot({ seed: { [STORAGE_KEYS.googleClient]: { clientId: 'abc.apps.googleusercontent.com', updatedAt: T0 } } });
    await h.handle.ready;
    const health = await h.ok('health.get');
    expect(health).toMatchObject({
      sgw: null,
      session: SESSION_EXP,
      sessionState: 'ok',
      google: { connected: false, configured: true },
      budget: { lanes: { background: { usedToday: 0, budget: 120 } } },
    });
  });

  it('settings.set applies considerate mode to the scheduler', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    expect(ctx.scheduler.stats().lanes.background.budget).toBe(120);
    await h.ok('settings.set', { considerateMode: 'tight' });
    expect(ctx.scheduler.stats().lanes.background.budget).toBe(60);
  });

  it('rules.save validates keywords, rules.preview uses the tab or the most recent SGW page, rules.delete broadcasts', async () => {
    const h = boot();
    await h.handle.ready;
    const rule = {
      id: 'r1',
      name: 'Pyrex',
      enabled: true,
      action: 'highlight',
      tone: 'green',
      all: [{ kind: 'keyword', mode: 'any', terms: ['pyrex'], wholeWord: true, regex: false, fields: ['title'] }],
      createdAt: T0,
      updatedAt: T0,
    };
    await h.ok('page.listings', { url: 'https://shopgoodwill.com/a', listings: [listing(1, { title: 'Pyrex bowl' }), listing(2)], capturedAt: T0 }, CONTENT);
    await h.ok('page.listings', { url: 'https://shopgoodwill.com/b', listings: [listing(3)], capturedAt: T0 }, { ...CONTENT, tab: { id: 9 } });
    expect(await h.ok('rules.preview', { rule })).toEqual({ matched: 0, total: 1, ids: [] });
    expect(await h.ok('rules.preview', { rule, tabId: 7 })).toEqual({ matched: 1, total: 2, ids: [1] });

    const bad = await h.send('rules.save', { ...rule, all: [{ ...rule.all[0], regex: true, terms: ['(unclosed'] }] });
    expect(bad.ok).toBe(false);
    await h.ok('rules.save', rule);
    expect(await h.ok('rules.list')).toEqual([rule]);
    await h.ok('rules.delete', { id: 'r1' });
    expect(await h.ok('rules.list')).toEqual([]);
    expect(h.broadcasts('rules.changed')).toHaveLength(2);
  });

  it('quick.hideKeyword adds a hide rule; quick.track tracks an item seen on a page', async () => {
    const h = boot();
    await h.handle.ready;
    await h.ok('quick.hideKeyword', { term: 'Lot' }, CONTENT);
    const rules = h.areas.local.dump()[STORAGE_KEYS.rules] as Array<{ id: string; action: string; all: unknown[] }>;
    expect(rules).toEqual([
      expect.objectContaining({
        id: 'quick:keyword:lot',
        action: 'hide',
        all: [{ kind: 'keyword', mode: 'any', terms: ['Lot'], wholeWord: true, regex: false, fields: ['title'] }],
      }),
    ]);

    expect((await h.send('quick.track', { itemId: 1 }, CONTENT)).ok).toBe(false);
    await h.ok('page.listings', { url: 'https://shopgoodwill.com/a', listings: [listing(1)], capturedAt: T0 }, CONTENT);
    await h.ok('quick.track', { itemId: 1 }, CONTENT);
    expect((h.areas.local.dump()[STORAGE_KEYS.tracked] as Record<string, unknown>)['1']).toMatchObject({
      itemId: 1,
      title: 'Item 1',
      sellerId: 123,
      reasons: [{ kind: 'manual' }],
      favoriteState: 'none',
    });
  });

  it('quick.favorite in dry-run audits the intent and sends nothing', async () => {
    const h = boot({ seed: { [STORAGE_KEYS.settings]: { ...liveSettings({ dryRun: { favorites: true, calendar: true, bidding: true } }), overlay: { ...defaultSettings().overlay, quickFavorite: true } } } });
    await h.handle.ready;
    await h.ok('quick.favorite', { itemId: 55 }, CONTENT);
    expect(h.http.requests).toEqual([]);
    expect(h.audit()).toContainEqual(expect.objectContaining({ actor: 'user', kind: 'favorite.add', itemId: 55, dryRun: true }));
  });

  it('page.domHealth keeps the latest report per tab; T-30 health reads the newest (domReport)', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    const cards = async (): Promise<unknown> => (await ctx.health.run('anonymous')).checks.find((c) => c.name === 'card-selectors');
    const dom = { url: 'https://shopgoodwill.com/a', configVersion: 'v1', pageKind: 'search', cardsFound: 40, fallbackUsed: false };

    expect(await cards()).toEqual({ name: 'card-selectors', ok: true, detail: `${UNKNOWN_PREFIX}no content-script report yet` });
    await h.ok('page.domHealth', dom, CONTENT);
    expect(await cards()).toEqual({ name: 'card-selectors', ok: true });
    await h.ok('page.domHealth', { ...dom, cardsFound: 0 }, { ...CONTENT, tab: { id: 9 } });
    expect(ctx.pages.domReports()).toEqual([
      expect.objectContaining({ tabId: 7, cardsFound: 40 }),
      expect.objectContaining({ tabId: 9, cardsFound: 0, at: T0 }),
    ]);
    expect(await cards()).toEqual({ name: 'card-selectors', ok: true, detail: `${UNKNOWN_PREFIX}no cards parsed on the reported page` });
    await h.ok('page.domHealth', { ...dom, fallbackUsed: true }, CONTENT);
    expect(await cards()).toMatchObject({ ok: true, detail: expect.stringContaining('selector drift') as unknown });
    // Card drift is never a failure (T-30), and the probe found no network: one search attempt in all.
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: true });
    expect(h.http.requests).toHaveLength(1);
  });
});

// ── Fix round 1 (review) ─────────────────────────────────────────────────────

/** Storage whose `local.get(key)` can be held: `hold(key)` makes the next reads of it wait (stale value captured at the read). */
function holdableAreas(): {
  areas: FakeStorageAreas;
  hold: (key: string) => void;
  release: () => void;
  hangForever: (key: string) => void;
  unhang: (key: string) => void;
} {
  const areas = new FakeStorageAreas();
  const realGet = areas.local.get.bind(areas.local);
  const held = new Set<string>();
  const forever = new Set<string>();
  let gate = deferred();
  areas.local.get = async <T>(key: string): Promise<T | undefined> => {
    if (forever.has(key)) return new Promise<T | undefined>(() => undefined);
    if (!held.has(key)) return realGet<T>(key);
    const stale = await realGet<T>(key); // what the read saw when it started
    held.delete(key); // only the first read waits
    await gate.promise;
    return stale;
  };
  return {
    areas,
    hold: (key) => {
      gate = deferred();
      held.add(key);
    },
    release: () => {
      gate.resolve();
    },
    hangForever: (key) => {
      forever.add(key);
    },
    unhang: (key) => {
      forever.delete(key);
    },
  };
}

describe('fix round 1: startup timeouts', () => {
  it('a snapshot load that does not answer fails closed; ready still resolves; the 30 s retry loads it', async () => {
    const s = holdableAreas();
    s.hangForever(STORAGE_KEYS.settings);
    const h = boot({ areas: s.areas });
    await flush();
    h.clock.advance(SWITCHES_LOAD_TIMEOUT_MS);
    const ctx = await h.handle.ready;
    expect(ctx.switches.loaded).toBe(false);
    expect(await ctx.switches.writesAllowed('favorites')).toEqual({ ok: false, why: 'starting: the switch state is not loaded yet' });

    // Storage answers again: the retry 30 s later loads the snapshot.
    s.unhang(STORAGE_KEYS.settings);
    h.clock.advance(SWITCHES_RETRY_MS - 1);
    await flush();
    expect(ctx.switches.loaded).toBe(false);
    h.clock.advance(1);
    // The retried load reads the session, which hashes the token (crypto.subtle): wait for the condition.
    await vi.waitFor(() => {
      expect(ctx.switches.loaded).toBe(true);
    });
    expect(await verdicts(ctx.switches)).toEqual(ALL_OK);
  });

  it(`a migrate() that does not answer within ${String(MIGRATE_TIMEOUT_MS)} ms fails closed like meta-corrupt; startup continues`, async () => {
    const s = holdableAreas();
    s.hangForever(STORAGE_KEYS.meta);
    const h = boot({ areas: s.areas });
    await flush();
    h.clock.advance(MIGRATE_TIMEOUT_MS);
    const ctx = await h.handle.ready;
    expect(ctx.startup.migration).toBeNull();
    expect(ctx.startup.storageProblem).toContain('did not answer');
    for (const f of WRITE_FEATURES) {
      const v = await ctx.switches.writesAllowed(f);
      expect(v.ok, f).toBe(false);
      expect(v.why, f).toContain('storage needs repair');
    }
    const health = (await h.ok('health.get')) as { sgw: HealthReport | null };
    expect(health.sgw?.ok).toBe(false);
    // Reads still serve.
    expect((await h.send('settings.get')).ok).toBe(true);
  });
});

describe('fix round 1: startup kill races, each guard on its own', () => {
  it('a kill persisted while the snapshot load was reading is kept (killWrites guard), even before its onChanged arrives', async () => {
    const s = holdableAreas();
    // Deliver no local onChanged event until the end, so only the killWrites guard can keep the kill.
    const realOnChanged = s.areas.local.onChanged.bind(s.areas.local);
    const late: Array<() => void> = [];
    let deferEvents = true;
    s.areas.local.onChanged = (cb) =>
      realOnChanged((changes) => {
        if (deferEvents) {
          late.push(() => {
            cb(changes);
          });
        } else {
          cb(changes);
        }
      });
    s.hold(STORAGE_KEYS.settings); // the snapshot read starts, sees killSwitch false, and waits
    const h = boot({ areas: s.areas });
    await flush();
    for (const l of h.fb.onCommand.listeners) l(KILL_COMMAND);
    await flush(); // the kill is persisted while the load still waits
    expect((s.areas.local.dump()[STORAGE_KEYS.settings] as Settings).killSwitch).toBe(true);
    s.release();
    const ctx = await h.handle.ready;
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: false, why: 'kill switch is on' });
    deferEvents = false;
    for (const fire of late.splice(0)) fire();
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: false, why: 'kill switch is on' });
  });

  it('a kill another context stored while the snapshot load was reading is applied after it (the queued onChanged)', async () => {
    const s = holdableAreas();
    s.hold(STORAGE_KEYS.settings); // the snapshot read sees killSwitch false and waits
    const h = boot({ areas: s.areas });
    await flush();
    // Another worker (not this one's setKill, so no killWrites bump) stores the kill.
    await s.areas.local.set({ [STORAGE_KEYS.settings]: liveSettings({ killSwitch: true }) });
    s.release();
    const ctx = await h.handle.ready;
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: false, why: 'kill switch is on' });
  });
});

describe('fix round 1: GlobalSwitches details', () => {
  it('a report older than a flagged schema failure does not clear it; one at or after it does', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    h.clock.advance(MIN);
    ctx.switches.flagSchemaFailure({ endpoint: 'itemDetail', message: 'drift', at: h.clock.now() });
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: false, why: 'health check failed' });
    ctx.switches.noteHealthReport(report(true, h.clock.now() - 1));
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: false, why: 'health check failed' });
    ctx.switches.noteHealthReport(report(true, h.clock.now()));
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: true });
  });

  it('verdictNow answers synchronously, the same as writesAllowed', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    expect(ctx.switches.verdictNow('bidding')).toEqual({ ok: true });
    void ctx.switches.setKill(true, 'test');
    expect(ctx.switches.verdictNow('bidding')).toEqual({ ok: false, why: 'kill switch is on' });
  });

  it('feeds the one SgwClock: a GetCurrentTime reply sets the offset; re-adding the returned sample is a no-op', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    expect(ctx.sgwClock.offset()).toBeNull();
    h.http.on(`${API}Dashboard/GetCurrentTime`, { status: 200, bodyText: JSON.stringify(loadFixture('get-current-time')) });
    const sample = await ctx.api.serverTimeSample();
    expect(ctx.sgwClock.offset()).toMatchObject({ samples: 1 });
    ctx.sgwClock.addSample(sample);
    expect(ctx.sgwClock.offset()).toMatchObject({ samples: 1 });
    ctx.sgwClock.addSample({ ...sample }); // a different sample object counts
    expect(ctx.sgwClock.offset()).toMatchObject({ samples: 2 });
  });
});

describe('fix round 1: defence in depth for content-only handlers', () => {
  const detail = {
    ...listing(5),
    pickupOnly: false,
    minimumBid: 1400,
    bidIncrement: 100,
    serverTime: new Date(T0).toISOString(),
    serverTimeRaw: '2026-10-10T08:00:00',
    isClosed: false,
    isHighBidder: null,
    inWatchlist: null,
    bidHistory: [],
  };
  it.each([
    ['page.listings', { url: 'https://shopgoodwill.com/a', listings: [listing(1)], capturedAt: T0 }],
    ['page.detail', { detail }],
    ['page.token', { bearer: BEARER, capturedAt: T0 }],
    ['page.domHealth', { url: 'https://shopgoodwill.com/a', configVersion: 'v1', pageKind: 'search', cardsFound: 1, fallbackUsed: false }],
    ['quick.hideSeller', { sellerId: 1, sellerName: 'x' }],
    ['quick.hideKeyword', { term: 'lot' }],
    ['quick.favorite', { itemId: 1 }],
    ['quick.track', { itemId: 1 }],
  ])('%s from an extension page (UI) is refused by the handler itself', async (type, payload) => {
    const h = boot();
    const ctx = await h.handle.ready;
    const observe = vi.spyOn(ctx.session, 'observe');
    const before = h.areas.local.dump();
    expect(await h.send(type, payload, UI)).toEqual({
      ok: false,
      error: { code: 'handler_error', message: `only a content script may send "${type}"` },
    });
    expect(observe).not.toHaveBeenCalled();
    expect(ctx.pages.listingsFor()).toBeUndefined();
    expect(ctx.pages.domReport()).toBeNull();
    expect(h.areas.local.dump()).toEqual(before);
  });
});

describe('fix round 1: no post-kill window in the write path (T-26 writesAllowedNow)', () => {
  it('a kill flipped between enqueue and build: the write never reaches HTTP', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    h.http.on(`${API}Search/ItemListing`, { status: 200, bodyText: JSON.stringify(emptySearch()) });
    h.http.on(`${API}Favorite/AddToFavorite`, { status: 200, bodyText: JSON.stringify({ message: 'Ok', status: true, type: null, primaryKey: null, isUnauthorized: false }) });
    await ctx.api.search({ searchText: 'pyrex', categoryIds: [], sellerIds: [], page: 1 }, 'background'); // starts the 120 s gap
    const write = ctx.api.addFavorite(55).catch((e: unknown) => e);
    await flush();
    for (let t = 0; t < 120_000 - 1; t += 250) {
      h.clock.advance(Math.min(250, 120_000 - 1 - t));
      await flush(1);
    }
    // The last refresh said ok; the kill lands 1 ms before the write's turn.
    void ctx.switches.setKill(true, 'test');
    h.clock.advance(1);
    const err = await write;
    expect(err).toMatchObject({ kind: 'paused', message: 'kill switch is on' });
    expect(h.http.requests.map((r) => r.url)).toEqual([`${API}Search/ItemListing`]);
  });
});

describe('fix round 1: broadcasts reach content scripts (T-32 carry)', () => {
  it('rules.changed and switches.changed go to every open SGW tab via tabs.sendMessage; no receiver is fine', async () => {
    const h = boot();
    await h.handle.ready;
    // Tab 9 has no content script: "no receiver". Tab 7 receives.
    h.fb.tabsSend.mockImplementation((tabId: number) =>
      tabId === 9 ? Promise.reject(new Error('Could not establish connection. Receiving end does not exist.')) : Promise.resolve(undefined),
    );
    await h.ok('quick.hideSeller', { sellerId: 123, sellerName: 'Goodwill of Example' }, CONTENT);
    await h.ok('kill.set', { on: true });
    await flush();
    expect(h.fb.tabsQuery).toHaveBeenCalledWith({ url: ['https://shopgoodwill.com/*'] });
    const toTab = (tabId: number): string[] =>
      h.fb.tabsSend.mock.calls.filter(([id]) => id === tabId).map(([, m]) => (m as { type: string }).type);
    expect(toTab(7)).toEqual(['rules.changed', 'switches.changed']);
    expect(toTab(9)).toEqual(['rules.changed', 'switches.changed']);
    expect(h.fb.tabsSend.mock.calls[0]?.[1]).toMatchObject({ v: 1, type: 'rules.changed', reqId: expect.any(String) as unknown });

    // A failing tabs.query (and no page open) never fails the change.
    h.fb.tabsQuery.mockRejectedValueOnce(new Error('tabs unavailable'));
    expect(await h.send('kill.set', { on: false })).toEqual({ ok: true });
  });

  it('quick.hideSeller without a seller name builds the rule from sellerId (the seller condition matches ids)', async () => {
    const h = boot();
    await h.handle.ready;
    await h.ok('quick.hideSeller', { sellerId: 321, sellerName: '' }, CONTENT);
    expect(h.areas.local.dump()[STORAGE_KEYS.rules]).toEqual([
      expect.objectContaining({
        id: 'quick:seller:321',
        name: 'Hide seller: seller 321',
        all: [{ kind: 'seller', mode: 'include', sellerIds: [321], sellerNames: [] }],
      }),
    ]);
    const evaluated = (await h.ok('rules.evaluate', { listings: [listing(1, { sellerId: 321 }), listing(2)] }, CONTENT)) as Array<{
      decision: string;
    }>;
    expect(evaluated.map((r) => r.decision)).toEqual(['hide', 'none']);
  });
});

describe('T-30b: feature-scoped sticky blocking and the audited resume', () => {
  const fail = async (ctx: Awaited<BackgroundHandle['ready']>, h: ReturnType<typeof boot>, endpoint: SgwEndpointKey): Promise<void> => {
    await ctx.health.recordSchemaFailure({ endpoint, message: `${endpoint} drifted`, at: h.clock.now() });
    await flush();
  };

  it('a placeBid sticky failure blocks bidding only; favorites and calendar stay allowed', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    await fail(ctx, h, 'placeBid');
    expect(await verdicts(ctx.switches)).toEqual({
      favorites: { ok: true },
      calendar: { ok: true },
      bidding: { ok: false, why: 'health check failed' },
    });
  });

  it('showBidModal blocks bidding; the favorites endpoints block favorites', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    await fail(ctx, h, 'showBidModal');
    expect((await ctx.switches.writesAllowed('bidding')).ok).toBe(false);
    expect((await ctx.switches.writesAllowed('favorites')).ok).toBe(true);
    for (const e of ['addFavorite', 'removeFavorite', 'saveFavoriteNote', 'favorites'] as const) {
      const h2 = boot();
      const c2 = await h2.handle.ready;
      await fail(c2, h2, e);
      expect(await verdicts(c2.switches), e).toEqual({
        favorites: { ok: false, why: 'health check failed' },
        calendar: { ok: true },
        bidding: { ok: true },
      });
    }
  });

  it('a search or itemDetail sticky failure blocks every feature; so does any other endpoint', async () => {
    for (const e of ['search', 'itemDetail', 'currentTime', 'sellerInfo'] as const) {
      const h = boot();
      const ctx = await h.handle.ready;
      await fail(ctx, h, e);
      for (const f of WRITE_FEATURES) expect((await ctx.switches.writesAllowed(f)).ok, `${e} ${f}`).toBe(false);
    }
  });

  it('a schema failure flagged but not yet stored is scoped the same way', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    ctx.switches.flagSchemaFailure({ endpoint: 'placeBid', message: 'x', at: h.clock.now() });
    expect((await ctx.switches.writesAllowed('favorites')).ok).toBe(true);
    expect((await ctx.switches.writesAllowed('bidding')).ok).toBe(false);
  });

  it('other failing checks keep their all-features effect, even next to a scoped sticky failure', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    await fail(ctx, h, 'placeBid');
    await h.areas.local.set({ [STORAGE_KEYS.healthReport]: report(false, h.clock.now() + 1) }); // a drift/stale style failure
    for (const f of WRITE_FEATURES) expect((await ctx.switches.writesAllowed(f)).ok, f).toBe(false);
    // ...and the resume does not clear it.
    await h.ok('health.clearSticky', { endpoint: 'placeBid' });
    await flush();
    for (const f of WRITE_FEATURES) expect((await ctx.switches.writesAllowed(f)).ok, f).toBe(false);
  });

  it('a stale probe escalation blocks all features, and a resume does not clear it', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    await ctx.health.run('anonymous'); // no samples: probes are unknown
    h.clock.advance(25 * HOUR);
    await fail(ctx, h, 'placeBid'); // recompose: detail-schema is now stale + sticky
    for (const f of WRITE_FEATURES) expect((await ctx.switches.writesAllowed(f)).ok, f).toBe(false);
    await h.ok('health.clearSticky', { endpoint: 'placeBid' });
    await flush();
    const stored = h.areas.local.dump()[STORAGE_KEYS.healthReport] as HealthReport;
    expect(stored.checks.some((c) => !c.ok && c.detail?.startsWith('stale') === true)).toBe(true);
    for (const f of WRITE_FEATURES) expect((await ctx.switches.writesAllowed(f)).ok, f).toBe(false);
  });

  const stickyReport = (checks: HealthReport['checks'], at: number): HealthReport => ({ ok: false, checkedAt: at, configVersion: 'test', checks });
  const STICKY_DETAIL = 'sticky schema failure: placeBid: drifted';
  const probeWith = (endpoints: string[]) => ({
    probedAt: T0,
    lastGoodProbeAt: {},
    sticky: endpoints.map((endpoint) => ({ endpoint, at: T0, detail: 'drifted' })),
  });
  const allBlocked = async (ctx: Awaited<BackgroundHandle['ready']>, label: string): Promise<void> => {
    for (const f of WRITE_FEATURES) expect((await ctx.switches.writesAllowed(f)).ok, `${label}: ${f}`).toBe(false);
  };

  it('a sticky-only report with an EMPTY sticky list fails closed for every feature', async () => {
    const h = boot({
      seed: {
        [STORAGE_KEYS.healthReport]: stickyReport([{ name: 'detail-schema', ok: false, detail: STICKY_DETAIL }], T0),
        [STORAGE_KEYS.healthProbe]: probeWith([]),
      },
    });
    await allBlocked(await h.handle.ready, 'empty list');
  });

  it('a corrupt healthProbe change fails closed for every feature (the old list is not kept)', async () => {
    const h = boot({
      seed: {
        [STORAGE_KEYS.healthReport]: stickyReport([{ name: 'detail-schema', ok: false, detail: STICKY_DETAIL }], T0),
        [STORAGE_KEYS.healthProbe]: probeWith(['placeBid']),
      },
    });
    const ctx = await h.handle.ready;
    expect((await ctx.switches.writesAllowed('favorites')).ok).toBe(true);
    await h.areas.local.set({ [STORAGE_KEYS.healthProbe]: { sticky: 'garbage' } });
    await allBlocked(ctx, 'corrupt probe');
  });

  it('a placeBid sticky failure plus a shipping-quote problem blocks every feature', async () => {
    const h = boot({
      seed: {
        [STORAGE_KEYS.healthReport]: stickyReport(
          [{ name: 'detail-schema', ok: false, detail: `${STICKY_DETAIL}; shipping-quote: cached reply no longer parses` }],
          T0,
        ),
        [STORAGE_KEYS.healthProbe]: probeWith(['placeBid']),
      },
    });
    await allBlocked(await h.handle.ready, 'shipping');
  });

  it('a placeBid sticky failure plus clock skew blocks every feature', async () => {
    const h = boot({
      seed: {
        [STORAGE_KEYS.healthReport]: stickyReport(
          [
            { name: 'detail-schema', ok: false, detail: STICKY_DETAIL },
            { name: 'clock', ok: false, detail: 'skew: offset 400000 ms exceeds 5 min' },
          ],
          T0,
        ),
        [STORAGE_KEYS.healthProbe]: probeWith(['placeBid']),
      },
    });
    await allBlocked(await h.handle.ready, 'clock');
  });

  it('health.clearSticky removes only that entry, audits health.resume and re-evaluates at once', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    await fail(ctx, h, 'placeBid');
    await fail(ctx, h, 'addFavorite');
    expect((await ctx.switches.writesAllowed('bidding')).ok).toBe(false);
    await h.ok('health.clearSticky', { endpoint: 'placeBid' });
    const probe = h.areas.local.dump()[STORAGE_KEYS.healthProbe] as { sticky: Array<{ endpoint: string }> };
    expect(probe.sticky.map((x) => x.endpoint)).toEqual(['addFavorite']);
    expect(h.audit()).toContainEqual(
      expect.objectContaining({ actor: 'user', kind: 'health.resume', details: expect.objectContaining({ endpoint: 'placeBid' }) as unknown }),
    );
    // No flush: the verdict is already updated.
    expect((await ctx.switches.writesAllowed('bidding')).ok).toBe(true);
    expect((await ctx.switches.writesAllowed('favorites')).ok).toBe(false);
    await h.ok('health.clearSticky', { endpoint: 'addFavorite' });
    expect(await verdicts(ctx.switches)).toEqual(ALL_OK);
    expect((h.areas.local.dump()[STORAGE_KEYS.healthReport] as HealthReport).ok).toBe(true);
  });

  it('health.clearSticky for an endpoint that is not sticky changes nothing and audits nothing', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    await fail(ctx, h, 'placeBid');
    await h.ok('health.clearSticky', { endpoint: 'addFavorite' });
    expect(h.audit().filter((e) => e.kind === 'health.resume')).toEqual([]);
    expect((await ctx.switches.writesAllowed('bidding')).ok).toBe(false);
  });

  it('health.clearSticky from a content script is refused', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    await fail(ctx, h, 'placeBid');
    const r = await h.send('health.clearSticky', { endpoint: 'placeBid' }, CONTENT);
    expect(r.ok).toBe(false);
    expect((await ctx.switches.writesAllowed('bidding')).ok).toBe(false);
    expect(h.audit().filter((e) => e.kind === 'health.resume')).toEqual([]);
  });

  it('health.get lists the sticky failures with the features they block', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    await fail(ctx, h, 'placeBid');
    const got = (await h.ok('health.get')) as { sticky: unknown };
    expect(got.sticky).toEqual([{ endpoint: 'placeBid', at: h.clock.now(), detail: 'placeBid drifted', features: ['bidding'] }]);
  });

  it('the scoped block survives a restart', async () => {
    const h = boot();
    const ctx = await h.handle.ready;
    await fail(ctx, h, 'placeBid');
    const h2 = boot({ areas: h.areas, clock: h.clock });
    const ctx2 = await h2.handle.ready;
    expect((await ctx2.switches.writesAllowed('favorites')).ok).toBe(true);
    expect((await ctx2.switches.writesAllowed('bidding')).ok).toBe(false);
  });
});

describe('verdictNow ignoreDryRun (T-84)', () => {
  const dryBidding = liveSettings({ dryRun: { favorites: false, calendar: false, bidding: true } });
  const at = T0;
  const sticky = (endpoint: string, detail: string): HealthReport => ({
    ok: false,
    checkedAt: at,
    configVersion: 'test',
    checks: [{ name: 'detail-schema', ok: false, detail }],
  });
  const probe = (endpoint: string) => ({
    probedAt: at,
    lastGoodProbeAt: {},
    sticky: [{ endpoint, at, detail: 'drift' }],
  });

  it('skips only the dry-run condition; writesAllowed and the view still report it', async () => {
    const h = boot({ seed: { [STORAGE_KEYS.settings]: dryBidding } });
    const ctx = await h.handle.ready;
    expect(ctx.switches.verdictNow('bidding')).toEqual({ ok: false, why: 'dry run' });
    expect(ctx.switches.verdictNow('bidding', { ignoreDryRun: false })).toEqual({ ok: false, why: 'dry run' });
    expect(ctx.switches.verdictNow('bidding', { ignoreDryRun: true })).toEqual({ ok: true });
    expect(ctx.switches.verdictNow('favorites', { ignoreDryRun: true })).toEqual({ ok: true });
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: false, why: 'dry run' });
    expect(ctx.switches.view().writesAllowed.bidding).toBe(false);
  });

  it('still fails closed on kill, health, a pending flag, session, storage and startup', async () => {
    const h = boot({ seed: { [STORAGE_KEYS.settings]: dryBidding } });
    const ctx = await h.handle.ready;
    await h.ok('kill.set', { on: true });
    expect(ctx.switches.verdictNow('bidding', { ignoreDryRun: true })).toEqual({ ok: false, why: 'kill switch is on' });
    await h.ok('kill.set', { on: false });

    await h.areas.local.set({ [STORAGE_KEYS.healthReport]: report(false, h.clock.now()) });
    expect(ctx.switches.verdictNow('bidding', { ignoreDryRun: true })).toEqual({ ok: false, why: 'health check failed' });
    expect(ctx.switches.verdictNow('favorites', { ignoreDryRun: true })).toEqual({ ok: false, why: 'health check failed' });
    await h.areas.local.set({ [STORAGE_KEYS.healthReport]: report(true, h.clock.now() + 1) });

    ctx.switches.flagSchemaFailure({ endpoint: 'placeBid', message: 'drift', at: h.clock.now() });
    expect(ctx.switches.verdictNow('bidding', { ignoreDryRun: true })).toEqual({ ok: false, why: 'health check failed' });
    expect(ctx.switches.verdictNow('favorites', { ignoreDryRun: true })).toEqual({ ok: true });
    expect(await ctx.switches.writesAllowed('bidding')).toEqual({ ok: false, why: 'dry run' });

    const loggedOut = boot({ seed: { [STORAGE_KEYS.settings]: dryBidding } });
    const out = await loggedOut.handle.ready;
    await loggedOut.areas.local.remove([STORAGE_KEYS.sgwSession]);
    expect(out.switches.verdictNow('bidding', { ignoreDryRun: true })).toEqual({ ok: false, why: 'SGW session is logged-out' });
    expect(out.switches.verdictNow('calendar', { ignoreDryRun: true })).toEqual({ ok: true });

    const broken = boot({
      bare: true,
      seed: { [STORAGE_KEYS.meta]: 'garbage', [STORAGE_KEYS.rules]: 'not an array', [STORAGE_KEYS.settings]: dryBidding },
    });
    const bad = await broken.handle.ready;
    expect(bad.switches.verdictNow('bidding', { ignoreDryRun: true }).why).toContain('storage needs repair');

    const early = boot();
    expect(early.handle.switches.verdictNow('bidding', { ignoreDryRun: true })).toEqual({
      ok: false,
      why: 'starting: the switch state is not loaded yet',
    });
  });

  it('keeps T-30b sticky scoping when the dry-run condition is ignored', async () => {
    const favorites = boot({
      seed: {
        [STORAGE_KEYS.settings]: dryBidding,
        [STORAGE_KEYS.healthReport]: sticky('addFavorite', 'sticky schema failure: addFavorite: drift'),
        [STORAGE_KEYS.healthProbe]: probe('addFavorite'),
      },
    });
    const fav = await favorites.handle.ready;
    expect(fav.switches.verdictNow('bidding', { ignoreDryRun: true })).toEqual({ ok: true });
    expect(fav.switches.verdictNow('favorites', { ignoreDryRun: true })).toEqual({ ok: false, why: 'health check failed' });

    const bidding = boot({
      seed: {
        [STORAGE_KEYS.settings]: dryBidding,
        [STORAGE_KEYS.healthReport]: sticky('placeBid', 'sticky schema failure: placeBid: drifted'),
        [STORAGE_KEYS.healthProbe]: probe('placeBid'),
      },
    });
    const bid = await bidding.handle.ready;
    expect(bid.switches.verdictNow('bidding', { ignoreDryRun: true })).toEqual({ ok: false, why: 'health check failed' });
    expect(bid.switches.verdictNow('favorites', { ignoreDryRun: true })).toEqual({ ok: true });
    expect(bid.switches.verdictNow('calendar', { ignoreDryRun: true })).toEqual({ ok: true });
  });
});
