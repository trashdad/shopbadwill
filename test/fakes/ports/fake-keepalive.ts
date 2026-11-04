import type { KeepAlive } from '../../../src/ports/keep-alive';
import type { FakeClock } from './fake-clock';

/** Records start/stop; with a FakeClock it also "pings" every interval so tests can count them. */
export class FakeKeepAlive implements KeepAlive {
  readonly starts: number[] = [];
  stops = 0;
  pings = 0;
  private timer: number | undefined;
  private active = false;

  constructor(private readonly clock?: FakeClock) {}

  get running(): boolean {
    return this.active;
  }

  start(intervalMs: number): void {
    this.stopTimer();
    this.starts.push(intervalMs);
    this.active = true;
    const clock = this.clock;
    if (clock === undefined) return;
    const tick = (): void => {
      this.pings += 1;
      this.timer = clock.setTimeout(tick, intervalMs);
    };
    this.timer = clock.setTimeout(tick, intervalMs);
  }

  stop(): void {
    this.stops += 1;
    this.active = false;
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer !== undefined) this.clock?.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
