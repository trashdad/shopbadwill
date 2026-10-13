import type { GcalEvent, GcalEventBody } from '../../../src/domain/calendar/types';
import { CalendarApiError, type CalendarApiErrorCode } from '../../../src/ports/errors';
import type { CalendarApi, CalendarListRow } from '../../../src/ports/calendar';

export type CalendarApiMethod = keyof CalendarApi;

/**
 * In-memory Calendar v3 subset with Google's semantics: inserting an existing
 * id is a 'conflict' (even a cancelled one), delete marks an event 'cancelled'
 * (eventsGet still returns it, list does not), delete of a missing event is a
 * no-op, and patching a missing event is 'not-found'.
 */
export class FakeCalendarApi implements CalendarApi {
  readonly calls: Array<{ method: CalendarApiMethod; args: unknown[] }> = [];
  private readonly calendars = new Map<string, { id: string; summary: string; timeZone: string; description?: string }>();
  private readonly events = new Map<string, Map<string, GcalEvent>>();
  private readonly failures = new Map<CalendarApiMethod, CalendarApiError[]>();
  private calSeq = 0;
  private etagSeq = 0;

  /** Makes the next call to `method` reject with CalendarApiError(code); stacks FIFO. */
  failNext(method: CalendarApiMethod, code: CalendarApiErrorCode, status?: number): void {
    const queue = this.failures.get(method) ?? [];
    queue.push(new CalendarApiError(code, undefined, status === undefined ? undefined : { status }));
    this.failures.set(method, queue);
  }

  /** Test helper: a calendar created out of band. */
  seedCalendar(id: string, summary = 'Seeded', timeZone = 'UTC'): void {
    this.calendars.set(id, { id, summary, timeZone });
  }

  /** Test helper: every stored event of a calendar (cancelled included). */
  allEvents(calendarId: string): GcalEvent[] {
    return structuredClone([...(this.events.get(calendarId)?.values() ?? [])]);
  }

  calendarsInsert(summary: string, timeZone: string, description?: string): Promise<{ id: string }> {
    return this.run('calendarsInsert', [summary, timeZone, description], () => {
      this.calSeq += 1;
      const id = `fake-calendar-${String(this.calSeq)}@group.calendar.test`;
      this.calendars.set(id, { id, summary, timeZone, ...(description === undefined ? {} : { description }) });
      return { id };
    });
  }

  calendarListGet(calendarId: string): Promise<{ id: string } | null> {
    return this.run('calendarListGet', [calendarId], () => (this.calendars.has(calendarId) ? { id: calendarId } : null));
  }

  calendarListList(): Promise<CalendarListRow[]> {
    return this.run('calendarListList', [], () =>
      [...this.calendars.values()].map((c) => ({
        id: c.id,
        summary: c.summary,
        accessRole: 'owner',
        ...(c.description === undefined ? {} : { description: c.description }),
      })),
    );
  }

  eventsInsert(calendarId: string, body: GcalEventBody & { id: string }): Promise<GcalEvent> {
    return this.run('eventsInsert', [calendarId, body], () => {
      const bucket = this.bucket(calendarId);
      if (bucket.has(body.id)) throw new CalendarApiError('conflict', undefined, { status: 409 });
      const event: GcalEvent = structuredClone({ ...body, status: body.status ?? 'confirmed', etag: this.nextEtag() });
      bucket.set(body.id, event);
      return structuredClone(event);
    });
  }

  eventsGet(calendarId: string, eventId: string): Promise<GcalEvent | null> {
    return this.run('eventsGet', [calendarId, eventId], () => structuredClone(this.events.get(calendarId)?.get(eventId) ?? null));
  }

  eventsPatch(calendarId: string, eventId: string, patch: Partial<GcalEventBody>): Promise<GcalEvent> {
    return this.run('eventsPatch', [calendarId, eventId, patch], () => {
      const bucket = this.bucket(calendarId);
      const current = bucket.get(eventId);
      if (current === undefined) throw new CalendarApiError('not-found', undefined, { status: 404 });
      const defined = Object.fromEntries(Object.entries(patch as Record<string, unknown>).filter(([, v]) => v !== undefined));
      const next: GcalEvent = structuredClone({ ...current, ...defined, id: eventId, etag: this.nextEtag() });
      bucket.set(eventId, next);
      return structuredClone(next);
    });
  }

  eventsDelete(calendarId: string, eventId: string): Promise<void> {
    return this.run('eventsDelete', [calendarId, eventId], () => {
      const current = this.events.get(calendarId)?.get(eventId);
      if (current !== undefined) current.status = 'cancelled';
    });
  }

  eventsListByPrivateProp(calendarId: string, key: string, value: string): Promise<GcalEvent[]> {
    return this.run('eventsListByPrivateProp', [calendarId, key, value], () =>
      structuredClone(
        [...(this.events.get(calendarId)?.values() ?? [])].filter(
          (e) => e.status !== 'cancelled' && (e.extendedProperties.private as Record<string, string>)[key] === value,
        ),
      ),
    );
  }

  private run<T>(method: CalendarApiMethod, args: unknown[], body: () => T): Promise<T> {
    this.calls.push({ method, args: structuredClone(args) });
    const injected = this.failures.get(method)?.shift();
    if (injected !== undefined) return Promise.reject(injected);
    try {
      return Promise.resolve(body());
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  private bucket(calendarId: string): Map<string, GcalEvent> {
    let b = this.events.get(calendarId);
    if (b === undefined) {
      b = new Map();
      this.events.set(calendarId, b);
    }
    return b;
  }

  private nextEtag(): string {
    this.etagSeq += 1;
    return `"etag-${String(this.etagSeq)}"`;
  }
}
