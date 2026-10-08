// Contract v1 (T-02): default values. §15 user answers are binding (I-09):
// caps $50 / $100 / $200 (Q3), 5 required dry runs (§1.8), favoriteMode 'sgw'
// for new watches (Q5), America/New_York with a 07:00 daily run (Q7), ntfy off
// (Q10). Readers (T-33, T-82, T-102, …) import these and never edit them.
//
// The values are deeply frozen: copy before changing (structuredClone).
import type { CapsCheck } from '../snipe/types';
import type { FavoriteMode } from '../watches/schema';
import type { Settings } from './schema';

function freezeDeep<T>(value: T): Readonly<T> {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}

/** §15 Q3: $50 per item, $100 per day, $200 total open exposure; typo guard at 3× current or $25. */
export const DEFAULT_CAPS: Readonly<CapsCheck> = freezeDeep({
  perItemMax: 5000,
  perDayMax: 10000,
  openExposureMax: 20000,
  typoMultiplier: 3,
  typoAbsolute: 2500,
});

/** The `Watch` schema default (§15 Q5, I-09): favorite on SGW immediately. */
export const DEFAULT_WATCH_FAVORITE_MODE = 'sgw' satisfies FavoriteMode;

/** `Watch.favoriteWithinHours` when `favoriteMode` is 'sgw-late' and the field is absent (§1.8). */
export const DEFAULT_FAVORITE_WITHIN_HOURS = 6;

export const DEFAULT_SETTINGS: Readonly<Settings> = freezeDeep({
  schemaVersion: 1,
  // §15 Q7. The composition root may replace it with the detected zone.
  locale: { timeZone: 'America/New_York' },
  dailyRun: { enabled: true, localTime: '07:00', catchUp: true },
  overlay: { enabled: true, hideStyle: 'collapse', quickFavorite: false, landedCostBadges: true, countdown: true },
  dryRun: { favorites: true, calendar: true, bidding: true },
  considerateMode: 'normal',
  // Features that spend SGW requests start off (§9); comps and relist are Phase 6.
  features: { landedCost: false, comps: false, countdownRefresh: false, relistDetector: false },
  // Off until Google is connected; the .ics fallback stays available (T-71).
  calendar: { enabled: false, mode: 'dedicated', reminders: [60, 15, 5], icsFallback: true },
  notifications: { enabled: true, digest: true },
  snipe: {
    enabled: false,
    defaultLeadMs: 8000,
    defaultFallback: 'early-proxy',
    caps: DEFAULT_CAPS,
    keepAlive: true,
    requiredDryRuns: 5,
    completedDryRuns: 0,
    tier: 'T0',
  },
  killSwitch: false,
});
