// T-82: spending guards for the snipe engine. Pure domain code, integer cents.
// `checkCaps` implements the frozen `CheckCaps` type (it only adds an optional
// trailing `detail`), `exposure` totals the open commitments, and `spentToday`
// is the only per-day accumulation (T-103 reuses it). The typo guard is
// money.ts `exceedsTypo`; it is not re-implemented here.
import { exceedsTypo, formatMoney } from '../money';
import type { Cents, ItemDetail } from '../types';
import type { CapsCheck, CapsResult, Snipe } from './types';

/** The user's day for the per-day cap (§15 Q7). Callers pass `settings.locale.timeZone`. */
export const DEFAULT_TIME_ZONE = 'America/New_York';

export interface Exposure {
  /** Sum of armed maxes plus known estimated shipping and handling. */
  total: Cents;
  /** True when any counted snipe has no shipping estimate: its max was counted alone. */
  shippingUnknown: boolean;
  /** Number of snipes counted. */
  count: number;
}

/**
 * States in which a snipe can still become a purchase. Everything from `armed`
 * up to `sent` counts as a potential win; drafts and finished snipes do not.
 */
const OPEN_STATES: ReadonlySet<Snipe['state']> = new Set([
  'armed',
  'fallback-applied',
  'waking',
  'verified',
  'firing',
  'sent',
]);

/** Max bid plus the shipping and handling estimates that are known. */
function landed(s: Snipe): Cents {
  return s.maxBid + (s.estShipping ?? 0) + (s.estHandling ?? 0);
}

/** A dry-run snipe never places a bid, so it is no exposure. */
function isOpen(s: Snipe): boolean {
  return !s.dryRun && OPEN_STATES.has(s.state);
}

/**
 * Open exposure: every armed snipe counts as a potential win (sum of maxes plus
 * estimated shipping and handling). With no shipping estimate the max is counted
 * alone and `shippingUnknown` is set so the UI can say so. A missing handling
 * estimate is treated as zero (handling is often legitimately absent).
 */
export function exposure(snipes: readonly Snipe[]): Exposure {
  let total = 0;
  let count = 0;
  let shippingUnknown = false;
  for (const s of snipes) {
    if (!isOpen(s)) continue;
    total += landed(s);
    count += 1;
    if (s.estShipping === undefined) shippingUnknown = true;
  }
  return { total, shippingUnknown, count };
}

/**
 * Checks one snipe against the caps. Violations are strings starting with the
 * kind: `per-item`, `per-day`, `exposure` or `typo`. The result never throws on
 * a violation, but a malformed cap (e.g. a negative `typoAbsolute`) throws
 * `RangeError` from `exceedsTypo` rather than silently disabling a guard.
 *
 * `detail` (optional) is the latest ItemDetail: its `minimumBid` is the next
 * acceptable bid (the search row's `startingMinimumBid` is never used) and its
 * `currentPrice` feeds the typo guard. Without it only the absolute typo
 * threshold applies. Monotone in `maxBid`: raising it never removes a violation.
 */
export function checkCaps(
  s: Snipe,
  others: readonly Snipe[],
  spentToday: Cents,
  caps: CapsCheck,
  detail?: ItemDetail,
): CapsResult {
  const violations: string[] = [];

  // Per item: what we would pay is at least the next acceptable bid.
  const itemCost = Math.max(s.maxBid, detail?.minimumBid ?? 0);
  if (itemCost > caps.perItemMax) {
    violations.push(`per-item: ${formatMoney(itemCost)} exceeds the ${formatMoney(caps.perItemMax)} per-item cap`);
  }

  // Per day: already spent today plus this snipe if it wins.
  const dayTotal = spentToday + landed(s);
  if (dayTotal > caps.perDayMax) {
    violations.push(`per-day: ${formatMoney(dayTotal)} would exceed the ${formatMoney(caps.perDayMax)} daily cap`);
  }

  // Open exposure: this snipe (whatever its state; it is being armed) plus every
  // other open snipe (never itself, by id).
  const rest = exposure(others.filter((o) => o.id !== s.id));
  const openTotal = rest.total + landed(s);
  if (openTotal > caps.openExposureMax) {
    violations.push(
      `exposure: ${formatMoney(openTotal)} across ${String(rest.count + 1)} armed snipes exceeds the ${formatMoney(caps.openExposureMax)} cap`,
    );
  }

  if (exceedsTypo(s.maxBid, detail?.currentPrice ?? 0, caps.typoMultiplier, caps.typoAbsolute)) {
    violations.push(
      `typo: ${formatMoney(s.maxBid)} is above the typo guard (3x the current price or ${formatMoney(caps.typoAbsolute)})`,
    );
  }

  return { ok: violations.length === 0, violations };
}

// ── Spent today ─────────────────────────────────────────────────────────────

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** "YYYY-MM-DD" of the calendar day containing `ms` in `timeZone`. */
export function localDayKey(ms: number, timeZone: string): string {
  let f = dayFormatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dayFormatters.set(timeZone, f);
  }
  const part = (type: string): string => f.formatToParts(ms).find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

/** When the snipe's outcome was recorded: its `resolved` transition, else its last transition, else armedAt. */
function resolvedAt(s: Snipe): number {
  for (let i = s.history.length - 1; i >= 0; i--) {
    const h = s.history[i];
    if (h?.to === 'resolved') return h.at;
  }
  return s.history[s.history.length - 1]?.at ?? s.armedAt;
}

/**
 * Money committed today, in the user's local day. Counts real (non-dry-run)
 * snipes whose outcome is `won`, or `fallback-proxy-placed` (a proxy bid that
 * can still win), resolved on the local day of `nowMs`. Each counts at its
 * ceiling (max bid plus known shipping and handling): the actual final price
 * is not stored on the snipe, and overcounting only makes the guard stricter.
 */
export function spentToday(snipes: readonly Snipe[], nowMs: number, timeZone: string = DEFAULT_TIME_ZONE): Cents {
  const today = localDayKey(nowMs, timeZone);
  let total = 0;
  for (const s of snipes) {
    if (s.dryRun) continue;
    if (s.outcome !== 'won' && s.outcome !== 'fallback-proxy-placed') continue;
    if (localDayKey(resolvedAt(s), timeZone) === today) total += landed(s);
  }
  return total;
}
