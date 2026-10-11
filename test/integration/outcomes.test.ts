// T-103 integration: after-auction outcome detection. One ItemDetail read per
// tracked item (with a snipe or a calendar event) at least 2 minutes after its
// end, on lane `background`; the outcome (won / lost / ended-early) is stamped
// on the calendar through T-67's CalendarSink, recorded on the TrackedItem and
// notified exactly once (T-56's gates: notifications.enabled, the
// `notifications` permission, quiet hours; never twice across a restart).
//
// Everything runs on fakes: FakeClock, FakeStorageAreas, FakeAuditLog,
// FakeSwitches, FakeNotifier, FakePermissions, FakeAlarms, FakeSgwApi and
// FakeCalendarApi. No network call is possible here (vitest.setup.ts refuses
// unhandled requests).
import { afterEach, describe, expect, it } from 'vitest';

import {
  Channel,
  EventGate,
  createPortRegistry,
  createTickHub,
  type BackgroundContext,
} from '../../src/background/context';
import { syncFor } from '../../src/background/jobs/calendar-sync';
import {
  MAX_POST_END_READS,
  OUTCOME_NOTIFY_ALARM_PREFIX,
  decisiveOutcome,
  onOutcomeAlarm,
  register as registerOutcomes,
  stampedOutcome,
} from '../../src/background/jobs/outcomes';
import { register as registerSnipeRunner } from '../../src/background/jobs/snipe-runner';
import { eventIdFor } from '../../src/domain/calendar/event-id';
import { spentToday } from '../../src/domain/snipe/caps';
import { defaultSettings } from '../../src/domain/settings/defaults';
import { Repo } from '../../src/domain/storage/repo';
import { STORAGE_KEYS } from '../../src/domain/storage/schema';
import type { Snipe } from '../../src/domain/snipe/types';
import type { ItemDetail, SgwSessionState, TrackedItem } from '../../src/domain/types';
import { FakeAlarms } from '../fakes/ports/fake-alarms';
import { FakeAuditLog } from '../fakes/ports/fake-audit-log';
import { FakeCalendarApi } from '../fakes/ports/fake-calendar-api';
import { FakeClock } from '../fakes/ports/fake-clock';
import { FakeKeepAlive } from '../fakes/ports/fake-keepalive';
import { FakeKeepAwake } from '../fakes/ports/fake-keepawake';
import { FakeNotifier } from '../fakes/ports/fake-notifier';
import { FakePermissions } from '../fakes/ports/fake-permissions';
import { FakeSgwApi } from '../fakes/ports/fake-sgw-api';
import { FakeStorageAreas } from '../fakes/ports/fake-storage';
import { FakeSwitches } from '../fakes/ports/fake-switches';

// ── Constants and helpers ────────────────────────────────────────────────────

const MIN = 60_000;
/** 2026-10-11 16:00 UTC = 12:00 EDT (America/New_York, the default zone). */
const T0 = Date.UTC(2026, 9, 11, 16, 0, 0);
/** 2026-10-11 04:00 UTC = 00:00 EDT: inside quiet hours "22:00"-"06:00". */
const T0_QUIET = Date.UTC(2026, 9, 11, 4, 0, 0);
const CALENDAR_ID = 'cal-1';

/** Drains pending promise callbacks (no fake time passes). */
const flush = async (rounds = 8): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

/** Fires pending FakeClock timers in small steps (e.g. the calendar limiter's 1 s waits). */
async function settle(clock: FakeClock): Promise<void> {
  for (let i = 0; i < 40; i++) {
    await flush();
    if (clock.pendingTimers === 0) return;
    clock.advance(1250);
  }
}

/** FakeSwitches plus the extra members the snipe runner and the rig need. */
class TestSwitches extends FakeSwitches {
  settings(): undefined {
    return undefined;
  }
  onChange(): () => void {
    return () => undefined;
  }
  verdictNow(): { ok: boolean; why?: string } {
    return { ok: true };
  }
  view(): { killSwitch: boolean; writesAllowed: Record<string, boolean> } {
    return { killSwitch: false, writesAllowed: { favorites: true, calendar: true, bidding: true } };
  }
}

interface Rig {
  ctx: BackgroundContext;
  clock: FakeClock;
  alarms: FakeAlarms;
  repo: Repo;
  audit: FakeAuditLog;
  notifier: FakeNotifier;
  switches: TestSwitches;
  api: FakeSgwApi;
  calendarApi: FakeCalendarApi;
  /** Mutable: the sink reads it on every sync. Calendar stamps must ignore it. */
  sessionState: { value: SgwSessionState };
  /** Mutable: calendar sync writes only while this says connected. */
  google: { connected: boolean; needsInteraction: boolean };
  tick(): Promise<void>;
}

const RIGS: Rig[] = [];
afterEach(() => {
  RIGS.length = 0;
});

