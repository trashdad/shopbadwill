// T-129: ended auctions drop off the extension's lists at once. An auction has
// ended when the clock reaches its end (the local clock: these lists have no
// SGW clock offset) or when it carries a recorded outcome. A list re-renders
// when the next of its ends passes: one timer to that end, never a poll.
import { useEffect, useState } from 'preact/hooks';

/** setTimeout's ceiling (about 24.8 days). A later end is re-checked when this fires. */
const MAX_TIMER_MS = 2_147_483_647;

/** `endMs` has passed at `now`. An unparseable end never counts as ended. */
export function auctionEnded(endMs: number, now: number): boolean {
  return !Number.isNaN(endMs) && now >= endMs;
}

/**
 * The local clock, read again when the soonest future end in `ends` passes,
 * so a row whose auction ends while the page is open leaves it then.
 */
export function useEndClock(ends: readonly number[]): number {
  const [now, setNow] = useState(() => Date.now());
  let next = Infinity;
  for (const e of ends) if (!Number.isNaN(e) && e > now && e < next) next = e;
  useEffect(() => {
    if (!Number.isFinite(next)) return undefined;
    const id = setTimeout(
      () => {
        setNow(Date.now());
      },
      Math.min(Math.max(0, next - Date.now()), MAX_TIMER_MS),
    );
    return () => {
      clearTimeout(id);
    };
  }, [next, now]);
  return now;
}
