import type { KeepAwake } from '../../../src/ports/keep-awake';

export class FakeKeepAwake implements KeepAwake {
  readonly available: boolean;
  /** Reasons passed to hold(), in order. */
  readonly holds: string[] = [];
  releases = 0;
  private held = false;

  constructor(opts: { available?: boolean } = {}) {
    this.available = opts.available ?? true;
  }

  /** True between a hold() and the next release(); always false when unavailable (the real one is a no-op). */
  get isHeld(): boolean {
    return this.held;
  }

  hold(reason: string): Promise<void> {
    this.holds.push(reason);
    if (this.available) this.held = true;
    return Promise.resolve();
  }

  release(): Promise<void> {
    this.releases += 1;
    this.held = false;
    return Promise.resolve();
  }
}
