// Contract v1 (T-02): PLAN §3.8 calendar ports. CalendarApi is implemented by
// T-64 (src/adapters/google/calendar-api.ts, every response zod-validated) and
// CalendarSink by T-67 (src/adapters/google/calendar-sink.ts). Failures throw
// CalendarApiError (./errors.ts).
import type { CalendarLink, DesiredEvent, GcalEvent, GcalEventBody } from '../domain/calendar/types';
import type { Cents, ItemId } from '../domain/types';

export interface CalendarSink {
  /** Creates "ShopGoodwill Auctions" once; stores calendarId. */
  ensureCalendar(): Promise<string>;
  upsert(e: DesiredEvent): Promise<{ op: 'insert' | 'patch' | 'noop' | 'recreated'; link: CalendarLink }>;
  remove(itemId: ItemId): Promise<{ op: 'delete' | 'noop' }>;
  /** Retitles and clears reminders. */
  stamp(itemId: ItemId, outcome: 'won' | 'lost' | 'ended-early', finalPrice?: Cents): Promise<void>;
  reconcile(
    desired: DesiredEvent[],
    links: CalendarLink[],
  ): Promise<Array<{ itemId: ItemId; op: string; error?: string }>>;
}

/** One `calendarList.list` entry, as far as the sink needs it. */
export interface CalendarListRow {
  id: string;
  summary: string;
  description?: string;
  /** 'owner' | 'writer' | 'reader' | 'freeBusyReader' (Google's values). */
  accessRole?: string;
  primary?: boolean;
}

/** Thin typed Calendar v3 subset. */
export interface CalendarApi {
  calendarsInsert(summary: string, timeZone: string, description?: string): Promise<{ id: string }>;
  calendarListGet(calendarId: string): Promise<{ id: string } | null>;
  /**
   * Calendars this grant can see. `calendar.app.created` sees only calendars
   * this app created. An entry with no id is omitted. `accessRole` and
   * `primary` are passed through when Google sends them (the sink adopts only
   * an owned, non-primary calendar carrying its marker).
   */
  calendarListList(): Promise<CalendarListRow[]>;
  /** 409 → CalendarApiError('conflict'). */
  eventsInsert(calendarId: string, body: GcalEventBody & { id: string }): Promise<GcalEvent>;
  /** Includes status 'cancelled'. */
  eventsGet(calendarId: string, eventId: string): Promise<GcalEvent | null>;
  eventsPatch(calendarId: string, eventId: string, patch: Partial<GcalEventBody>): Promise<GcalEvent>;
  /** 404/410 → no-op. */
  eventsDelete(calendarId: string, eventId: string): Promise<void>;
  eventsListByPrivateProp(calendarId: string, key: string, value: string): Promise<GcalEvent[]>;
}
