// T-83: awake history. The heartbeat job (src/background/jobs/heartbeat.ts, on
// T-52's onTick hook) records every 5 min that the browser is running; this
// module keeps that record compact and answers "how often was the browser
// running at this local hour over the last 14 days?", for honest arm-time
// advice. Pure: `now` and the zone come in through the context.
//
// Storage (`sbw:awake`, number[] of epoch ms, oldest first, kept 15 days): the
// first heartbeat of each 15-minute UTC slot, plus the latest heartbeat (so the
// job can space beats from storage alone, across worker restarts). Every
// current IANA offset is a whole number of 15-minute steps (+5:45 and +8:45
// included), so a local hour is exactly four slots: one heartbeat per slot
// loses nothing the per-hour likelihood needs, and the record stays bounded
// (at most 1,442 entries) instead of 4,000+ raw heartbeats.
import { STORAGE_LIMITS } from '../storage/schema';
import { formatClock } from '../time/pacific';
import { wallParts, zonedWallToInstant } from '../time/zoned';
import type { EpochMs } from '../types';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The heartbeat cadence: one beat per 5-minute cell of the epoch (see heartbeatDue). */
export const HEARTBEAT_INTERVAL_MS = 5 * MINUTE_MS;
/** Days the likelihood looks back over (§2.3 `sbw:awake`). */
export const AWAKE_DAYS = STORAGE_LIMITS.awakeHistoryDays;
/** One stored heartbeat per slot (plus the latest). */
export const AWAKE_SLOT_MS = 15 * MINUTE_MS;
/**
 * One day more than AWAKE_DAYS: when the hour asked about has not come yet
 * today, its 14 most recent occurrences reach back almost 15 days. (A
 * spring-forward day skipped on the way adds a day of dates but removes an
 * hour of real time, so the oldest one still falls inside 15 days.)
 */
export const AWAKE_RETENTION_MS = (AWAKE_DAYS + 1) * DAY_MS;
/** Upper bound on the stored array: one entry per slot in the retention window, plus the latest. */
export const AWAKE_MAX_ENTRIES = AWAKE_RETENTION_MS / AWAKE_SLOT_MS + 2;

export interface AwakeContext {
  now: EpochMs;
  /** The user's IANA zone (`settings.locale.timeZone`). */
  timeZone: string;
  /**
   * When recording began (`sbw:meta.installedAt`), if known. A day counts only
   * if recording began before that day's hour ended; earlier days are left
   * out instead of counted as "not running".
   */
  since?: EpochMs;
}

export interface AwakeDays {
  /** Local hour, 0-23. */
  hour: number;
  /** Days with at least one heartbeat inside that local hour. */
  awake: number;
  /** Days looked at: AWAKE_DAYS, fewer only when `since` is recent. */
  observed: number;
}

export interface AwakeAdvice extends AwakeDays {
  likelihood: number;
  /** "your browser was running at 7:42 PM on 3 of the last 14 days" */
  text: string;
}

/**
 * Adds a heartbeat at `now`. Keeps the first heartbeat of each 15-minute slot
 * and the latest one; sorts; drops entries older than the retention window or
 * later than `now` (a clock that moved back); caps the length. Returns
 * `history` itself when nothing changed, so the caller can skip the write.
 * Never mutates.
 */
export function recordHeartbeat(history: EpochMs[], now: EpochMs): EpochMs[] {
  if (!Number.isFinite(now)) return history;
  const from = now - AWAKE_RETENTION_MS;
  const sorted = [...new Set([...history, now])]
    .filter((t) => Number.isFinite(t) && t > from && t <= now)
    .sort((a, b) => a - b);
  const kept: EpochMs[] = [];
  let lastSlot = Number.NaN;
  for (const t of sorted) {
    const slot = Math.floor(t / AWAKE_SLOT_MS);
    if (slot === lastSlot) continue;
    kept.push(t);
    lastSlot = slot;
  }
  // `now` is the latest entry; keep it even when it is not first in its slot.
  if (kept.at(-1) !== now) kept.push(now);
  const next = kept.slice(-AWAKE_MAX_ENTRIES);
  const same = next.length === history.length && next.every((t, i) => t === history[i]);
  return same ? history : next;
}

/**
 * True when a heartbeat is due at `now`: nothing is stored yet, or `now` is in
 * a different 5-minute cell of the epoch than the latest stored heartbeat. On
 * a 2-minute tick this gives exactly one beat per 5-minute cell (12 an hour,
 * gaps of 4 or 6 min), and it reads only the stored ring, so a restarted
 * worker keeps the spacing. A clock that moved back into an earlier cell is due.
 */
