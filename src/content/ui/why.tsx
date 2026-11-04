// T-32: the "Why?" button and its dialog. Lists, per matched rule, each
// MatchReason.detail exactly as the rules engine wrote it, and offers
// "Disable rule" (rules.disable, trusted clicks only; the activity log can undo
// it). Every string (the listing title from the page, rule names, details) is
// rendered as text.
//
// A native modal <dialog>: top layer, the page behind it inert, Escape handled
// by the browser ('cancel' -> 'close'). Focus moves in when it opens, Tab and
// Shift+Tab wrap inside it, and Escape, Close or a click on the backdrop close
// it and return focus to the Why? button.
//
// The button and the dialog are separate components (fix round 2): the card
// tools render the dialog outside their hover/focus panel. Every Why? dialog
// (the card tools' since fix round 3, the stub's since fix round 4) is rendered
// into its own closed shadow host on <html> (`useDocumentModal`), outside the
// card and the page's results. Nothing the page or a decoration does to those
// ancestors (a collapsed card, results hidden while loading or by a responsive
// layout) can hide an open modal and leave the page inert with nothing on screen.
//
// The heading follows `shown` (the decoration on the card). A stale MatchResult
// can still say `hide` after the overlay has switched the card to a highlight;
// the overlay then passes only the rules that still count.
//
// Focus (fix round 4): closing returns focus to Why? when it is on screen. When
// it is not (the card collapsed meanwhile, or the page hid it), or the dialog
// went away while focused (its rule turned off, the card re-rendered), `refocus`
// moves focus to a visible control near the card, else to the page pill.
import type { Ref, VNode } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { MatchResult } from '../../domain/rules/schema';
import type { ItemId } from '../../domain/types';
import type { MessagingClient } from '../../ports/messaging';
import { describeError } from '../../ui/components/describeError';
import { createUiHost, FOCUSABLE, rendered, type UiHost } from './shadow';
import { TOOLS_CSS } from './styles';

export interface WhyProps {
  result: MatchResult;
  /** The decoration on the card. The heading follows this, not `result.decision`. */
  shown: 'hide' | 'highlight';
  /** Display name of a rule id. */
  ruleName: (ruleId: string) => string;
  /** The listing title from the page's own data, when known (untrusted: text only). */
  title: string | null;
  /** For "Disable rule"; null hides that control. */
  client: MessagingClient | null;
  /** Focuses a visible control near the card: used when Why? itself cannot take focus back. */
  refocus?: () => void;
}

const HEADING = {
  hide: 'Why this listing is hidden',
  highlight: 'Why this listing is highlighted',
  watch: 'Why this listing matches a watch rule',
  none: 'No rule matched this listing',
} as const;
const ACTION = { hide: 'Hide', highlight: 'Highlight', watch: 'Watch' } as const;

function focusables(el: Element | null): HTMLElement[] {
  return el === null ? [] : Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
}

/** The focused element inside `el`'s own (shadow) root. */
function activeIn(el: Element | null): Element | null {
  const root: unknown = el?.getRootNode();
  return root instanceof ShadowRoot || root instanceof Document ? root.activeElement : null;
}

/** Back to the Why? button when it is on screen; otherwise `refocus` (a visible control near the card). */
export function returnFocus(button: HTMLElement | null, refocus: (() => void) | undefined): void {
  if (button !== null && rendered(button)) {
    button.focus();
    return;
  }
  refocus?.();
}

/** Once the current work is done, runs `fn` if focus was left nowhere (on the body). */
function whenFocusLost(doc: Document, fn: () => void): void {
  setTimeout(() => {
    const active = doc.activeElement;
    if (active === null || active === doc.body || active === doc.documentElement) fn();
  }, 0);
}

/**
 * Renders `dialog` (null: none) into a closed shadow host appended to <html>,
 * outside the card and the page's results. Re-renders on every commit so the
 * dialog sees fresh props. A host the page removed is replaced. Unmounting the
 * owner destroys the host, and the dialog's cleanup leaves the top layer.
 */
