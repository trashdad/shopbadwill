import { browser } from 'wxt/browser';
import type { EpochMs } from '../../domain/types';
import type { AlarmInfo, Alarms } from '../../ports/alarms';
import { testClockNow } from './clock';
import { isFirefox } from './env';

export const MIN_ALARM_MINUTES = 0.5;
const PERSIST_MIN_CHROME_MAJOR = 150;

/**
 * Whether alarms.create accepts `persistAcrossSessions` (Chrome 150+). Firefox
 * rejects unknown properties, so it is never passed there.
 */
export function detectPersistSupport(): boolean {
  if (isFirefox()) return false;
  if (typeof navigator === 'undefined') return false;
  const m = /Chrome\/(\d+)/.exec(navigator.userAgent);
  return m?.[1] !== undefined && Number(m[1]) >= PERSIST_MIN_CHROME_MAJOR;
}

export interface BrowserAlarmsOptions {
  /** Override detection (tests simulate the schema). */
  supportsPersist?: boolean;
}

const clamp = (minutes: number): number => Math.max(minutes, MIN_ALARM_MINUTES);

function toInfo(a: { name: string; scheduledTime: number; periodInMinutes?: number | undefined }): AlarmInfo {
  const info: AlarmInfo = { name: a.name, scheduledTime: a.scheduledTime };
  if (a.periodInMinutes !== undefined) info.periodInMinutes = a.periodInMinutes;
  return info;
}

// ── T-59: the test-build fake-alarm registry ────────────────────────────────
//
// In a TEST build the browser alarm API is never touched: alarms are tracked
// here in fake time (the Clock seam's `testClockNow`) and fired by the
// `sbw:test:advance` hook (due alarms) and the `sbw:test:fireAlarm` hook (one
// alarm by name). This keeps real 30 s-floor alarms from firing in real time
// during an E2E run and lets the spec drive `sbw:tick` deterministically.
// Only the hooks below call the fire helpers, so production tree-shakes the
// whole registry (`pnpm check:prod-bundle` verifies nothing leaks).

interface TestAlarm {
  name: string;
  scheduledTime: EpochMs;
  periodMs: number | undefined;
}

const testAlarms = new Map<string, TestAlarm>();
const testListeners = new Set<(a: AlarmInfo) => void>();

function createTestAlarm(name: string, opts: { when?: EpochMs; delayInMinutes?: number; periodInMinutes?: number }): void {
  const delayMs = opts.delayInMinutes !== undefined ? clamp(opts.delayInMinutes) * 60_000 : undefined;
  const periodMs = opts.periodInMinutes !== undefined ? clamp(opts.periodInMinutes) * 60_000 : undefined;
  const scheduledTime = opts.when ?? testClockNow() + (delayMs ?? periodMs ?? 0);
  testAlarms.set(name, { name, scheduledTime, periodMs });
}

function testToInfo(e: TestAlarm): AlarmInfo {
  return e.periodMs === undefined
    ? { name: e.name, scheduledTime: e.scheduledTime }
    : { name: e.name, scheduledTime: e.scheduledTime, periodInMinutes: e.periodMs / 60_000 };
}

function deliverTestAlarm(info: AlarmInfo): void {
  for (const cb of [...testListeners]) cb(info);
}

/** Every test-build alarm, for the `sbw:test:state` hook (the browser alarm API holds none in a test build). */
export function listTestAlarms(): AlarmInfo[] {
  return [...testAlarms.values()].map(testToInfo);
}

/** Fires one alarm by name now, whatever its scheduledTime. Throws when it does not exist. */
export function fireTestAlarm(name: string): AlarmInfo {
  const entry = testAlarms.get(name);
  if (entry === undefined) {
    const known = [...testAlarms.keys()].map((n) => `"${n}"`).join(', ');
    throw new Error(`no test alarm named "${name}" (created: ${known === '' ? 'none' : known})`);
  }
  const info = testToInfo(entry);
  if (entry.periodMs === undefined) testAlarms.delete(entry.name);
  else entry.scheduledTime += entry.periodMs;
  deliverTestAlarm(info);
  return info;
}

/** Fires every alarm due at `now` (soonest first); periodic alarms are rescheduled and may fire again. */
export function fireDueTestAlarms(now: EpochMs): AlarmInfo[] {
  const fired: AlarmInfo[] = [];
  for (;;) {
    let next: TestAlarm | undefined;
    for (const entry of testAlarms.values()) {
      if (entry.scheduledTime > now) continue;
      if (next === undefined || entry.scheduledTime < next.scheduledTime) next = entry;
    }
    if (next === undefined) return fired;
    const info = testToInfo(next);
    fired.push(info);
    if (next.periodMs === undefined) testAlarms.delete(next.name);
    else next.scheduledTime += next.periodMs;
    deliverTestAlarm(info);
  }
}

export class BrowserAlarms implements Alarms {
  private readonly persist: boolean;

  constructor(opts: BrowserAlarmsOptions = {}) {
    this.persist = opts.supportsPersist ?? detectPersistSupport();
  }

  async create(
    name: string,
    opts: { when?: EpochMs; delayInMinutes?: number; periodInMinutes?: number },
  ): Promise<void> {
    if (import.meta.env.SBW_TEST) {
      createTestAlarm(name, opts);
      return;
    }
    const info: { when?: number; delayInMinutes?: number; periodInMinutes?: number; persistAcrossSessions?: boolean } =
      {};
    if (opts.when !== undefined) info.when = opts.when;
    if (opts.delayInMinutes !== undefined) info.delayInMinutes = clamp(opts.delayInMinutes);
    if (opts.periodInMinutes !== undefined) info.periodInMinutes = clamp(opts.periodInMinutes);
    if (this.persist) info.persistAcrossSessions = true;
    try {
      await browser.alarms.create(name, info as never);
    } catch (err) {
      if (!this.persist) throw err;
      // Detection said yes but the browser disagreed: retry without the property.
      delete info.persistAcrossSessions;
      await browser.alarms.create(name, info as never);
    }
  }

  clear(name: string): Promise<boolean> {
    if (import.meta.env.SBW_TEST) return Promise.resolve(testAlarms.delete(name));
    return browser.alarms.clear(name);
  }

  async getAll(): Promise<AlarmInfo[]> {
    if (import.meta.env.SBW_TEST) return [...testAlarms.values()].map(testToInfo);
    return (await browser.alarms.getAll()).map(toInfo);
  }

  onAlarm(cb: (alarm: AlarmInfo) => void): () => void {
    if (import.meta.env.SBW_TEST) {
      testListeners.add(cb);
      return () => {
        testListeners.delete(cb);
      };
    }
    const listener = (a: { name: string; scheduledTime: number; periodInMinutes?: number | undefined }): void => {
      cb(toInfo(a));
    };
    browser.alarms.onAlarm.addListener(listener);
    return () => {
      browser.alarms.onAlarm.removeListener(listener);
    };
  }
}
