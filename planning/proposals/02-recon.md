# 02-recon — ShopGoodwill Site & API Recon

## Research Findings

Researched 2026-10-07. Every claim below is tagged by how I know it:
- **[observed]**: I saw it myself in a read-only request on 2026-10-07. That was about 10 requests in total: the homepage, one search page rendered in a headless browser, one public `Search/ItemListing` POST, one public item-detail GET, one `Dashboard/GetCurrentTime`, the Terms page, and `main.918356f8354624fa.js`.
- **[bundle]**: read from the site's current production JS bundle.
- **[community]**: taken from open-source projects, with dates.
- **[unverified]**: a claim I could not confirm.

I did not log in, favorite, or bid.

### 1. Front-end stack and hosting
- **Angular 15.2.9 with SSR** [observed]: `<app-root ng-version="15.2.9" ng-server-context="other">`. The bundles are `runtime/polyfills/scripts/main.<hash>.js`. The UI kit is PrimeNG plus Bootstrap classes (`p-grid`, `p-col-*`, `pi pi-search`, `btn`).
- **SSR renders only skeleton cards** [observed]. Search results come from the client-side XHR, and the server HTML holds `.placeholder-image` and `.text-line` placeholders. Content scripts therefore have to wait for client render and handle re-renders on SPA route, page, or filter changes (MutationObserver plus route-change detection).
- **Hosting** [observed]: both `shopgoodwill.com` and `buyerapi.shopgoodwill.com` sit behind **Azure Front Door** (`x-azure-ref`, `X-Cache`). The API is **ASP.NET on Azure App Service** (`X-Powered-By: ASP.NET`, cookies scoped to `wapp-buyermvc-prod.azurewebsites.net`).
- **No Cloudflare or bot-challenge** was seen on the site or the API [observed]. The site does load Google reCAPTCHA (the `ngx-captcha` module, `reCaptchaEnabled: true` in the config) [bundle]. I could not verify which flows it gates (login? registration?).
- The site carries heavy ad-tech (Playwire/Prebid, GAM, Criteo, Adobe, Emarsys) [observed]. Pages are noisy, slow, and log many console errors, so injected UI must not depend on page timing.
- The site polls `/version.json` (every 10 minutes per `versionCheckfrequency`) and has an `appVersion` [bundle]. Bundle hashes change on every deploy, so nothing should be keyed off bundle filenames.

### 2. URL patterns
- **Item page:** `https://shopgoodwill.com/item/{itemId}` [observed, numeric IDs such as 279250057].
- **Search:** `/categories/listing?st=<text>&sg=&c=<catIds>&s=<sellerIds>&lp=0&hp=999999&sbn=&spo=false&snpo=false&socs=false&sd=false&sca=false&caed=10%2F7%2F2026&cadb=7&scs=false&sis=false&col=1&p=1&ps=40&desc=false&ss=0&UseBuyerPrefs=true&sus=false&cln=1&catIds=&pn=&wc=false&mci=false&hmt=false&layout=grid&ihp=` [observed].
  - These parameters map 1:1 to the `Search/ItemListing` JSON body. My mapping is an inference from the names: st=searchText, c=selectedCategoryIds, s=selectedSellerIds, lp/hp=low/highPrice, spo=searchPickupOnly, socs=searchOneCentShippingOnly, sd=searchDescriptions, sca=searchClosedAuctions, col=sortColumn, p=page, ps=pageSize, desc=sortDescending, ss=savedSearchId, layout=grid|list.
  - So a rule engine can turn any site search URL into an API query.
- **Other pages:** `/categories/new`, `/categories/gallery`, `/categories/hot50`, `/shopgoodwill/favorites`, `/shopgoodwill/saved-searches`, `/shopgoodwill/personal-shopper-list`, `/shopgoodwill/inprogress-auctions`, `/about/terms-of-use` [observed].

