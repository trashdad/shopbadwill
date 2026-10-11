// T-32: one card's tools, rendered in the card's closed shadow root: the
// registered badges, Why? (when a rule matched) and the quick actions.
//
// Fix round 1: the row takes no layout space (the host is zero-height; see
// TOOLS_CSS), so fixed-height cards keep their "Quick Bid" line. Only a small
// handle shows; the panel opens on hover, on keyboard focus, or when the
// handle is pressed.
import { Component, type ComponentChildren, type VNode } from 'preact';
import { useState } from 'preact/hooks';

import type { MatchResult } from '../../domain/rules/schema';
import type { Settings } from '../../domain/settings/schema';
import type { ItemId, Listing } from '../../domain/types';
import type { MessagingClient } from '../../ports/messaging';
import type { CardBadge, CardBadgeProps } from './badge-registry';
import { QuickActions } from './quick-actions';
import { Why } from './why';

export interface CardToolsProps {
  itemId: ItemId;
  listing: Listing | null;
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
  const badgeProps: CardBadgeProps = {
    itemId: p.itemId,
    listing: p.listing,
    settings: p.settings,
    client: p.client,
    cardRoot: p.cardRoot,
    now: p.now,
  };
  return (
    <div class={open ? 'tools open' : 'tools'}>
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
        {p.result !== null && p.result.decision !== 'none' ? (
          <Why result={p.result} ruleName={p.ruleName} title={p.listing?.title ?? null} client={p.client} />
        ) : null}
        <QuickActions itemId={p.itemId} listing={p.listing} quickFavorite={p.settings.overlay.quickFavorite} client={p.client} />
      </div>
    </div>
  );
}
