// Contract v1 (T-02): PLAN §3.2 Clock port. Implemented by T-34
// (src/adapters/browser/clock.ts); FakeClock by T-03.
import type { EpochMs } from '../domain/types';

export interface Clock {
  /** Wall clock. */
  now(): EpochMs;
  /** performance.now() */
  monotonic(): number;
  /** Tight timer; background context only. */
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
}
