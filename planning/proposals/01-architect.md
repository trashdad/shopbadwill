# 01-architect — Cross-browser extension architecture proposal

## Research Findings

Research date: 2026-10-07. "Verified" means I read it on a primary source this session. "Observed" means I saw it directly in the live site. Everything else is flagged.

### A. Target site (shopgoodwill.com), observed with 4 read-only requests
- **Angular 15.2.9 SPA with SSR.** The home page HTML contains `<app-root ... ng-version="15.2.9" ng-server-context="other">`, and the bundle is `main.<hash>.js` (about 1.7 MB). Client-side routing means content scripts have to handle in-app navigation and re-rendered DOM.
- **JSON API at `https://buyerapi.shopgoodwill.com/api/`.** I grepped these endpoint strings out of the live `main.js`: `Search/ItemListing`, `ItemDetail/GetItemDetailModelByItemId`, `Favorite/AddToFavorite?itemId=`, `Favorite/RemoveItemFromFavoriteList?itemId=`, `Favorite/GetAllFavoriteItemsByType`, `Favorite/GetFavoriteItemsByUser`, `SaveSearches/GetSaveSearches`, `Dashboard/GetCurrentTime` and `GetCurrentTimeV1` (server clock, which matters for sniping), and `SignIn/Login`, `SignIn/RefreshToken`, `SignIn/RevokeToken`.
- **Bid endpoints are not in `main.js`.** They are probably in a lazy-loaded chunk. The community client [scottmconway/shopgoodwill-scripts](https://github.com/scottmconway/shopgoodwill-scripts/blob/main/shopgoodwill.py) uses `POST /ItemBid/PlaceBid` with `{itemId, bidAmount:"%.2f", sellerId, quantity}` and `GET /itemBid/ShowBidModal?itemId=` to get `sellerId`. **I have not confirmed these against the live site.**
- **Auth is `Authorization: Bearer <accessToken>`.** I saw this in the bundle and in the community client. The site keeps its session in a JS-set cookie named `cookieSession_8` (constant `currentUserObject="cookieSession_8"`, default expiry 1 day). Some stored values look encrypted with a key read from `localStorage.getItem("key")`. **The exact token location and format are unverified**, so the plan needs a spike for this.
- **Login body is obfuscated.** The community client "encrypts" username and password with AES-CBC using a key hard-coded in the site JS and an all-zero IV. Logging in from the extension would mean copying that obfuscation, which is fragile and means storing the password.
- **robots.txt sets `Crawl-delay: 120`** and disallows `/shopgoodwill/` (the account and favorites pages) and `/categories/listing?st=`. A daily job should be slow and polite.
- **Proxy bidding is built in** ([SGW blog](https://blog.shopgoodwill.com/english/the-ultimate-guide-to-bidding-buying)). The same blog openly describes "sniping." I found **no confirmed soft-close or anti-snipe extension**. A Goodwill Canada FAQ warns that bids in the last seconds "may not be processed" (secondary source). **I could not retrieve SGW's ToS or bidder agreement**, so its position on automation is unknown. For context, eBay banned AI shopping agents in its Jan 2026 user agreement ([ecommercebytes](https://www.ecommercebytes.com/2026/01/21/ebay-bans-ai-shopping-agents-updates-arbitration-provision/)).

### B. Chrome MV3 (verified on developer.chrome.com)
- **Service worker lifetime.** The worker is terminated after 30 s idle, after a single event or call runs past 5 min, or when a `fetch()` response takes more than 30 s. Since Chrome 110, events and extension API calls reset the idle timer. Since Chrome 116, WebSocket traffic keeps it alive. Globals are lost on termination. ([lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle))
- **`chrome.alarms` timing.** Alarms fire at most once every 30 s, and Chrome "may delay them an arbitrary amount more." Unpacked extensions have no limit. Alarms keep running while the device sleeps but never wake it, and missed alarms fire once on wake. ([alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms))
- **Alarm persistence.** `persistAcrossSessions` (Chrome 150+) defaults to `true`. Before Chrome 150 the behavior is "unpredictable," so re-create important alarms at every worker start. Alarms are cleared on extension update.
- **Offscreen documents (Chrome 109+).** Only one can be open at a time. Reasons include `DOM_PARSER`, `WORKERS` and `LOCAL_STORAGE`, and only `AUDIO_PLAYBACK` has a lifetime limit. The service worker has no `DOMParser` or `localStorage`, so it should parse JSON from the API and avoid parsing HTML. ([offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen))
- **`browser` namespace.** Since Chrome 148, all extension APIs are available under `browser.*`, including promise-returning `onMessage` listeners. Google suggests new extensions set the minimum Chrome version to 148. ([browser namespace](https://developer.chrome.com/docs/extensions/develop/concepts/browser-namespace))
- **`webextension-polyfill` is archived.** The repo was archived on 2026-07-30 and says it "will not receive any further updates." ([repo](https://github.com/mozilla/webextension-polyfill))
- **`background` permission.** It "Makes Chrome start up early… and shut down late (even after its last window is closed…)" ([permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list)). This is the only lever an extension has for "browser closed." It also depends on the user setting "Continue running background apps." `chrome.power.requestKeepAwake` is Chrome-only and could stop the machine sleeping while a snipe is pending (from memory; not re-verified this session).
- **Identity.** `getAuthToken` needs the `oauth2` manifest key and Chrome sign-in. It caches and refreshes tokens, but it is Chrome-only. `launchWebAuthFlow` redirects to `https://<id>.chromiumapp.org/`, and Chrome 113+ adds the `abortOnLoadForNonInteractive` and `timeoutMsForNonInteractive` options for silent flows. ([identity](https://developer.chrome.com/docs/extensions/reference/api/identity))
- **Storage quotas.** `local` is 10 MB, or unlimited with `unlimitedStorage`. `sync` is 100 KB total, 8 KB per item, 512 items, and 120 writes per minute. `session` is 10 MB, in memory, and hidden from content scripts by default. ([storage](https://developer.chrome.com/docs/extensions/reference/api/storage))

### C. Firefox MV3 (verified on MDN and Extension Workshop)
- **No `background.service_worker`** ([bug 1573659](https://bugzil.la/1573659)). Firefox uses `background.scripts` as a non-persistent event page, with full DOM and `DOMParser`. If both `scripts` and `service_worker` are declared, Chrome 121+ and Firefox 121+ each pick theirs. ([MDN background](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background))
- **Idle timeout.** The event page idle timeout is about 30 s (pref `extensions.background.idle.timeout`; figure from a Bugzilla comment, not docs). Mozilla calls keep-alive hacks an anti-pattern. ([bug 1771203](https://bugzilla.mozilla.org/show_bug.cgi?id=1771203))
- **Alarms do not persist across browser sessions** ([MDN alarms](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/alarms)). Reconcile them on `runtime.onStartup` and `onInstalled`.
- **Host permissions.** Since Firefox 127 they are shown and granted at install, but users can revoke them at any time, and updates that add hosts are not prompted. Always check with `permissions.contains`. ([MV3 migration guide](https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/))
- **Identity.** Firefox has only `launchWebAuthFlow` and `getRedirectURL`. Google rejects the default redirect domain, so use the loopback form `http://127.0.0.1/mozoauth2/<subdomain>` (Firefox 86+). A fixed `gecko.id` is required, or the redirect URL changes on every temporary install. ([MDN identity](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/identity))
- **AMO requirements.** AMO requires `browser_specific_settings.gecko.id`. New add-ons since 2025-11-03 must also declare `data_collection_permissions`. ([Mozilla blog](https://blog.mozilla.org/addons/2025/10/23/data-collection-consent-changes-for-new-firefox-extensions), [Extension Workshop](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/))

### D. Frameworks (status as of Oct 2026)
- **WXT ([github.com/wxt-dev/wxt](https://github.com/wxt-dev/wxt)) is the best choice.** It is actively released: wxt 0.21.4 is tagged "Latest" (11 Aug), and `@wxt-dev/storage` 1.3.0 came out 4 Oct. The year isn't shown on the releases page, but it is consistent with 2026. WXT builds Chrome and Firefox from one codebase, generates per-browser manifests, provides a `ctx` that survives "Extension context invalidated," fires `wxt:locationchange` for SPA navigation, and has `createShadowRootUi` with `autoMount` for dynamic anchors. ([content scripts guide](https://wxt.dev/guide/essentials/content-scripts.html)) It ships `wxt/testing` (a fake browser for Vitest). It has a 0.x version number, so pin the version.
- **Plasmo appears stalled.** Its last release, v0.90.5, was around Sep 2025, with about 350 open issues (secondary source: [extensionbooster](https://extensionbooster.net/blog/plasmo-alternatives-chrome-extension-framework-migration-guide-2026.md)). Not recommended.
- **CRXJS is Chrome-first.** `@crxjs/vite-plugin` v2.4.0 came out in Mar 2026 under new maintainers (secondary source only). Its Firefox support is weaker. Not recommended for a two-browser target.
- **webextension-polyfill** is archived and no longer needed (see B).

### E. "Once a day" and sniping reliability
- **Nothing runs while the browser is closed**, in either browser. Alarms don't wake a sleeping machine.
  - A daily check can catch up at the next start: store `lastRunAt` and run if more than 24 h have passed.
  - **A snipe cannot catch up.** That is why server-side snipers exist (Gixen, below).
- **Companion options**
  - **Native messaging host.** It can only be started by a running browser, so it doesn't solve "browser closed" by itself. It can install an OS scheduled task (Windows Task Scheduler supports "wake the computer to run this task"; launchd and systemd timers are the equivalents).
  - **GitHub Actions cron.** It runs at most every 5 min, "can be delayed during periods of high loads," jobs may be dropped, and it is auto-disabled after 60 days without repo activity ([docs](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)). Fine for a daily search, unusable for sniping, and it means storing SGW secrets in CI.
  - **Cloudflare Durable Object alarms.** They are scheduled in ms and guaranteed at least once, with up to 6 retries ([docs](https://developers.cloudflare.com/durable-objects/api/alarms/)). This is a plausible cloud sniper, but it must hold an SGW token, which is a security and ToS risk.
  - **Google Apps Script.** Time triggers run within ±15 min. A web app deployed "execute as me" can create Calendar events with `addPopupReminder` ([web apps](https://developers.google.com/apps-script/guides/web), [ClockTriggerBuilder](https://developers.google.com/apps-script/reference/script/clock-trigger-builder)). It is a user-owned alternative to shipping an OAuth client.
- **In-browser snipe pattern (my design):**
  - Set an alarm about 3 min before the end. When it wakes the background, keep it alive with cheap API calls every 20 s or so. Chrome counts these as activity; in Firefox, events reset the timer.
  - Measure clock offset and RTT against `Dashboard/GetCurrentTime`, pre-warm the connection, then `setTimeout` to fire at end − lead.
  - Afterwards, verify the outcome through item detail.
  - It needs the browser open and the machine awake. Default to dry-run.

### F. Google Calendar
- **`events.insert` supports the required reminders.** Use `reminders.useDefault=false` and `overrides` with up to 5 entries, method `popup` or `email`, and 0–40320 minutes, so 60/15/5 fits. `extendedProperties.private` and client-supplied event `id`s (unique per calendar) allow idempotent upserts. ([events resource](https://developers.google.com/workspace/calendar/api/v3/reference/events))
- **Testing-mode refresh tokens expire after about 7 days**, and testing mode caps users at 100. `calendar.events` is a sensitive scope that needs Google verification for a public app ([sensitive scopes](https://developers.google.com/identity/protocols/oauth2/production-readiness/sensitive-scope-verification)). The 7-day figure comes from multiple secondary sources, not a Google page I read.
- **Autonomous calendar writes need a non-interactive token.** That rules out "ask the user each time." The options are:
  - Chrome `getAuthToken`, which is Chrome-only.
  - An auth-code flow with a refresh token.
  - An Apps Script web app, which avoids OAuth app verification entirely.
- **.ics import is not a dependable fallback.** Google's handling of `VALARM` reminders on import is reported as unreliable ([support thread](https://support.google.com/calendar/thread/9627602?hl=en)).

### G. Content-script injection into the SPA
- Match broadly (`*://shopgoodwill.com/*`) and route in code on URL change. Use WXT's `wxt:locationchange` (its detection mechanism isn't documented), or `webNavigation.onHistoryStateUpdated` from the background.
- A debounced `MutationObserver` on the results container finds new or re-rendered cards. Mark processed nodes with a `data-sbw-*` attribute so they are handled exactly once.
- Hide with a class plus injected stylesheet rather than removing nodes, so the user can reveal them again.
- Prefer reading the API JSON for item facts over scraping DOM text. The rule engine should run on structured listing objects.

## Existing Tools / Prior Art

**ShopGoodwill-specific**
- **scottmconway/shopgoodwill-scripts.** A Python daemon that alerts on new saved-query results and snipes favorites, storing the max bid as JSON in SGW favorite notes. It is the best public map of buyerapi endpoints. https://github.com/scottmconway/shopgoodwill-scripts
- **ShopGoodwill Sniper.** A free desktop app that claims server clock sync, "Auto-Max," a pre-warmed connection, sleep prevention, and an isolated browser partition for the SGW session. It requires a third-party "BotGrabber" account, and its install scripts download from another domain, so treat it as untrusted. https://github.com/shopgoodwill-auction-sniper/shopgoodwill-sniper
- **dudemcbacon/goodwill.** A scraper with login, search and bid features. It looks unmaintained (its README still has template placeholder text). https://codeclimate.com/github/dudemcbacon/goodwill/README.md/source
- **ShopGoodwill Helper (Chrome).** Shows a shipping-to-ZIP estimate, live price and countdown, and eBay/Poshmark comps. About 102 users, v4.1, Feb 2026. I only saw it in a third-party directory. https://chromeboard.com/extension/shopgoodwill-helper-llampoenjhpfnepahgdiigndopefgihg
- **sgwpricecheck (Firefox).** A right-click "Compare on eBay" sold-listings lookup, v2.4, Jan 2025. https://addons.mozilla.org/en-US/firefox/addon/sgwpricecheck/
- **Apify ShopGoodwill scrapers.** Read-only scrapers that use SGW's public listing API with no login. https://apify.com/automation-lab/shopgoodwill-scraper
- **ShopGoodwill's native features.** Proxy bidding, Favorites, saved keyword searches with email alerts, and the official app (rated about 2.5 stars per underpriced.app). https://blog.shopgoodwill.com/english/the-ultimate-guide-to-bidding-buying

**Other marketplaces and patterns**
- **Gixen (eBay).** A free server-side sniper with optional "mirror" redundant servers, "group bidding" where the first win cancels the rest, and a browser add-on to queue snipes. A user review describes an expired auth warning that arrived only after the auctions had closed. https://chrome.google.com/webstore/detail/gixen-ebay-sniper-autosni/nfjjhbbnailabfbenccobieecimkbmji
- **Distill Web Monitor.** A hybrid model: "local monitors" run only while the browser or PC is on, and "cloud monitors" run on servers. This is the clearest precedent for a tiered local/cloud design. https://distill.io/docs/web-monitor/cloud-local-monitors/
- **Hide eBay Items and Sellers.** A per-card hide button, seller-level hiding, and an unhide list in the popup. Its "unlimited" variant uses local storage instead of sync because of quota. https://chrome.google.com/webstore/detail/hide-ebay-items-and-selle/oaihjfifleeodajknhocogepkoomgecm
- **Poshmark Mega Filter.** Hides listings by keyword, seller and brand. https://chrome.google.com/webstore/detail/poshmark-mega-filter-decl/mkejbbfppmancdadihjnbmffgmeefdgo
- **easyBlock.** A generic "hide items and sellers" extension for shopping sites. https://extscope.org/extension/bhnmgddgmmpeegbcognmbpjekfanfhje

## Quality-of-Life Ideas

1. **[MVP] Auth-health preflight.** Check the SGW session and Google token at the daily run, and again 24 h and 1 h before any scheduled snipe or calendar write. Notify immediately on failure. This is Gixen's top complaint: the warning came after the auction closed.
2. **[MVP] "Why hidden / why highlighted" chips plus a "show hidden (N)" toggle.** Builds trust in rules and makes rule bugs debuggable instead of making items silently disappear.
3. **[MVP] One-click hide on each listing card** (this item / this seller-location / this keyword). The eBay hide extensions show this is the fastest way to build a blocklist.
4. **[MVP] Run log and status in the popup.** Shows last daily run, items found, favorites added, calendar events created, and any "caught up after browser was closed" notes. Autonomous jobs need visible proof they ran.
5. **[MVP] Shipping-inclusive totals.** Show the estimated total (current bid plus shipping to the user's ZIP) and allow rule thresholds on the total. On SGW, shipping often costs more than the item.
6. **[MVP] Dry-run snipe journal.** Record what would have been bid, when, at what measured latency, and whether it would have won. This lets bidding be validated safely before it goes live.
7. **[later] Import SGW saved searches as watch rules** (`SaveSearches/GetSaveSearches`). Reuses the work the user has already done on the site.
8. **[later] Snipe groups: "win one of these N."** A win cancels the remaining snipes, which stops the user winning five identical lamps (Gixen's group bidding).
9. **[later] Calendar lifecycle sync.** Update or delete events when an item is un-favorited, outbid with no snipe set, won, or relisted with a new end time. Keeps the calendar from becoming stale clutter.
10. **[later] Local price history and sold comps** for watched items. Gives the user evidence for setting a max bid.
11. **[later] Export/import rules as JSON, with only a small core synced via `storage.sync`.** Allows backup and multiple machines within the 100 KB sync quota.
12. **[later] Keyboard triage on results pages** (j/k to move, h to hide, f to favorite, s to set a snipe). Power users scan hundreds of listings.
13. **[stretch] Opt-in keep-alive.** The Chrome `background` permission plus `power.requestKeepAwake` while a snipe is pending. This is the cheapest reliability gain for Chrome users.
14. **[stretch] Companion sniper**, either a local OS-scheduled helper or a small cloud worker holding a revocable token. It is the only way to snipe with the browser closed, with explicit risk disclosure.

## Fable Prompt

You are the lead planner for **shopbadwill**, a new MIT-licensed **Chrome + Firefox** browser extension (repo `github.com/trashdad/shopbadwill`, currently only README and LICENSE) that helps one user shop **shopgoodwill.com** (SGW) auctions. Write an **implementation plan, not code**. An orchestrator will run your plan by sending parallel worker agents. Each worker sees only its own task plus the shared contracts you define, so every task must be buildable and verifiable in isolation.

### Requirements
1. **Listing rules:** inject UI into SGW search and result pages to **highlight or hide** listings according to user rules (keywords/regex, price or total with shipping, category, location, time left, etc.).
2. **Autonomy:** run the user's saved watch rules **once a day** with no interaction.
3. **Favorite** matching items on the user's SGW account.
4. **Google Calendar:** create an event at each auction's end time with reminders **60, 15 and 5 minutes** before.
5. **Nice-to-have:** bid for the user, or **snipe in the last seconds** up to a max bid set in advance.
6. Quality-of-life features (seed list below).

### Facts to plan around (researched Oct 2026; re-verify anything you depend on)

**The SGW site**
- Angular 15 SPA. Its JSON API is `https://buyerapi.shopgoodwill.com/api/`.
- Endpoint names found in the live bundle: `Search/ItemListing` (POST), `ItemDetail/GetItemDetailModelByItemId`, `Favorite/AddToFavorite?itemId=`, `Favorite/RemoveItemFromFavoriteList?itemId=`, `Favorite/GetAllFavoriteItemsByType`, `SaveSearches/GetSaveSearches`, `Dashboard/GetCurrentTime` (server clock), `SignIn/Login`, `SignIn/RefreshToken`.
- `ItemBid/PlaceBid` (`{itemId, bidAmount, sellerId, quantity}`) and `itemBid/ShowBidModal` come only from a community client (github.com/scottmconway/shopgoodwill-scripts) and are **unconfirmed**.
- Auth uses `Authorization: Bearer <accessToken>`. The site keeps its session in a JS-set cookie (`cookieSession_8`) that looks obfuscated. Login obfuscates credentials with AES using a key from the site JS.
- Schemas are undocumented and may change. robots.txt sets `Crawl-delay: 120`.
- SGW has native proxy bidding. No soft-close rule is confirmed, and late bids may not be processed. Its **ToS on automation is unverified**.

**Chrome MV3**
- The background is a **service worker**. It dies after 30 s idle or a 5-minute task, and since Chrome 110 events and extension API calls reset the idle timer.
- `alarms` fire at most once every 30 s and "may [be delayed] an arbitrary amount more." Missed alarms fire once on wake, but alarms never wake the machine.
- `persistAcrossSessions` exists only in Chrome 150+, so re-create alarms on every worker start.
- The worker has no `DOMParser`. Use an offscreen document (one at a time) or stick to JSON.
- Since Chrome 148, `browser.*` is native with promise-returning `onMessage`. `webextension-polyfill` was archived in July 2026.
- `identity.getAuthToken` is **Chrome-only**. `launchWebAuthFlow` redirects to `https://<id>.chromiumapp.org/`.
- An optional `background` permission keeps Chrome alive after its windows close and starts it at login. `power.requestKeepAwake` is Chrome-only.
- Storage quotas: `local` 10 MB (or `unlimitedStorage`), `sync` 100 KB with 8 KB per item, `session` 10 MB in memory.

**Firefox MV3**
- **No service worker.** The background is an event page using `background.scripts`, with DOM access and about 30 s of idle before it is suspended. Declaring both `scripts` and `service_worker` works in Chrome 121+ and Firefox 121+.
- **Alarms do not persist across browser sessions.**
- Host permissions are granted at install (Firefox 127+) but users can revoke them, so check with `permissions.contains`.
- Identity offers only `launchWebAuthFlow`. Google needs the loopback redirect `http://127.0.0.1/mozoauth2/<subdomain>`.
- AMO requires a fixed `gecko.id` and `data_collection_permissions`.

**Reliability**
- **Nothing runs while the browser is closed or the machine is asleep.** A daily check can catch up at the next launch. A snipe cannot.
- Server-side snipers (Gixen for eBay) exist for exactly this reason.
- GitHub Actions cron runs at most every 5 min, is often delayed, and is auto-disabled after 60 inactive days. It suits a daily search, not sniping.
- Cloudflare Durable Object alarms are at-least-once with retries.

**Google Calendar**
- `events.insert` with `reminders.useDefault=false` and up to 5 `overrides` (popup) covers 60/15/5. Use `extendedProperties.private` or a deterministic event `id` for idempotency.
- Writes during the daily job need a **non-interactive token**. Refresh tokens for OAuth apps in "Testing" expire after about 7 days, and `calendar.events` is a sensitive scope.
- Alternatives: a user-owned Google Apps Script web app ("execute as me", `addPopupReminder`), or `.ics` export, though Google may ignore `VALARM` on import.

**Frameworks**
- **WXT** (wxt.dev, 0.21.x, actively released in 2026) builds both browsers from one codebase. It provides per-browser manifests, a `wxt:locationchange` event for SPA routing, `createShadowRootUi` with `autoMount`, and a fake browser for Vitest via `wxt/testing`.
- Plasmo appears stalled (last release around Sep 2025). CRXJS is Chrome-first.

### Recommended direction (override only with explicit justification)
- **Stack:** WXT + strict TypeScript. Vitest with fake browser and fake timers. Playwright for Chromium e2e and `web-ext` for Firefox. Minimum Chrome 148 using `browser.*` directly, with no polyfill.
- **Reliability tiers:**
  - **T0:** the extension only. Reconcile alarms on every background start, persist `lastRunAt`, catch up missed daily runs, and jitter request timing.
  - **T1 (Chrome, opt-in):** the `background` permission plus keep-awake while a snipe is pending.
  - **T2 (stretch):** a companion sniper, either a local helper scheduled by the OS or a small cloud worker, for when the browser is closed. Weigh honestly whether it is worth the credential risk.
- **Snipe engine:**
  - An alarm wakes the background a few minutes early, and cheap API calls keep it alive.
  - Compute clock offset and RTT from `Dashboard/GetCurrentTime`, then fire at a configurable lead.
  - Verify the outcome afterwards. Ship with **dry-run as the default** and hard caps.
- **Isolate the parts most likely to change:**
  - Put all SGW access behind one `SgwClient` interface, with recorded fixtures and a local fake buyerapi.
  - Put all DOM knowledge behind a `ListingCardAdapter`, tested against saved HTML snapshots.
  - Run rules on structured listing data, not on scraped text.

### Deliver this plan
1. **Architecture and decisions:**
   - The contexts: background, content script, popup/options, offscreen, and optional companion.
   - A text data-flow diagram.
   - A **Chrome vs Firefox differences table**.
   - Each permission with a justification.
   - How the extension gets an SGW session: reuse the page's token, its own login, or driving the site UI. If this is unknown, plan a time-boxed spike.
   - The Calendar auth route for each browser.
2. **Contracts first (Phase 0):**
   - TypeScript interfaces for `SgwClient`, the rule schema and matcher, the storage schema with a version number and migrations, the typed message protocol, `Scheduler`, `CalendarSink`, `BidExecutor`, and logging.
   - Freeze these before parallel work starts.
3. **Phases with exit criteria.** Requirements 1–4 (MVP) come before bidding, and bidding is behind a feature flag.
4. **Task breakdown:** 15–30 tasks. Each one gives:
   - ID and goal.
   - Contracts it consumes.
   - **The files and directories it owns.** No two parallel tasks own the same file.
   - Dependencies.
   - Concrete acceptance tests.
   - Size (S, M or L; L is at most about one agent-day).
5. **Test strategy:**
   - Unit tests, including simulated alarm loss, browser restart, machine sleep and missed runs.
   - Contract tests against sanitized SGW fixtures.
   - DOM-snapshot tests for injection across SPA navigation.
   - e2e on **both** browsers against a fake buyerapi.
   - An opt-in, read-only live canary.
   - **No automated test may favorite, bid or touch a real account.**
6. **Risk register** giving likelihood, impact and mitigation for each risk. Include ToS and account bans, API or DOM drift, token expiry, OAuth verification, clock skew, missed snipes, store-review policy, and rate limiting.
7. **QoL backlog** tagged MVP, later or stretch. Seed list:
   - Auth-health preflight before snipes.
   - A "why hidden" reveal toggle.
   - One-click hide for a seller or keyword.
   - Shipping-inclusive totals.
   - A run log with catch-up status.
   - Importing SGW saved searches.
   - Snipe groups ("win one, cancel the rest").
   - A dry-run snipe journal.
8. **Open questions for the user**, for example:
   - Distribution channel: store or self-hosted.
   - Whether the PC stays on.
   - Whether they will run a companion.
   - Whether the SGW password may be stored.
   - The calendar auth route.

Be concrete, state every assumption, and mark anything you could not verify.
