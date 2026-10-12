// T-111: the extension side of the T2 wake-and-launch companion.
//
//   src/adapters/browser/companion.ts      CompanionPort over native messaging
//                                          (one-shot sendNativeMessage to
//                                          com.shopbadwill.companion, zod-checked
//                                          replies, a short timeout; any failure
//                                          is "unreachable", never a throw)
//   src/background/jobs/companion-sync.ts  ArmHooks on T-84's registry: schedule
//                                          on arm, cancel on disarm/resolve,
//                                          reachability at the T-15 preflight
//                                          (tier T2 only); the awake-history
//                                          filter for companion-caused wakes
//
// Everything runs inside the real background composition root (main.ts) over
// fakes: FakeClock, FakeStorageAreas, FakeAlarms, a tiny SGW over FakeHttp, and
// a fake native host that speaks companion/windows/PROTOCOL.md (exact keys,
// R2 validation) instead of Task Scheduler. No real host, no scheduled task,
// no registry entry, no network.
import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import {
  BrowserCompanion,
  COMPANION_HOST,
  COMPANION_TIMEOUT_MS,
  validCompanionProfile,
  type CompanionReply,
  type NativeSend,
} from '../../src/adapters/browser/companion';
import type { BackgroundContext, BackgroundModule, RuntimePort } from '../../src/background/context';
import { HANDLER_MODULES } from '../../src/background/handlers/index';
import {
  CompanionSync,
  COMPANION_CANCEL_GUARD_MS,
  COMPANION_WAKE_MARGIN_MS,
  COMPANION_WAKES_KEY,
  companionSyncFor,
  registerCompanionSync,
  withoutCompanionWakes,
} from '../../src/background/jobs/companion-sync';
import { JOB_MODULES } from '../../src/background/jobs/index';
import { snipeAlarmName } from '../../src/background/jobs/snipe-runner';
import { startBackground, type BackgroundBrowser } from '../../src/background/main';
import type { MessageResponse, RouterSender } from '../../src/background/router';
import type { AuditEntry } from '../../src/domain/audit/types';
import { defaultSettings } from '../../src/domain/settings/defaults';
import { SettingsSchema, type Settings } from '../../src/domain/settings/schema';
import type { Snipe } from '../../src/domain/snipe/types';
import { Repo } from '../../src/domain/storage/repo';
import { STORAGE_KEYS, STORAGE_RECORDS } from '../../src/domain/storage/schema';
import { formatPacificNaive } from '../../src/domain/time/pacific';
import type { SgwSessionRecord } from '../../src/domain/types';
import type { KeepAlive } from '../../src/ports/keep-alive';
import { loadFixture } from '../contract/sgw/fixtures';
import { FakeAlarms } from '../fakes/ports/fake-alarms';
import { FakeAuditLog } from '../fakes/ports/fake-audit-log';
import { FakeClock } from '../fakes/ports/fake-clock';
import { FakeHttp, type HttpStep } from '../fakes/ports/fake-http';
import { FakeKeepAwake } from '../fakes/ports/fake-keepawake';
import { FakeNotifier } from '../fakes/ports/fake-notifier';
import { FakePermissions } from '../fakes/ports/fake-permissions';
import { FakeStorageAreas } from '../fakes/ports/fake-storage';

// ── Constants ────────────────────────────────────────────────────────────────

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const EXT_ID = 'test-extension-id';
const EXT_ORIGIN = `chrome-extension://${EXT_ID}/`;
const UI: RouterSender = { id: EXT_ID, url: `${EXT_ORIGIN}options.html` };
const API = 'https://buyerapi.shopgoodwill.com/api/';
const DETAIL_URL = `${API}ItemDetail/GetItemDetailModelByItemId/`;

