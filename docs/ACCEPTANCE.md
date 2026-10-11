# ShopBadwill acceptance checklists

Manual checks against the real site and your real browser. One checklist per
phase; run each on a personal-use install (see `docs/SETUP-CHROME.md` /
`docs/SETUP-FIREFOX.md`). T-73 consolidates these into the release checklist.

Never paste tokens, passwords or cookies into anything you share. Paste back
only the results asked for (counts, texts, outcomes).

## A-1 Overlay (Phase 1)

Purpose: on a real search page, rules behave as previewed; the overlay never
breaks the page and never makes its own requests.

**Setup**

1. Build and load the extension (Chrome: `pnpm build`, Load unpacked
   `.output/chrome-mv3`; Firefox: `pnpm build:firefox`, temporary install).
2. Open the options page and create two rules:
   - a **highlight** rule (any colour) with one keyword condition you expect to
     match some results;
   - a **hide** rule with a different keyword.
3. Open a real search page (`shopgoodwill.com/categories/listing?st=...`).

**Checks**

1. Matched listings are highlighted (coloured outline + the rule's name), and
   the hide rule's matches are collapsed to a stub row naming the rule.
2. The status pill shows the hidden count (for example "ShopBadwill: 3 hidden")
   with a **Show** button.
3. Click **Show**: every hidden card comes back into view and the pill now
   offers **Hide again**.
4. Open **Why?** on a hidden card (the stub's button) and on a highlighted card
   (hover the card, then the tools row): each dialog names the rule(s) and the
   decision, and both **Escape** and the close button dismiss it; the page is
   still clickable afterwards.
5. Change page with the site's paginator (or change the search): the
   decorations appear again on the fresh cards, and stale decorations are gone.
6. Flip the kill switch (popup button, or **Alt+Shift+K**): all decorations
   clear and the pill shows "ShopBadwill paused (kill switch)". Resume and
   confirm the decorations come back after a moment.
7. Open the browser's console: no errors are logged by the extension
   (ShopBadwill errors appear as `[ShopBadwill] ...`).
8. Network check: in DevTools, filter requests to `buyerapi.shopgoodwill.com`.
   On a plain page view there must be **zero** extension-initiated requests
   (the page's own search call is fine; it is anonymous and page-initiated).

**Record**

Paste back: the two rule names, the highlight/hide counts you saw, the Why?
text for each dialog, and whether any step failed.

---

<!-- A-2 (T-59), A-3 (T-72) and the consolidated sections land later; T-73 owns the final file. -->
