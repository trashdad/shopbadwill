// T-32: the "Why?" button and its dialog. Lists, per matched rule, each
// MatchReason.detail exactly as the rules engine wrote it. Every string (the
// listing title from the page, rule names, details) is rendered as text.
// The dialog is modal: focus moves in when it opens, Tab and Shift+Tab wrap
// inside it, and Escape (or Close, or the backdrop) closes it and returns focus
// to the Why? button.
import type { VNode } from 'preact';
import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import type { MatchResult } from '../../domain/rules/schema';

export interface WhyProps {
  result: MatchResult;
  /** Display name of a rule id. */
  ruleName: (ruleId: string) => string;
  /** The listing title from the page's own data, when known (untrusted: text only). */
  title: string | null;
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

export function Why({ result, ruleName, title }: WhyProps): VNode {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (open) focusables(dialog.current)[0]?.focus();
  }, [open]);

  const close = (): void => {
    setOpen(false);
    button.current?.focus();
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

  const unknown = result.unknownConditions;
  return (
    <span class="why">
      <button
        ref={button}
        type="button"
        data-action="why"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        Why?
      </button>
      {open ? (
        <>
          <div class="backdrop" onClick={close} />
          <div ref={dialog} class="pop" role="dialog" aria-modal="true" aria-labelledby="sbw-why-h" onKeyDown={onKeyDown}>
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
              </div>
            ))}
            {unknown > 0 ? (
              <p class="note">
                {unknown === 1 ? '1 condition' : `${String(unknown)} conditions`} could not be checked (the page did not show
                that data). An unknown condition never hides a listing.
              </p>
            ) : null}
            <button type="button" data-action="close-why" onClick={close}>
              Close
            </button>
          </div>
        </>
      ) : null}
    </span>
  );
}
