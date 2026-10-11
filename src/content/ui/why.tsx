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
// tools render the dialog OUTSIDE their hover/focus panel, so the dialog never
// depends on that panel being visible (a hidden ancestor would leave an inert,
// invisible modal). `Why` is the two together, for hosts without such a panel.
import type { Ref, VNode } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { MatchResult } from '../../domain/rules/schema';
import type { MessagingClient } from '../../ports/messaging';
import { describeError } from '../../ui/components/describeError';

export interface WhyProps {
  result: MatchResult;
  /** Display name of a rule id. */
  ruleName: (ruleId: string) => string;
  /** The listing title from the page's own data, when known (untrusted: text only). */
  title: string | null;
  /** For "Disable rule"; null hides that control. */
  client: MessagingClient | null;
}

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
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
export function WhyDialog({ result, ruleName, title, client, onDone }: WhyProps & { onDone: () => void }): VNode {
  const [status, setStatus] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const finished = useRef(false);

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
          {HEADING[result.decision]}
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

/** Why? button and dialog together (the stub row, which has no hover panel). */
export function Why(props: WhyProps): VNode {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <span class="why">
      <WhyButton
        open={open}
        buttonRef={button}
        onToggle={() => {
          setOpen(!open);
        }}
      />
      {open ? (
        <WhyDialog
          {...props}
          onDone={() => {
            setOpen(false);
            button.current?.focus();
          }}
        />
      ) : null}
    </span>
  );
}