### 3. Search-result card DOM [observed, grid layout only; list layout not inspected]
```
div.item-col (PrimeNG col)                       ← card wrapper (hide target)
 └ app-home-product-items                        ← Angular component tag (most stable hook)
    └ div.feat-item
       ├ a[href="/item/{id}"] > figure > img.feat-item_img
       ├ div.feat-item_info
       │  ├ a.feat-item_name[id="{itemId}"][href="/item/{id}"][title="<full title>"]
       │  ├ p.feat-item_price  (" $9.99 ")
       │  └ a.btn-heart[aria-label="Add to your Favorites list"]
       └ ul.feat-item_bottom > li "Bids: 0" | li.text-danger (<span.sr-only>Time remaining:</span> 13m 52s) | li > a[title="Quick Bid"]
```
- The same `app-home-product-items` and `.feat-item` component also renders homepage, featured, and new-item cards [observed]. One card adapter covers most surfaces.
- Do **not** select on `_ngcontent-serverapp-cNN` or `_nghost-*` attributes. They are build-specific.
- Prefer, in this order: `app-home-product-items`, then `a[href^="/item/"]` with an itemId regex, then `.feat-item_*`. Pull the itemId from the href or `id`, and get the truth (price, end time) from the API rather than parsing card text.

### 4. Buyer API (`https://buyerapi.shopgoodwill.com/api/`) — undocumented and reverse-engineered
| Purpose | Endpoint | Status |
|---|---|---|
| Search | `POST Search/ItemListing` (JSON body; booleans sent as **strings** "true"/"false") | [observed] anonymous 200. Response keys: `searchResults{items[],itemCount}`, `maxTotalRecords`=**10000**, `categoryListModel`, `isAzureSearchEnabled`=true. Item fields: `itemId,title,currentPrice,minimumBid,numBids,startTime,endTime,remainingTime,sellerId,listingType,buyNowPrice,shippingPrice,imageURL,catFullName,isFavorite,startingPrice,relistId,...` |
| Item detail | `GET ItemDetail/GetItemDetailModelByItemId/{id}` | [observed] anonymous 200. Includes `endTime`, **`serverTime` (with ms)**, `bidIncrement`, `minimumBid` (=next acceptable bid), `numberOfBids`, `bidHistory.bidSummary[]` (masked bidder `m****e`, amount, time), `isReserveMet`, `inWatchlist`, `sellerId`, `pickupOnly`, `shippingPrice` |
| Server clock | `POST Dashboard/GetCurrentTime` → `{"data":"10/07/2026 14:05:04"}` (PT, **seconds only**); `GET Dashboard/GetCurrentTimeV1` exists | [observed] the web app calls it on load. The HTTP `Date` header is also usable |
| Favorite add / remove | `GET Favorite/AddToFavorite?itemId=`, `GET Favorite/RemoveItemFromFavoriteList?itemId=` | [bundle] current |
| List favorites | `POST Favorite/GetAllFavoriteItemsByType?Type=open\|close\|all` (returns `watchlistId, notes, endTime, sellerId, ...`) | [community, used by repos updated 2026-09/10] |
| Favorite note | `POST Favorite/Save {notes, watchlistId}`. Max length is 256 per the code but 500 per the README, which conflict | [community, scottmconway] |
| Saved searches | `POST SaveSearches/GetSaveSearches` | [bundle + community] |
| Bid prep | `GET ItemBid/ShowBidModal?itemId=` (gives `sellerId`, `minimumBid`) | [community] |
| Place bid | `POST ItemBid/PlaceBid {itemId, bidAmount:"12.00", sellerId, quantity:1}` → `{status, result, message(HTML)}`; `result:-3` = "Auction has closed" | [community, scottmconway 2022–2025]. Lives in a lazy chunk, not main.js. Other result codes (-110 auth, -4/-5 too low) are [unverified, from an AI-generated repo] |
| Auth | `POST SignIn/Login`, `POST SignIn/RefreshToken {refreshToken, clientIpAddress}`, `POST SignIn/RevokeToken` | [bundle] |
| Shipping estimate | `POST ItemDetail/CalculateShipping {itemId, zipCode, country, quantity, ...}` returns HTML, so parse it | [community] |