async function rig(opts: { now?: number; quiet?: { from: string; to: string } } = {}): Promise<Rig> {
  const clock = new FakeClock(opts.now ?? T0);
  const areas = new FakeStorageAreas();
  const repo = new Repo(areas, clock);
  const audit = new FakeAuditLog(clock);
  const switches = new TestSwitches();
  const notifier = new FakeNotifier();
  const permissions = new FakePermissions({ permissions: ['notifications'] });
  const alarms = new FakeAlarms(clock);
  const keepAlive = new FakeKeepAlive();
  const keepAwake = new FakeKeepAwake();
  const api = new FakeSgwApi({ clock, switches });
  const calendarApi = new FakeCalendarApi();
  const ticks = createTickHub(() => undefined);
  const gate = new EventGate(() => undefined);
  const ports = createPortRegistry(new Channel(gate));
  const sessionState: Rig['sessionState'] = { value: 'ok' };
  const google: Rig['google'] = { connected: false, needsInteraction: false };
  const ctx = {
    clock,
    storage: areas,
    repo,
    audit,
    notifier,
    permissions,
    alarms,
    keepAlive,
    keepAwake,
    api,
    calendarApi,
    switches,
    ticks,
    ports,
    session: { state: () => Promise.resolve(sessionState.value), current: () => Promise.resolve(null) },
    sgwClock: { offset: () => null, serverNow: () => null },
    google: { status: () => Promise.resolve({ connected: google.connected, needsInteraction: google.needsInteraction }) },
    googleNeedsInteraction: { set: () => undefined },
    lifecycle: { onStartup: () => () => undefined, onInstalled: () => () => undefined },
    router: { register: () => undefined },
    broadcast: () => Promise.resolve(undefined),
    startup: { migration: null, storageProblem: null, registered: { handlers: [], jobs: [], failed: [] } },
  } as unknown as BackgroundContext;

  const settings = defaultSettings();
  settings.calendar.enabled = true;
  settings.dryRun.calendar = false;
  settings.notifications.enabled = true;
  if (opts.quiet !== undefined) settings.notifications.quietHours = opts.quiet;
  await repo.set(STORAGE_KEYS.settings, settings);

  registerOutcomes(ctx);
  registerSnipeRunner(ctx);

  const r: Rig = {
    ctx,
    clock,
    alarms,
    repo,
    audit,
    notifier,
    switches,
    api,
    calendarApi,
    sessionState,
    google,
    async tick() {
      const p = ticks.tick();
      await settle(clock);
      await p;
      await settle(clock);
    },
  };
  RIGS.push(r);
  return r;
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

/** A tracked item that ended 5 minutes ago, on the calendar. */
async function track(r: Rig, itemId: number, over: Partial<TrackedItem> = {}): Promise<void> {
  await r.repo.update(STORAGE_KEYS.tracked, (cur) => ({
    ...cur,
    [itemId]: {
      itemId,
      title: `Pyrex bowl ${String(itemId)}`,
      endTime: new Date(r.clock.now() - 5 * MIN).toISOString(),
      sellerId: 7,
      reasons: [{ kind: 'manual' as const }],
      favoriteState: 'none',
      calendar: true,
      addedAt: r.clock.now() - 60 * MIN,
      updatedAt: r.clock.now() - 60 * MIN,
      ...over,
    },
  }));
}

/** A closed ItemDetail as the FakeSgwApi answers. */
function closedDetail(itemId: number, over: Partial<ItemDetail> = {}): ItemDetail {
  return {
    itemId,
    title: `Pyrex bowl ${String(itemId)}`,
    currentPrice: 1299,
    startingMinimumBid: 500,
    numBids: 2,
    endTime: new Date(T0 - 5 * MIN).toISOString(),
    endTimeRaw: '2026-10-11T11:55:00',
    sellerId: 7,
    source: 'api',
    observedAt: T0,
    pickupOnly: false,
    minimumBid: 1400,
    bidIncrement: 100,
    serverTime: new Date(T0 - 4 * MIN).toISOString(),
    serverTimeRaw: '2026-10-11T11:56:00',
    isClosed: true,
    isHighBidder: null,
    inWatchlist: null,
    bidHistory: [],
    ...over,
  };
}

/** A live calendar event under the item's event id, plus its synced link. */
async function seedEvent(r: Rig, itemId: number, title: string): Promise<void> {
  const eventId = eventIdFor(itemId, 0);
  await r.repo.set(STORAGE_KEYS.calendar, {
    calendarId: CALENDAR_ID,
    links: {
      [itemId]: { itemId, eventId, generation: 0, calendarId: CALENDAR_ID, lastSyncedHash: 'seed-hash', status: 'synced' },
    },
  });
  r.calendarApi.seedCalendar(CALENDAR_ID);
  await r.calendarApi.eventsInsert(CALENDAR_ID, {
    summary: title,
    description: `https://shopgoodwill.com/item/${String(itemId)}`,
    start: { dateTime: new Date(T0 - 5 * MIN).toISOString(), timeZone: 'UTC' },
    end: { dateTime: new Date(T0 - 5 * MIN + 15 * MIN).toISOString(), timeZone: 'UTC' },
    reminders: { useDefault: false, overrides: [{ method: 'popup' as const, minutes: 60 }] },
    extendedProperties: { private: { sbwItemId: String(itemId), sbwGen: '0', sbwState: 'open' } },
    id: eventId,
  });
}

async function seedSnipe(r: Rig, over: Partial<Snipe> = {}): Promise<string> {
  const id = `sn-${String(Math.floor(Math.random() * 1e9))}`;
  const itemId = over.itemId ?? 1;
  const base: Snipe = {
    id,
    itemId,
    title: `Pyrex bowl ${String(itemId)}`,
    endTime: new Date(r.clock.now() - 5 * MIN).toISOString(),
    endTimeAtArm: new Date(r.clock.now() - 5 * MIN).toISOString(),
    maxBid: 2000,
    leadMs: 8000,
    fallback: 'skip',
    dryRun: false,
    state: 'armed',
    armedAt: r.clock.now() - 60 * MIN,
    attempt: {},
    history: [{ at: r.clock.now() - 60 * MIN, from: 'draft' as const, to: 'armed' as const, why: 'armed' }],
    ...over,
  };
  await r.repo.update(STORAGE_KEYS.snipes, (cur) => ({ ...cur, [id]: base }));
  return id;
}

const reads = (r: Rig): Array<{ method: string; args: unknown[] }> => r.api.calls.filter((c) => c.method === 'itemDetail');
const eventOf = (r: Rig, itemId: number) => r.calendarApi.eventsGet(CALENDAR_ID, eventIdFor(itemId, 0));
const outcomes = (r: Rig) => r.repo.get(STORAGE_KEYS.tracked).then((t) => Object.fromEntries(Object.entries(t).map(([k, v]) => [k, v.outcome])));

// ── Pure classification helpers ──────────────────────────────────────────────

/** The last history entry of a snipe the T-84 runner settled, by how it settled. */
const settledBy = (why: string): Snipe['history'] => [
  { at: T0 - 60 * MIN, from: 'draft', to: 'armed', why: 'armed' },
  { at: T0 - 5 * MIN, from: 'sent', to: 'resolved', why },
];

describe('outcome classification helpers', () => {
  it('decisiveOutcome maps the T-84 snipe outcomes that already stamped the calendar', () => {
    const snipe = (outcome: Snipe['outcome'], why = 'post-read') => ({ outcome, history: settledBy(why) });
    expect(decisiveOutcome(snipe('won'))).toBe('won');
    expect(decisiveOutcome(snipe('outbid'))).toBe('lost');
    expect(decisiveOutcome(snipe('below-minimum'))).toBe('lost');
    expect(decisiveOutcome(snipe('late'))).toBe('lost');
    expect(decisiveOutcome(snipe('ended'))).toBe('ended-early');
    expect(decisiveOutcome(snipe('killed'))).toBeUndefined();
    expect(decisiveOutcome(snipe('dry-run'))).toBeUndefined();
    expect(decisiveOutcome(snipe('network'))).toBeUndefined();
    expect(decisiveOutcome(snipe(undefined))).toBeUndefined();
  });

  it('decisiveOutcome: a win or an outbid settled without the outcome read ("Leading") decides nothing', () => {
    // T-87 judges these with no ItemDetail: final is false, T-84 neither stamps nor says "Won".
    for (const why of ['post-read failed', 'result: accepted']) {
      expect(decisiveOutcome({ outcome: 'won', history: settledBy(why) })).toBeUndefined();
      expect(decisiveOutcome({ outcome: 'outbid', history: settledBy(why) })).toBeUndefined();
    }
    // T-84's own "Lost" results stay decisive however they settled.
    expect(decisiveOutcome({ outcome: 'late', history: settledBy('result: closed') })).toBe('lost');
    expect(decisiveOutcome({ outcome: 'below-minimum', history: settledBy('result: below-minimum') })).toBe('lost');
  });

  it('stampedOutcome reads the calendar link stamp record', () => {
    expect(stampedOutcome('stamped:won')).toBe('won');
    expect(stampedOutcome('stamped:lost')).toBe('lost');
    expect(stampedOutcome('stamped:ended-early')).toBe('ended-early');
    expect(stampedOutcome('abcdef0123456789')).toBeUndefined();
    expect(stampedOutcome('')).toBeUndefined();
  });
});

// ── The post-end flow ────────────────────────────────────────────────────────

describe('post-end outcome detection', () => {
  it('won: title prefixed WON with the final price, reminders cleared, one notification, outcome recorded once', async () => {
    const r = await rig();
    await track(r, 11);
    await seedEvent(r, 11, 'Pyrex bowl 11');
    r.api.details.set(11, closedDetail(11, { isHighBidder: true, currentPrice: 1299 }));

    await r.tick();
    const ev = await eventOf(r, 11);
    expect(ev?.summary).toBe('WON: Pyrex bowl 11');
    expect(ev?.reminders.overrides).toEqual([]);
    expect(ev?.description).toContain('Final price: $12.99');
    expect(ev?.extendedProperties.private.sbwState).toBe('won');
    expect(await outcomes(r)).toMatchObject({ 11: 'won' });

    expect(reads(r)).toHaveLength(1);
    expect(reads(r)[0]?.args).toEqual([11, 'background', undefined]);
    const sent = r.notifier.sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]?.id).toBe('sbw:notify:outcome:11');
    expect(sent[0]?.notification.title).toBe('WON: Pyrex bowl 11');
    expect(sent[0]?.notification.message).toContain('You won this auction');
    expect(sent[0]?.notification.id?.startsWith('sbw:notify:digest:')).toBe(false);
    expect(sent[0]?.notification.openUrlOnClick).toBe('https://shopgoodwill.com/item/11');
    expect(r.audit.kinds).toContain('outcome.recorded');
    expect(r.audit.kinds).toContain('notify.outcome');

    // R2: never read again once recorded; R3: stamping again is a no-op; R6: never twice.
    const patches = () => r.calendarApi.calls.filter((c) => c.method === 'eventsPatch').length;
    const before = patches();
    await r.tick();
    expect(reads(r)).toHaveLength(1);
    expect(patches()).toBe(before);
    expect(r.notifier.sent).toHaveLength(1);
  });

  it('lost: title prefixed LOST, final price in the description, one notification', async () => {
    const r = await rig();
    await track(r, 12);
    await seedEvent(r, 12, 'Pyrex bowl 12');
    r.api.details.set(12, closedDetail(12, { isHighBidder: false, currentPrice: 2500 }));

    await r.tick();
    const ev = await eventOf(r, 12);
    expect(ev?.summary).toBe('LOST: Pyrex bowl 12');
    expect(ev?.description).toContain('Final price: $25.00');
    expect(ev?.reminders.overrides).toEqual([]);
    expect(await outcomes(r)).toMatchObject({ 12: 'lost' });
    expect(reads(r)).toHaveLength(1);
    expect(r.notifier.sent.map((n) => n.notification.title)).toEqual(['LOST: Pyrex bowl 12']);
  });

  it('ended-early: ENDED EARLY on the calendar, the armed snipe moved to ended, exactly one notification', async () => {
    const r = await rig();
    await track(r, 13, { reasons: [{ kind: 'snipe' }] });
    await seedEvent(r, 13, 'Pyrex bowl 13');
    const snipeId = await seedSnipe(r, { itemId: 13, state: 'armed' });
    r.api.details.set(13, closedDetail(13, { isHighBidder: null, currentPrice: 1299 }));

    await r.tick();
    const ev = await eventOf(r, 13);
    expect(ev?.summary).toBe('ENDED EARLY: Pyrex bowl 13');
    expect(ev?.reminders.overrides).toEqual([]);
    expect(ev?.extendedProperties.private.sbwState).toBe('ended-early');
    expect(await outcomes(r)).toMatchObject({ 13: 'ended-early' });

    const snipes = await r.repo.get(STORAGE_KEYS.snipes);
    expect(snipes[snipeId]).toMatchObject({ state: 'resolved', outcome: 'ended' });
    // T-82 is the only spent-today accumulation. `ended` is not a spend.
    expect(spentToday(Object.values(snipes), r.clock.now())).toBe(0);

    expect(reads(r)).toHaveLength(1);
    // The snipe path notifies ("Ended early: ..."); postEnd must not add a second one.
    expect(r.notifier.sent).toHaveLength(1);
    expect(r.notifier.sent[0]?.notification.title).toContain('Ended early');

    // Recorded: no second read, no second stamp, no second notification.
    const patches = () => r.calendarApi.calls.filter((c) => c.method === 'eventsPatch').length;
    const before = patches();
    await r.tick();
    expect(reads(r)).toHaveLength(1);
    expect(patches()).toBe(before);
    expect(r.notifier.sent).toHaveLength(1);
  });

  it('R3: an item the T-84 snipe path already decided is recorded from persisted state, with no read, stamp or notification', async () => {
    const r = await rig();
    await track(r, 14);
    await seedEvent(r, 14, 'Pyrex bowl 14');
    await seedSnipe(r, { itemId: 14, state: 'resolved', outcome: 'won', history: settledBy('post-read') });

    await r.tick();
    expect(await outcomes(r)).toMatchObject({ 14: 'won' });
    expect(reads(r)).toHaveLength(0);
    expect(r.notifier.sent).toHaveLength(0);
    expect(r.calendarApi.calls.filter((c) => c.method === 'eventsPatch')).toHaveLength(0);
    expect(r.audit.entries.some((e) => e.kind === 'outcome.recorded' && e.itemId === 14 && e.details.from === 'snipe')).toBe(true);
  });

  it('a calendar link stamped by a crashed post-end run recovers the outcome with no second read', async () => {
    const r = await rig();
    await track(r, 15);
    await seedEvent(r, 15, 'Pyrex bowl 15');
    await r.repo.update(STORAGE_KEYS.calendar, (c) => ({
      ...c,
      links: { ...c.links, 15: { ...(c.links[15] as NonNullable<(typeof c.links)[number]>), lastSyncedHash: 'stamped:lost' } },
    }));

    await r.tick();
    expect(await outcomes(r)).toMatchObject({ 15: 'lost' });
    expect(reads(r)).toHaveLength(0);
    expect(r.notifier.sent).toHaveLength(1);
    expect(r.notifier.sent[0]?.notification.title).toBe('LOST: Pyrex bowl 15');
  });

  it('a snipe with a send in flight defers the outcome read to a later tick', async () => {
    const r = await rig();
    await track(r, 16);
    await seedEvent(r, 16, 'Pyrex bowl 16');
    const snipeId = await seedSnipe(r, { itemId: 16, state: 'sent', attempt: { sentAt: T0 - 6 * MIN, idempotencyKey: 'k-16' } });
    r.api.details.set(16, closedDetail(16, { isHighBidder: false }));

    await r.tick();
    expect(reads(r)).toHaveLength(0);
    expect(await outcomes(r)).toMatchObject({ 16: undefined });

    // The runner settles the send: the decisive outcome is recorded without a read.
    await r.repo.update(STORAGE_KEYS.snipes, (cur) => {
      const snipe = cur[snipeId];
      if (snipe === undefined) return cur;
      return { ...cur, [snipeId]: { ...snipe, state: 'resolved', outcome: 'outbid', history: settledBy('post-read') } };
    });
    await r.tick();
    expect(reads(r)).toHaveLength(0);
    expect(await outcomes(r)).toMatchObject({ 16: 'lost' });
  });

  it('an auction still running refreshes the tracked end time and waits for the new end', async () => {
    const r = await rig();
    await track(r, 17);
    await seedEvent(r, 17, 'Pyrex bowl 17');
    const newEnd = new Date(r.clock.now() + 3 * 60 * MIN).toISOString();
    r.api.details.set(17, closedDetail(17, { isClosed: false, endTime: newEnd, endTimeRaw: '2026-10-11T15:00:00' }));

    await r.tick();
    const tracked = await r.repo.get(STORAGE_KEYS.tracked);
    expect(tracked[17]?.endTime).toBe(newEnd);
    expect(tracked[17]?.outcome).toBeUndefined();
    expect(r.calendarApi.calls.filter((c) => c.method === 'eventsPatch')).toHaveLength(0);
    expect(r.notifier.sent).toHaveLength(0);

    // Not due again until 2 minutes after the new end.
    await r.tick();
    expect(reads(r)).toHaveLength(1);
    expect(await outcomes(r)).toMatchObject({ 17: undefined });
  });

  it('one read per tick: two due items are read one per tick, on lane background', async () => {
    const r = await rig();
    await track(r, 18);
    await track(r, 19);
    await seedEvent(r, 18, 'Pyrex bowl 18');
    await seedEvent(r, 19, 'Pyrex bowl 19');
    r.api.details.set(18, closedDetail(18, { isHighBidder: false }));
    r.api.details.set(19, closedDetail(19, { isHighBidder: false }));

    await r.tick();
    expect(reads(r)).toHaveLength(1);
    await r.tick();
    expect(reads(r)).toHaveLength(2);
    expect(reads(r).every((c) => c.args[1] === 'background')).toBe(true);
  });

  it('waits at least 2 minutes after the end before the one read', async () => {
    const r = await rig();
    await track(r, 20, { endTime: new Date(r.clock.now() - 1 * MIN).toISOString() });
    await seedEvent(r, 20, 'Pyrex bowl 20');
    r.api.details.set(20, closedDetail(20, { isHighBidder: false }));

    await r.tick();
    expect(reads(r)).toHaveLength(0);

    r.clock.advance(2 * MIN);
    await r.tick();
    expect(reads(r)).toHaveLength(1);
  });

  it('only tracked items with a snipe or a calendar event are read', async () => {
    const r = await rig();
    await track(r, 21, { calendar: false });
    r.api.details.set(21, closedDetail(21, { isHighBidder: false }));

    await r.tick();
    expect(reads(r)).toHaveLength(0);
    expect(await outcomes(r)).toMatchObject({ 21: undefined });
  });

  it('a budget refusal stops the tick quietly and the read happens on a later tick', async () => {
    const r = await rig();
    await track(r, 22);
    await seedEvent(r, 22, 'Pyrex bowl 22');
    r.api.details.set(22, closedDetail(22, { isHighBidder: true }));
    r.api.failNext('itemDetail', 'budget');

    await r.tick();
    expect(reads(r)).toHaveLength(1); // attempted
    expect(await outcomes(r)).toMatchObject({ 22: undefined });
    expect(r.audit.kinds).not.toContain('outcome.read-failed');

    await r.tick();
    expect(reads(r)).toHaveLength(2);
    expect(await outcomes(r)).toMatchObject({ 22: 'won' });
  });

  it('R7: the read obeys the kill switch and resumes when it is lifted', async () => {
    const r = await rig();
    await track(r, 23);
    await seedEvent(r, 23, 'Pyrex bowl 23');
    r.api.details.set(23, closedDetail(23, { isHighBidder: true }));
    await r.repo.update(STORAGE_KEYS.settings, (s) => ({ ...s, killSwitch: true }));

    await r.tick();
    expect(reads(r)).toHaveLength(0);

    await r.repo.update(STORAGE_KEYS.settings, (s) => ({ ...s, killSwitch: false }));
    await r.tick();
    expect(reads(r)).toHaveLength(1);
    expect(await outcomes(r)).toMatchObject({ 23: 'won' });
  });

  it('R7: a blocked calendar write skips the stamp but still records the outcome and notifies', async () => {
    const r = await rig();
    await track(r, 24);
    await seedEvent(r, 24, 'Pyrex bowl 24');
    r.api.details.set(24, closedDetail(24, { isHighBidder: true, currentPrice: 1500 }));
    r.switches.block('calendar', 'dry run');

    await r.tick();
    const ev = await eventOf(r, 24);
    expect(ev?.summary).toBe('Pyrex bowl 24'); // not stamped
    expect(await outcomes(r)).toMatchObject({ 24: 'won' });
    expect(r.notifier.sent).toHaveLength(1);
    expect(r.audit.entries.some((e) => e.kind === 'outcome.stamp-skipped' && e.itemId === 24)).toBe(true);
  });

  it('an anonymous read with no price proof records unknown: no stamp, no notification, no re-read', async () => {
    const r = await rig();
    await track(r, 25);
    await seedEvent(r, 25, 'Pyrex bowl 25');
    r.api.details.set(25, closedDetail(25, { isHighBidder: null }));

    await r.tick();
    expect(await outcomes(r)).toMatchObject({ 25: 'unknown' });
    expect(r.calendarApi.calls.filter((c) => c.method === 'eventsPatch')).toHaveLength(0);
    expect(r.notifier.sent).toHaveLength(0);

    await r.tick();
    expect(reads(r)).toHaveLength(1);
  });

  it('a final price above the snipe max is recorded lost, and the notification says only what the price proves', async () => {
    const r = await rig();
    await track(r, 26);
    await seedEvent(r, 26, 'Pyrex bowl 26');
    await seedSnipe(r, { itemId: 26, state: 'resolved', outcome: 'killed', maxBid: 1000 });
    r.api.details.set(26, closedDetail(26, { isHighBidder: null, currentPrice: 1299 }));

    await r.tick();
    expect(await outcomes(r)).toMatchObject({ 26: 'lost' });
    expect((await eventOf(r, 26))?.summary).toBe('LOST: Pyrex bowl 26');
    // ShopBadwill cannot see bids placed on SGW directly: the copy states the
    // price fact, never "you did not win".
    expect(r.notifier.sent).toHaveLength(1);
    expect(r.notifier.sent[0]?.notification.title).toBe('Over your max: Pyrex bowl 26');
    expect(r.notifier.sent[0]?.notification.message).toBe(
      'The final price, $12.99, was above your max of $10.00. https://shopgoodwill.com/item/26',
    );
  });

  it('notifications disabled: the outcome is stamped and recorded silently', async () => {
    const r = await rig();
    await track(r, 27);
    await seedEvent(r, 27, 'Pyrex bowl 27');
    r.api.details.set(27, closedDetail(27, { isHighBidder: true }));
    await r.repo.update(STORAGE_KEYS.settings, (s) => ({ ...s, notifications: { ...s.notifications, enabled: false } }));

    await r.tick();
    expect((await eventOf(r, 27))?.summary).toBe('WON: Pyrex bowl 27');
    expect(await outcomes(r)).toMatchObject({ 27: 'won' });
    expect(r.notifier.sent).toHaveLength(0);
    expect(r.audit.kinds).not.toContain('notify.outcome');
  });

  it('quiet hours: the outcome notification is deferred to the quiet end and sent exactly once', async () => {
    const r = await rig({ now: T0_QUIET, quiet: { from: '22:00', to: '06:00' } });
    await track(r, 28);
    await seedEvent(r, 28, 'Pyrex bowl 28');
    r.api.details.set(28, closedDetail(28, { isHighBidder: true, endTime: new Date(T0_QUIET - 5 * MIN).toISOString() }));

    await r.tick();
    expect(await outcomes(r)).toMatchObject({ 28: 'won' });
    expect(r.notifier.sent).toHaveLength(0);
    const alarm = (await r.alarms.getAll()).find((a) => a.name === `${OUTCOME_NOTIFY_ALARM_PREFIX}28`);
    expect(alarm).toBeDefined();
    expect(alarm?.scheduledTime).toBeGreaterThan(r.clock.now());

    // Quiet hours end at 06:00 EDT = 10:00 UTC.
    r.clock.advance(6 * 60 * MIN + 10 * MIN);
    await settle(r.clock);
    expect(r.notifier.sent).toHaveLength(1);
    expect(r.notifier.sent[0]?.notification.title).toBe('WON: Pyrex bowl 28');

    // R6: never sent twice, whatever fires again.
    await onOutcomeAlarm(r.ctx, 28);
    expect(r.notifier.sent).toHaveLength(1);
  });

  it('a waking or verified snipe that ended early moves through verify-failed, once', async () => {
    for (const state of ['waking', 'verified'] as const) {
      const itemId = state === 'waking' ? 31 : 32;
      const r = await rig();
      await track(r, itemId, { reasons: [{ kind: 'snipe' }] });
      await seedEvent(r, itemId, `Pyrex bowl ${String(itemId)}`);
      const snipeId = await seedSnipe(r, { itemId, state });
      r.api.details.set(itemId, closedDetail(itemId, { isHighBidder: null }));

      await r.tick();
      expect(await r.repo.get(STORAGE_KEYS.snipes)).toMatchObject({
        [snipeId]: { state: 'resolved', outcome: 'ended' },
      });
      expect((await eventOf(r, itemId))?.summary).toBe(`ENDED EARLY: Pyrex bowl ${String(itemId)}`);
      expect(reads(r)).toHaveLength(1);
      expect(r.notifier.sent).toHaveLength(1);

      await r.tick();
      expect(reads(r)).toHaveLength(1);
      expect(r.notifier.sent).toHaveLength(1);
    }
  });

  it('an auction that is still open at a due end is read once, and again only after the end moves', async () => {
    const r = await rig();
    const end = new Date(r.clock.now() - 5 * MIN).toISOString();
    await track(r, 33, { endTime: end });
    await seedEvent(r, 33, 'Pyrex bowl 33');
    r.api.details.set(33, closedDetail(33, { isClosed: false, endTime: end, isHighBidder: false }));

    await r.tick();
    expect(reads(r)).toHaveLength(1);
    expect(await outcomes(r)).toMatchObject({ 33: undefined });
    expect(r.notifier.sent).toHaveLength(0);
    expect(r.calendarApi.calls.filter((c) => c.method === 'eventsPatch')).toHaveLength(0);

    r.clock.advance(30 * MIN);
    await r.tick();
    expect(reads(r)).toHaveLength(1);

    const later = new Date(r.clock.now() + 10 * MIN).toISOString();
    await r.repo.update(STORAGE_KEYS.tracked, (cur) => {
      const t = cur[33];
      return t === undefined ? cur : { ...cur, 33: { ...t, endTime: later } };
    });
    r.api.details.set(33, closedDetail(33, { isClosed: true, endTime: later, isHighBidder: false, currentPrice: 2500 }));
    r.clock.advance(10 * MIN + 2 * MIN);
    await r.tick();
    expect(reads(r)).toHaveLength(2);
    expect(await outcomes(r)).toMatchObject({ 33: 'lost' });
    expect((await eventOf(r, 33))?.summary).toBe('LOST: Pyrex bowl 33');
  });

  it('a scheduler pause retries on a later tick and does not read in a loop', async () => {
    const r = await rig();
    await track(r, 34);
    await seedEvent(r, 34, 'Pyrex bowl 34');
    r.api.details.set(34, closedDetail(34, { isHighBidder: false }));
    r.api.failNext('itemDetail', 'paused');

    await r.tick();
    expect(reads(r)).toHaveLength(1);
    expect(await outcomes(r)).toMatchObject({ 34: undefined });
    expect(r.audit.kinds).not.toContain('outcome.read-failed');

    await r.tick();
    expect(reads(r)).toHaveLength(2);
    expect(await outcomes(r)).toMatchObject({ 34: 'lost' });
  });

  it('a snipe with no calendar event is still read; a tracked item with neither is not', async () => {
    const r = await rig();
    await track(r, 35, { calendar: false });
    await track(r, 36, { calendar: false });
    await seedSnipe(r, { itemId: 35, state: 'resolved', outcome: 'killed', maxBid: 5000 });
    r.api.details.set(35, closedDetail(35, { isHighBidder: null, currentPrice: 800 }));
    r.api.details.set(36, closedDetail(36, { isHighBidder: false }));

    await r.tick();
    expect(reads(r).map((c) => c.args[0])).toEqual([35]);
    expect(reads(r)[0]?.args[1]).toBe('background');
    await r.tick();
    expect(reads(r)).toHaveLength(1);
  });

  it('stamps only our own event: a foreign event under the link is left untouched', async () => {
    const r = await rig();
    await track(r, 37);
    await seedEvent(r, 37, 'Not ours');
    const eventId = eventIdFor(37, 0);
    const foreign = await r.calendarApi.eventsGet(CALENDAR_ID, eventId);
    if (foreign === null) throw new Error('seeded event missing');
    await r.calendarApi.eventsPatch(CALENDAR_ID, eventId, {
      extendedProperties: { private: { ...foreign.extendedProperties.private, sbwItemId: '999999' } },
    });
    r.calendarApi.calls.length = 0;
    r.api.details.set(37, closedDetail(37, { isHighBidder: true, currentPrice: 1500 }));

    await r.tick();
    expect(r.calendarApi.calls.filter((c) => c.method === 'eventsPatch')).toHaveLength(0);
    expect((await eventOf(r, 37))?.summary).toBe('Not ours');
    expect(await outcomes(r)).toMatchObject({ 37: 'won' });
    expect(r.notifier.sent).toHaveLength(1);
  });

  it('a calendar stamp is not gated by the SGW session', async () => {
    const r = await rig();
    r.sessionState.value = 'logged-out';
    await track(r, 38);
    await seedEvent(r, 38, 'Pyrex bowl 38');
    r.api.details.set(38, closedDetail(38, { isHighBidder: true, currentPrice: 1500 }));

    await r.tick();
    expect((await eventOf(r, 38))?.summary).toBe('WON: Pyrex bowl 38');
    expect((await eventOf(r, 38))?.description).toContain('Final price: $15.00');
    expect(await outcomes(r)).toMatchObject({ 38: 'won' });
  });

  it('a sync that samples the item before the outcome is saved does not un-stamp, and later syncs do not ping-pong', async () => {
    const r = await rig();
    r.google.connected = true;
    await track(r, 39);
    await seedEvent(r, 39, 'Pyrex bowl 39');
    const patches = (): number => r.calendarApi.calls.filter((c) => c.method === 'eventsPatch').length;

    const stamped = syncFor(r.ctx).sink.stamp(39, 'won', 1299);
    await settle(r.clock);
    await stamped;
    const afterStamp = patches();
    expect(afterStamp).toBeGreaterThan(0);
    expect((await eventOf(r, 39))?.summary).toBe('WON: Pyrex bowl 39');
    expect((await eventOf(r, 39))?.description).toContain('Final price: $12.99');
    expect((await eventOf(r, 39))?.reminders.overrides).toEqual([]);

    // The outcome is not recorded yet: this is the race window.
    const raced = syncFor(r.ctx).syncNow('before-record');
    await settle(r.clock);
    await raced;
    expect((await eventOf(r, 39))?.summary).toBe('WON: Pyrex bowl 39');
    expect((await eventOf(r, 39))?.description).toContain('Final price: $12.99');
    expect((await eventOf(r, 39))?.reminders.overrides).toEqual([]);
    expect(patches()).toBe(afterStamp);

    await r.repo.update(STORAGE_KEYS.tracked, (cur) => {
      const t = cur[39];
      return t === undefined ? cur : { ...cur, 39: { ...t, outcome: 'won' } };
    });
    const settled = syncFor(r.ctx).syncNow('after-record');
    await settle(r.clock);
    await settled;
    expect((await eventOf(r, 39))?.summary).toBe('WON: Pyrex bowl 39');
    expect((await eventOf(r, 39))?.description).toContain('Final price: $12.99');
    expect((await eventOf(r, 39))?.reminders.overrides).toEqual([]);
    const stable = patches();

    for (let i = 0; i < 3; i++) {
      const again = syncFor(r.ctx).syncNow('again');
      await settle(r.clock);
      await again;
    }
    expect(patches()).toBe(stable);
    expect((await eventOf(r, 39))?.summary).toBe('WON: Pyrex bowl 39');
  });
});

