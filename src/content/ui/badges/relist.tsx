// T-113: the relist badge, "Seen before at $X (date)". badge-registry.ts loads
// it by glob; sgw-overlay.ts mounts it per card.
//
// - Only when `features.relistDetector` is on (default off) and the card has
//   listing data. Every card in the same flush window is batched into ONE
//   relist.lookup message (<= 40 ids per message). The background answers
//   from data it already has: no SGW request is ever made for this badge.
// - Text only (Preact text nodes; never innerHTML). Nothing while pending,
//   on a null reply or an error, and never for the card's own item id.
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { formatMoney } from '../../../domain/money';
import { formatter } from '../../../domain/time/zoned';
import type { ItemId } from '../../../domain/types';
import type { RelistLookupHit } from '../../../messaging/protocol';
import type { MessagingClient } from '../../../ports/messaging';
import type { CardBadge, CardBadgeProps } from '../badge-registry';

const MAX_IDS_PER_MESSAGE = 40;

type Resolve = (hit: RelistLookupHit | null) => void;

// One batcher per content script (one per page).
const pending = new Map<ItemId, Resolve[]>();
let flushScheduled = false;

function flush(client: MessagingClient): void {
  flushScheduled = false;
  const entries = [...pending.entries()];
  pending.clear();
  for (let i = 0; i < entries.length; i += MAX_IDS_PER_MESSAGE) {
    const group = entries.slice(i, i + MAX_IDS_PER_MESSAGE);
    const answer = (reply: Record<ItemId, RelistLookupHit | null> | null): void => {
      for (const [id, resolvers] of group) for (const resolve of resolvers) resolve(reply?.[id] ?? null);
    };
    client.send('relist.lookup', { itemIds: group.map(([id]) => id) }).then(answer, () => {
      // The background may be restarting: nothing renders.
      answer(null);
    });
  }
}

/** Queues one card's lookup; the batch flushes on the next macrotask. */
export function requestRelist(client: MessagingClient, itemId: ItemId): Promise<RelistLookupHit | null> {
  return new Promise((resolve) => {
    const list = pending.get(itemId);
    if (list === undefined) pending.set(itemId, [resolve]);
    else list.push(resolve);
    if (!flushScheduled) {
      flushScheduled = true;
      setTimeout(() => {
        flush(client);
      }, 0);
    }
  });
}

function formatDate(ms: number, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', year: 'numeric' };
  try {
    return formatter(timeZone, options).format(ms);
  } catch {
    return formatter('UTC', options).format(ms);
  }
}

export interface BadgeLine {
  text: string;
  title: string;
}

/** The badge text, or null when there is no earlier listing (or the "earlier" one is this item). */
export function relistLine(hit: RelistLookupHit | null, itemId: ItemId, timeZone: string): BadgeLine | null {
  if (hit === null || hit.itemId === itemId) return null;
  const price = formatMoney(hit.price);
  const date = formatDate(hit.seenAt, timeZone);
  return {
    text: `Seen before at ${price} (${date})`,
    title: `An earlier listing (item ${String(hit.itemId)}) of what looks like the same item was last seen at ${price} on ${date}`,
  };
}

function Relist(p: CardBadgeProps): VNode | null {
  const enabled = p.settings.features.relistDetector;
  const hasListing = p.listing !== null;
  const [hit, setHit] = useState<RelistLookupHit | null>(null);

  useEffect(() => {
    setHit(null);
    if (!enabled || !hasListing) return undefined;
    let disposed = false;
    void requestRelist(p.client, p.itemId).then((h) => {
      if (!disposed) setHit(h);
    });
    return () => {
      disposed = true;
    };
  }, [enabled, hasListing, p.itemId, p.client]);

  if (!enabled || !hasListing) return null;
  const line = relistLine(hit, p.itemId, p.settings.locale.timeZone);
  return line === null ? null : (
    <span class="chip" title={line.title}>
      {line.text}
    </span>
  );
}

export const badge: CardBadge = { id: 'relist', order: 30, Component: Relist };