const T0 = Date.UTC(2026, 9, 10, 15, 0, 0);
/** Auction end, SGW (server) time. */
const END = T0 + 2 * HOUR;
/** SGW's clock runs this far ahead of ours. */
const SKEW = 1300;
const LATENCY = 150;
const ITEM = 702801256;
const SELLER = 955353;
const LEAD = 8000;
const MAX = 2345;
const TITLE = 'Pyrex mixing bowl, Cinderella pattern';
const PROFILE = 'Default';
const ID = 's1';
/** The runner's own wake (local time): 5 min before the planned fire. */
const RUNNER_WAKE_LOCAL = END - LEAD - SKEW - 5 * MIN;
/** The companion's wake: the runner's wake minus the margin. */
const COMPANION_WAKE = RUNNER_WAKE_LOCAL - COMPANION_WAKE_MARGIN_MS;
/** The T-15 preflight (local time). */
const PREFLIGHT_LOCAL = END - SKEW - 15 * MIN;

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
const SESSION_EXP = T0 + 30 * DAY;
const BEARER = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ BuyerId: '42', exp: Math.floor(SESSION_EXP / 1000), jti: 'token-1' })}.c2ln`;
const SESSION: SgwSessionRecord = { bearer: BEARER, capturedAt: T0 - MIN, expiresAt: SESSION_EXP, buyerId: '42', source: 'tap' };
const META = { schemaVersion: 1, installedAt: T0 - DAY, lastMigrationAt: T0 - DAY };

function settingsWith(opts: { tier?: Settings['snipe']['tier']; profile?: string | null } = {}): Settings {
  const s = defaultSettings();
  s.snipe.enabled = true;
  s.snipe.tier = opts.tier ?? 'T2';
  if (opts.profile !== null) s.companion = { profile: opts.profile ?? PROFILE };
  return s;
}

const flush = async (rounds = 3): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

// ── A fake native host that speaks PROTOCOL.md ──────────────────────────────

type HostMode =
  | 'ok'
  /** Chrome's error when the host is not registered. */
  | 'missing'
  /** The host never answers. */
  | 'hang'
  /** sendNativeMessage itself throws synchronously. */
  | 'throw'
  /** This exact reply, every time. */
  | { reply: unknown };

interface HostTask {
  snipeId: string;
  taskName: string;
  wakeAtUtc: string;
  browser: string;
  profile: string;
}

const KEYS: Record<string, string[]> = {
  schedule: ['browser', 'op', 'profile', 'snipeId', 'wakeAtUtc'],
  cancel: ['op', 'snipeId'],
  list: ['op'],
};
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]00:?00)$/;

class FakeNativeHost {
  mode: HostMode = 'ok';
  readonly hosts: string[] = [];
  readonly sent: Array<Record<string, unknown>> = [];
  readonly tasks = new Map<string, HostTask>();
  /** The profile install.ps1 configured for Chrome. */
  configuredProfile = PROFILE;
  /** While set, every answer waits for it (a slow PowerShell start). */
  gate: Promise<void> | undefined;

  constructor(private readonly clock: FakeClock) {}

  readonly send: NativeSend = (host, message) => {
    this.hosts.push(host);
    this.sent.push(structuredClone(message));
    const mode = this.mode;
    if (mode === 'throw') throw new TypeError("Cannot read properties of undefined (reading 'sendNativeMessage')");
    if (mode === 'missing') return Promise.reject(new Error('Specified native messaging host not found.'));
    if (mode === 'hang') return new Promise<unknown>(() => undefined);
    const reply = (): unknown => (typeof mode === 'object' ? structuredClone(mode.reply) : this.answer(message));
    return this.gate === undefined ? Promise.resolve(reply()) : this.gate.then(reply);
  };

  ops(): string[] {
    return this.sent.map((m) => String(m.op));
  }

  private answer(m: Record<string, unknown>): unknown {
    const op = typeof m.op === 'string' ? m.op : null;
    const fail = (error: string): unknown => ({ ok: false, op, error });
    const keys = op === null ? undefined : KEYS[op];
    if (keys === undefined || JSON.stringify(Object.keys(m).sort()) !== JSON.stringify(keys)) return fail('bad-request');
    if (op === 'list') {
      const tasks = [...this.tasks.values()].sort((a, b) => a.wakeAtUtc.localeCompare(b.wakeAtUtc));
      return { ok: true, op, tasks };
    }
    const id = m.snipeId;
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) return fail('bad-request');
    const taskName = `ShopBadwill-${id}`;
    if (op === 'cancel') {
      this.tasks.delete(id);
      return { ok: true, op, taskName };
    }
    if (typeof m.wakeAtUtc !== 'string' || !RFC3339.test(m.wakeAtUtc)) return fail('bad-request');
    const at = new Date(m.wakeAtUtc).getTime();
    if (at <= this.clock.now()) return fail('wake-in-past');
    if (at > this.clock.now() + 30 * DAY) return fail('wake-too-far-ahead');
    if (m.browser !== 'chrome' && m.browser !== 'firefox') return fail('bad-request');
    if (m.browser === 'firefox') return fail('browser-not-configured');
    if (typeof m.profile !== 'string' || m.profile.toLowerCase() !== this.configuredProfile.toLowerCase()) return fail('unknown-profile');
    const wakeAtUtc = new Date(at).toISOString();
    this.tasks.set(id, { snipeId: id, taskName, wakeAtUtc, browser: m.browser, profile: this.configuredProfile });
    return { ok: true, op, taskName, wakeAtUtc };
  }
}

// ── A tiny SGW over FakeHttp ─────────────────────────────────────────────────

class FakeSgw {
  endMs = END;
  readonly details: number[] = [];

  constructor(
    private readonly clock: FakeClock,
    http: FakeHttp,
  ) {
    http.on(
      (r) => r.url.startsWith(DETAIL_URL),
      () => this.detail(),
    );
    http.on(`${API}ItemBid/ShowBidModal`, () => this.ok({ sellerId: SELLER, minimumBid: 11 }));
    http.on(`${API}Dashboard/GetCurrentTime`, () => this.ok(this.currentTime()));
  }

  private serverNow(): number {
    return this.clock.now() + SKEW;
  }

  private ok(body: unknown): HttpStep {
    return { status: 200, bodyText: JSON.stringify(body), latencyMs: LATENCY };
  }

  private currentTime(): string {
    const p = formatPacificNaive(this.serverNow() + LATENCY / 2);
    const [date = '', time = ''] = p.split('T');
    const [y, m, d] = date.split('-');
    return `${m ?? ''}/${d ?? ''}/${y ?? ''} ${time.slice(0, 8)}`;
  }

  private detail(): HttpStep {
    this.details.push(this.clock.now());
    const raw = structuredClone(loadFixture<Record<string, unknown>>('item-detail-open'));
    const server = this.serverNow() + LATENCY / 2;
    const closed = server >= this.endMs;
    raw.itemId = ITEM;
    raw.sellerId = SELLER;
    raw.title = TITLE;
    raw.endTime = formatPacificNaive(this.endMs);
    raw.serverTime = formatPacificNaive(server);
    raw.currentPrice = 10;
    raw.minimumBid = 11;
    raw.numberOfBids = 3;
    raw.isItemEndTimeExpire = closed;
    const history = raw.bidHistory as Record<string, unknown>;
    history.auctionClosed = closed;
    history.isHighBidderLogIn = false;
    return { status: 200, bodyText: JSON.stringify(raw), latencyMs: LATENCY };
  }
}

// ── The browser world and a background worker ──────────────────────────────

interface World {
  clock: FakeClock;
  areas: FakeStorageAreas;
  alarms: FakeAlarms;
  http: FakeHttp;
  notifier: FakeNotifier;
  permissions: FakePermissions;
  host: FakeNativeHost;
  sgw: FakeSgw;
}

function makeWorld(opts: { settings?: Settings; seed?: Record<string, unknown>; granted?: boolean } = {}): World {
  const clock = new FakeClock(T0);
  const areas = new FakeStorageAreas();
  areas.local.seed({
    [STORAGE_KEYS.meta]: META,
    [STORAGE_KEYS.settings]: opts.settings ?? settingsWith(),
    [STORAGE_KEYS.sgwSession]: SESSION,
    ...opts.seed,
  });
  const http = new FakeHttp(clock);
  return {
    clock,
    areas,
    alarms: new FakeAlarms(clock),
    http,
    notifier: new FakeNotifier(),
    permissions: new FakePermissions(opts.granted === false ? {} : { permissions: ['nativeMessaging'] }),
    host: new FakeNativeHost(clock),
    sgw: new FakeSgw(clock, http),
  };
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

/** The job module map with companion-sync wired to the fake native host (the real BrowserCompanion over it). */
function companionJobs(world: World): Record<string, BackgroundModule> {
  return {
    ...JOB_MODULES,
    './companion-sync.ts': {
      register: (ctx: BackgroundContext) => {
        registerCompanionSync(ctx, { send: world.host.send, browser: 'chrome' });
      },
    },
  };
}

class Worker {
  readonly onMessage = fakeEvent<MessageListener>();
  readonly onConnect = fakeEvent<(port: RuntimePort) => void>();
  readonly logs: string[] = [];
  readonly ready: Promise<BackgroundContext>;

  constructor(
    readonly world: World,
    jobModules: Record<string, BackgroundModule> = companionJobs(world),
  ) {
    const keepAlive: KeepAlive = { start: () => undefined, stop: () => undefined };
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
        clock: world.clock,
        storage: world.areas,
        http: world.http,
        alarms: world.alarms,
        notifier: world.notifier,
        permissions: world.permissions,
        keepAwake: new FakeKeepAwake({ available: true }),
        keepAlive,
        random: () => 0,
      },
      log: (m) => {
        this.logs.push(m);
      },
      handlerModules: HANDLER_MODULES,
      jobModules,
    });
    this.ready = handle.ready;
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
    for (let i = 0; i < 400 && !done; i++) {
      done = await Promise.race([p.then(() => true), flush(1).then(() => false)]);
      if (!done) this.world.clock.advance(50);
    }
    if (!done) throw new Error(`${type}: no reply`);
    const r = await p;
    if (!r.ok) throw new Error(`${type} failed: ${r.error.code}: ${r.error.message}`);
    return r.reply as T;
  }
}

function nextDue(world: World): number | undefined {
  const timers = (world.clock as unknown as { timers: Map<number, { at: number }> }).timers;
  let min: number | undefined;
  for (const t of timers.values()) {
    const wall = world.clock.now() + (t.at - world.clock.monotonic());
    if (min === undefined || wall < min) min = wall;
  }
  const a = world.alarms.nextDue();
  if (a !== undefined && (min === undefined || a < min)) min = a;
  return min;
}

/** Runs fake time to `target`, one due event at a time, letting async work settle between events. */
async function runTo(world: World, target: number): Promise<void> {
  for (let guard = 0; guard < 200_000; guard++) {
    await flush();
    const now = world.clock.now();
    const due = nextDue(world);
    if (due === undefined || due > target) {
      if (target > now) world.clock.advance(target - now);
      await flush();
      return;
    }
    world.clock.advance(Math.max(0, due - now));
  }
  throw new Error('runTo: too many events');
}

async function boot(world: World, jobModules?: Record<string, BackgroundModule>): Promise<{ w: Worker; ctx: BackgroundContext }> {
  const w = new Worker(world, jobModules);
  const ctx = await w.ready;
  await flush();
  return { w, ctx };
}

/** Waits until companion-sync has no queued or running op (a hung host needs fake time to time out). */
async function settle(world: World, ctx: BackgroundContext): Promise<void> {
  const sync = companionSyncFor(ctx);
  if (sync === undefined) throw new Error('companion-sync did not register');
  const state = { done: false };
  const idle = sync.idle().then(() => {
    state.done = true;
  });
  for (let i = 0; i < 400 && !state.done; i++) {
    await flush(1);
    world.clock.advance(100);
  }
  await idle;
}

function armPayload(over: Partial<Snipe> = {}): Record<string, unknown> {
  return {
    id: ID,
    itemId: ITEM,
    title: TITLE,
    endTime: new Date(END).toISOString(),
    endTimeAtArm: new Date(END).toISOString(),
    maxBid: MAX,
    leadMs: LEAD,
    fallback: 'skip',
    dryRun: true,
    attempt: {},
    ...over,
  };
}

async function arm(w: Worker, over: Partial<Snipe> = {}): Promise<Snipe> {
  return w.ok<Snipe>('snipe.arm', { snipe: armPayload(over) });
}

function stored(world: World, id = ID): Snipe {
  const all = world.areas.local.dump()[STORAGE_KEYS.snipes] as Record<string, Snipe> | undefined;
  const s = all?.[id];
  if (s === undefined) throw new Error(`no stored snipe ${id}`);
  return s;
}

function audits(world: World): AuditEntry[] {
  return Object.entries(world.areas.local.dump())
    .filter(([k]) => k.startsWith('sbw:audit:'))
    .flatMap(([, v]) => v as AuditEntry[])
    .sort((a, b) => a.seq - b.seq);
}

interface WakeEntry {
  wakeAt: number;
  state: 'confirmed' | 'asked' | 'none';
  triedAt: number;
  cancelTriedAt?: number;
}

function wakeRecord(world: World): Record<string, WakeEntry> {
  const rec = world.areas.local.dump()[COMPANION_WAKES_KEY] as { wakes: Record<string, WakeEntry> } | undefined;
  return rec?.wakes ?? {};
}

/** The entries for a wake task that may exist (not `none`). */
function liveWakes(world: World): Record<string, WakeEntry> {
  return Object.fromEntries(Object.entries(wakeRecord(world)).filter(([, e]) => e.state !== 'none'));
}

function isoMs(iso: unknown): number {
  return typeof iso === 'string' ? new Date(iso).getTime() : Number.NaN;
}

/** A stored snipe (for seeding storage directly). */
function storedSnipe(over: Partial<Snipe> = {}): Snipe {
  return {
    id: ID,
    itemId: ITEM,
    title: TITLE,
    endTime: new Date(END).toISOString(),
    endTimeAtArm: new Date(END).toISOString(),
    sellerId: SELLER,
    maxBid: MAX,
    leadMs: LEAD,
    fallback: 'skip',
    dryRun: true,
    state: 'armed',
    armedAt: T0,
    attempt: {},
    history: [{ at: T0, from: 'draft', to: 'armed', why: 'armed' }],
    ...over,
  };
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
  vi.restoreAllMocks();
});

// ── Brief: tests first ───────────────────────────────────────────────────────

describe('T-111 brief', () => {
  it('arm under T2 schedules the wake: snipeId, wakeAtUtc, browser and profile only; no title, no bid', async () => {
    const world = makeWorld();
    const { w, ctx } = await boot(world);
    await arm(w);
    await settle(world, ctx);

    expect(world.host.hosts).toEqual([COMPANION_HOST]);
    expect(COMPANION_HOST).toBe('com.shopbadwill.companion');
    expect(world.host.sent).toHaveLength(1);
    const msg = world.host.sent[0] ?? {};
    // Exactly the protocol's five fields (the host refuses anything else).
    expect(Object.keys(msg).sort()).toEqual(['browser', 'op', 'profile', 'snipeId', 'wakeAtUtc']);
    expect(msg).toMatchObject({ op: 'schedule', snipeId: ID, browser: 'chrome', profile: PROFILE });
    // No item title, no max bid, no account data.
    const wire = JSON.stringify(msg);
    expect(wire).not.toContain(TITLE);
    expect(wire).not.toContain('Pyrex');
    expect(wire).not.toContain(String(MAX));
    expect(wire).not.toContain('23.45');
    expect(wire).not.toContain(BEARER);
    expect(wire).not.toContain(String(ITEM));
    expect(wire).not.toMatch(/maxBid|title|itemId|buyer|bearer|token/i);

    // The wake is the runner's T-5 min wake minus the margin, as RFC 3339 UTC.
    expect(msg.wakeAtUtc).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const wakeAt = isoMs(msg.wakeAtUtc);
    expect(COMPANION_WAKE_MARGIN_MS).toBeGreaterThanOrEqual(MIN);
    expect(Math.abs(wakeAt - COMPANION_WAKE)).toBeLessThanOrEqual(2 * SEC);
    const runnerWake = (await world.alarms.getAll()).find((a) => a.name === snipeAlarmName(ID, 'wake'));
    expect(runnerWake).toBeDefined();
    expect(wakeAt).toBeLessThanOrEqual((runnerWake?.scheduledTime ?? 0) - COMPANION_WAKE_MARGIN_MS + 2 * SEC);

    // The host made the task; the extension recorded the wake it may cause.
    expect(world.host.tasks.get(ID)?.taskName).toBe(`ShopBadwill-${ID}`);
    expect(wakeRecord(world)[ID]).toMatchObject({ wakeAt, state: 'confirmed' });
    expect(audits(world).some((a) => a.kind === 'companion.schedule' && a.ref === ID && a.details.ok === true)).toBe(true);
    expect(world.notifier.sent).toHaveLength(0);
  });

  it('disarm cancels the wake task', async () => {
    const world = makeWorld();
    const { w, ctx } = await boot(world);
    await arm(w);
    await settle(world, ctx);
    await w.ok('snipe.disarm', { id: ID });
    await settle(world, ctx);

    expect(stored(world).state).toBe('killed');
    expect(world.host.ops()).toEqual(['schedule', 'cancel']);
    expect(world.host.sent[1]).toEqual({ op: 'cancel', snipeId: ID });
    expect(world.host.tasks.size).toBe(0);
    expect(wakeRecord(world)[ID]).toBeUndefined();
  });

  it('a snipe resolved before its wake (preflight skip) cancels the wake task', async () => {
    const world = makeWorld();
    const { w, ctx } = await boot(world);
    await arm(w);
    await settle(world, ctx);
    // The auction is gone at the preflight: the snipe resolves at T-15, before the T-8 wake.
    world.sgw.endMs = T0;
    await runTo(world, PREFLIGHT_LOCAL + MIN);
    await settle(world, ctx);

    expect(stored(world).state).toBe('resolved');
    expect(world.host.ops()).toContain('cancel');
    expect(world.host.tasks.size).toBe(0);
  });

  describe('a wake that has already fired is never cancelled', () => {
    it('a disarm after the wake time sends no cancel', async () => {
      const world = makeWorld();
      const { w, ctx } = await boot(world);
      await arm(w);
      await settle(world, ctx);
      // The companion's wake has passed; the runner's own wake (T-5) has not yet.
      await runTo(world, COMPANION_WAKE + 30 * SEC);
      expect(stored(world).state).toBe('armed');
      await w.ok('snipe.disarm', { id: ID });
      await settle(world, ctx);

      expect(stored(world).state).toBe('killed');
      expect(world.host.ops()).not.toContain('cancel');
      // The record stays: the wake happened, the awake history must know.
      expect(wakeRecord(world)[ID]).toBeDefined();
    });

    it('a disarm moments before the wake (inside the guard) sends no cancel', async () => {
      const world = makeWorld();
      const { w, ctx } = await boot(world);
      await arm(w);
      await settle(world, ctx);
      await runTo(world, COMPANION_WAKE - COMPANION_CANCEL_GUARD_MS + 10 * SEC);
      await w.ok('snipe.disarm', { id: ID });
      await settle(world, ctx);

      expect(world.host.ops()).not.toContain('cancel');
    });

    it('a snipe that fires and resolves sends no cancel', async () => {
      const world = makeWorld();
      const { w, ctx } = await boot(world);
      await arm(w);
      await settle(world, ctx);
      await runTo(world, END + 3 * MIN);
      await settle(world, ctx);

      const s = stored(world);
      expect(s.state).toBe('resolved');
      expect(s.history.some((h) => h.to === 'firing')).toBe(true);
      expect(world.host.ops()).toEqual(['schedule', 'list']);
    });

    it('a restarted worker never cancels a past wake left in the record', async () => {
      const world = makeWorld({
        seed: {
          [STORAGE_KEYS.snipes]: { [ID]: storedSnipe({ state: 'killed' }) },
          [COMPANION_WAKES_KEY]: { version: 1, wakes: { [ID]: { wakeAt: T0 - MIN, state: 'confirmed', triedAt: T0 - HOUR } } },
        },
      });
      const { ctx } = await boot(world);
      await settle(world, ctx);
      expect(world.host.sent).toEqual([]);
    });
  });

  it('tiers T0 and T1 send nothing to the companion: arm, preflight, disarm', async () => {
    for (const tier of ['T0', 'T1'] as const) {
      const world = makeWorld({ settings: settingsWith({ tier }) });
      const { w, ctx } = await boot(world);
      await arm(w);
      await settle(world, ctx);
      await runTo(world, PREFLIGHT_LOCAL + MIN);
      await settle(world, ctx);
      expect(stored(world).state, tier).toBe('armed');
      await w.ok('snipe.disarm', { id: ID });
      await settle(world, ctx);

      expect(world.host.sent, tier).toEqual([]);
      expect(wakeRecord(world), tier).toEqual({});
    }
  });

  describe('an unreachable companion at preflight fails it as keep-awake', () => {
    const cases: Array<{ name: string; breakIt: (world: World) => void; why: RegExp }> = [
      {
        name: 'host not installed',
        breakIt: (world) => {
          world.host.mode = 'missing';
        },
        why: /companion.*(did not answer|not reachable)[\s\S]*native messaging host not found/i,
      },
      {
        name: 'permission revoked',
        breakIt: (world) => {
          world.permissions.revoke({ permissions: ['nativeMessaging'] });
        },
        why: /permission/i,
      },
      {
        name: 'host hangs',
        breakIt: (world) => {
          world.host.mode = 'hang';
        },
        why: /did not answer within/i,
      },
      {
        name: 'malformed reply',
        breakIt: (world) => {
          world.host.mode = { reply: { ok: true, op: 'list', tasks: 'none' } };
        },
        why: /unreadable reply/i,
      },
    ];
    for (const c of cases) {
      it(c.name, async () => {
        const world = makeWorld();
        const { w, ctx } = await boot(world);
        await arm(w);
        await settle(world, ctx);
        expect(world.host.tasks.size).toBe(1);
        c.breakIt(world);
        await runTo(world, PREFLIGHT_LOCAL + COMPANION_TIMEOUT_MS + MIN);
        await settle(world, ctx);

        const s = stored(world);
        const failed = s.history.find((h) => h.why.includes('preflight-failed'));
        expect(failed?.why, JSON.stringify(s.history)).toMatch(/keep-awake/);
        // fallback 'skip': nothing is bid, the snipe resolves.
        expect(s.state).toBe('resolved');
        const pre = audits(world).find((a) => a.kind === 'snipe.preflight' && a.details.ok === false);
        expect(pre?.details.hook).toBe('keep-awake');
        expect(String(pre?.details.why)).toMatch(c.why);
        expect(String(pre?.details.why)).toMatch(/T2/);
      });
    }
  });

  it('a reachable companion passes the preflight with one list and no extra schedule', async () => {
    const world = makeWorld();
    const { w, ctx } = await boot(world);
    await arm(w);
    await settle(world, ctx);
    await runTo(world, PREFLIGHT_LOCAL + MIN);
    await settle(world, ctx);

    expect(stored(world).state).toBe('armed');
    expect(world.host.ops()).toEqual(['schedule', 'list']);
    expect(world.host.sent[1]).toEqual({ op: 'list' });
  });

  describe('malformed replies are "unreachable"', () => {
    const wakeAt = T0 + HOUR;
    const wakeIso = new Date(wakeAt).toISOString();
    const malformed: Array<{ op: 'list' | 'schedule' | 'cancel'; reply: unknown }> = [
      { op: 'list', reply: undefined },
      { op: 'list', reply: null },
      { op: 'list', reply: 'ok' },
      { op: 'list', reply: 42 },
      { op: 'list', reply: [] },
      { op: 'list', reply: {} },
      { op: 'list', reply: { ok: true } },
      { op: 'list', reply: { ok: true, op: 'list' } },
      { op: 'list', reply: { ok: true, op: 'list', tasks: 'none' } },
      { op: 'list', reply: { ok: true, op: 'list', tasks: [{ snipeId: 1 }] } },
      { op: 'list', reply: { ok: true, op: 'list', tasks: [{ snipeId: 's1', taskName: 'ShopBadwill-s1', wakeAtUtc: 'later', browser: 'chrome', profile: 'Default' }] } },
      { op: 'list', reply: { ok: true, op: 'list', tasks: [{ snipeId: 's1', taskName: 'Evil-s1', wakeAtUtc: wakeIso, browser: 'chrome', profile: 'Default' }] } },
      { op: 'list', reply: { ok: true, op: 'schedule', tasks: [] } },
      { op: 'list', reply: { ok: 'true', op: 'list', tasks: [] } },
      { op: 'list', reply: { ok: false, op: 'list' } },
      { op: 'list', reply: { ok: false, op: 'list', error: 'teapot' } },
      { op: 'list', reply: { ok: false, op: 'schedule', error: 'internal' } },
      { op: 'schedule', reply: { ok: true, op: 'schedule', taskName: 'ShopBadwill-other', wakeAtUtc: wakeIso } },
      { op: 'schedule', reply: { ok: true, op: 'schedule', taskName: 'ShopBadwill-s1' } },
      { op: 'schedule', reply: { ok: true, op: 'schedule', taskName: 'ShopBadwill-s1', wakeAtUtc: 'soon' } },
      { op: 'schedule', reply: { ok: true, op: 'schedule', taskName: 'ShopBadwill-s1', wakeAtUtc: new Date(wakeAt + HOUR).toISOString() } },
      { op: 'schedule', reply: { ok: true, op: 'cancel', taskName: 'ShopBadwill-s1' } },
      { op: 'cancel', reply: { ok: true, op: 'cancel', taskName: 'ShopBadwill-s2' } },
      { op: 'cancel', reply: { ok: true, op: 'cancel' } },
      { op: 'cancel', reply: { ok: true } },
    ];
    for (const [i, c] of malformed.entries()) {
      it(`${c.op} #${String(i)}: ${c.reply === undefined ? 'undefined' : JSON.stringify(c.reply)}`, async () => {
        const clock = new FakeClock(T0);
        const companion = new BrowserCompanion({ clock, send: () => Promise.resolve(c.reply), granted: () => Promise.resolve(true) });
        let r: CompanionReply<unknown>;
        if (c.op === 'list') r = await companion.list();
        else if (c.op === 'cancel') r = await companion.cancel(ID);
        else r = await companion.schedule({ snipeId: ID, wakeAt, browser: 'chrome', profile: PROFILE });
        expect(r.status).toBe('unreachable');
        expect(r.status === 'unreachable' ? r.detail : '').toMatch(/unreadable reply/i);
      });
    }

    it('a well-formed refusal is "refused", not "unreachable"', async () => {
      const clock = new FakeClock(T0);
      const companion = new BrowserCompanion({
        clock,
        send: () => Promise.resolve({ ok: false, op: 'schedule', error: 'unknown-profile' }),
        granted: () => Promise.resolve(true),
      });
      const r = await companion.schedule({ snipeId: ID, wakeAt, browser: 'chrome', profile: PROFILE });
      expect(r).toMatchObject({ status: 'refused', error: 'unknown-profile' });
    });

    it('a malformed list at preflight fails it as keep-awake (end to end)', async () => {
      const world = makeWorld();
      const { w, ctx } = await boot(world);
      await arm(w);
      await settle(world, ctx);
      world.host.mode = { reply: { ok: true, op: 'list', tasks: [{ snipeId: 1 }] } };
      await runTo(world, PREFLIGHT_LOCAL + MIN);
      await settle(world, ctx);
      expect(audits(world).find((a) => a.kind === 'snipe.preflight' && a.details.ok === false)?.details.hook).toBe('keep-awake');
    });
  });
});

