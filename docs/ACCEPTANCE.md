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
   should not report already-seen items as new matches and should add no new
   `favorite.add` entries for them (the watch's seen list de-duplicates).
9. Local-only sanity: create a second watch with **favorites: track in
   ShopBadwill only** and run it: its matches appear in the audit as tracked
   items, with no `favorite.add` entries at all.

10. **Opt-in live favorite.** Only if you want this exact step. A live run
    favorites EVERY new match of EVERY watch set to favorite on ShopGoodwill,
    and items an earlier run already saw are not new, so first narrow it to
    one item:
    - Disable (or switch to "track in ShopBadwill only") every other watch
      that favorites on ShopGoodwill.
    - Create a fresh rule whose keyword matches only ONE open item you are
      happy to favorite (for example its exact, unusual title), and a fresh
      watch for a search that shows it, using that rule. Run it once in
      dry-run first: the audit must show exactly one dry-run `favorite.add`.
      If it shows more, narrow the rule and use another fresh watch.
    - Delete that watch and create it again (so the item is new to it), then
      turn **dry-run for favorites OFF** in the options page.
    - Press **Run now** (or wait for the scheduled run); as soon as the run
      finishes, turn dry-run back ON.
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

## A-3 Calendar (Phase 3)

Purpose: with your own Google project, tracked auction ends land on a
dedicated "ShopGoodwill Auctions" calendar with popups 60, 15 and 5 minutes
before the end; **the popups arrive on your phone with the PC off**; an
extended auction moves its event; removing an item deletes its event; and
Disconnect really revokes the grant at Google.

Everything here writes only to the dedicated calendar ShopBadwill creates
(the extension's permission is `calendar.app.created`: it cannot see or
change your other calendars). The only live step is turning **Dry run:
calendar** off at step 6; you can turn it back on at the end.

Never paste your client secret, tokens, or your Google account name into
anything you share. Paste back only the results asked for under **Record**.

**Setup**

1. Build and load the extension (Chrome: `pnpm build`, Load unpacked
   `.output/chrome-mv3`; Firefox: `pnpm build:firefox`, temporary install).
2. Have your own Google Cloud project with the Calendar API enabled and an
   OAuth client (Chrome: **Web application**, redirect URI
   `https://<your-extension-id>.chromiumapp.org/`; Firefox: **Desktop app**).
   The setup guide (`docs/SETUP-GOOGLE.md`, T-73) has the full steps. Publish
   the app (**In production**) first, so the grant does not lapse after 7 days.
3. On your phone, install the Google Calendar app signed in to the same
   Google account, with notifications allowed for it.

**Checks** (run on Chrome; then repeat steps 4–5 and 12 on Firefox)

4. Options page → **Google Calendar**: paste the client ID and secret, press
   **Connect to Google Calendar**, and approve the single calendar permission
   on Google's screen ("Google hasn't verified this app" → Advanced → Go to
   ShopBadwill is expected for a personal project). The section shows
   **Connected**, the permission `.../auth/calendar.app.created`, and
   "Last error: None".
5. Answer **Turn on calendar events now?** (or switch on **Add auction ends to
   Google Calendar**). Open calendar.google.com: a new calendar named
   **ShopGoodwill Auctions** appears in your list. Nothing appears in your
   primary calendar.
6. Options page → **Settings** → Dry run (practice mode): turn **Dry run:
   calendar** OFF. While it is on, the **Activity** log shows
   `calendar.insert` entries marked **dry-run** and nothing reaches Google;
   check that first if you like.
7. On a real ShopGoodwill item page, open the item's **Actions** and press
   **Track** for one auction that ends in about 1½–3 hours. In the dashboard
   (side panel) → **Calendar**, press **Sync now**.
8. On calendar.google.com, open the new event: it is on **ShopGoodwill
   Auctions**, starts at the auction's end time, links to the item, and has
   three popup notifications: **60, 15 and 5 minutes** before.
9. **Phone with the PC off.** On the phone, open Google Calendar → Settings →
   the ShopGoodwill Auctions calendar: it is synced (shown) and its
   notifications are on. Then shut the PC down (or put it to sleep) more than
   an hour before the auction ends, and leave it off until after the end. The
   60-, 15- and 5-minute popups arrive on the phone on time.
10. **End-time change.** Opportunistic: if a tracked auction is extended at
    the end (bids in the last minutes), ShopBadwill reads it again a few
    minutes after its original end (the browser must be open) and the event
    moves to the new end. It is the same event (one entry, not two), still
    with its three popups.
