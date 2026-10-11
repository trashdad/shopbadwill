// T-85 (I-18): the one exposure measurement behind the exposure meter. The
// domain already defines exposure() (the sum of every open — armed through
// sent — max bid plus its known shipping and handling) and spentToday()
// (resolved spend today, including T-80b's unconfirmed ones, at the ceiling).
// "Exposure against the daily cap" (R4) combines the two: this is the only
// place they are added, so the meter T-85 builds and T-102 mounts never
// diverges from the caps' accounting.
import { exposure, spentToday, type Exposure } from '../../domain/snipe/caps';
import type { Snipe } from '../../domain/snipe/types';
import type { Cents, EpochMs } from '../../domain/types';

export interface ExposureMeasure {
  /** Open exposure plus today's spent (including unconfirmed): what the meter shows. */
  used: Cents;
  /** The open-exposure part (armed through sent). */
  open: Exposure;
  /** Spent or unconfirmed today, at the ceiling. */
  spentToday: Cents;
}

/** Pure: integer cents, no I/O. `nowMs` is the user's local "today" anchor. */
export function measureExposure(snipes: readonly Snipe[], nowMs: EpochMs, timeZone: string): ExposureMeasure {
  const open = exposure(snipes);
  const spent = spentToday(snipes, nowMs, timeZone);
  return { used: open.total + spent, open, spentToday: spent };
}
