// Clock over Date, performance and setTimeout. Background context only.
//
// T-59 time-travel seam: in a TEST build (`import.meta.env.SBW_TEST`, the
// literal `false` in production) a shared offset is added to both `now()` and
// `monotonic()`, so the RequestScheduler's two-clock gap check
// (src/adapters/sgw/request-scheduler.ts) fast-forwards with the test's
// `sbw:test:advance` hook. The offset is set only by src/test-hooks/advance.ts
// (and unit tests); production tree-shakes the helpers and the branches
// compile out, so the prod bundle carries no trace (`pnpm check:prod-bundle`).
import type { EpochMs } from '../../domain/types';
import type { Clock } from '../../ports/clock';

/** SBW_TEST only: the shared offset applied to wall and monotonic time. */
let testOffsetMs = 0;

function testOffset(): number {
  return import.meta.env.SBW_TEST ? testOffsetMs : 0;
}

export class BrowserClock implements Clock {
  now(): EpochMs {
    return Date.now() + testOffset();
  }

  monotonic(): number {
    return performance.now() + testOffset();
  }

  setTimeout(fn: () => void, ms: number): number {
    // Node returns a Timeout object; Number() yields its numeric id.
    return Number(globalThis.setTimeout(fn, ms));
  }

  clearTimeout(id: number): void {
    globalThis.clearTimeout(id);
  }
}

/**
 * SBW_TEST only: the shared fake "now" (`Date.now()` plus the offset). Used
 * by the alarms seam (src/adapters/browser/alarms.ts) and the fetch stamp
 * (src/test-hooks/advance.ts); in production it is `Date.now()`.
 */
export function testClockNow(): EpochMs {
  return Date.now() + testOffset();
}

/**
 * SBW_TEST only: moves the shared offset forward by `ms` and returns the new
 * `now()`. In production this is a no-op that reports the real time.
 */
export function advanceTestClock(ms: number): EpochMs {
  if (!import.meta.env.SBW_TEST) return Date.now();
  if (!Number.isFinite(ms) || ms < 0) {
    throw new Error(`sbw:test:advance: ms must be a non-negative finite number, got ${String(ms)}`);
  }
  testOffsetMs += ms;
  return Date.now() + testOffsetMs;
}

/**
 * SBW_TEST only: sets the offset so `now()` is exactly `toMs` (a restart lost
 * the offset; the harness re-anchors absolutely instead of re-adding). In
 * production this is a no-op that reports the real time.
 */
export function setTestClockTo(toMs: number): EpochMs {
  if (!import.meta.env.SBW_TEST) return Date.now();
  if (!Number.isFinite(toMs)) {
    throw new Error(`sbw:test:advance: to must be a finite number, got ${String(toMs)}`);
  }
  testOffsetMs = toMs - Date.now();
  return toMs;
}
