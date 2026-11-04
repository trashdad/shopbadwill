// T-112: bid groups, "win at most N", inside the real background composition
// root (main.ts) with the real runner (T-84), reducer (T-80), classifier
// (T-87) and the groups job (src/background/jobs/snipe-groups.ts, registered
// by the jobs glob like any job), over fakes: FakeClock, FakeStorageAreas,
// FakeAlarms (+45 s late), a small multi-item SGW over FakeHttp (an
// unscripted request rejects, so nothing can reach a real host), FakeNotifier.
//
// The money rules proven here, on LIVE snipes (PlaceBid counted on the fake):
// - a CONFIRMED win (T-87 won + final, on the group's own read after the end)
//   disarms the rest through the runner: they never send a PlaceBid;
// - a win the group cannot confirm never cancels anything: the next member
//   still bids, and the user is told it risks winning more than N; a later
//   confirmation stops only what is still open;
// - a member whose bid is already sent cannot be stopped: the runner refuses,
//   and the group records and says so;
// - spacing, mode and the edit freeze are enforced at arm time (beforeArm),
//   and a group never raises a cap (each member counts in full);
// - a restarted worker re-applies a reached N; a dry-run group simulates it.
import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import type { BackgroundContext, RuntimePort } from '../../src/background/context';
import { HANDLER_MODULES } from '../../src/background/handlers/index';
import { JOB_MODULES } from '../../src/background/jobs/index';
import { GROUPS_KEY, snipeGroupsFor } from '../../src/background/jobs/snipe-groups';
import { startBackground, type BackgroundBrowser } from '../../src/background/main';
import type { MessageResponse, RouterSender } from '../../src/background/router';
import type { AuditEntry } from '../../src/domain/audit/types';
import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import { groupView } from '../../src/domain/snipe/groups';
import type { Snipe } from '../../src/domain/snipe/types';
import { STORAGE_KEYS, type SnipeGroupsRecord } from '../../src/domain/storage/schema';
import { formatPacificNaive } from '../../src/domain/time/pacific';
import type { SgwSessionRecord } from '../../src/domain/types';
import { HttpNetworkError } from '../../src/ports/errors';
import type { HttpRequest } from '../../src/ports/http';
import type { KeepAlive } from '../../src/ports/keep-alive';
import { loadFixture } from '../contract/sgw/fixtures';
import { FakeAlarms } from '../fakes/ports/fake-alarms';
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
const UI: RouterSender = { id: EXT_ID, url: `${EXT_ORIGIN}dashboard.html` };
const API = 'https://buyerapi.shopgoodwill.com/api/';
const DETAIL_URL = `${API}ItemDetail/GetItemDetailModelByItemId/`;
const MODAL_URL = `${API}ItemBid/ShowBidModal`;
const PLACE_URL = `${API}ItemBid/PlaceBid`;

const T0 = Date.UTC(2026, 9, 10, 15, 0, 0);
/** Item A's end (SGW time); B and C end later, at least 2 min apart. */
const END = T0 + 2 * HOUR;
const SKEW = 1300;
const LATENCY = 150;
const SELLER = 955353;
const LEAD = 8000;
const MAX = 2000;

