// T-86: the kill switch's disarm-all (src/background/jobs/kill-disarm.ts) and
// the action badge (src/background/badge.ts), run inside the real background
// composition root (main.ts) over fakes. The popup kill section's component is
// tested in kill-popup.test.ts (its DOM tests need the happy-dom environment,
// which breaks `node:util` imports on this machine — see T-57's report); its
// pure reason formatting is tested here.
//
// No network: FakeHttp has no scripted routes, so any request fails loudly.
// Snipe records are seeded directly into `sbw:snipes` (valid per SnipeSchema);
// arming through `snipe.arm` is T-84's tested path and is not re-tested here.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import type { AuditEntry } from '../../src/domain/audit/types';
import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import type { Snipe } from '../../src/domain/snipe/types';
import { STORAGE_KEYS } from '../../src/domain/storage/schema';
import type { BackgroundContext, BackgroundModule, RuntimePort } from '../../src/background/context';
import { HANDLER_MODULES } from '../../src/background/handlers/index';
import { JOB_MODULES } from '../../src/background/jobs/index';
import { DEFAULT_SEND_STRATEGY, getSnipeRunner, RUNNER_KEY, snipeSeams } from '../../src/background/jobs/snipe-runner';
import { BADGE_DEFAULT_COLOR, KILL_BADGE_COLOR, registerBadge } from '../../src/background/badge';
import {
  KILL_DISARM_FAILED_KIND,
  KILL_DISARM_WHY,
  KILL_SNIPE_SENT_KIND,
} from '../../src/background/jobs/kill-disarm';
import { KILL_COMMAND, startBackground, type BackgroundBrowser, type BackgroundHandle } from '../../src/background/main';
import type { MessageResponse, RouterSender } from '../../src/background/router';
import { section as killSection } from '../../src/entrypoints/popup/sections/kill/index';
import { killReasons } from '../../src/entrypoints/popup/sections/kill/reasons';
import type { KeepAlive } from '../../src/ports/keep-alive';
import { FakeAlarms } from '../fakes/ports/fake-alarms';
import { FakeClock } from '../fakes/ports/fake-clock';
import { FakeHttp } from '../fakes/ports/fake-http';
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
const UI: RouterSender = { id: EXT_ID, url: `${EXT_ORIGIN}popup.html` };
const CONTENT: RouterSender = { id: EXT_ID, tab: { id: 3 }, url: 'https://shopgoodwill.com/item/1' };

const T0 = Date.UTC(2026, 9, 10, 15, 0, 0);
/** Auction end, far enough in the future that nothing wakes or reads. */
const END = T0 + 2 * HOUR;
const META = { schemaVersion: 1, installedAt: T0 - DAY, lastMigrationAt: T0 - DAY };

function settingsWith(killSwitch: boolean): Settings {
  return { ...defaultSettings(), killSwitch };
}

