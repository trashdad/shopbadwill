# Fable Prompt Ballot

Six candidate prompts, anonymized and shuffled as Prompts A–F. Each asks Fable (Claude Fable 5.1) to produce the implementation PLAN for the ShopGoodwill Chrome+Firefox extension.

---

# Prompt A


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

---

# Prompt B


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

---

# Prompt C


You are the lead planner for **ShopBadWill**. It is an MIT-licensed, greenfield repo containing only README and LICENSE. The product is a **Chrome and Firefox** extension that helps one user shop **shopgoodwill.com**, Goodwill's online auction site. Produce an **implementation plan, not code**.

An orchestrator will execute your plan by dispatching parallel worker agents with isolated context, then testing extensively. Every task must be buildable and verifiable by an agent that sees only that task, the repo, and your shared contracts.

### Functional requirements
1. **Listing overlay:** on search and listing pages, highlight or hide visible listings according to user-defined rules (keywords, negative keywords, seller/location, price, time left, etc.).
2. **Autonomous daily check:** once a day, run the user's watch rules (saved searches) without the user present.
3. **Favorite** matching items on the user's ShopGoodwill account.
4. **Google Calendar:** add each matched auction's end time as an event, with popup reminders **60, 15 and 5 minutes** before the end.
5. **Nice-to-have:** bid for the user, or **snipe** in the final seconds up to a max bid the user sets in advance.

Also propose tagged (MVP/later/stretch) quality-of-life features, including at least dry-run mode, an audit log with undo, "why hidden/highlighted" explanations, a health page, and a kill switch.

### Researched facts (October 2026). Items marked ⚠ are unverified and need a spike.

**The site.**
- shopgoodwill.com is an Angular 15 single-page app that loads reCAPTCHA. Listings render client-side after skeleton loaders, so content scripts must handle async rendering and in-app navigation, and selectors will drift.
- Data comes from an undocumented JSON API at `https://buyerapi.shopgoodwill.com/api/`. An open-source client (github.com/scottmconway/shopgoodwill-scripts) uses these endpoints:
  - `POST Search/ItemListing`
  - `GET itemDetail/GetItemDetailModelByItemId/{id}`
  - `GET Favorite/AddToFavorite?itemId=`
  - `POST Favorite/GetAllFavoriteItemsByType`
  - `POST SaveSearches/GetSaveSearches`
  - `GET itemBid/ShowBidModal?itemId=` (returns sellerId)
  - `POST ItemBid/PlaceBid {itemId,bidAmount,sellerId,quantity}`
  - `POST itemDetail/CalculateShipping`
- Auth uses `Authorization: Bearer <token>`. Login "encrypts" credentials with a hardcoded key, which is obfuscation only.
- Treat every endpoint and field as unverified ⚠. The site has built-in proxy bidding, favorites and saved searches. robots.txt asks for a 120-second crawl delay.
- Unknown ⚠: the ToS stance on automated bidding, and whether late bids extend an auction.

**Browsers.**
- Chrome MV3 runs a background service worker that is killed after about 30 s idle. Extension API calls reset that timer.
- Firefox MV3 does **not** run `background.service_worker`. It uses non-persistent event pages (`background.scripts`).
- Firefox MV3 host permissions are user-revocable and opt-in. Content scripts may not run until the user grants access, and `permissions.request` requires a user gesture.
- `alarms` has a 30-second minimum and "may delay an arbitrary amount." That suits the daily job but is **not precise enough for sniping**. Unpacked builds skip the minimum, so tests can pass where production fails.
- Alarms do not wake a sleeping machine. The browser must be running, as with eBay snipers like PowerSniper.
- `identity.getAuthToken` is Chrome-only. Firefox needs `launchWebAuthFlow`, and Google has rejected Firefox redirect URIs in reported cases ⚠.
- Google OAuth apps left in "Testing" get refresh tokens that expire after 7 days.
- Narrow Calendar scopes exist: `calendar.app.created` (a dedicated calendar) and `calendar.events.owned`.
- Events allow at most 5 reminder overrides and a client-supplied `id`, which makes inserts idempotent.

**Distribution.**
- Personal use first: Chrome "Load unpacked"; Firefox release builds require signing via `web-ext sign --channel unlisted`.
- AMO requires source and reproducible build instructions for bundled code.
- New Firefox add-ons must declare `browser_specific_settings.gecko.data_collection_permissions`.

