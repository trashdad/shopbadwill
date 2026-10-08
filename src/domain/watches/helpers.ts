// T-50: Watch helpers. Pure: no clock, no storage, no SGW names (I-26).
import type { Settings } from '../settings/schema';
import type { EpochMs, ItemId } from '../types';
import { WATCH_SEEN_RING_SIZE, type Watch } from './schema';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallParts(ms: number, timeZone: string): Wall {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  const parts = f.formatToParts(ms);
  const get = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** The zone's wall clock at `ms`, expressed as if it were UTC (whole seconds). */
function wallAsUtc(ms: number, timeZone: string): number {
  const w = wallParts(ms, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

/** UTC offset (ms, east positive) of `timeZone` at `ms`. */
function offsetAt(ms: number, timeZone: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  return wallAsUtc(whole, timeZone) - whole;
}

/**
 * The instant at which `timeZone` shows the wall time `wallUtc` (a wall time written as UTC).
 * Fall-back (two instants): the earlier. Spring-forward gap (none): the pre-transition offset
 * is applied, so 02:30 EST-gap becomes 03:30 EDT. Same technique as `parsePacificDetailed`,
 * for any IANA zone (pacific.ts only knows America/Los_Angeles).
 */
function instantOfWall(wallUtc: number, timeZone: string): number {
  const before = offsetAt(wallUtc - DAY_MS, timeZone);
  const after = offsetAt(wallUtc + DAY_MS, timeZone);
  const first = [...new Set([before, after])]
    .map((off) => wallUtc - off)
    .filter((instant) => wallAsUtc(instant, timeZone) === wallUtc)
    .sort((a, b) => a - b)[0];
  return first ?? wallUtc - before;
}

/**
 * The next scheduled daily run strictly after `now`: `settings.dailyRun.localTime`
 * ("HH:MM") on the user's calendar in `timeZone`, DST-correct.
 */
export function nextRunAtFor(settings: Pick<Settings, 'dailyRun'>, now: EpochMs, timeZone: string): EpochMs {
  const m = LOCAL_TIME.exec(settings.dailyRun.localTime);
  if (m === null) throw new RangeError(`Invalid dailyRun.localTime: ${JSON.stringify(settings.dailyRun.localTime)}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  const today = wallParts(now, timeZone);
  for (let addDays = 0; addDays < 3; addDays++) {
    const candidate = instantOfWall(Date.UTC(today.year, today.month - 1, today.day + addDays, hour, minute), timeZone);
    if (candidate > now) return candidate;
  }
  /* c8 ignore next 2: unreachable, a day-after candidate always exceeds now */
  throw new RangeError('nextRunAtFor: no candidate after now');
}

/**
 * Adds `ids` to the front of a most-recent-first ring of already-reported item ids.
 * `ids` keep their given order at the front (first = most recent). Dedupes (a re-reported
 * id moves to the front, once) and evicts the oldest beyond `cap`. Pure; returns a new array.
 */
export function recordSeen(
  seen: readonly ItemId[],
  ids: readonly ItemId[],
  cap: number = WATCH_SEEN_RING_SIZE,
): ItemId[] {
  const out: ItemId[] = [];
  const taken = new Set<ItemId>();
  for (const id of [...ids, ...seen]) {
    if (taken.has(id)) continue;
    taken.add(id);
    out.push(id);
    if (out.length >= cap) break;
  }
  return out;
}

export function hasSeen(watch: Pick<Watch, 'seenItemIds'>, id: ItemId): boolean {
  return watch.seenItemIds.includes(id);
}

/** A copy of `watch` with `ids` recorded in its seen ring. */
export function markSeen(watch: Watch, ids: readonly ItemId[], cap: number = WATCH_SEEN_RING_SIZE): Watch {
  return { ...watch, seenItemIds: recordSeen(watch.seenItemIds, ids, cap) };
}
