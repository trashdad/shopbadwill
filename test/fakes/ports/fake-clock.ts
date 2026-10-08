import type { Clock } from '../../../src/ports/clock';
import type { EpochMs } from '../../../src/domain/types';

interface Timer {
  id: number;
  at: number;
  seq: number;
  fn: () => void;
}

/**
 * Deterministic Clock. Time moves only through `advance` / `set`. `setTimeout`
 * timers fire in (time, creation) order; timers scheduled by a firing timer
 * run in the same `advance` call if they fall inside the window.
 */
export class FakeClock implements Clock {
  private wall: number;
  private mono = 0;
  private nextId = 1;
  private nextSeq = 0;
  private readonly timers = new Map<number, Timer>();

  constructor(startMs: EpochMs = 1_700_000_000_000) {
    this.wall = startMs;
  }

  now(): EpochMs {
    return this.wall;
  }

  monotonic(): number {
    return this.mono;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.nextId++;
    this.timers.set(id, { id, at: this.mono + Math.max(0, ms), seq: this.nextSeq++, fn });
    return id;
  }

  clearTimeout(id: number): void {
    this.timers.delete(id);
  }

  /** Number of timers not yet fired or cleared. */
  get pendingTimers(): number {
    return this.timers.size;
  }

  /** Moves wall and monotonic time forward by `ms`, firing due timers in order. */
  advance(ms: number): void {
    if (ms < 0) throw new RangeError('FakeClock.advance: ms must be >= 0');
    const target = this.mono + ms;
    for (;;) {
      let next: Timer | undefined;
      for (const t of this.timers.values()) {
        if (t.at <= target && (next === undefined || t.at < next.at || (t.at === next.at && t.seq < next.seq))) next = t;
      }
      if (next === undefined) break;
      this.timers.delete(next.id);
      this.step(next.at);
      next.fn();
    }
    this.step(target);
  }

  /** Jumps the wall clock only (e.g. a user changing the system time); timers use monotonic time and are unaffected. */
  set(wallMs: EpochMs): void {
    this.wall = wallMs;
  }

  private step(monoTarget: number): void {
    this.wall += monoTarget - this.mono;
    this.mono = monoTarget;
  }
}