**Test tooling.**
- WXT (wxt.dev) builds both browsers from one source. Its Vitest plugin provides an in-memory `fakeBrowser` covering storage, alarms (trigger `onAlarm` manually), runtime, tabs and notifications. Identity and permissions need hand-written fakes.
- Playwright supports extension E2E **only in Chromium**. It uses `launchPersistentContext` with `--load-extension` on its bundled Chromium, and the `chromium` channel works headless. Branded Chrome ignores the flag. The service worker is reachable through `context.serviceWorkers()`. Routing that worker's fetches is experimental ⚠.
- There is no Playwright extension support for Firefox. The options are Selenium/geckodriver `install_addon(temporary=True)`, WebDriver BiDi `webExtension.install`, Puppeteer ⚠, or `web-ext run` for smoke tests.
- `web-ext lint --warnings-as-errors` runs Mozilla's linter.
- MSW intercepts fetch in Node, not inside a real extension worker.

### Engineering principles (non-negotiable)

**TDD everywhere.** Each task lists failing tests first, then implementation, then gate commands. A task is done only with green gates and pasted evidence.

**Ports and adapters.**
- Domain logic (rule engine, bid and increment math, snipe state machine, calendar-event builder, scheduler) depends only on injected interfaces: `Clock`, `Http`, `Storage`, `Alarms`, `Notifier`, `SgwApi`, `CalendarApi`. Browser glue stays thin.

**Test pyramid in every phase.**
1. Static checks: TypeScript strict, ESLint with unsafe-DOM rules, `web-ext lint`, and a manifest-permissions snapshot that fails on any new permission.
2. Unit tests: Vitest, fake timers, and property tests for money and time math.
3. Contract tests: schema validation of sanitized, recorded API fixtures. The same schemas validate live responses at runtime and **fail closed**.
4. Integration tests: fakeBrowser plus MSW.
5. Content-script tests against sanitized, *rendered* DOM captures.
6. Offline Chromium E2E against a fake ShopGoodwill server and a fake Google server.
7. A thinner Firefox E2E or smoke lane.
8. A **scheduled, read-only, anonymous live canary** that detects API and DOM drift. It never logs in and never writes.
9. A manual acceptance script for the real account.

**No live writes in automated tests.** No automated test may favorite, bid, or touch a real calendar. Test-only hooks (time travel, alarm triggers, base-URL override) must be compiled out of production, and a CI check must prove it.

### Safety and security requirements

**Permissions.** Request least privilege: only shopgoodwill.com, buyerapi.shopgoodwill.com and the Google API hosts. Make the permissions for opt-in features optional.

**Credentials and tokens.**
- Never store the user's raw password. Prefer reusing the session the user already has in the browser. How the site stores its token is unknown ⚠, so plan a spike.
- Decide where ShopGoodwill and Google tokens live (`storage.session` or `storage.local`) and how expiry works.
- Degrade gracefully when a token is missing: still search, queue the favorites, and notify the user.

**Untrusted input.**
- Treat all listing text as attacker-controlled. Use no `innerHTML`, and put injected UI in Shadow DOM.
- The background must validate the sender of every message. Content scripts must never trigger state-changing actions.

**Bidding.** It ships **disabled** and is gated by all of the following:
- Dry-run by default.
- Explicit per-item arming with a typed max bid.
- A per-item cap and a daily or weekly spend cap.
- Pre-flight checks: item still open, price below max, valid schema, bounded clock skew.
- Idempotency, so a restarted worker never double-bids.
- A one-click kill switch.
- An append-only local audit log of every favorite, calendar write and bid. The log must contain no secrets.

**Other.** No telemetry and no remote code.

### Deliverables. Structure your plan exactly as follows.
1. **Key decisions, with rejected alternatives.** Cover the framework, how the daily job and the snipe timer actually wake in each browser, and the auth approach for ShopGoodwill and Google.
2. **Architecture.** Modules, data model, storage schema, message protocol, and **typed interface contracts** with example payloads, so parallel agents can build against them.
3. **Phase 0 spikes, each with exit criteria.** At minimum: the API and auth shape, Firefox host permissions, Google OAuth on both browsers, the Firefox E2E harness, and snipe timing.
4. **Phases and milestones, each with verification gates.** MVP is requirements 1–4. Bidding comes later and ships disabled.
5. **Task breakdown.** For each task give: ID, goal, contracts consumed and produced, files owned (no two parallel tasks may touch the same file), dependencies, the tests-first list, acceptance criteria, the gate command, and size (at most about one agent-day). Mark which tasks can run in parallel.
6. **Test strategy.** Pyramid targets, the fixture capture and sanitization procedure, the GitHub Actions workflow (static → unit → contract → Chromium E2E → Firefox lane, plus the nightly canary), and the flake policy.
7. **Threat model table:** asset, threat, control, and the test that proves the control.
8. **Release and distribution** for both browsers.
9. **Risk register:** likelihood, impact, mitigation, and the task that owns it.
10. **QoL feature list**, tagged.
11. **Open questions for the user.** For example: ToS comfort with automated bidding, the token-storage trade-off, a dedicated calendar versus the primary one, and spend caps.