### 5. Auth and session
- Authenticated calls send `Authorization: Bearer <JWT>` [bundle].
  - The JWT is **HS256**. Its claims are `BuyerId, BuyerSession, IpAddress, Browser (full UA string), exp, iss/aud=https://buyerprodmvc.ocgoodwill-techservices.org/` [community: a token leaked in a public repo, 2026-03].
  - The token is likely bound to IP and UA. That strongly favors making API calls **from the user's own browser** over a cloud server.
- **Login "encryption"** [bundle, still present 2026-10-07]: the username and password are AES-CBC encrypted with a **hard-coded key**, a zero IV, base64 and URL-encoding. It is pure obfuscation. The login body is `{userName, password, remember, appVersion, clientIpAddress, browser}`.
  - Source: https://conway.scot/shopgoodwill-reversing/ (2022).
  - The extension should **never** need the user's password.
- **Session storage** [bundle]: the site keeps `{accessToken, refreshToken{token,createdByIp}, buyer{buyerId}}` in a JS-readable cookie named **`cookieSession_8`** (Secure, SameSite=Strict, 1-day default expiry).
  - The cookie is CryptoJS-AES encrypted with a passphrase derived from a constant in the bundle.
  - Decrypting it is possible but brittle. Watching the `Authorization` header on the site's own buyerapi requests (webRequest) is a cleaner way to capture the token.
