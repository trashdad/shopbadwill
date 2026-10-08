// Pure RFC 5545 builder for the zero-auth calendar fallback (.ics file and the
// Google "Add to calendar" template link). Time comes only from the inputs.
//
// OPEN QUESTION (see the plan): Google Calendar's import may ignore VALARMs,
// so the three reminders can be dropped when a .ics is imported there. Apple
// and Outlook honour them. The template link cannot carry reminders at all.
import type { DesiredEvent } from './types';

export const ICS_PRODID = '-//ShopBadwill//Auction Reminders//EN';
export const ICS_UID_DOMAIN = 'shopbadwill';
/** Fallback alarms: 60, 15 and 5 minutes before the auction ends. */
export const ICS_ALARM_MINUTES = [60, 15, 5] as const;
const MAX_OCTETS = 75;
const encoder = new TextEncoder();

export interface IcsOptions {
  /** Used for DTSTAMP; passed in so this module never reads the clock. */
  nowUtc: string;
}

function parseUtc(iso: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new RangeError(`not a valid UTC time: ${iso}`);
  return d;
}

/** `20261008T043000Z` */
function basicUtc(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
}

function endOf(event: DesiredEvent): Date {
  return new Date(parseUtc(event.startUtc).getTime() + event.durationMin * 60_000);
}

/** Escape a TEXT value: backslash, comma, semicolon and any newline form. */
export function escapeIcsText(text: string): string {
  return text
    .toWellFormed()
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/** Fold at 75 octets (UTF-8), never inside a character. Continuations start with one space. */
export function foldLine(line: string): string {
  if (encoder.encode(line).length <= MAX_OCTETS) return line;
  const out: string[] = [];
  let current = '';
  let used = 0;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    const limit = out.length === 0 ? MAX_OCTETS : MAX_OCTETS - 1; // the leading space counts
    if (used + size > limit) {
      out.push(current);
      current = '';
      used = 0;
    }
    current += ch;
    used += size;
  }
  out.push(current);
  return out.map((p, i) => (i === 0 ? p : ` ${p}`)).join('\r\n');
}

function eventLines(event: DesiredEvent, stamp: string): string[] {
  const lines = [
    'BEGIN:VEVENT',
    `UID:sbv${String(event.itemId)}g${String(event.generation)}@${ICS_UID_DOMAIN}`,
    `DTSTAMP:${stamp}`,
    `DTSTART:${basicUtc(parseUtc(event.startUtc))}`,
    `DTEND:${basicUtc(endOf(event))}`,
    `SUMMARY:${escapeIcsText(event.title)}`,
    `DESCRIPTION:${escapeIcsText(event.description)}`,
    `URL:${event.sourceUrl}`,
  ];
  for (const m of ICS_ALARM_MINUTES) {
    lines.push(
      'BEGIN:VALARM',
      'ACTION:DISPLAY',
      `DESCRIPTION:${escapeIcsText(event.title)}`,
      `TRIGGER:-PT${String(m)}M`,
      'END:VALARM',
    );
  }
  lines.push('END:VEVENT');
  return lines;
}

/** A VCALENDAR with one VEVENT per desired event. CRLF-terminated, folded. */
export function buildIcs(events: readonly DesiredEvent[], options: IcsOptions): string {
  const stamp = basicUtc(parseUtc(options.nowUtc));
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${ICS_PRODID}`, 'CALSCALE:GREGORIAN'];
  for (const e of events) lines.push(...eventLines(e, stamp));
  lines.push('END:VCALENDAR');
  return `${lines.map(foldLine).join('\r\n')}\r\n`;
}

/** Google's template link. It cannot carry reminders (Google applies the calendar defaults). */
export function googleCalendarLink(event: DesiredEvent): string {
  const dates = `${basicUtc(parseUtc(event.startUtc))}/${basicUtc(endOf(event))}`;
  const query = [
    ['action', 'TEMPLATE'],
    ['text', event.title],
    ['dates', dates],
    ['details', event.description],
  ]
    .map(([k, v]) => `${k as string}=${encodeURIComponent((v as string).toWellFormed())}`)
    .join('&');
  return `https://calendar.google.com/calendar/render?${query}`;
}
