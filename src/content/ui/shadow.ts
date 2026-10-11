// T-32: closed Shadow DOM hosts for our in-card UI (the tools row and the
// stub's Why? button) and for the Why? dialog's own host on the document.
// Closed: page scripts cannot reach the controls inside,
// so quick favorite/track cannot even be found by the page, let alone clicked
// (they also act on trusted clicks only). Keyboard events stop at the shadow
// root, so the page's own shortcuts do not fire while the user types in our
// controls. Everything inside is rendered by Preact as text, never markup.
import { render, type ComponentChild } from 'preact';

const roots = new WeakMap<Element, ShadowRoot>();
const ISOLATED_EVENTS = ['keydown', 'keyup', 'keypress'] as const;

/** Controls that can take focus. */
export const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

/**
 * Whether `el` is on the page and rendered: neither it nor an ancestor (across
 * shadow roots, up to the document) is `display:none`. A browser cannot focus
 * anything else, and an open modal dialog that is not rendered leaves the page
 * inert with nothing on screen.
 */
export function rendered(el: Element): boolean {
  if (!el.isConnected) return false;
  const view = el.ownerDocument.defaultView;
  let n: Element | null = el;
  while (n !== null) {
    if (n instanceof HTMLElement && n.hidden) return false;
    if (view?.getComputedStyle(n).display === 'none') return false;
    const parent: Element | null = n.parentElement;
    if (parent !== null) {
      n = parent;
      continue;
    }
    const root = n.getRootNode();
    n = root instanceof ShadowRoot ? root.host : null;
  }
  return true;
}

export interface UiHost {
  readonly host: HTMLElement;
  /** Renders (or re-renders, diffed) `vnode` into the host. */
  render(vnode: ComponentChild): void;
  /** Focuses the first rendered control inside. False when there is none, or focus did not take. */
  focusFirst(): boolean;
  /** Unmounts the Preact tree and removes the host from the page. */
  destroy(): void;
}

/** A detached `<tag>` host with a closed shadow root, a `<style>` and a Preact container. */
export function createUiHost(doc: Document, tag: string, css: string, attrs: Record<string, string>): UiHost {
  const host = doc.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) host.setAttribute(name, value);
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = css;
  const container = doc.createElement('div');
  root.append(style, container);
  for (const type of ISOLATED_EVENTS) {
    root.addEventListener(type, (e) => {
      e.stopPropagation();
    });
  }
  roots.set(host, root);
  let alive = true;
  return {
    host,
    render(vnode) {
      if (alive) render(vnode, container);
    },
    focusFirst() {
      if (!alive) return false;
      const target = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).find(rendered);
      if (target === undefined) return false;
      target.focus();
      return root.activeElement === target;
    },
    destroy() {
      if (!alive) return;
      alive = false;
      render(null, container);
      host.remove();
    },
  };
}

/** Test-only accessor: the roots are closed, so page scripts cannot reach them. */
export function uiRootForTest(host: Element | null): ShadowRoot | undefined {
  return host === null ? undefined : roots.get(host);
}
