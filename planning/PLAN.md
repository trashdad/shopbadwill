# ShopBadwill Implementation Plan

Plan version 1.0 · 2026-10-07 · Author: Fable (lead planner) · Source brief: `planning/fable-prompt.md`

**How to read this document.** Sections 1–2 explain the decisions and the shape of the system. Section 3 is the frozen interface contract: every worker reads it. Sections 4–6 are what the orchestrator dispatches: spikes, phases and task cards. Sections 7–14 are the supporting material (tests, threats, budgets, setup, release, risks, QoL, open questions).

**Legend.** ⚠ = unverified fact, routed to a spike named in brackets. **ASSUMPTION** = a choice made without evidence, stated so it can be challenged. `T-xx` ids are task cards; `S-x` ids are Phase 0 spikes. Sizes: S ≈ ¼ agent-day, M ≈ ½, L ≈ 1 (the maximum).

**Standing rules for every worker.** (1) No live writes to shopgoodwill.com or Google from any automated test, ever. (2) Downstream tasks consume Task 0 fixtures, never the live site. (3) A task is done only when its gate command is green and the output is pasted into the task's completion note. (4) Tests first: write the failing tests listed on the card, then the implementation. (5) Never store a password. (6) Touch only the files your card owns.

---

## 1. Key decisions, with rejected alternatives

### 1.1 Framework and toolchain

**Decision: WXT 0.21.x (pinned exact), TypeScript strict, Vitest, zod, Preact for UI, `browser.*` namespace only, no polyfill.**

- WXT builds Chrome MV3 and Firefox MV3 from one codebase, emits per-browser manifests, provides `wxt:locationchange` for SPA routing, `createShadowRootUi`, and a Vitest fake browser (`wxt/testing/vitest-plugin`, `wxt/testing/fake-browser`; verified on wxt.dev for v0.21.4 on 2026-10-07).
- WXT targets **MV2 for Firefox by default**, so every Firefox build and gate command passes `-b firefox --mv3` (verified on wxt.dev). Output dirs: `.output/chrome-mv3`, `.output/firefox-mv3`.
- Minimum browsers: Chrome 148 (native `browser.*` with promise-returning `onMessage`), Firefox 128 (MV3 event pages, `world: "MAIN"` content scripts). The dev machine has Chrome, Chromium and Firefox 157.
- webextension-polyfill is archived (repo banner: "archived by the owner on Jul 30, 2026"), so it is not used.
- Preact (via `@wxt-dev/module-preact`) for popup, options, dashboard and in-page Shadow DOM UI. Small, no runtime HTML strings, works with the no-`innerHTML` lint rule.
- zod for every API response and every stored record; the same schemas run in contract tests and at runtime (fail closed).

Rejected: **Plasmo** (stalled, last release ~Sep 2025). **CRXJS** (Chrome-first, weak Firefox). **Hand-rolled Vite config** (would re-implement per-browser manifests, SPA navigation and fake browser that WXT already provides). **React** (heavier, no benefit over Preact here). **Lit** (viable, but Preact keeps one component model across all surfaces and WXT has a first-party module).

### 1.2 How the daily job wakes, per browser

**Decision: a resumable, persisted job driven by a coarse alarm tick, reconciled on every background start.**

- One repeating alarm `sbw:tick` with `periodInMinutes: 2`. On each tick, and on `runtime.onStartup`, `runtime.onInstalled` and the first line of the background script, the scheduler runs `reconcile()`: re-create missing alarms, then compare `now` with `watches[*].nextRunAt`. If any is due (including hours or days overdue), start or resume a `JobRun`.
- A `JobRun` is a persisted queue of single-request steps (search page, detail read, favorite add, calendar upsert). Each tick advances **one SGW request** in the background lane, which honours the 120 s robots.txt crawl delay by construction and sidesteps the 5-minute per-event cap and the 30 s idle kill of the Chrome service worker. A 20-request nightly run takes about 40 minutes while the user sleeps, which is fine.
- Chrome: `alarms.create` passes `persistAcrossSessions: true` explicitly when the running browser supports it (Chrome ≥150; feature-detected, never passed on Firefox, whose schema validation rejects unknown properties — **ASSUMPTION**, confirmed by the fake-alarm unit test contract and S-6). Alarms are re-created at every worker start regardless, per Chrome's own advice for pre-150 behaviour.
- Firefox: alarms do not survive restart; the event page's top-level code runs on every wake, so `reconcile()` there re-creates them. Missed runs catch up the same way.
- The user-visible run time is a local-time setting (default 07:00 local; the run catches up whenever the browser is next running after that).

Rejected: **one alarm per watch at the exact time** (fragile across restarts; no catch-up without a reconcile anyway). **Running the whole job in one event** (dies at 5 min on Chrome; forces bursts that violate the crawl delay). **GitHub Actions cron** (holds SGW secrets off-device; auto-disables after 60 idle days). **Native-host daemon for the daily job** (not needed; catch-up is acceptable for a daily check).

### 1.3 How the snipe timer wakes, per browser

**Decision: alarm-based coarse wake at T−5 min, then the background context stays alive with extension-API heartbeats every 20 s and fires on a tight in-memory timer computed from the server clock offset. The executor is the background (Chrome service worker / Firefox event page) in both browsers, with a "runner page" fallback for Firefox if S-7 shows the event page cannot be held alive.**

- Sequence: `sbw:snipe:<id>:wake` alarm at `fireAt − 5 min` (alarm floor and arbitrary delay are tolerated because the margin is minutes) → `KeepAlive.hold()` (calls `runtime.getPlatformInfo()` every 20 s, never a buyerapi request) → clock-offset samples (3 ItemDetail reads of the target item, 20 s apart, keep lowest-RTT) → T−60 s verification read → `setTimeout` to `fireAt` → PlaceBid with a 20 s abort → outcome read.
- Hidden-tab timer throttling does not apply to the background context, and the background is the only context guaranteed to exist without a visible window.
- Firefox gap ⚠ [S-7]: whether `runtime.getPlatformInfo` resets the event-page idle timer. If not, the fallback is a `SnipeHost` implemented as a small extension window (`windows.create({type:'popup', focused:false})`) that holds a `runtime.connect` port open; S-7 measures its timer precision when the window is not foreground. The `SnipeHost` port interface (§3.9) is the same in either case so the engine does not change.
- Chrome kills the worker if a fetch takes >30 s: PlaceBid uses a 20 s `AbortController`; a timeout or a worker death between "request sent" and "response recorded" is an **ambiguous** outcome that re-reads ItemDetail before deciding whether a retry is allowed (§3.9).

Rejected: **a pinned SGW tab running a content-script timer** (hidden-tab throttling: 1 s, then 1 min after five minutes; also violates "never load site pages in background"). **Polling the item every second near close** (burst traffic; the server offset makes it unnecessary). **`chrome.alarms` for the fire moment** (30 s floor, arbitrary delay).

### 1.4 Reliability tier recommendation

**First sniping release: T1 (extension + keep-alive) on Chrome, with the per-snipe fallback defaulting to "early proxy bid", a measured "awake history" that tells the user whether their machine is usually up at fire time, and OS power guidance. Later: T2 "wake-and-launch" local companion (Windows Task Scheduler wake timer + native-messaging host) that wakes the PC and starts the browser so the extension itself places the bid. T3 rejected.**

Plain statement of the limits: **nothing in the extension runs while the browser is closed or the PC is asleep.** A daily check catches up; a snipe does not. If the PC sleeps at fire time under T0/T1, the snipe is missed and the user learns of it on wake (`outcome: late`). The only protection in T0/T1 is the fallback decision made earlier, while the extension is running.

Why T1 first, not T2: T2's value depends on three ⚠ facts (MV3 `background` permission, wake timers on the user's hardware, Modern Standby) that S-8 settles, and the dry-run soak (Phase 4) measures how often T1 actually misses on this user's machine. If the soak shows ≥95% on-time dry-run fires, T2 is a later nicety; if it shows a night-time gap, T2 moves up. Build the measurement before the machinery.

Why T2 is "wake-and-launch" rather than a companion that bids: the JWT is likely bound to IP and user agent ⚠ [S-2]; a companion that sends PlaceBid itself would need the token handed off and the UA matched, which is close to identity spoofing and doubles the attack surface for the token. A companion that only wakes the machine and starts the browser keeps the token in the browser and the bid path identical to T1. Its ToS exposure is no greater than T1.

Why T3 is rejected: it needs the SGW token off-device, on a server with a different IP and UA (likely rejected by the JWT binding ⚠), and it concentrates account and money risk in a remote host. Prior art (Gixen, BidPulse) runs this way only because they are services; a personal tool does not need it.

Firefox: T1 has no keep-awake and no `background` equivalent ⚠ [S-7, S-8]. Firefox users get T0 plus the fallback policy, and T2 if built. Chrome is therefore the primary browser for sniping; Firefox is fully supported for requirements 1–4.

### 1.5 SGW authentication

**Decision: never log in. Capture the bearer token the site already uses, from a MAIN-world "api-tap" content script that observes the page's own XHR/fetch to buyerapi (headers and response bodies). `webRequest` observation is the fallback if S-2 finds the tap cannot see the header. Store the access token in `storage.local` so unattended jobs can use it; store the refresh token only if S-2 proves `SignIn/RefreshToken` works unattended.**

- The tap serves two purposes with one mechanism: token capture and "reuse before fetching" (the listing data the page already loaded feeds the overlay, so a search page costs the site zero extra requests).
- It observes only; it never modifies requests or responses, never solves CAPTCHAs and never changes the UA. Chrome 111+ and Firefox 128+ support `world: "MAIN"` content scripts.
- Permission cost: none beyond the `shopgoodwill.com` host permission we already need. `webRequest` would add one permission on both browsers. S-2 reports both.
- Token lifetime ⚠ [S-2] decides everything downstream: if the JWT dies within a day and refresh needs the user, the unattended job degrades to "search, queue favorites, notify" and the plan's reliability tiers for sniping must be re-read with that in mind.

Rejected: **storing the password and replaying the AES-obfuscated login** (brief forbids; reCAPTCHA may gate it; brittle). **Decrypting `cookieSession_8`** (possible but couples us to an obfuscation constant; kept only as an S-2 fallback evaluation). **Asking the user to paste a token** (bad UX; tokens expire).

### 1.6 Google authentication and calendar scope

**Decision: one provider interface, `GoogleAuthProvider`, with the PKCE + refresh-token implementation (`PkceRefreshProvider`) as the primary on both browsers via `identity.launchWebAuthFlow`. On Chrome it pairs with a Web-application OAuth client (redirect `https://<ext-id>.chromiumapp.org/`); on Firefox with a Desktop-app client (loopback redirect `http://127.0.0.1/mozoauth2/<hash>`). `ChromeIdentityProvider` (`getAuthToken`) is a secondary implementation, built only if S-4 shows the Web-client path is unworkable. Single scope `calendar.app.created`, dedicated calendar "ShopGoodwill Auctions".**

