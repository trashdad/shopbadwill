// T-50: Watch helpers. Pure: no clock, no storage, no SGW names (I-26).
import { wallParts, zonedWallToInstant } from '../time/zoned';
import type { Settings } from '../settings/schema';
import type { EpochMs, ItemId } from '../types';
import { WATCH_SEEN_RING_SIZE, type Watch } from './schema';

const LOCAL_TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

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
    const candidate = zonedWallToInstant(Date.UTC(today.year, today.month - 1, today.day + addDays, hour, minute), timeZone).ms;
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
  if (cap <= 0) return [];
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
