import type { EpochMs } from '../../../src/domain/types';
import type { AlarmInfo, Alarms } from '../../../src/ports/alarms';
import type { ClockSource, FakeClock } from './fake-clock';

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

/** Alarms with the production 30 s floor and an injectable firing delay. Driven by the shared FakeClock (`clock.advance` or the `advance` alias). */
export class FakeAlarms implements Alarms, ClockSource {
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
    clock.addSource(this);
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

  /** Alias for `clock.advance(ms)`: alarms fire from the clock, interleaved with its timers. */
  advance(ms: number): void {
    this.clock.advance(ms);
  }

  nextDue(): number | undefined {
    let min: number | undefined;
    for (const e of this.entries.values()) if (min === undefined || e.fireAt < min) min = e.fireAt;
    return min;
  }

  /** Fires the earliest due alarm (called by the clock with time already at its firing time). */
  fireNext(): void {
    let next: Entry | undefined;
    for (const entry of this.entries.values()) if (next === undefined || entry.fireAt < next.fireAt) next = entry;
    if (next === undefined) return;
    const info = toInfo(next);
    if (next.periodMs === undefined) {
      this.entries.delete(next.name);
    } else {
      next.scheduledTime += next.periodMs;
      next.fireAt = next.scheduledTime + this.drawExtra();
    }
    for (const cb of [...this.listeners]) cb(info);
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
