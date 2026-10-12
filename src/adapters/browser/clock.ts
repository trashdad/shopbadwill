// Clock over Date, performance and setTimeout. Background context only.
//
// T-59 time-travel seam: in a TEST build (`import.meta.env.SBW_TEST`, the
// literal `false` in production) a shared offset is added to both `now()` and
// `monotonic()`, so the RequestScheduler's two-clock gap check
// (src/adapters/sgw/request-scheduler.ts) fast-forwards with the test's
// `sbw:test:advance` hook. Clock timers fast-forward too: each one also
// records its deadline in fake time, and the hook fires the ones it passed
// (`fireDueTestTimers`), so a RequestScheduler gap wait ends when fake time
// says so; a timer nobody fast-forwards still fires on real time. The offset is set only by src/test-hooks/advance.ts
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
    if (import.meta.env.SBW_TEST) return setTrackedTimer(fn, ms);
    // Node returns a Timeout object; Number() yields its numeric id.
    return Number(globalThis.setTimeout(fn, ms));
  }

  clearTimeout(id: number): void {
    if (import.meta.env.SBW_TEST) testTimers.delete(id);
    globalThis.clearTimeout(id);
  }
}

/** SBW_TEST only: pending Clock timers by id, with their deadline in fake time. */
const testTimers = new Map<number, { fn: () => void; dueAt: EpochMs }>();

function setTrackedTimer(fn: () => void, ms: number): number {
  const dueAt = testClockNow() + Math.max(0, ms);
  const id = Number(
    globalThis.setTimeout(() => {
      testTimers.delete(id);
      fn();
    }, ms),
  );
  testTimers.set(id, { fn, dueAt });
  return id;
}

/**
 * SBW_TEST only: fires (soonest first) every pending Clock timer whose fake
 * deadline is at or before `now`, cancelling its real-time twin. Returns how
 * many fired. In production nothing is tracked, so it returns 0.
 */
export function fireDueTestTimers(now: EpochMs): number {
  if (!import.meta.env.SBW_TEST) return 0;
  const due = [...testTimers.entries()].filter(([, t]) => t.dueAt <= now).sort((a, b) => a[1].dueAt - b[1].dueAt);
  let fired = 0;
  for (const [id, t] of due) {
    if (!testTimers.delete(id)) continue; // an earlier timer cleared it
    globalThis.clearTimeout(id);
    fired++;
    t.fn();
  }
  return fired;
}

/** SBW_TEST only: the pending Clock timers' fake deadlines, soonest first (empty in production). */
export function pendingTestTimers(): EpochMs[] {
  if (!import.meta.env.SBW_TEST) return [];
  return [...testTimers.values()].map((t) => t.dueAt).sort((a, b) => a - b);
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
