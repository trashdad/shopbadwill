// T-32: CSS for the overlay's shadow roots (set as <style> text, never markup).

/**
 * Card tools, the stub's Why? button, the dim chip, badges and the Why? dialog.
 * The host takes no layout space (height 0): fixed-height cards keep their
 * "Quick Bid" line. Its content overlays the card bottom-right, growing upward:
 * a small handle, and a panel shown on hover, keyboard focus or the handle.
 */
export const TOOLS_CSS = `
:host { display: block; position: relative; height: 0; overflow: visible; z-index: 3; }
.tools { position: absolute; right: 2px; bottom: 2px; display: flex; flex-direction: column-reverse; align-items: flex-end;
  font: 11px/1.4 system-ui, sans-serif; color: #333; text-align: left; }
.handle { font: 10px/1.3 system-ui, sans-serif; padding: 0 5px; border-radius: 8px; opacity: 0.8; }
.panel { display: none; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px 6px; max-width: 280px;
  padding: 4px 6px; border: 1px solid #ddd; border-radius: 4px; background: #fff; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2); }
.tools.open .panel, :host(:hover) .panel, :host(:focus-within) .panel { display: flex; }
.badge:empty { display: none; }
.chip { display: inline-block; padding: 1px 6px; border-radius: 9px; background: #eef1f4; color: #333; white-space: nowrap; }
.chip.green { background: #1e7e34; color: #fff; } .chip.amber { background: #b35c00; color: #fff; } .chip.blue { background: #1a5fb4; color: #fff; }
.dimchip { display: inline-flex; align-items: center; gap: 4px; padding: 1px 4px 1px 8px; border-radius: 10px;
  background: #fff; color: #333; border: 1px dashed #9aa0a6; font: 11px/1.4 system-ui, sans-serif; white-space: nowrap; }
button { font: inherit; cursor: pointer; border: 1px solid #9aa0a6; border-radius: 3px; background: #fff; color: #222; padding: 1px 6px; }
button:focus-visible, input:focus-visible { outline: 2px solid #1a5fb4; outline-offset: 1px; }
.qa { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 4px; }
.qa-panel { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 4px;
  border: 1px solid #ddd; border-radius: 4px; background: #fafafa; }
.qa-panel form { display: inline-flex; gap: 4px; margin: 0; }
.qa-panel input { font: inherit; width: 9em; padding: 1px 4px; border: 1px solid #9aa0a6; border-radius: 3px; }
.status { color: #1e5e2e; }
.status:empty { display: none; }
dialog.pop { box-sizing: border-box; width: min(380px, 92vw); max-height: 70vh; overflow: auto; padding: 0; border: none;
  border-radius: 6px; background: #fff; color: #222; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.3);
  font: 13px/1.45 system-ui, sans-serif; text-align: left; }
dialog.pop::backdrop { background: rgba(0, 0, 0, 0.25); }
.pop-body { padding: 12px 14px; }
.pop-h { margin: 0 0 6px; font-weight: 600; }
.pop-title { margin: 0 0 8px; color: #555; overflow-wrap: anywhere; }
.pop .rule { margin: 6px 0 2px; font-weight: 600; overflow-wrap: anywhere; }
.pop ul { margin: 0 0 6px; padding-left: 18px; }
.pop li { overflow-wrap: anywhere; }
.pop .note { color: #6b4e00; }
.pop .status { margin: 6px 0; }
`;

/**
 * The page-level pill and its collapsed dot. Bottom-left, clear of SGW's own
 * bottom-right controls; the layout-changed alert is the pill itself (amber),
 * never a box over SGW's header.
 */
export const PAGE_CSS = `
.pill { position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; display: flex; align-items: center; gap: 6px;
  max-width: calc(100vw - 24px); padding: 4px 6px 4px 10px; border-radius: 14px; background: #1f2937; color: #fff;
  font: 12px/1.4 system-ui, sans-serif; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); }
.pill.warn { background: #b35c00; }
.pill button, .dot { font: inherit; cursor: pointer; border: 1px solid #9ca3af; border-radius: 10px; background: transparent;
  color: #fff; padding: 0 8px; }
.pill .min { padding: 0 6px; border-color: transparent; }
.dot { position: fixed; left: 12px; bottom: 12px; z-index: 2147483647; min-width: 14px; height: 14px; padding: 0 3px;
  border: none; border-radius: 7px; background: #1f2937; font: 10px/14px system-ui, sans-serif; text-align: center;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.3); opacity: 0.85; }
.dot.warn { background: #b35c00; }
.pill button:focus-visible, .dot:focus-visible { outline: 2px solid #93c5fd; outline-offset: 1px; }
`;
