You are the lead planner for **ShopBadwill**, a greenfield, MIT-licensed browser extension for **Chrome and Firefox** that helps one user shop **shopgoodwill.com** (SGW), Goodwill's online auction site. Repo: https://github.com/trashdad/shopbadwill (README + LICENSE only), cloned at `C:\tools\shopbadwill`.

**Produce an implementation plan, not code.** An orchestrator will execute your plan by dispatching parallel worker agents with isolated context, then testing extensively. Each worker sees only its task card, the repo, and the shared contracts you define, so every task must be buildable and verifiable on its own.

## Who this is for, and why

The user works long hours and is usually asleep or busy when SGW auctions end. Vendor data says most end around 6–8 PM Pacific ⚠. SGW's design rewards people who can sit at a screen at closing time. ShopBadwill levels that field: it finds items for the user, tracks them, and bids for them when the user can't be there.

**Unattended operation is the core value, not an edge case.** The daily check and, above all, the snipe must work while the user is asleep. The plan must be honest about what that takes.

## Functional requirements

1. **Listing overlay.** On SGW search and category pages, highlight or hide visible listings according to user rules. Rules can use:
   - keywords, with whole-word, negative and regex matching
   - price and landed-cost range
   - seller and location
   - category
   - time until the auction ends
   - bid count
2. **Autonomous daily check.** Once a day, run the user's saved watches (a search plus rules) with no user present. Catch up if a run was missed.
3. **Auto-favorite** matches on the user's SGW account, idempotently. Make this a per-watch choice with a "watch locally only" alternative: an anecdotal Reddit report says favoriting a no-bid item draws rival bidders.
4. **Google Calendar.** Create an event at each tracked auction's end with popup reminders **60, 15 and 5 minutes** before. Deduplicate events, and update or delete them when the end time changes or the item is won, lost or unwatched.
5. **Bid / auto-snipe.** Bid for the user, or snipe in the final seconds up to a max the user set in advance. Given the user's schedule, this is a **high-value** feature. It ships after the MVP (requirements 1–4), but design it in depth now.

## Decisions the user has already made

**ToS risk accepted.**
- SGW's Terms of Use (updated 2025-01-22, https://shopgoodwill.com/about/terms-of-use) prohibit using any "robot, spider, crawler, scraper, script, browser extension … or other automated means **not authorized by us**" to access the Services, extract data, or modify the rendering of Site pages. They also prohibit unapproved third-party apps.
- The site license is "solely for your own private, non-commercial purposes".
- The Terms say robots.txt "controls all automated access".
- Bids "are not retractable except in exceptional circumstances", for example a clear typo. That is why the typo guard and the caps exist.
- The user has read this and chosen to proceed with all five features. **Do not re-ask the go/no-go.**
- Keep account-suspension risk in the risk register, and design to minimize it. Note there that written authorization from SGW is a possible mitigation.

**Be a considerate guest.** The user's intent is never malicious. Design every mechanic to be as light on SGW as possible, and never to degrade anyone else's ability to browse or bid.
- **Human-scale traffic.** Route every SGW request through a central request scheduler with:
  - per-endpoint rate limits (for example, at most 1 request per second, no parallel bursts)
  - a daily request budget
  - jitter
  - caching of item details and shipping quotes
  - exponential backoff on 403, 429 and 5xx
- **robots.txt rules.** shopgoodwill.com/robots.txt asks for `Crawl-delay: 120`. It also disallows `/shopgoodwill/` (account pages), `/checkout/` and **`/categories/listing?st=`**, which is the search-results page itself. buyerapi.shopgoodwill.com has no robots.txt (404). Since the Terms say robots.txt controls automated access:
  - Background work (the daily check, the snipe engine) uses the **API only**. It never loads search or `/shopgoodwill/*` pages in background or hidden tabs.
  - Content scripts on pages the user opens themselves are fine.
  - Honor the 120 s delay for background polling the user didn't trigger, and justify any exception, such as the snipe window.
