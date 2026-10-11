// T-56 (I-18): the ONLY late-add rule. T-66 (calendar reconciler) and T-67 inject
// or call it; nothing else in the code base may re-derive "ends soon".
// Pure: the caller passes `now`.
import type { EpochMs, IsoUtc, ItemId } from '../types';

/** A late add ends in under this long. */
export const LATE_ADD_WINDOW_MS = 60 * 60_000;

/**
 * True when the item ends less than 60 minutes after `now` and has not ended
 * yet. Exactly 60 minutes out is not late; `end <= now` is not late (past).
 * An unparseable end time is never late.
 */
export function isLateAdd(item: { itemId: ItemId; endTime: IsoUtc }, now: EpochMs): boolean {
  const end = new Date(item.endTime).getTime();
  if (Number.isNaN(end)) return false;
  return end > now && end - now < LATE_ADD_WINDOW_MS;
}