const A = 702801001;
const B = 702801002;
const C = 702801003;
/** C is far enough that the snipe lane is free for a late check before C's window. */
const ENDS: Record<number, number> = { [A]: END, [B]: END + 3 * MIN, [C]: END + 40 * MIN };
const TITLES: Record<number, string> = { [A]: 'Lamp A', [B]: 'Lamp B', [C]: 'Lamp C' };

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
const SESSION_EXP = T0 + 30 * DAY;
const BEARER = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ BuyerId: '42', exp: Math.floor(SESSION_EXP / 1000), jti: 'token-1' })}.c2ln`;
const SESSION: SgwSessionRecord = { bearer: BEARER, capturedAt: T0 - MIN, expiresAt: SESSION_EXP, buyerId: '42', source: 'tap' };
const META = { schemaVersion: 1, installedAt: T0 - DAY, lastMigrationAt: T0 - DAY };

function settingsWith(opts: { live?: boolean; caps?: Partial<Settings['snipe']['caps']> } = {}): Settings {
  const s = defaultSettings();
  s.snipe.enabled = true;
  if (opts.live !== false) s.dryRun = { favorites: false, calendar: false, bidding: false };
  s.snipe.caps = { ...s.snipe.caps, ...opts.caps };
  return s;
}

const flush = async (rounds = 3): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

// ── A tiny multi-item SGW over FakeHttp ──────────────────────────────────────

interface SgwItem {
  endMs: number;
  price: number;
  minimumBid: number;
  numBids: number;
  closed: boolean;
  /** Whether the signed-in user (our bearer) leads. */
  high: boolean;
}

class FakeSgw {
  readonly items = new Map<number, SgwItem>();
  /** Replaces an ItemDetail reply while it returns a step. */
  detailFault: ((itemId: number, auth: boolean) => HttpStep | undefined) | undefined;
  /** PlaceBid replies by item (default: accepted and leading). */
  readonly replies = new Map<number, 'accepted' | 'outbid'>();
  readonly placeBids: Array<{ at: number; itemId: number; amount: string }> = [];
  readonly details: Array<{ at: number; itemId: number; auth: boolean }> = [];

  constructor(
    private readonly clock: FakeClock,
    http: FakeHttp,
  ) {
    for (const id of [A, B, C]) {
      this.items.set(id, { endMs: ENDS[id] ?? END, price: 1000, minimumBid: 1100, numBids: 3, closed: false, high: false });
    }
    http.on(
      (r) => r.url.startsWith(DETAIL_URL),
      (req) => this.detail(req),
    );
    http.on(
      (r) => r.url.startsWith(MODAL_URL),
      (req) => {
        const id = Number(new URL(req.url).searchParams.get('itemId'));
        return this.ok({ sellerId: SELLER, minimumBid: (this.items.get(id)?.minimumBid ?? 0) / 100 });
      },
    );
    http.on(PLACE_URL, (req) => {
      const body = JSON.parse(String(req.body)) as { itemId: number; bidAmount: string };
      this.placeBids.push({ at: this.clock.now(), itemId: body.itemId, amount: body.bidAmount });
      const item = this.items.get(body.itemId);
      if (this.replies.get(body.itemId) === 'outbid') {
        if (item) item.price = MAX + 100;
        return this.ok({ status: true, result: 1, message: 'You have been outbid', isHighBidder: false });
      }
      if (item) {
        item.high = true;
        item.numBids += 1;
      }
      return this.ok({ status: true, result: 0, message: 'Bid placed', isHighBidder: true });
    });
    http.on(`${API}Dashboard/GetCurrentTime`, () => this.ok(this.currentTime()));
  }

  bidsOn(itemId: number): number {
    return this.placeBids.filter((p) => p.itemId === itemId).length;
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

  private detail(req: HttpRequest): HttpStep {
    const id = Number(req.url.slice(DETAIL_URL.length).split(/[/?]/)[0]);
    const auth = req.headers?.Authorization !== undefined;
    this.details.push({ at: this.clock.now(), itemId: id, auth });
    const fault = this.detailFault?.(id, auth);
    if (fault) return fault;
    const i = this.items.get(id);
    if (i === undefined) return { status: 404, bodyText: '{}', latencyMs: LATENCY };
    const raw = structuredClone(loadFixture<Record<string, unknown>>('item-detail-open'));
    const server = this.serverNow() + LATENCY / 2;
    const closed = i.closed || server >= i.endMs;
    raw.itemId = id;
    raw.title = TITLES[id] ?? `Item ${String(id)}`;
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
    return { status: 200, bodyText: JSON.stringify(raw), latencyMs: LATENCY };
  }
}

// ── One background worker over shared fakes ─────────────────────────────────

interface Shared {
  clock: FakeClock;
  areas: FakeStorageAreas;
  alarms: FakeAlarms;
  http: FakeHttp;
  notifier: FakeNotifier;
  sgw: FakeSgw;
}

function makeShared(opts: { settings?: Settings; seed?: Record<string, unknown> } = {}): Shared {
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
    alarms: new FakeAlarms(clock, { extraDelayMs: 45 * SEC }),
    http,
    notifier: new FakeNotifier(),
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

const NO_KEEP_ALIVE: KeepAlive = { start: () => undefined, stop: () => undefined };

class Worker {
  readonly onMessage = fakeEvent<MessageListener>();
  readonly ready: Promise<BackgroundContext>;

  constructor(readonly shared: Shared) {
    const browser = {
      runtime: {
        id: EXT_ID,
        getURL: (p: string) => EXT_ORIGIN + p.replace(/^\//, ''),
        sendMessage: () => Promise.reject(new Error('Receiving end does not exist.')),
        onMessage: this.onMessage,
        onConnect: fakeEvent<(port: RuntimePort) => void>(),
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
        clock: shared.clock,
        storage: shared.areas,
        http: shared.http,
        alarms: shared.alarms,
        notifier: shared.notifier,
        permissions: new FakePermissions(),
        keepAwake: new FakeKeepAwake({ available: true }),
        keepAlive: NO_KEEP_ALIVE,
        random: () => 0,
      },
      log: () => undefined,
      handlerModules: HANDLER_MODULES,
      jobModules: JOB_MODULES,
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

  /** The reply, or throws the handler's error message. Lets fake time run while a handler waits on a fake reply. */
  async ok<T = unknown>(type: string, payload?: unknown): Promise<T> {
    const p = this.send(type, payload);
    let done = false;
    for (let i = 0; i < 80 && !done; i++) {
      done = await Promise.race([p.then(() => true), flush(1).then(() => false)]);
      if (!done) this.shared.clock.advance(50);
    }
    if (!done) throw new Error(`${type}: no reply`);
    const r = await p;
    if (!r.ok) throw new Error(r.error.message);
    return r.reply as T;
  }
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

async function boot(shared: Shared): Promise<{ w: Worker; ctx: BackgroundContext }> {
  const w = new Worker(shared);
  const ctx = await w.ready;
  await flush();
  return { w, ctx };
}

function armPayload(itemId: number, over: Partial<Snipe> = {}): Record<string, unknown> {
  const end = new Date(ENDS[itemId] ?? END).toISOString();
  return {
    id: `s-${String(itemId)}`,
    itemId,
    title: TITLES[itemId] ?? 'Item',
    endTime: end,
    endTimeAtArm: end,
    maxBid: MAX,
    leadMs: LEAD,
    fallback: 'skip',
    dryRun: false,
    attempt: {},
    groupId: 'g1',
    ...over,
  };
}

async function arm(w: Worker, itemId: number, over: Partial<Snipe> = {}): Promise<Snipe> {
  return w.ok<Snipe>('snipe.arm', { snipe: armPayload(itemId, over) });
}

async function makeGroup(w: Worker, maxWins = 1, id = 'g1'): Promise<void> {
  await w.ok('groups.save', { id, name: 'Lamps', maxWins });
}

function stored(shared: Shared, itemId: number): Snipe {
  const all = shared.areas.local.dump()[STORAGE_KEYS.snipes] as Record<string, Snipe> | undefined;
  const s = all?.[`s-${String(itemId)}`];
  if (s === undefined) throw new Error(`no stored snipe for ${String(itemId)}`);
  return s;
}

function groups(shared: Shared): SnipeGroupsRecord {
  return (shared.areas.local.dump()[GROUPS_KEY] as SnipeGroupsRecord | undefined) ?? { version: 1, groups: {} };
}

function audits(shared: Shared): AuditEntry[] {
  return Object.entries(shared.areas.local.dump())
    .filter(([k]) => k.startsWith('sbw:audit:'))
    .flatMap(([, v]) => v as AuditEntry[])
    .sort((a, b) => a.seq - b.seq);
}

function told(shared: Shared, title: RegExp): string[] {
  return shared.notifier.sent.filter((n) => title.test(n.notification.title)).map((n) => n.notification.message);
}

/** A read of `itemId` after its member resolved (the group's own confirming reads). */
function failAfterResolved(shared: Shared, itemId: number, until: () => boolean): void {
  shared.sgw.detailFault = (id) => {
    if (id !== itemId || until()) return undefined;
    const s = stored(shared, itemId);
    return s.state === 'resolved' ? { status: 503, bodyText: 'busy', latencyMs: LATENCY } : undefined;
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

// ── Cancel only on proof ─────────────────────────────────────────────────────

describe('T-112 bid groups (live, real runner)', () => {
  it('a CONFIRMED win disarms the rest through the runner: they never send a PlaceBid', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await makeGroup(w, 1);
    await arm(w, A);
    await arm(w, B);
    await arm(w, C);

    await runTo(shared, END + 2 * MIN);
    expect(stored(shared, A)).toMatchObject({ state: 'resolved', outcome: 'won' });
    // The group's own read after the end, on the snipe lane (authenticated: SGW says who leads).
    const resolvedAt = stored(shared, A).history.at(-1)?.at ?? 0;
    expect(shared.sgw.details.some((d) => d.itemId === A && d.auth && d.at >= resolvedAt)).toBe(true);
    const g = groups(shared).groups.g1;
    expect(g?.results[`s-${String(A)}`]).toMatchObject({ verdict: 'confirmed', dryRun: false });
    for (const id of [B, C]) {
      expect(stored(shared, id)).toMatchObject({ state: 'killed', outcome: 'killed' });
      expect(g?.cancels[`s-${String(id)}`]).toMatchObject({ ok: true });
    }
    // Through the runner's disarm: the reducer's own disarm audit, by the user, naming the group.
    const disarms = audits(shared).filter((e) => e.kind === 'snipe.disarm');
    expect(disarms.map((e) => e.ref).sort()).toEqual([`s-${String(B)}`, `s-${String(C)}`]);
    expect(disarms.every((e) => e.details.by === 'user' && String(e.details.why).includes('bid group "Lamps" already won 1 of 1'))).toBe(true);
    expect(told(shared, /^Bid group "Lamps": won 1 of 1$/)).toEqual(['Stopped "Lamp B", "Lamp C".']);

    await runTo(shared, END + 50 * MIN);
    expect(shared.sgw.placeBids.map((p) => p.itemId)).toEqual([A]);
    const view = groupView(groups(shared).groups.g1 as never, Object.values(shared.areas.local.dump()[STORAGE_KEYS.snipes] as Record<string, Snipe>), END + 20 * MIN, 'UTC');
    expect(view).toMatchObject({ wins: 1, full: true, nextEnd: null, warnings: [] });
  });

  it('a win the group cannot confirm never cancels: the next member still bids, the user is warned, a later confirmation stops only what is open', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await makeGroup(w, 1);
    await arm(w, A);
    await arm(w, B);
    await arm(w, C);
    shared.sgw.replies.set(B, 'outbid');
    // The runner's own outcome read of A works (A resolves `won`); the group's confirming reads fail.
    let lifted = false;
    failAfterResolved(shared, A, () => lifted);

    await runTo(shared, END + 4 * MIN);
    expect(stored(shared, A)).toMatchObject({ state: 'resolved', outcome: 'won' });
    const a = groups(shared).groups.g1?.results[`s-${String(A)}`];
    expect(a).toMatchObject({ verdict: 'checking', attempts: 4 });
    // Never a cancel on a guess: B fired and sent its bid.
    expect(shared.sgw.bidsOn(B)).toBe(1);
    expect(stored(shared, B)).toMatchObject({ state: 'resolved', outcome: 'outbid' });
    expect(stored(shared, C).state).toBe('armed');
    expect(groups(shared).groups.g1?.cancels).toEqual({});
    expect(audits(shared).filter((e) => e.kind === 'snipe.disarm')).toEqual([]);
    // Said plainly, once: the group keeps bidding, so more than N may be won.
    const warned = told(shared, /win not confirmed/);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/"Lamp A" may have been won, but the win is not confirmed \(the item could not be read after the end\)\. The group keeps bidding on its other items, so you could win more than 1\./);

    // SGW answers again: the 5-minute check confirms A and stops C, the only member still open.
    lifted = true;
    await runTo(shared, END + 7 * MIN);
    expect(groups(shared).groups.g1?.results[`s-${String(A)}`]).toMatchObject({ verdict: 'confirmed', attempts: 5 });
    expect(stored(shared, C)).toMatchObject({ state: 'killed', outcome: 'killed' });
    await runTo(shared, END + 50 * MIN);
    expect(shared.sgw.placeBids.map((p) => p.itemId)).toEqual([A, B]);
  });

  it('a member whose bid is already sent cannot be stopped: the runner refuses, and the group records and says so', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await makeGroup(w, 1);
    await arm(w, A);
    await arm(w, B);
    let lifted = false;
    failAfterResolved(shared, A, () => lifted);
    // B's outcome read keeps failing (no connection: no lane backs off), so B stays `sent` (its bid is out).
    const aFault = shared.sgw.detailFault;
    shared.sgw.detailFault = (id, auth) => {
      if (id === B && stored(shared, B).state === 'sent') return { error: new HttpNetworkError('connection reset'), latencyMs: LATENCY };
      return aFault?.(id, auth);
    };

    await runTo(shared, END + 4 * MIN);
    expect(stored(shared, B).state).toBe('sent');
    lifted = true;
    await runTo(shared, END + 7 * MIN);

    const g = groups(shared).groups.g1;
    expect(g?.results[`s-${String(A)}`]?.verdict).toBe('confirmed');
    expect(g?.cancels[`s-${String(B)}`]).toMatchObject({ ok: false, why: expect.stringMatching(/bid may already be out/) as unknown });
    expect(stored(shared, B).state).toBe('sent');
    expect(audits(shared).some((e) => e.kind === 'group.cancel-refused' && e.ref === `s-${String(B)}`)).toBe(true);
    expect(told(shared, /^Bid group "Lamps": won 1 of 1$/)).toEqual([
      'Could not stop "Lamp B": a bid already sent cannot be stopped, so you could win more than 1.',
    ]);
    const all = Object.values(shared.areas.local.dump()[STORAGE_KEYS.snipes] as Record<string, Snipe>);
    const view = groupView(g as never, all, END + 7 * MIN, 'UTC');
    expect(view.warnings.join(' ')).toMatch(/could not stop "Lamp B".*A bid already sent cannot be stopped, so you could win more than 1\./);
  });

  // ── Arm-time rules ─────────────────────────────────────────────────────────

  it('arm time: ends under 2 min apart, a mixed mode or an unknown group are vetoed; a group never raises a cap', async () => {
    const shared = makeShared({ settings: settingsWith({ caps: { openExposureMax: 4000 } }) });
    const { w } = await boot(shared);
    await makeGroup(w, 1);
    await arm(w, A, { maxBid: 2400 });
    // B moved to end 70 s after A.
    (shared.sgw.items.get(B) as SgwItem).endMs = END + 70 * SEC;
    await expect(arm(w, B)).rejects.toThrow(/only 1 min 10 s from "Lamp A".*at least 2 minutes apart/);
    await expect(arm(w, C, { dryRun: true })).rejects.toThrow(/all dry run or all live/);
    await expect(arm(w, C, { groupId: 'nope' })).rejects.toThrow(/does not exist/);
    // N = 1 does not mean "only one max counts": C's full max still exceeds open exposure.
    await expect(arm(w, C, { maxBid: 2400 })).rejects.toThrow(/exposure/i);
    await arm(w, C, { maxBid: 1500 });
    expect(Object.keys(shared.areas.local.dump()[STORAGE_KEYS.snipes] as Record<string, Snipe>).sort()).toEqual([`s-${String(A)}`, `s-${String(C)}`]);
  });

  it('edit freeze: from 2 min before the next end, the group cannot be edited, deleted or joined', async () => {
    const shared = makeShared();
    const { w } = await boot(shared);
    await makeGroup(w, 2);
    await arm(w, A);
    await expect(w.ok('groups.delete', { id: 'g1' })).rejects.toThrow(/open snipe/);
    await runTo(shared, END - 2 * MIN);
    await expect(w.ok('groups.save', { id: 'g1', name: 'Lamps', maxWins: 1 })).rejects.toThrow(/frozen: "Lamp A" ends/);
    await expect(w.ok('groups.save', { id: 'g1', name: 'Other', maxWins: 2 })).rejects.toThrow(/frozen/);
    await expect(w.ok('groups.delete', { id: 'g1' })).rejects.toThrow(/frozen/);
    await expect(arm(w, C)).rejects.toThrow(/frozen/);
    // Unchanged values are no edit.
    await w.ok('groups.save', { id: 'g1', name: 'Lamps', maxWins: 2 });
    expect(groups(shared).groups.g1?.maxWins).toBe(2);
    // After A's result is known the group thaws.
    await runTo(shared, END + 2 * MIN);
    await w.ok('groups.save', { id: 'g1', name: 'Lamps', maxWins: 3 });
    expect(groups(shared).groups.g1?.maxWins).toBe(3);
  });

  // ── Restart and dry run ────────────────────────────────────────────────────

  it('a restarted worker re-applies a reached N: a confirmed win recorded before the restart stops the open members', async () => {
    const armed = (itemId: number): Snipe => {
      const end = new Date(ENDS[itemId] ?? END).toISOString();
      return {
        id: `s-${String(itemId)}`,
        itemId,
        title: TITLES[itemId] ?? 'Item',
        endTime: end,
        endTimeAtArm: end,
        sellerId: SELLER,
        maxBid: MAX,
        leadMs: LEAD,
        fallback: 'skip',
        dryRun: false,
        state: 'armed',
        armedAt: T0 - HOUR,
        fireAt: (ENDS[itemId] ?? END) - LEAD,
        attempt: {},
        groupId: 'g1',
        history: [{ at: T0 - HOUR, from: 'draft', to: 'armed', why: 'arm' }],
      };
    };
    const record: SnipeGroupsRecord = {
      version: 1,
      groups: {
        g1: {
          id: 'g1',
          name: 'Lamps',
          maxWins: 1,
          createdAt: T0 - DAY,
          updatedAt: T0 - DAY,
          results: { 's-1': { verdict: 'confirmed', dryRun: false, at: T0 - HOUR, attempts: 1, why: 'won at $11.00' } },
          cancels: {},
        },
      },
    };
    const shared = makeShared({ seed: { [STORAGE_KEYS.snipes]: { [`s-${String(B)}`]: armed(B) }, [GROUPS_KEY]: record } });
    const { ctx } = await boot(shared);
    await snipeGroupsFor(ctx)?.idle();
    await runTo(shared, T0 + MIN);
    expect(stored(shared, B)).toMatchObject({ state: 'killed', outcome: 'killed' });
    expect(groups(shared).groups.g1?.cancels[`s-${String(B)}`]).toMatchObject({ ok: true });
  });

  it('dry run: "would have won" at the close (a read after the end) stops the other dry-run members; nothing is ever sent', async () => {
    const shared = makeShared({ settings: settingsWith({ live: false }) });
    const { w } = await boot(shared);
    await makeGroup(w, 1);
    expect((await arm(w, A)).dryRun).toBe(true);
    await arm(w, B);
    await runTo(shared, END - 5 * SEC);
    // The dry run resolved at its fire, before the end: the group waits for a read after the end.
    expect(stored(shared, A)).toMatchObject({ state: 'resolved', outcome: 'dry-run' });
    expect(groups(shared).groups.g1?.results[`s-${String(A)}`]?.verdict).toBe('checking');
    expect(['armed', 'waking']).toContain(stored(shared, B).state);
    await runTo(shared, END + MIN);
    expect(groups(shared).groups.g1?.results[`s-${String(A)}`]).toMatchObject({ verdict: 'confirmed', dryRun: true });
    expect(stored(shared, B)).toMatchObject({ state: 'killed', outcome: 'killed' });
    await runTo(shared, END + 10 * MIN);
    expect(shared.sgw.placeBids).toEqual([]);
  });
});
