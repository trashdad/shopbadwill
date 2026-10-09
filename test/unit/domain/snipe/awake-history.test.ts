import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createHeartbeat, registerHeartbeat } from '../../../../src/background/jobs/heartbeat';
import {
  AWAKE_DAYS,
  AWAKE_MAX_ENTRIES,
  AWAKE_RETENTION_MS,
  AWAKE_SLOT_MS,
  awakeAdvice,
  awakeDaysAt,
  HEARTBEAT_INTERVAL_MS,
  likelihoodAwakeAt,
  recordHeartbeat,
} from '../../../../src/domain/snipe/awake-history';
import { Repo } from '../../../../src/domain/storage/repo';
import { STORAGE_KEYS, STORAGE_LIMITS } from '../../../../src/domain/storage/schema';
import { zonedWallToInstant } from '../../../../src/domain/time/zoned';
import { FakeClock } from '../../../fakes/ports/fake-clock';
import { FakeStorageAreas } from '../../../fakes/ports/fake-storage';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NY = 'America/New_York';
const LA = 'America/Los_Angeles';

/** The instant `tz` shows 2026-10-<day> hh:mm (days before 1 roll back into September). */
function local(day: number, hh: number, mm = 0, tz = NY): number {
  return zonedWallToInstant(Date.UTC(2026, 9, day, hh, mm), tz).ms;
}

/** Heartbeats every 5 min across [from, to). */
function beats(from: number, to: number, every = HEARTBEAT_INTERVAL_MS): number[] {
  const out: number[] = [];
  for (let t = from; t < to; t += every) out.push(t);
  return out;
}

// "Now" is Friday 2026-10-09, 9:00 PM in New York.
const NOW = local(9, 21);
const CTX = { now: NOW, timeZone: NY };

describe('constants', () => {
  it('use the 14-day storage limit and a 5-minute heartbeat', () => {
    expect(AWAKE_DAYS).toBe(14);
    expect(AWAKE_DAYS).toBe(STORAGE_LIMITS.awakeHistoryDays);
    expect(HEARTBEAT_INTERVAL_MS).toBe(5 * MIN);
  });
});

// ── Tests first (task card) ────────────────────────────────────────────────

describe('likelihoodAwakeAt: the task card tests', () => {
  it('is computed from heartbeat gaps: only days with a heartbeat inside the local hour count', () => {
    const history = [
      // Running through 7 PM on three days.
      ...beats(local(9, 18, 30), local(9, 20, 10)),
      ...beats(local(5, 19, 0), local(5, 19, 6)),
      ...beats(local(27 - 30, 19, 55), local(27 - 30, 20, 0)), // Sep 27, last 5 minutes of the hour
      // A gap over 7 PM: running at 6:55 PM and again at 8:05 PM, nothing between.
      local(7, 18, 55),
      local(7, 20, 5),
      // Running at other hours only.
      ...beats(local(6, 8, 0), local(6, 12, 0)),
    ];
    expect(likelihoodAwakeAt(19, history, CTX)).toBeCloseTo(3 / 14, 12);
    expect(awakeDaysAt(19, history, CTX)).toEqual({ hour: 19, awake: 3, observed: 14 });
  });

  it('no heartbeat in the hour gives 0', () => {
    const history = [...beats(local(8, 6, 0), local(8, 18, 59)), ...beats(local(8, 20, 0), local(8, 23, 0))];
    expect(likelihoodAwakeAt(19, history, CTX)).toBe(0);
    expect(likelihoodAwakeAt(19, [], CTX)).toBe(0);
  });
});

