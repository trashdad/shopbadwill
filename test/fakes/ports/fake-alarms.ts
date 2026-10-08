import type { EpochMs } from '../../../src/domain/types';
import type { AlarmInfo, Alarms } from '../../../src/ports/alarms';
import type { FakeClock } from './fake-clock';

/** Production floor: Chrome and Firefox enforce 30 s in packed builds. */
export const MIN_ALARM_MINUTES = 0.5;
/** The port allows an implementation to add up to this much delay. */
export const MAX_EXTRA_DELAY_MS = 60_000;

/** Clamps a delay/period to the production floor. `clamped` tells the caller to record a warning. */
export function clampMinutes(minutes: number): { value: number; clamped: boolean } {
  return minutes < MIN_ALARM_MINUTES ? { value: MIN_ALARM_MINUTES, clamped: true } : { value: minutes, clamped: false };
}

interface Entry {
  name: string;
  /** Nominal time, what AlarmInfo.scheduledTime reports. */
  scheduledTime: number;
  /** When this occurrence fires: scheduledTime plus the extra delay drawn at scheduling time. */
  fireAt: number;
  periodMs: number | undefined;
}

export interface FakeAlarmsOptions {
  /** Extra delay on each occurrence, clamped to 0..60 s, drawn when it is scheduled. A function is called per occurrence. Default 0. */
  extraDelayMs?: number | (() => number);
}

/** Alarms with the production 30 s floor and an injectable firing delay. Driven by `advance`. */
export class FakeAlarms implements Alarms {
  /** One message per clamp, for assertions. */
  readonly warnings: string[] = [];
  extraDelayMs: number | (() => number);
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<(a: AlarmInfo) => void>();

  constructor(
    private readonly clock: FakeClock,
    opts: FakeAlarmsOptions = {},
  ) {
    this.extraDelayMs = opts.extraDelayMs ?? 0;
  }

  create(name: string, opts: { when?: EpochMs; delayInMinutes?: number; periodInMinutes?: number }): Promise<void> {
    let delayMs: number | undefined;
    if (opts.delayInMinutes !== undefined) {
      const { value, clamped } = clampMinutes(opts.delayInMinutes);
      if (clamped) this.warnings.push(`alarm "${name}": delayInMinutes ${String(opts.delayInMinutes)} clamped to ${String(MIN_ALARM_MINUTES)}`);
      delayMs = value * 60_000;
    }
    let periodMs: number | undefined;
    if (opts.periodInMinutes !== undefined) {
      const { value, clamped } = clampMinutes(opts.periodInMinutes);
      if (clamped) this.warnings.push(`alarm "${name}": periodInMinutes ${String(opts.periodInMinutes)} clamped to ${String(MIN_ALARM_MINUTES)}`);
      periodMs = value * 60_000;
    }
    const scheduledTime = opts.when ?? this.clock.now() + (delayMs ?? periodMs ?? 0);
    this.entries.set(name, { name, scheduledTime, fireAt: scheduledTime + this.drawExtra(), periodMs });
    return Promise.resolve();
  }

  clear(name: string): Promise<boolean> {
    return Promise.resolve(this.entries.delete(name));
  }

  getAll(): Promise<AlarmInfo[]> {
    return Promise.resolve([...this.entries.values()].map(toInfo));
  }

  onAlarm(cb: (alarm: AlarmInfo) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /**
   * Advances the clock by `ms` and fires every alarm that falls due (nominal
   * time plus the extra delay), in order, with the clock set to each firing
   * time. Periodic alarms repeat; one-shot alarms are removed.
   */
  advance(ms: number): void {
    const target = this.clock.now() + ms;
    for (;;) {
      let next: Entry | undefined;
      for (const entry of this.entries.values()) {
        if (entry.fireAt <= target && (next === undefined || entry.fireAt < next.fireAt)) next = entry;
      }
      if (next === undefined) break;
      this.clock.advance(Math.max(0, next.fireAt - this.clock.now()));
      const info = toInfo(next);
      if (next.periodMs === undefined) {
        this.entries.delete(next.name);
      } else {
        next.scheduledTime += next.periodMs;
        next.fireAt = next.scheduledTime + this.drawExtra();
      }
      for (const cb of [...this.listeners]) cb(info);
    }
    this.clock.advance(Math.max(0, target - this.clock.now()));
  }

  /** The extra delay is drawn once per occurrence, when it is scheduled. */
  private drawExtra(): number {
    const raw = typeof this.extraDelayMs === 'function' ? this.extraDelayMs() : this.extraDelayMs;
    return Math.min(MAX_EXTRA_DELAY_MS, Math.max(0, raw));
  }
}

function toInfo(e: Entry): AlarmInfo {
  return e.periodMs === undefined
    ? { name: e.name, scheduledTime: e.scheduledTime }
    : { name: e.name, scheduledTime: e.scheduledTime, periodInMinutes: e.periodMs / 60_000 };
}
