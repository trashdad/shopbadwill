// Pure builder for the desired calendar event of a tracked item. Time comes
// only from the inputs. Titles are untrusted text and stay plain text.
import { formatMoney } from '../money';
import type { Settings } from '../settings/schema';
import { formatDual } from '../time/pacific';
import type { Cents, ItemDetail, Listing, TrackedItem } from '../types';
import type { DesiredEvent } from './types';

export const MAX_TITLE_CHARS = 200;
export const MAX_REMINDERS = 5;
export const EVENT_DURATION_MIN = 15;

export interface BuildOptions {
  /** Event generation (a relist or recreate bumps it). Default 0. */
  generation?: number;
  /** The user's max bid, shown in the description when set. */
  maxBid?: Cents;
}

/** Control characters (incl. newlines) become spaces; whitespace collapses; capped at 200 code points. */
export function sanitizeTitle(raw: string): string {
  const flat = Array.from(raw, (ch) => {
    const c = ch.codePointAt(0) ?? 0;
    return c < 0x20 || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029 ? ' ' : ch;
  })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const points = Array.from(flat.toWellFormed());
  if (points.length <= MAX_TITLE_CHARS) return points.join('');
  return `${points.slice(0, MAX_TITLE_CHARS - 1).join('')}…`;
}

export function itemUrl(itemId: number): string {
  return `https://shopgoodwill.com/item/${String(itemId)}`;
}

function sbwState(outcome: TrackedItem['outcome']): DesiredEvent['privateProps']['sbwState'] {
  return outcome === 'won' || outcome === 'lost' || outcome === 'ended-early' ? outcome : 'open';
}

export function buildDesiredEvent(
  tracked: TrackedItem,
  item: Listing | ItemDetail,
  settings: Settings,
  options: BuildOptions = {},
): DesiredEvent {
  const generation = options.generation ?? 0;
  if (!Number.isSafeInteger(generation) || generation < 0) {
    throw new RangeError(`generation must be a non-negative safe integer, got ${String(generation)}`);
  }
  if (tracked.itemId !== item.itemId) {
    throw new RangeError(`tracked item ${String(tracked.itemId)} does not match listing ${String(item.itemId)}`);
  }
  const minutes = settings.calendar.reminders;
  if (minutes.length > MAX_REMINDERS) {
    throw new RangeError(`at most ${String(MAX_REMINDERS)} reminders are allowed, got ${String(minutes.length)}`);
  }

  const url = itemUrl(item.itemId);
  const lines = [
    `Ends: ${formatDual(new Date(item.endTime).getTime(), settings.locale.timeZone)}`,
    `Current price: ${formatMoney(item.currentPrice)}`,
  ];
  if (options.maxBid !== undefined) lines.push(`Your max bid: ${formatMoney(options.maxBid)}`);
  lines.push(url);

  return {
    itemId: item.itemId,
    generation,
    title: sanitizeTitle(item.title),
    description: lines.join('\n'),
    startUtc: item.endTime,
    durationMin: EVENT_DURATION_MIN,
    sourceUrl: url,
    reminders: minutes.map((m) => ({ method: 'popup' as const, minutes: m })),
    privateProps: { sbwItemId: String(item.itemId), sbwGen: String(generation), sbwState: sbwState(tracked.outcome) },
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Change-detection hash (not security): two 32-bit FNV-style passes over key-sorted JSON, 16 hex chars. */
export function hashDesired(desired: DesiredEvent): string {
  const text = stableJson(desired);
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c ^ (a >>> 13), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}
