// T-27: our own UI for decorated SGW cards. Every element lives in a Shadow DOM
// (closed: page scripts cannot reach it; no CSS leaks either way) and every string from the site
// or a rule is set as text, never as markup.
import type { DecorationUi, LabelSpec, StubSpec } from '../../adapters/sgw/dom-adapter';

const STUB_CSS = `
:host { display: block; }
.stub { box-sizing: border-box; display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  margin: 2px 0; border: 1px dashed #9aa0a6; border-radius: 4px; background: #f6f6f6;
  color: #444; font: 12px/1.3 system-ui, sans-serif; }
.text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button { font: inherit; cursor: pointer; border: 1px solid #9aa0a6; border-radius: 3px; background: #fff; color: #222; padding: 1px 8px; }
`;

const LABEL_CSS = `
:host { display: block; }
.row { display: flex; flex-wrap: wrap; gap: 4px; margin: 2px 0; font: 11px/1.3 system-ui, sans-serif; }
.chip { padding: 1px 6px; border-radius: 9px; color: #fff; background: #5f6368; }
.green { background: #1e7e34; } .amber { background: #b35c00; } .blue { background: #1a5fb4; }
`;

const roots = new WeakMap<Element, ShadowRoot>();

/** Test-only accessor: the roots are closed, so page scripts cannot reach them. */
export function shadowRootForTest(host: Element | null): ShadowRoot | undefined {
  return host === null ? undefined : roots.get(host);
}

function shadowHost(doc: Document, tag: string, css: string): { host: HTMLElement; root: ShadowRoot } {
  const host = doc.createElement(tag);
  const root = host.attachShadow({ mode: 'closed' });
  const style = doc.createElement('style');
  style.textContent = css;
  root.append(style);
  roots.set(host, root);
  return { host, root };
}

export function createStub(doc: Document, spec: StubSpec): Element {
  const { host, root } = shadowHost(doc, 'sbw-stub', STUB_CSS);
  const box = doc.createElement('div');
  box.className = 'stub';
  box.setAttribute('role', 'note');
  const text = doc.createElement('span');
  text.className = 'text';
  text.textContent = `Hidden by rule: ${spec.ruleName}`;
  const show = doc.createElement('button');
  show.type = 'button';
  show.textContent = 'Show';
  show.addEventListener('click', () => {
    spec.onShow();
  });
  box.append(text, show);
  root.append(box);
  return host;
}

export function createLabel(doc: Document, spec: LabelSpec): Element {
  const { host, root } = shadowHost(doc, 'sbw-label', LABEL_CSS);
  const row = doc.createElement('div');
  row.className = 'row';
  for (const c of spec.chips) {
    const chip = doc.createElement('span');
    chip.className = c.tone === undefined ? 'chip' : `chip ${c.tone}`;
    chip.textContent = c.text;
    if (c.title !== undefined) chip.title = c.title;
    row.append(chip);
  }
  root.append(row);
  return host;
}

export const decorationUi: DecorationUi = { createStub, createLabel };
