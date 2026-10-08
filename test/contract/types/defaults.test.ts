// §15 user answers encoded as defaults (I-09), and the §3.4 lane table.
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CAPS,
  DEFAULT_FAVORITE_WITHIN_HOURS,
  DEFAULT_SETTINGS,
  DEFAULT_WATCH_FAVORITE_MODE,
} from '../../../src/domain/settings/defaults';
import { SettingsSchema } from '../../../src/domain/settings/schema';
import { DEFAULT_LANES } from '../../../src/domain/types';
import { WatchSchema } from '../../../src/domain/watches/schema';

describe('Settings defaults', () => {
  it('parse against SettingsSchema unchanged', () => {
    expect(SettingsSchema.parse(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it('encode the §15 Q3 spend caps: $50 per item, $100 per day, $200 open exposure', () => {
    expect(DEFAULT_SETTINGS.snipe.caps.perItemMax).toBe(5000);
    expect(DEFAULT_SETTINGS.snipe.caps.perDayMax).toBe(10000);
    expect(DEFAULT_SETTINGS.snipe.caps.openExposureMax).toBe(20000);
    expect(DEFAULT_SETTINGS.snipe.caps.typoMultiplier).toBe(3);
    expect(DEFAULT_SETTINGS.snipe.caps).toEqual(DEFAULT_CAPS);
  });

  it('require 5 dry runs before live bidding (§1.8, I-25) and start with none completed', () => {
    expect(DEFAULT_SETTINGS.snipe.requiredDryRuns).toBe(5);
    expect(DEFAULT_SETTINGS.snipe.completedDryRuns).toBe(0);
  });

  it('keep every automation in dry-run (§1.8) with the kill switch off', () => {
    expect(DEFAULT_SETTINGS.dryRun).toEqual({ favorites: true, calendar: true, bidding: true });
    expect(DEFAULT_SETTINGS.killSwitch).toBe(false);
  });

  it('run daily at 07:00 Eastern with catch-up (§15 Q7, §1.2)', () => {
    expect(DEFAULT_SETTINGS.dailyRun).toEqual({ enabled: true, localTime: '07:00', catchUp: true });
    expect(DEFAULT_SETTINGS.locale.timeZone).toBe('America/New_York');
  });

  it('use the §3.9 snipe defaults: 8 s lead, early-proxy fallback, sniping off', () => {
    expect(DEFAULT_SETTINGS.snipe.defaultLeadMs).toBe(8000);
    expect(DEFAULT_SETTINGS.snipe.defaultFallback).toBe('early-proxy');
    expect(DEFAULT_SETTINGS.snipe.enabled).toBe(false);
  });

  it('use the §3.8 reminders [60, 15, 5] on a dedicated calendar', () => {
    expect(DEFAULT_SETTINGS.calendar.reminders).toEqual([60, 15, 5]);
    expect(DEFAULT_SETTINGS.calendar.mode).toBe('dedicated');
  });

  it('leave ntfy off (§15 Q10)', () => {
    expect(DEFAULT_SETTINGS.ntfy).toBeUndefined();
  });

  it('are deeply frozen, so no consumer can change the shared defaults', () => {
    expect(Object.isFrozen(DEFAULT_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.snipe.caps)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SETTINGS.calendar.reminders)).toBe(true);
    expect(() => {
      (DEFAULT_SETTINGS.dryRun as { bidding: boolean }).bidding = false;
    }).toThrow(TypeError);
  });

  it('reject a Settings record of another schema version', () => {
    expect(SettingsSchema.safeParse({ ...DEFAULT_SETTINGS, schemaVersion: 2 }).success).toBe(false);
  });
});

describe('Watch defaults', () => {
  const newWatch = {
    id: 'w-1',
    name: 'Pyrex',
    enabled: true,
    query: { searchText: 'pyrex', categoryIds: [], sellerIds: [], page: 1 },
    ruleIds: [],
    maxPages: 1,
    calendar: false,
    notify: true,
    nextRunAt: 1791428400000,
    seenItemIds: [],
  };

  it("defaults a new watch to favoriteMode 'sgw' (§15 Q5, I-09)", () => {
    expect(DEFAULT_WATCH_FAVORITE_MODE).toBe('sgw');
    expect(WatchSchema.parse(newWatch).favoriteMode).toBe('sgw');
  });

  it('keeps an explicit favoriteMode', () => {
    expect(WatchSchema.parse({ ...newWatch, favoriteMode: 'local' }).favoriteMode).toBe('local');
  });

  it('documents the sgw-late window default of 6 hours (§1.8)', () => {
    expect(DEFAULT_FAVORITE_WITHIN_HOURS).toBe(6);
  });
});

describe('DEFAULT_LANES', () => {
  it('equals the §3.4 table', () => {
    expect(DEFAULT_LANES).toEqual({
      interactive: { minIntervalMs: 1000, jitterMs: 300, maxConcurrent: 1, dailyBudget: 300 },
      background: { minIntervalMs: 120000, jitterMs: 15000, maxConcurrent: 1, dailyBudget: 120 },
      snipe: { minIntervalMs: 1000, jitterMs: 0, maxConcurrent: 1, dailyBudget: 80 },
      canary: { minIntervalMs: 120000, jitterMs: 0, maxConcurrent: 1, dailyBudget: 4 },
    });
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DEFAULT_LANES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_LANES.background)).toBe(true);
  });
});
