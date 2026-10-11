import { describe, expect, it } from 'vitest';
import { buildDesiredEvent } from '../../../../src/domain/calendar/event-builder';
import { eventIdFor } from '../../../../src/domain/calendar/event-id';
import { buildIcs, escapeIcsText, foldLine, googleCalendarLink } from '../../../../src/domain/calendar/ics';
import { DEFAULT_SETTINGS } from '../../../../src/domain/settings/defaults';
import { SettingsSchema } from '../../../../src/domain/settings/schema';
import type { DesiredEvent } from '../../../../src/domain/calendar/types';
import type { Listing, TrackedItem } from '../../../../src/domain/types';

const listing: Listing = {
  itemId: 279250057,
  title: 'Vase, glass; 5" tall\\ new',
  currentPrice: 1299,
  startingMinimumBid: 100,
  numBids: 2,
  endTime: '2026-10-08T04:30:00.000Z',
  endTimeRaw: '2026-10-07T21:30:00',
  sellerId: 1,
  pickupOnly: false,
  source: 'api',
  observedAt: 1,
};
const tracked: TrackedItem = {
  itemId: 279250057,
  title: listing.title,
  endTime: listing.endTime,
  sellerId: 1,
  reasons: [{ kind: 'manual' }],
  favoriteState: 'none',
  calendar: true,
  addedAt: 1,
  updatedAt: 1,
};
const desired = buildDesiredEvent(tracked, listing, SettingsSchema.parse(DEFAULT_SETTINGS));
const NOW = '2026-10-01T12:00:00.000Z';

interface Node {
  name: string;
  props: Map<string, string[]>;
  children: Node[];
}

/** Minimal ICS parser: unfold, split on CRLF, unescape nothing (raw values). */
function parse(ics: string): Node {
  expect(ics.endsWith('\r\n')).toBe(true);
  const raw = ics.slice(0, -2).split('\r\n');
  const lines: string[] = [];
  for (const l of raw) {
    if (l.startsWith(' ')) lines[lines.length - 1] = `${lines[lines.length - 1] ?? ''}${l.slice(1)}`;
    else lines.push(l);
  }
  const root: Node = { name: 'ROOT', props: new Map(), children: [] };
  const stack = [root];
  for (const l of lines) {
    const i = l.indexOf(':');
    const key = l.slice(0, i).split(';')[0] ?? '';
    const value = l.slice(i + 1);
    const top = stack[stack.length - 1] as Node;
    if (key === 'BEGIN') {
      const n: Node = { name: value, props: new Map(), children: [] };
      top.children.push(n);
      stack.push(n);
    } else if (key === 'END') {
      expect(top.name).toBe(value);
      stack.pop();
    } else {
      top.props.set(key, [...(top.props.get(key) ?? []), value]);
    }
  }
  expect(stack).toHaveLength(1);
  return root.children[0] as Node;
}

