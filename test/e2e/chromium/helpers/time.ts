// Time constants for the Chromium E2E specs (T-59). The daily job's spacing
// comes from PLAN §3.4: the `background` lane waits `minIntervalMs` (120 s)
// plus 0..`jitterMs` (15 s) between requests, measured on BOTH the wall and
// the monotonic clock (src/adapters/sgw/request-scheduler.ts). The E2E
// fast-forwards the Clock port through `sbw:test:advance` (fake time, never
// real sleeps: test-strategy §7.4), so nothing here depends on real elapsed
// time.
export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

/**
 * How much fake time to advance between two ticks. The background lane's
 * 120 s interval plus its maximum 15 s jitter, so the next request is always
 * legal the moment the tick runs, and every pair of requests is at least
 * 120 s apart in fake time (the considerate-use assertion, T-59 R4).
 */
export const TICK_STEP_MS = 120 * SEC + 15 * SEC;