// ── The adapter ──────────────────────────────────────────────────────────────

describe('BrowserCompanion (the CompanionPort adapter)', () => {
  const wakeAt = T0 + HOUR;

  it('never throws: a synchronous throw, a rejection, a hang and no API all become "unreachable"', async () => {
    const clock = new FakeClock(T0);
    const host = new FakeNativeHost(clock);
    const granted = (): Promise<boolean> => Promise.resolve(true);
    for (const mode of ['throw', 'missing'] as const) {
      host.mode = mode;
      const r = await new BrowserCompanion({ clock, send: host.send, granted }).list();
      expect(r.status, mode).toBe('unreachable');
    }
    host.mode = 'hang';
    const pending = new BrowserCompanion({ clock, send: host.send, granted }).list();
    await flush();
    clock.advance(COMPANION_TIMEOUT_MS - 1);
    await flush();
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    clock.advance(1);
    const hung = await pending;
    expect(hung).toMatchObject({ status: 'unreachable' });
    expect(hung.status === 'unreachable' ? hung.detail : '').toMatch(/did not answer within 10 s/);
    // A granted() that throws, and one that says no: nothing is sent.
    const before = host.sent.length;
    const boom = await new BrowserCompanion({ clock, send: host.send, granted: () => Promise.reject(new Error('gone')) }).list();
    const denied = await new BrowserCompanion({ clock, send: host.send, granted: () => Promise.resolve(false) }).list();
    expect(boom.status).toBe('unreachable');
    expect(denied).toMatchObject({ status: 'unreachable' });
    expect(denied.status === 'unreachable' ? denied.detail : '').toMatch(/permission/i);
    expect(host.sent.length).toBe(before);
  });

  it('the default transport is runtime.sendNativeMessage to com.shopbadwill.companion', async () => {
    const clock = new FakeClock(T0);
    const spy = vi.spyOn(fakeBrowser.runtime, 'sendNativeMessage').mockImplementation((() =>
      Promise.resolve({ ok: true, op: 'list', tasks: [] })) as never);
    const r = await new BrowserCompanion({ clock, granted: () => Promise.resolve(true) }).list();
    expect(r).toEqual({ status: 'ok', value: { tasks: [] } });
    expect(spy).toHaveBeenCalledWith(COMPANION_HOST, { op: 'list' });
  });

  it('refuses to send a request the host would refuse, and sends nothing', async () => {
    const clock = new FakeClock(T0);
    const host = new FakeNativeHost(clock);
    const companion = new BrowserCompanion({ clock, send: host.send, granted: () => Promise.resolve(true) });
    const bad = [
      { snipeId: 'has space', wakeAt, browser: 'chrome' as const, profile: PROFILE },
      { snipeId: 'x'.repeat(65), wakeAt, browser: 'chrome' as const, profile: PROFILE },
      { snipeId: ID, wakeAt: Number.NaN, browser: 'chrome' as const, profile: PROFILE },
      { snipeId: ID, wakeAt, browser: 'chrome' as const, profile: '-headless' },
      { snipeId: ID, wakeAt, browser: 'chrome' as const, profile: 'Default & calc' },
      { snipeId: ID, wakeAt, browser: 'chrome' as const, profile: '..\\..\\Windows' },
      { snipeId: ID, wakeAt, browser: 'chrome' as const, profile: '$(calc)' },
      { snipeId: ID, wakeAt, browser: 'chrome' as const, profile: '' },
    ];
    for (const req of bad) {
      const r = await companion.schedule(req);
      expect(r.status, JSON.stringify(req)).toBe('refused');
    }
    expect(await companion.cancel('bad id')).toMatchObject({ status: 'refused', error: 'bad-request' });
    expect(host.sent).toEqual([]);
  });

  it('validCompanionProfile follows ruling R2 (names and paths, no shell metacharacters)', () => {
    for (const ok of ['Default', 'Profile 1', 'default-release', 'C:\\Users\\me\\ChromeProfile', 'D:/profiles/x']) {
      expect(validCompanionProfile(ok), ok).toBe(true);
    }
    for (const bad of ['', '-P', 'a"b', 'a&b', 'a|b', 'a<b', 'a>b', 'a^b', 'a%b', 'a!b', 'a`b', 'a$(b)', 'a${b}', 'a\nb', '..', 'C:\\x\\..\\y', 'x'.repeat(261)]) {
      expect(validCompanionProfile(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

// ── companion-sync beyond the brief ──────────────────────────────────────────

describe('companion-sync', () => {
  it('the real register() goes through runtime.sendNativeMessage and the nativeMessaging permission', async () => {
    const world = makeWorld();
    const spy = vi.spyOn(fakeBrowser.runtime, 'sendNativeMessage').mockImplementation(world.host.send as never);
    const { w, ctx } = await boot(world, JOB_MODULES);
    await arm(w);
    await settle(world, ctx);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe(COMPANION_HOST);
    expect(world.host.ops()).toEqual(['schedule']);
  });

  it('without the permission nothing is sent, and the user hears at arm time that no wake was scheduled', async () => {
    const world = makeWorld({ granted: false });
    const { w, ctx } = await boot(world);
    const s = await arm(w);
    await settle(world, ctx);
    expect(s.state).toBe('armed');
    expect(world.host.sent).toEqual([]);
    const n = world.notifier.sent.find((x) => x.id.startsWith('sbw:companion:'));
    expect(n?.notification.message).toMatch(/will not be woken/i);
    expect(n?.notification.message).toMatch(/permission/i);
  });

  it('a host refusal at arm notifies with the reason and records no wake', async () => {
    const world = makeWorld();
    world.host.configuredProfile = 'Profile 2';
    const { w, ctx } = await boot(world);
    await arm(w);
    await settle(world, ctx);
    expect(world.host.ops()).toEqual(['schedule']);
    expect(liveWakes(world)).toEqual({});
    const n = world.notifier.sent.find((x) => x.id.startsWith('sbw:companion:'));
    expect(n?.notification.message).toMatch(/profile/i);
    expect(audits(world).find((a) => a.kind === 'companion.schedule')?.details).toMatchObject({ ok: false, error: 'unknown-profile' });
  });

  it('T2 without a profile in the settings sends nothing and fails the preflight with a fix', async () => {
    const world = makeWorld({ settings: settingsWith({ profile: null }) });
    const { w, ctx } = await boot(world);
    await arm(w);
    await settle(world, ctx);
    expect(world.host.sent).toEqual([]);
    await runTo(world, PREFLIGHT_LOCAL + MIN);
    await settle(world, ctx);
    const pre = audits(world).find((a) => a.kind === 'snipe.preflight' && a.details.ok === false);
    expect(pre?.details.hook).toBe('keep-awake');
    expect(String(pre?.details.why)).toMatch(/profile/i);
    expect(world.host.sent).toEqual([]);
  });

  it('the preflight re-schedules a task the host lost, then passes', async () => {
    const world = makeWorld();
    const { w, ctx } = await boot(world);
    await arm(w);
    await settle(world, ctx);
    world.host.tasks.clear();
    await runTo(world, PREFLIGHT_LOCAL + MIN);
    await settle(world, ctx);
    expect(world.host.ops()).toEqual(['schedule', 'list', 'schedule']);
    expect(world.host.tasks.has(ID)).toBe(true);
    expect(stored(world).state).toBe('armed');
  });

  it('a slow schedule and a quick disarm keep their order: schedule, then cancel', async () => {
    const world = makeWorld();
    const { w, ctx } = await boot(world);
    let release: () => void = () => undefined;
    world.host.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await arm(w);
    await w.ok('snipe.disarm', { id: ID });
    release();
    await settle(world, ctx);
    expect(world.host.ops()).toEqual(['schedule', 'cancel']);
    expect(world.host.tasks.size).toBe(0);
  });

  it('a schedule queued for a snipe that was disarmed before it ran sends nothing', async () => {
    const clock = new FakeClock(T0);
    const areas = new FakeStorageAreas();
    const repo = new Repo(areas, clock);
    await repo.set(STORAGE_KEYS.snipes, { [ID]: storedSnipe({ state: 'killed' }) });
    const host = new FakeNativeHost(clock);
    const sync = new CompanionSync({
      companion: new BrowserCompanion({ clock, send: host.send, granted: () => Promise.resolve(true) }),
      browser: 'chrome',
      clock,
      repo,
      settings: () => Promise.resolve(settingsWith()),
      offsetMs: () => 0,
      audit: new FakeAuditLog(clock),
      notifier: new FakeNotifier(),
      log: () => undefined,
    });
    // The hook saw the armed snipe; by the time its op runs, storage says killed.
    await sync.hooks.afterArm?.(storedSnipe());
    await sync.idle();
    expect(host.sent).toEqual([]);
  });

  it('the hooks never hold the runner: a hung host does not delay the arm reply', async () => {
    const world = makeWorld();
    world.host.mode = 'hang';
    const { w, ctx } = await boot(world);
    const t = world.clock.now();
    await arm(w);
    expect(world.clock.now() - t).toBeLessThan(COMPANION_TIMEOUT_MS);
    await settle(world, ctx);
  });

  it('a restarted worker cancels a future wake whose snipe ended while the cancel could not run', async () => {
    const world = makeWorld({
      seed: {
        [STORAGE_KEYS.snipes]: { [ID]: storedSnipe({ state: 'killed' }), s2: storedSnipe({ id: 's2', itemId: 702801257 }) },
        [COMPANION_WAKES_KEY]: {
          version: 1,
          wakes: {
            [ID]: { wakeAt: COMPANION_WAKE, state: 'confirmed', triedAt: T0 - HOUR },
            s2: { wakeAt: COMPANION_WAKE, state: 'confirmed', triedAt: T0 - HOUR },
          },
        },
      },
    });
    world.host.tasks.set(ID, { snipeId: ID, taskName: `ShopBadwill-${ID}`, wakeAtUtc: new Date(COMPANION_WAKE).toISOString(), browser: 'chrome', profile: PROFILE });
    const { ctx } = await boot(world);
    await settle(world, ctx);
    // s1 ended: cancelled. s2 is still armed and already recorded: left alone.
    expect(world.host.sent).toEqual([{ op: 'cancel', snipeId: ID }]);
    expect(wakeRecord(world)[ID]).toBeUndefined();
    expect(wakeRecord(world).s2).toBeDefined();
  });

  it('a restarted worker under T2 schedules an armed snipe that has no wake yet', async () => {
    const world = makeWorld({ seed: { [STORAGE_KEYS.snipes]: { [ID]: storedSnipe() } } });
    const { ctx } = await boot(world);
    await settle(world, ctx);
    expect(world.host.ops()).toEqual(['schedule']);
    expect(Math.abs(isoMs(world.host.sent[0]?.wakeAtUtc) - (END - LEAD - 5 * MIN - COMPANION_WAKE_MARGIN_MS))).toBeLessThanOrEqual(2 * SEC);
  });

  it('a failed cancel is retried by a later worker, at most every few minutes', async () => {
    const world = makeWorld();
    const { w, ctx } = await boot(world);
    await arm(w);
    await settle(world, ctx);
    world.host.mode = 'missing';
    await w.ok('snipe.disarm', { id: ID });
    await settle(world, ctx);
    expect(world.host.ops()).toEqual(['schedule', 'cancel']);
    expect(wakeRecord(world)[ID]).toBeDefined();

    world.host.mode = 'ok';
    // A worker that starts at once does not hammer the host...
    const second = await boot(world);
    await settle(world, second.ctx);
    expect(world.host.ops()).toEqual(['schedule', 'cancel']);
    // ...one that starts later retries, and the wake is gone.
    world.clock.advance(15 * MIN);
    const third = await boot(world);
    await settle(world, third.ctx);
    expect(world.host.ops()).toEqual(['schedule', 'cancel', 'cancel']);
    expect(wakeRecord(world)[ID]).toBeUndefined();
  });
});

// ── Awake history ────────────────────────────────────────────────────────────

describe('awake history ignores companion-caused wakes', () => {
  // Heartbeats as the ring stores them: one per 15-minute slot while the browser runs.
  const beats = (from: number, to: number): number[] => {
    const out: number[] = [];
    for (let t = from; t <= to; t += 15 * MIN) out.push(t);
    return out;
  };
  const NIGHT = Date.UTC(2026, 9, 8, 9, 0, 0); // 02:00 in Los Angeles
  const WAKE = NIGHT + HOUR; // the companion woke the PC at 03:00 local

  it('drops the run a companion wake started when the browser was not running before it', () => {
    const evening = beats(NIGHT - 6 * HOUR, NIGHT - 4 * HOUR);
    const woken = beats(WAKE + 2 * MIN, WAKE + 2 * HOUR);
    const morning = beats(WAKE + 6 * HOUR, WAKE + 8 * HOUR);
    const kept = withoutCompanionWakes([...evening, ...woken, ...morning], [WAKE], WAKE + DAY);
    expect(kept).toEqual([...evening, ...morning]);
  });

  it('keeps everything when the browser was already running at the wake', () => {
    const running = beats(WAKE - 2 * HOUR, WAKE + 2 * HOUR);
    expect(withoutCompanionWakes(running, [WAKE], WAKE + DAY)).toEqual(running);
  });

  it('ignores wakes that have not happened yet, and history without wakes', () => {
    const woken = beats(WAKE + 2 * MIN, WAKE + HOUR);
    expect(withoutCompanionWakes(woken, [WAKE], WAKE - MIN)).toEqual(woken);
    expect(withoutCompanionWakes(woken, [], WAKE + DAY)).toEqual(woken);
  });

  it('the run ends when the computer sleeps again, and never runs on for more than 8 h', () => {
    const woken = beats(WAKE + 2 * MIN, WAKE + HOUR);
    const later = beats(WAKE + 3 * HOUR, WAKE + 4 * HOUR);
    expect(withoutCompanionWakes([...woken, ...later], [WAKE], WAKE + DAY)).toEqual(later);
    const allDay = beats(WAKE + 2 * MIN, WAKE + 12 * HOUR);
    const kept = withoutCompanionWakes(allDay, [WAKE], WAKE + DAY);
    expect(kept.length).toBeGreaterThan(0);
    expect(Math.min(...kept)).toBeGreaterThan(WAKE + 8 * HOUR);
  });

  it('timing.awake (the advice chart) answers the history without the companion-caused run', async () => {
    const evening = beats(NIGHT - 6 * HOUR, NIGHT - 4 * HOUR);
    const woken = beats(WAKE + 2 * MIN, WAKE + HOUR);
    const world = makeWorld({
      seed: {
        [STORAGE_KEYS.awake]: [...evening, ...woken],
        [COMPANION_WAKES_KEY]: { version: 1, wakes: { old: { wakeAt: WAKE, state: 'asked', triedAt: WAKE - DAY } } },
      },
    });
    world.clock.set(WAKE + DAY);
    const { w } = await boot(world);
    expect(await w.ok<number[]>('timing.awake')).toEqual(evening);
    // The stored history itself is untouched.
    expect(world.areas.local.dump()[STORAGE_KEYS.awake]).toEqual([...evening, ...woken]);
  });

  it('a corrupt wake record is ignored, never an error', async () => {
    const evening = beats(NIGHT - 6 * HOUR, NIGHT - 4 * HOUR);
    const world = makeWorld({ seed: { [STORAGE_KEYS.awake]: evening, [COMPANION_WAKES_KEY]: { version: 9, wakes: 'x' } } });
    const { w } = await boot(world);
    expect(await w.ok<number[]>('timing.awake')).toEqual(evening);
  });
});

// ── Contract additions ───────────────────────────────────────────────────────

describe('contract additions (additive, optional)', () => {
  it('settings.companion is optional and its profile is a bounded string', () => {
    expect(SettingsSchema.safeParse(defaultSettings()).success).toBe(true);
    expect(defaultSettings().companion).toBeUndefined();
    expect(SettingsSchema.safeParse({ ...defaultSettings(), companion: { profile: 'Default' } }).success).toBe(true);
    expect(SettingsSchema.safeParse({ ...defaultSettings(), companion: { profile: '' } }).success).toBe(false);
    expect(SettingsSchema.safeParse({ ...defaultSettings(), companion: { profile: 'x'.repeat(261) } }).success).toBe(false);
  });

  it('sbw:companionWakes is a local record of snipe id to wake time', () => {
    const spec = STORAGE_RECORDS[COMPANION_WAKES_KEY];
    expect(spec.area).toBe('local');
    expect(spec.schema.safeParse({ version: 1, wakes: {} }).success).toBe(true);
    expect(spec.schema.safeParse({ version: 1, wakes: { s1: { wakeAt: T0, state: 'confirmed', triedAt: T0 } } }).success).toBe(true);
    expect(spec.schema.safeParse({ version: 1, wakes: { s1: { wakeAt: T0, state: 'asked', triedAt: T0, cancelTriedAt: T0 } } }).success).toBe(true);
    expect(spec.schema.safeParse({ version: 1, wakes: { s1: { wakeAt: 'soon', state: 'asked', triedAt: T0 } } }).success).toBe(false);
    expect(spec.schema.safeParse({ version: 1, wakes: { s1: { wakeAt: T0, state: 'maybe', triedAt: T0 } } }).success).toBe(false);
    expect(spec.schema.safeParse({ version: 2, wakes: {} }).success).toBe(false);
  });
});