describe('buildIcs', () => {
  const cal = parse(buildIcs([desired], { nowUtc: NOW }));
  const ev = cal.children[0] as Node;

  it('has a valid calendar header and one VEVENT', () => {
    expect(cal.name).toBe('VCALENDAR');
    expect(cal.props.get('VERSION')).toEqual(['2.0']);
    expect(cal.props.get('PRODID')?.[0]).toMatch(/ShopBadwill/);
    expect(cal.children).toHaveLength(1);
    expect(ev.name).toBe('VEVENT');
  });

  it('uses CRLF only and never exceeds 75 octets per line', () => {
    const out = buildIcs([desired], { nowUtc: NOW });
    expect(out.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    for (const l of out.split('\r\n')) expect(new TextEncoder().encode(l).length).toBeLessThanOrEqual(75);
  });

  it('writes UTC times with Z, a 15 minute duration, stable UID and DTSTAMP', () => {
    expect(ev.props.get('DTSTART')).toEqual(['20261008T043000Z']);
    expect(ev.props.get('DTEND')).toEqual(['20261008T044500Z']);
    expect(ev.props.get('DTSTAMP')).toEqual(['20261001T120000Z']);
    expect(ev.props.get('UID')).toEqual([`${eventIdFor(279250057, 0)}@shopbadwill`]);
    const again = parse(buildIcs([desired], { nowUtc: '2027-01-01T00:00:00.000Z' })).children[0] as Node;
    expect(again.props.get('UID')).toEqual(ev.props.get('UID'));
  });

  it('emits three DISPLAY alarms at 60, 15 and 5 minutes', () => {
    const alarms = ev.children.filter((c) => c.name === 'VALARM');
    expect(alarms.map((a) => a.props.get('TRIGGER')?.[0])).toEqual(['-PT60M', '-PT15M', '-PT5M']);
    for (const a of alarms) {
      expect(a.props.get('ACTION')).toEqual(['DISPLAY']);
      expect(a.props.get('DESCRIPTION')?.length).toBe(1);
    }
  });

  it('escapes backslash, comma, semicolon and newlines in TEXT values', () => {
    expect(ev.props.get('SUMMARY')).toEqual(['Vase\\, glass\\; 5" tall\\\\ new']);
    const d = ev.props.get('DESCRIPTION')?.[0] ?? '';
    expect(d).toContain('\\n');
    expect(d).not.toMatch(/\n/);
    expect(escapeIcsText('a\r\nb\nc\rd,e;f\\g')).toBe('a\\nb\\nc\\nd\\,e\\;f\\\\g');
  });

  it('derives alarms from popup reminders only, falling back to 60/15/5', () => {
    const triggers = (e: DesiredEvent): (string | undefined)[] =>
      (parse(buildIcs([e], { nowUtc: NOW })).children[0] as Node).children.map((a) => a.props.get('TRIGGER')?.[0]);
    expect(
      triggers({
        ...desired,
        reminders: [
          { method: 'popup', minutes: 120 },
          { method: 'popup', minutes: 10 },
        ],
      }),
    ).toEqual(['-PT120M', '-PT10M']);
    expect(
      triggers({
        ...desired,
        reminders: [
          { method: 'email', minutes: 30 },
          { method: 'popup', minutes: 7 },
        ],
      }),
    ).toEqual(['-PT7M']);
    expect(triggers({ ...desired, reminders: [{ method: 'email', minutes: 30 }] })).toEqual([
      '-PT60M',
      '-PT15M',
      '-PT5M',
    ]);
    expect(triggers({ ...desired, reminders: [] })).toEqual(['-PT60M', '-PT15M', '-PT5M']);
  });

  it('emits one alarm for duplicate popup minutes', () => {
    const popup = { method: 'popup' as const, minutes: 10 };
    const e = { ...desired, reminders: [popup, { ...popup }] };
    const ev2 = parse(buildIcs([e], { nowUtc: NOW })).children[0] as Node;
    expect(ev2.children.map((a) => a.props.get('TRIGGER')?.[0])).toEqual(['-PT10M']);
  });

  it('refuses a sourceUrl that could inject ICS lines', () => {
    for (const bad of ['https://x.test/\r\nATTACH:evil', 'https://x.test/\nX:1']) {
      expect(() => buildIcs([{ ...desired, sourceUrl: bad }], { nowUtc: NOW })).toThrow(RangeError);
    }
  });

  it('supports several events and none', () => {
    const second: DesiredEvent = {
      ...desired,
      itemId: 5,
      privateProps: { ...desired.privateProps, sbwItemId: '5' },
    };
    expect(parse(buildIcs([desired, second], { nowUtc: NOW })).children).toHaveLength(2);
    expect(parse(buildIcs([], { nowUtc: NOW })).children).toHaveLength(0);
  });

  it('rejects an unparseable time', () => {
    expect(() => buildIcs([{ ...desired, startUtc: 'nope' }], { nowUtc: NOW })).toThrow(RangeError);
  });
});

describe('foldLine', () => {
  it('folds multi-byte text at 75 octets without splitting a character', () => {
    const line = `SUMMARY:${'é€😀'.repeat(40)}`;
    const folded = foldLine(line);
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(new TextEncoder().encode(p).length).toBeLessThanOrEqual(75);
    expect(parts.map((p, i) => (i === 0 ? p : p.slice(1))).join('')).toBe(line);
  });

  it('leaves short lines alone', () => {
    expect(foldLine('A:b')).toBe('A:b');
  });
});

describe('googleCalendarLink', () => {
  it('builds an encoded template link', () => {
    const url = new URL(googleCalendarLink(desired));
    expect(url.origin + url.pathname).toBe('https://calendar.google.com/calendar/render');
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe(desired.title);
    expect(url.searchParams.get('dates')).toBe('20261008T043000Z/20261008T044500Z');
    expect(url.searchParams.get('details')).toBe(desired.description);
    expect(googleCalendarLink(desired)).not.toMatch(/ |"/);
  });
});