// ── Final check (Opus): bounded reads ────────────────────────────────────────

describe('post-end reads stay bounded', () => {
  const patchCount = (r: Rig): number => r.calendarApi.calls.filter((c) => c.method === 'eventsPatch').length;
  const recordedFrom = (r: Rig, itemId: number): unknown =>
    r.audit.entries.find((e) => e.kind === 'outcome.recorded' && e.itemId === itemId)?.details.from;

  it('an auction whose end keeps moving later is read a bounded number of times, then recorded unknown', async () => {
    expect(MAX_POST_END_READS).toBeLessThanOrEqual(4);
    const r = await rig();
    await track(r, 42);
    await seedEvent(r, 42, 'Pyrex bowl 42');
    for (let i = 0; i < 10; i++) {
      const later = new Date(r.clock.now() + 10 * MIN).toISOString();
      r.api.details.set(42, closedDetail(42, { isClosed: false, endTime: later }));
      await r.tick();
      r.clock.advance(12 * MIN);
    }
    await r.tick();

    expect(reads(r)).toHaveLength(MAX_POST_END_READS);
    expect(await outcomes(r)).toMatchObject({ 42: 'unknown' });
    expect(recordedFrom(r, 42)).toBe('read-cap');
    expect(r.notifier.sent).toHaveLength(0);
    expect(patchCount(r)).toBe(0);
  });

  it('a read that keeps failing backs off between attempts, then gives up as unknown', async () => {
    const r = await rig();
    await track(r, 43);
    await seedEvent(r, 43, 'Pyrex bowl 43');
    // No detail seeded: FakeSgwApi answers every read with a 404 server error.

    await r.tick();
    expect(reads(r)).toHaveLength(1);
    expect(r.audit.entries.filter((e) => e.kind === 'outcome.read-failed' && e.itemId === 43)).toHaveLength(1);

    // The next tick, 2 minutes later, does not read the failing item again.
    r.clock.advance(2 * MIN);
    await r.tick();
    expect(reads(r)).toHaveLength(1);

    // Twelve hours of 2-minute ticks: a bounded number of reads, then unknown.
    for (let i = 0; i < 360; i++) {
      r.clock.advance(2 * MIN);
      await r.tick();
    }
    expect(reads(r)).toHaveLength(MAX_POST_END_READS);
    expect(await outcomes(r)).toMatchObject({ 43: 'unknown' });
    expect(recordedFrom(r, 43)).toBe('read-cap');
    expect(r.notifier.sent).toHaveLength(0);
  });

  it('a failing read does not starve the next due item', async () => {
    const r = await rig();
    await track(r, 44); // no detail seeded: its read fails
    await track(r, 45);
    r.api.details.set(45, closedDetail(45, { isHighBidder: false, currentPrice: 2500 }));

    await r.tick();
    r.clock.advance(2 * MIN);
    await r.tick();

    expect(reads(r).map((c) => c.args[0])).toEqual([44, 45]);
    expect(await outcomes(r)).toMatchObject({ 44: undefined, 45: 'lost' });
  });

  it('a tick that starts while the previous one is still reading does not read or notify a second time', async () => {
    const r = await rig();
    await track(r, 46);
    await seedEvent(r, 46, 'Pyrex bowl 46');
    r.api.details.set(46, closedDetail(46, { isHighBidder: true, currentPrice: 1500 }));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let attempts = 0;
    const read = r.api.itemDetail.bind(r.api);
    r.api.itemDetail = (itemId, lane, opts) => {
      attempts += 1;
      return gate.then(() => read(itemId, lane, opts));
    };

    const first = r.tick();
    await flush();
    const second = r.tick();
    await flush();
    const state = { done: false };
    const both = Promise.all([first, second]).then(() => {
      state.done = true;
    });
    release();
    // Keep fake time moving (the calendar limiter waits on it) until both ticks finish.
    for (let i = 0; i < 50 && !state.done; i++) await settle(r.clock);
    await both;
    await r.tick();

    expect(attempts).toBe(1);
    expect(await outcomes(r)).toMatchObject({ 46: 'won' });
    expect(r.notifier.sent).toHaveLength(1);
  });
});

