## Research Findings

Author: 03-sniper (BIDDING & SNIPING specialist). Research date: 2026-10-07. All fetches were read-only. I did not log in, bid, or favorite anything. Confidence tags: **[confirmed]** means I read it at a primary source. **[community]** means it comes from open-source code or forums. **[UNVERIFIED]** means a single or weak source that needs empirical confirmation.

### A. ShopGoodwill (SGW) platform facts

1. **The Terms of Use explicitly prohibit browser extensions and scripts. [confirmed]** The SGW Terms of Use were last updated 01/22/2025 (https://shopgoodwill.com/about/terms-of-use, fetched 2026-10-07). The Acceptable Use section forbids using "any robot, spider, crawler, scraper, script, browser extension, offline reader or other automated means … or interface not authorized by us to access the Services, extract data, or otherwise interfere with or modify the rendering of Site pages or functionality". This applies to the whole product, not only to bidding: hiding or highlighting listings is "modify the rendering". The same document says "Bid manipulation is strictly prohibited" and forbids using another person's account without authorization. It also says winning bidders "ARE OBLIGATED TO COMPLETE THE TRANSACTION", that bids are "not retractable except in exceptional circumstances" (for example, clear typographical errors), and that SGW "will record, monitor, suspend or ban any bidder who fails to fulfill his or her obligation to purchase". **Consequence:** an account ban is a real risk, and a bidding bug costs real money that is hard to undo.
2. **robots.txt [confirmed]** (https://shopgoodwill.com/robots.txt) sets `Crawl-delay: 120` and disallows `/shopgoodwill/` (the account pages: favorites, saved searches), `/checkout/` and `/categories/listing?st=`. The ToS separately forbids bypassing robots.txt.
3. **Proxy bidding is built in. [confirmed]** SGW's own blog (https://blog.shopgoodwill.com/english/the-ultimate-guide-to-bidding-buying) says the system "automatically raises your bid by small increments" up to your max. The same post openly describes expert bidders "sniping" at "the last second". Implication: a sniper should submit the user's **single max bid once** and let SGW resolve the price. Re-bidding in increments is pointless and only adds requests. No increment table was found. Item detail reportedly includes a `bidIncrement` field [community].
4. **Hard close vs soft close is not documented. Evidence leans toward hard close. [UNVERIFIED]**
   - A Goodwill Industries (Canada) FAQ about ShopGoodwill says "Bids placed in the last seconds may not be processed before the auction closes" (https://www.goodwillindustries.ca/?p=7581).
   - A forum poster held the high bid for an hour and was then "beaten out in the last minute with no time to respond" (https://audiokarma.org/forums/threads/got-sniped.670450/post-8943584).
   - SGW sniping tools exist and are marketed.
   - **The engine must detect an end-time change rather than assume either model.**
5. **End times are Pacific Time and come as naive strings. [community, three independent codebases]** The API's `endTime` is `"YYYY-MM-DDTHH:mm:ss"` with no offset, and every client parses it as `America/Los_Angeles`: scottmconway/shopgoodwill-scripts, robherley/gw-bot `inferTime()`, and Bzcasper/sgw-jewelry-sniper. The site footer shows "Time - PT". Gotchas:
   - JavaScript `Date.parse()` treats such a string as *local* time.
   - Around the November DST fall-back, 01:00–02:00 PT is ambiguous.
6. **There is no official API.** The Angular SPA calls `https://buyerapi.shopgoodwill.com/api/` with `Authorization: Bearer <token>`. The endpoints below were seen in open-source code; none are documented and any could change:
   - `POST SignIn/Login`: username and password are AES-CBC encrypted with a key hardcoded in the frontend bundle (https://conway.scot/shopgoodwill-reversing/, 2022).
   - `POST Search/ItemListing` (search).
   - `GET ItemDetail/GetItemDetailModelByItemId/{id}`: returns `endTime`, `currentPrice`, `minimumBid`, `bidIncrement`, and per the goodwill-snipper code also `remainingTime` and `bidHistory.isHighBidderLogIn`.
   - `GET ItemBid/ShowBidModal?itemId=`: returns `sellerId`, `minimumBid`, `currentPrice`.
   - `POST ItemBid/PlaceBid`: body `{itemId, sellerId, quantity:1, bidAmount}`. scottmconway formats the amount as a 2-decimal string.
   - `GET Favorite/AddToFavorite?itemId=`.
   - `POST Favorite/GetAllFavoriteItemsByType?Type=open|close|all`.
   - `POST Favorite/Save`: favorite notes, 256-char truncation in code.
   - `POST ItemDetail/CalculateShipping`.

   Sources: https://github.com/scottmconway/shopgoodwill-scripts (shopgoodwill.py), https://github.com/taciturnaxolotl/goodwill-snipper (utils/api.ts), https://github.com/robherley/gw-bot.

   **[UNVERIFIED, single repo that may be AI-generated: Bzcasper/sgw-jewelry-sniper API-CONTRACTS.md]**
   - `POST SignIn/RefreshToken`.
   - `POST Dashboard/GetCurrentTime` (a server-time source).
   - A `serverTime` field returned by `Search/GetItemsById`.
   - PlaceBid result codes: `-110` auth, `-4/-5` too low, `-3` rejected.

   Other quirks:
   - SGW rejects the default python-requests User-Agent.
   - Double quotes in `searchText` return a 403.
   - Result sets are capped at 10k.
7. **New-account limit. [UNVERIFIED]** A third-party guide (https://www.underpriced.app/blog/goodwill-bidding-2026, updated 2026-10-02) cites a 2026-01-29 help-center update: accounts under 30 days old are limited to 15 active auctions where they are the high bidder. The snipe engine should treat any similar rejection as a distinct failure type.
8. **The SGW account has native favorites and saved searches** at `/shopgoodwill/favorites` and `/shopgoodwill/saved-searches`. These are the natural sync targets for requirements 2 and 3.

### B. How established snipers work

9. **Server-side execution is the norm**, because it is the only way to snipe while the user's PC is off. Gixen, eSnipe, AuctionSniper, BidSlammer and JustSnipe all place bids from their own servers.
   - **Gixen FAQ [confirmed]** (https://www.gixen.com/main/faq.php):
     - Free tier: "5 seconds or less" before the end.
     - Paid Mirror tier: user-selectable offsets of 3, 6 (default), 8, 10, 12 or 15 s, plus a second copy of each snipe on a mirror server. Group snipes are *not* mirrored because cross-server cancellation is hard.
     - Edits should be made at least 2 minutes before the end.
     - "No sniping service or software can give you 100% guarantee."
     - In 2017 Gixen moved from storing eBay passwords to OAuth-style authorization. That is the lesson: don't hold the user's password.
   - **BidSlammer [community]:** the free tier bids 10 s before the end and paid tiers 1 s before; snipes can be edited or cancelled until 15 s before the end.
10. **Client-side tools:**
    - esniper (https://manpages.ubuntu.com/manpages/jammy/man1/esniper.1.html) defaults to 10 s before the end. It has `-n` "Do not bid" (dry-run that exercises everything else), `-q` quantity semantics ("quit when it has won enough items") and per-auction log files.
    - JBidwatcher "synchs up with eBay official time", which is the precedent for estimating a server clock offset.
    - PowerSniper (Chrome) only snipes if a browser tab is open at the right time.
11. **Bid groups ("win one of N"):**
    - eSnipe bids on each auction in sequence, then cancels the rest after a win (O'Reilly *eBay Hacks*, https://oreilly.com/library/view/ebay-hacks/0596005644/ch03s05.html).
    - Gixen says items in a group should not end within 2 minutes of each other. It also offers *contingency* groups (cancel the rest if one is lost) and *multi-win* groups (stop after N wins).
    - AuctionStealer requires at least 30 s between group snipes.
    - Lesson: winning must be confirmed by reading the actual result before later group members fire.
12. **Failure taxonomy** (Gixen FAQ):
    - Bid below the current price plus the increment.
    - Restricted auction.
    - An auth interstitial the bot cannot pass.
    - A network outage.
    - Site software changes.
    - Edits made too late.
13. **Late bids really do fail.** In Ockenfels & Roth's survey, 63 of 73 eBay late bidders had at least once seen the auction close before their last-minute bid registered (https://www.cs.princeton.edu/courses/archive/spr08/cos444/papers/ockenfels_roth06.pdf).
14. **Soft-close variants:**
    - Proxibid: a bid in the last 5 min adds 5 min (2008 article).
    - Catawiki: +90 s.
    - Municibid: resets to 2 min.

    Research found that sniping still happens under soft close but is less profitable. I could not confirm current HiBid or GovDeals rules, and found **no** sniper that supports HiBid, Proxibid or GovDeals.
15. **Existing SGW snipers and what to learn from them:**
    - **scottmconway `bid_sniper.py`** (read the source):
      - Fires `bid_snipe_time_delta` before the end, **default 30 seconds**, using the *local* clock with no server offset.
      - Waits with a single `asyncio.sleep`.
      - **No retries** and **no price-vs-max check.**
      - Has `--dry-run`, but dry-run logs look identical to real bids.
      - Has a `friend_list` to avoid outbidding friends.
      - Stores max bids as JSON inside SGW favorite notes, which exposes your max to SGW.
      - Supports a split "command" and "bid" account. That is a ToS hazard given the multiple-account clause.
    - **taciturnaxolotl/goodwill-snipper:** `LEAD_TIME=3` and a `BID_SAFETY` flag.
    - **Bzcasper/sgw-jewelry-sniper:** estimates the offset from the HTTP `Date` header plus RTT/2, which is only ±1 s because `Date` has 1-second resolution. It spin-waits through the final milliseconds and retries once on "too low".
    - **"ShopGoodwill Sniper" desktop app** (github.com/shopgoodwill-auction-sniper): a third-party "BotGrabber" login, and installation via `curl … | bash` or a downloaded VBS run by `wscript`. That is a classic malware-delivery pattern, so do not recommend or emulate it.

### C. Browser-platform constraints (drive the reliability story)

16. **Chrome MV3 [confirmed]:**
    - Service worker lifecycle (https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle): the worker is killed after 30 s idle, after 5 min on a single event, and when a fetch takes over 30 s. Extension API calls reset the idle timer (Chrome 110+).
    - `chrome.alarms` (https://developer.chrome.com/docs/extensions/reference/api/alarms): limited to "at most once every 30 seconds but may delay them an arbitrary amount more". Alarms do **not** wake a sleeping device, and "when the device wakes up, any missed alarms will fire", which is too late for a snipe. `persistAcrossSessions` arrived in Chrome 150.
    - So an alarm can only be a coarse wake-up a few minutes before the end. The final seconds need an in-memory timer in a context that stays alive. That needs a spike to validate.
17. **Hidden-page timer throttling [confirmed]** (https://developer.chrome.com/blog/timer-throttling-in-chrome-88): hidden pages get timers checked once per second. After 5 min hidden with chained timers, checks drop to once per **minute**. Never rely on a background tab's `setTimeout` for the fire moment.
18. **`chrome.power.requestKeepAwake('system')` [confirmed]** (https://developer.chrome.com/docs/extensions/reference/api/power) prevents sleep from *user inactivity* only, not lid-close or manual sleep, and needs the `power` permission. I found **no Firefox WebExtension equivalent**. The Screen Wake Lock API in a visible extension page is a possible partial substitute (UNVERIFIED).
19. **Firefox MV3** uses non-persistent event pages (no service workers, no offscreen documents). Forums report a ~30 s idle timeout (UNVERIFIED default). Firefox still permits MV2 persistent backgrounds (https://discourse.mozilla.org/t/how-to-stop-a-background-script-from-going-idle-in-mv3/128327).
20. **When the browser is closed, an MV3 extension does not run.** Norton documents that its MV3 extension lost "run in background after close". The MV3 status of the `background` permission is UNVERIFIED. **Bottom line:** an extension-only snipe needs the browser running and the PC awake at T−0. Anything stronger needs a companion process: a local daemon or native-messaging host plus an OS wake timer (Windows Task Scheduler "Wake the computer to run this task"), or a remote server that holds the SGW token.
21. **Google Calendar [confirmed]** (https://developers.google.com/workspace/calendar/api/v3/reference/events): `reminders.overrides` allows at most 5 entries, each 0–40320 minutes, so 60, 15 and 5 fit. `extendedProperties.private` can store the itemId for idempotent upserts. `chrome.identity.getAuthToken` is Chrome-only; Firefox needs `identity.launchWebAuthFlow`.

## Existing Tools / Prior Art

**ShopGoodwill-specific**
- scottmconway/shopgoodwill-scripts: Python bid sniper daemon, new-listing alerts and a schedule-bid helper. It uses the undocumented buyerapi, has 97 stars, and was active in 2026. https://github.com/scottmconway/shopgoodwill-scripts
- conway.scot reverse-engineering post: login encryption uses a key hardcoded in main.js (2022). https://conway.scot/shopgoodwill-reversing/
- taciturnaxolotl/goodwill-snipper: Bun CLI sniper with a lead time of 3 s, a bearer token and a bid-safety flag. https://github.com/taciturnaxolotl/goodwill-snipper
- Bzcasper/sgw-jewelry-sniper: TS/Rust sniper with Date-header clock offset and spin-wait; API contracts doc (unverified). https://github.com/Bzcasper/sgw-jewelry-sniper
- robherley/gw-bot: Discord subscription bot for SGW searches; PT end-time parsing. https://github.com/robherley/gw-bot
- pkmnct/shopgoodwill-ical: serves an iCal feed of SGW favorites, a calendar alternative to the Google API. https://github.com/pkmnct/shopgoodwill-ical
- lancetm714/shopgoodwill-watchlist: a deliberately "ToS-safe" watchlist with no API use and no bidding, just user-confirmed end times and Telegram pushes. https://github.com/lancetm714/shopgoodwill-watchlist
- lancetm714/shopgoodwill-notifier: polls the search API for new matches. https://github.com/lancetm714/shopgoodwill-notifier
- dudemcbacon/goodwill: Ruby gem that can log in, search and bid. https://github.com/dudemcbacon/goodwill
- abarran02/ShopGoodwill: Python search/item package. https://github.com/abarran02/ShopGoodwill
- Shopgoodwill Helper (Chrome, 147 users, updated 2026-02-21): shipping estimates, live price, countdown and comps. No bidding or hiding. https://www.chromeboard.com/extension/shopgoodwill-helper-llampoenjhpfnepahgdiigndopefgihg
- "ShopGoodwill Sniper" desktop app (BotGrabber): commercial last-second sniper installed via curl|bash or VBS. Treat as untrusted. https://github.com/shopgoodwill-auction-sniper/shopgoodwill-sniper

**Other sites (sniping)**
- Gixen: free server-side eBay sniper. Mirror tier adds redundancy and 3–15 s offsets; bid groups, contingency and multi-win groups. https://www.gixen.com/main/faq.php
- eSnipe: paid server-side eBay sniper with bid groups and a Chrome add-on. https://esnipe.com/snipetool
- AuctionSniper: long-running server-side eBay sniper; anecdotally 7 s minimum lead. https://www.auctionsniper.com
- BidSlammer: free tier 10 s, paid 1 s; edit until 15 s before the end. https://www.bidslammer.com
- JustSnipe: server-side service with a Chrome extension front-end. https://chrome.google.com/webstore/detail/foehhligadgccgjhkcclhonpdcjeokjh
- Bidnapper: paid sniper that bids from multiple locations; supports eBay and other sites. https://www.bidnapper.com
- Myibidder: eBay sniper Chrome extension. https://chrome.google.com/webstore/detail/myibidder-auction-bid-sni/fmebanjjkaohcmifehogijfgcoieefnp
- AuctionStealer family (LotSnipe, HammerSnipe, BidSniper): eBay snipers; bid groups need at least 30 s spacing. https://lotsnipe.auctionstealer.com/about/auction-sniper
- esniper: open-source CLI with a 10 s default, `-n` dry-run and quantity groups. https://manpages.ubuntu.com/manpages/jammy/man1/esniper.1.html
- JBidwatcher: open-source Java client that syncs to eBay official time. https://www.oreilly.com/library/view/ebay-hacks-2nd/059610068X/ch03s04.html
- PowerSniper: client-side Chrome eBay sniper that needs an open tab. https://chrome.google.com/webstore/detail/powersniper-for-ebay/aaedppaainbngpdbjenindnjcgcndpje
- Bid-O-Matic: old multi-site client sniper, roughly 9 years stale. https://hub.turbo.net/run/bidomatic
- eBay explicitly allows sniping software, a contrast with SGW's ToS. https://www.ebay.com/help/Buying/How_Bidding_Works/Bid_sniping?id=4224
- HiBid, Proxibid, GovDeals: no dedicated sniper found. Proxibid uses a 5-minute soft close. https://www.constructionequipmentguide.com/proxibid-puts-new-spin-on-bidding/10119

## Quality-of-Life Ideas

1. **[MVP] Exposure meter:** a live total of every armed max bid plus estimated shipping and handling, shown against the user's hard cap. Every armed snipe could win, so this is the user's true worst-case spend.
2. **[MVP] All-in max bid:** the user enters the most they will pay in total, and the tool subtracts estimated shipping and handling (CalculateShipping) to get the bid. Shipping often doubles the price of cheap SGW items.
3. **[MVP] Typo guard:** amounts more than 3× the current price, or above a configurable threshold, must be retyped. Bids are binding, and typo retractions are discretionary, one-time courtesies.
4. **[MVP] T−15 min pre-flight notification:** checks you are logged in, the token is valid, the clock offset is sane, keep-awake is on and the price is still under max. It offers one-click abort or fix, so the user learns about a doomed snipe while they can still act.
5. **[MVP] Kill switch** in the popup plus a keyboard command, which disarms everything and writes an audit entry. An instant way to stop is the minimum safety standard for money-spending automation.
6. **[MVP] Post-auction outcome report:** won or lost, final price, the margin you lost by, and failure reason. Without it the user cannot tell bad luck from a broken tool.
7. **[later] Timing diagnostics page:** history of clock offset and latency, plus the measured "bid accepted at T−x.xs". This makes the reliability story visible and helps tune the lead time.
8. **[later] Per-snipe fallback policy:** if a snipe cannot be guaranteed (browser closing, low battery, PC going to sleep), either place the max now as a normal proxy bid or skip it. This mirrors what users do manually when they can't be present.
9. **[later] Bid groups ("win one of these N"):** validates at least 2 min spacing between end times, confirms a win before the next member fires, and freezes edits in the final 2 min. Thrift shoppers often watch several near-identical items.
10. **[later] Sold-price comps:** the median closing price of similar closed SGW auctions, used to suggest a max. This stops the user overpaying in a bidding frenzy.
11. **[later] Local-time countdown badges** on result cards, with an "ends while you're asleep" flag. PT end times confuse non-Pacific users, and it shows which auctions need a snipe.
12. **[later] Combined-shipping hints:** flag items from the same seller closing within 7 days. Combined shipping can make a marginal item worth bidding on.
13. **[stretch] Companion process** (native-messaging host or a Windows scheduled task with a wake timer), so snipes survive a closed browser or a sleeping PC. This is the only honest path to "set and forget".
14. **[stretch] Friend list / don't-bid-against list**, as in scottmconway, which avoids bidding wars with family or co-resellers.

## Fable Prompt

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