- One token lifecycle on both browsers means one storage model (refresh token in `storage.local`, access token in `storage.session`), one error taxonomy and one test suite. The unattended daily sync needs a refresh token anyway.
- The user's own GCP project, published to "In production" without verification, removes the 7-day Testing expiry. The client secret for a Web client, if Google requires it with PKCE ⚠ [S-4], is pasted into options and treated as non-confidential; it never enters the repo.
- `calendar.app.created` means the extension can only touch calendars it created. Its sensitivity class is unpublished (verified: Google's scope page lists no classes), which does not matter for an unverified personal-use app. `calendar.events` is the opt-in alternative for users who insist on their primary calendar.
- `disconnect()` revokes: `POST https://oauth2.googleapis.com/revoke` with the refresh token (PKCE) or `identity.clearAllCachedAuthTokens()` (getAuthToken).

Rejected: **getAuthToken as primary** (Chrome-only, needs Chrome profile sign-in, ownership verification of the "Chrome Extension" client is ⚠, unreliable on Edge/Brave; it would leave Firefox on a different lifecycle anyway). **Implicit flow** (1 h tokens, no silent renewal on Firefox). **Apps Script web app** (avoids OAuth but is a remote endpoint the daily job must call; a reasonable fallback, listed under QoL "stretch"). **A backend server** (none, by brief).

### 1.7 Where buyerapi calls originate

**Decision: all buyerapi requests the extension makes originate in the background context with the `https://buyerapi.shopgoodwill.com/*` host permission, through one `RequestScheduler`, with `credentials: 'omit'` and `Authorization: Bearer`. Content scripts never call buyerapi; they send data in (tap) and intents out.**

- Host permissions bypass CORS in extension contexts on both browsers; the UA is the browser's own, so a UA-bound JWT is satisfied; the IP is the user's.
- `credentials:'omit'` avoids the `Bid` cookie 403 on the second bid.
- Unattended jobs cannot rely on an SGW tab being open, so content-script-origin calls were never an option for them. Making the background the only origin keeps the rate limiter and budget authoritative.

Rejected: **content-script fetches on the SGW origin** (needs an open tab; splits rate limiting). **MAIN-world fetches** (same, plus page CSP and page-visible side effects).

### 1.8 Other decisions made here

- **Auto-favorite is per watch**, three modes: `sgw` (favorite immediately), `sgw-late` (favorite only within N hours of end, default 6), `local` (track locally only). Default for new watches: `local` **ASSUMPTION** pending open question Q5.
- **Dry-run is global and on by default** for favoriting, calendar writes and bidding; each automation has its own switch. Live bidding additionally requires completing ≥5 dry-run snipes with on-time fires.
- **Hiding is never silent**: collapsed stub with rule name, page bar "N hidden · show", per-card Why?, one-click undo, global off.
- **Money is integer cents** everywhere in the domain; strings only at the API edge (`bidAmount: "12.00"`).
- **Time is epoch milliseconds or RFC 3339 UTC** in the domain; the raw Pacific string is kept beside it for audit.
- **Audit log is append-only** in `storage.local` with a 10,000-entry ring and JSON export; no secrets, HTML rendered as text.
- **No telemetry, no remote code, no `innerHTML`.** ESLint `no-unsanitized` and a bundle grep enforce it.

---

## 2. Architecture

### 2.1 Repository layout and module map

```
shopbadwill/
  package.json  wxt.config.ts  tsconfig.json  vitest.config.ts  eslint.config.js  playwright.config.ts
  src/
    domain/                     pure TypeScript, no browser imports, depends only on src/ports
      types.ts                  Listing, ItemDetail, Favorite, BidResult, Money, Time aliases
      money.ts                  cents math, increment math, formatting
      time/pacific.ts           naive-PT parsing, DST, dual display
      rules/{schema,matcher,keywords,preview}.ts
      watches/{schema,query-url}.ts
      jobs/daily-job.ts         resumable JobRun state machine
      favorites/reconcile.ts
      calendar/{event-id,event-builder,reconciler,ics}.ts
      snipe/{state-machine,timing,caps,preflight,outcome,awake-history}.ts
      audit/log.ts
      settings/{schema,defaults}.ts
      storage/{schema,migrations,repo}.ts
    ports/                      interfaces only (Clock, Http, Storage, Alarms, Notifier, Permissions,
                                KeepAwake, SgwApi, CalendarApi, GoogleAuthProvider, SnipeHost, Messaging)
    adapters/
      sgw/                      the ONLY code that knows SGW specifics
        config.ts               versioned selectors, endpoints, field names (SGW_CONFIG_VERSION)
        schemas.ts              zod schemas for every endpoint
        request-scheduler.ts    lanes, rate limits, budget, jitter, cache, backoff
        api-adapter.ts          typed SgwApi over RequestScheduler
        dom-adapter.ts          card discovery, itemId extraction, hide/highlight hooks
        session-adapter.ts      token capture, expiry, logged-out state
        clock-adapter.ts        server offset, RTT, Pacific parsing glue
        health.ts               healthCheck() that fails closed
      google/{auth-pkce,auth-chrome-identity,calendar-api,schemas}.ts
      ntfy/ntfy-sink.ts
      browser/{clock,http,storage,alarms,notifier,permissions,keepawake,snipe-host,messaging}.ts
    background/
      main.ts                   composition root: wires adapters, registers listeners, reconcile()
      router.ts                 message dispatch with sender validation
      jobs/{scheduler,daily-job-runner,calendar-sync,snipe-runner,auth-health,heartbeat}.ts
    content/
      api-tap.main.ts           MAIN world: observes page XHR/fetch to buyerapi, relays via postMessage
      sgw-overlay.ts            ISOLATED world: DomAdapter + Shadow DOM UI, listens to tap + background
      ui/                       Preact components for card badges, stubs, hidden bar, Why? popover
    ui/                         shared Preact components, time display, money display
    entrypoints/                WXT entrypoints: background.ts, sgw.content.ts, api-tap.content.ts,
                                popup/, options/, sidepanel/ (Chrome) + sidebar/ (Firefox), onboarding/
    messaging/{protocol,client}.ts   typed message union + zod + send helpers
  test/
    fixtures/sgw/{json,html}/   sanitized Task 0 captures (+ manifest.json listing provenance)
    fixtures/google/
    fakes/fake-sgw-server/      Node http server, injectable latency/skew/errors/token expiry/soft-close
    fakes/fake-google-server/   token endpoint + Calendar v3 subset
    fakes/ports/                FakeClock, FakeAlarms (enforces 30 s floor + delay), FakeNotifier, ...
    unit/  contract/  integration/  dom/  e2e/chromium/  e2e/firefox/
  scripts/{capture-fixtures,sanitize-fixtures,canary,check-prod-bundle,permissions-snapshot,release}.ts
  companion/windows/            Phase 6: native host + scheduled-task installer
  docs/{SETUP-GOOGLE,SETUP-CHROME,SETUP-FIREFOX,COMPANION,ACCEPTANCE,CONSIDERATE-USE}.md  docs/spikes/
  .github/workflows/{ci,canary,release}.yml
```

Dependency rule (enforced by ESLint `import/no-restricted-paths`): `domain → ports` only; `adapters → ports, domain/types`; `background, content, entrypoints → anything`; nothing imports from `entrypoints`. `wxt/browser` may be imported only under `adapters/browser`, `background`, `content` and `entrypoints`.

### 2.2 Data flow (text diagram)

```
                      user browses shopgoodwill.com
                                  │
   ┌──────────── page (Angular) ──┼──────────────────────────────────────┐
   │  site XHR/fetch → buyerapi   │                                      │
   │        ▲        │            ▼                                      │
   │        │   api-tap.main.ts (MAIN world, observe-only)               │
   │        │        │ postMessage {nonce, kind:'listing'|'detail'|'token'}
   │        │        ▼                                                   │
   │   sgw-overlay.ts (ISOLATED) ── DomAdapter finds cards ──► Shadow DOM UI (badges, stubs, Why?)
   │        │  rules.evaluateBatch / page.listings / page.token / quick.* │
   └────────┼───────────────────────────────────────────────────────────┘
            ▼  runtime.sendMessage (validated sender + zod)
   ┌──────────────────────────── background ────────────────────────────────┐
   │ router.ts ──► Rules (domain) ──► MatchResult[] ──► back to content     │
   │           ──► SessionAdapter.observeToken(token)                       │
   │ scheduler (alarm tick, reconcile) ──► DailyJobRunner ──► JobRun steps  │
   │                                        │ one request per tick          │
   │                                        ▼                               │
   │                 RequestScheduler (lanes: interactive | background | snipe)
   │                     └► Http (fetch, credentials:'omit', Bearer) ──► buyerapi
   │ FavoritesReconcile ◄── GetAllFavoriteItemsByType  ──► AddToFavorite    │
   │ CalendarSync ──► CalendarSink ──► GoogleAuthProvider ──► Calendar v3   │
   │ SnipeRunner ──► SnipeEngine (domain state machine) ──► SgwApi.placeBid │
   │ AuditLog (append-only) ◄── every write, every state change             │
   │ Notifier ──► OS notifications; ntfy (opt-in)                           │
   └────────────────────────────────────────────────────────────────────────┘
            ▲ messages                      ▲ storage.onChanged
   popup (status, kill switch) · sidepanel/sidebar (dashboard) · options (rules, watches, settings, log)
```

### 2.3 Storage schema (version 1) and migrations

All keys live in `storage.local` unless marked `session`. Every record is validated with zod on read; an invalid record is quarantined to `sbw:quarantine:<key>` and replaced by defaults, and the health panel shows it.

| Key | Type (see §3) | Notes |
|---|---|---|
| `sbw:meta` | `{ schemaVersion: 1, installedAt, lastMigrationAt }` | migrations run before any other read |
| `sbw:settings` | `Settings` | §3.11 |
| `sbw:rules` | `Rule[]` | rules import/export target |
| `sbw:watches` | `Watch[]` | |
| `sbw:tracked` | `Record<ItemId, TrackedItem>` | items the user tracks (via watch, favorite, snipe, or manual); source of calendar desired state |
| `sbw:listingCache` | `Record<ItemId, {listing: Listing, expiresAt}>` | 6 h TTL; written by tap and job |
| `sbw:detailCache` | `Record<ItemId, {detail: ItemDetail, expiresAt}>` | 6 h TTL, 60 s near close |
| `sbw:shippingCache` | `Record<string /*itemId:zip*/, {cents, expiresAt}>` | 24 h TTL |
| `sbw:favoritesCache` | `{ fetchedAt, items: Favorite[] }` | one list read per job run |
| `sbw:jobRuns` | `JobRun[]` (last 30) | resumable state lives in the active run |
| `sbw:calendar` | `{ calendarId?, links: Record<ItemId, CalendarLink> }` | event id generations |
| `sbw:snipes` | `Record<SnipeId, Snipe>` | durable; survives restart |
| `sbw:audit:<chunk>` | `AuditEntry[]` chunks of 500 | ring of 20 chunks |
| `sbw:auditMeta` | `{ nextSeq, head, tail }` | |
| `sbw:sgwSession` | `SgwSession` | access token + exp (+ refresh token only if S-2 approves) |
| `sbw:google` | `GoogleCredentials` | refresh token, client id (+ secret if required), grantedScopes |
| `sbw:requestBudget` | `{ day: 'YYYY-MM-DD', used: Record<Lane, number> }` | |
| `sbw:awake` | `number[]` heartbeat epochs, 14 days | |
| `sbw:clock` (session) | `ClockSample[]` | lowest-RTT offset |
| `sbw:googleAccess` (session) | `{ token, expiresAt }` | never persisted to disk |
| `sbw:runtimeHealth` (session) | `HealthReport` | last healthCheck() |

Never in `storage.sync`: anything. (Rules export/import is a JSON file; sync quotas and token safety both argue against sync.)

**Migrations.** `src/domain/storage/migrations.ts` exports `migrations: Array<{ from: number; to: number; run(repo): Promise<void> }>`. `migrate()` runs in `background/main.ts` before listeners are registered, under a `sbw:meta.migrating` flag so a crash mid-migration is detected and retried. A migration must be idempotent and covered by a unit test that loads a fixture of the old shape. Adding a field with a default is not a migration (zod `.default()` handles it); renaming or re-keying is.

### 2.4 Message protocol

Transport: `browser.runtime.sendMessage` for request/response, `browser.runtime.connect` ports for streams (snipe countdown, job progress). Every message is `{ v: 1, type: string, payload: unknown, reqId: string }` and is validated against the zod union in `src/messaging/protocol.ts` before dispatch. The background's router checks:

1. `sender.id === browser.runtime.id` (drop otherwise).
2. Origin class: messages from a content script must have `sender.tab` and `sender.url` whose origin is `https://shopgoodwill.com`; messages that are UI-only (anything under `snipe.*`, `settings.set`, `calendar.connect`, `kill.*`, `audit.undo`, `favorites.*`) are rejected if `sender.tab` is present and `sender.url` is not an extension page.
3. Content scripts may send only the `page.*`, `rules.evaluate`, `quick.*` and `landedCost.get` types. `quick.favorite` is honoured only when `settings.overlay.quickFavorite` is on and the item is not yet favorited; `quick.hideSeller` creates a local rule; neither can arm a snipe, place a bid, or write to the calendar.

The full union is in §3.12.

### 2.5 Permissions, per browser, with justification

| Permission | Chrome | Firefox | When requested | Justification |
|---|---|---|---|---|
| `storage` | required | required | install | all state |
| `alarms` | required | required | install | scheduler tick, snipe wake |
| host `https://shopgoodwill.com/*` | required | required (install-time grant, revocable; checked with `permissions.contains`) | install | content scripts, tap |
| host `https://buyerapi.shopgoodwill.com/*` | required | required | install | background API calls (CORS bypass) |
| `notifications` | optional | optional | onboarding step 5 / options | local alerts, preflight, outcomes |
| `identity` | optional | optional (needed for `launchWebAuthFlow`) | "Connect Google" click | OAuth |
| host `https://oauth2.googleapis.com/*`, `https://www.googleapis.com/*` | optional | optional | "Connect Google" click | token + Calendar API |
| `sidePanel` | optional | n/a (`sidebar_action` manifest key) | "Open dashboard" click | dashboard |
| `background` | optional | n/a | "Enable keep-alive" in snipe settings | T1: start early / shut down late ⚠ [S-8] |
| `power` | optional | n/a | same | T1: `requestKeepAwake('system')` |
| `nativeMessaging` | optional | optional | "Install companion" | T2 only |
| host `https://ntfy.sh/*` (or user's server) | optional | optional | "Enable phone push" | ntfy fallback |
| `webRequest` | optional, only if S-2 picks it | same | onboarding | token capture fallback |
| `commands` (manifest key, not a permission) | yes | yes | — | kill-switch shortcut |
| `unlimitedStorage` | not requested | not requested | — | 10 MB is enough with caches capped |
| `scripting`, `tabs`, `cookies`, `webNavigation` | not requested | not requested | — | not needed; `wxt:locationchange` handles SPA routing |

Firefox additionally declares `browser_specific_settings.gecko.id = "shopbadwill@trashdad.github.io"` (fixed; required for signing and a stable redirect URL), `gecko.strict_min_version = "128.0"`, and `gecko.data_collection_permissions = { required: ["none"] }` with `optional: ["technicalAndInteraction"]` **only** when ntfy is enabled (ntfy sends auction data to a third party).

The permissions snapshot test (`test/unit/manifest-permissions.test.ts`) diff-checks both production manifests against a committed JSON; any addition fails CI. Test builds add `http://127.0.0.1/*` and the CI step `check-prod-bundle` proves it is absent from production manifests.

### 2.6 Chrome vs Firefox differences table

| Concern | Chrome (MV3) | Firefox (MV3) | Plan handling |
|---|---|---|---|
| Background | service worker, 30 s idle kill, 5 min/event, fetch >30 s kills | event page (`background.scripts`), ~30 s idle (pref), DOM available | WXT emits both `service_worker` and `scripts`; all long work is tick-driven; no job step exceeds one request |
| Alarms persistence | `persistAcrossSessions` (150+), pre-150 "unpredictable" | not persisted across restart | `reconcile()` on every background start; feature-detect the property |
| Alarm floor | 30 s packed, none unpacked | 30 s | `Alarms` port and fake enforce the floor; manual check on a packed build |
| Keep-alive | extension API calls reset idle timer | ⚠ S-7 | `KeepAlive` heartbeat; runner-page fallback |
| Keep-awake / background | `power`, `background` ⚠ MV3 | none found | T1 Chrome-only; Firefox = T0 + fallback policy |
| Offscreen documents | yes | no | not used; JSON only, no DOMParser in background |
| Dashboard surface | `sidePanel` | `sidebar_action` | same Preact app, two entrypoints |
| Identity | `getAuthToken`, `launchWebAuthFlow` (chromiumapp.org) | `launchWebAuthFlow` only, allizom or loopback redirect | PKCE on both; client type differs |
| Host permissions | granted at install | granted at install since 127, revocable | `permissions.contains` check at every job start; UI prompt to re-grant |
| `world: "MAIN"` content scripts | 111+ | 128+ | tap works on both |
| Notifications | buttons, `requireInteraction` | `basic` only, no buttons | Notifier port exposes `supportsActions`; preflight uses a click-to-open-dashboard notification on Firefox |
| `browser.*` namespace | 148+ native | native | min Chrome 148 |
| Distribution | Load unpacked (Developer mode) | must be signed: `web-ext sign --channel unlisted` | release task |
| E2E | Playwright Chromium (`launchPersistentContext`) | no Playwright; Selenium/geckodriver `install_addon(temporary=true)` or `web-ext run` | separate lanes |
| Data collection declaration | n/a | `data_collection_permissions` required | manifest |

---

## 3. Interface contracts (frozen at the end of Phase 0 by T-02)

Conventions: money is `Cents` (integer); instants are `EpochMs` (number) or `IsoUtc` (RFC 3339 with `Z`); raw site strings keep a `Raw` suffix. All interfaces are in `src/ports/*.ts` and `src/domain/types.ts`; zod schemas with the same names plus `Schema` live beside them. Workers must not add fields to these types without a contract-change PR that updates this section.

### 3.1 Domain types

```ts
export type ItemId = number;            // SGW numeric id, e.g. 279250057
export type Cents = number;             // integer, 1299 = $12.99
export type EpochMs = number;
export type IsoUtc = string;            // "2026-10-08T02:18:30.000Z"
export type PacificNaiveRaw = string;   // "2026-10-07T19:18:30" or "...:17.45" exactly as received

export interface Listing {
  itemId: ItemId;
  title: string;                        // untrusted text; render as text only
  currentPrice: Cents;
  startingMinimumBid: Cents;            // search-row minimumBid; NOT the next acceptable bid
  numBids: number;
  endTime: IsoUtc;                      // parsed from endTimeRaw with America/Los_Angeles
  endTimeRaw: PacificNaiveRaw;
  sellerId: number;
  sellerName?: string;
  categoryId?: number;
  categoryPath?: string;                // "Collectibles > Glass"
  shippingPrice?: Cents | null;         // null = calculated, unknown until quoted
  pickupOnly: boolean;
  buyNowPrice?: Cents | null;
  imageUrl?: string;
  isFavorite?: boolean;                 // only meaningful when the request was authenticated
  relistId?: number | null;
  source: 'tap' | 'api' | 'dom';
  observedAt: EpochMs;
}

export interface ItemDetail extends Listing {
  minimumBid: Cents;                    // next acceptable bid (detail value; use THIS for caps/snipes)
  bidIncrement: Cents;
  serverTime: IsoUtc;                   // parsed per S-1 verdict (naive PT assumed ⚠)
  serverTimeRaw: string;
  isClosed: boolean;
  isHighBidder: boolean | null;         // null = unknown (anonymous read)
  inWatchlist: boolean | null;
  handlingPrice?: Cents;
  bidHistory: Array<{ amount: Cents; time: IsoUtc; timeRaw: string; bidderMasked: string }>;
}

export interface Favorite {
  itemId: ItemId; watchlistId: number; notes: string; endTime: IsoUtc; sellerId: number;
  status: 'open' | 'closed';
}

export type BidResultKind =
  | 'accepted'          // bid registered; may or may not be high bidder
  | 'outbid'            // registered but below a rival's proxy max
  | 'below-minimum' | 'closed' | 'auth' | 'restricted' | 'rejected-unknown';
export interface BidResult {
  kind: BidResultKind;
  rawStatus: number | null; rawResult: number | null;
  messageText: string;                  // HTML stripped to text at the adapter edge
  isHighBidder: boolean | null;
  observedAt: EpochMs;
}

export interface TrackedItem {
  itemId: ItemId; title: string; endTime: IsoUtc; sellerId: number;
  reasons: Array<{ kind: 'watch' | 'favorite' | 'snipe' | 'manual'; id?: string }>;
  favoriteState: 'none' | 'queued' | 'favorited' | 'failed';
  calendar: boolean;                    // desired on the calendar?
  outcome?: 'won' | 'lost' | 'ended-early' | 'unknown';
  addedAt: EpochMs; updatedAt: EpochMs;
}
```

Example `Listing` (from fixture `search-grid-page1.json`, row 0, sanitized):
```json
{ "itemId": 279250057, "title": "Vintage Pyrex Butterfly Gold Bowl 403", "currentPrice": 1299,
  "startingMinimumBid": 1299, "numBids": 0, "endTime": "2026-10-08T02:18:30.000Z",
  "endTimeRaw": "2026-10-07T19:18:30", "sellerId": 123, "sellerName": "Goodwill of Example",
  "categoryId": 45, "shippingPrice": null, "pickupOnly": false, "source": "api", "observedAt": 1791400000000 }
```

### 3.2 Ports (injected into all domain code)

```ts
export interface Clock {
  now(): EpochMs;                                   // wall clock
  monotonic(): number;                              // performance.now()
  setTimeout(fn: () => void, ms: number): number;   // tight timer; background context only
  clearTimeout(id: number): void;
}

export interface HttpRequest { url: string; method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>; body?: string; timeoutMs: number; credentials: 'omit' | 'include'; }
export interface HttpResponse { status: number; headers: Record<string, string>; bodyText: string;
  startedAt: EpochMs; endedAt: EpochMs; }
export interface Http { send(req: HttpRequest): Promise<HttpResponse>; }   // throws HttpTimeoutError / HttpNetworkError

export interface Storage {
  get<T>(key: string): Promise<T | undefined>;
  set(entries: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  onChanged(cb: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => void): () => void;
}
export interface StorageAreas { local: Storage; session: Storage; }

export interface AlarmInfo { name: string; scheduledTime: EpochMs; periodInMinutes?: number; }
export interface Alarms {
  create(name: string, opts: { when?: EpochMs; delayInMinutes?: number; periodInMinutes?: number }): Promise<void>;
  // Implementations and FakeAlarms MUST clamp delay/period to >= 0.5 min and MAY add up to 60 s delay.
  clear(name: string): Promise<boolean>;
  getAll(): Promise<AlarmInfo[]>;
  onAlarm(cb: (alarm: AlarmInfo) => void): () => void;
}

export interface Notification { id?: string; title: string; message: string; priority?: 0 | 1 | 2;
  actions?: Array<{ id: string; title: string }>; openUrlOnClick?: string; }
export interface Notifier {
  readonly supportsActions: boolean;      // false on Firefox
  notify(n: Notification): Promise<string>;
  onAction(cb: (notificationId: string, actionId: string | 'click') => void): () => void;
}

export interface Permissions {
  contains(p: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
  request(p: { permissions?: string[]; origins?: string[] }): Promise<boolean>;   // user gesture only
  onRemoved(cb: () => void): () => void;
}

export interface KeepAwake {                // Chrome only; no-op implementation elsewhere
  readonly available: boolean;
  hold(reason: string): Promise<void>;      // power.requestKeepAwake('system')
  release(): Promise<void>;
}

export interface KeepAlive {                // keeps the background context from idling
  start(intervalMs: number): void;          // calls runtime.getPlatformInfo(); NEVER a network request
  stop(): void;
}
```

### 3.3 Site adapter: `SgwApi`, `SgwDom`, `SgwSession`, `SgwClock`, health

```ts
export interface SearchQuery {           // typed subset of the ItemListing body; booleans become "true"/"false" at the edge
  searchText: string;                    // double quotes are stripped at the edge (403 otherwise); exact-phrase is a local rule
  categoryIds: number[]; sellerIds: number[]; lowPrice?: Cents; highPrice?: Cents;
  pickupOnly?: boolean; excludePickupOnly?: boolean; oneCentShippingOnly?: boolean;
  searchDescriptions?: boolean; closedAuctions?: boolean; sortColumn?: number; sortDescending?: boolean;
  page: number;                          // 1-based; always 40 rows per page
  layout?: 'grid' | 'list';
}
export const searchQueryFromUrl: (url: string) => SearchQuery | null;      // src/domain/watches/query-url.ts
export const searchQueryToUrl: (q: SearchQuery) => string;

export interface SgwApi {
  search(q: SearchQuery, lane: Lane): Promise<{ items: Listing[]; total: number; page: number }>;
  itemDetail(itemId: ItemId, lane: Lane, opts?: { maxAgeMs?: number }): Promise<ItemDetail>;
  shippingQuote(itemId: ItemId, zip: string, lane: Lane): Promise<{ shipping: Cents; handling: Cents } | null>; // ⚠ shape [S-1]
  favorites(type: 'open' | 'close' | 'all', lane: Lane): Promise<Favorite[]>;         // auth
  addFavorite(itemId: ItemId): Promise<void>;                                          // auth, write
  removeFavorite(itemId: ItemId): Promise<void>;                                       // auth, write
  saveFavoriteNote(watchlistId: number, notes: string): Promise<void>;                 // auth, write, ≤256 chars enforced
  savedSearches(lane: Lane): Promise<Array<{ id: number; name: string; query: SearchQuery }>>;  // auth
  showBidModal(itemId: ItemId): Promise<{ sellerId: number; minimumBid: Cents }>;      // auth, read
  placeBid(req: { itemId: ItemId; sellerId: number; bidAmount: Cents; quantity: 1 },
           opts: { idempotencyKey: string; timeoutMs: number }): Promise<BidResult>;   // auth, WRITE, money
  serverTimeSample(): Promise<ClockSample>;                                             // prefers ItemDetail serverTime of a known item
}
export class SgwApiError extends Error { kind: 'auth' | 'rate-limited' | 'blocked' | 'server' | 'network' | 'timeout' | 'schema' | 'budget' | 'paused'; status?: number; retryAfterMs?: number; }
```

Write methods throw `SgwApiError{kind:'paused'}` when `GlobalSwitches.killSwitch`, `dryRun` for that feature, or `healthCheck()` failure is in effect. The adapter, not the caller, enforces this.

```ts
export interface CardHandle { itemId: ItemId; root: Element; anchor: Element /* where badges mount */; layout: 'grid' | 'list' | 'unknown'; }
export interface SgwDom {
  readonly configVersion: string;
  discoverCards(root: ParentNode): CardHandle[];       // ranked selectors; marks nodes with data-sbw-seen
  readListingHints(card: CardHandle): Partial<Listing>; // DOM-only fallback: title, price text, bids, time-left text
  applyDecoration(card: CardHandle, d: Decoration): void; // idempotent; re-applying same Decoration is a no-op
  clearDecoration(card: CardHandle): void;
  pageKind(url: string): 'search' | 'category' | 'item' | 'favorites' | 'other';
}
export type Decoration =
  | { kind: 'none' }
  | { kind: 'highlight'; label: string; ruleId: string; tone: 'green' | 'amber' | 'blue' }
  | { kind: 'hide'; ruleId: string; ruleName: string }      // collapsed stub, never display:none without stub
  | { kind: 'badge'; badges: Array<{ id: string; text: string; title?: string }> };

export interface SgwSession {
  observe(token: { bearer: string; capturedAt: EpochMs; source: 'tap' | 'webRequest' }): Promise<void>; // validates JWT shape, stores
  current(): Promise<{ bearer: string; expiresAt: EpochMs; buyerId: string } | null>;
  state(): Promise<'ok' | 'expiring' | 'expired' | 'logged-out'>;   // expiring = < 12 h left
  refresh(): Promise<boolean>;    // only if S-2 enabled refresh; otherwise returns false
  clear(): Promise<void>;
}

export interface ClockSample { serverMs: EpochMs; sentAt: EpochMs; receivedAt: EpochMs; rttMs: number; source: 'itemDetail' | 'getCurrentTime' | 'dateHeader'; }
export interface SgwClock {
  parsePacific(raw: PacificNaiveRaw): EpochMs;       // throws on ambiguity-unsafe input? No: resolves fall-back ambiguity to the EARLIER instant and flags it
  parsePacificDetailed(raw: string): { ms: EpochMs; ambiguous: boolean; nonexistent: boolean };
  addSample(s: ClockSample): void;
  offset(): { offsetMs: number; rttMs: number; samples: number; confidence: 'none' | 'low' | 'high' } | null; // lowest-RTT sample wins
  serverNow(): EpochMs | null;
}

export interface HealthReport { ok: boolean; checkedAt: EpochMs; configVersion: string;
  checks: Array<{ name: 'search-schema' | 'detail-schema' | 'card-selectors' | 'clock' | 'session'; ok: boolean; detail?: string }>; }
export interface SgwHealth { run(mode: 'anonymous' | 'full'): Promise<HealthReport>; last(): Promise<HealthReport | null>; }
```

**Fail-closed rule.** `GlobalSwitches` (§3.11) exposes `writesAllowed(feature)`. It is false whenever: kill switch on, `dryRun[feature]` on, last `HealthReport.ok === false` within 24 h, or `SgwSession.state() !== 'ok'`. Every write path checks it; the adapter checks it again.

### 3.4 Request scheduler / rate limiter

```ts
export type Lane = 'interactive' | 'background' | 'snipe' | 'canary';
export interface LaneConfig { minIntervalMs: number; jitterMs: number; maxConcurrent: 1; dailyBudget: number; }
export const DEFAULT_LANES: Record<Lane, LaneConfig> = {
  interactive: { minIntervalMs: 1000,   jitterMs: 300,  maxConcurrent: 1, dailyBudget: 300 },
  background:  { minIntervalMs: 120000, jitterMs: 15000, maxConcurrent: 1, dailyBudget: 120 },
  snipe:       { minIntervalMs: 1000,   jitterMs: 0,    maxConcurrent: 1, dailyBudget: 80 },   // exception justified in §9
  canary:      { minIntervalMs: 120000, jitterMs: 0,    maxConcurrent: 1, dailyBudget: 4 },
};
export interface ScheduledRequest<T> {
  lane: Lane; endpoint: string /* config key */; key?: string /* cache key */; cacheTtlMs?: number;
  priority?: number; build(): HttpRequest; parse(res: HttpResponse): T;   // parse runs zod; throws SgwApiError('schema')
}
export interface RequestScheduler {
  run<T>(r: ScheduledRequest<T>): Promise<T>;
  stats(): { lanes: Record<Lane, { usedToday: number; budget: number; nextAllowedAt: EpochMs; backoffUntil?: EpochMs }>; cacheHits: number };
  pause(reason: string, untilMs?: EpochMs): void;   // set by health failure, 403/429 bursts, considerate mode
  resume(): void;
}
```
Backoff: on 429 or 5xx, lane backoff = min(2^n × 30 s, 30 min) with jitter; on 403, backoff 1 h and mark `blocked`; three consecutive 403s on any lane pause **all** lanes 6 h and notify ("SGW is refusing requests; automation paused"). Budgets reset at local midnight. `considerateMode: 'normal' | 'tight'` halves every budget and doubles every interval.

### 3.5 Rule engine

```ts
export type Condition =
  | { kind: 'keyword'; mode: 'any' | 'all' | 'none'; terms: string[]; wholeWord: boolean; regex: boolean; fields: Array<'title' | 'category' | 'seller'> }
  | { kind: 'price'; min?: Cents; max?: Cents }
  | { kind: 'landedCost'; min?: Cents; max?: Cents }        // currentPrice + shipping + handling to home ZIP; unknown → condition is 'unknown'
  | { kind: 'seller'; mode: 'include' | 'exclude'; sellerIds: number[]; sellerNames: string[] }
  | { kind: 'location'; mode: 'include' | 'exclude'; states: string[] }
  | { kind: 'category'; categoryIds: number[]; includeChildren: boolean }
  | { kind: 'endsWithin'; minMinutes?: number; maxMinutes?: number }
  | { kind: 'bidCount'; min?: number; max?: number }
  | { kind: 'pickupOnly'; value: boolean };
export interface Rule { id: string; name: string; enabled: boolean; action: 'highlight' | 'hide' | 'watch';
  tone?: 'green' | 'amber' | 'blue'; all: Condition[]; any?: Condition[]; createdAt: EpochMs; updatedAt: EpochMs; }
export interface MatchContext { now: EpochMs; landedCost?: (id: ItemId) => Cents | null | undefined /* undefined = not fetched */; }
export interface MatchReason { ruleId: string; conditionIndex: number; field: string; detail: string; } // e.g. "title contains 'pyrex' (whole word)"
export interface MatchResult { itemId: ItemId; decision: 'hide' | 'highlight' | 'watch' | 'none';
  matched: Array<{ ruleId: string; action: Rule['action']; reasons: MatchReason[] }>; unknownConditions: number; }
export function evaluate(listing: Listing, rules: Rule[], ctx: MatchContext): MatchResult;
export function evaluateBatch(listings: Listing[], rules: Rule[], ctx: MatchContext): MatchResult[];
export function compileKeyword(c: Extract<Condition, { kind: 'keyword' }>): { test(text: string): boolean; }; // regex is RE2-safe-checked: length ≤ 200, no nested quantifiers, 5 ms budget per test
```
Precedence: `hide` beats `highlight` beats `watch`; a disabled rule never matches; conditions in `all` are AND, `any` is OR, both must hold. Keyword matching is case-insensitive, Unicode-normalised (NFKC), `wholeWord` uses `\b` on word characters plus digits.

### 3.6 Watches and the daily job

```ts
export interface Watch { id: string; name: string; enabled: boolean; query: SearchQuery; ruleIds: string[];
  maxPages: 1 | 2 | 3; favoriteMode: 'sgw' | 'sgw-late' | 'local'; favoriteWithinHours?: number;
  calendar: boolean; notify: boolean; lastRunAt?: EpochMs; nextRunAt: EpochMs; lastError?: string; seenItemIds: ItemId[] /* ring 2000 */; }
export type JobStep =
  | { kind: 'search'; watchId: string; page: number }
  | { kind: 'favoritesList' }
  | { kind: 'detail'; itemId: ItemId; reason: 'new-match' | 'calendar' }
  | { kind: 'favorite'; itemId: ItemId; watchId: string }
  | { kind: 'calendarUpsert'; itemId: ItemId }
  | { kind: 'notifyDigest' };
export interface JobRun { id: string; trigger: 'scheduled' | 'catch-up' | 'manual'; startedAt: EpochMs; finishedAt?: EpochMs;
  status: 'running' | 'done' | 'failed' | 'paused'; steps: JobStep[]; cursor: number;
  results: { newMatches: ItemId[]; favorited: ItemId[]; calendarUpserts: ItemId[]; errors: Array<{ step: number; message: string }> }; }
export interface DailyJob {        // pure state machine; the runner feeds it one step at a time
  plan(watches: Watch[], now: EpochMs): JobRun;
  next(run: JobRun): JobStep | null;
  apply(run: JobRun, step: JobStep, outcome: StepOutcome): JobRun;   // returns a new run; may append steps (e.g., details for new matches)
}
export interface Scheduler { reconcile(now: EpochMs): Promise<void>; dueWatches(now: EpochMs): Promise<Watch[]>; }
```
Manual "Run now" uses lane `interactive` (1 req/s); scheduled and catch-up runs use lane `background` (120 s).

### 3.7 Favorites

```ts
export interface FavoritesReconciler {
  desired(tracked: TrackedItem[], watches: Watch[], now: EpochMs): Array<{ itemId: ItemId; action: 'add' | 'none'; reason: string }>;
  // idempotent: 'add' only when favoriteState==='none'|'failed' AND the item is not in favoritesCache AND the watch mode permits now
}
```
Removal is never automatic (the user may have favorited manually); undo of an extension-made favorite is an explicit audit-log undo.

### 3.8 `CalendarSink`, `CalendarApi`, `GoogleAuthProvider`

```ts
export interface DesiredEvent { itemId: ItemId; generation: number; title: string; description: string;
  startUtc: IsoUtc /* = auction end */; durationMin: 15; sourceUrl: string;
  reminders: Array<{ method: 'popup' | 'email'; minutes: number }>;   // default [popup 60, popup 15, popup 5]; max 5
  privateProps: { sbwItemId: string; sbwGen: string; sbwState: 'open' | 'won' | 'lost' | 'ended-early' }; }
export function eventIdFor(itemId: ItemId, generation: number): string;   // "sbv" + itemId + "g" + gen  → /^[a-v0-9]{5,1024}$/
export interface CalendarLink { itemId: ItemId; eventId: string; generation: number; calendarId: string; lastSyncedHash: string; status: 'synced' | 'pending' | 'error' | 'deleted'; lastError?: string; }
export interface CalendarSink {
  ensureCalendar(): Promise<string>;                                   // creates "ShopGoodwill Auctions" once; stores calendarId
  upsert(e: DesiredEvent): Promise<{ op: 'insert' | 'patch' | 'noop' | 'recreated'; link: CalendarLink }>;
  remove(itemId: ItemId): Promise<{ op: 'delete' | 'noop' }>;
  stamp(itemId: ItemId, outcome: 'won' | 'lost' | 'ended-early', finalPrice?: Cents): Promise<void>;  // retitles, clears reminders
  reconcile(desired: DesiredEvent[], links: CalendarLink[]): Promise<Array<{ itemId: ItemId; op: string; error?: string }>>;
}
export interface CalendarApi {   // thin typed Calendar v3 subset; every response zod-validated
  calendarsInsert(summary: string, timeZone: string): Promise<{ id: string }>;
  calendarListGet(calendarId: string): Promise<{ id: string } | null>;
  eventsInsert(calendarId: string, body: GcalEventBody & { id: string }): Promise<GcalEvent>;   // 409 → CalendarApiError('conflict')
  eventsGet(calendarId: string, eventId: string): Promise<GcalEvent | null>;                    // includes status:'cancelled'
  eventsPatch(calendarId: string, eventId: string, patch: Partial<GcalEventBody>): Promise<GcalEvent>;
  eventsDelete(calendarId: string, eventId: string): Promise<void>;                              // 404/410 → noop
  eventsListByPrivateProp(calendarId: string, key: string, value: string): Promise<GcalEvent[]>;
}
export class CalendarApiError extends Error { code: 'conflict' | 'not-found' | 'auth' | 'insufficient-scope' | 'rate-limited' | 'offline' | 'schema' | 'other'; status?: number; }

export interface AuthStatus { connected: boolean; provider: 'pkce' | 'chrome-identity' | 'none'; account?: string;
  grantedScopes: string[]; refreshTokenAgeDays?: number; lastError?: GoogleAuthErrorCode; needsInteraction: boolean; configured: boolean; }
export type GoogleAuthErrorCode = 'invalid_grant' | 'unauthorized' /*401*/ | 'insufficient_scope' | 'rate_limited' /*429/quota*/ | 'offline' | 'needs_interaction' | 'not_configured' | 'user_cancelled';
export class GoogleAuthError extends Error { code: GoogleAuthErrorCode; }
export interface GoogleAuthProvider {
  getAccessToken(opts: { interactive: boolean }): Promise<string>;   // interactive:true only from a user gesture; background always passes false
  connect(): Promise<AuthStatus>;      // user gesture; PKCE S256; access_type=offline; prompt=consent; stores refresh token in storage.local
  disconnect(): Promise<void>;         // REVOKES: POST oauth2.googleapis.com/revoke (refresh token) | identity.clearAllCachedAuthTokens(); then clears storage
  status(): Promise<AuthStatus>;
}
```
Example `DesiredEvent`:
```json
{ "itemId": 279250057, "generation": 0, "title": "SGW ends: Vintage Pyrex Butterfly Gold Bowl 403 ($12.99)",
  "description": "https://shopgoodwill.com/item/279250057\nCurrent $12.99 · Bids 0 · Ends 7:18 PM PT / 10:18 PM EDT\nShopBadwill watch: Pyrex",
  "startUtc": "2026-10-08T02:18:30.000Z", "durationMin": 15, "sourceUrl": "https://shopgoodwill.com/item/279250057",
  "reminders": [{"method":"popup","minutes":60},{"method":"popup","minutes":15},{"method":"popup","minutes":5}],
  "privateProps": { "sbwItemId": "279250057", "sbwGen": "0", "sbwState": "open" } }
```
Generated event id: `sbv279250057g0`. On 409 at insert: `eventsGet`; if `status==='cancelled'` try `eventsPatch({status:'confirmed', ...})`; if that fails (⚠ S-5), bump `generation` and insert `sbv279250057g1`.

### 3.9 Snipe engine

```ts
export type SnipeState = 'draft' | 'armed' | 'fallback-applied' | 'waking' | 'verified' | 'firing' | 'sent' | 'resolved' | 'killed';
export type SnipeOutcome = 'won' | 'outbid' | 'below-minimum' | 'auth' | 'network' | 'late' | 'ended' | 'extended' | 'cap-blocked' | 'killed' | 'dry-run' | 'fallback-proxy-placed' | 'skipped';
export interface Snipe {
  id: string; itemId: ItemId; title: string; endTime: IsoUtc; endTimeAtArm: IsoUtc; sellerId?: number;
  maxBid: Cents; allInMax?: Cents; estShipping?: Cents; estHandling?: Cents;
  leadMs: number; fallback: 'early-proxy' | 'skip'; dryRun: boolean;
  state: SnipeState; outcome?: SnipeOutcome; outcomeDetail?: string;
  armedAt: EpochMs; fireAt?: EpochMs; wakeAlarm?: string; attempt: { sentAt?: EpochMs; idempotencyKey?: string; ambiguous?: boolean };
  measured?: { offsetMs?: number; rttMs?: number; firedAt?: EpochMs; responseAt?: EpochMs };
  groupId?: string; history: Array<{ at: EpochMs; from: SnipeState; to: SnipeState; why: string }>;
}
export type SnipeEvent =
  | { type: 'arm'; now: EpochMs } | { type: 'disarm'; now: EpochMs; by: 'user' | 'kill' | 'anomaly'; why: string }
  | { type: 'wake'; now: EpochMs } | { type: 'verified'; now: EpochMs; detail: ItemDetail; offsetMs: number; rttMs: number }
  | { type: 'verify-failed'; now: EpochMs; reason: 'ended' | 'extended' | 'price-over-max' | 'already-high' | 'auth' | 'network' | 'clock' | 'cap' }
  | { type: 'fire'; now: EpochMs } | { type: 'sent'; now: EpochMs; key: string }
  | { type: 'result'; now: EpochMs; result: BidResult } | { type: 'ambiguous'; now: EpochMs }
  | { type: 'post-read'; now: EpochMs; detail: ItemDetail } | { type: 'preflight-failed'; now: EpochMs; reason: string }
  | { type: 'apply-fallback'; now: EpochMs; mode: 'early-proxy' | 'skip' };
export function reduce(s: Snipe, e: SnipeEvent, caps: CapsCheck): { next: Snipe; effects: Effect[] };  // pure; Effects: 'scheduleWake' | 'holdKeepAwake' | 'sampleClock' | 'readDetail' | 'placeBid' | 'notify' | 'stampCalendar' | 'audit' | 'applyFallbackProxy'
export function computeFireAt(endMs: EpochMs, leadMs: number, oneWayLatencyMs: number): EpochMs;   // end − lead − oneWay; oneWay = rtt/2 of lowest-RTT sample
export interface CapsCheck { perItemMax: Cents; perDayMax: Cents; openExposureMax: Cents; typoMultiplier: 3; typoAbsolute: Cents; }
export function checkCaps(s: Snipe, others: Snipe[], spentToday: Cents, caps: CapsCheck): { ok: boolean; violations: string[] };
export interface SnipeHost {   // where the final timer runs; background by default, runner page on Firefox if S-7 says so
  acquire(snipeId: string): Promise<void>; release(snipeId: string): Promise<void>;
}
```
Idempotency rule (binding): `placeBid` is called at most once per `Snipe.id` unless the previous attempt is **proven** not to have arrived: a `HttpNetworkError` thrown before any bytes were sent, or a post-read showing `numBids` and `bidHistory` unchanged from the T−60 read **and** `isHighBidder === false` **and** at least 1.5 s remain. Timeouts and worker death are ambiguous: post-read first; never a second send unless proven. A restarted worker reads `attempt.sentAt` from storage and treats an existing key as sent.

Default lead: **8 s** (configurable 3–30 s). Justification: SGW's own FAQ warns last-second bids may not process, peak-hour slowness is reported ⚠, and proxy bidding means the snipe only needs to beat *humans* reacting (≥5–10 s), not rival proxies. Prior art sits at 1–15 s. After the dry-run soak (T-74), the default becomes `clamp(p99 one-way latency + 5 s, 6 s, 15 s)`.

### 3.10 Audit log and settings

```ts
export interface AuditEntry { seq: number; at: EpochMs; actor: 'user' | 'daily-job' | 'snipe' | 'calendar' | 'health' | 'system';
  kind: string;                 // 'favorite.add' | 'calendar.insert' | 'snipe.arm' | 'bid.sent' | 'bid.result' | 'kill.on' | 'health.fail' | ...
  itemId?: ItemId; ref?: string; details: Record<string, string | number | boolean | null>;  // redacted: no tokens, no HTML
  undo?: { kind: 'unfavorite' | 'deleteEvent' | 'disableRule' | 'disarm'; ref: string; done?: boolean }; dryRun?: boolean; }
export interface AuditLog { append(e: Omit<AuditEntry, 'seq' | 'at'>): Promise<AuditEntry>; list(q: { limit: number; before?: number; kinds?: string[] }): Promise<AuditEntry[]>; exportJson(): Promise<string>; }

export interface Settings {
  schemaVersion: 1; homeZip?: string; locale: { timeZone: string };   // user's IANA tz, detected
  dailyRun: { enabled: boolean; localTime: string /* "07:00" */; catchUp: boolean };
  overlay: { enabled: boolean; hideStyle: 'collapse' | 'dim'; quickFavorite: boolean; landedCostBadges: boolean; countdown: boolean };
  dryRun: { favorites: boolean; calendar: boolean; bidding: boolean };   // all true by default
  considerateMode: 'normal' | 'tight';
  features: { landedCost: boolean; comps: boolean; countdownRefresh: boolean; relistDetector: boolean };
  calendar: { enabled: boolean; mode: 'dedicated' | 'primary'; reminders: number[]; icsFallback: boolean };
  notifications: { enabled: boolean; digest: boolean; quietHours?: { from: string; to: string } };
  ntfy?: { enabled: boolean; server: string; topic: string };
  snipe: { enabled: boolean; defaultLeadMs: number; defaultFallback: 'early-proxy' | 'skip'; caps: CapsCheck; keepAlive: boolean; requiredDryRuns: number; completedDryRuns: number; tier: 'T0' | 'T1' | 'T2' };
  killSwitch: boolean;
}
export interface GlobalSwitches { writesAllowed(feature: 'favorites' | 'calendar' | 'bidding'): Promise<{ ok: boolean; why?: string }>; }
```

### 3.11 Session and credentials records

```ts
export interface SgwSession { bearer: string; capturedAt: EpochMs; expiresAt: EpochMs; buyerId: string; source: 'tap' | 'webRequest'; refreshToken?: string /* only if S-2 approves */; }
export interface GoogleCredentials { provider: 'pkce' | 'chrome-identity'; clientId: string; clientSecret?: string; refreshToken?: string; grantedScopes: string[]; connectedAt: EpochMs; account?: string; calendarId?: string; }
```

### 3.12 Message types

```ts
export type Msg =
  // content → background
  | { type: 'page.listings'; payload: { url: string; listings: Listing[]; capturedAt: EpochMs } }
  | { type: 'page.detail'; payload: { detail: ItemDetail } }
  | { type: 'page.token'; payload: { bearer: string; capturedAt: EpochMs } }
  | { type: 'rules.evaluate'; payload: { listings: Listing[] }; reply: MatchResult[] }
  | { type: 'landedCost.get'; payload: { itemIds: ItemId[] }; reply: Record<ItemId, Cents | null> }
  | { type: 'quick.hideSeller'; payload: { sellerId: number; sellerName: string } }
  | { type: 'quick.hideKeyword'; payload: { term: string } }
  | { type: 'quick.favorite'; payload: { itemId: ItemId } }
  | { type: 'quick.track'; payload: { itemId: ItemId } }
  // UI → background
  | { type: 'settings.get'; reply: Settings } | { type: 'settings.set'; payload: Partial<Settings> }
  | { type: 'rules.list'; reply: Rule[] } | { type: 'rules.save'; payload: Rule } | { type: 'rules.delete'; payload: { id: string } }
  | { type: 'rules.preview'; payload: { rule: Rule; listings: Listing[] }; reply: { matched: number; total: number; ids: ItemId[] } }
  | { type: 'watches.list'; reply: Watch[] } | { type: 'watches.save'; payload: Watch } | { type: 'watches.delete'; payload: { id: string } }
  | { type: 'job.runNow'; payload: { watchIds?: string[] } } | { type: 'job.status'; reply: JobRun | null }
  | { type: 'tracked.list'; reply: TrackedItem[] } | { type: 'tracked.remove'; payload: { itemId: ItemId } }
  | { type: 'favorites.sync' }
  | { type: 'calendar.connect' /* gesture */; reply: AuthStatus } | { type: 'calendar.disconnect' } | { type: 'calendar.status'; reply: AuthStatus }
  | { type: 'calendar.syncNow' } | { type: 'calendar.ics'; payload: { itemIds: ItemId[] }; reply: { ics: string } }
  | { type: 'snipe.prepare'; payload: { itemId: ItemId }; reply: { detail: ItemDetail; estAllIn: Cents | null; caps: ReturnType<typeof checkCaps> } }
  | { type: 'snipe.arm'; payload: { snipe: Omit<Snipe, 'state' | 'history' | 'armedAt'>; typedConfirmation?: string } ; reply: Snipe }
  | { type: 'snipe.disarm'; payload: { id: string } } | { type: 'snipe.list'; reply: Snipe[] }
  | { type: 'kill.set'; payload: { on: boolean } } | { type: 'health.get'; reply: { sgw: HealthReport | null; session: SgwSession['expiresAt'] | null; google: AuthStatus; budget: RequestScheduler['stats'] } }
  | { type: 'audit.list'; payload: { limit: number; before?: number }; reply: AuditEntry[] } | { type: 'audit.undo'; payload: { seq: number } }
  | { type: 'permissions.request'; payload: { permissions?: string[]; origins?: string[] }; reply: boolean }   // gesture
  // background → content/UI broadcasts
  | { type: 'rules.changed' } | { type: 'switches.changed'; payload: { killSwitch: boolean; writesAllowed: Record<string, boolean> } };
```
Port names: `sbw:snipe-countdown` (background → UI stream of `{ snipeId, serverNow, fireAt, state }` every 1 s while the dashboard is open), `sbw:job-progress`.

---

## 4. Phase 0 spikes, each with exit criteria

Every spike writes `docs/spikes/S-n.md` with: method, raw evidence (sanitized), verdict, and the contract or config change it implies. Spikes are read-only against SGW and anonymous unless a step is explicitly marked **USER STEP** (the user performs it logged in, following exact instructions the spike author writes; the worker never has the user's credentials). All SGW requests go through `scripts/capture-fixtures.ts`, which enforces ≥120 s between requests and a per-run cap of 25.

### S-1 · SGW recon (Task 0) — card T-07
Scope: capture and sanitize fixtures for every endpoint and page the plan touches; confirm the facts in the brief; settle ⚠ items that need only anonymous reads.
Exit criteria:
1. `test/fixtures/sgw/json/` holds validated samples: `search-grid-p1`, `search-list-p1`, `search-empty`, `search-malformed-200`, `item-detail-open`, `item-detail-closed`, `item-detail-pickup`, `get-current-time`, plus `favorites-open`, `saved-searches`, `show-bid-modal`, `calculate-shipping` from **USER STEP** captures (the user exports from DevTools, the worker sanitizes).
2. `test/fixtures/sgw/html/` holds *rendered* DOM captures (Playwright, after hydration) of grid, list, item page, favorites page (USER STEP), logged-in and logged-out variants, sanitized (titles replaced, ids remapped, ad scripts stripped) with a provenance `manifest.json`.
3. Verdicts recorded for: `serverTime` format (naive PT? ms?) ⚠, `CalculateShipping` request/response shape ⚠, list-layout and item-page DOM ⚠, which flows reCAPTCHA gates (observation only) ⚠, the Goodwill Canada "last-second bids" warning's presence in SGW's own help center ⚠, `Favorite/Save` note length (USER STEP, by observing the site's own validation, no write) ⚠.
4. `src/adapters/sgw/config.ts` v1 is filled with selectors ranked by observed stability and every endpoint path.
5. Request log shows ≤25 anonymous requests, spaced ≥120 s. No login, no writes.

### S-2 · Session capture, token lifetime, unattended refresh — card T-08
Exit criteria:
1. Verdict on token capture: MAIN-world tap sees the `Authorization` header on the site's XHR/fetch (yes/no, with evidence from the user's DevTools on a logged-in page, USER STEP) vs `webRequest` fallback; permission cost of each listed.
2. Measured JWT `exp` − `iat` from the user's own token (USER STEP: the user pastes only the decoded `exp`, `iat` and whether `IpAddress`/`Browser` claims exist; never the token itself).
3. Verdict on `SignIn/RefreshToken` with no user present: whether the site calls it itself, what body it needs, whether a refresh token is available to the tap, and whether a refreshed token works after the cookie's 1-day expiry (USER STEP over two days).
4. Verdict on IP/UA binding: the user changes nothing; the worker documents claim names only. (Binding behaviour is not tested by spoofing.)
5. Decision written into `SgwSession` contract: store refresh token yes/no; expected unattended validity window; the graceful-degradation path if < 24 h.

### S-3 · Soft-close verdict — card T-09
Method (no polling near close): pick 6 anonymous items ending within the next 3 hours with ≥3 bids; read ItemDetail once ≥10 min before each end and once ≥10 min after; compare final `endTime` with `endTimeAtFirstRead` and with the last `bidHistory` time (ms precision).
Exit criteria: a table of items, late-bid times relative to original end, and whether `endTime` moved; verdict `hard-close` | `soft-close(+N s)` | `inconclusive`; the `SnipeEngine` constant `ASSUME_EXTENSION_MS` set accordingly and the "extended" outcome path kept regardless. ≤12 requests.

### S-4 · Google OAuth on both browsers with the user's own project — card T-10
USER STEP throughout (the worker writes the exact clicks; the user runs them and pastes redacted results).
Exit criteria:
1. On Chrome: `launchWebAuthFlow` + Web client + PKCE: does the token exchange succeed without `client_secret` ⚠? With it? Refresh works with `interactive:false` from the background?
2. On Firefox: loopback redirect `http://127.0.0.1/mozoauth2/<hash>` + Desktop client accepted by Google ⚠? Refresh works?
3. `calendar.app.created` grants `calendars.insert` and `events.insert` on the created calendar ⚠ (one test calendar on the user's own account, deleted afterwards — this is the only Phase 0 Google write and it is a USER STEP, not automated).
4. Decision rule applied: PKCE on both if 1 and 2 pass; else `ChromeIdentityProvider` on Chrome (T-63 activates) and the fallback for Firefox documented.
5. Project publishing status moved to "In production" and the 7-day expiry confirmed gone (token still valid on day 8; USER STEP, reported later, does not block Phase 1).

### S-5 · Event-ID 409 and cancelled behaviour — card T-11
USER STEP on the test calendar from S-4. Insert `sbv…g0`, delete it, insert the same id again (expect 409 or 200?), `events.get` with the id (status `cancelled`?), patch `status:'confirmed'` (revives?). Exit: documented matrix; `CalendarSink.upsert` recreate path chosen (`patch-revive` vs `bump-generation`).

### S-6 · Firefox E2E harness — card T-12
Exit criteria: a CI job installs the `.output/firefox-mv3` build temporarily with Selenium/geckodriver (`install_addon(temporary=True)`, Python 3.14 on the dev machine, `selenium` pinned) or WebDriver BiDi `webExtension.install`, navigates to a page served by the fake SGW server with a hostname override, and asserts a Shadow DOM badge is present; the background's `reconcile()` ran (checked through a test-only `sbw:test:state` page compiled only in test builds). Documents what is and isn't reachable (no SW handle in Firefox). Fallback if Selenium fails: `web-ext run` smoke with `--pref` and a screenshot assertion.

### S-7 · Dry-run snipe timing measurement — card T-13
Against the fake SGW server with injected 150 ms latency and +1.3 s clock skew. Exit criteria: on Chromium and Firefox, with the extension packed (not unpacked, so alarm floors apply) and no visible extension window, 20 scheduled dry-run fires each: alarm wake latency distribution; whether `KeepAlive` heartbeats keep the background alive for ≥6 min on both; tight-timer fire error (target: p95 ≤ 50 ms, max ≤ 250 ms); verdict for Firefox: background-host OK or runner-page fallback required (T-116). Also measures how often the worker died during a 20 s stalled fetch and whether the restart path recovered.

### S-8 · Wake-from-sleep feasibility on Windows — card T-14
USER STEP-heavy (the worker writes a script and a checklist). Exit criteria:
1. MV3 `background` permission ⚠: with it granted, does Chrome keep running after the last window closes, and start at login? Evidence: `chrome://extensions` state plus a heartbeat alarm writing timestamps.
2. `power.requestKeepAwake('system')` prevents idle sleep on this machine (yes/no); confirmed no effect on lid-close/manual sleep.
3. Task Scheduler "Wake the computer to run this task" fires from S3 sleep and from hibernate; time from wake to network-up measured; "Allow wake timers" setting documented; Modern Standby ⚠ status of the user's hardware (`powercfg /a`) and whether only "important" wake timers are honoured.
4. A scheduled task launching Chrome with the user's profile results in the extension's `onStartup` reconcile running within N s (measured).
5. Verdict feeds §1.4: T1 viable on this machine (y/n), T2 viable (y/n), recommended power-plan settings written to `docs/COMPANION.md`.

---

## 5. Phases and milestones

| Phase | Goal | Ends with the user able to… | Gate (all must be green) |
|---|---|---|---|
| **0 · Foundations and spikes** | Repo, contracts, fakes, CI, eight spikes | load an unpacked build that shows a "ShopBadwill ready" badge on SGW search pages (no features) | T-01…T-14 done; contracts frozen (PR "contracts v1" merged); every spike doc has a verdict; CI green on both lanes |
| **1 · Overlay (req. 1)** | Rules engine, site adapter, overlay, options, popup | write rules in options and see highlights/hidden stubs/Why?/undo on live SGW pages they browse; kill switch works | static+unit+contract+dom+integration green; Chromium E2E overlay green; Firefox smoke green; manual acceptance A-1 signed |
| **2 · Watches, daily job, favorites (req. 2–3)** | Resumable daily job, catch-up, favorites reconcile, dashboard, audit log, notifications, landed cost | create a watch from a search, have it run overnight in dry-run, see the activity log, then enable real favoriting | E2E "daily job + catch-up + restart" green; canary workflow passing nightly; A-2 signed (one real favorite via undo-able action, user-approved) |
| **3 · Google Calendar and onboarding (req. 4) = MVP complete** | PKCE auth, calendar sync, stamping, .ics, onboarding, setup guides, release pipeline | connect Google, see events with 60/15/5 popups on their phone, install a signed Firefox build | E2E calendar green against fake Google; A-3 signed ("popups arrived on the phone with the PC off"); release v0.1.0 artifacts for both browsers |
| **4 · Snipe engine, dry-run** | State machine, timing, caps, preflight, runner, arming UI, kill switch, outcome report, soak tooling | arm dry-run snipes and read a timing report after a week | E2E snipe scenarios green; S-7 verdicts incorporated; dry-run soak ≥5 fires with on-time ≥95% on the user's machine; A-4 signed |
| **5 · Live bidding with caps** | PlaceBid adapter, idempotent send, live gating, outcome stamping | place one real snipe on a cheap item they chose; see WON/LOST on the calendar | E2E money paths green; PlaceBid response catalogue captured (USER STEP); A-5 signed after the first real snipe |
| **6 · Reliability T2 and later QoL** | Windows wake-and-launch companion, bid groups, relist detector, import/export, comps | wake the PC from sleep for a snipe; win one of N | S-8 verdicts; E2E group cancellation; A-6 signed |

**Task counts per phase (86 cards):** Phase 0 = 14 (T-01…T-14, incl. 8 spikes) · Phase 1 = 22 (T-20…T-41) · Phase 2 = 12 (T-50…T-61) · Phase 3 = 13 (T-62…T-74; T-63 conditional) · Phase 4 = 12 (T-80…T-91) · Phase 5 = 6 (T-100…T-105) · Phase 6 = 7 (T-110…T-116; T-116 conditional).

**Parallelism.** Within a phase, every distinct lane letter in §6 can run concurrently; the widest fronts are Phase 0 (lanes A–L after T-01/T-02) and Phase 1 (lanes A–N after T-02/T-03/T-07). The critical path is T-01 → T-02 → T-07 → T-24 → T-26 → T-36 → T-39 → T-52 → T-59 → T-67 → T-72 → T-84 → T-89 → T-101 → T-104.

Release cadence: tag `v0.1.0` at end of Phase 3 (MVP), `v0.2.0` after Phase 4 (dry-run snipes), `v0.3.0` after Phase 5 (live), `v0.4.0` after Phase 6.

---

## 6. Task cards

Card format: **ID · Title** (size · lane). Goal · Consumes/Produces · Owns (files; no two parallel cards share a file) · Deps · Tests first · Acceptance · Gate. Lanes: cards in the same phase with different lane letters can run concurrently; same letter = sequential. Package scripts are defined by T-01 and named consistently: `pnpm lint`, `pnpm typecheck`, `pnpm test:unit [path]`, `pnpm test:contract`, `pnpm test:dom`, `pnpm test:integration`, `pnpm test:e2e:chromium`, `pnpm test:e2e:firefox`, `pnpm build`, `pnpm build:firefox` (= `wxt build -b firefox --mv3`), `pnpm lint:webext`, `pnpm check:permissions`, `pnpm check:prod-bundle`, `pnpm check:all` (everything except e2e). Every card's gate implicitly includes `pnpm lint && pnpm typecheck` on its owned files.

### Phase 0

**T-01 · Repo scaffold and toolchain** (L · A)
Goal: WXT 0.21.x project with TypeScript strict, ESLint (`typescript-eslint`, `eslint-plugin-no-unsanitized`, `import/no-restricted-paths` per §2.1), Vitest with `WxtVitest()` plugin, Playwright config for Chromium, `web-ext` dev dependency, Preact module, pnpm, Node 25 `.nvmrc`, `.editorconfig`, package scripts listed above, `wxt.config.ts` with per-browser manifest (permissions per §2.5, `gecko.id`, `data_collection_permissions`, `commands` for kill switch), build-time `oauth2.client_id` injection via env (unused until Phase 3), `import.meta.env.SBW_TEST` flag for test builds.
Produces: project skeleton; `entrypoints/background.ts` printing a heartbeat; `entrypoints/sgw.content.ts` mounting an empty Shadow DOM badge "ShopBadwill ready".
Owns: root config files, `package.json`, `wxt.config.ts`, `entrypoints/background.ts`, `entrypoints/sgw.content.ts`, `src/entrypoints/**` placeholders, `README.md` (dev section only).
Deps: none.
Tests first: `test/unit/smoke.test.ts` (fakeBrowser storage round-trip); `test/unit/manifest-permissions.test.ts` snapshot of both prod manifests.
Acceptance: `pnpm build` and `pnpm build:firefox` produce `.output/chrome-mv3` and `.output/firefox-mv3`; `pnpm lint:webext` passes on the Firefox build with `--warnings-as-errors`; loading unpacked shows the badge on a SGW search page (manual, screenshot pasted).
Gate: `pnpm check:all && pnpm build && pnpm build:firefox && pnpm lint:webext`.

**T-02 · Contracts v1** (L · B)
Goal: encode §3 verbatim as TypeScript plus zod schemas and fixtures-of-contracts (one valid and one invalid JSON example per type).
Produces: `src/ports/*.ts`, `src/domain/types.ts`, `src/domain/settings/{schema,defaults}.ts`, `src/domain/storage/schema.ts` (key names, v1), `src/messaging/protocol.ts`, `src/domain/snipe/types.ts`, `src/domain/calendar/types.ts`, `src/domain/rules/schema.ts`, `src/domain/watches/schema.ts`, `src/domain/audit/types.ts`.
Owns: those files and `test/contract/types/*.test.ts`.
Deps: T-01.
Tests first: each schema parses its valid example and rejects its invalid example; `Msg` union discriminates every `type`; `Settings` defaults parse; `eventIdFor` regex test lives here as a type-level constant test.
Acceptance: `pnpm typecheck` clean; contract-change PR template added (`.github/PULL_REQUEST_TEMPLATE/contract-change.md`).
Gate: `pnpm test:contract -- test/contract/types`.

**T-03 · Fake ports and test utilities** (M · C)
Goal: in-memory fakes for every port, usable in unit and integration tests.
Produces: `test/fakes/ports/{fake-clock,fake-alarms,fake-storage,fake-notifier,fake-permissions,fake-keepawake,fake-keepalive,fake-http}.ts`, `test/fixtures/load.ts` (typed fixture loader), `test/setup/vitest.setup.ts` (fakeBrowser.reset in beforeEach, MSW `setupServer` for Node).
Owns: those files, `vitest.config.ts` test section (coordinate with T-01: T-01 creates the file, T-03 only edits `setupFiles`; serialize by making T-03 depend on T-01).
Deps: T-01, T-02.
Tests first: `FakeAlarms` rejects `delayInMinutes < 0.5` by clamping and records a warning; `FakeAlarms.advance(ms)` fires due alarms with configurable extra delay; `FakeClock` drives `setTimeout` deterministically; `FakeHttp` scripted responses with latency and abort support.
Acceptance: fakes implement the port interfaces (typecheck), 100% branch coverage on FakeAlarms clamp logic.
Gate: `pnpm test:unit -- test/fakes`.

**T-04 · Fake buyerapi server** (L · D)
Goal: Node HTTP server emulating the endpoints in §3.3 with SGW's quirks: string booleans, 40 rows/page, 403 on double quotes in `searchText`, 200-with-zero-rows on malformed body, naive-PT `endTime`, ms `serverTime`, `Bid` cookie 403 behaviour, bearer validation with configurable expiry, `GetCurrentTime` seconds-only, injectable per-endpoint latency, clock skew, error codes (403/429/5xx), and a scenario API (`POST /__scenario`) for tests; seeded from the Task 0 fixtures once they exist (until then from hand-written samples with the same schema).
Owns: `test/fakes/fake-sgw-server/**`.
Deps: T-02 (schemas). Re-seeded by T-24 after fixtures land (T-24 owns `test/fixtures/sgw/**`, not the server).
Tests first: server contract tests: each endpoint response validates against the zod schema in T-02; scenario toggles verified (quote→403, skew applied to serverTime, latency ≥ configured).
Acceptance: `pnpm fake:sgw` starts on 127.0.0.1:8787; documented scenario list in `test/fakes/fake-sgw-server/README.md`. Bidding endpoints are stubs returning `result:-3` until T-88.
Gate: `pnpm test:unit -- test/fakes/fake-sgw-server`.

**T-05 · Fake Google server** (M · E)
Goal: token endpoint (`/token` with PKCE verification, `invalid_grant` scenario, 7-day expiry scenario), `/revoke`, Calendar v3 subset (`calendars.insert`, `calendarList.get`, `events.insert` with 409 on duplicate id, `events.get` returning `status:'cancelled'` after delete, `patch`, `delete`, `list?privateExtendedProperty=`), 429 scenario, scope enforcement for `calendar.app.created`.
Owns: `test/fakes/fake-google-server/**`.
Deps: T-02.
Tests first: PKCE S256 check using RFC 7636 Appendix B vector; 409 on duplicate insert; cancelled status after delete; patch-revive behaviour configurable (`revive: true|false`) so both S-5 outcomes can be tested.
Acceptance: `pnpm fake:google` on 127.0.0.1:8788.
Gate: `pnpm test:unit -- test/fakes/fake-google-server`.

**T-06 · CI workflow, permission snapshot, prod-bundle check** (M · F)
Goal: `.github/workflows/ci.yml` with jobs `static` → `unit` → `contract` → `e2e-chromium` (headless `chromium` channel, fakes started as services) → `e2e-firefox` (geckodriver; allowed to be `continue-on-error` until S-6 lands, then required); `scripts/permissions-snapshot.ts`; `scripts/check-prod-bundle.ts` greps production outputs for `127.0.0.1`, `localhost`, `SBW_TEST`, `__scenario`, `innerHTML`, `eval(` and fails on any hit.
Owns: `.github/workflows/ci.yml`, `scripts/permissions-snapshot.ts`, `scripts/check-prod-bundle.ts`, `test/snapshots/permissions.{chrome,firefox}.json`.
Deps: T-01.
Tests first: a unit test for `check-prod-bundle` using a fixture bundle containing each forbidden token.
Acceptance: CI green on a PR; a deliberate added permission fails `check:permissions` (demonstrated in the PR, then reverted).
Gate: `pnpm check:permissions && pnpm check:prod-bundle` after `pnpm build && pnpm build:firefox`.

**T-07 · S-1 SGW recon (Task 0)** (L · G) — see §4 S-1. Owns: `scripts/capture-fixtures.ts`, `scripts/sanitize-fixtures.ts`, `test/fixtures/sgw/**`, `src/adapters/sgw/config.ts` (v1 fill), `docs/spikes/S-1.md`, `docs/USER-STEPS/S-1.md`. Deps: T-02. Tests first: `sanitize-fixtures` unit test proves titles, seller names, bidder masks, image URLs and ids are replaced deterministically and that no `Authorization`/`Cookie`/`Set-Cookie` survives. Gate: `pnpm test:unit -- scripts && pnpm test:contract` (fixtures validate against schemas; any mismatch is a documented schema fix, not a fixture edit).

**T-08 · S-2 Session spike** (L · H) — §4 S-2. Owns: `docs/spikes/S-2.md`, `docs/USER-STEPS/S-2.md`, `scripts/jwt-claims-only.ts` (decodes a pasted JWT locally and prints claim *names* plus `exp/iat`, never values). Deps: T-07. Gate: spike doc contains the five verdicts and the resulting `SgwSession` contract note.

**T-09 · S-3 Soft-close verdict** (M · G, after T-07) — §4 S-3. Owns: `scripts/softclose-observe.ts`, `docs/spikes/S-3.md`. Deps: T-07. Gate: ≤12 requests logged; verdict table present.

**T-10 · S-4 Google OAuth spike** (L · I) — §4 S-4. Owns: `docs/spikes/S-4.md`, `docs/USER-STEPS/S-4.md`, `scripts/oauth-probe/**` (a throwaway WXT build with only identity + a console log, under `scripts/`, never shipped). Deps: T-01. Gate: decision rule applied and recorded; `GoogleAuthProvider` implementation choice written to `docs/spikes/S-4.md#decision`.

**T-11 · S-5 Event-ID behaviour** (S · I, after T-10) — §4 S-5. Owns: `docs/spikes/S-5.md`, `docs/USER-STEPS/S-5.md`. Deps: T-10. Gate: matrix present; `CalendarSink` recreate strategy recorded.

**T-12 · S-6 Firefox E2E harness** (L · J) — §4 S-6. Owns: `test/e2e/firefox/**`, `test/e2e/firefox/requirements.txt`, CI job body for `e2e-firefox` (edits `ci.yml` only after T-06 merges; sequential dependency). Deps: T-01, T-06. Tests first: a smoke spec asserting the badge Shadow DOM exists on a fake-served page. Gate: `pnpm test:e2e:firefox` green locally and in CI.

**T-13 · S-7 Dry-run timing measurement** (L · K) — §4 S-7. Owns: `scripts/timing-probe/**`, `docs/spikes/S-7.md`. Deps: T-01, T-04. Gate: distributions for both browsers in the doc; Firefox host verdict recorded; `KeepAlive` interval confirmed ≤ 25 s.

**T-14 · S-8 Wake-from-sleep feasibility** (L · L) — §4 S-8. Owns: `docs/spikes/S-8.md`, `docs/USER-STEPS/S-8.md`, `companion/windows/probe/{wake-probe.ps1,README.md}`. Deps: T-01. Gate: five verdicts recorded; `docs/COMPANION.md` power-plan guidance drafted (final in T-110).

### Phase 1 — Overlay

**T-20 · Pacific time module** (M · A)
Goal: `parsePacific`, `parsePacificDetailed`, `formatDual(ms, userTz)` ("7:18 PM PT · 10:18 PM EDT"), `relative(ms, now)`.
Owns: `src/domain/time/pacific.ts`, `test/unit/domain/time/*.test.ts`.
Deps: T-02.
Tests first: table tests for `2026-10-07T19:18:30`, fractional `…:17.45`, DST spring-forward nonexistent `2026-03-08T02:30:00` (→ `nonexistent:true`, resolves to 03:30 PDT), fall-back ambiguous `2026-11-01T01:30:00` (→ `ambiguous:true`, earlier instant), `Date.parse` misuse guarded (a test asserts the module never calls `Date.parse` on raw input, via a lint rule `no-restricted-syntax`). Property test: `format(parse(x)) === x` for 10k generated naive strings outside DST transitions.
Acceptance: uses `Intl.DateTimeFormat` with `America/Los_Angeles` only; zero dependencies.
Gate: `pnpm test:unit -- src/domain/time`.

**T-21 · Money module** (S · A)
Goal: `Cents` parse/format, `nextAcceptable(current, increment)`, `allInToBid(allIn, shipping, handling)`, `exceedsTypo(max, current, multiplier, absolute)`.
Owns: `src/domain/money.ts`, `test/unit/domain/money.test.ts`.
Deps: T-02.
Tests first: property tests: `format(parse(s)) === s` for `/^\d+\.\d{2}$/`; no floating drift over 1e6 additions; `bidAmount` string always two decimals.
Gate: `pnpm test:unit -- src/domain/money`.

**T-22 · Keyword compiler** (M · B)
Goal: `compileKeyword` with modes any/all/none, wholeWord, safe regex (length cap, nested-quantifier rejection, per-test time budget via a pre-check and a 5 ms watchdog pattern), NFKC folding, misspelling-variant hook (stub returning `[term]`, filled in Phase 6).
Owns: `src/domain/rules/keywords.ts`, `test/unit/domain/rules/keywords.test.ts`.
Deps: T-02.
Tests first: "men" does not match "women" with wholeWord; "women" matches `women` and `WOMEN'S`; negative keyword excludes; catastrophic regex `(a+)+$` rejected at compile; unicode "Pÿrex" folds.
Gate: `pnpm test:unit -- src/domain/rules/keywords`.

**T-23 · Rule matcher and preview** (M · B, after T-22)
Goal: `evaluate`, `evaluateBatch`, precedence, `unknownConditions`, `preview(rule, listings)`.
Owns: `src/domain/rules/{matcher,preview}.ts`, `test/unit/domain/rules/matcher.test.ts`.
Deps: T-22, T-20, T-21.
Tests first: table of 30 cases across every `Condition.kind`; hide beats highlight; landedCost unknown → `unknownConditions++` and no match; `endsWithin` uses `ctx.now`; disabled rule ignored; reasons name field and detail.
Gate: `pnpm test:unit -- src/domain/rules`.

**T-24 · SGW schemas and contract tests** (M · C)
Goal: zod schemas for every endpoint in `config.ts`; normalizers to `Listing`/`ItemDetail`/`Favorite`; contract tests over fixtures; re-seed the fake server from fixtures.
Owns: `src/adapters/sgw/schemas.ts`, `src/adapters/sgw/normalize.ts`, `test/contract/sgw/*.test.ts`, `test/fakes/fake-sgw-server/seed/**` (seed data only).
Deps: T-07, T-02, T-20, T-21.
Tests first: every fixture parses; a fixture with a renamed field fails with a `schema` error naming the path; `minimumBid` from search maps to `startingMinimumBid`, from detail to `minimumBid`; `message` HTML is stripped to text.
Gate: `pnpm test:contract -- test/contract/sgw`.

**T-25 · RequestScheduler** (L · D)
Goal: §3.4 lanes, budgets, jitter, cache, backoff, pause/resume, persistence of budget in `sbw:requestBudget`, stats.
Owns: `src/adapters/sgw/request-scheduler.ts`, `test/unit/adapters/sgw/request-scheduler.test.ts`.
Deps: T-02, T-03.
Tests first (fake clock): two background requests are ≥120 s apart; interactive ≥1 s; never two in flight; budget exhaustion throws `budget`; 429 doubles backoff with cap; three 403s pause all lanes 6 h and emit an event; cache hit skips network; considerate `tight` halves budgets; day rollover resets.
Gate: `pnpm test:unit -- src/adapters/sgw/request-scheduler`.

**T-26 · ApiAdapter (reads + gated writes)** (L · D, after T-25)
Goal: `SgwApi` over the scheduler: search (quote stripping, string booleans), itemDetail (cache), shippingQuote (shape per S-1), favorites list, addFavorite/removeFavorite/saveFavoriteNote (gated by `GlobalSwitches`), savedSearches, showBidModal, `serverTimeSample`. `placeBid` throws `paused` always in this phase (live in T-100).
Owns: `src/adapters/sgw/api-adapter.ts`, `test/unit/adapters/sgw/api-adapter.test.ts`, `test/integration/sgw-api.test.ts` (MSW).
Deps: T-24, T-25.
Tests first: request bodies match fixtures byte-for-byte for a known query; `credentials:'omit'` always; bearer attached only to auth endpoints; a write with dry-run on records an audit intent and makes no HTTP call; schema failure → `SgwApiError('schema')` and health flagged.
Gate: `pnpm test:unit -- src/adapters/sgw/api-adapter && pnpm test:integration -- sgw-api`.

**T-27 · DomAdapter** (L · E)
Goal: `SgwDom` over rendered fixtures: ranked selectors (`app-home-product-items` → `a[href^="/item/"]` id regex → `.feat-item_*`), list layout per S-1, idempotent decoration (data attributes, class toggles, stub element), `pageKind`.
Owns: `src/adapters/sgw/dom-adapter.ts`, `src/content/ui/stub.ts`, `test/dom/dom-adapter.test.ts`.
Deps: T-07, T-02.
Tests first (jsdom/happy-dom over fixtures): finds all 40 cards on grid and list; extracts itemIds; a fixture with the primary selector removed still finds cards via fallback and reports `configVersion` drift; applying the same `Decoration` twice yields one stub; simulated SPA re-render (replace container innerHTML in the test only) re-discovers without duplicates; never selects `_ngcontent-*`.
Gate: `pnpm test:dom`.

**T-28 · SessionAdapter** (M · F)
Goal: `SgwSession` with JWT shape validation (three base64url parts, `exp` claim), expiry from `exp`, `expiring` at < 12 h, logged-out detection (401 from any auth call clears), refresh per S-2 verdict (behind `SBW_SESSION_REFRESH` config constant).
Owns: `src/adapters/sgw/session-adapter.ts`, `test/unit/adapters/sgw/session-adapter.test.ts`.
Deps: T-08, T-02.
Tests first: observe stores and never logs the bearer (spy on console and audit); `state()` transitions by fake clock; `clear()` on 401; refresh path tested in both verdict configurations.
Gate: `pnpm test:unit -- src/adapters/sgw/session-adapter`.

**T-29 · ClockAdapter** (M · F)
Goal: `SgwClock`: samples, lowest-RTT offset, confidence levels (≥3 samples and rtt ≤ 400 ms → high), `serverNow`, `serverTime` parsing per S-1 verdict.
Owns: `src/adapters/sgw/clock-adapter.ts`, `test/unit/adapters/sgw/clock-adapter.test.ts`.
Deps: T-20, T-07.
Tests first: offset equals the lowest-RTT sample's `server − (sent + rtt/2)`; a seconds-only sample never outranks an ms sample at equal RTT; samples older than 30 min expire.
Gate: `pnpm test:unit -- src/adapters/sgw/clock-adapter`.

**T-30 · Health check** (M · E, after T-27)
Goal: `SgwHealth.run('anonymous')`: one cached search schema check, one cached detail schema check, card-selector check (from the last content-script report), clock sanity; `run('full')` adds session. Stores `HealthReport`; emits `health.fail` audit.
Owns: `src/adapters/sgw/health.ts`, `test/unit/adapters/sgw/health.test.ts`.
Deps: T-24, T-27, T-29.
Tests first: schema drift → `ok:false` with the failing check named; `writesAllowed` false after failure; passes again after a good report; uses cache (no new requests) when a report < 6 h exists.
Gate: `pnpm test:unit -- src/adapters/sgw/health`.

**T-31 · api-tap (MAIN world)** (M · G)
Goal: `src/content/api-tap.main.ts`: wraps `XMLHttpRequest.prototype.{open,setRequestHeader,send}` and `window.fetch` to observe buyerapi requests only; relays `{nonce, kind, url, status, body}` via `window.postMessage` to the isolated script, with a per-page nonce exchanged through a `data-sbw-nonce` attribute the isolated script sets before the tap runs (WXT `runAt: 'document_start'`, `world: 'MAIN'`). Observes the `Authorization` header (S-2) and relays it once per change. Never alters anything; passes through all errors.
Owns: `src/content/api-tap.main.ts`, `entrypoints/api-tap.content.ts`, `test/dom/api-tap.test.ts`.
Deps: T-08 verdict, T-02.
Tests first (jsdom with mocked XHR/fetch): a buyerapi ItemListing response is relayed with the nonce; non-buyerapi traffic is not; a message without the nonce is ignored by the receiver; wrapping preserves return values and exceptions; wrapping twice is a no-op.
Gate: `pnpm test:dom -- api-tap`.

**T-32 · Content overlay (ISOLATED)** (L · G, after T-31)
Goal: `src/content/sgw-overlay.ts` + Preact Shadow DOM UI (`createShadowRootUi`): receives tap listings, sends `page.listings`/`page.token`, requests `rules.evaluate`, applies decorations through `SgwDom`, renders stubs with rule name, the "N hidden · show" bar, Why? popover, undo (local re-show + optional "disable rule"), quick actions (hide seller, hide keyword, favorite if enabled, track), dual-time badge; reacts to `wxt:locationchange` and a debounced `MutationObserver`; shows the "SGW layout changed, filters paused" banner when zero cards parse on a `search` page.
Owns: `src/content/sgw-overlay.ts`, `src/content/ui/**` (except `stub.ts`), `entrypoints/sgw.content.ts` (replaces T-01 placeholder — T-01 is complete before this starts).
Deps: T-27, T-31, T-35.
Tests first (dom tests against fixtures with a fake messaging client): idempotent under three re-renders; hidden count matches; Why? text equals `MatchReason.detail`; no `innerHTML` (lint); keyboard: stubs and bar operable with Tab/Enter; a `text/html` title with `<script>` renders as text.
Gate: `pnpm test:dom -- overlay`.

**T-33 · Storage repo and migrations** (M · H)
Goal: typed `Repo` over `StorageAreas` with zod validation, quarantine, `migrate()`, chunked audit storage helpers.
Owns: `src/domain/storage/{repo,migrations}.ts`, `test/unit/domain/storage/*.test.ts`.
Deps: T-02, T-03.
Tests first: invalid record is quarantined and defaults returned; migration framework runs 0→1 on empty storage and is idempotent; a crash flag triggers re-run; audit ring wraps at 20 chunks.
Gate: `pnpm test:unit -- src/domain/storage`.

**T-34 · Browser port adapters** (M · I)
Goal: `src/adapters/browser/*`: `Clock` (Date/performance/setTimeout), `Http` (fetch with AbortController timeout, header capture, timing), `StorageAreas`, `Alarms` (floor clamp; `persistAcrossSessions` feature-detected), `Notifier` (Firefox basic-only), `Permissions`, `KeepAwake` (Chrome `power`, no-op elsewhere), `KeepAlive` (`runtime.getPlatformInfo` ticker).
Owns: `src/adapters/browser/**`, `test/integration/browser-ports.test.ts` (fakeBrowser).
Deps: T-02.
Tests first: alarms created with 0.1 min become 0.5; `persistAcrossSessions` present only when `browser.alarms.create` schema supports it (simulated); `Http` throws `HttpTimeoutError` after `timeoutMs`; `Notifier.supportsActions` false under `import.meta.env.FIREFOX`.
Gate: `pnpm test:integration -- browser-ports`.

**T-35 · Messaging router and client** (M · J)
Goal: `src/messaging/client.ts` (typed `send`, port helpers) and `src/background/router.ts` (sender validation per §2.4, zod parse, handler registry, error envelope).
Owns: `src/messaging/client.ts`, `src/background/router.ts`, `test/unit/background/router.test.ts`.
Deps: T-02.
Tests first: wrong `sender.id` dropped; `snipe.arm` from a tab sender rejected; `quick.favorite` rejected when setting off; malformed payload → error envelope, handler not called; `rules.evaluate` from a `https://shopgoodwill.com/...` tab accepted; from `https://evil.example` rejected.
Gate: `pnpm test:unit -- src/background/router`.

**T-36 · Background composition root and GlobalSwitches** (M · J, after T-35)
Goal: `src/background/main.ts` wiring all adapters, `migrate()`, `GlobalSwitches`, health gating, `rules.*`/`settings.*`/`page.*`/`quick.*`/`kill.set`/`health.get` handlers, `switches.changed` broadcast, kill-switch `commands` listener.
Owns: `src/background/main.ts`, `src/background/switches.ts`, `src/background/handlers/{rules,settings,page,quick,health}.ts`, `entrypoints/background.ts` (replaces T-01 placeholder), `test/integration/background-main.test.ts`.
Deps: T-26, T-28, T-29, T-30, T-33, T-34, T-35, T-23, T-41.
Tests first (fakeBrowser): startup runs migrate then registers listeners; `page.token` reaches `SessionAdapter.observe`; `kill.set` flips `writesAllowed` for all features and audits; `quick.hideSeller` creates a rule and broadcasts `rules.changed`.
Gate: `pnpm test:integration -- background-main`.

**T-37 · Options page: rule editor, settings** (L · K)
Goal: Preact options app: rule list, editor for every `Condition.kind` with plain-English summary, live preview ("matches 7 of 40 on this page" using the last `page.listings` of the active SGW tab, via `rules.preview`), settings (home ZIP, run time, overlay style, dry-run switches, considerate mode, feature switches), accessibility (labels, focus order, no color-only cues).
Owns: `src/entrypoints/options/**`, `src/ui/{time,money,components}/**`, `test/dom/options.test.ts`.
Deps: T-02, T-35.
Tests first (Preact testing library + fake messaging): saving a rule sends `rules.save` with a schema-valid payload; regex validation error shown; preview count renders from reply; dry-run toggles persist via `settings.set`.
Gate: `pnpm test:dom -- options`.

**T-38 · Popup** (S · L)
Goal: status (session ok/expiring/logged-out, health, dry-run badges), kill switch, overlay on/off, "Open dashboard", "Open options".
Owns: `src/entrypoints/popup/**`, `test/dom/popup.test.ts`.
Deps: T-35.
Tests first: kill toggle sends `kill.set`; badge text reflects `switches.changed`.
Gate: `pnpm test:dom -- popup`.

**T-41 · Audit log (domain + storage)** (M · H, after T-33)
Goal: `AuditLog` over chunked storage; redaction (`bearer`, `token`, `refresh`, `password` keys dropped; strings > 2 kB truncated; HTML tags stripped); export.
Owns: `src/domain/audit/log.ts`, `test/unit/domain/audit/log.test.ts`.
Deps: T-33.
Tests first: entries get monotonically increasing `seq`; a details object containing `bearer` is redacted; ring eviction keeps the newest 10,000; export is valid JSON.
Gate: `pnpm test:unit -- src/domain/audit`.

**T-39 · Chromium E2E: overlay** (L · M)
Goal: Playwright (`launchPersistentContext`, `channel:'chromium'`, headless) loads the **test build** (`SBW_TEST=1`, base URL override to the fake servers, localhost host permission) and runs: rules created in options → fake SGW search page (served by the fake server on `127.0.0.1:8789` with hostname override `sgw.test` via Playwright `route`) → highlights, stubs, hidden bar, Why?, undo, SPA page change → still correct, kill switch → decorations cleared.
Owns: `test/e2e/chromium/{fixtures.ts,overlay.spec.ts}`, `playwright.config.ts` (T-01 created it; T-39 is the first and only Phase 1 editor), `scripts/serve-fake-site.ts` (serves sanitized HTML fixtures with the real Angular replaced by a minimal script that performs the same XHR to the fake buyerapi, so the tap path is exercised).
Deps: T-32, T-36, T-37, T-38, T-04.
Tests first: the spec itself; a CI job proves the test build contains `127.0.0.1` and the prod build does not.
Gate: `pnpm test:e2e:chromium -- overlay`.

**T-40 · Firefox smoke: overlay** (M · N)
Goal: extend the S-6 harness to assert highlights and stubs on the fake site.
Owns: `test/e2e/firefox/overlay_test.py`.
Deps: T-12, T-32, T-36.
Gate: `pnpm test:e2e:firefox`.

### Phase 2 — Watches, daily job, favorites, dashboard

**T-50 · Watch schema and search-URL mapping** (M · A)
Goal: `searchQueryFromUrl` / `searchQueryToUrl` (param map per S-1: `st, c, s, lp, hp, spo, snpo, socs, sd, sca, col, p, ps, desc, layout`), `Watch` helpers (`nextRunAtFor(settings, now, tz)`, `seen` ring).
Owns: `src/domain/watches/query-url.ts`, `src/domain/watches/helpers.ts`, `test/unit/domain/watches/*.test.ts`.
Deps: T-02, T-07.
Tests first: round-trip of the observed URL from S-1; unknown params preserved in `extra`; quotes stripped; `nextRunAtFor("07:00", America/New_York)` across DST yields the correct UTC instants.
Gate: `pnpm test:unit -- src/domain/watches`.

**T-51 · DailyJob state machine** (L · A, after T-50)
Goal: §3.6 `plan/next/apply`: per watch `maxPages` search steps, de-dup by `seenItemIds`, rule evaluation (via injected `evaluateBatch`), new matches → `detail` steps (only when favoriting or calendar needs the detail value) → `favorite` steps per `favoriteMode` (`sgw-late` schedules a deferred step with `notBefore`), `calendarUpsert` steps when `watch.calendar`, `notifyDigest` last; errors recorded, run never aborts on one failed step; `paused` when scheduler pauses.
Owns: `src/domain/jobs/daily-job.ts`, `test/unit/domain/jobs/daily-job.test.ts`.
Deps: T-50, T-23.
Tests first: a plan for 3 watches × 2 pages yields 6 search steps then 1 favoritesList; a search outcome with 2 new matches appends 2 detail steps; `local` mode never adds a favorite step; `sgw-late` adds a step with `notBefore = end − N h`; applying an outcome to a finished run is a no-op; property: `cursor` never exceeds `steps.length`.
Gate: `pnpm test:unit -- src/domain/jobs`.

**T-52 · Scheduler, reconcile and runner wiring** (L · B)
Goal: `src/background/jobs/scheduler.ts` (`sbw:tick` alarm, `reconcile()` on start/onStartup/onInstalled/tick, due-watch detection with catch-up), `daily-job-runner.ts` (loads the active `JobRun`, executes exactly one step per tick through `SgwApi` lane `background`, or drains at lane `interactive` on `job.runNow`), permission check `permissions.contains` before each run, `job.*`/`watches.*`/`tracked.*` handlers, `sbw:job-progress` port.
Owns: `src/background/jobs/{scheduler,daily-job-runner}.ts`, `src/background/handlers/{job,watches,tracked}.ts`, `test/integration/daily-job-runner.test.ts`.
Deps: T-51, T-36, T-34.
Tests first (fakeBrowser + FakeAlarms + FakeHttp): a watch due 3 days ago runs once (catch-up), not three times; browser restart mid-run resumes at `cursor`; each tick issues at most one SGW request; `runNow` completes a 10-step run in < 15 s fake time; revoked host permission → run skipped, notification, audit.
Gate: `pnpm test:integration -- daily-job-runner`.

**T-53 · Favorites reconciler** (M · C)
Goal: §3.7 `desired()`, favorite job step execution (`addFavorite` gated by dry-run and health), `favorites.sync` handler (one list read, lane interactive), `TrackedItem.favoriteState` updates, undo refs.
Owns: `src/domain/favorites/reconcile.ts`, `src/background/handlers/favorites.ts`, `test/unit/domain/favorites/*.test.ts`.
Deps: T-26, T-51 (interface only), T-41.
Tests first: already-favorited (cache) → `none`; `failed` retries once per run; dry-run → audit entry `favorite.add {dryRun:true}` and no call; undo entry references `removeFavorite`.
Gate: `pnpm test:unit -- src/domain/favorites`.

**T-54 · Dashboard (side panel / sidebar)** (L · D)
Goal: one Preact app at `src/entrypoints/sidepanel/` (Chrome) and `src/entrypoints/sidebar/` (Firefox) sharing `src/ui/dashboard/**`: Watches (last run, next run, new matches, Run now), Matches and Favorites, Calendar sync status (placeholder until Phase 3), Health (session, Google, drift, budget), Activity log with undo; dual time everywhere; keyboard-operable.
Owns: `src/entrypoints/sidepanel/**`, `src/entrypoints/sidebar/**`, `src/ui/dashboard/**`, `test/dom/dashboard.test.ts`.
Deps: T-35, T-52 (message types only).
Tests first: renders a `JobRun` progress from the port; Run now sends `job.runNow`; undo sends `audit.undo` and disables the button once `done`.
Gate: `pnpm test:dom -- dashboard`.

**T-55 · Watches editor and SGW saved-search import** (M · E)
Goal: options section: create a watch from the current SGW tab URL (`searchQueryFromUrl`), choose rules, `favoriteMode` with the explanatory copy about the favoriting anecdote, calendar toggle, pages; import SGW saved searches (`savedSearches`, lane interactive, user-triggered).
Owns: `src/entrypoints/options/watches/**`, `test/dom/options-watches.test.ts`.
Deps: T-37, T-50.
Tests first: the form produces a schema-valid `Watch`; import maps saved searches to watches without duplicates by `query` hash.
Gate: `pnpm test:dom -- options-watches`.

**T-56 · Notifications, digest, quiet hours** (M · F)
Goal: `src/background/jobs/notify.ts`: per-run digest ("3 new matches in Pyrex"), immediate late-add alert (< 60 min to end), quiet hours deferral, Firefox basic-only variant with click-to-open-dashboard; `notifications` optional permission request from options (gesture).
Owns: `src/background/jobs/notify.ts`, `src/background/handlers/permissions.ts`, `test/unit/background/notify.test.ts`.
Deps: T-34, T-36.
Tests first: during quiet hours a digest is deferred to the end of quiet hours; late-add bypasses quiet hours; no notification when permission absent (audit only).
Gate: `pnpm test:unit -- src/background/notify`.

**T-57 · Landed cost** (M · G)
Goal: `landedCost.get` handler: shipping quote via `SgwApi.shippingQuote` (lane interactive, cache 24 h, max 40 per page view, only when `features.landedCost`), badge in overlay (reads `landedCost.get` lazily for visible cards via `IntersectionObserver`), `landedCost` rule condition wiring in the job (quotes only for items that passed all other conditions).
Owns: `src/background/handlers/landed-cost.ts`, `src/content/ui/landed-cost-badge.tsx`, `test/unit/background/landed-cost.test.ts`.
Deps: T-26, T-32, T-23.
Tests first: 41st request on a page is refused with `budget`; cached quote not re-fetched; feature switch off → `null` for all; pickup-only items return `shipping:0` with a `pickup` flag.
Gate: `pnpm test:unit -- src/background/landed-cost`.

**T-58 · Audit undo and activity UI** (M · C, after T-53)
Goal: `audit.undo` handler for `unfavorite`, `disableRule`, `deleteEvent` (Phase 3 fills), `disarm`; activity list component used by dashboard and options.
Owns: `src/background/handlers/audit.ts`, `src/ui/activity/**`, `test/unit/background/audit-undo.test.ts`.
Deps: T-41, T-53.
Tests first: undo of a dry-run entry is refused; undo marks `done` and appends an `undo` audit entry; double undo is a no-op.
Gate: `pnpm test:unit -- src/background/audit-undo`.

**T-59 · Chromium E2E: daily job** (L · H)
Goal: specs: create watch → trigger `sbw:tick` via test hook → one request per tick observed on the fake server with ≥120 s fake spacing (fake server records timestamps; the test build exposes a `sbw:test:advance` hook that fast-forwards the Clock port and fires alarms); browser context restart mid-run → resume; catch-up after a 3-day gap; dry-run favoriting produces audit entries and zero `AddToFavorite` calls; live favoriting (against the fake) produces exactly one call per item.
Owns: `test/e2e/chromium/daily-job.spec.ts`, `src/test-hooks/**` (compiled only when `SBW_TEST`), `test/e2e/chromium/helpers/time.ts`.
Deps: T-52, T-53, T-39.
Gate: `pnpm test:e2e:chromium -- daily-job && pnpm check:prod-bundle`.

**T-60 · Live canary workflow** (M · I)
Goal: `scripts/canary.ts` (anonymous: one `ItemListing`, one `ItemDetail` of a result, one rendered search page via Playwright; validates schemas and selectors; 120 s between requests; budget 4/day) and `.github/workflows/canary.yml` (nightly, `workflow_dispatch`, opens/updates a GitHub issue "SGW drift detected" on failure, never on success).
Owns: `scripts/canary.ts`, `.github/workflows/canary.yml`, `test/unit/scripts/canary.test.ts` (against the fake server).
Deps: T-24, T-27.
Tests first: canary passes on fixtures; fails and reports the path on a renamed field; refuses to run twice within 12 h (lock file in the workflow cache).
Gate: `pnpm test:unit -- scripts/canary`.

**T-61 · Firefox smoke: daily job** (S · J)
Goal: run one tick and assert an audit entry via the test page.
Owns: `test/e2e/firefox/daily_job_test.py`. Deps: T-12, T-52. Gate: `pnpm test:e2e:firefox`.

### Phase 3 — Google Calendar, onboarding, release

**T-62 · PkceRefreshProvider** (L · A)
Goal: `GoogleAuthProvider` via `identity.launchWebAuthFlow`: S256 PKCE, `access_type=offline`, `prompt=consent`, state check, redirect per browser (chromiumapp.org vs loopback), token exchange with optional secret (per S-4), refresh with `interactive:false`, `invalid_grant` → status `needsInteraction` + badge, revoke on disconnect, scope check, tokens in `storage.session` (access) and `storage.local` (refresh).
Owns: `src/adapters/google/auth-pkce.ts`, `src/adapters/google/pkce.ts`, `test/unit/adapters/google/auth-pkce.test.ts`, `test/integration/google-auth.test.ts` (MSW).
Deps: T-10, T-02, T-34.
Tests first: RFC 7636 Appendix B vector; `state` mismatch rejected; `interactive:false` never calls `launchWebAuthFlow`; `invalid_grant` clears nothing but sets status; 401 → one refresh then surface; revoke endpoint called on disconnect then storage cleared; error taxonomy mapping table for 400/401/403/429/network.
Gate: `pnpm test:unit -- src/adapters/google/auth-pkce && pnpm test:integration -- google-auth`.

**T-63 · ChromeIdentityProvider** (M · A, after T-62; **only if S-4 decision selects it**)
Goal: `getAuthToken({interactive})`, 401 → `removeCachedAuthToken` + retry once, `clearAllCachedAuthTokens` on disconnect, manifest `oauth2` block injected from env at build.
Owns: `src/adapters/google/auth-chrome-identity.ts`, `test/unit/adapters/google/auth-chrome-identity.test.ts`, `wxt.config.ts` oauth2 section (coordinate: T-01 complete).
Deps: T-62 (shared types), T-10.
Gate: `pnpm test:unit -- src/adapters/google/auth-chrome-identity`.

**T-64 · CalendarApi adapter and schemas** (M · B)
Goal: §3.8 `CalendarApi` with zod on every response, `CalendarApiError` mapping (409 conflict, 404/410 not-found, 401 auth, 403 insufficient scope vs rate limit by `reason`, 429), exponential backoff on 429/5xx, offline detection.
Owns: `src/adapters/google/{calendar-api,schemas}.ts`, `test/unit/adapters/google/calendar-api.test.ts`, `test/contract/google/*.test.ts`.
Deps: T-02, T-05.
Tests first: each fake-server response validates; 409 → `conflict`; `forbidden/insufficientPermissions` → `insufficient-scope`; `rateLimitExceeded` → `rate-limited` with backoff.
Gate: `pnpm test:unit -- src/adapters/google/calendar-api && pnpm test:contract -- test/contract/google`.

**T-65 · Event builder and event id** (S · C)
Goal: `eventIdFor` (`/^[a-v0-9]{5,1024}$/`), `buildDesiredEvent(tracked, listing/detail, settings)` with RFC 3339 UTC `dateTime` + `timeZone: 'UTC'`, ≤5 reminders, description with dual time and link, title ≤ 200 chars, `hash(desired)` for change detection.
Owns: `src/domain/calendar/{event-id,event-builder}.ts`, `test/unit/domain/calendar/event-*.test.ts`.
Deps: T-02, T-20.
Tests first: id regex property test over 10k ids; 6 reminders rejected; start equals auction end; hash changes only when content changes.
Gate: `pnpm test:unit -- src/domain/calendar/event`.

**T-66 · Calendar reconciler (domain)** (M · C, after T-65)
Goal: pure `reconcile(desired[], links[], now)` → ops `insert | patch | delete | noop | recreate`, handling: end-time change → patch; item no longer desired → delete; link `error` → retry with backoff count; outcome stamping ops; late-add flag (`startUtc − now < 60 min`).
Owns: `src/domain/calendar/reconciler.ts`, `test/unit/domain/calendar/reconciler.test.ts`.
Deps: T-65.
Tests first: 25-case table; idempotent (running twice yields noops); a cancelled-link recreate bumps generation only when strategy = `bump-generation` (per S-5).
Gate: `pnpm test:unit -- src/domain/calendar/reconciler`.

**T-67 · CalendarSink and sync job** (L · D)
Goal: `CalendarSink` over `CalendarApi` + `GoogleAuthProvider` (ensureCalendar, upsert with 409 path per S-5, remove, stamp), `src/background/jobs/calendar-sync.ts` (runs after each job run and on `calendar.syncNow`, on `tracked` changes debounced 60 s, uses lane-less Google calls with their own 1 r/s limiter), queueing when disconnected (`links.status='pending'`), `deleteEvent` undo, `calendar.*` handlers, late-add → immediate local notification.
Owns: `src/adapters/google/calendar-sink.ts`, `src/background/jobs/calendar-sync.ts`, `src/background/handlers/calendar.ts`, `test/integration/calendar-sync.test.ts`.
Deps: T-62, T-64, T-66, T-36, T-56.
Tests first (fake Google server): first sync creates the calendar once; an end-time change patches; unwatch deletes; 409 on insert → get → revive or bump; disconnected → pending links, no calls, badge; `invalid_grant` → notification once per day, not per item; dry-run calendar → audit only.
Gate: `pnpm test:integration -- calendar-sync`.

**T-68 · .ics and Add-to-Calendar fallback** (S · E)
Goal: `buildIcs(desired[])` with three `VALARM`s, `calendar.ics` handler, download button in dashboard, Google "Add to calendar" template link per item.
Owns: `src/domain/calendar/ics.ts`, `src/ui/calendar-fallback/**`, `test/unit/domain/calendar/ics.test.ts`.
Deps: T-65.
Tests first: output parses with a minimal ICS parser in the test; `DTSTART` in UTC with `Z`; three `TRIGGER:-PT60M/-PT15M/-PT5M`; text escaping of commas/semicolons/newlines.
Gate: `pnpm test:unit -- src/domain/calendar/ics`.

**T-69 · ntfy sink (opt-in)** (M · F)
Goal: `src/adapters/ntfy/ntfy-sink.ts`: scheduled messages via `X-Delay` (≤3 days; later ones scheduled by the daily job), update/cancel by sequence id, unguessable topic generator (128-bit), optional host permission request from options, Firefox data-collection declaration note.
Owns: `src/adapters/ntfy/**`, `src/entrypoints/options/ntfy/**`, `test/unit/adapters/ntfy/*.test.ts`.
Deps: T-34, T-37.
Tests first (MSW): message for an auction 5 days out is not sent now and is marked `deferred`; cancel sends DELETE with the stored seq; disabled → no network.
Gate: `pnpm test:unit -- src/adapters/ntfy`.

**T-70 · Options: Google connect and health panel** (M · E, after T-68)
Goal: paste client id (+ secret), Connect (gesture → `calendar.connect`), status (account, scopes, refresh-token age, last error with fix hint), Disconnect (revokes), calendar mode (dedicated/primary → scope choice), reminders editor (≤5), health panel (session, Google, drift, budget usage, considerate mode).
Owns: `src/entrypoints/options/google/**`, `src/entrypoints/options/health/**`, `test/dom/options-google.test.ts`.
Deps: T-37, T-62.
Tests first: Connect disabled until client id present; `needsInteraction` renders the reconnect CTA; disconnect confirms before revoking.
Gate: `pnpm test:dom -- options-google`.

**T-71 · Onboarding** (M · G)
Goal: `src/entrypoints/onboarding/`: five steps (detect SGW login via `SgwSession.state`, home ZIP, connect Google or skip with .ics note, create first watch from current search or template, dry-run it now), ToS/risk disclosure copy, notification permission request, < 3 minutes.
Owns: `src/entrypoints/onboarding/**`, `test/dom/onboarding.test.ts`.
Deps: T-70, T-55, T-56.
Tests first: skip path leaves calendar disabled and `icsFallback` on; completing creates one watch and triggers `job.runNow` with dry-run on.
Gate: `pnpm test:dom -- onboarding`.

**T-72 · Chromium E2E: calendar** (L · H)
Goal: with the test-only `GoogleAuthProvider` stub (`src/test-hooks/google-auth-stub.ts`, compiled only in test builds) pointed at the fake Google server: connect → sync → events with 60/15/5 → end-time change → patch → unwatch → delete → `invalid_grant` scenario → badge and pending links → reconnect → drain.
Owns: `test/e2e/chromium/calendar.spec.ts`, `src/test-hooks/google-auth-stub.ts`.
Deps: T-67, T-59.
Gate: `pnpm test:e2e:chromium -- calendar && pnpm check:prod-bundle`.

**T-73 · Setup guides** (M · I)
Goal: `docs/SETUP-GOOGLE.md` (§10 outline expanded with screenshots-as-text), `docs/SETUP-CHROME.md`, `docs/SETUP-FIREFOX.md`, `docs/ACCEPTANCE.md` (A-1…A-6 checklists from §7.6), `docs/CONSIDERATE-USE.md` (§9).
Owns: those files. Deps: T-10, T-62. Gate: a second worker follows SETUP-GOOGLE against the fake server build and reports no missing step (review checklist pasted).

**T-74 · Release pipeline** (M · J)
Goal: `.github/workflows/release.yml` on tag: build both, `web-ext lint --warnings-as-errors --self-hosted`, zip Chrome, `web-ext sign --channel unlisted --upload-source-code` (AMO keys as repo secrets, run only if present), attach artifacts and SHA256 to a GitHub release; `scripts/release.ts` version bump; `CHANGELOG.md`.
Owns: `.github/workflows/release.yml`, `scripts/release.ts`, `CHANGELOG.md`.
Deps: T-06.
Gate: a `v0.0.1-rc` tag on a branch produces artifacts (dry run without AMO secrets).

### Phase 4 — Snipe engine, dry-run

**T-80 · Snipe state machine** (L · A)
Goal: §3.9 `reduce` with every transition, effects list, `history`, caps integration, `ASSUME_EXTENSION_MS` per S-3, dry-run branch (identical path, `placeBid` effect replaced by `audit` + measured timing).
Owns: `src/domain/snipe/state-machine.ts`, `test/unit/domain/snipe/state-machine.test.ts`.
Deps: T-02, T-82.
Tests first: exhaustive transition table (state × event → next or rejected); `sent` is terminal for sending (a second `fire` is rejected); `ambiguous` → `post-read` → resolves `won|outbid|network` by rules in §3.9; `verify-failed:extended` → `extended` outcome and re-arm proposal effect; `disarm` from any pre-`sent` state → `killed`; property: no path produces two `placeBid` effects.
Gate: `pnpm test:unit -- src/domain/snipe/state-machine`.

**T-81 · Timing** (M · B)
Goal: `computeFireAt`, sampling policy (3 samples at wake, 20 s apart, lowest RTT), latency bounds (abort if rtt > 2 s or confidence `none`), `clockSanity(offset)` (abort if |offset| > 5 min).
Owns: `src/domain/snipe/timing.ts`, `test/unit/domain/snipe/timing.test.ts`.
Deps: T-29.
Tests first: `fireAt = end − lead − rtt/2`; skew +1.3 s produces fire 1.3 s later on the local clock; property: fireAt < end − lead always.
Gate: `pnpm test:unit -- src/domain/snipe/timing`.

**T-82 · Caps, typo guard, exposure** (M · B)
Goal: `checkCaps`, `exposure(snipes)` (sum of armed maxes + estimated shipping/handling), `exceedsTypo`, per-day spent accumulation from outcomes.
Owns: `src/domain/snipe/caps.ts`, `test/unit/domain/snipe/caps.test.ts`.
Deps: T-21.
Tests first: exposure counts every armed snipe as a potential win; per-item cap uses `detail.minimumBid` not search `minimumBid`; typo guard at 3× current or absolute threshold; property: `checkCaps` is monotone in `maxBid`.
Gate: `pnpm test:unit -- src/domain/snipe/caps`.

**T-83 · Preflight, fallback policy, awake history** (M · C)
Goal: `preflight(snipe, ctx)` at T−15 min (session, token, clock, keep-awake held, price < max, caps), `fallbackDecision` applied automatically on failure, `awake-history.ts` (heartbeat every 5 min via the tick; `likelihoodAwakeAt(hour)` over 14 days), arm-time advice ("your browser was running at 7:42 PM on 3 of the last 14 days").
Owns: `src/domain/snipe/{preflight,awake-history}.ts`, `src/background/jobs/heartbeat.ts`, `test/unit/domain/snipe/preflight.test.ts`.
Deps: T-82, T-28, T-29.
Tests first: preflight failure with `fallback:'early-proxy'` produces `applyFallbackProxy` effect (dry-run: audit only); `skip` produces `skipped`; likelihood computed from heartbeat gaps; no heartbeat in the hour → 0.
Gate: `pnpm test:unit -- src/domain/snipe`.

**T-84 · Snipe runner (background)** (L · D)
Goal: `src/background/jobs/snipe-runner.ts`: per-snipe alarms (`:health24`, `:health1`, `:preflight`, `:wake`), `KeepAlive`, `KeepAwake` hold from arm (if T1 enabled) to end, `SnipeHost.acquire`, effect executor (readDetail via lane `snipe`, sampleClock, tight timer, placeBid (dry-run: `audit` + a harmless `itemDetail` read at fire time to measure real latency), post-read, notify, stamp), restart recovery (reads `attempt` from storage; re-schedules alarms on `reconcile()`), auto-kill on anomalies (auth, clock, latency, repeated errors, schema drift) → `disarm(anomaly)` + fallback.
Owns: `src/background/jobs/snipe-runner.ts`, `src/background/handlers/snipe.ts`, `src/adapters/browser/snipe-host.ts`, `test/integration/snipe-runner.test.ts`.
Deps: T-80, T-81, T-83, T-36, T-34.
Tests first (fakeBrowser, FakeAlarms with +45 s delay, FakeClock): wake alarm delayed 45 s still fires on time (margin is 5 min); worker restart between `wake` and `fire` resumes and fires once; restart after `sent` never sends again; `KeepAlive` tick count ≥ 1 per 25 s during the window; health failure during the window → killed + fallback; kill switch mid-window → no bid.
Gate: `pnpm test:integration -- snipe-runner`.

**T-85 · Arming UI** (L · E)
Goal: dashboard Snipes section: prepare (`snipe.prepare` → detail, next acceptable bid, est. all-in), arm form (max or all-in max, lead, fallback, dry-run badge, typed confirmation when typo guard trips, dual time, exposure meter after arming), countdown via port, disarm, outcome list; item-page and card "Snipe…" deep link that opens the dashboard prefilled (no arming from content).
Owns: `src/ui/dashboard/snipes/**`, `src/content/ui/snipe-link.tsx`, `test/dom/dashboard-snipes.test.ts`.
Deps: T-54, T-84 (types).
Tests first: cannot submit above per-item cap; typo guard requires retyped amount equal to max; confirmation shows both times; dry-run state visibly labelled.
Gate: `pnpm test:dom -- dashboard-snipes`.

**T-86 · Kill switch command, badge, auto-kill wiring** (S · F)
Goal: `commands` shortcut (`Ctrl+Shift+K` default) → `kill.set true`; action badge shows armed count or `KILL`; `switches.changed` broadcast; auto-kill reasons surfaced in popup.
Owns: `src/background/handlers/kill.ts`, `src/background/badge.ts`, `test/integration/kill.test.ts`.
Deps: T-36, T-84.
Tests first: command disarms all snipes within one tick and audits each; badge text updates; killed snipes cannot be re-armed without an explicit user action.
Gate: `pnpm test:integration -- kill`.

**T-87 · Outcome classifier and report** (M · C, after T-83)
Goal: `classifyOutcome(snipe, bidResult|null, postDetail)` → `SnipeOutcome` + detail (margin lost by, final price, measured timing), notification copy, calendar stamp request, post-auction report entry.
Owns: `src/domain/snipe/outcome.ts`, `test/unit/domain/snipe/outcome.test.ts`.
Deps: T-80.
Tests first: table for every outcome; `late` when fire occurred after `endTime`; `extended` when post-read `endTime` > armed `endTime`.
Gate: `pnpm test:unit -- src/domain/snipe/outcome`.

**T-88 · Fake SGW server: bidding and timing scenarios** (M · G)
Goal: `ShowBidModal`, `PlaceBid` (proxy semantics: hidden maxes, increments, `result` codes from the Phase 5 catalogue or placeholders `-3` closed, `-4/-5` too low ⚠, `-110` auth ⚠), `Bid` cookie 403, soft-close extension scenario, stalled-response scenario (≥ 25 s), token-expiry mid-window, high-bidder flag in detail.
Owns: `test/fakes/fake-sgw-server/bidding/**`. Deps: T-04. Tests first: proxy resolution table; a bid after close returns `-3`. Gate: `pnpm test:unit -- test/fakes/fake-sgw-server`.

**T-89 · Chromium E2E: snipe scenarios (dry-run)** (L · H)
Goal: packed test build (so alarm floors apply), fake server with 150 ms latency and +1.3 s skew: on-time dry-run fire (measured error logged); restart mid-wake; stalled fetch → ambiguous → post-read; extended end → `extended`; ended early → `ended`; kill mid-window; preflight failure → fallback audit; Firefox host per S-7.
Owns: `test/e2e/chromium/snipe.spec.ts`, `test/e2e/firefox/snipe_test.py`.
Deps: T-84, T-85, T-88, T-72.
Gate: `pnpm test:e2e:chromium -- snipe && pnpm test:e2e:firefox`.

**T-90 · Dry-run soak tooling and timing diagnostics** (M · I)
Goal: dashboard "Timing" page: per-snipe measured offset/RTT/fire error/alarm delay, awake-history chart (text-based), soak summary (fires attempted, on-time %, p50/p95/p99 latency), export JSON; the rule that sets `defaultLeadMs` from the soak; `completedDryRuns` counter.
Owns: `src/ui/dashboard/timing/**`, `src/domain/snipe/soak.ts`, `test/unit/domain/snipe/soak.test.ts`.
Deps: T-84, T-54.
Tests first: p99 computed correctly; lead rule clamps to [6 s, 15 s]; on-time = |error| ≤ 1 s.
Gate: `pnpm test:unit -- src/domain/snipe/soak`.

**T-91 · Auth-health checks and T1 settings** (M · F, after T-86)
Goal: `src/background/jobs/auth-health.ts` (24 h and 1 h before any armed snipe: session state, Google state, health report, keep-awake availability; notification with fix action while the user is likely awake), snipe settings UI (enable, tier, `background`/`power` permission requests from gesture, OS power guidance link, caps, lead, fallback default).
Owns: `src/background/jobs/auth-health.ts`, `src/entrypoints/options/snipe/**`, `test/unit/background/auth-health.test.ts`.
Deps: T-84, T-37.
Tests first: a session expiring in 20 h triggers the 24 h warning; permissions requested only from the options click handler; Firefox hides T1 controls.
Gate: `pnpm test:unit -- src/background/auth-health`.

### Phase 5 — Live bidding with caps

**T-100 · PlaceBid live adapter and response catalogue** (M · A)
Goal: `SgwApi.placeBid` live path: `showBidModal` → `placeBid` with `bidAmount` two-decimal string, `credentials:'omit'`, 20 s timeout, zod schema of `{status, result, message}` from the USER STEP catalogue (one cheap item the user wants; the user bids through the site with DevTools open and exports the response; a second deliberate too-low bid attempt through the site's own UI if the site allows the user to see the rejection), `messageText` stripping, result-code map with `unknown` default.
Owns: `src/adapters/sgw/bid.ts` (imported by `api-adapter.ts`, which T-26 wrote with a seam `bidImpl`), `test/contract/sgw/bid.test.ts`, `docs/USER-STEPS/P5-catalogue.md`, `test/fixtures/sgw/json/placebid-*.json`.
Deps: T-26, T-88.
Tests first: every catalogue fixture maps to a `BidResultKind`; unknown code → `rejected-unknown` and never `accepted`.
Gate: `pnpm test:contract -- test/contract/sgw/bid`.

**T-101 · Idempotent send and ambiguous resolution** (M · A, after T-100)
Goal: `attempt.idempotencyKey` persisted before the request leaves; ambiguous handling per §3.9 with the proof conditions; the single-retry path.
Owns: `src/background/jobs/snipe-send.ts`, `test/integration/snipe-send.test.ts`.
Deps: T-100, T-84.
Tests first: a timeout followed by a post-read showing our bid present → `accepted`, no resend; post-read showing nothing changed with 2 s left → one resend; with 1 s left → no resend, outcome `network`; worker death simulated between persist and send → resend allowed exactly once.
Gate: `pnpm test:integration -- snipe-send`.

**T-102 · Live gating and exposure meter** (S · B)
Goal: `dryRun.bidding` may be turned off only when `completedDryRuns ≥ requiredDryRuns` (default 5) and on-time ≥ 95%; confirmation copy; exposure meter in popup and dashboard; "first live snipe" guided checklist link.
Owns: `src/background/handlers/live-gate.ts`, `src/ui/exposure/**`, `test/unit/background/live-gate.test.ts`.
Deps: T-90, T-85.
Gate: `pnpm test:unit -- src/background/live-gate`.

**T-103 · Outcome detection and calendar stamping** (M · C)
Goal: post-end job step (lane background, one detail read ≥ 2 min after end for every tracked item with a snipe or calendar event): `won|lost|ended-early`, `stamp` on calendar, notification, tracked outcome, spent-today accumulation.
Owns: `src/background/jobs/outcomes.ts`, `test/integration/outcomes.test.ts`.
Deps: T-67, T-87, T-52.
Tests first: won → event title prefixed `WON $x`, reminders cleared; lost → `LOST`; ended-early → `ENDED EARLY` and snipe `ended`.
Gate: `pnpm test:integration -- outcomes`.

**T-104 · Chromium E2E: money paths** (M · D)
Goal: against the fake server with proxy semantics: live snipe wins; outbid by a higher hidden max; below-minimum; cap-blocked; `Bid` cookie scenario cannot trigger because `credentials:'omit'` (assert no cookie header).
Owns: `test/e2e/chromium/live-bid.spec.ts`. Deps: T-101, T-103, T-89. Gate: `pnpm test:e2e:chromium -- live-bid`.

**T-105 · First real snipe acceptance script** (S · E)
Goal: `docs/ACCEPTANCE.md#A-5`: user-approved cheap item, caps set to its max, dry-run off for that one snipe, timing report captured, calendar stamp verified; explicit approval text the user signs.
Owns: `docs/ACCEPTANCE.md` A-5 section. Deps: T-102. Gate: reviewed by a second worker for completeness.

### Phase 6 — T2 companion and later QoL

**T-110 · Windows wake-and-launch companion** (L · A)
Goal: `companion/windows/`: native-messaging host (PowerShell or a tiny Node script registered via `HKCU\Software\Google\Chrome\NativeMessagingHosts` and `HKCU\Software\Mozilla\NativeMessagingHosts`), protocol `{op:'schedule'|'cancel'|'list', snipeId, wakeAtUtc, browser, profile}` → `schtasks` with `-WakeToRun`, launch command for the browser with the user's profile; installer `install.ps1`, uninstaller, `docs/COMPANION.md` with power-plan settings per S-8.
Owns: `companion/**`, `docs/COMPANION.md`. Deps: T-14. Tests first: Pester tests for task XML generation; a protocol round-trip test in Node. Gate: `pnpm test:unit -- companion && powershell -File companion/windows/tests/run.ps1`.

**T-111 · Extension side of T2** (M · B)
Goal: `nativeMessaging` optional permission, `CompanionPort` adapter, schedule/cancel on arm/disarm when tier T2, preflight checks the companion is reachable, awake-history ignores companion-caused wakes for advice.
Owns: `src/adapters/browser/companion.ts`, `src/background/jobs/companion-sync.ts`, `test/integration/companion.test.ts`. Deps: T-110, T-84. Gate: `pnpm test:integration -- companion`.

**T-112 · Bid groups** (L · C)
Goal: `groupId`, "win at most N", spacing validation (≥ 2 min between ends), edit freeze at T−2 min, cancellation only after a confirmed `won` post-read, UI.
Owns: `src/domain/snipe/groups.ts`, `src/ui/dashboard/groups/**`, `test/unit/domain/snipe/groups.test.ts`, `test/e2e/chromium/groups.spec.ts`. Deps: T-103, T-85. Gate: `pnpm test:unit -- src/domain/snipe/groups && pnpm test:e2e:chromium -- groups`.

**T-113 · Relist detector** (M · D)
Goal: fingerprint (normalized title + sellerId + image basename), "seen before at $X" badge, `relistId` use when present. Owns: `src/domain/relist/**`, `src/content/ui/relist-badge.tsx`, tests. Deps: T-32. Gate: `pnpm test:unit -- src/domain/relist`.

**T-114 · Rules import/export and templates** (S · E)
Owns: `src/domain/rules/io.ts`, `src/entrypoints/options/io/**`, tests. Deps: T-37. Gate: `pnpm test:unit -- src/domain/rules/io`.

**T-115 · Comps link-out, combined-shipping hint, pickup distance** (M · F)
Owns: `src/content/ui/{comps,combined,pickup}.tsx`, `src/domain/geo/zip-distance.ts` (offline ZIP centroid table), tests. Deps: T-32, T-57. Gate: `pnpm test:unit -- src/domain/geo && pnpm test:dom -- comps`.

**T-116 · Firefox runner-page SnipeHost** (M · G, **only if S-7 requires**)
Owns: `src/entrypoints/snipe-runner/**`, `src/adapters/browser/snipe-host-page.ts`, tests. Deps: T-13, T-84. Gate: `pnpm test:e2e:firefox`.

---

## 7. Test strategy

### 7.1 Pyramid targets

| Layer | Tooling | Target | What it must prove |
|---|---|---|---|
| Static | `tsc --strict`, ESLint (`no-unsanitized`, restricted paths, `no-restricted-syntax` for `Date.parse`/`innerHTML`/`eval`), `web-ext lint --warnings-as-errors --self-hosted`, permissions snapshot, prod-bundle grep | 0 warnings | no unsafe DOM, no new permissions, no test hooks in prod |
| Unit | Vitest, fake timers, fast-check property tests | ≥ 90% lines in `src/domain`, 100% of state-machine transitions | money/time math incl. DST edges, rules, scheduler, snipe reducer, calendar reconciler |
| Contract | zod over sanitized fixtures | every fixture, every endpoint | schema drift is caught before runtime; the same schema fails closed at runtime |
| Integration | WXT `fakeBrowser` + fake ports + MSW (`msw/node`) | all background jobs | alarm loss, restart, missed runs, permission revocation, token expiry |
| DOM | happy-dom over rendered fixtures | overlay, options, dashboard | idempotent injection under re-render, keyboard operability, text-only rendering |
| E2E Chromium | Playwright `launchPersistentContext`, `channel:'chromium'`, headless, test build, fake servers | overlay, daily job, calendar, snipe, money | real extension lifecycle incl. packed alarm floors (snipe specs run the packed build) |
| E2E Firefox | Selenium/geckodriver (or BiDi) temporary install; `web-ext run` smoke fallback | overlay, daily job, snipe host | Firefox event-page behaviour, MV3 manifest validity |
| Canary | nightly GitHub Action, anonymous, read-only, ≤ 4 requests | schemas + selectors | drift detection with an issue, never a write |
| Manual | `docs/ACCEPTANCE.md` A-1…A-6 | one per phase | real account, real calendar, real phone, first real snipe |

### 7.2 Fixture capture and sanitization procedure (Task 0 and refreshes)

1. Capture only through `scripts/capture-fixtures.ts` (anonymous) or by the user exporting DevTools HAR/JSON (USER STEP). The script enforces ≥ 120 s spacing, a 25-request cap per run, a visible log, and refuses any URL under `/shopgoodwill/`, `/checkout/` or a `PlaceBid`/`AddToFavorite`/`Save` path.
2. Rendered HTML is captured with Playwright after `app-home-product-items` count ≥ 1 (or a 20 s timeout → "skeleton-only" fixture, also kept), then `scripts/sanitize-fixtures.ts`:
   - replaces titles with deterministic lorem of the same length, seller names with `Goodwill of <Letter>`, bidder masks with `b****r`, image URLs with `https://img.test/<hash>.jpg`;
   - remaps itemIds with a stable salted hash (consistent across JSON and HTML in the same capture);
   - strips `<script>` ad tags, inline event handlers, `_ngcontent-*` values are kept (tests must not depend on them, a lint test asserts selectors do not);
   - removes every `Authorization`, `Cookie`, `Set-Cookie`, `x-azure-ref` header and any JWT-shaped string (`/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/`).
3. `test/fixtures/sgw/manifest.json` records capture date, URL pattern, anonymous/user, and sanitizer version. Fixtures are refreshed only by re-running Task 0's capture (a new PR), never hand-edited; a schema mismatch is a schema change with a changelog entry.
4. User-provided captures are sanitized **before** being committed; the raw export never enters the repo (`.gitignore: test/fixtures/raw/`).

### 7.3 GitHub Actions workflow

`ci.yml` (on PR and push to `main`): `static` (lint, typecheck, build both, web-ext lint, permissions snapshot, prod-bundle check) → `unit` (Vitest unit + dom, coverage upload) → `contract` → `integration` → `e2e-chromium` (fake servers as background steps, Playwright headless `chromium`, packed build for `snipe.spec.ts`, artifacts: traces on failure) → `e2e-firefox` (Python 3.x + geckodriver, Firefox stable, temporary install; required after S-6). `canary.yml`: nightly at 03:17 UTC with `workflow_dispatch`, concurrency group `canary`, 12 h lock, opens/updates one issue on failure. `release.yml`: on `v*` tags (§11).

### 7.4 Flake policy

- A test may be retried once in CI only if tagged `@retry` with a linked issue; untagged tests never retry.
- Any E2E spec that fails twice in a week on `main` is quarantined (`test.fixme` with issue link) within one working day, and the owning task reopens.
- No `sleep`-based waits: E2E uses the time-travel hook and server-side scenario barriers; unit tests use fake timers only.
- Timing assertions in S-7 and `snipe.spec.ts` use generous CI bounds (fire error ≤ 1 s) and record the distribution as an artifact; the tight bound (≤ 250 ms) is asserted only in the local soak.

### 7.5 Test-only hooks

`src/test-hooks/**` exports `installTestHooks()` guarded by `if (import.meta.env.SBW_TEST)`; the test build sets it, production never does, and `check-prod-bundle` greps the output for `SBW_TEST`, `__scenario`, `127.0.0.1`, `localhost`, `sbw:test`. Hooks: `sbw:test:advance` (Clock + Alarms fast-forward), `sbw:test:fireAlarm`, `sbw:test:baseUrl`, `sbw:test:state` (dump storage), `GoogleAuthProvider` stub.

### 7.6 Manual acceptance checklists (full text in `docs/ACCEPTANCE.md`)

- **A-1 Overlay (Phase 1):** on a real search page, a highlight rule and a hide rule behave as previewed; hidden bar count; Why?; undo; SPA paging keeps decorations; kill switch clears; no console errors from the extension; request log shows zero extension buyerapi calls on page view.
- **A-2 Daily job (Phase 2):** a watch runs overnight in dry-run with the browser open; the log shows the plan; catch-up after a closed-browser day; one real favorite on a user-chosen item with dry-run off, then undo via the log; request spacing ≥ 120 s in the health panel.
- **A-3 Calendar (Phase 3):** connect with the user's own project (Chrome and Firefox); the dedicated calendar appears; an event with 60/15/5 popups; **"the 60/15/5 popups arrive on the phone with the PC off"** (dedicated calendar synced in the phone app, notifications on); end-time change patches; unwatch deletes; the disconnect revokes (Google account permissions page shows removal).
- **A-4 Dry-run snipes (Phase 4):** ≥ 5 dry-run snipes over ≥ 3 evenings; timing page shows on-time ≥ 95%; preflight notification at T−15; a deliberately failed preflight (log out of SGW) applies the fallback and reports; kill switch via keyboard; awake-history advice shown.
- **A-5 First real snipe (Phase 5):** user-signed approval naming the item and max; caps set; one bid sent; outcome notification; calendar stamped; audit log complete; the SGW bid history shows exactly one bid from the account.
- **A-6 Companion (Phase 6):** PC put to sleep 20 min before a dry-run snipe; wake timer fires; browser launches; fire on time; log shows the chain.

---

## 8. Threat model

| Asset | Threat | Control | Test that proves it |
|---|---|---|---|
| SGW bearer token | exfiltration by page scripts | token captured in MAIN world is sent only via nonce-gated `postMessage` to our isolated script and never written to the DOM; stored in `storage.local` (extension-only); never logged | `api-tap.test.ts` nonce check; `session-adapter.test.ts` no-log spy; `audit/log.test.ts` redaction |
| SGW bearer token | leaked in audit/export | redaction of key names and JWT-shaped strings | `log.test.ts` JWT regex redaction |
| SGW token | theft at rest | `storage.local` is per-profile; no sync; documented residual risk | permissions snapshot (no `storage.sync` usage: lint rule banning `storage.sync`) |
| User's money | double bid after worker restart | idempotency key persisted before send; `sent` terminal | `snipe-send.test.ts`, `state-machine.test.ts` property "≤1 placeBid" |
| User's money | bid above max / typo | caps and typo guard in domain and UI; `bidAmount` derived only from `Snipe.maxBid` | `caps.test.ts`, `dashboard-snipes.test.ts`, `live-bid.spec.ts` |
| User's money | bidding on drifted data | schema fail-closed; health gating; `minimumBid` from detail only | `health.test.ts`, `api-adapter.test.ts` schema path |
| User's money | accidental live bid during testing | dry-run default; live gate; no live writes in CI (fake servers only, prod URLs absent from test build) | `live-gate.test.ts`; CI never has credentials; `check-prod-bundle` |
| SGW account | suspension from heavy traffic | lanes, budgets, 120 s background spacing, backoff, pause on 403s | `request-scheduler.test.ts`; E2E server timestamps |
| SGW account | evasion-like behaviour | no CAPTCHA, UA or IP manipulation anywhere | grep test for `User-Agent` header set in `src/` (must be absent) |
| User's browser | XSS from listing text/API HTML | no `innerHTML`; Preact text nodes; `messageText` stripped | ESLint `no-unsanitized`; `overlay.test.ts` script-in-title; `bid.test.ts` |
| Extension privileges | hostile message from a web page | sender validation; content-script allow-list; UI-only types | `router.test.ts` |
| Google refresh token | leaked | `storage.local` only; revoke on disconnect; redaction | `auth-pkce.test.ts` revoke; `log.test.ts` |
| Google account | over-broad scope | single scope `calendar.app.created`; granted scopes checked | `auth-pkce.test.ts` scope check; fake Google scope enforcement |
| User's calendar | duplicate/stale events | deterministic ids; reconciler; 409 handling; stamping | `reconciler.test.ts`; `calendar-sync.test.ts` |
| User's privacy | ntfy third party | opt-in, unguessable topic, own host permission, declared | `ntfy-sink.test.ts` disabled→no network; manifest declaration snapshot |
| Supply chain | malicious dependency / remote code | pinned exact versions, lockfile, no remote code, no `eval` | `check-prod-bundle` `eval(`; Dependabot config |
| Site | our tests hitting SGW | fixtures only; canary budget 4/day; capture script caps | `canary.test.ts` lock; `capture-fixtures` URL refusal test |

---

## 9. Considerate-use budget

Assumptions: 5 watches, 2 pages each, ~10 new matches/day, user views ~10 search pages/day, 3 armed snipes/week.

| Feature | SGW requests/day (expected) | Peak req/min | Lane | Scale-down switch |
|---|---|---|---|---|
| Overlay on pages the user opens | 0 (tap reuses page data) | 0 | — | `overlay.enabled` |
| Landed-cost badges | ≤ 40 per page view, cached 24 h; typical 30/day | 60 (1/s while scrolling, user-triggered) | interactive | `features.landedCost`; `overlay.landedCostBadges` |
| Server-synced countdown | 1 ItemDetail per item page (from tap) + ≤ 2 clock samples/hour | 2 | interactive | `features.countdownRefresh` |
| Daily job: searches | 10 | 0.5 (one per 120 s) | background | `dailyRun.enabled`; `maxPages` |
| Daily job: favorites list | 1 | | background | — |
| Daily job: details for new matches | ~10 | 0.5 | background | `favoriteMode: local` avoids details unless calendar |
| Daily job: favorite adds | ~5 | 0.5 | background | per-watch `favoriteMode`; dry-run |
| Run now (manual) | same count, 1/s | 60 | interactive | — |
| Calendar sync | 0 SGW (Google only) | — | — | `calendar.enabled` |
| Outcome detection | 1 detail per tracked item after end (~5) | 0.5 | background | `calendar.enabled`/snipes |
| Snipe (per armed item) | 24 h check 1 · 1 h check 1 · preflight 1 · wake samples 3 · T−60 verify 1 · ShowBidModal 1 · PlaceBid 1 · post-read 1 ≈ **10** | ≤ 6 in the final 5 min (≥ 20 s apart except modal+bid at fire) | snipe | `snipe.enabled`; per-day budget 80 |
| Canary (CI) | 2–3 | 0.5 | canary | workflow toggle |
| Auth health | 0 SGW (uses cached session state) | — | — | — |
| **Total typical day** | **≈ 60–90**, hard cap 300 interactive + 120 background + 80 snipe | | | `considerateMode: tight` halves all budgets and doubles intervals; kill switch stops all writes |

Justified exception to the 120 s rule: the snipe window (≤ 6 reads for one item the user explicitly armed, plus one write), because acting on live state at close is the feature's purpose; it is bounded, per-item, and never parallel.

---

## 10. Personal-use setup guide outline (`docs/SETUP-*.md`)

**SETUP-GOOGLE.md**
1. Create a GCP project "ShopBadwill (personal)". Enable the Google Calendar API.
2. OAuth consent screen: External; app name; your email as support and developer contact; add yourself as a test user.
3. Create credentials: (a) for Chrome, an OAuth client of type **Web application** with authorized redirect URI `https://<your-extension-id>.chromiumapp.org/` (the options page shows your exact id); (b) for Firefox, a client of type **Desktop app** (no redirect to configure; the options page shows the loopback URI the browser will use). Copy the client id(s) and, for the Web client, the secret, into the options page. They are stored only in your browser.
4. Click Connect in the options page; on the "Google hasn't verified this app" screen choose Advanced → Go to ShopBadwill; grant the single calendar permission.
5. Publishing status → **In production**; do **not** submit for verification (personal use under 100 users is exempt). Then click Disconnect and Connect again, because tokens issued during Testing expire after 7 days.
6. Phone: open Google Calendar app → settings → ensure the "ShopGoodwill Auctions" calendar is synced and its notifications are on. Test: the extension creates a test event 3 minutes out with a 1-minute popup (A-3).
7. Troubleshooting: `invalid_grant` weekly (still in Testing), `redirect_uri_mismatch`, "client_secret is missing", scope not granted.

**SETUP-CHROME.md**: install Node 25 and pnpm; `pnpm i && pnpm build`; `chrome://extensions` → Developer mode → Load unpacked → `.output/chrome-mv3`; pin the action; keyboard shortcut; note that branded Chrome ignores `--load-extension` (so always Load unpacked); updating = `git pull && pnpm build` then Reload; optional permissions explained; Windows power plan: "Sleep: Never" when plugged in if sniping with T1; `chrome://settings/system` "Continue running background apps when Google Chrome is closed" for the `background` permission.

**SETUP-FIREFOX.md**: `pnpm build:firefox`; temporary install via `about:debugging` for trying; permanent: get AMO API keys (addons.mozilla.org → Tools → Manage API keys), `pnpm sign:firefox` (= `web-ext sign --channel unlisted --upload-source-code --source-dir .output/firefox-mv3 --api-key … --api-secret …`), install the signed `.xpi`; host permission grant on install; sidebar; limits (no keep-awake, snipes need the PC awake).

**COMPANION.md** (Phase 6): `powercfg /a` check; "Allow wake timers" in the power plan; Modern Standby notes; run `install.ps1` (registers the native host for Chrome and Firefox, creates the task folder `\ShopBadwill\`); verify with the dashboard "Companion: connected"; uninstall.

---

## 11. Release and distribution

- **Versioning:** semver; `wxt.config.ts` reads `package.json` version; `CHANGELOG.md` keep-a-changelog.
- **Chrome:** no store listing planned (**ASSUMPTION**, open question Q6). Distribution is `Load unpacked` from a GitHub release zip or the repo. If a store listing is ever wanted: the single-purpose and data-disclosure policies (July 2026 update) require a privacy policy; the extension collects nothing, which simplifies it.
- **Firefox:** signed unlisted builds. `release.yml` runs `web-ext lint --warnings-as-errors --self-hosted`, then `web-ext sign --channel unlisted --upload-source-code` with the source zip produced by `scripts/release.ts` (clean clone + build instructions in `README.md#reproducible-build`), and attaches the signed `.xpi`. AMO keys are repository secrets; the job is skipped when absent so forks still build.
- **Artifacts per release:** `shopbadwill-chrome-mv3-vX.Y.Z.zip`, `shopbadwill-firefox-vX.Y.Z.xpi`, `source-vX.Y.Z.zip`, `SHA256SUMS`.
- **Companion:** separate zip `companion-windows-vX.Y.Z.zip` with `install.ps1` and a signed-hash manifest; no `curl | bash`.
- **Updates:** manual (`git pull`/download). Firefox unlisted builds can use `update_url` in `browser_specific_settings` pointing at a GitHub-hosted `updates.json` (stretch).

---

## 12. Risk register

| # | Risk | L | I | Mitigation | Owner task |
|---|---|---|---|---|---|
| R1 | Account suspension under the ToS (extensions, automation, altering rendering) | M | H | user-accepted; human-scale lanes and budgets; API-only background; no evasion; kill switch; stop-and-notify on 403; **possible mitigation: written authorization from SGW** (user may request it; the plan does not depend on it) | T-25, T-36 |
| R2 | API or DOM drift | H | M | versioned config; zod fail-closed; ranked selectors; health check pauses writes; nightly canary; fixtures refresh procedure | T-24, T-27, T-30, T-60 |
| R3 | SGW token expiry / IP-UA binding breaks unattended runs | M | H | S-2 measures; refresh only if proven; `expiring` warnings 24 h/1 h; degrade to search+queue+notify; calls always from the user's browser | T-08, T-28, T-91 |
| R4 | Clock skew and latency at close | M | H | ms `serverTime` lowest-RTT offset; latency bounds; lead default from the soak; auto-kill on out-of-bounds | T-29, T-81, T-90 |
| R5 | Missed snipes: sleep, closed browser, peak overload | H | H | honest tiers; fallback policy applied early; awake history; T1 keep-awake; T2 wake-and-launch; preflight at T−15; `late` outcome reported | T-83, T-84, T-91, T-110 |
| R6 | Money loss and typos | L | H | dry-run default and live gate; caps (item/day/exposure); typo guard; single bid; `minimumBid` from detail; audit | T-82, T-85, T-101, T-102 |
| R7 | Google OAuth changes, 7-day Testing expiry, loopback rejection | M | M | user's own project in production; `invalid_grant` handling with badge; S-4 verifies both browsers; getAuthToken alternative; .ics and ntfy fallbacks | T-10, T-62, T-68, T-69 |
| R8 | Rate limiting and blocks (403/429) | M | M | backoff; global pause on 403 bursts; budgets; considerate mode; notify | T-25 |
| R9 | Store review (if ever listed) / AMO source requirement | L | L | unlisted signing with source upload; reproducible build doc; no remote code | T-74 |
| R10 | Data loss (storage corruption, quota, reinstall) | M | M | zod quarantine; migrations with crash flag; rules/watches export; audit ring; caches capped under 10 MB | T-33, T-114 |
| R11 | Firefox event page cannot be held alive for the snipe window | M | M | S-7 measures; runner-page host fallback | T-13, T-116 |
| R12 | `background` permission ineffective under MV3 | M | M | S-8 measures; T1 falls back to power-plan guidance; T2 wake-and-launch | T-14, T-91 |
| R13 | Favoriting attracts rival bidders (anecdotal) | ? | L | per-watch mode incl. `local` and `sgw-late` | T-51, T-55 |
| R14 | Soft close exists (snipe fires into an extension) | L | M | S-3 verdict; `extended` detection and re-arm proposal | T-09, T-80 |
| R15 | New-account 15-auction cap ⚠ / restricted auctions | L | L | `restricted` BidResultKind; warning copy in arming UI | T-100, T-85 |
| R16 | Fixture sanitization leaks personal data | L | M | sanitizer tests; raw dir git-ignored; review step | T-07 |

---

## 13. QoL list (tagged)

**MVP (Phases 1–3):** dry-run for everything · health checks that pause automation on site drift · whole-word and negative keywords · "Why?" chips, hidden bar, undo, global off · one-click hide this seller / keyword from a card · live rule preview ("matches 7 of 40") · local + Pacific time side by side · watch health line (last run, next run, new, Run now, catch-up note) · per-watch favorite mode incl. local-only and favorite-late · activity log with undo · landed-cost badge and landed-cost rules (own switch) · server-synced countdown (own switch) · late-add alert · dedicated calendar · calendar events that update, stamp WON/LOST and delete themselves · .ics fallback · importing SGW saved searches · daily digest with quiet hours · selector-drift banner · rules import/export as JSON (Phase 6 card but small; may be pulled forward).

**Phase 4–5 (sniping):** kill switch with armed-snipe badge · typo guard · max bid entered as all-in price · exposure meter · T−15 preflight with automatic fallback · auth-health 24 h/1 h · post-auction outcome report · timing diagnostics · awake-history advice · per-snipe fallback (early proxy / skip) · calendar "SNIPE ARMED" title prefix (stamping hook).

**Later (Phase 6):** snipe groups · relist detector · sold-price comps (link-out only) · pickup-only badge with distance · combined-shipping hint · friend list (never bid against; needs bidder identity, which SGW masks ⚠ — may be infeasible) · rule templates · keyboard triage (j/k/h/f/s) · ntfy phone push (built in Phase 3 but opt-in) · "new since last visit" / hide-seen · new-account cap warning.

**Stretch:** misspelling variants for keywords · Apps Script calendar alternative · Firefox `update_url` self-updates · multi-win groups · busy-time awareness (extra scope, opt-in) · audio cues for fire/win/loss · ad-slot decluttering (weigh against ToS "alter rendering" — default off).

---

## 14. Open questions for the user

Only items that block or materially change the plan. The ToS decision and the five features are settled and are not re-asked.

1. **Machine and power habits.** Is the primary machine a desktop or a laptop, and will it be left on with the browser running overnight? (Decides whether T1 is enough for the first sniping release or T2 should move up; affects S-8 scope.)
2. **Primary browser for sniping.** Chrome is assumed for T1 (keep-awake is Chrome-only). Is Firefox the daily browser? If so, Firefox sniping depends on S-7 and T2.
3. **Spend caps.** Default per-item max, per-day max and total open exposure (e.g. $75 / $150 / $300)? Required before T-82 ships defaults.
4. **Google account type.** Personal Gmail or Workspace? (Workspace "Internal" avoids the unverified-app screen and the 7-day expiry.) Also: is a dedicated "ShopGoodwill Auctions" calendar acceptable, and is the Google Calendar app installed on the phone with notifications on?
5. **Auto-favorite default** for new watches: `sgw` (favorite immediately), `sgw-late` (within N hours of end), or `local`? The plan assumes `local` until answered.
6. **Distribution.** Unpacked Chrome + unlisted-signed Firefox only (assumed), or is a store listing wanted later? (Changes privacy-policy and review work.)
7. **Daily run time and time zone.** Default 07:00 local; which time zone are you in? (Affects dual-time display and the "ends while you sleep" heuristics.)
8. **Real-money approvals.** Agreement in principle that (a) one cheap item you actually want will be used for the PlaceBid response catalogue (you bid through the site yourself) and (b) a second for the first live snipe. These are USER STEPs in Phase 5; approval is per item at the time.
9. **Companion consent.** Are you willing to install a small native-messaging host and a Windows scheduled task (wake timer) if the dry-run soak shows your machine is usually asleep at auction close?
10. **Phone push.** Do you want the ntfy.sh fallback at all (it sends auction titles to a third party)? Default: off.

---

## 15. User answers (2026-10-07) — binding, supersede the assumptions above

| Q | Answer | Effect on the plan |
|---|---|---|
| 1 Machine | Laptop (Lenovo 83F5), **plugged in and left on** with the browser running when auctions end. Supports S3 standby + hibernate; **no Modern Standby** (`powercfg /a`). | T1 (keep-awake) is the first sniping release as planned; T2 stays Phase 6. S-8 notes S3 wake timers should be honoured. |
| 2 Primary browser for sniping | **Both Chrome and Firefox equally.** | Firefox sniping is a first-class requirement: if S-7 shows the Firefox event page cannot be held alive, T-116 (runner-page `SnipeHost`) is **not conditional** and moves into Phase 4. Phase 4 E2E covers both browsers. |
| 3 Spend caps | **$50 per item / $100 per day / $200 total open exposure** (defaults; user-editable). | `Settings` defaults in T-02/T-82: 5000 / 10000 / 20000 cents. |
| 4 Google account | Personal Gmail (not Workspace). | 7-day Testing expiry applies → SETUP-GOOGLE "In production" path is required. Phone app check stays a USER STEP. |
| 5 Auto-favorite default | **`sgw` (favorite immediately)** — the user's original requirement is "favorite those items on our account". `sgw-late` and `local` stay available per watch. | Supersedes the `local` ASSUMPTION in §1.8. Dry-run still on by default. |
| 6 Distribution | Load unpacked (Chrome) + unlisted-signed Firefox. No store listing. | As assumed. |
| 7 Time zone | **America/New_York (Eastern).** Daily run default 07:00 local. | Dual display "PT · ET". |
| 8 Real money | Per-item approval at the time (Phase 5 USER STEPs). | As planned. |
| 9 Companion | Not yet asked; ask after the Phase 4 dry-run soak. | — |
| 10 ntfy | Default off (opt-in). | As planned. |
| — Git | Work on branch `dev`; per-task branches merged into `dev` after review; push; PR `dev → main` for CI. **Never merge to `main` without the user's approval.** | — |
