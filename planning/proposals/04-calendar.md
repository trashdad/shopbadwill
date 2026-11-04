# 04-calendar — Google Calendar, Auth & Notifications

Author role: Google Calendar, auth & notifications integrator. Research date: 2026-10-07.
Legend: **[V]** = verified against a primary source (date given where the page shows one); **[R]** = reported by secondary sources / forums, not confirmed; **[U]** = unverified, must be proven in a spike.

## Research Findings

### A. Extension OAuth mechanics (Chrome vs Firefox)

1. **`chrome.identity.getAuthToken` is Chrome-only** [V]. It reads `client_id` + `scopes` from the manifest `oauth2` key, caches access tokens in memory, and "the token cache automatically handles expiration". With `interactive:false` it "will return failure any time a prompt would be required". Fetching a token "may require the user to sign-in to Chrome". On a 401, pass the token to `removeCachedAuthToken` and retry. `clearAllCachedAuthTokens` (Chrome 87+) works as a full sign-out. There is no runtime `client_id` parameter, so the client ID has to be in the manifest, which means injecting it at build time. Source: https://developer.chrome.com/docs/extensions/reference/api/identity (updated 2026-09-11).
2. **The getAuthToken client must be a "Chrome Extension" OAuth client** whose *Item ID* equals the extension ID [V]. The extension ID has to stay stable through the manifest `"key"` field. Chrome's tutorial gets the key by uploading an unpublished draft to the Chrome Web Store dashboard. Source: https://developer.chrome.com/docs/extensions/how-to/integrate/oauth. A key pair generated locally also yields a stable ID [R, standard practice]. Google's native-app page says the CWS item is required for *ownership verification* (https://developers.google.com/identity/protocols/oauth2/native-app). Whether a personal-use client needs that is [U].
3. **getAuthToken is unreliable outside Google Chrome** [R]. Brave returns 400 errors (https://community.brave.com/t/chrome-identity-getauthtoken-does-not-work-even-when-disabling-the-security-rule/576426). Edge developers fall back to launchWebAuthFlow and hit 1-hour tokens (https://techcommunity.microsoft.com/discussions/edgeinsiderdiscussions/edge-extensions----chrome-identity-api-is-not-a-good-ux/4160103).
4. **Firefox implements only `identity.getRedirectURL()` and `identity.launchWebAuthFlow()`** [V]. There is no getAuthToken. `getRedirectURL()` derives `https://<hash>.extensions.allizom.org/` from the add-on ID, so `browser_specific_settings.gecko.id` must be set or the URL changes on every temporary install. MDN explicitly warns: "Some OAuth servers (such as Google) only accept domains with a verified ownership as the redirect URL." **From Firefox 86, a loopback redirect `http://127.0.0.1/mozoauth2/<subdomain of getRedirectURL()>` is allowed** (RFC 8252 §7.3). Source: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/identity. Forum threads show Google rejecting the allizom/moz-extension redirect in Google-Calendar ports (https://discourse.mozilla.org/t/how-to-integrate-google-oauth-for-calendar-access-in-firefox-extension-previously-successful-in-chrome/134818, Aug 2024, unanswered; https://discourse.mozilla.org/t/firefox-webextension-and-oauth-browser-identity-getredirecturl-with-google-resolved/42362).
5. **Google still supports loopback redirects only for the *Desktop app* client type.** Loopback is deprecated for the iOS, Android and Chrome-app types, and custom URI schemes are no longer supported [V]. Sources: https://developers.google.com/identity/protocols/oauth2/resources/loopback-migration and the native-app page. Google documents `http://127.0.0.1:port` and does not say whether a path like `/mozoauth2/...` or a port-less URI is accepted [U]. **Firefox + Desktop client + loopback is the most promising Firefox route, but it must be proven in a spike.**
6. **launchWebAuthFlow in Chrome** completes on a redirect to `https://<ext-id>.chromiumapp.org/*` [V]. Chrome 113+ adds `abortOnLoadForNonInteractive` and `timeoutMsForNonInteractive` for silent flows [V]. Using a Google *Web application* client with a chromiumapp.org redirect is a widely used pattern [R]. Web-client redirect URIs must be HTTPS on a public-suffix-list domain [V, https://developers.google.com/identity/protocols/oauth2/web-server].
7. **Silent re-auth via the implicit flow is unreliable in Firefox** [R]. A background call with `interactive:false` fails with "Requires user interaction" even after a prior grant (https://discourse.mozilla.org/t/browser-identity-launchwebauthflow-always-needs-to-be-interactive/37324). MDN's own Google example uses the implicit flow (`response_type=token`) with `interactive:true`. Implicit tokens last about 1 hour and come with no refresh token. **Conclusion: an unattended daily run needs auth code + PKCE + `access_type=offline` and a stored refresh token** (or getAuthToken on Chrome).
8. **PKCE**: Google supports S256 (verifier 43–128 chars) [V, native-app page]. **client_secret**: Google documents it as "Optional" in the token exchange [V], but tests report "client_secret is missing" for *Web application* clients even when PKCE is used [R, https://ktaka.blog.ccmp.jp/2025/07/oogle-oauth2-and-pkce-understanding.html, 2025-07-07]. Desktop clients get an auto-generated secret that is treated as non-confidential [R, https://discuss.google.dev/t/is-it-ok-to-put-a-client-secret-in-a-desktop-app/296820]. For a personal bring-your-own-project setup, a secret entered in the options page at runtime is acceptable. It must never be committed to the public MIT repo.
9. **Google pages now mention DPoP-bound refresh tokens** and the need for `prompt=consent` to re-issue a refresh token [V, native-app and web-server pages]. A refresh token is returned only on the first authorization unless consent is forced. Plan on `prompt=consent` for an explicit (re)connect.

### B. Google consent-screen, verification & token lifetime

10. **The 7-day expiry is confirmed** [V]: a project whose publishing status is "Testing" "is issued a refresh token expiring in 7 days", unless it requests only name/email/profile scopes. Also: "limit of 100 refresh tokens per Google Account per OAuth 2.0 client ID". Reaching the limit silently invalidates the oldest. Tokens also die when time-based access expires. Source: https://developers.google.com/identity/protocols/oauth2 (updated 2026-05-26). After the move to production, refresh tokens "generally don't expire unless they are revoked" [V, https://developers.google.com/health/setup]. Tokens issued while in Testing keep their 7-day life, so the user has to re-auth after publishing [R].
11. **Testing status** has "a hard cap of 100 test users", and only allow-listed users can sign in. **Published-but-unverified** apps that request sensitive or restricted scopes have "a hard cap of 100 total users" [V, https://developers.google.com/identity/protocols/oauth2/production-readiness/overview]. A Workspace admin marking the app Trusted overrides the 7-day limit [V, same page].
12. **Personal-use exemption** [V]: verification is not required "If the app is for your personal use (fewer than 100 users)". Users "will be allowed to click through 'unverified app' warning screens during sign-in". Internal (Workspace/Cloud Identity org) apps are also exempt. Source: https://support.google.com/cloud/answer/13464323. The cap is "100 new users in total" (https://support.google.com/cloud/answer/7454865).
13. **⇒ Personal-use path**:
    - The user creates their own GCP project, enables the Calendar API, and sets the consent screen to External.
    - They add themselves as a test user and create the OAuth client(s).
    - Then they **Publish → "In production" and do not submit for verification**. This avoids the 7-day expiry, at the cost of clicking through the unverified-app warning once.
    - The fallback is to stay in Testing and re-consent weekly. The extension must detect `invalid_grant` and nudge.
    - Whether `getAuthToken`'s Chrome-managed tokens are affected by Testing mode is [U].
14. **Scope sensitivity**: `calendar.events` ("View and edit events on all your calendars") is listed as *sensitive* on the console Data Access page [R, https://discuss.google.dev/t/oauth-verification-pending-since-22-apr-2026-first-trust-safety-email-never-received/392005]. One Nylas guide claims *restricted* [R]. **`calendar.app.created`** ("Make secondary Google calendars, and see, create, change, and delete events on them") is accepted by `calendars.insert`, `events.insert` and `events.list` [V, Calendar reference pages], so it is the least-privilege choice. Its sensitivity class is **not published** [U]: the official scopes page has only Scope/Meaning columns (https://developers.google.com/workspace/calendar/api/auth). `calendar.events.owned` is another narrower option [V].
15. **Granular consent**: Google shows per-scope checkboxes when an app requests more than one non-sign-in scope, or sign-in plus non-sign-in scopes. A single non-sign-in scope gets an all-or-nothing screen [R, https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions]. ⇒ Request exactly one Calendar scope, don't add `openid email`, and still verify the granted `scope` field.

### C. Calendar API behaviour

16. **Reminders** [V]: `reminders.useDefault` (bool) and `reminders.overrides[]` with `method` = `email` | `popup` and `minutes` 0–40320. **"The maximum number of override reminders is 5."** 60/15/5 popup uses 3 slots, leaving 2 spare (e.g., an email at 60). Source: https://developers.google.com/calendar/api/v3/reference/events
17. **Reminders are relative to event *start***, so the event must *start* at the auction end time and end N minutes later. An event that "ends at" the auction end would fire the 5-minute popup too early (design inference from reminder semantics).
18. **Event IDs** [V]: base32hex only, meaning **lowercase a–v** and digits 0–9, length 5–1024, unique per calendar. Collisions are "not guaranteed" to be detected at creation. **Gotcha:** prefixes like `sgw…` are invalid because `w` is outside a–v. A 409 on insert means the ID already exists [R, https://cli.nylas.com/guides/google-calendar-api-error-codes.md], so treat it as "exists → get → patch". Deleted events persist as `status:"cancelled"` (visible with `showDeleted`) [V, events.list], so a deterministic ID re-used after a delete probably collides. Whether patching a cancelled event back to `confirmed` revives it is [U].
19. **Lookup & metadata** [V]: `extendedProperties.private` (string map, private to this calendar's copy), queried with `events.list?privateExtendedProperty=sgwItemId=123`. `source.{url,title}` must be http(s) and is visible only to the creator. `colorId` "is superseded by" `eventLabelId` (new; noted on the 2026 reference page). `transparency:"transparent"` keeps the event from blocking time. `sendUpdates` defaults to false.
20. **Time** [V]: `start.dateTime` is RFC 3339 and needs an offset unless `timeZone` (IANA) is given.
21. **ShopGoodwill end times are naive local Pacific times.** The `endTime` field is ISO without an offset. The site "simply trims the 'PDT' (or PST?)", so the scripts interpret it as `America/Los_Angeles`. Fractional seconds are inconsistent (`'2025-04-29T23:00:17.45'` vs `'2025-05-01T22:09:00'`). Bid responses say "…ends at … PM PT". Source: code in https://github.com/scottmconway/shopgoodwill-scripts (`shopgoodwill.py`, `bid_sniper.py`; last commit 2025-08-11, which switched `US/Pacific`→`America/Los_Angeles`) [R, observed in third-party code; re-verify live].
22. **ShopGoodwill endpoints** seen in the same code [R]: `https://buyerapi.shopgoodwill.com/api/` with paths:
    - `SignIn/Login` (returns `accessToken`; username/password are AES-CBC "encrypted" with a static key the site ships)
    - `Favorite/GetAllFavoriteItemsByType?Type=open|close|all` (not paginated)
    - `Favorite/AddToFavorite?itemId=`
    - `Favorite/Save` (notes, ≤256 chars, keyed by `watchlistId`)
    - `SaveSearches/GetSaveSearches`, `Search/ItemListing`, `itemDetail/GetItemDetailModelByItemId/{id}`, `ItemBid/PlaceBid` (`itemId`, `bidAmount`, `sellerId`, `quantity`)

    That project **stores each item's max bid as JSON in the favorite's note**, so SGW favorites act as the source of truth.

### D. Runtime, notifications and fallbacks

23. **Chrome alarms** [V, https://developer.chrome.com/docs/extensions/reference/api/alarms, updated 2026-10-04]: at most once per 30 s. Alarms keep running while the device sleeps, and missed ones fire on wake (a repeating alarm fires once). `persistAcrossSessions` arrives only in **Chrome 150+**, so before that alarms may vanish on restart and must be re-created at service-worker start. **Nothing runs while the browser is closed**, which makes Google Calendar's *server-side* reminders the only channel guaranteed to fire.
24. **Firefox notifications** support only `type:'basic'` with `title`, `message` and `iconUrl` [V, https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/notifications/NotificationOptions]. There are no buttons and no `requireInteraction`.
25. **ntfy** [V, https://docs.ntfy.sh/publish/]: scheduled delivery via `X-Delay`/`At`/`In` (min 10 s, **max 3 days** on default config), `X-Click` URL and priority 1–5. Scheduled messages can be **updated or cancelled by sequence ID** (DELETE `/<topic>/<seq>`). It works as a phone push with no Google auth, but auctions more than 3 days out must be scheduled later (e.g., by the daily job).
26. **.ics with VALARM**: community reports say Google Calendar *import* ignores or overrides VALARM triggers [R, https://support.google.com/calendar/thread/9627602, 2019]. One guide claims the opposite. Treat .ics as reliable for Apple/Outlook only [U for Google].
27. **"Add to Google Calendar" template link** (`https://calendar.google.com/calendar/render?action=TEMPLATE&text=…&dates=YYYYMMDDTHHMMSSZ/…&ctz=…&details=…&location=…`) needs no OAuth but cannot set reminders. The format is undocumented by Google [R, https://github.com/InteractionDesignFoundation/add-event-to-calendar-docs/blob/master/services/google.md].
28. **Email fallback without Gmail scopes**: a Calendar reminder with `method:"email"` makes Google send the email itself. This avoids requesting the restricted or sensitive Gmail scopes [V for the method; design inference].

### E. Things I could not verify (flag to the planner)
- Whether Google accepts `http://127.0.0.1/mozoauth2/<hash>` (port-less, with a path) for a Desktop client.
- Whether Web-client token exchange works without a secret under PKCE as of 2026 (docs say optional; testers say required).
- The sensitivity class of `calendar.app.created`.
- Revival of cancelled event IDs.
- Whether getAuthToken tokens are subject to the 7-day Testing expiry.
- Google's handling of imported VALARMs.
- ShopGoodwill's ToS stance on automated bidding.
- Whether SGW has a soft-close or anti-snipe extension.

## Existing Tools / Prior Art

- **scottmconway/shopgoodwill-scripts** (Python, MIT-style, last commit Aug 2025). Covers saved-search alerts, `bid_sniper` daemon, time-based alerts before end, max bid stored in favorite notes, and Gotify notifications: https://github.com/scottmconway/shopgoodwill-scripts
- **ShopGoodwill Sniper / BotGrabber** desktop app. Claims last-second bids and a multi-auction queue. Marketing only; installs via a piped shell script: https://github.com/shopgoodwill-auction-sniper/shopgoodwill-sniper
- **Shopgoodwill Helper** (Chrome, v4.1, about 147 users, updated Feb 2026). Live price/bid/countdown on item pages, ZIP-based shipping estimate, resale research links: https://chromeboard.com/extension/shopgoodwill-helper-llampoenjhpfnepahgdiigndopefgihg
- **sgwpricecheck** (Firefox, MIT, v2.4, Jan 2025). Right-click "Compare on eBay" sold listings: https://addons.mozilla.org/firefox/addon/sgwpricecheck/ (seen via mirror listing)
- **ShopGoodwill official app**: favorites, saved searches, push notifications on favorites, "personal shopper" new-listing emails. No calendar export found: https://apps.apple.com/app/id1590146817
- **Apify ShopGoodwill scrapers**: scheduled cloud keyword scraping: https://apify.com/automation-lab/shopgoodwill-scraper
- **Gixen** (eBay): free server-side sniping that bids in the final seconds. Proves the value of sniping that works with the PC off: https://www.gixen.com
- **Add Ebay Auctions to Google Calendar** userscript (2016–2019). Adds a calendar button on auction pages: https://openuserjs.org/scripts/dwbfox/Add_Ebay_Auctions_to_Google_Calendar
- **Auction Alarm Pro** (focuses the tab and chimes about 1 minute before end) and **eBay Σummer** (desktop notification before a watched auction ends): https://chromeboard.com/extension/auction-alarm-pro-ahmfabemhgkjpgobphajbdhmdnpjakgd, https://chromeboard.com/extension/ebay-σummer-mfpbbgjchdmhknhpljohaabkkongpmlo
- **Hide eBay Items and Sellers** (Chrome). Hides items and sellers in search results; offers local vs sync storage variants: https://chrome.google.com/webstore/detail/hide-ebay-items-and-selle/oaihjfifleeodajknhocogepkoomgecm
- **Poshmark Mega Filter**: keyword-based hiding of marketplace listings: https://chrome.google.com/webstore/detail/poshmark-mega-filter-decl/mkejbbfppmancdadihjnbmffgmeefdgo
- **Checker Plus for Google Calendar**: a mature Chrome+Firefox extension doing Google Calendar OAuth. Firefox reviewers report Google sign-in breakage, which is a cautionary signal: https://addons.mozilla.org/en-US/firefox/addon/checker-plus-for-calendar/
- **MDN google-userinfo example**: the reference implementation of Google OAuth via launchWebAuthFlow (implicit flow): https://github.com/mdn/webextensions-examples/tree/main/google-userinfo
- **ntfy**: self-hostable push with scheduled and cancellable delivery: https://docs.ntfy.sh/publish/

## Quality-of-Life Ideas

1. **[MVP] Dedicated "ShopGoodwill Auctions" calendar** (via `calendar.app.created`). Least privilege, color-coded, can be toggled off in one click, and deleting it removes every event the extension created.
2. **[MVP] Auth health panel + badge nudge.** Shows strategy, account, token age, last sync and last error, and warns before the 7-day Testing expiry so the daily job never fails silently.
3. **[MVP] Dry-run / preview mode.** Shows exactly what tomorrow's autonomous run *would* favorite, put on the calendar or bid before autonomy is switched on. Builds trust and doubles as a test harness.
4. **[MVP] Late-add safety net.** If an auction is found less than 60 min before end, fire an immediate local notification, because Calendar popups whose time has passed never fire.
5. **[MVP] Rich event body.** Includes current price, your max bid, shipping estimate, thumbnail link and a deep link (`source.url`), refreshed each sync, so the reminder popup alone is enough to decide.
6. **[later] Outcome stamping.** After end, retitle the event "WON $X" / "LOST" / "ENDED", strip reminders, and keep it as a price-history log.
7. **[later] Per-rule reminder profiles** within the 5-override limit (e.g., "must-have": 24h email + 60/15/5 popup; "casual": 15 only).
8. **[later] ntfy phone push channel** for people who skip Google OAuth. Uses scheduled delivery and cancels or updates on end-time change via sequence ID.
9. **[later] Morning digest.** One notification or email listing all of today's daily-check finds and today's endings, instead of N pings; respects quiet hours.
10. **[later] .ics export / "Add to calendar" link** per item and for the whole watchlist. A zero-auth fallback for Apple/Outlook users.
11. **[later] Budget guard.** Sums max bids on auctions ending in the same window and warns when the total exceeds a weekly budget.
12. **[stretch] Snipe visibility in the calendar.** Event title prefix "⚡ SNIPE ARMED $45", updated if the snipe is cancelled or fails, so the calendar shows which auctions are automated.
13. **[stretch] Busy-time awareness.** Warn when an auction you care about ends during a busy calendar block and suggest arming a snipe. Needs an extra free/busy scope, so make it opt-in.

## Fable Prompt

You are the lead planner for **ShopBadwill**, a greenfield, MIT-licensed browser extension for **Chrome and Firefox**. It helps one person shop **shopgoodwill.com** (Goodwill's online auctions); the repo currently holds only README and LICENSE. Write an **implementation plan, not code**. An orchestrator will dispatch parallel worker agents that each see only their own task, then run extensive tests, so every task must be independently buildable and verifiable.

### Requirements
1. **Highlight or hide** search-result listings in the site's DOM, based on user rules (keywords, price, category, seller, …).
2. **Run autonomously once a day**: execute saved searches or watch rules with no user present.
3. **Favorite** each match on the user's ShopGoodwill account.
4. **Google Calendar**: add each favorited auction's end time as an event with popup reminders **60, 15 and 5 minutes** before the end, and keep it in sync.
5. Nice-to-have: **bid for the user**, or **snipe at the last second** with a pre-set max bid.

Also propose quality-of-life features, each tagged MVP / later / stretch.

### Facts to design around
These were researched in Oct 2026. Treat items marked **(verify)** as assumptions that a Phase-0 spike must prove.

**Google auth (there is no backend server):**
- `chrome.identity.getAuthToken` works only in Google Chrome. It needs a "Chrome Extension" OAuth client whose Item ID equals the extension ID, so pin the ID with the manifest `key`. The `client_id` must be in the manifest `oauth2` key (inject it at build time). Chrome caches and refreshes tokens itself. Call it with `interactive:false` in the background; on a 401, call `removeCachedAuthToken` and retry once. It may require Chrome profile sign-in, and it is unreliable on Edge and Brave.
- Firefox implements only `identity.getRedirectURL()` (returns `https://<hash>.extensions.allizom.org/`; set `browser_specific_settings.gecko.id` to keep it stable) and `identity.launchWebAuthFlow()`. Google often rejects the allizom redirect. **Firefox ≥86 also accepts the loopback redirect `http://127.0.0.1/mozoauth2/<hash>`**, and Google supports loopback only for the **Desktop app** client type **(verify that Google accepts this exact URI)**.
- Chrome's `launchWebAuthFlow` redirects to `https://<ext-id>.chromiumapp.org/`, which pairs with a Google Web-application client.
- The implicit flow returns only 1-hour tokens, and silent renewal (`interactive:false`, `prompt=none`) is unreliable in Firefox. **Unattended daily runs therefore need auth code + PKCE (S256) + `access_type=offline`, with a stored refresh token.** Testers report that Google's token endpoint requires `client_secret` for Web clients even with PKCE; Desktop clients have a secret Google treats as non-confidential **(verify)**.
- Google docs (updated 2026-05-26) say a project in **"Testing" status gets refresh tokens that expire after 7 days**. The limit is 100 refresh tokens per account per client; past that, the oldest is silently revoked. Handle `invalid_grant` everywhere.
- `calendar.events` is a sensitive scope. Google exempts apps "for your personal use (fewer than 100 users)" from verification; the user clicks through the "unverified app" screen. Workspace users can choose "Internal".
- **The plan must include a step-by-step personal-use setup guide:**
  - Create your own GCP project, enable the Calendar API, choose External, and add yourself as a test user.
  - Create the client(s) and paste the client ID (and secret if needed) into the options page. Secrets are never committed to the public repo.
  - **Publish → "In production" without submitting for verification**, which removes the 7-day expiry. Then re-authorize, because tokens issued during Testing keep their 7-day life.
  - Alternatively, stay in Testing and have the extension detect the weekly expiry and prompt for re-consent.
- Request **one** scope: asking for more than one non-sign-in scope triggers per-scope checkboxes. Prefer **`calendar.app.created`**, which lets the extension create a dedicated "ShopGoodwill Auctions" calendar and manage only events on it. Use `calendar.events` only if the user wants their primary calendar **(verify the scope's sensitivity class)**. Check the granted scopes anyway.

**Calendar API:**
- Set `reminders:{useDefault:false, overrides:[popup 60, popup 15, popup 5]}`. The **maximum is 5 overrides**, and `method` is `popup` or `email`.
- Reminders count back from the **event start**, so start = auction end and end = start + N minutes.
- Custom event `id` values must be base32hex: **lowercase a–v and 0–9**, 5–1024 characters, unique per calendar. A prefix like `sgw` is invalid because of the `w`.
- Inserting an existing id returns 409. Deleted events remain with `status:"cancelled"`, so a deterministic id re-used after a delete may collide **(verify)**.
- Use `extendedProperties.private` (look up with `events.list?privateExtendedProperty=k=v`) and `source.url`. `dateTime` must be RFC 3339 with an offset, or paired with an IANA `timeZone`.

**ShopGoodwill (from third-party code, github.com/scottmconway/shopgoodwill-scripts, Aug 2025, verify):**
- The API base is `buyerapi.shopgoodwill.com/api`, with a bearer token from `SignIn/Login`.
- Endpoints: `Favorite/GetAllFavoriteItemsByType`, `Favorite/AddToFavorite`, `Favorite/Save` (notes ≤256 chars), `SaveSearches/GetSaveSearches`, `Search/ItemListing`, `ItemBid/PlaceBid`.
- **`endTime` is a naive ISO string in Pacific time** (the "PT" suffix is stripped), with inconsistent fractional seconds.
- That project stores each max bid as JSON in the favorite's note. Consider making SGW favorites the source of truth.

**Runtime:**
- Chrome MV3 uses a service worker and Firefox MV3 an event page; both get suspended.
- Missed alarms fire on wake. Re-create alarms at startup; persistence is only guaranteed from Chrome 150.
- **Nothing runs while the browser is closed.** Google Calendar's server-side reminders are therefore the primary reminder channel, and local notifications are secondary. Firefox notifications are basic only, with no buttons.
- Keep refresh tokens in `storage.local`, never `storage.sync`.

**Fallbacks (no OAuth, or auth broken):**
- A Google "Add to calendar" template link (no reminder control).
- An `.ics` file with three VALARMs. Google's import may ignore them, but they work for Apple and Outlook.
- Local notifications.
- ntfy.sh push: scheduled delivery via `X-Delay`, from 10 s to 3 days, cancellable by sequence ID.
- A Calendar reminder with `method:"email"`, which makes Google send the email without any Gmail scope.

### Required plan structure (use these headings)
1. **Summary and key decisions**, with the alternatives you rejected and why.
2. **Architecture**:
   - modules and the message flow between content scripts, background and the options/popup UI
   - storage schema with a version field and migrations
   - every permission and host permission, each justified
   - Chrome/Firefox manifest differences
3. **Auth design**:
   - a `GoogleAuthProvider` interface, e.g. `getAccessToken({interactive})`, `connect()`, `disconnect()` (revokes), `status()`
   - a per-browser strategy matrix: getAuthToken vs PKCE+refresh vs fallback, chosen by feature detection
   - an error taxonomy: `invalid_grant`, 401, insufficient scope, 429/quota, offline
   - re-auth UX that respects "interactive only on user gesture"
   - the user setup guide as a deliverable
   - ShopGoodwill session handling (reuse the site's token vs store credentials) and its risks
4. **Calendar sync design**:
   - a reconciliation algorithm (desired state from favorites → create / patch / no-op / delete)
   - an idempotent event-ID scheme and 409 handling
   - behavior when the end time changes, when an item is won, lost or unfavorited, and when an event is created less than 60 minutes before the end
   - PT→UTC conversion, including DST edges
   - what happens when the user switches calendar or account
5. **The remaining features**:
   - the rule engine and DOM highlight/hide, resilient to site markup changes
   - the daily scheduler with catch-up after missed days
   - auto-favoriting
   - bidding and sniping safety: explicit opt-in, per-item caps, kill switch, audit log, ToS and account risk, and the fact that a snipe needs the browser open with accurate clock offset
6. **Phases and milestones.** Phase 0 is spikes that produce evidence: OAuth on both browsers with the user's own project, live SGW endpoints, and event-ID 409/cancelled behavior.
7. **Task breakdown table.** Each row has: ID, goal, contracts consumed and produced, files owned (no two tasks own the same file), dependencies, size (≤1 agent-day) and acceptance tests. Shared types and contracts get their own early task.
8. **Test strategy**:
   - Unit tests: PKCE using the RFC 7636 Appendix B vector, event-ID regex `^[a-v0-9]{5,1024}$`, PT→UTC across DST, ≤5 overrides, and the reconciliation state machine.
   - Contract tests against a fake Google token and Calendar server, plus recorded SGW fixtures.
   - Extension E2E: Playwright with unpacked Chromium; web-ext/Selenium for Firefox.
   - A dry-run mode.
   - A manual acceptance checklist for real Google consent and real calendar writes, since CI cannot log in to Google.
9. **Risk register** with likelihood, impact and mitigation. Include Google policy or flow changes, token expiry, SGW API or markup changes, account bans, and snipe timing.
10. **QoL features (tagged) and open questions for the user.**

Tie decisions to the facts above and flag any assumption you add.
