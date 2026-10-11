// Lenient raw-shape schemas for Google Calendar v3 responses, plus the
// normalizer that turns a raw event into the contract's `GcalEvent`.
//
// Google's JSON is parsed leniently: only `id` is required of an event. A
// cancelled event may carry little more than id and status, `description` may
// be absent, `reminders.overrides` is absent after a stamp, and a user can edit
// an event into another time zone, an all-day event, or strip our private
// properties. None of those may crash the adapter, so every optional field uses
// `.catch(undefined)` and `normalizeEvent` fills documented defaults.
import { z } from 'zod';

import { GcalEventSchema, type GcalEvent } from '../../domain/calendar/types';

const lenient = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

const RawTimeSchema = z.looseObject({
  dateTime: lenient(z.string()),
  date: lenient(z.string()),
  timeZone: lenient(z.string()),
});

const RawReminderSchema = z.looseObject({ method: z.string(), minutes: z.number() });

export const RawEventSchema = z.looseObject({
  id: z.string().min(1),
  etag: lenient(z.string()),
  status: lenient(z.string()),
  summary: lenient(z.string()),
  description: lenient(z.string()),
  start: lenient(RawTimeSchema),
  end: lenient(RawTimeSchema),
  reminders: lenient(
    z.looseObject({
      useDefault: lenient(z.boolean()),
      overrides: lenient(z.array(z.unknown())),
    }),
  ),
  extendedProperties: lenient(z.looseObject({ private: lenient(z.record(z.string(), z.unknown())) })),
  source: lenient(z.looseObject({ title: lenient(z.string()), url: lenient(z.string()) })),
});
export type RawEvent = z.infer<typeof RawEventSchema>;

export const RawEventsListSchema = z.looseObject({
  items: lenient(z.array(z.unknown())),
  nextPageToken: lenient(z.string()),
});

export const RawCalendarSchema = z.looseObject({ id: z.string().min(1) });

export const RawCalendarListEntrySchema = z.looseObject({
  id: z.string().min(1),
  summary: lenient(z.string()),
  description: lenient(z.string()),
});

export const RawCalendarListSchema = z.looseObject({
  items: lenient(z.array(z.unknown())),
  nextPageToken: lenient(z.string()),
});

/** Google's error envelope; every field is optional because proxies and edge errors return other bodies. */
export const RawGoogleErrorSchema = z.looseObject({
  error: lenient(
    z.looseObject({
      code: lenient(z.number()),
      message: lenient(z.string()),
      status: lenient(z.string()),
      errors: lenient(z.array(z.looseObject({ reason: lenient(z.string()), message: lenient(z.string()) }))),
    }),
  ),
});

const DEFAULT_DURATION_MS = 15 * 60_000;
const MAX_REMINDERS = 5;
const OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/i;
const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Offset (ms) of `timeZone` from UTC at the instant `utcMs`; undefined for an unknown zone. */
function zoneOffsetMs(timeZone: string, utcMs: number): number | undefined {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(utcMs));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return asUtc - Math.floor(utcMs / 1000) * 1000;
  } catch {
    return undefined;
  }
}

/** A raw start/end object to epoch ms, or undefined when it holds nothing usable. */
export function rawTimeToMs(t: z.infer<typeof RawTimeSchema> | undefined): number | undefined {
  if (t === undefined) return undefined;
  if (t.dateTime !== undefined) {
    if (OFFSET_RE.test(t.dateTime)) {
      const ms = new Date(t.dateTime).getTime();
      return Number.isNaN(ms) ? undefined : ms;
    }
    // No offset: wall time in `timeZone` (UTC when absent or unknown).
    const m = NAIVE_RE.exec(t.dateTime);
    if (m === null) return undefined;
    const frac = m[7] === undefined ? 0 : Math.floor(Number(`0.${m[7]}`) * 1000);
    const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0), frac);
    if (Number.isNaN(wall)) return undefined;
    if (t.timeZone === undefined || t.timeZone === 'UTC') return wall;
    const off = zoneOffsetMs(t.timeZone, wall);
    if (off === undefined) return wall;
    // Re-check the offset at the corrected instant (DST edges).
    return wall - (zoneOffsetMs(t.timeZone, wall - off) ?? off);
  }
  if (t.date !== undefined && DATE_RE.test(t.date)) {
    const ms = new Date(`${t.date}T00:00:00Z`).getTime();
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

const iso = (ms: number): string => new Date(ms).toISOString();

function normalizeReminders(raw: RawEvent['reminders']): GcalEvent['reminders'] {
  const overrides: GcalEvent['reminders']['overrides'] = [];
  for (const o of raw?.overrides ?? []) {
    const r = RawReminderSchema.safeParse(o);
    if (!r.success || (r.data.method !== 'popup' && r.data.method !== 'email')) continue;
    if (!Number.isFinite(r.data.minutes)) continue;
    overrides.push({ method: r.data.method, minutes: Math.max(0, Math.round(r.data.minutes)) });
    if (overrides.length === MAX_REMINDERS) break;
  }
  return { useDefault: false, overrides };
}

function normalizePrivate(raw: RawEvent['extendedProperties']): GcalEvent['extendedProperties']['private'] {
  const p = raw?.private ?? {};
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');
  const state = p['sbwState'];
  return {
    sbwItemId: str(p['sbwItemId']),
    sbwGen: str(p['sbwGen']),
    sbwState: state === 'open' || state === 'won' || state === 'lost' || state === 'ended-early' ? state : 'open',
  };
}

/**
 * Raw event to the normalized `GcalEvent`. Defaults for what a hand-edited or
 * cancelled event may lack: summary and description ''; unknown status
 * 'confirmed'; missing start the Unix epoch; missing end start + 15 min;
 * times in any zone (or all-day) converted to UTC; reminders taken from
 * `overrides` only (`useDefault` is always false, an absent list is []);
 * missing private properties '' and 'open'. Returns undefined only when the
 * input has no usable `id` (callers map that to a 'schema' error).
 */
export function normalizeEvent(rawInput: unknown): GcalEvent | undefined {
  const parsed = RawEventSchema.safeParse(rawInput);
  if (!parsed.success) return undefined;
  const raw = parsed.data;
  const startMs = rawTimeToMs(raw.start) ?? 0;
  const endMs = rawTimeToMs(raw.end) ?? startMs + DEFAULT_DURATION_MS;
  const status = raw.status === 'cancelled' || raw.status === 'tentative' ? raw.status : 'confirmed';
  const candidate: Record<string, unknown> = {
    id: raw.id,
    status,
    summary: raw.summary ?? '',
    description: raw.description ?? '',
    start: { dateTime: iso(startMs), timeZone: 'UTC' },
    end: { dateTime: iso(endMs), timeZone: 'UTC' },
    reminders: normalizeReminders(raw.reminders),
    extendedProperties: { private: normalizePrivate(raw.extendedProperties) },
  };
  if (raw.etag !== undefined) candidate['etag'] = raw.etag;
  if (raw.source?.url !== undefined) candidate['source'] = { title: raw.source.title ?? '', url: raw.source.url };
  const out = GcalEventSchema.safeParse(candidate);
  return out.success ? out.data : undefined;
}
