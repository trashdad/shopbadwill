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

## A-2 Daily job (Phase 2)

Purpose: a watch runs overnight in dry-run with the browser open, catches up
after a closed-browser day, and one user-chosen item is favorited live (then
undone) — all without the user's account being written to otherwise.

No live writes happen unless you opt in at step 10. Steps 1–9 are read-only
and dry-run: the extension never favorites anything on your account there.

**Setup**

1. Build and load the extension (Chrome: `pnpm build`, Load unpacked
   `.output/chrome-mv3`; Firefox: `pnpm build:firefox`, temporary install).
2. Sign in to shopgoodwill.com in that browser (so the extension can pick up
   your session for the live step later; it is not used before step 10).
3. In the options page, create a **watch** rule (a keyword you expect to match
   a few results), then create a **watch** for a search that matches it
   ("Use my current tab" or "Paste a search address").
4. Keep **dry-run for favorites on** (the default) in the daily-run section.

**Checks**

5. Open the health panel (options page) and note the request counts, then
   leave the browser open with at least one ShopGoodwill tab; the daily run
   fires at the configured time (default 07:00). You can also press **Run now**
   in the watches section and watch the progress line advance step by step.
6. After the run finishes, open the audit log in the options page. You should
   see: a `job.run.done` entry naming the run; `favorite.add` entries marked
   **dry-run** for every new match; and **zero** `favorite.add` entries
   without the dry-run mark. In DevTools, filter requests to
   `buyerapi.shopgoodwill.com`: there must be **zero** `AddToFavorite` or
   `Favorite/Save` calls. Consecutive background requests (the health panel's
   log) must be at least 120 s apart.
7. Closed-browser catch-up: close the browser for at least one whole day (with
   the watch due daily), then reopen it. The next run should be marked
   **catch-up** in the audit log (`job.run.done`, trigger `catch-up`), run the
   watch once, and move its next run time to the next daily slot.
8. Repeat the overnight check once more if convenient: the next day's run
   should re-report the same already-seen items without duplicate favorites
   (the watch's seen ring de-duplicates).
9. Local-only sanity: create a second watch with **favorites: track in
   ShopBadwill only** and run it: its matches appear in the audit as tracked
   items, with no `favorite.add` entries at all.

10. **Opt-in live favorite.** Pick ONE item the dry-run just matched, and
    confirm you want this exact step:
    - Turn **dry-run for favorites OFF** in the options page.
    - Press **Run now** (or wait for the scheduled run), then immediately turn
      dry-run back ON.
    - Check your ShopGoodwill favorites: that one item is there, and nothing
      else was added by the extension.
    - In the audit log, find the `favorite.add` entry for that item (no
      dry-run mark, with an **Undo** action) and click Undo; confirm the item
      leaves your ShopGoodwill favorites.

**Record**

Paste back: the watch name, the run's trigger (`scheduled` / `catch-up`), the
number of dry-run `favorite.add` entries, the health-panel spacing you saw,
whether catch-up worked after the closed-browser day, the one item id you
favorited live, and that Undo removed it. Never paste tokens, cookies or
account details.

---

<!-- A-3 (T-72) and the consolidated sections land later; T-73 owns the final file. -->
