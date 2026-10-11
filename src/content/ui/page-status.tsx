// T-32: the page-level pill: "N hidden · Show" (one-click undo of every hide on
// the page) and "Hide again", a short status otherwise, and the "SGW layout
// changed, filters paused" alert when the cards stop parsing.
//
// Fix round 1: it sits bottom-left (clear of SGW's bottom-right controls), the
// layout alert is folded into it (no box over SGW's header search), and the
// user can collapse it to a small dot.
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
  collapsed: boolean;
  onShowAll: () => void;
  onHideAgain: () => void;
  onCollapse: () => void;
  onExpand: () => void;
}

function summary(view: Exclude<PageView, { kind: 'off' }>): string {
  switch (view.kind) {
    case 'idle':
      return view.text;
    case 'hidden':
      return `ShopBadwill: ${String(view.count)} hidden`;
    case 'shown':
      return `ShopBadwill: ${String(view.count)} shown`;
    case 'banner':
      return `ShopBadwill: ${LAYOUT_CHANGED}`;
  }
}

function body(view: Exclude<PageView, { kind: 'off' }>, p: PageStatusProps): VNode {
  switch (view.kind) {
    case 'idle':
      return <div role="status">{view.text}</div>;
    case 'hidden':
      return (
        <div role="status">
          <span>{view.count} hidden</span>
          {' · '}
          <button type="button" data-action="show-all" onClick={p.onShowAll}>
            Show
          </button>
        </div>
      );
    case 'shown':
      return (
        <div role="status">
          <span>{view.count} shown</span>
          {' · '}
          <button type="button" data-action="hide-again" onClick={p.onHideAgain}>
            Hide again
          </button>
        </div>
      );
    case 'banner':
      return <div role="alert">{LAYOUT_CHANGED}</div>;
  }
}

export function PageStatus(p: PageStatusProps): VNode | null {
  const { view } = p;
  if (view.kind === 'off') return null;
  if (p.collapsed) {
    const count = view.kind === 'hidden' || view.kind === 'shown' ? String(view.count) : '';
    return (
      <button
        type="button"
        class={view.kind === 'banner' ? 'dot warn' : 'dot'}
        data-action="expand-pill"
        aria-label={`${summary(view)}. Show the status`}
        title="ShopBadwill"
        onClick={p.onExpand}
      >
        {count}
      </button>
    );
  }
  return (
    <div class={view.kind === 'banner' ? 'pill warn' : 'pill'} title="ShopBadwill">
      {body(view, p)}
      <button type="button" class="min" data-action="collapse-pill" aria-label="Minimize the ShopBadwill status" onClick={p.onCollapse}>
        –
      </button>
    </div>
  );
}
