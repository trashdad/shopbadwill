// T-32: CSS for the overlay's shadow roots (set as <style> text, never markup).

/** Card tools row, the stub's Why? button, badges and the Why? dialog. */
export const TOOLS_CSS = `
:host { display: block; }
.tools { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 6px; margin: 4px 0;
  font: 11px/1.4 system-ui, sans-serif; color: #333; text-align: left; }
.badge:empty { display: none; }
.chip { display: inline-block; padding: 1px 6px; border-radius: 9px; background: #eef1f4; color: #333; white-space: nowrap; }
.chip.green { background: #1e7e34; color: #fff; } .chip.amber { background: #b35c00; color: #fff; } .chip.blue { background: #1a5fb4; color: #fff; }
button { font: inherit; cursor: pointer; border: 1px solid #9aa0a6; border-radius: 3px; background: #fff; color: #222; padding: 1px 6px; }
button:focus-visible, input:focus-visible { outline: 2px solid #1a5fb4; outline-offset: 1px; }
.qa { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.qa-panel { flex-basis: 100%; display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding: 4px;
  border: 1px solid #ddd; border-radius: 4px; background: #fafafa; }
.qa-panel form { display: inline-flex; gap: 4px; margin: 0; }
.qa-panel input { font: inherit; width: 9em; padding: 1px 4px; border: 1px solid #9aa0a6; border-radius: 3px; }
.status { color: #1e5e2e; }
.status:empty { display: none; }
.backdrop { position: fixed; inset: 0; z-index: 2147483646; background: rgba(0, 0, 0, 0.25); }
.pop { position: fixed; z-index: 2147483647; top: 15vh; left: 50%; transform: translateX(-50%);
  box-sizing: border-box; width: min(380px, 92vw); max-height: 70vh; overflow: auto; padding: 12px 14px;
  border-radius: 6px; background: #fff; color: #222; box-shadow: 0 8px 28px rgba(0, 0, 0, 0.3);
  font: 13px/1.45 system-ui, sans-serif; text-align: left; }
.pop-h { margin: 0 0 6px; font-weight: 600; }
.pop-title { margin: 0 0 8px; color: #555; overflow-wrap: anywhere; }
.pop .rule { margin: 6px 0 2px; font-weight: 600; overflow-wrap: anywhere; }
.pop ul { margin: 0 0 6px; padding-left: 18px; }
.pop li { overflow-wrap: anywhere; }
.pop .note { color: #6b4e00; }
`;

/** The page-level pill ("N hidden · Show") and the layout-changed banner. */
export const PAGE_CSS = `
.pill { position: fixed; right: 12px; bottom: 12px; z-index: 2147483647; display: flex; align-items: center; gap: 6px;
  padding: 4px 10px; border-radius: 14px; background: #1f2937; color: #fff; font: 12px/1.4 system-ui, sans-serif;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); }
.pill button { font: inherit; cursor: pointer; border: 1px solid #9ca3af; border-radius: 10px; background: transparent;
  color: #fff; padding: 0 8px; }
.pill button:focus-visible { outline: 2px solid #93c5fd; outline-offset: 1px; }
.banner { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483647; padding: 8px 14px;
  border-radius: 6px; background: #b35c00; color: #fff; font: 13px/1.4 system-ui, sans-serif;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25); }
`;