11. **Removing an item deletes its event.** Options → **Activity** → the
    `calendar.insert` entry for a tracked item → **Undo**. The event
    disappears from ShopGoodwill Auctions; your other events, including any
    you added to that calendar yourself, are untouched.
12. **Disconnect revokes.** Options → Google Calendar → **Disconnect** → **Yes,
    disconnect**. Open myaccount.google.com/connections (Third-party apps
    with account access): your ShopBadwill project is no longer listed.
    Events already created stay on the calendar (expected).
13. Optional, the lost-grant path. Connect again, then remove ShopBadwill at
    myaccount.google.com/connections while the browser stays open, track one
    more auction and press **Sync now**: the toolbar badge shows **!**, the
    dashboard says Google needs you to reconnect and the new item waits as
    pending, and nothing new appears on Google. Press **Reconnect Google** in
    the options page and approve: the badge clears and the waiting event
    appears once (not twice).

**Record**

Paste back: the browser(s) tested, whether ShopGoodwill Auctions appeared
(and nothing landed in the primary calendar), the three popup offsets you saw
on the event, whether the phone popups arrived with the PC off (and which of
60/15/5 you saw), whether an end-time change was observed (and that it moved
the same event), that Undo removed the event, that the app left the
connections page after Disconnect, and the result of step 13 if you ran it.
Never paste the client secret, tokens or account details.

## A-5 First real snipe (Phase 5)

This is the first time the extension places a real bid with real money. Do it once, on a cheap item you would be happy to win. Each later live snipe needs your own decision too.

**Before you start, make sure all of these are true:**
- The A-1 to A-3 checklists passed on this browser profile.
- You have done at least 5 dry-run snipes. The extension counts them, and the live gate refuses until it has 5. The Timing page shows an on-time rate. If that rate is under 95 %, the extension will ask you to type a confirmation.
- You are signed in to shopgoodwill.com in this browser profile. Never paste your password, cookies or tokens anywhere else.
- Your computer will be awake at the auction's end: you are at the machine, or keep-awake (T1) or the Windows companion (T2) is set up per `docs/COMPANION.md`.

### Steps
1. **Pick the item.** Choose one cheap auction ending in more than 2 hours, with a current price well under $10. Write down its item number and end time, then check the end time on the item page. Be ready to win it and pay for it, shipping included.
2. **Set the caps to this one item.** Go to Options → Snipe:
   - per-item cap = your max for this item, e.g. $8.00;
   - daily cap = the same amount;
   - open exposure cap = the same amount.
   
   No other snipe can then spend anything today.
3. **Arm it as a dry run first.** On the dashboard's Snipes page, prepare the item. Then:
   - Check the confirmation. It must show your max, the estimated total with shipping and handling, and the end date and time in both your time zone and ShopGoodwill's Pacific time.
   - Arm it with "DRY RUN" still showing.
4. **Turn live bidding on, for this snipe only.**
   - In the popup's Live bidding section, read the warning and type the confirmation.
   - Disarm the dry-run snipe, then arm it again. The confirmation must NOT say "DRY RUN" this time.
   - The exposure meter must show your max against the daily cap.
5. **Leave it alone.** Do not bid on this item yourself on the site, since that would compete with the snipe. Leave the browser open, or rely on T1/T2.
6. **After the end:**
   - The notification says Won, Lost or Unconfirmed. An Unconfirmed result means the outcome could not be read. Check the item on ShopGoodwill; never re-bid blindly.
   - On the dashboard's Timing page, save the JSON export. It contains timing data only, with no bid amounts.
   - On your dedicated ShopGoodwill calendar, check the event title: it should read `WON $x` or `LOST`.
   - In Activity, the audit log should show exactly one `bid` entry for this snipe, or two if the safe retry ran. A second entry always has the same amount.
7. **Turn live bidding back off** (one click in the popup) until you decide on the next live snipe.

### Sign-off
Copy this text, fill it in, and keep it with your own notes. Never paste it anywhere public.

```
A-5 first real snipe — I approved this specific bid.
Item: ______________   End (Pacific): ______________
My max: $______   Caps set to: per-item $____ / daily $____ / exposure $____
Result: Won / Lost / Unconfirmed   Final price: $______
Calendar stamp correct: yes / no   Timing export saved: yes / no
Audit shows one bid (or one proven-safe retry with the same amount): yes / no
Live bidding turned back off afterwards: yes / no
Signed: ______________   Date: ______________
```

If anything looks wrong, turn on the kill switch (Alt+Shift+K, or the popup), keep the timing export, and report what you saw.
