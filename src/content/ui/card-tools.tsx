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
// Fix round 3: the dialog's host is on the document, not in the card. A collapsed
// card is `display:none`, which would hide a modal dialog inside it and leave
// the page inert with nothing on screen.
import { Component, type ComponentChildren, type VNode } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { MatchResult } from '../../domain/rules/schema';
import type { Settings } from '../../domain/settings/schema';
import type { ItemId, Listing } from '../../domain/types';
import type { MessagingClient } from '../../ports/messaging';
import type { CardBadge, CardBadgeProps } from './badge-registry';
import { QuickActions } from './quick-actions';
import { createUiHost, type UiHost } from './shadow';
import { TOOLS_CSS } from './styles';
import { WhyButton, WhyDialog } from './why';

export interface CardToolsProps {
  itemId: ItemId;
  listing: Listing | null;
  /** The match to explain with Why? (a hide or highlight), or null for no Why?. */
  result: MatchResult | null;
  /** Decoration on the card. The Why? heading follows this, not `result.decision`. */
  shown: 'hide' | 'highlight' | null;
  ruleName: (ruleId: string) => string;
  settings: Settings;
  client: MessagingClient;
  badges: readonly CardBadge[];
  cardRoot: Element;
  now: number;
}

/**
 * Renders `dialog` into a closed shadow host on the document, outside the card.
 * Re-renders on every commit so the dialog sees fresh props. Destroying the host
 * unmounts the dialog (and its cleanup leaves the top layer).
 */
function useDocumentDialog(open: boolean, doc: Document, itemId: ItemId, dialog: VNode | null): void {
  const modal = useRef<UiHost | null>(null);
  useLayoutEffect(() => {
    if (!open || dialog === null) {
      modal.current?.destroy();
      modal.current = null;
      return;
    }
    let host = modal.current;
    if (host === null || !host.host.isConnected) {
      host?.destroy();
      host = createUiHost(doc, 'sbw-why-modal', TOOLS_CSS, { 'data-sbw-why-modal': String(itemId) });
      doc.documentElement.append(host.host);
      modal.current = host;
    } else {
      host.host.setAttribute('data-sbw-why-modal', String(itemId));
    }
    host.render(dialog);
  });
  useLayoutEffect(() => {
    return () => {
      modal.current?.destroy();
      modal.current = null;
    };
  }, []);
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
  const shown = p.shown;
  const whyShown = whyOpen && why !== null && shown !== null;
  useEffect(() => {
    // The match went away (for example its rule was turned off).
    if ((why === null || shown === null) && whyOpen) setWhyOpen(false);
  }, [why, shown, whyOpen]);
  let dialog: VNode | null = null;
  if (why !== null && shown !== null && whyOpen) {
    dialog = (
      <WhyDialog
        result={why}
        shown={shown}
        ruleName={p.ruleName}
        title={p.listing?.title ?? null}
        client={p.client}
        onDone={() => {
          setWhyOpen(false);
          whyButton.current?.focus();
        }}
      />
    );
  }
  useDocumentDialog(dialog !== null, p.cardRoot.ownerDocument, p.itemId, dialog);
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
    </div>
  );
}