- **CORS** [observed]: buyerapi returns `Access-Control-Allow-Origin: https://shopgoodwill.com`. Extension background fetches with host permissions get around this (Chrome; Firefox once the user grants host permission). Content-script fetches in Chrome run with the page origin, so they also work.
- **Gotcha** [community, issue #31, 2025-04]: after a bid, buyerapi sets a `Bid` cookie, and the next bid sent with that cookie returns **403**. API calls should use `credentials:'omit'` (bearer only).

### 6. Time, end rules, bidding semantics
- `endTime` is **US Pacific local time with no offset**, for example `2026-10-07T14:18:30` [observed: it matched `remainingTime` against the `Date` header]. Fractional seconds appear inconsistently, e.g. `...:17.45` [community issue #32, 2025-04]. Convert with IANA `America/Los_Angeles` so DST is handled.
- **Proxy bidding is built in** [official FAQ https://shopgoodwill.com/help/faqdetail/automatic-proxy-bidding, updated 2024-04-22]. You enter a max, the system bids up by the increment, and the max stays hidden.
  - The increment comes back per item in `bidIncrement`: $1.00 at a $16 price [observed]. No official increment table was found, so the plan should use the API value.
  - A "snipe" is therefore placing your max bid at T-minus-N seconds.
- **End rule: probably a hard close, but not confirmed.**
  - The official FAQ only warns that a last-second bid "may not be accepted and processed before the auction closes" (https://shopgoodwill.com/help/faqdetail/i-tried-bidding-on-an-item-in-the-last-second, 2024-04-04).
  - Third-party sources conflict. BidPulse says there is no extension. lancetm714's README says sellers can extend or soft-close.
  - **The recon spike must verify this empirically** (read-only): watch the `endTime` of items that get late bids.
- Sellers can **end auctions early**, and bids are retracted with an email (FAQ: why-did-the-auction-i-was-bidding-on-end-early). So calendar events and snipes must handle cancellation.
- The tie-break rule is unknown [unverified].
- Search-result `minimumBid` is the starting minimum. Item-detail `minimumBid` is the next acceptable bid [observed: 12.99 vs 17.00 on the same item].

### 7. Rate limits and anti-bot
- I found no documented limits.
- Community-reported failure modes:
  - 403 when `searchText` contains double quotes (since 2025-03, scottmconway README).
  - 403 on the second bid in a session because of the `Bid` cookie.
  - Occasional 403s, 5xx outages, and connection resets in 2024 and 2026 (issues #26, #28, #33).
  - Wrong body types give a **200 with zero rows** or a 500 (pipeworx 2026-09).
  - `pageSize` is ignored: always 40 rows (pipeworx; my request used 40).
- Search results are capped at 10,000 (`maxTotalRecords`) [observed].
- The closed-auction archive reaches back about 90 days [community].
- A conservative budget: at most 1 request per second, backoff on 403/429/5xx, and a hard daily request cap.

### 8. Terms of Use — high risk (Last updated 01/22/2025, https://shopgoodwill.com/about/terms-of-use) [observed]
- Users may not "use any robot, spider, crawler, scraper, script, **browser extension**, offline reader or other automated means or interface not authorized by us to access the Services, extract data, or otherwise **interfere with or modify the rendering of Site pages** or functionality."
- Users may not "develop any third-party applications that interact with the Services without our prior written consent."
- The license is "for your own private, non-commercial purposes."
- You must "not have more than one ShopGoodwill account". That rules out the two-account "ban evasion" pattern in scottmconway's bid_sniper.
- Won bids are binding, and "Bid manipulation is strictly prohibited."
- In short, every requirement here (hide/highlight, auto-favorite, auto-bid) is technically prohibited, and the user's account could be suspended. Treat this as an explicit user decision, not something to engineer around.

### 9. Extension-platform gotchas (Chrome/Firefox docs)
- `chrome.alarms` fires at most once every 30 s. Alarms keep firing through sleep and catch up on wake.
  - Persistence across restarts needs `persistAcrossSessions` (Chrome 150+), and behavior is otherwise "unpredictable" (https://developer.chrome.com/docs/extensions/reference/api/alarms).
  - So: re-register on startup and catch up on missed daily runs.
- MV3 service workers and Firefox event pages get suspended. Second-accurate sniping needs a keep-alive window near T-0, and **the browser must be running and awake**. That is the main weakness compared with server-side snipers.
- Google Calendar allows at most **5** `reminders.overrides` (popup/email, 0–40320 min), so the 60/15/5 popup set fits. Use `extendedProperties.private` to store `sgwItemId` for dedupe (https://developers.google.com/workspace/calendar/api/v3/reference/events).
- `identity.getAuthToken` is Chrome-only. Firefox needs `identity.launchWebAuthFlow`.

## Existing Tools / Prior Art

**ShopGoodwill-specific**
- scottmconway/shopgoodwill-scripts — Python client with a bid_sniper daemon (max bid stored as JSON in the favorite note), saved-query alerts, and dry-run. It is the source of most endpoint knowledge (97★, pushed 2025-08). https://github.com/scottmconway/shopgoodwill-scripts
- conway.scot "Reverse Engineering ShopGoodwill" — the login AES key and IV writeup (2022). https://conway.scot/shopgoodwill-reversing/
- pkmnct/shopgoodwill-ts-api — TypeScript port of the client (2023). https://github.com/pkmnct/shopgoodwill-ts-api
- pkmnct/shopgoodwill-ical — serves your favorites as an iCal feed. It is the only calendar prior art found. https://github.com/pkmnct/shopgoodwill-ical
- sottey/sgwnotify — Go/macOS notifier for favorites ending soon plus keyword search, using a pasted bearer token (2026-10). https://github.com/sottey/sgwnotify
- lancetm714/shopgoodwill-watchlist — "ToS-safe" watchlist plus a browser extension that captures the end time from the page; no API use (2026-09). https://github.com/lancetm714/shopgoodwill-watchlist
- lancetm714/shopgoodwill-notifier — polls ItemListing and alerts via email or Telegram (2026-08). https://github.com/lancetm714/shopgoodwill-notifier
- RichardMcQuiston01/legendary-goggles — MV3 Vite/TS extension scaffold with captured API requests (2026-04). https://github.com/RichardMcQuiston01/legendary-goggles
- pipeworx-io/mcp-shopgoodwill — MCP server for search, sold comps, and item detail, with documented 2026-09 API quirks. https://github.com/pipeworx-io/mcp-shopgoodwill
- Bzcasper/sgw-jewelry-sniper — AI-generated TS/Rust sniper. It claims 257 endpoints, RefreshToken, and GetCurrentTime clock-offset usage; treat it as unverified (2026-10). https://github.com/Bzcasper/sgw-jewelry-sniper
- denisjovic/goodwill-cli — Go search CLI that fixes substring matching ("men" matches "women"). https://github.com/denisjovic/goodwill-cli
- ShopGoodwill Sniper (BotGrabber) — commercial desktop sniper with clock sync and auto-max. It installs via `curl | bash`, which is a red flag. https://github.com/shopgoodwill-auction-sniper/shopgoodwill-sniper
- ShopGoodwill Helper — Chrome extension (v4.1, about 100 users) with shipping estimates by ZIP, a live price and countdown, and research links. https://chromeboard.com/extension/shopgoodwill-helper-llampoenjhpfnepahgdiigndopefgihg. A Firefox port: https://addons.mozilla.org/firefox/addon/shopgoodwill-helper/
- Goodwill Listings to CSV — Firefox add-on that exports result pages. https://addons.mozilla.org/firefox/addon/goodwill-listings-to-csv/
- sgwpricecheck — Firefox add-on with a "Compare on eBay" context menu. https://addons.mozilla.org/firefox/addon/sgwpricecheck/
- Apify ShopGoodwill Scraper — paid scheduled scraper. https://apify.com/automation-lab/shopgoodwill-scraper
- SGW Fixer — userscripts for the **seller** site only, 2016–2018. https://greasyfork.org/en/scripts/7850-sgw-fixer-current
- Official features: Saved Searches with email alerts, Favorites, and a Personal Shopper keyword list. iOS app: https://apps.apple.com/app/id1590146817

**Other sites**
- Gixen — server-side eBay sniper that fires about 6–8 s before close; it shows the timing norms. https://www.gixen.com/blog/how-does-ebay-bidding-work/
- Myibidder — eBay sniper extension that adds "Snipe it" and "Snipe these" links to item and search pages (about 20K users, MV3). https://chrome.google.com/webstore/detail/fmebanjjkaohcmifehogijfgcoieefnp
- Craigslist hide items — classic userscript pattern for per-listing hide. https://greasyfork.org/scripts/1746-craiglist-hide-items
- eBay User Agreement 2026 — bans "buy-for-me" agents and LLM bots, a sign of where marketplaces are heading. https://www.theregister.com/2026/01/22/ebay_updates_legalese_to_ban/

## Quality-of-Life Ideas
1. **[MVP] Adapter health badge.** A self-test on page load checks that the card selectors, the search endpoint, and the clock all work. If something drifts, it shows "SGW changed — automation paused" instead of failing silently.
2. **[MVP] Whole-word and negative keyword rules.** These fix the site's substring search ("men" matching "women") and handle the 403 that quotes trigger.
3. **[MVP] Server-synced countdown on cards and item pages.** It uses the ms `serverTime` offset, since the site itself says you must refresh to see real time.
4. **[MVP] Dry-run mode for all automation.** It logs what *would* be favorited, calendared, or bid. This is proven in scottmconway's `--dry-run`.
5. **[MVP] Seller/location hide list and pickup-only filter.** It hides far-away pickup-only lots in one click.
6. **[later] True-cost badge.** Price plus a cached `CalculateShipping` estimate for the user's ZIP, because shipping often exceeds the item price.
7. **[later] Relist detector.** It fingerprints title, seller, and image so a relisted item (new `itemId`) is shown as "seen before at $X" instead of "new."
8. **[later] Sold comps.** Median closing price from closed-auction search (about 90-day window) shown on cards.
9. **[later] Calendar lifecycle sync.** It updates or deletes events when `endTime` changes, the auction ends early, or the user unfavorites the item.
10. **[later] Snipe budget guard.** A daily and simultaneous spend cap, so several armed snipes cannot all win and blow the budget.
11. **[stretch] Max bid stored in the SGW favorite note**, as JSON. Armed snipes then sync across devices through the user's own account.
12. **[stretch] Rules import/export and `storage.sync`**, plus a shareable "rule pack" JSON.

## Fable Prompt

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
