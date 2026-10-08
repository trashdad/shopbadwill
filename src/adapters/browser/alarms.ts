import { browser } from 'wxt/browser';
import type { EpochMs } from '../../domain/types';
import type { AlarmInfo, Alarms } from '../../ports/alarms';
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

export class BrowserAlarms implements Alarms {
  private readonly persist: boolean;

  constructor(opts: BrowserAlarmsOptions = {}) {
    this.persist = opts.supportsPersist ?? detectPersistSupport();
  }

  async create(
    name: string,
    opts: { when?: EpochMs; delayInMinutes?: number; periodInMinutes?: number },
  ): Promise<void> {
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
    return browser.alarms.clear(name);
  }

  async getAll(): Promise<AlarmInfo[]> {
    return (await browser.alarms.getAll()).map(toInfo);
  }

  onAlarm(cb: (alarm: AlarmInfo) => void): () => void {
    const listener = (a: { name: string; scheduledTime: number; periodInMinutes?: number | undefined }): void => {
      cb(toInfo(a));
    };
    browser.alarms.onAlarm.addListener(listener);
    return () => {
      browser.alarms.onAlarm.removeListener(listener);
    };
  }
}
