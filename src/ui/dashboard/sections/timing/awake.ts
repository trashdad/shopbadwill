// T-90: the awake-history chart's row computation, text-based (R4). Pure: the
// rows come from T-83's awakeDaysAt over the heartbeat history (`sbw:awake`),
// which the Timing page loads with `timing.awake`.
import { AWAKE_DAYS, awakeDaysAt } from '../../../../domain/snipe/awake-history';

export interface AwakeRow {
  /** Local hour, 0-23. */
  hour: number;
  /** '00:00' … '23:00' (local). */
  label: string;
  /** Of the last AWAKE_DAYS, how many had at least one heartbeat in this hour. */
  awake: number;
  /** Days looked at (fewer only while recording is young). */
  observed: number;
}

/** One row per local hour of the day: how often the browser was running at that hour. */
export function awakeRows(history: readonly number[], timeZone: string, now: number): AwakeRow[] {
  return Array.from({ length: 24 }, (_, hour) => {
    const days = awakeDaysAt(hour, history, { now, timeZone });
    return {
      hour,
      label: `${String(hour).padStart(2, '0')}:00`,
      awake: days.awake,
      observed: days.observed,
    };
  });
}

/** The fraction a row's bar covers (CSS width), 0 when nothing observed. */
export function awakeFraction(row: AwakeRow): number {
  return row.observed === 0 ? 0 : row.awake / row.observed;
}

/** How many days the chart looks back over (T-83). */
export const AWAKE_DAYS_SHOWN = AWAKE_DAYS;