describe('likelihoodAwakeAt: the 14-day window', () => {
  it('an always-on browser scores 1 at every hour', () => {
    const history = beats(NOW - 15 * DAY, NOW);
    for (let h = 0; h < 24; h++) expect(likelihoodAwakeAt(h, history, CTX)).toBe(1);
  });

  it("today counts once the hour is over; an hour still to come uses yesterday back 14 days", () => {
    // 7 PM has passed today (now is 9 PM): Oct 9 .. Sep 26.
    expect(likelihoodAwakeAt(19, [local(9, 19, 30)], CTX)).toBe(1 / 14);
    expect(likelihoodAwakeAt(19, [local(26 - 30, 19, 30)], CTX)).toBe(1 / 14);
    expect(likelihoodAwakeAt(19, [local(25 - 30, 19, 30)], CTX)).toBe(0);
    // 10 PM has not happened yet today: Oct 8 .. Sep 25.
    expect(likelihoodAwakeAt(22, [local(25 - 30, 22, 30)], CTX)).toBe(1 / 14);
    expect(likelihoodAwakeAt(22, [local(24 - 30, 22, 30)], CTX)).toBe(0);
    // The current hour (9 PM) is not over: today is not counted yet.
    expect(likelihoodAwakeAt(21, [NOW], CTX)).toBe(0);
  });

  it('uses the local hour of the given time zone', () => {
    const t = local(8, 19, 30); // 7:30 PM in New York = 4:30 PM in Los Angeles
    expect(likelihoodAwakeAt(19, [t], CTX)).toBe(1 / 14);
    expect(likelihoodAwakeAt(16, [t], { now: NOW, timeZone: LA })).toBe(1 / 14);
    expect(likelihoodAwakeAt(19, [t], { now: NOW, timeZone: LA })).toBe(0);
  });

  it('counts a day once however many heartbeats it has', () => {
    expect(likelihoodAwakeAt(19, beats(local(8, 19, 0), local(8, 20, 0), MIN), CTX)).toBe(1 / 14);
  });

  it("with 'since' (install time), days before recording began are not counted against the browser", () => {
    const since = local(7, 12);
    const history = [local(8, 19, 10)];
    expect(awakeDaysAt(19, history, { ...CTX, since })).toEqual({ hour: 19, awake: 1, observed: 3 });
    expect(likelihoodAwakeAt(19, history, { ...CTX, since })).toBe(1 / 3);
    expect(likelihoodAwakeAt(19, [], { ...CTX, since: NOW })).toBe(0);
  });

  it('rejects an hour outside 0-23', () => {
    expect(() => likelihoodAwakeAt(24, [], CTX)).toThrow(RangeError);
    expect(() => likelihoodAwakeAt(-1, [], CTX)).toThrow(RangeError);
    expect(() => likelihoodAwakeAt(1.5, [], CTX)).toThrow(RangeError);
  });
});

describe('recordHeartbeat: a compact, bounded ring in sbw:awake', () => {
  it('stores the first heartbeat of each 15-minute slot and returns the same array when nothing changes', () => {
    const slot = Math.floor(NOW / AWAKE_SLOT_MS) * AWAKE_SLOT_MS;
    const a = recordHeartbeat([], slot + MIN);
    expect(a).toEqual([slot + MIN]);
    const b = recordHeartbeat(a, slot + 6 * MIN);
    expect(b).toBe(a);
    const c = recordHeartbeat(b, slot + AWAKE_SLOT_MS);
    expect(c).toEqual([slot + MIN, slot + AWAKE_SLOT_MS]);
    expect(a).toEqual([slot + MIN]); // input never mutated
  });

  it('drops entries older than the retention window and entries in the future', () => {
    const old = NOW - AWAKE_RETENTION_MS;
    const future = NOW + HOUR;
    expect(recordHeartbeat([old, NOW - DAY, future], NOW)).toEqual([NOW - DAY, NOW]);
  });

  it('keeps at most AWAKE_MAX_ENTRIES after a month of 5-minute heartbeats, and still covers 14 days', () => {
    let history: number[] = [];
    for (const t of beats(NOW - 30 * DAY, NOW + 1)) history = recordHeartbeat(history, t);
    expect(history.length).toBeLessThanOrEqual(AWAKE_MAX_ENTRIES);
    expect(history.length).toBeGreaterThan(AWAKE_DAYS * 96);
    for (let h = 0; h < 24; h++) expect(likelihoodAwakeAt(h, history, CTX)).toBe(1);
  });

  it('is retained for 15 days, enough for the 14 completed occurrences of any hour', () => {
    expect(AWAKE_RETENTION_MS).toBe((AWAKE_DAYS + 1) * DAY);
    expect(AWAKE_MAX_ENTRIES).toBe((AWAKE_DAYS + 1) * 96 + 1);
  });

  it('property: compaction loses nothing the per-hour likelihood needs, even in a :45 offset zone', () => {
    const zones = [NY, LA, 'Asia/Kathmandu', 'Asia/Kolkata', 'Australia/Eucla'];
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 15 * 24 * 12 - 1 }), { maxLength: 300 }),
        fc.constantFrom(...zones),
        fc.integer({ min: 0, max: 23 }),
        (ticks, tz, hour) => {
          const raw = [...new Set(ticks)].sort((x, y) => x - y).map((i) => NOW - 15 * DAY + i * HEARTBEAT_INTERVAL_MS);
          let compact: number[] = [];
          for (const t of raw) compact = recordHeartbeat(compact, t);
          const ctx = { now: NOW, timeZone: tz };
          expect(awakeDaysAt(hour, compact, ctx)).toEqual(awakeDaysAt(hour, raw, ctx));
        },
      ),
      { numRuns: 60 },
    );
  });
});

