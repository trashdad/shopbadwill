// T-32: the dual-time badge. The auction end in Pacific time and the user's
// zone ("Ends 7:18 PM PT · 10:18 PM ET"), with the Pacific weekday when it
// does not end today. Only from the page's own API data; nothing for DOM-only cards.
import type { VNode } from 'preact';

import { formatter, wallParts } from '../../../domain/time/zoned';
import { PacificTime } from '../../../ui/time';
import type { CardBadge, CardBadgeProps } from '../badge-registry';

const PACIFIC = 'America/Los_Angeles';

function sameDay(a: number, b: number): boolean {
  const x = wallParts(a, PACIFIC);
  const y = wallParts(b, PACIFIC);
  return x.year === y.year && x.month === y.month && x.day === y.day;
}

function EndTime({ listing, settings, now }: CardBadgeProps): VNode | null {
  if (listing === null) return null;
  const ms = new Date(listing.endTime).getTime();
  if (!Number.isFinite(ms)) return null;
  const day = sameDay(ms, now) ? '' : `${formatter(PACIFIC, { weekday: 'short' }).format(ms)} `;
  return (
    <span class="chip" title="Auction end: Pacific time · your time">
      Ends {day}
      <PacificTime ms={ms} userTz={settings.locale.timeZone} />
    </span>
  );
}

export const badge: CardBadge = { id: 'end-time', order: 10, Component: EndTime };
