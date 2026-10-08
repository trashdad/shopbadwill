import type { VNode } from 'preact';

import { googleCalendarLink } from '../../domain/calendar/ics';
import type { DesiredEvent } from '../../domain/calendar/types';

export interface CalendarFallbackProps {
  events: readonly DesiredEvent[];
  /** Output of buildIcs(events, ...). */
  ics: string;
  /** Copy handler supplied by the host page (clipboard access is not this component's job). */
  onCopy?: (text: string) => void;
}

/** Per-item "Add to Google Calendar" links plus the .ics text with a copy option. */
export function CalendarFallback(props: CalendarFallbackProps): VNode {
  return (
    <section class="sbw-calendar-fallback" aria-labelledby="sbw-cal-fallback-h">
      <h3 id="sbw-cal-fallback-h">Add to your calendar</h3>
      <p>
        The Google Calendar links cannot include reminders; Google applies your calendar defaults. The .ics file asks
        for reminders at 60, 15 and 5 minutes before the end, but Google may ignore them when importing it. Apple and
        Outlook honour them.
      </p>
      <ul>
        {props.events.map((e) => (
          <li key={`${String(e.itemId)}-${String(e.generation)}`}>
            <a href={googleCalendarLink(e)} target="_blank" rel="noopener noreferrer">
              Add to Google Calendar: {e.title}
            </a>
          </li>
        ))}
      </ul>
      <label for="sbw-cal-ics">Calendar file (.ics) text</label>
      <textarea id="sbw-cal-ics" readOnly rows={8} value={props.ics} />
      {props.onCopy === undefined ? null : (
        <button type="button" onClick={() => props.onCopy?.(props.ics)}>
          Copy .ics
        </button>
      )}
    </section>
  );
}
