// T-32: one card's tools, rendered in the card's closed shadow root: the
// registered badges, Why? (when a rule matched) and the quick actions.
//
// Fix round 1: the row takes no layout space (the host is zero-height; see
// TOOLS_CSS), so fixed-height cards keep their "Quick Bid" line. Only a small
// handle shows; the panel opens on hover, on keyboard focus, or when the
// handle is pressed.
//
// Fix round 2: the Why? dialog is rendered outside that panel, and the panel is
// forced open while the dialog is open (so focus can return to Why? on close).
import { Component, type ComponentChildren, type VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { MatchResult } from '../../domain/rules/schema';
import type { Settings } from '../../domain/settings/schema';
import type { ItemId, Listing } from '../../domain/types';
import type { MessagingClient } from '../../ports/messaging';
import type { CardBadge, CardBadgeProps } from './badge-registry';
import { QuickActions } from './quick-actions';
import { WhyButton, WhyDialog } from './why';

export interface CardToolsProps {
  itemId: ItemId;
  listing: Listing | null;
  /** The match to explain with Why? (a hide or highlight), or null for no Why?. */
  result: MatchResult | null;
  ruleName: (ruleId: string) => string;
  settings: Settings;
  client: MessagingClient;
  badges: readonly CardBadge[];
  cardRoot: Element;
  now: number;
}

/** Drops a badge that throws (for this card) instead of taking the row down. */
class BadgeBoundary extends Component<{ id: string; children?: ComponentChildren }, { failed: boolean }> {
  static override getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override state = { failed: false };

  override render(): VNode | null {
    return this.state.failed ? null : (
      <span class="badge" data-badge={this.props.id}>
        {this.props.children}
      </span>
    );
  }
}

export function CardTools(p: CardToolsProps): VNode {
  const [open, setOpen] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false);
  const whyButton = useRef<HTMLButtonElement>(null);
  const why = p.result;
  const whyShown = whyOpen && why !== null;
  useEffect(() => {
    if (why === null && whyOpen) setWhyOpen(false); // the match went away (e.g. its rule was turned off)
  }, [why, whyOpen]);
  const badgeProps: CardBadgeProps = {
    itemId: p.itemId,
    listing: p.listing,
    settings: p.settings,
    client: p.client,
    cardRoot: p.cardRoot,
    now: p.now,
  };
  return (
    <div class={open || whyShown ? 'tools open' : 'tools'}>
      <button
        type="button"
        class="handle"
        data-action="tools"
        aria-expanded={open}
        aria-label="ShopBadwill tools for this listing"
        title="ShopBadwill"
        onClick={() => {
          setOpen(!open);
        }}
      >
        SBW
      </button>
      <div class="panel" role="group" aria-label="ShopBadwill">
        {p.badges.map((b) => (
          <BadgeBoundary key={b.id} id={b.id}>
            <b.Component {...badgeProps} />
          </BadgeBoundary>
        ))}
        {why === null ? null : (
          <WhyButton
            open={whyShown}
            buttonRef={whyButton}
            onToggle={() => {
              setWhyOpen(!whyOpen);
            }}
          />
        )}
        <QuickActions itemId={p.itemId} listing={p.listing} quickFavorite={p.settings.overlay.quickFavorite} client={p.client} />
      </div>
      {whyShown ? (
        <WhyDialog
          result={why}
          ruleName={p.ruleName}
          title={p.listing?.title ?? null}
          client={p.client}
          onDone={() => {
            setWhyOpen(false);
            whyButton.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
