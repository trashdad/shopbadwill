// T-82: spending guards for the snipe engine. Pure domain code, integer cents.
// `checkCaps` implements the frozen `CheckCaps` type (it only adds an optional
// trailing `detail`), `exposure` totals the open commitments, and `spentToday`
// is the only per-day accumulation (T-103 reuses it). `typoCheck` wraps
// money.ts `exceedsTypo` (not re-implemented here).
import { exceedsTypo, formatMoney, parseCents } from '../money';
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
  // Negative estimates can never reduce what we count.
  return s.maxBid + Math.max(0, s.estShipping ?? 0) + Math.max(0, s.estHandling ?? 0);
}

/** In-flight states that are committed right now (the bid is being or has been placed). */
const COMMITTED_STATES: ReadonlySet<Snipe['state']> = new Set(['verified', 'firing', 'sent']);

function isCents(n: number | undefined): boolean {
  return n === undefined || (Number.isSafeInteger(n) && n >= 0);
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
 * kind: `per-item`, `per-day`, `exposure` or `invalid`. The typo guard is NOT a
 * cap: see `typoCheck`.
 *
 * `detail` is the latest ItemDetail. Its `minimumBid` is the next acceptable
 * bid (the search row's `startingMinimumBid` is never used). Without it the
 * check FAILS CLOSED with a `per-item` violation, so the runner must read the
 * detail (it does at T-60) before firing.
 *
 * The day total is `spentToday` (resolved outcomes) plus this snipe plus every
 * OTHER committed in-flight snipe (verified, firing, sent; non-dry-run) ending
 * on the same local day (`timeZone`), so concurrent snipes cannot each pass a
 * cap the group would break. Bad inputs (negative or non-integer cents) return
 * an `invalid` violation instead of throwing. Monotone in `maxBid`: raising it
 * never removes a violation.
 */
export function checkCaps(
  s: Snipe,
  others: readonly Snipe[],
  spentToday: Cents,
  caps: CapsCheck,
  detail?: ItemDetail,
  timeZone: string = DEFAULT_TIME_ZONE,
): CapsResult {
  if (!isCents(s.maxBid) || !isCents(s.estShipping) || !isCents(s.estHandling) || !isCents(spentToday)) {
    return { ok: false, violations: ['invalid: maxBid, shipping, handling and spent-today must be whole cents >= 0'] };
  }
  const violations: string[] = [];

  // Per item: what we would pay is at least the next acceptable bid.
  if (detail === undefined) {
    violations.push('per-item: item detail required (next acceptable bid unknown)');
  } else {
    const itemCost = Math.max(s.maxBid, detail.minimumBid);
    if (itemCost > caps.perItemMax) {
      violations.push(`per-item: ${formatMoney(itemCost)} exceeds the ${formatMoney(caps.perItemMax)} per-item cap`);
    }
  }

  // Per day: resolved spend today, this snipe, and other committed in-flight snipes that day.
  const dayKey = localDayKey(new Date(s.endTime).getTime(), timeZone);
  const inFlight = others
    .filter(
      (o) =>
        o.id !== s.id &&
        !o.dryRun &&
        COMMITTED_STATES.has(o.state) &&
        localDayKey(new Date(o.endTime).getTime(), timeZone) === dayKey,
    )
    .reduce((sum, o) => sum + landed(o), 0);
  const dayTotal = spentToday + inFlight + landed(s);
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

  return { ok: violations.length === 0, violations };
}

export interface TypoResult {
  needsConfirmation: boolean;
  reason?: string;
  /** The amount the user must retype (the max bid). */
  expectedCents?: Cents;
  /** Text for the confirmation prompt. */
  prompt?: string;
}

/**
 * Typo guard: a confirmation step at ARMING time, not a cap. Contract for the
 * arming handler (T-84/T-85): when `needsConfirmation` is true, `snipe.arm` must
 * carry a `typedConfirmation` for which `confirmsAmount(typed, maxBid)` is true
 * (compared by VALUE, so "$20", "20" and "20.00" all match $20.00), otherwise
 * it refuses. `checkCaps` (run again at fire time) never reports typo, so a
 * confirmed snipe is not blocked later. `detail.currentPrice` feeds the 3x rule;
 * without detail only the absolute threshold applies. Throws RangeError on a
 * malformed multiplier/absolute.
 */
export function typoCheck(
  maxBid: Cents,
  detail: ItemDetail | undefined,
  caps: Pick<CapsCheck, 'typoMultiplier' | 'typoAbsolute'>,
): TypoResult {
  if (!exceedsTypo(maxBid, detail?.currentPrice ?? 0, caps.typoMultiplier, caps.typoAbsolute)) {
    return { needsConfirmation: false };
  }
  return {
    needsConfirmation: true,
    reason: `${formatMoney(maxBid)} is above ${String(caps.typoMultiplier)}x the current price or the ${formatMoney(caps.typoAbsolute)} threshold`,
    expectedCents: maxBid,
    prompt: `Type the amount to confirm: ${formatMoney(maxBid)}`,
  };
}

/** True when `typed` parses (via `parseCents`) to exactly `maxBid` cents. */
export function confirmsAmount(typed: string, maxBid: Cents): boolean {
  return parseCents(typed) === maxBid;
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
