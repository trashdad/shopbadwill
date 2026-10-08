// Money is integer cents everywhere in the domain (`Cents`). Strings exist only
// at the edges: parsing user/site text and the API's two-decimal `bidAmount`.
import type { Cents } from './types';

const AMOUNT = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

function assertCents(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer number of cents, got ${String(value)}`);
  }
}

/**
 * Parses "12.99", "12.5", "12" or "$1,299.50" into cents without floating point.
 * Returns null for anything else (negative, 3+ decimals, exponent, empty, unsafe size).
 */
export function parseCents(text: string): Cents | null {
  const m = AMOUNT.exec(text.trim());
  const whole = m?.[1];
  if (m === null || whole === undefined) return null;
  const frac = (m[2] ?? '').padEnd(2, '0');
  const cents = Number(whole.replaceAll(',', '')) * 100 + Number(frac);
  return Number.isSafeInteger(cents) ? cents : null;
}

/** Two-decimal plain amount, "12.99". Throws RangeError unless `cents` is a non-negative safe integer. */
export function formatCents(cents: Cents): string {
  assertCents(cents, 'cents');
  const whole = Math.floor(cents / 100);
  return `${String(whole)}.${String(cents - whole * 100).padStart(2, '0')}`;
}

/** Display form with a dollar sign and thousands separators, "$1,299.50". */
export function formatMoney(cents: Cents): string {
  const plain = formatCents(cents);
  const [whole = '0', frac = '00'] = plain.split('.');
  return `$${whole.replace(/\B(?=(\d{3})+$)/g, ',')}.${frac}`;
}

/** The `bidAmount` string sent to SGW: always two decimals, derived only from cents. */
export function bidAmount(cents: Cents): string {
  return formatCents(cents);
}

/** The next acceptable bid: the current price plus the increment. */
export function nextAcceptable(current: Cents, increment: Cents): Cents {
  assertCents(current, 'current');
  assertCents(increment, 'increment');
  return current + increment;
}

/**
 * Converts a max the user thinks of as all-in (price + shipping + handling) into
 * the bid to place. Unknown shipping or handling counts as zero; never below 0.
 */
export function allInToBid(allIn: Cents, shipping?: Cents | null, handling?: Cents | null): Cents {
  assertCents(allIn, 'allIn');
  const extras = (shipping ?? 0) + (handling ?? 0);
  assertCents(extras, 'shipping + handling');
  return Math.max(0, allIn - extras);
}

/**
 * Typo guard (the only implementation; T-82 reuses it). True when `max` is
 * strictly above `multiplier` x `current`, or strictly above the `absolute`
 * threshold. With no bids yet (current 0) only the absolute threshold applies.
 */
export function exceedsTypo(max: Cents, current: Cents, multiplier: number, absolute: Cents): boolean {
  assertCents(max, 'max');
  assertCents(current, 'current');
  assertCents(absolute, 'absolute');
  return max > absolute || (current > 0 && max > current * multiplier);
}
