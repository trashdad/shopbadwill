// T-32: the DecorationUi the overlay gives the DomAdapter. Labels are T-27's
// as is. A stub becomes a row: T-27's stub (rule name + Show) followed by our
// own closed-shadow Why? host. The row is the element the DomAdapter marks
// with data-sbw-stub and inserts before the hidden card.
//
// The overlay learns about each stub through `hooks`: which card it belongs to
// (the overlay sets `current()` around applyDecoration), a `reveal` function
// (local undo, also used by the bar's "Show"), and when the user revealed it.
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
      row.setAttribute('style', 'display:flex;align-items:center;gap:4px');
      const stub = createStub(doc, { ...spec, onShow: reveal });
      stub.setAttribute('style', 'flex:1 1 auto;min-width:0');
      const why = createUiHost(doc, 'sbw-why', TOOLS_CSS, { 'data-sbw-why': String(spec.itemId) });
      why.host.setAttribute('style', 'flex:0 0 auto');
      row.append(stub, why.host);
      if (card !== null) hooks.stubCreated(card, reveal, why);
      return row;
    },
  };
}
