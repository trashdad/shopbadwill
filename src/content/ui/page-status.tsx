// T-32: the page-level UI: the "N hidden · Show" pill (one-click undo of every
// hide on the page, and "Hide again"), a short status otherwise, and the
// "SGW layout changed, filters paused" banner when the cards stop parsing.
import type { VNode } from 'preact';

export const LAYOUT_CHANGED = 'SGW layout changed, filters paused';

export type PageView =
  /** settings.overlay.enabled is off: nothing visible. */
  | { kind: 'off' }
  | { kind: 'idle'; text: string }
  | { kind: 'hidden'; count: number }
  | { kind: 'shown'; count: number }
  | { kind: 'banner' };

export interface PageStatusProps {
  view: PageView;
  onShowAll: () => void;
  onHideAgain: () => void;
}

export function PageStatus({ view, onShowAll, onHideAgain }: PageStatusProps): VNode | null {
  switch (view.kind) {
    case 'off':
      return null;
    case 'idle':
      return (
        <div class="pill" role="status" title="ShopBadwill">
          {view.text}
        </div>
      );
    case 'hidden':
      return (
        <div class="pill" role="status" title="ShopBadwill">
          <span>{view.count} hidden</span>
          {' · '}
          <button type="button" data-action="show-all" onClick={onShowAll}>
            Show
          </button>
        </div>
      );
    case 'shown':
      return (
        <div class="pill" role="status" title="ShopBadwill">
          <span>{view.count} shown</span>
          {' · '}
          <button type="button" data-action="hide-again" onClick={onHideAgain}>
            Hide again
          </button>
        </div>
      );
    case 'banner':
      return (
        <>
          <div class="banner" role="alert">
            {LAYOUT_CHANGED}
          </div>
          <div class="pill" role="status" title="ShopBadwill">
            ShopBadwill: filters paused
          </div>
        </>
      );
  }
}