export function useDocumentModal(doc: Document, itemId: ItemId, dialog: VNode | null): void {
  const modal = useRef<UiHost | null>(null);
  useLayoutEffect(() => {
    if (dialog === null) {
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

export function WhyButton(props: { open: boolean; onToggle: () => void; buttonRef: Ref<HTMLButtonElement> }): VNode {
  return (
    <button
      ref={props.buttonRef}
      type="button"
      data-action="why"
      aria-haspopup="dialog"
      aria-expanded={props.open}
      onClick={props.onToggle}
    >
      Why?
    </button>
  );
}

/** The modal dialog: mounting it opens it. `onDone` runs once, after it closed (however that happened). */
export function WhyDialog({ result, shown, ruleName, title, client, refocus, onDone }: WhyProps & { onDone: () => void }): VNode {
  const [status, setStatus] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const finished = useRef(false);
  const latestRefocus = useRef(refocus);
  latestRefocus.current = refocus;

  useLayoutEffect(() => {
    const d = dialog.current;
    if (d === null) return;
    if (!d.open) {
      try {
        d.showModal();
      } catch {
        d.setAttribute('open', ''); // not connected yet, or no modal support: still usable
      }
    }
    focusables(d)[0]?.focus();
    return () => {
      // The host is going away while the modal is open (its rule turned off, the
      // card removed, the overlay stopped). Leave the top layer, and if focus was
      // in here, put it on a visible control. `onDone` already ran if the user closed it.
      // The dialog's host is a child of <html> holding nothing else, so focus is
      // in the dialog exactly when the document's (retargeted) activeElement is that host.
      const root = d.getRootNode();
      const hadFocus = root instanceof ShadowRoot && d.ownerDocument.activeElement === root.host;
      if (d.open) {
        finished.current = true;
        d.close();
      }
      const again = latestRefocus.current;
      if (hadFocus && again !== undefined) whenFocusLost(d.ownerDocument, again);
    };
  }, []);

  const finish = (): void => {
    if (finished.current) return;
    finished.current = true;
    onDone();
  };
  const close = (): void => {
    const d = dialog.current;
    if (d?.open === true) d.close(); // fires 'close' -> finish
    else finish();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const list = focusables(dialog.current);
    const first = list[0];
    const last = list[list.length - 1];
    if (first === undefined || last === undefined) {
      e.preventDefault();
      return;
    }
    const active = activeIn(dialog.current);
    const inside = active !== null && dialog.current?.contains(active) === true;
    if (e.shiftKey && (!inside || active === first)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (!inside || active === last)) {
      e.preventDefault();
      first.focus();
    }
  };

  const disable = (e: MouseEvent, ruleId: string): void => {
    if (!e.isTrusted || client === null) return;
    setStatus('…');
    client.send('rules.disable', { ruleId }).then(
      () => {
        setStatus(`Rule turned off: ${ruleName(ruleId)}. You can undo this in ShopBadwill's activity log.`);
      },
      (err: unknown) => {
        setStatus(`Not done: ${describeError(err)}`);
      },
    );
  };

  const unknown = result.unknownConditions;
  return (
    <dialog
      ref={dialog}
      class="pop"
      role="dialog"
      aria-labelledby="sbw-why-h"
      onKeyDown={onKeyDown}
      onClose={finish}
      onClick={(e) => {
        if (e.target === dialog.current) close(); // the backdrop
      }}
    >
      <div class="pop-body">
        <p id="sbw-why-h" class="pop-h">
          {HEADING[shown]}
        </p>
        {title === null ? null : <p class="pop-title">{title}</p>}
        {result.matched.map((m) => (
          <div key={m.ruleId}>
            <p class="rule">
              {ACTION[m.action]} rule: {ruleName(m.ruleId)}
            </p>
            <ul>
              {m.reasons.map((r, i) => (
                <li key={i} data-reason={String(r.conditionIndex)}>
                  {r.detail}
                </li>
              ))}
            </ul>
            {client === null ? null : (
              <button
                type="button"
                data-action="disable-rule"
                data-rule-id={m.ruleId}
                onClick={(e) => {
                  disable(e, m.ruleId);
                }}
              >
                Disable rule
              </button>
            )}
          </div>
        ))}
        {unknown > 0 ? (
          <p class="note">
            {unknown === 1 ? '1 condition' : `${String(unknown)} conditions`} could not be checked (the page did not show that
            data). An unknown condition never hides a listing.
          </p>
        ) : null}
        <p class="status" role="status" data-why-status="">
          {status}
        </p>
        <button type="button" data-action="close-why" onClick={close}>
          Close
        </button>
      </div>
    </dialog>
  );
}

/** Why? button and dialog together (the stub row, which has no hover panel). The dialog lives on the document. */
export function Why({ itemId, doc, ...props }: WhyProps & { itemId: ItemId; doc: Document }): VNode {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  useDocumentModal(
    doc,
    itemId,
    open ? (
      <WhyDialog
        {...props}
        onDone={() => {
          setOpen(false);
          returnFocus(button.current, props.refocus);
        }}
      />
    ) : null,
  );
  return (
    <span class="why">
      <WhyButton
        open={open}
        buttonRef={button}
        onToggle={() => {
          setOpen(!open);
        }}
      />
    </span>
  );
}