- **Reuse before fetching.** Prefer data the page already loaded (the site's own API responses) over making new requests.
- **No evasion.** No CAPTCHA solving, identity spoofing or detection evasion. If SGW challenges or blocks the extension, stop, back off and notify the user.
- **One account, one bid.** One account and one user. A snipe sends the user's single max bid once. No shill behavior and no bid spamming.
- **Scale-down switches.** Every network-heavy feature (landed-cost lookups, comps, countdown refresh) gets its own switch. A global "considerate mode" can be tightened if any feature proves heavy.

## Researched facts (October 2026)

⚠ means unverified. Route it to a spike; don't assume it.

### The site (read-only recon, 2026-10-07)

**Rendering.**
- shopgoodwill.com is an Angular 15 single-page app with SSR, served through Azure Front Door. SSR emits **skeleton cards only**.
- Real results render client-side after `POST https://buyerapi.shopgoodwill.com/api/Search/ItemListing`. They re-render on navigation, paging and filter changes.
- reCAPTCHA is bundled; which flows it gates is unknown ⚠. There is no Cloudflare, and the pages carry heavy ad scripts.

**URLs.** Items are at `/item/{itemId}`. Search is `/categories/listing?st=…&c=…&s=…&lp=…&hp=…&p=…&layout=grid|list`. The query params map 1:1 onto the ItemListing JSON body.

**Grid card DOM.**
- Each card is `div.item-col > app-home-product-items > div.feat-item`. It contains:
  - `a.feat-item_name[id={itemId}][href="/item/{id}"][title]`
  - `p.feat-item_price`
  - `a.btn-heart[aria-label="Add to your Favorites list"]`
  - `ul.feat-item_bottom` (bids, time left, Quick Bid)
- Never select on `_ngcontent-*`.
- The list layout and the item-page DOM have not been inspected ⚠.

**Buyer API.** It is undocumented and was reverse-engineered by the community (github.com/scottmconway/shopgoodwill-scripts).
- A grep of the live `main.*.js` bundle on 2026-10-07 found these endpoints: ItemListing, GetItemDetailModelByItemId, GetAllFavoriteItemsByType, AddToFavorite, RemoveItemFromFavoriteList, GetSaveSearches, GetCurrentTime, and SignIn Login, RefreshToken and RevokeToken.
- It did **not** find `ItemBid/ShowBidModal`, `ItemBid/PlaceBid`, `Favorite/Save` or `CalculateShipping`. These probably sit in lazy-loaded chunks and are community-sourced only ⚠.
- **`POST Search/ItemListing`** (anonymous):
  - Booleans are sent as strings ("true"/"false").
  - A malformed body returns 200 with zero rows, or 500.
  - It returns 40 rows per page regardless of pageSize; `maxTotalRecords` is 10000.
  - **Double quotes in `searchText` return 403.**
  - Rows include itemId, title, currentPrice, minimumBid, numBids, endTime, sellerId, isFavorite and shippingPrice.
  - The search-row `minimumBid` is the **starting** minimum, not the next acceptable bid. For the same item, search returned 12.99 and detail returned 17.00. Rules, caps and snipes must use the ItemDetail value.
- **`GET ItemDetail/GetItemDetailModelByItemId/{id}`** (anonymous): includes endTime, **`serverTime` with milliseconds**, bidIncrement, minimumBid (the next acceptable bid), bidHistory (bid times to the millisecond) and inWatchlist. `serverTime` is probably a naive Pacific timestamp like `endTime` ⚠, so parse it the same way before any offset math.
- **`POST Dashboard/GetCurrentTime`**: Pacific time, 1-second resolution.
- **`POST itemDetail/CalculateShipping`**: a shipping quote ⚠ request/response shape.
- **Favorites:**
  - `GET Favorite/AddToFavorite?itemId=`
  - `GET Favorite/RemoveItemFromFavoriteList?itemId=`
  - `POST Favorite/GetAllFavoriteItemsByType?Type=open|close|all`
  - `POST Favorite/Save {notes, watchlistId}` — sources conflict on the note length limit (256 vs 500) ⚠.
- **Saved searches:** `POST SaveSearches/GetSaveSearches`.
- **Bidding:**
  - `GET ItemBid/ShowBidModal?itemId=` returns sellerId and minimumBid.
  - Then `POST ItemBid/PlaceBid {itemId, bidAmount:"12.00", sellerId, quantity:1}` returns `{status, result, message(HTML)}`.
  - `result -3` means the auction is closed. Other codes are unknown ⚠.
- **Session:** `SignIn/Login`, `SignIn/RefreshToken {refreshToken, clientIpAddress}` and `SignIn/RevokeToken`.

**Auth.**
- Calls carry `Authorization: Bearer <HS256 JWT>`. Its claims include BuyerId, **IpAddress and Browser UA** (likely bound to them) and exp.
- The site keeps its session in an AES-obfuscated JS cookie (`cookieSession_8`), written with a **1-day default expiry** and SameSite=Strict. Login "encrypts" credentials with a key shipped in the site JS, which is obfuscation only.
- **Token lifetime decides the whole reliability design** ⚠. The only sample, a leaked JWT, had `exp` about 30 days after capture. Task 0 must measure the real JWT `exp`, and whether `SignIn/RefreshToken` works with no user present. If the captured session dies overnight, no reliability tier works while the user sleeps.
- **Never collect or store the user's password.** Reuse the session the user already has, for example by observing the `Authorization` header on the site's own buyerapi calls. Decrypting the cookie is a fallback for the spike to evaluate.

**Request gotchas.**
- Send buyerapi calls with `credentials:'omit'`. A `Bid` cookie set after one bid makes the next bid return 403.
- buyerapi CORS allows only `https://shopgoodwill.com`. Decide where calls originate (a content script on the SGW origin, or the background with host permissions) ⚠.

**Time.**
- `endTime` is **Pacific local time with no offset**, sometimes with fractional seconds.
- `Date.parse` misreads it as the machine's local time. Parse it with IANA `America/Los_Angeles`, and test DST edges.

**Auction mechanics.**
- SGW has native proxy bidding: a bid is a hidden max, raised automatically by bidIncrement. A snipe should therefore submit the user's single max once.
- Sellers can end auctions early, and bids are then retracted.
- A Goodwill Industries (Canada) FAQ about ShopGoodwill (goodwillindustries.ca/?p=7581) warns that last-second bids may not be processed in time. It was not found in SGW's own help center ⚠; confirm it in Task 0.
- Soft close is undocumented, and indirect evidence suggests a hard close ⚠. Detect endTime changes rather than assume.
- A third party reports that accounts under 30 days old are capped at 15 auctions where they are high bidder ⚠.
- Winning bids are binding, and non-payers get suspended.

### How established snipers work

**Server-side services.** Gixen, eSnipe, BidSlammer and JustSnipe run **server-side**, so the user's PC can be off.
- Lead times: Gixen bids at most 5 s before the end (its paid tier offers 3–15 s, default 6 s, and sends each bid from two servers). esniper defaults to 10 s. BidSlammer's paid tier bids at 1 s.
- Bid groups ("win one of N, cancel the rest") need end times spaced apart (Gixen recommends at least 2 minutes) and an edit freeze about 2 minutes before the end.
- Gixen: "no sniping service or software can give you 100% guarantee." In Ockenfels & Roth's survey, 63 of 73 eBay late bidders had seen a last-minute bid miss the close.

**SGW-specific tools.**
- scottmconway's Python `bid_sniper` stores the max bid as JSON in the favorite note. It fires on the local clock with a configurable lead (`bid_snipe_time_delta`, default 30 s), with no retries or price check.
- taciturnaxolotl/goodwill-snipper is a Bun CLI with a 3 s lead.
- BidPulse is a paid SaaS that, by its own marketing, bids about 6 s before close ⚠.
- The commercial "ShopGoodwill Sniper" desktop app installs via `curl | bash`. Do not copy it or depend on it.

**Client-side snipers** such as PowerSniper need an open tab, which is the same constraint we have.

### Browser platform

**Chrome MV3.**
- **Background worker.** The background is a service worker. It is killed after about 30 s idle; events and extension API calls reset that timer, and each task is capped at 5 minutes. The worker has no `DOMParser`, so use an offscreen document or stick to JSON.
- **Slow fetches kill the worker.** The worker is also killed if a fetch response takes more than 30 s. A peak-hour PlaceBid that slow would kill it mid-bid, so the snipe engine must treat that as an ambiguous outcome and re-read the item.
- **Alarms.**
  - `chrome.alarms` has a 30-second minimum and "may delay an arbitrary amount."
  - Missed alarms fire once on wake, and alarms never wake a sleeping machine.
  - `persistAcrossSessions` exists from Chrome 150. It defaults to true, but set it explicitly; Chrome calls behavior before 150 "unpredictable". Re-create alarms on every worker start anyway.
- **Staying alive.**
  - The MV2 docs say the optional `background` permission keeps Chrome running after its windows close and starts it at login. Nothing confirms this still works under MV3 ⚠: one vendor's MV3 extension reportedly lost "keep running after close". Make it an exit criterion of the wake-from-sleep spike.
  - `chrome.power.requestKeepAwake('system')` blocks idle sleep only. It cannot wake a PC that is already asleep, and it does not block lid-close or manual sleep.
- **Timer throttling.** Timers in hidden *tabs* are throttled to once per second, and to once per minute after 5 minutes hidden. This applies to pages, not the background worker.
- **`browser` namespace.** From Chrome 148, all extension APIs are available under `browser` (documented). webextension-polyfill was reportedly archived in July 2026 ⚠.
- **Permission requests.** `permissions.request` only works from a user gesture, in both browsers. Request every optional permission from onboarding or the options UI, never from the daily job.

**Firefox MV3.**
- **Background.** There is **no background service worker**: Firefox uses an event page via `background.scripts`. Declaring both `scripts` and `service_worker` works in Chrome 121+ and Firefox 121+.
- **Missing APIs.** Alarms do not persist across browser restarts. There are no offscreen documents, and no keep-awake equivalent was found ⚠.
- **Host permissions.** They are granted at install since Firefox 127, but the user can revoke them. Check with `permissions.contains` and handle losing them.
- **Distribution.**
  - AMO requires a fixed `browser_specific_settings.gecko.id` and `data_collection_permissions`.
  - Release Firefox requires signed add-ons. For personal use, sign with `web-ext sign --channel unlisted`.
  - AMO requires source code plus reproducible build instructions for bundled or minified code. No exemption for unlisted signing was found; use `web-ext sign --upload-source-code`.

**Nothing runs while the browser is closed or the PC is asleep.** A daily check can catch up later; a snipe cannot.

**Framework.**
- **WXT** (wxt.dev, 0.21.x, active) builds both browsers from one codebase. It provides:
  - per-browser manifests
  - `wxt:locationchange` for SPA navigation
  - `createShadowRootUi`
  - a Vitest `fakeBrowser` covering storage, alarms, runtime, tabs and notifications. `onAlarm` must be fired manually with `onAlarm.trigger()`, and identity and permissions need hand-written fakes.
- Plasmo appears stalled, and CRXJS is Chrome-first.

### Google Calendar and auth (no backend server)

**Chrome.**
- `chrome.identity.getAuthToken` works **only in Chrome**. It needs a "Chrome Extension" OAuth client whose item ID equals the extension ID; pin the ID with the manifest `key`.
- `oauth2.client_id` goes in the manifest. **Inject it at build time** and never commit it: it isn't secret, but the user's own client ID doesn't belong in the public repo.
- In the background, call it with `interactive:false`. On a 401, call `removeCachedAuthToken` and retry once.
- It may require the user to be signed in to their Chrome profile, and it is unreliable on Edge and Brave.
- **Interactive auth only on a user gesture.** The background and the daily job must never open an auth window. If silent auth fails, set a badge or send a notification so the user reconnects from the UI.
- Chrome's `launchWebAuthFlow` redirects to `https://<ext-id>.chromiumapp.org/`, which pairs with a Web-application client.

**Firefox.**
- Firefox has only `identity.launchWebAuthFlow` and `getRedirectURL()`. The redirect is `https://<hash>.extensions.allizom.org/`, which stays stable given a fixed gecko id.
- Google often rejects that redirect. Firefox 86+ also accepts the loopback redirect `http://127.0.0.1/mozoauth2/<hash>`, which pairs with Google's **Desktop app** client type ⚠ (verify that Google accepts it).

**Unattended tokens.**
- The implicit flow gives 1-hour tokens, and silent renewal is unreliable in Firefox. Unattended daily runs therefore need **auth code + PKCE (S256) + `access_type=offline`**, with a stored refresh token.
- Reports say Google's token endpoint requires `client_secret` for Web clients even with PKCE. Desktop clients have a secret that Google treats as non-confidential ⚠.

**Token expiry.**
- **Projects in "Testing" status get refresh tokens that expire after 7 days** (Google docs, updated 2026-05-26).
- The limit is 100 refresh tokens per account per client; past that, the oldest is silently revoked.
- Handle `invalid_grant` everywhere.
- **Store the Google refresh token in `storage.local`.** Keep access tokens in memory or `storage.session`. `storage.session` is cleared on browser restart, so a refresh token kept there would force an interactive sign-in and break the unattended daily sync.

**Personal-use path.** This is a deliverable: a step-by-step guide.
1. The user creates their own GCP project, enables the Calendar API, chooses External and adds themself as a test user.
2. They create the client(s) and paste the client ID (and secret, if needed) into the options page. Secrets are never committed.
3. They **publish to "In production" without submitting for verification**. Google exempts personal-use apps with under 100 users.
4. They click through the "unverified app" screen once, then re-authorize, because tokens issued during Testing keep their 7-day life.

Alternatives to the guide:
- Stay in Testing, and have the extension detect the weekly `invalid_grant` and prompt the user to reconnect.
- Google Workspace accounts can choose "Internal", which avoids both verification and the 7-day expiry.

**Scope.** Request **one** scope only.
- Prefer `calendar.app.created`, which lets the extension create and manage a dedicated "ShopGoodwill Auctions" calendar. Its sensitivity class is unverified ⚠.
- Use `calendar.events` only if the user wants their primary calendar.
- Check the granted scopes either way.

**Calendar API.**
- Set `reminders:{useDefault:false, overrides:[popup 60, popup 15, popup 5]}`. The maximum is 5 overrides, and the methods are popup or email.
- **Reminders count back from the event start, so start = auction end.**
- `dateTime` must be RFC 3339 with an offset, or paired with an IANA `timeZone`.
- **Event IDs.** A custom event `id` must be base32hex: lowercase **a–v and 0–9**, 5–1024 characters. An "sgw" prefix is invalid because of the "w".
  - Inserting an existing id returns 409.
  - Deleted events linger with `status:"cancelled"`, so reusing an id after a delete may collide ⚠.
- Use `extendedProperties.private` (queryable via `privateExtendedProperty=k=v`) and `source.url`.

**Reminder channels.**
- **Primary channel: Google Calendar popups.** They fire even when the browser is closed, so make them the primary reminder channel.
  - Popups only appear on a device running Google Calendar: the phone app or an open Calendar web tab ⚠.
  - A dedicated calendar must be synced, with notifications on, in the user's phone app.
  - Add a manual acceptance step: "the 60/15/5 popups arrive on the phone with the PC off."
- **Late adds.** If an item is found less than 60 minutes before its end, reminders already in the past never fire; send an immediate local notification instead.
- **Fallbacks:**
  - an `.ics` file with VALARMs (Google's import may ignore them)
  - a Google "Add to calendar" link
  - ntfy.sh push with scheduled delivery via `X-Delay`. The delay is limited to 10 s–3 days by default, so auctions further out are scheduled by a later daily run. A scheduled message can be updated or cancelled by sequence ID when the end time changes or the item is won or unwatched.

## Snipe engine: design in depth

**Safety.**
- **Dry-run first.** A global dry-run mode is on by default and required for the user's first several snipes, until they opt out. A dry-run soak records what would have been bid, when, at what measured latency, and whether it would have won.
- **Arming.** Each snipe needs explicit per-item arming and a confirmation showing the item, max bid, estimated all-in cost, and end time in both local time and PT.
- **Hard caps:** per item, per day, and on total open exposure (the sum of all armed maxes, since all of them may win).
- **Typo guard:** the user must retype any max above 3× the current price or above a configurable threshold.
- **Kill switch** in the popup plus a keyboard command.
- **Auto-kill on anomalies:** auth failure, clock offset or latency out of bounds, repeated errors, schema drift.
- **Audit log.** An append-only log of every state change, request and response, containing no secrets.

**Timing.**
- **Clock offset.** Estimate the server clock offset from multiple samples, keeping the lowest-RTT sample. Prefer ItemDetail `serverTime` (ms) over `Dashboard/GetCurrentTime` and the HTTP `Date` header (both 1 s resolution).
- **Latency.** Measure latency with a harmless read.
- **Fire time.** Fire at end − lead − one-way latency. Justify a default lead and make it configurable.
  - Prior art spans about 1–15 s: BidSlammer 1 s, goodwill-snipper 3 s, Gixen 3–15 s (default 6), esniper 10 s.
  - Reports of SGW slowing down at peak hours are anecdotal ⚠. The dry-run soak must measure peak-hour latency, and that measurement sets the default.
- **Wake sequence:**
  1. Wake coarsely with an alarm several minutes early.
  2. Keep the background alive with **extension API calls** (e.g., `runtime.getPlatformInfo` or `storage`) at least every 25 s. **Never** use buyerapi requests for this.
  3. Re-check at about T−60 s: the item is still open, endTime is unchanged, the token is valid, the price is below max, and the user is not already the high bidder.
  4. Use a tight timer for the final second, not a throttled hidden-tab timer.

**Retries and idempotency.**
- Send one bid per snipe.
- Retry only when the bid provably never arrived. On an ambiguous response, re-read the item first. Timeouts and worker death mid-request count as ambiguous.
- Never exceed the max.
- A restarted worker must never double-bid.

**Outcomes.** Classify each snipe as won, outbid, below-minimum, auth, network, late, ended/extended, cap-blocked, killed or dry-run. Notify the user, keep the record, and stamp the result on the calendar event.

**Reliability while the user sleeps: the central design question.** State plainly what happens if the PC sleeps or the browser is closed, then compare these tiers:
- **(T0) Extension only.** Alarms are reconciled on every start, missed daily runs catch up, and preflight warnings tell the user when a snipe is at risk.
- **(T1) Extension + keep-alive.**
  - On Chrome: the `background` permission (MV3 behavior ⚠) plus `power.requestKeepAwake`, held from arming until the auction ends.
  - Keep-awake cannot wake a PC that is already asleep, and it does not block lid-close or manual sleep.
  - Firefox has a gap here ⚠.
  - Include OS power-setting guidance.
- **(T2) Local companion.** A native-messaging host, or an OS scheduled task with a **wake timer** (Windows Task Scheduler's "Wake the computer to run this task"), that wakes the PC and places the snipe even if the browser is closed.
  - The power plan's "Allow wake timers" setting must be on. Modern Standby laptops may only allow "important wake timers" ⚠.
  - Resuming and reconnecting to the network take time, so schedule the wake several minutes before T−0 and let the companion run the precise timer.
  - Weigh how the token is handed off and the session's likely binding to IP and user agent.
- **(T3) Remote server.** It must hold an SGW token off-device. The JWT is likely bound to IP and user agent ⚠, which may make this impossible or fragile.

Recommend one tier for the first sniping release and one for later; the user's machine is Windows 11. For snipes that can't be guaranteed, offer a per-snipe fallback the user picks as a default: place the max early as a normal proxy bid, or skip.

**Preflight.**
- Send a T−15 min notification checking login, token, clock and keep-awake, and confirming the price is still under the max. It offers one-click abort or fix.
- **The preflight must work while the user is asleep.** A failed preflight or an auto-kill applies the user's pre-chosen fallback automatically (early proxy bid, or skip), then reports what it did. A one-click fix does nothing for a sleeping user.
- Run auth-health checks 24 h and 1 h before any armed snipe, while the user is likely awake to fix problems. One Gixen user review describes a warning that arrived only after the auction closed ⚠.

**Bid groups** come in a later phase, with spacing validation and cancellation based on the actual outcome.

## Engineering principles (non-negotiable)

**TDD everywhere.** Each task lists its failing tests first, then the implementation, then the gate commands. A task is done only when the gates are green and the evidence is pasted.

**Ports and adapters.** Domain logic depends only on injected interfaces: `Clock`, `Http`, `Storage`, `Alarms`, `Notifier`, `SgwApi`, `CalendarApi`. That logic covers the rule engine, bid and increment math, the snipe state machine, the calendar event builder, the scheduler and the request scheduler. Browser glue stays thin.

**Site Adapter layer.** This is the only code that knows SGW specifics. It has four parts:
- **DomAdapter:** card discovery, itemId extraction and hide/highlight hooks, with ranked fallback selectors.
- **ApiAdapter:** typed requests and responses, with schema validation (e.g., zod) on every response. It owns the request scheduler: rate limits, the daily budget and backoff.
- **SessionAdapter:** token capture, refresh, expiry and a logged-out state.
- **ClockAdapter:** server offset and RTT, and Pacific-time parsing.

Selectors, endpoints and field names live in a versioned config. `healthCheck()` **fails closed**: when it fails, all write automation (favoriting, calendar writes, bidding) is disabled and the user is notified. Everything above the adapter depends only on its interfaces and normalized domain types (`Listing`, `ItemDetail`, `Favorite`, `BidResult`).

**Task 0 is a read-only recon spike.** It runs before any other site-facing work. Downstream tasks consume its fixtures, never the live site. It produces:
- sanitized HTML fixtures: grid and list cards, the item page, the favorites page, and logged-in and logged-out views
- JSON fixtures for every endpoint
- a chosen, documented token-capture approach
- the **measured SGW token lifetime**, and whether `SignIn/RefreshToken` works with no user present
- an empirical **soft-close verdict**. This needs no polling near T-0: read ItemDetail once before close and once after, then compare the final `endTime` with the last `bidHistory` bid time (ms precision).
- a list of Firefox-versus-Chrome differences

Steps that need the user's logged-in account become manual steps for the user, with exact instructions. For example, the PlaceBid response catalogue is captured from one cheap item the user actually wants.

**Test pyramid in every phase.**
1. Static checks: TypeScript strict, ESLint with unsafe-DOM rules, `web-ext lint --warnings-as-errors`, and a manifest-permissions snapshot that fails on any new permission.
2. Unit tests: Vitest, fake timers, and property tests for money and time math, including DST edges.
3. Contract tests: schema validation of sanitized, recorded fixtures. The same schemas validate live responses at runtime and fail closed.
4. Integration tests: WXT `fakeBrowser`, plus fakes for identity and permissions, plus MSW (`msw/node`) for HTTP.
5. Content-script tests against sanitized, *rendered* DOM captures, proving injection stays idempotent under SPA re-render.
6. Offline Chromium E2E against a **fake buyerapi server** and a fake Google server, using a base-URL override. The fake buyerapi has injectable latency, clock skew, error codes, token expiry and soft-close extension.
7. A Firefox E2E or smoke lane.
8. A scheduled, read-only, anonymous **live canary** that detects API and DOM drift. It never logs in, never writes, and respects the request budget.
9. Manual acceptance scripts for the real account, the real calendar and the first real snipe. A real-money test needs the user's explicit approval for a specific cheap item.

**Test tooling facts.**
- **Chromium only for Playwright.** Playwright supports extension E2E **only in Chromium**: its bundled Chromium via `launchPersistentContext` with `--load-extension`; the `chromium` channel supports headless.
  - Branded Chrome 137+ ignores `--load-extension`.
  - The service worker is reachable via `context.serviceWorkers()`. Routing the worker's own fetches is experimental ⚠.
- **Firefox.** There is no Playwright extension support for Firefox. Options:
  - Selenium/geckodriver with `install_addon(temporary=True)`
  - WebDriver BiDi `webExtension.install`
  - `web-ext run` for smoke tests
- **No MSW in the browser.** MSW intercepts fetch in Node, not inside a real extension worker, so E2E needs the local fake servers.
- **Alarm minimum.** Unpacked builds skip the 30-second alarm minimum, so tests can pass where production fails.
  - Enforce the 30 s floor and the arbitrary delay inside the `Alarms` port and its fake, and assert them in unit tests.
  - Verify alarm behavior manually on a packed or signed build.
- **Google auth in E2E.** E2E tests can't point `getAuthToken` or `launchWebAuthFlow` at a fake Google server. Use a test-only `GoogleAuthProvider` stub, compiled out of production builds.
- **Localhost in test builds.** Test builds need a localhost host permission for the fake servers. Take the permissions snapshot from the *production* manifest, and have CI prove localhost is absent there.

**No live writes in automated tests.** No automated test may favorite, bid, or touch a real calendar or account. Test-only hooks (time travel, alarm triggers, base-URL override) must be compiled out of production builds, and a CI check must prove it.

## Safety and security requirements

**Permissions.**
- Request least privilege: only shopgoodwill.com, buyerapi.shopgoodwill.com and the Google API hosts.
- Make the permissions for opt-in features optional: `notifications`, `background`, `power`, and for Calendar, `identity` plus host permissions for `https://www.googleapis.com/*` and `https://oauth2.googleapis.com/*`.
- Capturing the SGW session from the `Authorization` header needs either the `webRequest` permission or a script in the page's own JS context (MAIN world). The session spike must report each option's permission cost.
- The ntfy.sh fallback sends auction data to a third party, and anyone who knows a topic name can read it. Make it opt-in, with:
  - an unguessable topic name
  - its own host permission
  - disclosure in the Firefox `data_collection_permissions`

**Credentials and tokens.**
- Never store the user's password.
- Decide where SGW and Google tokens live, and how expiry is handled.
  - Anything the unattended jobs need goes in `storage.local`: the Google refresh token, and the SGW session if refresh works.
  - Short-lived access tokens go in memory or `storage.session`.
  - Never use `storage.sync` for tokens.
- When a token is missing, degrade gracefully: still search, queue favorites and calendar writes, and notify the user.

**Untrusted input.**
- Treat all listing text and every SGW API response as attacker-controlled. For example, PlaceBid's `message` is HTML, so the audit log and the UI must render it as text.
- Use no `innerHTML`, and put injected UI in Shadow DOM.
- The background must validate the sender of every message.
- Content scripts must never trigger state-changing actions on their own.

**Other.** No telemetry and no remote code.

## UX direction

**Surfaces.**
- In-page card badges and quick actions (Shadow DOM).
- A toolbar popup for status and the kill switch.
- A dashboard: Chrome `sidePanel` or Firefox `sidebar_action`, or an options-page tab.
- An options page for rules, settings, import/export and the activity log.

**Hiding is never silent.**
- Collapsed stubs, plus an "N hidden · show" bar.
- A per-card "Why?" naming the rule that matched.
- One-click undo, plus a one-switch global off.

**Dashboard sections:**
- Watches: last run, next run, new matches, Run now.
- Matches and Favorites.
- Snipes: armed, countdown, result.
- Calendar sync status.
- Health: SGW session, Google token, site-drift check.
- The activity log of every autonomous action, with its reason and an undo.

**Throughout:**
- Show local time and Pacific time side by side everywhere.
- Highlights are never color-only, and everything is keyboard-operable.
- Onboarding takes under 3 minutes:
  1. Detect the SGW login.
  2. Enter the home ZIP.
  3. Connect Google Calendar (skippable, with an `.ics` fallback).
  4. Create the first watch from the current search.
  5. Dry-run it.

## Execution environment

- **Dev machine:** Windows 11 with Node 25, Python 3.14 and git. Chrome (per-user install), Chromium and Firefox 157 are installed. The GitHub repo is available, with Actions, through an authenticated `gh` CLI.
- **Worker agents:** they can run shell commands, edit files, search the web, and drive a Chromium browser via Playwright. They cannot log in to the user's SGW or Google accounts. Anything needing a real login is a manual step for the user; list every one.

## Deliverables: structure the plan exactly as follows

1. **Key decisions, with rejected alternatives.** Cover:
   - the framework
   - how the daily job and the snipe timer actually wake in each browser
   - the recommended reliability tier
   - the auth approach for SGW and for Google
   - where buyerapi calls originate
2. **Architecture.** Include:
   - modules and a text data-flow diagram
   - the storage schema, with a version field and migrations
   - the message protocol
   - every permission per browser, with its justification
   - a Chrome vs Firefox differences table
3. **Interface contracts.** TypeScript signatures with example payloads for:
   - the adapters and domain types
   - the rule engine and the scheduler
   - the request scheduler / rate limiter
   - favorites
   - `CalendarSink` and `GoogleAuthProvider`:
     - `getAccessToken({interactive})`, `connect()`, `disconnect()` and `status()`. `disconnect()` **revokes** the token: a POST to Google's revoke endpoint for the refresh-token flow, or `clearAllCachedAuthTokens` for getAuthToken.
     - The error taxonomy: `invalid_grant`, 401, insufficient scope, 429/quota, offline.
   - the snipe engine, the audit log, settings, and the message types

   Freeze these in Phase 0, before parallel work starts.
4. **Phase 0 spikes, each with exit criteria.** At minimum:
   - SGW recon (Task 0)
   - session capture, the token lifetime, and unattended refresh
   - the soft-close verdict
   - Google OAuth on both browsers with the user's own project
   - event-ID 409/cancelled behavior
   - the Firefox E2E harness
   - dry-run snipe timing measurement
   - wake-from-sleep feasibility on Windows, including the MV3 `background` permission, wake timers, and Modern Standby
5. **Phases and milestones, each with verification gates.**
   - MVP = requirements 1–4.
   - Sniping follows: a dry-run soak, then live bidding with caps.
   - Each phase ends in something the user can install and try.
6. **Task cards.** For each task give:
   - ID and goal
   - contracts consumed and produced
   - files owned (no two parallel tasks may touch the same file)
   - dependencies
   - the tests-first list and acceptance criteria
   - the gate command
   - size (at most about one agent-day)

   Mark the parallel lanes.
7. **Test strategy.** Include:
   - pyramid targets
   - the fixture capture and sanitization procedure
   - the GitHub Actions workflow: static → unit → contract → Chromium E2E → Firefox lane, plus the nightly canary
   - the flake policy
   - the manual acceptance checklists
8. **Threat model table:** asset, threat, control, and the test that proves the control.
9. **Considerate-use budget.** For each feature: expected SGW requests per day, peak requests per minute, and its scale-down switch.
10. **Personal-use setup guide outline:**
    - the Google Cloud project
    - loading unpacked in Chrome
    - Firefox unlisted signing
    - installing the companion, if one is chosen
11. **Release and distribution** for both browsers.
12. **Risk register:** likelihood, impact, mitigation, and the task that owns each risk. At least:
    - account suspension (ToS)
    - API or DOM drift
    - token expiry and IP/UA binding
    - clock skew and latency
    - missed snipes (sleep, closed browser, peak overload)
    - money loss and typos
    - Google OAuth changes and the 7-day expiry
    - rate limiting and blocks
    - store review
    - data loss
13. **QoL list, tagged MVP, later or stretch.** Seed candidates (add your own):
    - dry-run for everything
    - health checks that pause automation on site drift
    - landed-cost badge (bid + shipping + handling to the user's ZIP), with rules on landed cost
    - max bid entered as an all-in price
    - calendar events that update, stamp WON/LOST and delete themselves
    - a dedicated calendar
    - one-click hide this seller, location or keyword from a card
    - live rule preview ("matches 7 of 40 on this page")
    - whole-word and negative keywords (the site's search matches "men" inside "women")
    - kill switch with an armed-snipe badge
    - exposure meter
    - snipe groups
    - post-auction outcome report
    - timing diagnostics
    - activity log with undo
    - server-synced countdown
    - relist detector
    - sold-price comps (link-out)
    - pickup-only badge with distance
    - combined-shipping hint
    - importing SGW saved searches
    - rules import/export as JSON (in `storage.local`, because of `storage.sync` quotas)
    - a daily digest with quiet hours
    - friend list (never bid against these users)
    - misspelling variants for keywords
    - late-add alert
    - typo guard
14. **Open questions for the user.** Include only those that block the plan or materially change it. Already decided: the ToS risk is accepted, and all five features are wanted.

Be concrete and decisive. Flag every assumption, and route each ⚠ item to a spike. Prefer a small verifiable MVP that grows, but don't lose sight of the user's real goal: winning auctions while they sleep, without being a burden on the site.
