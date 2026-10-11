// T-85 ruling 3: the arm confirmation's auction end, with its DATE, in the
// user's zone and in SGW Pacific:
//   "Thu Oct 8, 12:30:00 AM EDT (Wed Oct 7, 9:30:00 PM PT)".
// The Pacific side repeats the date only when it differs (across midnight).
// pacific.ts's formatDual is clock-only, so the date is built here, on the same
// cached zoned Intl formatter pacific.ts uses (src/domain/time/zoned.ts): DST
// comes from the IANA zones, never from fixed offsets. Text only.
import { formatter } from '../../../../domain/time/zoned';

/** SGW's zone (pacific.ts keeps its own copy private). */
const PACIFIC = 'America/Los_Angeles';

/** Intl's narrow and no-break spaces made plain, as pacific.ts's formatClock does. */
function plain(text: string): string {
  return text.replaceAll(String.fromCharCode(0x202f), ' ').replaceAll(String.fromCharCode(0xa0), ' ');
}

/** "Thu Oct 8" in `timeZone`. */
function dateText(ms: number, timeZone: string): string {
  const parts = formatter(timeZone, { weekday: 'short', month: 'short', day: 'numeric' }).formatToParts(ms);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('weekday')} ${part('month')} ${part('day')}`;
}

/** "12:30:00 AM" in `timeZone`. */
function timeText(ms: number, timeZone: string): string {
  return plain(formatter(timeZone, { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).format(ms));
}

/** The zone's short name in force at `ms` ("EDT", "EST", "HST", "GMT+1"). */
function zoneName(ms: number, timeZone: string): string {
  return (
    formatter(timeZone, { timeZoneName: 'short' })
      .formatToParts(ms)
      .find((p) => p.type === 'timeZoneName')?.value ?? timeZone
  );
}

/**
 * The end in the user's zone with its date and zone name, then SGW Pacific in
 * parentheses ("PT"), with Pacific's own date when it is a different day. A
 * user on Pacific time sees one time, named PDT or PST so the repeated
 * fall-back hour stays unambiguous.
 */
export function formatEndDual(ms: number, userTz: string): string {
  const userDate = dateText(ms, userTz);
  const user = `${userDate}, ${timeText(ms, userTz)} ${zoneName(ms, userTz)}`;
  if (userTz === PACIFIC) return user;
  const pacificDate = dateText(ms, PACIFIC);
  return `${user} (${pacificDate === userDate ? '' : `${pacificDate}, `}${timeText(ms, PACIFIC)} PT)`;
}
