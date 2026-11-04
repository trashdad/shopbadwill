// T-32: the DecorationUi the overlay gives the DomAdapter. Labels are T-27's
// as is. A stub becomes a row the DomAdapter marks with data-sbw-stub and
// inserts before the hidden card:
//  - collapse: T-27's stub (rule name + Show) followed by our closed-shadow
//    Why? host;
//  - dim (fix round 1): a zero-height row whose small "Hidden by <rule> · Show"
//    chip and Why? host overlay the faded card's top-left corner, so the page
//    layout does not move.
//
// The overlay learns about each stub through `hooks`: which card it belongs to
// (the overlay sets `current()` around applyDecoration), a `reveal` function
// (local undo, also used by the bar's "Show"), and when the user revealed it.
import { h, type VNode } from 'preact';

import type { DecorationUi } from '../../adapters/sgw/dom-adapter';
import type { CardHandle } from '../../ports/sgw-dom';
import { createUiHost, type UiHost } from './shadow';
import { createLabel, createStub } from './stub';
import { TOOLS_CSS } from './styles';

export interface StubHooks {
  /** The card being decorated right now, or null. */
  current(): CardHandle | null;
  /** A stub was created for `card`; `why` is the empty host for its Why? button. */
  stubCreated(card: CardHandle, reveal: () => void, why: UiHost): void;
  /** `card` was re-shown (its stub's Show, or the bar's Show). */
  revealed(card: CardHandle): void;
}

/** The dim stub: rule name as text, and Show. */
function DimChip(props: { ruleName: string; onShow: () => void }): VNode {
  return h(
    'span',
    { class: 'dimchip', role: 'note' },
    h('span', null, `Hidden by ${props.ruleName}`),
    ' · ',
    h('button', { type: 'button', 'data-action': 'show-card', onClick: props.onShow }, 'Show'),
  );
}

export function createOverlayDecorationUi(hooks: StubHooks): DecorationUi {
  return {
    createLabel,
    createStub(doc, spec) {
      const card = hooks.current();
      let shown = false;
      const reveal = (): void => {
        if (shown) return;
        shown = true;
        spec.onShow();
        if (card !== null) hooks.revealed(card);
      };
      const row = doc.createElement('sbw-stub-row');
      const why = createUiHost(doc, 'sbw-why', TOOLS_CSS, { 'data-sbw-why': String(spec.itemId) });
      if (spec.style === 'dim') {
        row.setAttribute('style', 'display:block;position:relative;height:0;overflow:visible;z-index:4');
        const bar = doc.createElement('sbw-chip-bar');
        bar.setAttribute('style', 'position:absolute;top:4px;left:4px;display:flex;align-items:center;gap:4px');
        const chip = createUiHost(doc, 'sbw-chip', TOOLS_CSS, { 'data-sbw-chip': String(spec.itemId) });
        chip.host.setAttribute('style', 'height:auto');
        why.host.setAttribute('style', 'height:auto');
        chip.render(h(DimChip, { ruleName: spec.ruleName, onShow: reveal }));
        bar.append(chip.host, why.host);
        row.append(bar);
      } else {
        row.setAttribute('style', 'display:flex;align-items:center;gap:4px');
        const stub = createStub(doc, { ...spec, onShow: reveal });
        stub.setAttribute('style', 'flex:1 1 auto;min-width:0');
        why.host.setAttribute('style', 'flex:0 0 auto;height:auto');
        row.append(stub, why.host);
      }
      if (card !== null) hooks.stubCreated(card, reveal, why);
      return row;
    },
  };
}