describe('awakeAdvice: arm-time text in the brief format', () => {
  const history = [local(9, 19, 5), local(4, 19, 50), local(30 - 30, 19, 0)];

  it('"your browser was running at 7:42 PM on 3 of the last 14 days"', () => {
    const at = local(10, 19, 42);
    const advice = awakeAdvice(at, history, CTX);
    expect(advice.text).toBe('your browser was running at 7:42 PM on 3 of the last 14 days');
    expect(advice).toMatchObject({ hour: 19, awake: 3, observed: 14 });
    expect(advice.likelihood).toBeCloseTo(3 / 14, 12);
  });

  it("uses the user's time zone for both the hour and the clock text", () => {
    const at = local(10, 19, 42); // 4:42 PM in Los Angeles; the heartbeats fall in its 4 PM hour
    const advice = awakeAdvice(at, history, { now: NOW, timeZone: LA });
    expect(advice.text).toBe('your browser was running at 4:42 PM on 3 of the last 14 days');
    expect(advice.hour).toBe(16);
  });

  it('counts only recorded days when the install time is known', () => {
    const advice = awakeAdvice(local(10, 19, 42), history, { ...CTX, since: local(8, 9) });
    expect(advice.text).toBe('your browser was running at 7:42 PM on 1 of the last 2 days');
  });

  it('says so when there is no history yet', () => {
    const advice = awakeAdvice(local(10, 19, 42), [], { ...CTX, since: NOW });
    expect(advice.text).toBe('no awake history yet for 7:42 PM');
    expect(advice.likelihood).toBe(0);
  });
});

// ── src/background/jobs/heartbeat.ts ───────────────────────────────────────

function setup() {
  const clock = new FakeClock(NOW);
  const areas = new FakeStorageAreas();
  const repo = new Repo(areas, clock);
  return { clock, areas, repo };
}

describe('heartbeat job (registered on the scheduler onTick hook)', () => {
  it('registers exactly one tick callback and records into sbw:awake', async () => {
    const { repo } = setup();
    const callbacks: (() => Promise<void>)[] = [];
    registerHeartbeat((cb) => callbacks.push(cb), { repo });
    expect(callbacks).toHaveLength(1);
    await callbacks[0]?.();
    expect(await repo.get(STORAGE_KEYS.awake)).toEqual([NOW]);
  });

  it('records at most once per 5 minutes on a 2-minute tick', async () => {
    const { clock, repo } = setup();
    const hb = createHeartbeat({ repo });
    const results: string[] = [];
    for (let i = 0; i < 16; i++) {
      results.push(await hb.beat());
      clock.advance(2 * MIN);
    }
    // Ticks at 0, 2, 4, ... 30 min; beats at 0, 6, 12, 18, 24, 30.
    expect(results.filter((r) => r !== 'throttled')).toHaveLength(6);
    expect(results[0]).toBe('stored');
    expect(results[3]).toBe('same-slot'); // 6 min: same 15-minute slot as 0
    // One per 15-minute slot touched (NOW is on a slot boundary).
    expect(await repo.get(STORAGE_KEYS.awake)).toEqual([NOW, NOW + 18 * MIN, NOW + 30 * MIN]);
  });

  it('beats again after the clock moves backwards', async () => {
    const { clock, repo } = setup();
    const hb = createHeartbeat({ repo });
    await hb.beat();
    clock.set(NOW - HOUR);
    expect(await hb.beat()).not.toBe('throttled');
  });

  it('never throws into the tick loop when storage fails', async () => {
    const { areas, repo } = setup();
    areas.local.set = () => Promise.reject(new Error('quota'));
    const hb = createHeartbeat({ repo });
    await expect(hb.beat()).resolves.toBe('error');
  });
});
