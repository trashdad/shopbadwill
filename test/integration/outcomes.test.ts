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
import {
  OUTCOME_NOTIFY_ALARM_PREFIX,
  decisiveOutcome,
  onOutcomeAlarm,
  register as registerOutcomes,
  stampedOutcome,
} from '../../src/background/jobs/outcomes';
import { register as registerSnipeRunner } from '../../src/background/jobs/snipe-runner';
import { eventIdFor } from '../../src/domain/calendar/event-id';
import { defaultSettings } from '../../src/domain/settings/defaults';
import { Repo } from '../../src/domain/storage/repo';
import { STORAGE_KEYS } from '../../src/domain/storage/schema';
import type { Snipe } from '../../src/domain/snipe/types';
import type { ItemDetail, TrackedItem } from '../../src/domain/types';
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
    session: { state: () => Promise.resolve('ok' as const), current: () => Promise.resolve(null) },
    sgwClock: { offset: () => null, serverNow: () => null },
    google: { status: () => Promise.resolve({ connected: false }) },
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

describe('outcome classification helpers', () => {
  it('decisiveOutcome maps the T-84 snipe outcomes that already stamped the calendar', () => {
    expect(decisiveOutcome('won')).toBe('won');
    expect(decisiveOutcome('outbid')).toBe('lost');
    expect(decisiveOutcome('below-minimum')).toBe('lost');
    expect(decisiveOutcome('late')).toBe('lost');
    expect(decisiveOutcome('ended')).toBe('ended-early');
    expect(decisiveOutcome('killed')).toBeUndefined();
    expect(decisiveOutcome('dry-run')).toBeUndefined();
    expect(decisiveOutcome('network')).toBeUndefined();
    expect(decisiveOutcome(undefined)).toBeUndefined();
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
    await seedSnipe(r, { itemId: 14, state: 'resolved', outcome: 'won' });

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
      return { ...cur, [snipeId]: { ...snipe, state: 'resolved', outcome: 'outbid' } };
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

  it('a final price above the snipe max proves a loss even without the high-bidder flag', async () => {
    const r = await rig();
    await track(r, 26);
    await seedEvent(r, 26, 'Pyrex bowl 26');
    await seedSnipe(r, { itemId: 26, state: 'resolved', outcome: 'killed', maxBid: 1000 });
    r.api.details.set(26, closedDetail(26, { isHighBidder: null, currentPrice: 1299 }));

    await r.tick();
    expect(await outcomes(r)).toMatchObject({ 26: 'lost' });
    expect((await eventOf(r, 26))?.summary).toBe('LOST: Pyrex bowl 26');
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
});
