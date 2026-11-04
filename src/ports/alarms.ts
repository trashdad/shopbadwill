// Contract v1 (T-02): PLAN §3.2 Alarms port. Implemented by T-34
// (src/adapters/browser/alarms.ts); FakeAlarms by T-03.
import type { EpochMs } from '../domain/types';

export interface AlarmInfo {
  name: string;
  scheduledTime: EpochMs;
  periodInMinutes?: number;
}

export interface Alarms {
  /** Implementations and FakeAlarms MUST clamp delay/period to >= 0.5 min and MAY add up to 60 s delay. */
  create(name: string, opts: { when?: EpochMs; delayInMinutes?: number; periodInMinutes?: number }): Promise<void>;
  clear(name: string): Promise<boolean>;
  getAll(): Promise<AlarmInfo[]>;
  /** Returns an unsubscribe function. */
  onAlarm(cb: (alarm: AlarmInfo) => void): () => void;
}