/** Live bidding: no dry run anywhere (the send-gate tests need a bid that WOULD go out). */
function liveSettings(): Settings {
  const s = defaultSettings();
  s.snipe.enabled = true;
  s.dryRun = { favorites: false, calendar: false, bidding: false };
  return s;
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
const SESSION_EXP = T0 + 30 * DAY;
const BEARER = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ BuyerId: '42', exp: Math.floor(SESSION_EXP / 1000), jti: 'token-1' })}.c2ln`;
const SESSION = { bearer: BEARER, capturedAt: T0 - MIN, expiresAt: SESSION_EXP, buyerId: '42', source: 'tap' };
const SGW_API = 'https://buyerapi.shopgoodwill.com/api/';

const flush = async (rounds = 3): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

/** Waits until `cond` holds, draining the microtask/macrotask queues (fake time never advances). */
async function waitUntil(cond: () => boolean | Promise<boolean>, rounds = 400): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (await cond()) return;
    await flush(1);
  }
  throw new Error('waitUntil: the condition was not reached');
}

// ── Snipe records, seeded into storage ───────────────────────────────────────

function snipe(over: Partial<Snipe> & { id: string }): Snipe {
  const { id, ...rest } = over;
  return {
    id,
    itemId: 710000000 + id.length,
    title: `Snipe ${id}`,
    endTime: new Date(END).toISOString(),
    endTimeAtArm: new Date(END).toISOString(),
    maxBid: 2000,
    leadMs: 8000,
    fallback: 'skip',
    dryRun: false,
    state: 'armed',
    armedAt: T0 - MIN,
    attempt: {},
    history: [{ at: T0 - MIN, from: 'draft', to: 'armed', why: 'arm' }],
    ...rest,
  };
}

function armedSnipe(id: string): Snipe {
  return snipe({ id });
}

/** A snipe whose bid may already be out (R2): a disarm is refused by the reducer. */
function sentSnipe(id: string): Snipe {
  return snipe({
    id,
    state: 'sent',
    attempt: { idempotencyKey: `${id}:key`, sentAt: T0 - 2 * MIN, ambiguous: true },
    history: [
      { at: T0 - 3 * MIN, from: 'draft', to: 'armed', why: 'arm' },
      { at: T0 - 2 * MIN, from: 'firing', to: 'sent', why: 'sent' },
    ],
  });
}

function resolvedSnipe(id: string): Snipe {
  return snipe({
    id,
    state: 'resolved',
    outcome: 'won',
    attempt: {
      idempotencyKey: `${id}:key`,
      sentAt: T0 - 3 * MIN,
      reply: { kind: 'accepted', rawStatus: 200, rawResult: 0, messageText: 'Bid placed', isHighBidder: true, observedAt: T0 - 2 * MIN },
    },
    history: [
      { at: T0 - 4 * MIN, from: 'draft', to: 'armed', why: 'arm' },
      { at: T0 - 3 * MIN, from: 'firing', to: 'sent', why: 'sent' },
      { at: T0 - 2 * MIN, from: 'sent', to: 'resolved', why: 'post-read' },
    ],
  });
}

function draftSnipe(id: string): Snipe {
  return snipe({ id, state: 'draft', history: [] });
}

/** A snipe further along than `armed` but not yet `sent`: every one of these can still be stopped. */
function laterSnipe(id: string, state: 'fallback-applied' | 'waking' | 'verified' | 'firing'): Snipe {
  const path: Array<[Snipe['state'], Snipe['state']]> = {
    'fallback-applied': [['draft', 'armed'], ['armed', 'fallback-applied']] as Array<[Snipe['state'], Snipe['state']]>,
    waking: [['draft', 'armed'], ['armed', 'waking']] as Array<[Snipe['state'], Snipe['state']]>,
    verified: [['draft', 'armed'], ['armed', 'waking'], ['waking', 'verified']] as Array<[Snipe['state'], Snipe['state']]>,
    firing: [['draft', 'armed'], ['armed', 'waking'], ['waking', 'verified'], ['verified', 'firing']] as Array<[Snipe['state'], Snipe['state']]>,
  }[state];
  return snipe({
    id,
    state,
    sellerId: 955353,
    ...(state === 'verified' || state === 'firing' ? { fireAt: END - 8000, measured: { offsetMs: 0, rttMs: 150 } } : {}),
    history: path.map(([from, to], i) => ({ at: T0 - (path.length - i) * SEC, from, to, why: to })),
  });
}

// ── The background over fakes ────────────────────────────────────────────────

interface Shared {
  clock: FakeClock;
  areas: FakeStorageAreas;
  alarms: FakeAlarms;
  http: FakeHttp;
  notifier: FakeNotifier;
  keepAwake: FakeKeepAwake;
  permissions: FakePermissions;
}

function makeShared(opts: { killSwitch?: boolean; snipes?: Record<string, Snipe>; live?: boolean } = {}): Shared {
  const clock = new FakeClock(T0);
  const areas = new FakeStorageAreas();
  areas.local.seed({
    [STORAGE_KEYS.meta]: META,
    [STORAGE_KEYS.settings]: opts.live === true ? { ...liveSettings(), killSwitch: opts.killSwitch ?? false } : settingsWith(opts.killSwitch ?? false),
    ...(opts.live === true ? { [STORAGE_KEYS.sgwSession]: SESSION } : {}),
    ...(opts.snipes === undefined ? {} : { [STORAGE_KEYS.snipes]: opts.snipes }),
  });
  return {
    clock,
    areas,
    alarms: new FakeAlarms(clock),
    http: new FakeHttp(clock),
    notifier: new FakeNotifier(),
    keepAwake: new FakeKeepAwake({ available: true }),
    permissions: new FakePermissions(),
  };
}

function stored(shared: Shared, id: string): Snipe {
  const all = shared.areas.local.dump()[STORAGE_KEYS.snipes] as Record<string, Snipe> | undefined;
  const s = all?.[id];
  if (s === undefined) throw new Error(`no stored snipe ${id}`);
  return s;
}

function storedStates(shared: Shared): Record<string, Snipe['state']> {
  const all = (shared.areas.local.dump()[STORAGE_KEYS.snipes] ?? {}) as Record<string, Snipe>;
  return Object.fromEntries(Object.entries(all).map(([id, s]) => [id, s.state]));
}

function audits(shared: Shared): AuditEntry[] {
  return Object.entries(shared.areas.local.dump())
    .filter(([k]) => k.startsWith('sbw:audit:'))
    .flatMap(([, v]) => v as AuditEntry[])
    .sort((a, b) => a.seq - b.seq);
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

class LightWorker {
  readonly onMessage = fakeEvent<MessageListener>();
  readonly onConnect = fakeEvent<(port: RuntimePort) => void>();
  readonly onCommand = fakeEvent<(command: string) => void>();
  readonly handle: BackgroundHandle;
  readonly ready: Promise<BackgroundContext>;

  constructor(shared: Shared, jobModules?: Record<string, BackgroundModule>) {
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
      commands: { onCommand: this.onCommand },
      tabs: { query: () => Promise.resolve([]), sendMessage: () => Promise.resolve(undefined) },
      storage: fakeBrowser.storage,
      alarms: fakeBrowser.alarms,
    } satisfies BackgroundBrowser;
    this.handle = startBackground({
      browser,
      ports: {
        clock: shared.clock,
        storage: shared.areas,
        http: shared.http,
        alarms: shared.alarms,
        notifier: shared.notifier,
        permissions: shared.permissions,
        keepAwake: shared.keepAwake,
        keepAlive,
        random: () => 0,
      },
      log: () => undefined,
      handlerModules: HANDLER_MODULES,
      jobModules: jobModules ?? JOB_MODULES,
    });
    this.ready = this.handle.ready;
  }

  send(type: string, payload?: unknown): Promise<MessageResponse> {
    return this.sendAs(UI, type, payload);
  }

  /** `sender` is the browser sender the router classifies (popup page = ui). */
  sendAs(sender: RouterSender, type: string, payload?: unknown): Promise<MessageResponse> {
    const listener = this.onMessage.listeners[0];
    if (listener === undefined) throw new Error('no onMessage listener');
    return new Promise<MessageResponse>((resolve) => {
      listener({ v: 1, type, reqId: `req-${type}`, ...(payload === undefined ? {} : { payload }) }, sender, (r) => {
        resolve(r as MessageResponse);
      });
    });
  }

  async ok<T = unknown>(type: string, payload?: unknown): Promise<T> {
    const r = await this.send(type, payload);
    if (!r.ok) throw new Error(`${type} failed: ${r.error.code}: ${r.error.message}`);
    return r.reply as T;
  }
}

async function boot(shared: Shared): Promise<{ w: LightWorker; ctx: BackgroundContext }> {
  const w = new LightWorker(shared);
  const ctx = await w.ready;
  await flush();
  return { w, ctx };
}

// ── Badge helpers ────────────────────────────────────────────────────────────

async function badgeText(): Promise<string> {
  return fakeBrowser.action.getBadgeText({});
}
async function badgeBackground(): Promise<number[]> {
  return fakeBrowser.action.getBadgeBackgroundColor({});
}
const RED_RGBA = [0xa1, 0x18, 0x1f, 255];
const DEFAULT_RGBA = [0x5f, 0x5d, 0x5b, 255];

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ── T-86 brief: tests first ──────────────────────────────────────────────────

describe('kill switch: disarm-all (R1, R2, R6)', () => {
  it('kill.set disarms every armed snipe within one tick, audits each, and never stops a sent snipe', async () => {
    const shared = makeShared({
      snipes: {
        a1: armedSnipe('a1'),
        a2: armedSnipe('a2'),
        s1: sentSnipe('s1'),
        r1: resolvedSnipe('r1'),
        d1: draftSnipe('d1'),
      },
    });
    const { w } = await boot(shared);
    expect(await badgeText()).toBe('3'); // armed count: a1, a2 and the sent s1

    await w.ok('kill.set', { on: true });
    // R6: everything lands within one tick — states, the reducer's audits and the sent refusal.
    await waitUntil(
      () =>
        stored(shared, 'a1').state === 'killed' &&
        stored(shared, 'a2').state === 'killed' &&
        audits(shared).filter((e) => e.kind === 'snipe.disarm').length === 2 &&
        audits(shared).some((e) => e.kind === KILL_SNIPE_SENT_KIND),
    );

    // R6: one tick — no fake time (or alarm) was needed.
    expect(shared.clock.now()).toBe(T0);
    // Every armed snipe is killed; the sent one is NOT stopped; finished ones are untouched.
    expect(storedStates(shared)).toEqual({ a1: 'killed', a2: 'killed', s1: 'sent', r1: 'resolved', d1: 'draft' });
    const a1 = stored(shared, 'a1');
    expect(a1.outcome).toBe('killed');
    expect(a1.outcomeDetail).toBe('Kill switch or disarm before firing; no bid sent.');
    expect(a1.history.at(-1)).toMatchObject({ from: 'armed', to: 'killed' });
    const s1 = stored(shared, 's1');
    expect(s1.history).toHaveLength(2); // the disarm was refused: nothing more happened
    expect(s1.outcome).toBeUndefined(); // never claims the snipe was stopped

    // Each snipe is audited: two accepted disarms and the expected sent refusal (R2).
    const all = audits(shared);
    expect(all.map((e) => e.kind)).toContain('kill.on');
    const disarms = all.filter((e) => e.kind === 'snipe.disarm');
    expect(disarms).toHaveLength(2);
    for (const d of disarms) {
      expect(d.actor).toBe('snipe');
      expect(d.details.by).toBe('kill');
      expect(d.details.why).toBe(KILL_DISARM_WHY);
      expect(d.ref === 'a1' || d.ref === 'a2').toBe(true);
    }
    const sentAudits = all.filter((e) => e.kind === KILL_SNIPE_SENT_KIND);
    expect(sentAudits).toHaveLength(1);
    expect(sentAudits[0]?.ref).toBe('s1');
    expect(sentAudits[0]?.details.note).toBe('kill: snipe s1 already sent; outcome pending');
    expect(all.filter((e) => e.kind === KILL_DISARM_FAILED_KIND)).toHaveLength(0);

    // R3: the badge shows KILL in red while the kill switch is on.
    expect(await badgeText()).toBe('KILL');
    expect(await badgeBackground()).toEqual(RED_RGBA);
  });

  it('the Alt+Shift+K shortcut path (setKill with source shortcut) disarms the same way', async () => {
    const shared = makeShared({ snipes: { a1: armedSnipe('a1') } });
    const { ctx } = await boot(shared);
    // main.ts's command listener calls switches.setKill(true, 'shortcut'); disarm-all
    // subscribes to the switch change, so the source must not matter.
    await ctx.switches.setKill(true, 'shortcut');
    await waitUntil(() => stored(shared, 'a1').state === 'killed');
    expect(shared.clock.now()).toBe(T0);
    const killOn = audits(shared).filter((e) => e.kind === 'kill.on');
    expect(killOn).toHaveLength(1);
    expect(killOn[0]?.details.source).toBe('shortcut');
    expect(stored(shared, 'a1').outcome).toBe('killed');
  });

  it('turning kill off again leaves killed snipes disarmed; re-arming needs the explicit arm path (R4)', async () => {
    const shared = makeShared({ snipes: { a1: armedSnipe('a1'), a2: armedSnipe('a2') } });
    const { w } = await boot(shared);
    await w.ok('kill.set', { on: true });
    await waitUntil(() => stored(shared, 'a1').state === 'killed' && stored(shared, 'a2').state === 'killed');
    const historyA1 = stored(shared, 'a1').history.length;

    await w.ok('kill.set', { on: false });
    await flush();
    // Kill off does NOT re-arm anything.
    expect(storedStates(shared)).toEqual({ a1: 'killed', a2: 'killed' });
    expect(stored(shared, 'a1').history).toHaveLength(historyA1);

    // A restarted worker (kill still off) does not re-arm them either.
    const second = await boot(shared);
    await flush();
    expect(storedStates(shared)).toEqual({ a1: 'killed', a2: 'killed' });

    // The reducer refuses anything further on a killed snipe: the only way back
    // is a NEW snipe through snipe.arm (T-84's tested path).
    const runner = getSnipeRunner(second.ctx);
    if (runner === undefined) throw new Error('the snipe runner did not register');
    const arm = await runner.dispatch('a1', { type: 'arm', now: shared.clock.now() });
    expect(arm.kind).toBe('rejected');
    if (arm.kind === 'rejected') expect(arm.rejection.reason).toBe('terminal');
    const disarm = await runner.dispatch('a1', { type: 'disarm', now: shared.clock.now(), by: 'user', why: 'again' });
    expect(disarm.kind).toBe('rejected');
    if (disarm.kind === 'rejected') expect(disarm.rejection.reason).toBe('terminal');

    // An explicit new arm (a new record) is left alone once kill is off.
    const kept = (shared.areas.local.dump()[STORAGE_KEYS.snipes] ?? {}) as Record<string, Snipe>;
    await shared.areas.local.set({ [STORAGE_KEYS.snipes]: { ...kept, n1: armedSnipe('n1') } });
    await flush();
    expect(stored(shared, 'n1').state).toBe('armed');
    expect(stored(shared, 'a1').state).toBe('killed');
    expect(stored(shared, 'a2').state).toBe('killed');
  });

  it('a worker that starts while the kill switch is on disarms the armed snipes at startup', async () => {
    const shared = makeShared({ killSwitch: true, snipes: { a1: armedSnipe('a1'), s1: sentSnipe('s1') } });
    const { w } = await boot(shared);
    // The switch was loaded before register(); the subscriber must catch the already-on state.
    await waitUntil(() => stored(shared, 'a1').state === 'killed');
    expect(storedStates(shared)).toEqual({ a1: 'killed', s1: 'sent' });
    expect(await badgeText()).toBe('KILL');
    expect(await badgeBackground()).toEqual(RED_RGBA);
    const all = audits(shared);
    expect(all.some((e) => e.kind === 'snipe.disarm' && e.ref === 'a1' && e.details.by === 'kill')).toBe(true);
    expect(all.some((e) => e.kind === KILL_SNIPE_SENT_KIND && e.ref === 's1')).toBe(true);
    // The startup disarm-all needed no message at all.
    expect(typeof w.send).toBe('function');
  });

  it('kill turned on while starting, before snipes are stored, disarms them once they load', async () => {
    const shared = makeShared();
    const w = new LightWorker(shared);
    // The shortcut is live before migrate finishes. Snipes are not stored yet.
    for (const l of w.onCommand.listeners) l(KILL_COMMAND);
    const ctx = await w.ready;
    expect(ctx.switches.view().killSwitch).toBe(true);
    expect(shared.areas.local.dump()[STORAGE_KEYS.snipes]).toBeUndefined();
    await flush();
    expect(audits(shared).some((e) => e.kind === 'snipe.disarm')).toBe(false);

    await shared.areas.local.set({
      [STORAGE_KEYS.snipes]: { a1: armedSnipe('a1'), a2: armedSnipe('a2'), s1: sentSnipe('s1'), d1: draftSnipe('d1') },
    });
    await waitUntil(
      () => stored(shared, 'a1').state === 'killed' && stored(shared, 'a2').state === 'killed' && audits(shared).some((e) => e.kind === KILL_SNIPE_SENT_KIND),
    );
    expect(shared.clock.now()).toBe(T0);
    expect(storedStates(shared)).toEqual({ a1: 'killed', a2: 'killed', s1: 'sent', d1: 'draft' });
    const sent = audits(shared).filter((e) => e.kind === KILL_SNIPE_SENT_KIND);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.details.note).toBe('kill: snipe s1 already sent; outcome pending');
    expect(stored(shared, 's1').history).toHaveLength(2);
    expect(stored(shared, 's1').outcome).toBeUndefined();
    expect(await badgeText()).toBe('KILL');
  });

  it('shows KILL while kill is on even when the snipe read has not returned, then disarms once it does', async () => {
    const shared = makeShared({ killSwitch: true, snipes: { a1: armedSnipe('a1'), s1: sentSnipe('s1') } });
    let resolveGate: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    let open = false;
    const realGet = shared.areas.local.get.bind(shared.areas.local);
    shared.areas.local.get = async <T>(key: string): Promise<T | undefined> => {
      if (!open && key === STORAGE_KEYS.snipes) await gate;
      return realGet<T>(key);
    };
    const release = (): void => {
      open = true;
      resolveGate();
    };
    try {
      await boot(shared);
      // Kill is already on, but the snipes have not been read yet.
      expect(await badgeText()).toBe('KILL');
      expect(await badgeBackground()).toEqual(RED_RGBA);
      expect(stored(shared, 'a1').state).toBe('armed');
      expect(stored(shared, 's1').state).toBe('sent');
      release();
      await waitUntil(
        () => stored(shared, 'a1').state === 'killed' && audits(shared).some((e) => e.kind === KILL_SNIPE_SENT_KIND && e.ref === 's1'),
      );
      expect(stored(shared, 's1').state).toBe('sent');
      expect(stored(shared, 's1').outcome).toBeUndefined();
      expect(audits(shared).find((e) => e.kind === KILL_SNIPE_SENT_KIND)?.details.note).toBe('kill: snipe s1 already sent; outcome pending');
      expect(await badgeText()).toBe('KILL');
    } finally {
      release();
    }
  });

  it('a content-script kill.set is refused and disarms nothing; the popup sender disarms', async () => {
    const shared = makeShared({ snipes: { a1: armedSnipe('a1'), s1: sentSnipe('s1') } });
    const { w } = await boot(shared);
    const refused = await w.sendAs(CONTENT, 'kill.set', { on: true });
    expect(refused).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    await flush();
    expect(storedStates(shared)).toEqual({ a1: 'armed', s1: 'sent' });
    expect(audits(shared).some((e) => e.kind === 'snipe.disarm' || e.kind === KILL_SNIPE_SENT_KIND)).toBe(false);

    expect(UI.url ?? '').toMatch(/popup\.html$/);
    await w.ok('kill.set', { on: true });
    await waitUntil(() => stored(shared, 'a1').state === 'killed' && audits(shared).some((e) => e.kind === KILL_SNIPE_SENT_KIND));
    expect(stored(shared, 's1').state).toBe('sent');
    expect(stored(shared, 's1').outcome).toBeUndefined();
  });

  it('retries the sent-refusal audit when the write fails, and still records it once', async () => {
    const shared = makeShared({ snipes: { s1: sentSnipe('s1') } });
    const { w } = await boot(shared);
    const realSet = shared.areas.local.set.bind(shared.areas.local);
    let failSentWrite = true;
    shared.areas.local.set = async (entries) => {
      const refusesSent = Object.values(entries).some(
        (value) => Array.isArray(value) && value.some((e) => (e as AuditEntry).kind === KILL_SNIPE_SENT_KIND),
      );
      if (failSentWrite && refusesSent) {
        failSentWrite = false;
        throw new Error('audit write failed');
      }
      return realSet(entries);
    };
    await w.ok('kill.set', { on: true });
    await waitUntil(() => vi.mocked(console.warn).mock.calls.some((c) => String(c[0]).includes('auditing failed')));
    expect(audits(shared).filter((e) => e.kind === KILL_SNIPE_SENT_KIND)).toHaveLength(0);
    expect(stored(shared, 's1').state).toBe('sent');

    // A snipe write while kill stays on runs the pass again (a dry-run noteSettings
    // does not: with kill on, the broadcast view does not change).
    const s1 = stored(shared, 's1');
    await shared.areas.local.set({ [STORAGE_KEYS.snipes]: { s1: { ...s1, title: 'still out' } } });
    await waitUntil(() => audits(shared).some((e) => e.kind === KILL_SNIPE_SENT_KIND));
    expect(audits(shared).filter((e) => e.kind === KILL_SNIPE_SENT_KIND)).toHaveLength(1);
    expect(audits(shared).find((e) => e.kind === KILL_SNIPE_SENT_KIND)?.details.note).toBe('kill: snipe s1 already sent; outcome pending');
    expect(stored(shared, 's1').state).toBe('sent');
    expect(stored(shared, 's1').outcome).toBeUndefined();
  });

  it('kill disarms every state that can still bid: armed, fallback-applied, waking, verified and firing', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    // Stored after boot: this worker's runner never drove them (no window, no
    // reconcile), so its own in-window reaction cannot stop them. Only
    // disarm-all can, and it must not skip any pre-send state.
    const seeded = {
      a1: armedSnipe('a1'),
      f1: laterSnipe('f1', 'fallback-applied'),
      w1: laterSnipe('w1', 'waking'),
      v1: laterSnipe('v1', 'verified'),
      x1: laterSnipe('x1', 'firing'),
      s1: sentSnipe('s1'),
    };
    await shared.areas.local.set({ [STORAGE_KEYS.snipes]: seeded });
    await flush();
    // Kill is off: nothing is touched.
    expect(storedStates(shared)).toEqual({ a1: 'armed', f1: 'fallback-applied', w1: 'waking', v1: 'verified', x1: 'firing', s1: 'sent' });

    await w.ok('kill.set', { on: true });
    await waitUntil(
      () =>
        audits(shared).filter((e) => e.kind === 'snipe.disarm').length === 5 &&
        audits(shared).some((e) => e.kind === KILL_SNIPE_SENT_KIND),
    );
    expect(shared.clock.now()).toBe(T0);
    expect(storedStates(shared)).toEqual({ a1: 'killed', f1: 'killed', w1: 'killed', v1: 'killed', x1: 'killed', s1: 'sent' });
    const disarms = audits(shared).filter((e) => e.kind === 'snipe.disarm');
    expect(Object.fromEntries(disarms.map((d) => [d.ref, d.details.from]))).toEqual({
      a1: 'armed',
      f1: 'fallback-applied',
      w1: 'waking',
      v1: 'verified',
      x1: 'firing',
    });
    for (const d of disarms) expect(d.details).toMatchObject({ by: 'kill', why: KILL_DISARM_WHY, to: 'killed' });
    expect(stored(shared, 's1').history).toHaveLength(2);
    expect(stored(shared, 's1').outcome).toBeUndefined();
    expect(shared.http.requests).toHaveLength(0);
  });

  it('a new kill episode audits a still-sent snipe again (the dedupe is per episode)', async () => {
    const shared = makeShared({ snipes: { s1: sentSnipe('s1') } });
    const { w } = await boot(shared);
    await w.ok('kill.set', { on: true });
    await waitUntil(() => audits(shared).filter((e) => e.kind === KILL_SNIPE_SENT_KIND).length === 1);
    await w.ok('kill.set', { on: false });
    await flush();
    expect(audits(shared).filter((e) => e.kind === KILL_SNIPE_SENT_KIND)).toHaveLength(1);

    await w.ok('kill.set', { on: true });
    await waitUntil(() => audits(shared).filter((e) => e.kind === KILL_SNIPE_SENT_KIND).length === 2);
    expect(stored(shared, 's1').state).toBe('sent');
    expect(stored(shared, 's1').outcome).toBeUndefined();
  });

  it('a sent snipe is audited only once per kill episode, even when another pass runs', async () => {
    const shared = makeShared({ snipes: { s1: sentSnipe('s1') } });
    const { w } = await boot(shared);
    await w.ok('kill.set', { on: true });
    await waitUntil(() => audits(shared).some((e) => e.kind === KILL_SNIPE_SENT_KIND));
    // A snipe write while kill stays on re-runs the pass. The refusal is not audited again.
    const s1 = stored(shared, 's1');
    await shared.areas.local.set({ [STORAGE_KEYS.snipes]: { s1: { ...s1, title: 'still out' } } });
    await flush();
    expect(audits(shared).filter((e) => e.kind === KILL_SNIPE_SENT_KIND)).toHaveLength(1);
    expect(stored(shared, 's1').state).toBe('sent');
  });
});

// Disarm-all is defence in depth. The runner checks verdictNow('bidding')
// before it commits `sent`, and the API adapter asks writesAllowed again right
// before the request leaves. These tests keep disarm-all out of the way (stalled,
// or unable to help because `sent` is already stored) and check that no bid
// request leaves.
describe('the send gate does not depend on disarm-all', () => {
  /** A live snipe whose fire has just been committed: its PlaceBid effect waits in the outbox. */
  async function seedFiring(shared: Shared): Promise<void> {
    await shared.areas.local.set({
      [STORAGE_KEYS.snipes]: { x1: laterSnipe('x1', 'firing') },
      [RUNNER_KEY]: { version: 1, entries: { x1: { outbox: [{ kind: 'placeBid', snipeId: 'x1', amount: 2000 }] } } },
    });
  }
  const bidRequests = (shared: Shared): string[] => shared.http.requests.map((r) => r.url).filter((u) => u.startsWith(`${SGW_API}ItemBid/`));

  it('control: with kill off, the same setup does send a bid request', async () => {
    const shared = makeShared({ live: true });
    const { ctx } = await boot(shared);
    const runner = getSnipeRunner(ctx);
    if (runner === undefined) throw new Error('the snipe runner did not register');
    await seedFiring(shared);
    await runner.drive('x1');
    await waitUntil(() => bidRequests(shared).length > 0);
    expect(bidRequests(shared)[0]).toContain('ItemBid/ShowBidModal');
  });

  it('a fire due in the same tick as the kill sends nothing, even with disarm-all stalled', async () => {
    const shared = makeShared({ live: true });
    const { ctx } = await boot(shared);
    const runner = getSnipeRunner(ctx);
    if (runner === undefined) throw new Error('the snipe runner did not register');
    // Disarm-all never gets its snipe list: it is as slow as it can be.
    const list = vi.spyOn(runner, 'list').mockReturnValue(new Promise(() => undefined));
    await seedFiring(shared);

    // The fire timer and the kill in the same tick.
    const driven = runner.drive('x1');
    void ctx.switches.setKill(true, 'shortcut');
    await driven;
    await waitUntil(() => stored(shared, 'x1').state === 'killed');

    expect(list).toHaveBeenCalled(); // disarm-all did start, and is stuck
    expect(bidRequests(shared)).toEqual([]);
    expect(String(audits(shared).find((e) => e.kind === 'bid.not-sent')?.details.why)).toMatch(/kill switch/);
    // The runner closed it on its own (by kill); disarm-all's disarm never ran.
    const disarm = audits(shared).find((e) => e.kind === 'snipe.disarm');
    expect(disarm?.details).toMatchObject({ by: 'kill', from: 'firing', to: 'killed' });
    expect(disarm?.details.why).not.toBe(KILL_DISARM_WHY);
    expect(stored(shared, 'x1').attempt.idempotencyKey).toBeUndefined();
  });

  it('a kill that lands after `sent` is stored, just before the request: nothing leaves, and the snipe is never called stopped', async () => {
    const shared = makeShared({ live: true });
    let storedAtSend: Snipe['state'] | undefined;
    const probe: BackgroundModule = {
      register: (ctx) => {
        snipeSeams(ctx).setSendStrategy({
          send: (req, deps) => {
            storedAtSend = stored(shared, req.snipe.id).state;
            void ctx.switches.setKill(true, 'shortcut'); // the kill lands now
            return DEFAULT_SEND_STRATEGY.send(req, deps);
          },
        });
      },
    };
    const w = new LightWorker(shared, { ...JOB_MODULES, './zz-probe.ts': probe });
    const ctx = await w.ready;
    await flush();
    const runner = getSnipeRunner(ctx);
    if (runner === undefined) throw new Error('the snipe runner did not register');
    await seedFiring(shared);
    await runner.drive('x1');
    await waitUntil(() => audits(shared).some((e) => e.kind === KILL_SNIPE_SENT_KIND && e.ref === 'x1'));

    expect(storedAtSend).toBe('sent'); // persist before send
    expect(bidRequests(shared)).toEqual([]); // the adapter's own gate refused it
    const s = stored(shared, 'x1');
    expect(s.state).toBe('sent'); // a bid may be out as far as the reducer knows: never killed
    expect(s.history.some((h) => h.to === 'killed')).toBe(false);
    expect(audits(shared).find((e) => e.kind === KILL_SNIPE_SENT_KIND && e.ref === 'x1')?.details.note).toBe(
      'kill: snipe x1 already sent; outcome pending',
    );
    expect(audits(shared).some((e) => e.kind === 'snipe.disarm' && e.ref === 'x1')).toBe(false);
    expect(await badgeText()).toBe('KILL');
  });
});

describe('action badge (R3)', () => {
  it('shows the armed count when kill is off and clears when nothing is armed', async () => {
    const shared = makeShared({ snipes: { a1: armedSnipe('a1'), s1: sentSnipe('s1'), d1: draftSnipe('d1') } });
    await boot(shared);
    expect(await badgeText()).toBe('2');
    expect(await badgeBackground()).toEqual(DEFAULT_RGBA);

    const empty = makeShared();
    await boot(empty);
    expect(await badgeText()).toBe('');
  });

  it('switches to KILL (red) on kill on and back to the live count on kill off', async () => {
    const shared = makeShared({ snipes: { a1: armedSnipe('a1'), s1: sentSnipe('s1') } });
    const { w } = await boot(shared);
    expect(await badgeText()).toBe('2');

    await w.ok('kill.set', { on: true });
    await waitUntil(async () => (await badgeText()) === 'KILL');
    expect(await badgeBackground()).toEqual(RED_RGBA);

    await w.ok('kill.set', { on: false });
    await waitUntil(async () => (await badgeText()) === '1'); // only the sent snipe still lives
    expect(await badgeBackground()).toEqual(DEFAULT_RGBA);
  });

  it('shows ! when Google needs interaction, unless kill or the armed count take over', async () => {
    const shared = makeShared();
    const { ctx } = await boot(shared);
    expect(await badgeText()).toBe('');
    ctx.googleNeedsInteraction.set(true);
    await waitUntil(async () => (await badgeText()) === '!');
    expect(await badgeBackground()).toEqual(DEFAULT_RGBA);
    ctx.googleNeedsInteraction.set(false);
    await waitUntil(async () => (await badgeText()) === '');
  });

  it('follows snipe changes from storage and is idempotent', async () => {
    const shared = makeShared({ snipes: { a1: armedSnipe('a1'), a2: armedSnipe('a2'), s1: sentSnipe('s1') } });
    const { ctx } = await boot(shared);
    await waitUntil(async () => (await badgeText()) === '3');

    const spy = vi.spyOn(fakeBrowser.action, 'setBadgeText');
    // Another context arms a snipe: storage.onChanged must recompute the count.
    const all = (shared.areas.local.dump()[STORAGE_KEYS.snipes] ?? {}) as Record<string, Snipe>;
    await shared.areas.local.set({ [STORAGE_KEYS.snipes]: { ...all, a3: armedSnipe('a3') } });
    await waitUntil(async () => (await badgeText()) === '4');
    expect(spy).toHaveBeenCalledWith({ text: '4' });

    // A switch change that does not affect the badge (a dry-run flip) recomputes but writes nothing.
    const calls = spy.mock.calls.length;
    ctx.switches.noteSettings({ ...settingsWith(false), dryRun: { favorites: false, calendar: true, bidding: true } });
    await flush();
    expect(spy.mock.calls.length).toBe(calls);
    expect(await badgeText()).toBe('4');

    // A snipe write that does not change the armed count recomputes and writes nothing.
    const afterSwitch = spy.mock.calls.length;
    const current = (shared.areas.local.dump()[STORAGE_KEYS.snipes] ?? {}) as Record<string, Snipe>;
    await shared.areas.local.set({ [STORAGE_KEYS.snipes]: { ...current, d1: draftSnipe('d1') } });
    await flush();
    expect(await badgeText()).toBe('4');
    expect(spy.mock.calls.length).toBe(afterSwitch);
  });

  it('precedence is KILL, then the armed count, then !, then empty', async () => {
    const shared = makeShared({ snipes: { s1: sentSnipe('s1') } });
    const { ctx, w } = await boot(shared);
    expect(await badgeText()).toBe('1');
    expect(await badgeBackground()).toEqual(DEFAULT_RGBA);

    ctx.googleNeedsInteraction.set(true);
    await flush();
    // The armed count beats ! (the sent snipe still counts, and kill is off).
    expect(await badgeText()).toBe('1');
    expect(await badgeBackground()).toEqual(DEFAULT_RGBA);

    await w.ok('kill.set', { on: true });
    await waitUntil(async () => (await badgeText()) === 'KILL');
    // KILL beats both the still-live sent snipe and the reconnect flag.
    expect(stored(shared, 's1').state).toBe('sent');
    expect(await badgeText()).toBe('KILL');
    expect(await badgeBackground()).toEqual(RED_RGBA);

    await w.ok('kill.set', { on: false });
    await waitUntil(async () => (await badgeText()) === '1');
    expect(await badgeBackground()).toEqual(DEFAULT_RGBA);

    await shared.areas.local.set({ [STORAGE_KEYS.snipes]: { d1: draftSnipe('d1') } });
    await waitUntil(async () => (await badgeText()) === '!');
    expect(await badgeBackground()).toEqual(DEFAULT_RGBA);

    ctx.googleNeedsInteraction.set(false);
    await waitUntil(async () => (await badgeText()) === '');
    expect(await badgeBackground()).toEqual(DEFAULT_RGBA);
  });

  it('badge.ts is the only writer of the action badge', () => {
    const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) files.push(path);
      }
    };
    walk(join(root, 'src'));
    const writers = files
      .filter((file) => /setBadgeText|setBadgeBackgroundColor/.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file).replaceAll('\\', '/'))
      .sort();
    expect(writers).toEqual(['src/background/badge.ts']);
    expect(typeof registerBadge).toBe('function');
    expect(KILL_BADGE_COLOR).toBe('#a1181f');
    expect(BADGE_DEFAULT_COLOR).toBe('#5f5d5b');
  });
});

describe('popup kill section helpers (R5)', () => {
  const disarmKill: AuditEntry = {
    seq: 4,
    at: T0,
    actor: 'snipe',
    kind: 'snipe.disarm',
    itemId: 710000004,
    ref: 'a1',
    details: { event: 'disarm', from: 'armed', to: 'killed', outcome: 'killed', by: 'kill', why: 'stopped before it could bid' },
  };
  const disarmAnomaly: AuditEntry = {
    seq: 3,
    at: T0 - MIN,
    actor: 'snipe',
    kind: 'snipe.disarm',
    itemId: 710000003,
    ref: 'a2',
    details: { event: 'disarm', from: 'waking', to: 'killed', outcome: 'killed', by: 'anomaly', why: 'three reads in a row failed' },
  };
  const sentRefusal: AuditEntry = {
    seq: 2,
    at: T0 - 2 * MIN,
    actor: 'system',
    kind: KILL_SNIPE_SENT_KIND,
    ref: 's1',
    details: { note: 'kill: snipe s1 already sent; outcome pending' },
  };
  const unrelated: AuditEntry = { seq: 1, at: T0 - 3 * MIN, actor: 'user', kind: 'kill.on', details: { source: 'kill.set' } };

  it('is registered as the popup kill section', () => {
    expect(killSection.id).toBe('kill');
    expect(typeof killSection.Component).toBe('function');
  });

  it('killReasons filters and caps the audit entries', () => {
    expect(killReasons([disarmKill, disarmAnomaly, sentRefusal, unrelated], 3)).toEqual([
      { at: disarmKill.at, text: 'Kill switch a1: stopped before it could bid' },
      { at: disarmAnomaly.at, text: 'Auto-stopped a2: three reads in a row failed' },
      { at: sentRefusal.at, text: 'kill: snipe s1 already sent; outcome pending' },
    ]);
    expect(killReasons([disarmKill, disarmAnomaly, sentRefusal], 2).map((r) => r.text)).toEqual([
      'Kill switch a1: stopped before it could bid',
      'Auto-stopped a2: three reads in a row failed',
    ]);
    expect(killReasons([unrelated])).toEqual([]);
    const noBy: AuditEntry = { seq: 9, at: T0, actor: 'snipe', kind: 'snipe.disarm', details: {} };
    expect(killReasons([noBy])).toEqual([]);
    const userDisarm: AuditEntry = { seq: 8, at: T0, actor: 'snipe', kind: 'snipe.disarm', ref: 'a1', details: { by: 'user', why: 'I changed my mind' } };
    expect(killReasons([userDisarm])).toEqual([]); // user disarms are not auto-kills
  });
});