export function heartbeatDue(history: readonly EpochMs[], now: EpochMs): boolean {
  let latest = Number.NEGATIVE_INFINITY;
  for (const t of history) if (Number.isFinite(t) && t > latest) latest = t;
  if (latest === Number.NEGATIVE_INFINITY) return true;
  return Math.floor(now / HEARTBEAT_INTERVAL_MS) !== Math.floor(latest / HEARTBEAT_INTERVAL_MS);
}

const pad = (n: number): string => String(n).padStart(2, '0');
const dateKey = (year: number, month: number, day: number): string => `${String(year)}-${pad(month)}-${pad(day)}`;

function assertHour(hour: number): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    throw new RangeError(`hour must be an integer from 0 to 23, got ${String(hour)}`);
  }
}

/**
 * Whether local hour `hour` exists on the calendar day `dayUtc` (a date
 * written as UTC midnight). A spring-forward gap removes it; transitions move
 * by whole quarter hours, so checking the four quarters is exact.
 */
function hourExists(dayUtc: number, hour: number, timeZone: string): boolean {
  return [0, 15, 30, 45].some(
    (m) => !zonedWallToInstant(dayUtc + hour * HOUR_MS + m * MINUTE_MS, timeZone).nonexistent,
  );
}

/**
 * Of the last 14 days, how many had at least one heartbeat within local hour
 * `hour`. "The last 14 days" are the 14 most recent local dates on which that
 * hour exists (a spring-forward day without it is skipped) and is over: today
 * counts only once the hour has ended.
 */
export function awakeDaysAt(hour: number, history: readonly EpochMs[], ctx: AwakeContext): AwakeDays {
  assertHour(hour);
  const tz = ctx.timeZone;
  const today = wallParts(ctx.now, tz);
  const startBack = today.hour > hour ? 0 : 1;
  const days: string[] = [];
  // At most one spring-forward day falls in any 15 consecutive days.
  for (let k = 0, found = 0; found < AWAKE_DAYS && k <= AWAKE_DAYS; k++) {
    const dayUtc = Date.UTC(today.year, today.month - 1, today.day - startBack - k);
    if (!hourExists(dayUtc, hour, tz)) continue;
    found++;
    // Recording must have begun before this day's hour ended ((hour + 1):00 local).
    if (ctx.since !== undefined && zonedWallToInstant(dayUtc + (hour + 1) * HOUR_MS, tz).ms <= ctx.since) continue;
    const d = new Date(dayUtc);
    days.push(dateKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()));
  }

  const from = ctx.now - AWAKE_RETENTION_MS;
  const awakeDates = new Set<string>();
  for (const t of history) {
    if (!(t > from && t <= ctx.now)) continue;
    const w = wallParts(t, tz);
    if (w.hour === hour) awakeDates.add(dateKey(w.year, w.month, w.day));
  }
  return { hour, awake: days.filter((d) => awakeDates.has(d)).length, observed: days.length };
}

/**
 * The fraction of the last 14 days that had at least one heartbeat within
 * local hour `hour` (0-23). No heartbeat in the hour gives 0. With `since`,
 * the fraction is of the days recorded so far (0 when there are none).
 */
export function likelihoodAwakeAt(hour: number, history: readonly EpochMs[], ctx: AwakeContext): number {
  const { awake, observed } = awakeDaysAt(hour, history, ctx);
  return observed === 0 ? 0 : awake / observed;
}

/**
 * Arm-time advice for an instant (the auction end): how often the browser was
 * running in that local hour. Text in the brief's format, as a lower-case
 * fragment the UI can put in a sentence:
 * "your browser was running at 7:42 PM on 3 of the last 14 days".
 */
export function awakeAdvice(at: EpochMs, history: readonly EpochMs[], ctx: AwakeContext): AwakeAdvice {
  const days = awakeDaysAt(wallParts(at, ctx.timeZone).hour, history, ctx);
  const time = formatClock(at, ctx.timeZone);
  const likelihood = days.observed === 0 ? 0 : days.awake / days.observed;
  const text =
    days.observed === 0
      ? `no awake history yet for ${time}`
      : `your browser was running at ${time} on ${String(days.awake)} of the last ${String(days.observed)} day${days.observed === 1 ? '' : 's'}`;
  return { ...days, likelihood, text };
}