// ── Final check (Opus): claim only what the data proves ──────────────────────

describe('post-end claims only what the data proves', () => {
  it('a T-84 win settled without the outcome read ("Leading") is never recorded or stamped WON', async () => {
    const r = await rig();
    r.google.connected = true;
    await track(r, 47);
    await seedEvent(r, 47, 'Pyrex bowl 47');
    await seedSnipe(r, {
      itemId: 47,
      state: 'resolved',
      outcome: 'won',
      maxBid: 2000,
      attempt: { sentAt: T0 - 6 * MIN, idempotencyKey: 'k-47' },
      history: settledBy('post-read failed'),
    });
    // The anonymous read cannot see the high bidder, and the price is under the max.
    r.api.details.set(47, closedDetail(47, { isHighBidder: null, currentPrice: 1500 }));

    await r.tick();
    expect(await outcomes(r)).toMatchObject({ 47: 'unknown' });
    expect(reads(r)).toHaveLength(1);
    const synced = syncFor(r.ctx).syncNow('after');
    await settle(r.clock);
    await synced;
    // The sync may refresh the open event, but never stamps it.
    expect((await eventOf(r, 47))?.summary).toBe('Pyrex bowl 47');
    expect((await eventOf(r, 47))?.extendedProperties.private.sbwState).toBe('open');
    expect(r.notifier.sent).toHaveLength(0);
  });

  it('a dry-run snipe placed no bid: no loss is inferred from its max', async () => {
    const r = await rig();
    await track(r, 48);
    await seedEvent(r, 48, 'Pyrex bowl 48');
    await seedSnipe(r, { itemId: 48, state: 'resolved', outcome: 'dry-run', dryRun: true, maxBid: 1000, history: settledBy('post-read: dry run measured') });
    r.api.details.set(48, closedDetail(48, { isHighBidder: null, currentPrice: 1299 }));

    await r.tick();
    expect(await outcomes(r)).toMatchObject({ 48: 'unknown' });
    expect((await eventOf(r, 48))?.summary).toBe('Pyrex bowl 48');
    expect(r.notifier.sent).toHaveLength(0);
  });

  it('a snipe skipped because you already led shows a bid ShopBadwill never saw: no loss is inferred', async () => {
    const r = await rig();
    await track(r, 49);
    await seedEvent(r, 49, 'Pyrex bowl 49');
    await seedSnipe(r, {
      itemId: 49,
      state: 'resolved',
      outcome: 'skipped',
      maxBid: 1000,
      history: [
        { at: T0 - 60 * MIN, from: 'draft', to: 'armed', why: 'armed' },
        { at: T0 - 6 * MIN, from: 'armed', to: 'waking', why: 'wake' },
        { at: T0 - 6 * MIN, from: 'waking', to: 'resolved', why: 'verify-failed: already-high' },
      ],
    });
    r.api.details.set(49, closedDetail(49, { isHighBidder: null, currentPrice: 1299 }));

    await r.tick();
    expect(await outcomes(r)).toMatchObject({ 49: 'unknown' });
    expect((await eventOf(r, 49))?.summary).toBe('Pyrex bowl 49');
    expect(r.notifier.sent).toHaveLength(0);
  });

  it('quiet hours: a deferred over-max notification keeps the over-max copy', async () => {
    const r = await rig({ now: T0_QUIET, quiet: { from: '22:00', to: '06:00' } });
    await track(r, 50);
    await seedEvent(r, 50, 'Pyrex bowl 50');
    await seedSnipe(r, { itemId: 50, state: 'resolved', outcome: 'killed', maxBid: 1000 });
    r.api.details.set(50, closedDetail(50, { isHighBidder: null, currentPrice: 1299, endTime: new Date(T0_QUIET - 5 * MIN).toISOString() }));

    await r.tick();
    expect(await outcomes(r)).toMatchObject({ 50: 'lost' });
    expect(r.notifier.sent).toHaveLength(0);

    r.clock.advance(6 * 60 * MIN + 10 * MIN);
    await settle(r.clock);
    expect(r.notifier.sent).toHaveLength(1);
    expect(r.notifier.sent[0]?.notification.title).toBe('Over your max: Pyrex bowl 50');
    expect(r.notifier.sent[0]?.notification.message).toBe(
      'The final price, $12.99, was above your max of $10.00. https://shopgoodwill.com/item/50',
    );
  });

  it('a crash-recovered LOST stamp on a sniped item keeps the over-max copy, without a price it never saw', async () => {
    const r = await rig();
    await track(r, 51);
    await seedEvent(r, 51, 'Pyrex bowl 51');
    await seedSnipe(r, { itemId: 51, state: 'resolved', outcome: 'killed', maxBid: 1000 });
    await r.repo.update(STORAGE_KEYS.calendar, (c) => ({
      ...c,
      links: { ...c.links, 51: { ...(c.links[51] as NonNullable<(typeof c.links)[number]>), lastSyncedHash: 'stamped:lost' } },
    }));

    await r.tick();
    expect(await outcomes(r)).toMatchObject({ 51: 'lost' });
    expect(reads(r)).toHaveLength(0);
    expect(r.notifier.sent).toHaveLength(1);
    expect(r.notifier.sent[0]?.notification.title).toBe('Over your max: Pyrex bowl 51');
    expect(r.notifier.sent[0]?.notification.message).toBe('The final price was above your max of $10.00. https://shopgoodwill.com/item/51');
  });
});
