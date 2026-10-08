import type { EpochMs } from '../../domain/types';
import type { Clock } from '../../ports/clock';

/** Clock over Date, performance and setTimeout. Background context only. */
export class BrowserClock implements Clock {
  now(): EpochMs {
    return Date.now();
  }

  monotonic(): number {
    return performance.now();
  }

  setTimeout(fn: () => void, ms: number): number {
    // Node returns a Timeout object; Number() yields its numeric id.
    return Number(globalThis.setTimeout(fn, ms));
  }

  clearTimeout(id: number): void {
    globalThis.clearTimeout(id);
  }
}