Be concrete, flag assumptions, and prefer a small verifiable MVP over breadth.

---

# Prompt D


You are the lead planner for **shopbadwill**, a greenfield MIT-licensed **Chrome + Firefox (Manifest V3) extension** that helps one user shop **shopgoodwill.com** (Goodwill's online auction site). Produce an **implementation plan, not code**. A team of parallel worker agents with isolated contexts will execute it, followed by extensive testing. Every task must therefore be independently buildable and verifiable.

### Product requirements
1. **Highlight or hide** search-result listings in-page, based on user rules (keywords with whole-word/negative/regex matching, price range, seller/location, ending-within, bids count).
2. **Autonomous daily check**: run saved watch rules once a day (with catch-up if the browser was closed) and find new matching items.
3. **Auto-favorite** matches on the user's ShopGoodwill account (idempotently).
4. **Google Calendar**: create an event at each favorited auction's end, with popup reminders at **60, 15, and 5 minutes**. Deduplicate, and update or delete the event if the end time changes or the auction ends early.
5. *Nice-to-have*: **auto-bid / last-second snipe** up to a user-set max.
6. Propose quality-of-life features, for example an adapter-health badge, dry-run mode for all automation, a server-synced countdown, whole-word keyword rules, true-cost (price + shipping) badges, a relist detector, sold comps, and a snipe budget cap. Tag each MVP, later, or stretch.

### Verified recon facts (2026-10-07). Treat these as current but volatile.
- **Site:** Angular 15.2.9 SPA with SSR, served via Azure Front Door. SSR emits **skeleton cards only**. Real results render client-side after `POST https://buyerapi.shopgoodwill.com/api/Search/ItemListing`, and they re-render on SPA navigation, paging, and filter changes. Heavy ad scripts are on the page. There is no Cloudflare. reCAPTCHA is bundled; which flows it gates is unknown.
- **URLs:** items are `/item/{itemId}`. Search is `/categories/listing?st=…&c=…&s=…&lp=…&hp=…&p=…&layout=grid|list…`, and its query params map 1:1 onto the ItemListing JSON body.
- **Card DOM (grid):** `div.item-col > app-home-product-items > div.feat-item`.
  - It contains `a.feat-item_name[id={itemId}][href="/item/{id}"][title]`, `p.feat-item_price`, `a.btn-heart[aria-label="Add to your Favorites list"]`, and `ul.feat-item_bottom` (bids, time remaining, Quick Bid).
  - The same component renders home and featured cards.
  - Never select on `_ngcontent-*` attributes. The list layout and item-page DOM have **not** been inspected.
- **Buyer API** (undocumented, reverse-engineered by the community; see github.com/scottmconway/shopgoodwill-scripts):
  - `POST Search/ItemListing` is anonymous.
    - Booleans go as **strings** ("true"/"false"). A malformed body gives 200 with zero rows, or a 500.
    - It returns 40 rows per page regardless of pageSize, with `maxTotalRecords` = 10000.
    - Double quotes in `searchText` cause a 403.
    - Items carry `itemId, title, currentPrice, minimumBid(starting), numBids, endTime, sellerId, isFavorite, shippingPrice…`.
  - `GET ItemDetail/GetItemDetailModelByItemId/{id}` is anonymous. It includes `endTime`, **`serverTime` with milliseconds**, `bidIncrement`, `minimumBid` (the next acceptable bid), `bidHistory`, and `inWatchlist`.
  - `POST Dashboard/GetCurrentTime` returns the Pacific time to the second.
  - Favorites:
    - `GET Favorite/AddToFavorite?itemId=` and `GET Favorite/RemoveItemFromFavoriteList?itemId=`
    - `POST Favorite/GetAllFavoriteItemsByType?Type=open|close|all`
    - `POST Favorite/Save {notes, watchlistId}`
  - Bidding: `GET ItemBid/ShowBidModal?itemId=` (gives sellerId), then `POST ItemBid/PlaceBid {itemId, bidAmount:"12.00", sellerId, quantity:1}`. It returns `{status, result, message(HTML)}`, and `result -3` means closed. The other codes are unverified.
  - Saved searches: `POST SaveSearches/GetSaveSearches`.
- **Auth:** calls carry `Authorization: Bearer <HS256 JWT>`.
  - The JWT's claims include BuyerId, **IpAddress and Browser UA** (likely bound), and exp. A refresh endpoint exists: `SignIn/RefreshToken`.
  - The site stores the session in an AES-obfuscated JS cookie (`cookieSession_8`).
  - **Do not collect or store the user's password.** Reuse the session the user already has by logging in normally, for example by observing the `Authorization` header on the site's own buyerapi requests. If that is unavailable, decrypting the cookie is a fallback that the spike must evaluate.
  - Send buyerapi calls with `credentials:'omit'`: a `Bid` cookie set after one bid makes the next bid return 403.
  - buyerapi CORS allows only `https://shopgoodwill.com`.
- **Time:** `endTime` is **Pacific local time with no offset** and sometimes has fractional seconds, so parse it with IANA `America/Los_Angeles`.
- **Auctions:**
  - Proxy bidding is built in: a submitted bid is a hidden max, raised automatically by `bidIncrement`.
  - Sellers can end auctions early, and bids are then retracted.
  - The official FAQ warns that last-second bids may not be processed in time. Whether late bids extend the end (soft close) is **unconfirmed**, and sniping design depends on it.
- **Terms of Use (updated 2025-01-22)** explicitly prohibit any "script, **browser extension** … or other automated means … to access the Services, extract data, or … modify the rendering of Site pages," as well as unapproved third-party apps. They also require one account per person and personal, non-commercial use. Won bids are binding. **Account suspension is a real risk.**
- **Platform:**
  - `chrome.alarms` has a 30-second minimum and may not survive a restart (re-register on startup).
  - MV3 service workers and Firefox event pages are suspended when idle, so a snipe needs the browser running and a keep-alive window near T-0.
  - Calendar allows at most 5 reminder overrides; use `extendedProperties.private` for dedupe.
  - `identity.getAuthToken` is Chrome-only, so Firefox needs `launchWebAuthFlow`.

### Architecture mandates
1. **Site Adapter layer.** It is the only code that knows ShopGoodwill specifics. It has four parts:
   - **DomAdapter**: card discovery, itemId extraction, and hide/highlight hooks, with ranked fallback selectors.
   - **ApiAdapter**: typed requests and responses, schema validation (e.g., zod) on every response, a throttle of at most 1 request per second, backoff, and a daily request cap.
   - **SessionAdapter**: token capture, refresh, expiry, and a "logged-out" state.
   - **ClockAdapter**: server offset from `serverTime`/`Date` plus RTT/2, and Pacific-time parsing.

   Selectors, endpoints, and field names live in a versioned config. The adapter exposes a `healthCheck()`. When the check fails, all write automation is **disabled** and the user is notified. Everything above the adapter (rules engine, scheduler, calendar, sniper, UI) depends only on adapter interfaces and normalized domain types (`Listing`, `ItemDetail`, `Favorite`, `BidResult`).
2. **Task 0 is a read-only Recon Spike.** It runs before other site-facing work and produces:
   - Captured HTML fixtures (grid and list cards, item page, favorites page, logged-in and logged-out views).
   - JSON fixtures for every endpoint.
   - The token-capture approach, chosen and documented.
   - The PlaceBid response catalogue, captured manually by the user.
   - An empirical **soft-close verdict**: observe `endTime` on items that receive late bids.
   - Firefox-versus-Chrome differences.
   
   Downstream tasks consume these fixtures, never the live site.
3. **Safety:**
   - A global kill switch and dry-run by default for favoriting, calendaring, and bidding.
   - Bids only on items the user explicitly armed, with a typed confirmation and per-bid and daily spend caps.
   - An audit log of every write.
   - No multi-account support.
   - Never bid in CI.

### Plan deliverables, in this order
1. **Summary and key decisions**, including the build tooling (e.g., WXT or webextension-polyfill + TypeScript) and the cross-browser strategy.
2. **Architecture diagram and module list**, with **interface contracts**: TypeScript signatures for the adapter interfaces, domain types, message-passing schema, and storage schema.
3. **Phases and milestones**, each with exit criteria. MVP = requirements 1–4. Sniping comes last and stays behind a flag.
4. **Task breakdown.** Each task needs:
   - an ID
   - goal
   - inputs and fixtures
   - files and modules owned
   - depends-on
   - acceptance tests
   - size: S, M, or L, where L is about one agent-day
   
   No two parallel tasks may edit the same files.
5. **Test strategy:**
   - Unit tests for the rules engine and time math (DST edges).
   - Contract tests of the ApiAdapter against recorded fixtures.
   - DOM tests that run the DomAdapter against saved HTML fixtures.
   - A mock buyerapi server.
   - Playwright e2e that loads the unpacked extension in Chromium and Firefox against the mocks.
   - Fake-timer tests for the scheduler and sniper.
   - An opt-in, read-only live smoke test that detects site drift.
6. **Risk register** with likelihood, impact, and mitigation. It must cover at least: ToS and account ban, selector or API drift, token expiry or binding, clock skew and network latency at snipe time, service-worker suspension, the browser being closed, Google OAuth app verification, and store-review rejection.
7. **Open questions for the user.** Include at least:
   - accepting ToS risk
   - distribution: unpacked, self-signed, or store
   - snipe lead time
   - which calendar to use
   - hide versus dim behavior

Be concrete and decisive. Where facts above are marked unverified, plan the verification task rather than assuming.

---

# Prompt E


You are the lead planner for **ShopBadwill**, an open-source (MIT) Chrome + Firefox extension that makes shopping on **shopgoodwill.com** (SGW, Goodwill's national online auction site) calmer and smarter. The repo (github.com/trashdad/shopbadwill) is empty apart from a README and LICENSE.

Produce an **implementation plan, not code**. An orchestrator will execute your plan by dispatching parallel worker agents. Each worker has isolated context and sees only its own task card plus the contracts you define. So every task must be self-contained, small (≈0.5–2 human-days), and verifiable by tests.

### What the user wants
1. **Shape search results:** highlight or hide visible listing cards on SGW search/category pages, based on rules the user writes.
2. **Autonomy:** run saved "watches" (search + rules) **once a day**.
3. **Favorite** newly matching items on the user's SGW account.
4. **Google Calendar:** add each match's auction end time, with popup reminders **60, 15 and 5 minutes** before the end.
5. **Nice-to-have:** bid for the user, or **auto-snipe** in the last seconds up to a max bid set in advance.

### Facts and gotchas (researched Oct 2026; verify early)
- **API.** SGW is a single-page app (SPA): cards re-render on paging, sorting and filtering, so DOM injection must be idempotent and MutationObserver-driven. The site calls an undocumented JSON API at `https://buyerapi.shopgoodwill.com/api/`:
  - `Search/ItemListing` (POST, no auth)
  - `itemDetail/GetItemDetailModelByItemId/{id}`
  - `itemDetail/CalculateShipping`
  - `Favorite/AddToFavorite?itemId=`
  - `Favorite/GetAllFavoriteItemsByType`
  - `Favorite/Save` (notes ≤500 chars)
  - `SaveSearches/GetSaveSearches`
  - `ItemBid/PlaceBid`

  Auth is a Bearer token. Source: github.com/scottmconway/shopgoodwill-scripts.
- **API quirks:** quotes in `searchText` return 403 (match exact phrases client-side); end times are naive **Pacific** timestamps; relisted items get new IDs; intermittent 403s follow bursts (throttle and cache).
- **Auction timing:** most auctions end 6–8 PM Pacific (vendor data). The site slows down or rejects bids at the crunch, and SGW's FAQ admits last-second bids may not register. There is no clock extension. Accounts under 30 days old are capped at 15 active auctions.
- **Shipping:** shipping plus per-item handling is set per seller location and is users' #1 complaint, and search results don't show it. Pickup-only items exist. Wins from the same location within about 7 days can often ship combined.
- **ToU risk:** SGW's Terms (updated 2025-01-22) forbid any "robot, spider, crawler, scraper, script, browser extension… or other automated means" used to access the site, extract data, or alter how pages render, and forbid unapproved third-party apps. The plan must disclose this plainly in onboarding, keep traffic human-scale, never evade detection, and include a global kill switch and a dry-run mode.
- **Favoriting may attract bidders:** a popular r/shopgoodwill post claims that favoriting a no-bid item draws new bidders within hours. This is anecdotal, but auto-favorite should be a per-watch choice with a "local-only watch" alternative.
- **Platform (MV3):**
  - Background: a service worker on Chrome, event-page scripts on Firefox.
  - `alarms` fire ≥30 s apart and may be delayed, and never fire while the browser is closed. The daily run needs catch-up on startup; snipes need a separate precise, server-clock-synced path.
  - Side panel: `sidePanel` (Chrome) vs `sidebar_action` (Firefox).
  - Google OAuth: `identity.getAuthToken` is Chrome-only; Firefox needs `launchWebAuthFlow`.
  - Calendar API allows ≤5 reminder overrides (popup, 0–40320 min).

### Prior art to learn from
- **ShopGoodwill tools:** ShopGoodwill Helper (ZIP shipping estimates, comp links), sgwpricecheck (eBay sold search), BidPulse and ShopGoodwill Sniper (snipe ~6 s before close; audio win/loss cues), Deal Notifier (keyword + bid-ceiling alerts).
- **Other marketplaces:** MarketClean (FB Marketplace, 4.6★) has block/required keywords, a hard distance limit and hide-seen. Crumb promises "nothing is deleted" and one-switch undo. Low-rated hiders draw "still shows up", "stopped working" and "clicking each listing one by one is pointless". An eBay hider hit `storage.sync` quotas.
- **Sniping:** Gixen's snipe groups, where the first win cancels the rest.

### UX direction (treat as requirements)
Low-friction, trustworthy, reversible, honest about limits.
- **Surfaces:** in-page card badges and quick actions; a toolbar popup for at-a-glance status; the side panel/sidebar as the live dashboard; an options page for the rule editor, settings, import/export and the activity log.
- **Rule editor:**
  - Fields: any/all keywords, exclusions, exact phrase, optional regex (safe/time-boxed), price range, shipping+handling cap, **landed-total cap**, seller/location include/exclude, pickup-only handling, category, condition terms (verify whether SGW has a condition field), ends-within window, and bid count.
  - Actions: highlight (color + text label), collapse, hide, or watch.
  - **Live preview:** "matches 7 of 40 on this page".
  - Plain-English rule summaries.
  - Create a rule from a card: "hide this seller", "more like this".
- **Hiding is never silent:**
  - Collapsed stubs and a "12 hidden · show" bar.
  - A per-card "Why?" naming the rule.
  - One-click undo.
- **Dashboard sections:** Watches (last run, next run, new matches, Run now), Matches, Favorites, Snipes (armed, countdown, result), Calendar sync (synced, pending, or error with retry), and an Activity log of every autonomous action with its reason and an undo.
- **Onboarding (≤3 min):**
  1. Welcome and ToU disclosure.
  2. Detect SGW login.
  3. Home ZIP.
  4. Connect Google Calendar (skippable; offer an .ics fallback).
  5. Create the first watch from a template or the current search.
  6. Run it now.
- **States and accessibility:**
  - Design empty, error and degraded states, including "SGW layout changed: filters paused" when no cards parse.
  - Meet WCAG AA, with highlights that are never color-only, and make everything keyboard-operable.
  - Support dark mode.
  - Show local time next to Pacific time everywhere.
- **Snipes:** explicit per-item arming, configurable lead time, a global budget cap, a "browser must stay open/awake" warning, and peak-hour failure messaging.

### Quality-of-life candidates (phase each as MVP / later / stretch, add your own)
1. Landed-cost badge on cards (lazy, throttled, cached).
2. Pickup badge with distance, and "hide pickup items beyond X mi".
3. "New since last visit" / hide-seen.
4. Relist detector showing the previous close price.
5. Combined-shipping hint for sellers won from this week.
6. One-click comps: eBay sold search and SGW closed auctions, as link-outs only.
7. Snipe groups.
8. Misspelling variants for watch keywords.
9. Daily digest notification with a badge count and quiet hours.
10. Calendar hygiene: a dedicated calendar, and events that update or delete on early end, win, loss or unwatch.
11. Rule templates and JSON import/export, with rules in `storage.local`.
12. Keyboard shortcuts on hovered cards.
13. Import existing SGW saved searches.

### Deliverables: use exactly this structure
1. **Summary and assumptions,** including your recommended MVP cut and the reasoning behind it.
2. **Architecture.**
   - Modules with hard boundaries: site adapter (the *only* code that knows SGW DOM/API), pure rule engine, storage schema + migrations, scheduler, favorites, calendar, bid/snipe, UI surfaces, cross-browser shim.
   - A text data-flow diagram, and permissions with justifications.
3. **Contracts.**
   - TypeScript interfaces: normalized `Listing`, `Rule`, `Watch`, `MatchResult` (with reasons), `ActionLogEntry`, `CalendarLink`, `Snipe`.
   - Message types between content script, background and UI.
   - Storage keys and versioning.
   - Make them precise enough that workers can build against mocks in parallel.
4. **UX spec.**
   - Screen inventory with low-fidelity text wireframes: popup, side panel, rule editor, card overlay, onboarding.
   - Key user flows.
   - Microcopy for consent, ToU and destructive actions.
   - Empty/error states.
   - Accessibility checklist.
5. **Phased milestones.** Each phase ends in something the user can install and try.
6. **Task cards,** each with ID and goal, contracts consumed, files owned (no two tasks own the same file), dependencies and parallel lane, acceptance criteria, tests to write, and size. Make "verify API + capture fixtures" one of the first tasks.
7. **Test strategy:**
   - table-driven rule-engine unit tests, including regex safety;
   - saved SGW HTML/JSON fixtures, with no live calls in CI;
   - DOM tests proving injection is idempotent under re-render;
   - fake-clock tests for daily scheduling, catch-up, Pacific/DST conversion and snipe timing;
   - mocked Google Calendar and SGW endpoints;
   - Playwright e2e on unpacked Chrome, plus `web-ext` on Firefox;
   - a selector-drift canary;
   - an opt-in manual live smoke checklist.
8. **Risk register,** with likelihood, impact and mitigation for: ToU/account ban, API/DOM drift, missed snipes (browser closed or asleep, peak overload), Google OAuth verification for the Calendar scope, favoriting signaling interest, duplicate or stale calendar events, and data loss.
9. **Open questions for the user,** e.g. personal unpacked use vs store publishing (and Firefox signing), whether snipe is in v1, daily run time, auto-favorite default, and notification channels.

Be concrete and opinionated, flag anything you're unsure of, and keep the whole plan readable in one sitting.

---

# Prompt F


You are the lead planner for **ShopBadwill**, a greenfield, MIT-licensed browser extension for **Chrome and Firefox** that helps one user shop shopgoodwill.com (SGW), Goodwill's online auction site. Repo: https://github.com/trashdad/shopbadwill (README + LICENSE only). **Write an implementation plan, not code.** An orchestrator will execute it by dispatching parallel worker agents. Each agent sees only its task card and the contracts you define. Extensive testing follows. Your plan must therefore decompose into independent, verifiable tasks.

### User requirements
1. Inject UI that **highlights or hides** search-result listings according to user rules (keywords, price, seller/location, category, shipping and so on).
2. Run **autonomous daily checks** of saved searches / watch rules.
3. **Favorite** matches on the user's SGW account.
4. Add each auction end to **Google Calendar** with reminders 60, 15 and 5 minutes before.
5. Nice-to-have: **bid for the user** or **auto-snipe** at the last second using a pre-set max bid.

Also evaluate the quality-of-life (QoL) features listed below.

### Facts to design around (researched Oct 2026; items marked UNVERIFIED must be confirmed)

**ToS and money.** SGW's Terms of Use (updated 2025-01-22, https://shopgoodwill.com/about/terms-of-use) forbid using any "robot, spider, crawler, scraper, script, browser extension … or interface not authorized by us to access the Services, extract data, or otherwise interfere with or modify the rendering of Site pages". Winning bids are binding ("YOU ARE OBLIGATED TO COMPLETE THE TRANSACTION"). Bids are not retractable except in exceptional cases, and non-payers get suspended or banned. robots.txt sets Crawl-delay 120 and disallows `/shopgoodwill/` account pages. Treat this as a first-class constraint:
- Keep request volume minimal.
- Use one account only.
- Store no passwords.
- Disclose the risk clearly to the user.
- Make an explicit user go/no-go decision before any bidding code ships.

**No official API.** The Angular site calls an undocumented JSON API at `https://buyerapi.shopgoodwill.com/api/` with a Bearer token. Open-source clients (scottmconway/shopgoodwill-scripts, robherley/gw-bot, taciturnaxolotl/goodwill-snipper) use these endpoints:
- `POST Search/ItemListing`
- `GET ItemDetail/GetItemDetailModelByItemId/{id}`: returns endTime, currentPrice, minimumBid, bidIncrement, and bidHistory.isHighBidderLogIn.
- `GET ItemBid/ShowBidModal?itemId=`: returns sellerId and minimumBid.
- `POST ItemBid/PlaceBid {itemId, sellerId, quantity, bidAmount}`
- `GET Favorite/AddToFavorite?itemId=`
- `POST Favorite/GetAllFavoriteItemsByType?Type=open|close|all`

The following are UNVERIFIED:
- A server-time endpoint (`Dashboard/GetCurrentTime`) or `serverTime` field.
- PlaceBid result codes.
- Token refresh.
- Where the SPA keeps its token.

`endTime` is a naive `YYYY-MM-DDTHH:mm:ss` string in **America/Los_Angeles**. `Date.parse` misreads it as local time, so handle DST explicitly.

Phase 1 must include a **read-only discovery spike** that confirms these contracts and records sanitized fixtures. It must place no bids and add no favorites. Do not invent other endpoints; route unknowns to the spike.

**Auction mechanics.** SGW has built-in proxy bidding, so a snipe should submit the user's single max bid once. Soft close is undocumented and indirect evidence suggests a hard close (UNVERIFIED), so detect end-time changes rather than assume. A third party reports that accounts under 30 days old are capped at 15 auctions where they are high bidder (UNVERIFIED).

**How established snipers work.**
- Gixen, eSnipe, BidSlammer and JustSnipe run **server-side** so the user's PC can be off.
- Lead times: Gixen bids at most 5 s before the end (its paid tier offers 3–15 s, default 6 s, and sends each bid from two servers); esniper defaults to 10 s; BidSlammer's paid tier bids at 1 s.
- Bid groups ("win one of N, cancel the rest") need end times spaced apart (Gixen: at least 2 min) and an edit freeze about 2 min before the end.
- Gixen: "no sniping service or software can give you 100% guarantee". In one survey, 63 of 73 eBay late bidders had seen a last-minute bid miss the close.
- The existing SGW Python sniper fires 30 s early on the local clock, with no retries or price check.

**Browser constraints.**
- Chrome MV3 service workers die after 30 s idle.
- `chrome.alarms` has a 30 s floor and "may delay them an arbitrary amount". Alarms don't wake a sleeping PC, and missed alarms fire on wake, which is too late.
- Hidden tabs throttle timers to once per second, and to once per minute after 5 minutes hidden.
- `chrome.power.requestKeepAwake('system')` blocks idle sleep only (Chrome only). No Firefox equivalent was found.
- Firefox MV3 uses non-persistent event pages and has no offscreen documents.
- **The extension does not run when the browser is closed.**

**Calendar.**
- Google Calendar allows at most 5 reminder overrides.
- Store the itemId in `extendedProperties.private` for idempotent upserts.
- `chrome.identity.getAuthToken` is Chrome-only; Firefox needs `launchWebAuthFlow`.

### Snipe engine: design in depth
- **Safety.**
  - Global **dry-run** mode, on by default and required for the user's first several real snipes until they opt out.
  - **Explicit per-snipe confirmation** showing item, max, estimated all-in cost, and end time in both local time and PT.
  - **Hard caps:** per item, per day, and total open exposure (the sum of all armed maxes, since all may win).
  - Typo guard.
  - **Kill switch** in the popup plus a keyboard command.
  - Auto-kill on anomalies: auth failure, clock offset or latency out of bounds, repeated errors.
  - **Append-only audit log** of every state change, request and response.
- **Timing.**
  - Estimate the server clock offset from multiple samples, keeping the lowest-RTT sample (the HTTP `Date` header has only 1 s resolution).
  - Measure latency with a harmless read.
  - Fire at end − lead − one-way latency. Justify a default lead and make it configurable.
  - Wake coarsely with an alarm.
  - Re-check at about T−60 s: item still open, endTime unchanged, token valid, price below max, user not already the high bidder.
  - Use a tight timer for the final second.
- **Retries and idempotency.**
  - Send one bid per snipe.
  - Retry only when the bid provably never arrived.
  - On an ambiguous response, re-read the item first.
  - Never exceed the max.
- **Outcomes.** Classify each snipe as won, outbid, below-minimum, auth, network, late, ended/extended, cap-blocked, killed or dry-run, then notify the user and keep the record.
- **Honest reliability story.** State plainly what happens if the PC sleeps or the browser is closed. Compare three options:
  - (a) Extension-only, with keep-awake and pre-flight warnings.
  - (b) A local companion: a native-messaging host or OS scheduled task with a wake timer.
  - (c) A remote server, which must hold an SGW token off-device.

  Recommend one option for MVP and one for later. Offer a per-snipe fallback: place the max as a normal proxy bid early, or skip.
- **Bid groups** come in a later phase: spacing validation and cancellation based on the actual outcome.

### QoL features to evaluate (tag each MVP, later or stretch)
Exposure meter; max bid entered as an all-in price (bid + shipping + handling); T−15 min pre-flight notification; post-auction outcome report; timing diagnostics; sold-price comps to suggest a max; combined-shipping hints; local-time countdown badges on listings. Add your own.

### Deliverables (use these headings)
1. **Summary & key decisions:** MVP scope, and whether bidding ships in v1.
2. **Architecture:** components and contexts (content script, background, popup/options, optional companion), data flow, storage schema, permissions per browser, and Chrome vs Firefox differences.
3. **Interface contracts:** TypeScript-style signatures and message schemas for the SGW API adapter (isolate API drift here), rules engine, scheduler, favorites, calendar, snipe engine, audit log and settings.
4. **Phases & milestones** with exit criteria. Bidding is gated behind a dry-run soak and a user go/no-go.
5. **Task cards** sized for one agent (half a day to one day). Each card needs an ID, goal, inputs, contracts touched, dependencies, owned files (no overlap), acceptance criteria and proving tests. Mark which cards can run in parallel.
6. **Test strategy:**
   - Fake-clock unit tests.
   - A **mock buyerapi server** with injectable latency, clock skew, error codes, token expiry and soft-close extension.
   - Fixtures from the spike.
   - Playwright extension E2E tests on both browsers.
   - Sleep, close and restart scenarios.
   - A live read-only dry-run soak.
   - A rule that any real-money test needs the user's explicit approval for a specific cheap item.
7. **Risk register:** likelihood, impact and mitigation for ToS/ban, API drift, money loss, missed snipes, token theft, Google OAuth verification and store review.
8. **Open questions for the user:** risk acceptance, spending caps, default lead time, companion choice and Calendar account.

Be concrete, and label every assumption.

