// T-32: per-card quick actions (hide seller, hide keyword, favorite when
// enabled, track). They live in the card's CLOSED shadow root and act only on
// trusted user input (`event.isTrusted`): a page script can neither find these
// controls nor fake a click on them. Each one only sends a `quick.*` intent to
// the background, which decides (and audits) what happens; nothing here talks
// to SGW.
import type { VNode } from 'preact';
import { useRef, useState } from 'preact/hooks';

import type { Listing, ItemId } from '../../domain/types';
import type { MsgPayload } from '../../messaging/protocol';
import type { MessagingClient } from '../../ports/messaging';
import { describeError } from '../../ui/components/describeError';

export interface QuickActionsProps {
  itemId: ItemId;
  listing: Listing | null;
  /** settings.overlay.quickFavorite. */
  quickFavorite: boolean;
  client: MessagingClient;
}

type QuickType = 'quick.hideSeller' | 'quick.hideKeyword' | 'quick.favorite' | 'quick.track';

const MAX_TERM = 100;
/** Only real user input: false for script-dispatched events. */
const trusted = (e: Event): boolean => e.isTrusted;

export function QuickActions({ itemId, listing, quickFavorite, client }: QuickActionsProps): VNode {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('');
  const input = useRef<HTMLInputElement>(null);

  function run<K extends QuickType>(type: K, payload: MsgPayload<K>, done: string): void {
    setStatus('…');
    client.send(type, payload).then(
      () => {
        setStatus(done);
      },
      (err: unknown) => {
        setStatus(`Not done: ${describeError(err)}`);
      },
    );
  }

  return (
    <div class="qa">
      <button
        type="button"
        data-action="actions"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        Actions
      </button>
      {open ? (
        <div class="qa-panel" role="group" aria-label="ShopBadwill quick actions">
          {listing === null ? null : (
            <button
              type="button"
              data-action="hide-seller"
              onClick={(e) => {
                if (!trusted(e)) return;
                run('quick.hideSeller', { sellerId: listing.sellerId, sellerName: listing.sellerName ?? '' }, 'Seller hidden.');
              }}
            >
              Hide seller
            </button>
          )}
          <form
            data-action="hide-keyword"
            onSubmit={(e) => {
              e.preventDefault();
              if (!trusted(e)) return;
              const term = (input.current?.value ?? '').trim().slice(0, MAX_TERM);
              if (term === '') {
                setStatus('Type a keyword first.');
                return;
              }
              run('quick.hideKeyword', { term }, `Hiding listings with "${term}".`);
            }}
          >
            <input ref={input} type="text" maxLength={MAX_TERM} aria-label="Keyword to hide" placeholder="keyword" />
            <button type="submit">Hide keyword</button>
          </form>
          {quickFavorite && listing?.isFavorite !== true ? (
            <button
              type="button"
              data-action="favorite"
              onClick={(e) => {
                if (!trusted(e)) return;
                run('quick.favorite', { itemId }, 'Favorited.');
              }}
            >
              Favorite
            </button>
          ) : null}
          <button
            type="button"
            data-action="track"
            onClick={(e) => {
              if (!trusted(e)) return;
              run('quick.track', { itemId }, 'Tracking.');
            }}
          >
            Track
          </button>
        </div>
      ) : null}
      <span class="status" role="status" data-quick-status="">
        {status}
      </span>
    </div>
  );
}
