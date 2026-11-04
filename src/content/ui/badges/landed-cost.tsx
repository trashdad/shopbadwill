// T-57: the landed-cost badge (R7). badge-registry.ts loads it by glob;
// sgw-overlay.ts mounts it per card.
//
// - Requests quotes lazily, for visible cards only, through an
//   IntersectionObserver on the card root. Where IntersectionObserver does not
//   exist (tests), it requests at once.
// - Every card that becomes visible in the same flush window is batched into
//   ONE landedCost.get message (≤ 40 ids per message, R5).
// - Text only (Preact text nodes; never innerHTML). It shows "Pickup only" for
//   pickup items and nothing while pending, when the reply is null, when the
//   card has no listing, or when the feature / badge toggle is off.
// - The badge computes landed = the card's current price + shipping + handling
//   (R1); the handler already refused to make any request when the feature is
//   off, so gating here only spares the message.
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { formatMoney } from '../../../domain/money';
import type { Cents, ItemId } from '../../../domain/types';
import type { LandedCostQuote } from '../../../messaging/protocol';
import type { MessagingClient } from '../../../ports/messaging';
import type { CardBadge, CardBadgeProps } from '../badge-registry';

/** R5: the handler refuses messages with more ids; batches stay under it. */
const MAX_IDS_PER_MESSAGE = 40;

interface Pending {
  resolve: (quote: LandedCostQuote | null) => void;
  reject: (e: unknown) => void;
}

// One batcher per content script (one per page). Visible cards queue here and
// one flush sends them all as a single message.
const pending = new Map<ItemId, Pending>();
const inflight = new Map<ItemId, Promise<LandedCostQuote | null>>();
let flushScheduled = false;

/** Sends every queued id as one (or a few, capped at 40) landedCost.get message(s). */
export function flushLandedCostBatch(client: MessagingClient): void {
  flushScheduled = false;
  if (pending.size === 0) return;
  const entries = [...pending.entries()];
  pending.clear();
  const groups: Array<Array<[ItemId, Pending]>> = [];
  for (let i = 0; i < entries.length; i += MAX_IDS_PER_MESSAGE) {
    groups.push(entries.slice(i, i + MAX_IDS_PER_MESSAGE));
  }
  for (const group of groups) {
    const ids = group.map(([id]) => id);
    client.send('landedCost.get', { itemIds: ids }).then(
      (reply) => {
        for (const [id, entry] of group) entry.resolve(reply[id] ?? null);
      },
      () => {
        // The background may be restarting: nothing renders, and the next
        // render pass can ask again.
        for (const [, entry] of group) entry.resolve(null);
      },
    );
  }
}

/** Queues one visible card's quote; the batch flushes on the next macrotask. */
export function requestLandedCost(client: MessagingClient, itemId: ItemId): Promise<LandedCostQuote | null> {
  const existing = inflight.get(itemId);
  if (existing !== undefined) return existing;
  const promise = new Promise<LandedCostQuote | null>((resolve, reject) => {
    pending.set(itemId, { resolve, reject });
    if (!flushScheduled) {
      flushScheduled = true;
      setTimeout(() => {
        flushLandedCostBatch(client);
      }, 0);
    }
  });
  inflight.set(itemId, promise);
  void promise.then(
    () => {
      if (inflight.get(itemId) === promise) inflight.delete(itemId);
    },
    () => {
      if (inflight.get(itemId) === promise) inflight.delete(itemId);
    },
  );
  return promise;
}

export interface BadgeLine {
  text: string;
  title: string;
}

/** The badge text: "Pickup only", "Landed $X.XX" (price + shipping + handling), or nothing. */
export function badgeLine(quote: LandedCostQuote | null, currentPrice: Cents): BadgeLine | null {
  if (quote === null) return null;
  if (quote.pickup) return { text: 'Pickup only', title: 'Pickup only: no shipping or handling charged' };
  const landed = currentPrice + quote.shipping + quote.handling;
  return {
    text: `Landed ${formatMoney(landed)}`,
    title: `Current ${formatMoney(currentPrice)} + shipping ${formatMoney(quote.shipping)} + handling ${formatMoney(quote.handling)}`,
  };
}

type QuoteState = { status: 'pending' } | { status: 'none' } | { status: 'quote'; quote: LandedCostQuote };

function LandedCost(p: CardBadgeProps): VNode | null {
  const enabled = p.settings.features.landedCost && p.settings.overlay.landedCostBadges;
  const listing = p.listing;
  const [state, setState] = useState<QuoteState>({ status: 'pending' });

  useEffect(() => {
    if (!enabled || listing === null) return undefined;
    let disposed = false;
    const fetch = (): void => {
      void requestLandedCost(p.client, p.itemId).then(
        (quote) => {
          if (!disposed) setState(quote === null ? { status: 'none' } : { status: 'quote', quote });
        },
        () => {
          if (!disposed) setState({ status: 'none' });
        },
      );
    };
    if (typeof IntersectionObserver === 'undefined') {
      fetch();
      return () => {
        disposed = true;
      };
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          observer.disconnect();
          fetch();
          return;
        }
      }
    });
    observer.observe(p.cardRoot);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [enabled, listing === null, p.itemId, p.client, p.cardRoot]);

  if (!enabled || listing === null || state.status !== 'quote') return null;
  const line = badgeLine(state.quote, listing.currentPrice);
  return line === null ? null : (
    <span class="chip" title={line.title}>
      {line.text}
    </span>
  );
}

export const badge: CardBadge = { id: 'landed-cost', order: 20, Component: LandedCost };
