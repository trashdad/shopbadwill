# Contract decisions (T-02, contracts v1 — frozen 2026-10-07)

The merged code is the authoritative contract: `src/ports/**`, `src/domain/**/types.ts`, `src/domain/**/schema.ts`, `src/domain/settings/**`, `src/domain/storage/schema.ts`, `src/messaging/protocol.ts`. Where `planning/PLAN.md` §3 differs, the code wins. Changes go through a contract-change PR (`.github/PULL_REQUEST_TEMPLATE/contract-change.md`).

Below: every place §3 (v1.1) was ambiguous or incomplete and how it was resolved, followed by the review fix round.

## Decisions (round 0)

These are every place where §3 (v1.1) was ambiguous or incomplete and I chose the smallest faithful definition.

### Placement and layering

1. **Some §3.3, §3.4 and §3.11 data shapes live in `src/domain/types.ts`, not `src/ports`.** This covers `SearchQuery`, `ClockSample`, `HealthReport`, `SgwSessionState`, `Lane`, `LaneConfig`, `DEFAULT_LANES`, `RequestSchedulerStats`, `SgwSessionRecord` and `GoogleCredentials`. Two reasons:
   - These shapes need schemas, and ports are pure interfaces (your decision).
   - The ESLint zone lets adapters import only `domain/types.ts` and the snipe, calendar and audit `types.ts` files, not `watches/schema.ts`. T-50's `query-url.ts` needs `SearchQuery`.
2. **Some port parameters stay plain interfaces with no schema** because they are never serialized: `HttpRequest`, `HttpResponse`, `AlarmInfo`, `Notification`, `CardHandle`, `Decoration` and `ScheduledRequest<T>`. `MatchContext` is the same; it holds a function.
3. **`GlobalSwitches` is a port** (`src/ports/global-switches.ts`), not part of `settings/schema.ts`. T-26 (an adapter) depends on it and cannot import `domain/settings`.
4. **Domain service interfaces:**
   - `DailyJob`, `Scheduler` and `FavoritesReconciler` are in `domain/watches/schema.ts`.
   - `AuditLog` sits beside `AuditEntry`.
   - `SnipeHost`, `CalendarSink`, `CalendarApi` and `GoogleAuthProvider` are in `src/ports`, as §2.1 lists them.
5. **The error classes are real classes in `src/ports/errors.ts`**, the only runtime code in `src/ports` (enforced by a test).
   - **Why:** §3 declares `SgwApiError`, `CalendarApiError` and `GoogleAuthError` as `export class`, and §3.2 names `HttpTimeoutError` and `HttpNetworkError`. I-08 converted only `function` and `const` lines to types. T-03's fakes and T-25/26/34/62/64 must throw the same class so that `instanceof` works across cards, and no other card owns them.
   - **Constructors:**
     - `new SgwApiError(kind, message?, { status?, retryAfterMs?, cause? })`
     - `new CalendarApiError(code, message?, { status?, cause? })`
     - `new GoogleAuthError(code, message?, { cause? })`
     - `new HttpTimeoutError(timeoutMs, { cause? })`
     - `new HttpNetworkError(message, { beforeSend?, cause? })`
   - The message defaults to the kind or code.
   - New alias names: `SgwApiErrorKind` and `CalendarApiErrorCode`.
6. **`HttpNetworkError.beforeSend: boolean` was added (default `false`).** Without it, T-101 cannot apply the §3.9 proof ("a `HttpNetworkError` thrown before any bytes were sent"). Every other network error stays ambiguous.
7. **Function types use PascalCase names (I-08):** `Evaluate`, `EvaluateBatch`, `CompileKeyword`, `EventIdFor`, `Reduce`, `ComputeFireAt`, `CheckCaps`, `SearchQueryFromUrl` and `SearchQueryToUrl`. The last two are in `ports/sgw-api.ts`.
8. **`DEFAULT_LANES` is exported as a frozen value with the §3.4 numbers.** It is data, not a function; I-08's "export const → type" rule was aimed at function-valued constants. T-25 should import it.

### Gap fills

9. **`Effect` payloads (I-08 left them to T-02):**
   - `scheduleWake{at}`
   - `holdKeepAwake{hold: boolean}` (true holds, false releases; the runner applies it only on tier T1)
   - `sampleClock{}`
   - `readDetail{purpose: 'verify' | 'post-read' | 'measure'}` (`measure` is the dry-run read at fire time)
   - `placeBid{amount}`
   - `notify{title, message}`
   - `stampCalendar{outcome, finalPrice?}`
   - `audit{entry: Omit<AuditEntry, 'seq' | 'at'>}`
   - `applyFallbackProxy{amount}`
   - `proposeRearm{}`

   The runner generates the idempotency key and reports it with the `sent` event, so the reducer stays pure.
10. **`GcalEvent`.** §3.8's `interface GcalEvent extends GcalEventBody` widens `status`, which TypeScript rejects. I encoded the intended shape as `GcalEventBodySchema.extend(...)`: `status` is required and can be `confirmed`, `tentative` or `cancelled`.
11. **I kept `Listing.sellerState` (optional) and the `location` condition.** S-1 (T-07) depends on T-02 and has not run yet. If S-1 finds no source field, dropping `location` is a contract-change PR.
12. **Names for §3 inline types:** `SgwSessionState`, `RequestSchedulerStats` (= `ReturnType<RequestScheduler['stats']>`), `FavoriteMode`, `SnipeId` (which §2.3 already uses), `UsState` and `LeadMsSchema`.
13. **Messages.**
    - `Msg` is the §3.12 request union without `reply`. A reply's type is `MsgReply<K>`, validated by `MsgReplySchemas[K]`.
    - Messages that have no `reply` answer `undefined`.
    - On the wire, `MsgEnvelope` is `{ v: 1, reqId }` combined with `Msg` (§2.4). Messages without a payload have no `payload` key.
    - `MSG_SENDER` encodes §3.12's comment grouping.
    - **Left to T-35:** the response and error envelope, which §3 does not define.
14. **Port streams.**
    - The `sbw:snipe-countdown` tick is `{ snipeId, serverNow: EpochMs | null, fireAt: EpochMs | null, state }`. Both are nullable because `SgwClock.serverNow()` returns null before any sample and `Snipe.fireAt` is optional.
    - `sbw:job-progress` streams the active `JobRun`. §3.12 gives it no shape; T-54 renders JobRun progress.
15. **Storage.**
    - `StorageMeta` is `{ schemaVersion: 1, installedAt, lastMigrationAt, migrating? }`, with `migrating` taken from the §2.3 text.
    - `QuarantineRecord` is `{ at, error, value }`. §2.3 names the key but gives no shape.
    - The `sbw:shippingCache` key is a plain string ("itemId:zip").
    - **Retention is not enforced by the schemas.** This covers audit chunks of 500 in a ring of 20, the last 30 job runs, the cache TTLs and 14 days of awake history (in `STORAGE_LIMITS`), and the 2000-id `seenItemIds` ring (`WATCH_SEEN_RING_SIZE`). If a schema enforced them, a writer bug would quarantine the whole record. Writers enforce them instead.
16. **"Durable records are versioned."** The store as a whole is versioned by `sbw:meta.schemaVersion` (literal 1, `STORAGE_SCHEMA_VERSION`), and `Settings` carries `schemaVersion: 1` (§3.10). I added no per-record version fields elsewhere, because that would add fields to §3 types. Renames and re-keys go through T-33's migrations, as §2.3 says.

### Validation strictness

17. **Objects use zod's default strip mode:** unknown keys are dropped, not rejected. This is forward-compatible for stored records, and handlers see only known fields from untrusted senders.
18. **Constraints taken from §3 types and comments:**
    - `Cents`: integer ≥ 0. `ItemId`: positive integer.
    - `EpochMs`: finite and ≥ 0, but not required to be an integer, because `fireAt` subtracts rtt/2.
    - `IsoUtc` is `z.iso.datetime()` (Z only). `PacificNaiveRaw` must have no zone designator.
    - `sellerState` and `location.states` must match `^[A-Z]{2}$`. `localTime` and quiet hours are "HH:MM".
    - At most 5 reminders, in both `Settings` and `DesiredEvent`.
    - The lead is 3000–30000 ms, in both `Snipe.leadMs` and `defaultLeadMs`.
    - `CalendarLink.eventId` must match `^[a-v0-9]{5,1024}$`. Ids are non-empty, and counts are integers ≥ 0.
19. **Defensive constraints on content-script messages (I-27):** `page.token.bearer` must be JWT-shaped, and `quick.hideKeyword.term` must be non-empty (an empty term would hide every listing). `SgwSessionRecord.bearer` is only required to be non-empty; T-28 validates its shape.
20. **`Permissions.request()` stays in the port** because §3.2 is unchanged. I-21 removed only the message.
21. **`Notifier.onAction`'s `actionId: string | 'click'` is kept verbatim**, with a justified `eslint-disable` for `no-redundant-type-constituents`.

### Defaults beyond §15 (please confirm)

22. **`DEFAULT_SETTINGS` values that §15 does not fix:**

    | Setting | Default | Basis |
    |---|---|---|
    | `typoAbsolute` | **2500 ($25)** | Not specified anywhere; please confirm. |
    | `locale.timeZone` | `America/New_York` | §15 Q7. The composition root may replace it with the detected zone. |
    | `dailyRun` | enabled, `07:00`, catch-up on | — |
    | `overlay` | enabled, `hideStyle: 'collapse'`, `quickFavorite` **false**, `landedCostBadges` true, `countdown` true | `collapse` per §1.8; `quickFavorite` is a content-script write and opt-in per §2.4 |
    | `features.*` | all **false** | Request-spending features start off (§9); comps and relist are Phase 6 |
    | `calendar` | **disabled**, `mode: 'dedicated'`, reminders `[60, 15, 5]`, `icsFallback` **true** | Disabled until Google is connected; `icsFallback` per T-71 ("skip path leaves … `icsFallback` on") |
    | `notifications` | enabled, digest on, no quiet hours | — |
    | `ntfy` | absent | §15 Q10 |
    | `snipe` | disabled, 8000 ms lead, `early-proxy` fallback, `keepAlive` true, `tier` **T0**, `completedDryRuns` 0 | Fallback per §1.4; T1 needs the `power` permission and is Chrome-only |
    | `killSwitch` | false | — |
    | `considerateMode` | `normal` | — |

    `DEFAULT_FAVORITE_WITHIN_HOURS` is 6 (§1.8). `WatchSchema` uses `DEFAULT_WATCH_FAVORITE_MODE` (`'sgw'`) as its default.


## Review fix round 1 (amendments to the decisions above)

**Commit:** `b037ae8 fix(contracts): review round 1 — Messaging port, adapter storage access, freeze minors (T-02)` (on top of `32129a9`).

### Changes

**Important**

1. **Messaging port.** New file `src/ports/messaging.ts`, interface only, with:
   ```ts
   interface MessagingClient {
     send<K extends MsgType>(type: K, payload: MsgPayload<K>): Promise<MsgReply<K>>;
     connect<P extends PortName>(name: P, onTick: (t: PortTick<P>) => void): () => void;
     onBroadcast<K extends MsgBroadcastType>(type: K, cb: (payload: MsgPayload<K>) => void): () => void;
   }
   ```
   - `send` and `connect` follow the signature you gave. For messages without a payload, callers pass `undefined`; messages without a reply resolve `undefined`.
   - **`onBroadcast` is my addition.** Content and UI must receive `rules.changed` and `switches.changed` (T-32, and T-38's "badge reflects `switches.changed`"). Leaving it out would force a contract change in Phase 1.
   - `MsgBroadcastType` (= `'rules.changed' | 'switches.changed'`) is derived from `MSG_SENDER` in `protocol.ts`.
   - `ports.test.ts` now locks in `messaging.ts`, and `spec-shapes.test.ts` mirrors `MessagingClient`, `PortName` and both `PortTick`s.
2. **Adapter access to storage.**
   - `eslint.config.js` has one added line: `'./domain/storage/schema.ts'` is now in the adapter zone's `except` list (controller ruling).
   - `RequestBudget.used` is now `z.partialRecord(LaneSchema, …)`, typed `Partial<Record<Lane, number>>`. A missing lane reads as 0, and unknown lanes are still rejected.
   - The valid example is now partial (`{ interactive: 12, background: 20 }`). A new storage test covers an empty, a partial and a full record, rejects an unknown lane, and checks the type.

**Freeze minors**

3. `export type LeadMs` (mirrored in `spec-shapes`).
4. **`calendarId` has one home:** `CalendarState.calendarId` (`sbw:calendar`). I removed it from `GoogleCredentials` and from both `GoogleCredentials` examples. A storage test proves the credentials schema drops a stray `calendarId`.
5. **Doc comments only:**
   - `HttpNetworkError.beforeSend`: T-34 may set it true only when it throws without calling `fetch()`, that is, the request could not be built or `navigator.onLine` was false. Every rejection from `fetch()` is `false`.
   - `placeBid` effect: T-101 persists `attempt.idempotencyKey` and dispatches `sent { key }` BEFORE the request leaves, then dispatches `result` or `ambiguous`.
   - `readDetail`: `verify` is followed by `verified` or `verify-failed`, and `post-read` by `post-read`. `measure` (dry run) is followed by `post-read` with the detail just read, and the reducer resolves the snipe with outcome `'dry-run'`.
   - `ShippingCacheEntry.cents`: shipping and handling combined.
   - `LeadMs`: `.int()`, so computed leads (T-90) must be rounded.
   - `page.token`: the bearer is the bare JWT, with no `Bearer ` prefix.
   - `GcalEventSchema`: this is the normalized form; T-64 parses raw responses leniently and normalizes them.
   - `snipe.arm`: the T-84 handler sets `state`, `history` and `armedAt`, resets `attempt` to `{}`, and clears `fireAt`, `wakeAlarm`, `measured`, `outcome` and `outcomeDetail`.
6. **`DEFAULT_SETTINGS`** is now typed `DeepReadonly<Settings>` (exported helper type), so nested writes are compile errors, and it stays deeply frozen at runtime.
   - **New:** `defaultSettings(): Settings` returns a writable `structuredClone`.
   - `DEFAULT_CAPS` is `DeepReadonly<CapsCheck>`. `DEFAULT_SETTINGS.snipe.caps` is now a separate copy, so the two constants share no objects.
   - Tests use `@ts-expect-error` on a nested object write and a readonly array write, both of which still throw a `TypeError` at runtime. They also check that `defaultSettings()` returns independent, unfrozen copies whose mutations never reach the constants.

**Controller rulings applied without change:** `typoAbsolute` stays 2500, `features.landedCost` stays false (the defaults comment now notes that onboarding offers it), and `snipe.keepAlive` stays true (comment added).

### TDD

**RED.** I updated the tests and examples first: the regenerated examples, `storage`, `defaults`, `ports` and `spec-shapes`.

`pnpm test:contract -- test/contract/types` (exit 1):
```
 FAIL  |contract| test/contract/types/ports.test.ts
Error: Cannot find module '../../../src/ports/messaging' imported from …/ports.test.ts
 FAIL  … defaults.test.ts > Settings defaults > defaultSettings() returns a fresh, writable copy … — TypeError: defaultSettings is not a function
 FAIL  … examples.test.ts > RequestBudget > parses its valid example and returns it unchanged
 FAIL  … storage.test.ts > storage schema v1 > validates a sample record for every key  (sbw:requestBudget)
 FAIL  … storage.test.ts > … accepts a request budget that has used only some lanes, and rejects unknown lanes — ZodError
 FAIL  … storage.test.ts > … keeps calendarId in one place … — expected { provider: 'pkce', …(7) } to not have property "calendarId"
 Test Files  4 failed | 3 passed (7)
      Tests  5 failed | 255 passed (260)
```

`pnpm typecheck` (exit 2):
- missing `defaultSettings` and `DeepReadonly` exports
- unused `@ts-expect-error` ×2 (`DEFAULT_SETTINGS` was not deep-readonly yet)
- `ports/messaging` not found
- no exported `LeadMs`
- `SpecGoogleCredentials`: `calendarId` mismatch
- `RequestBudget['used']` was not `Partial<Record<Lane, number>>`

**GREEN.** Gate: 281 passed. Typecheck and lint are clean after one lint fix: `@ts-expect-error` on `.push` (absent from readonly arrays) tripped `no-unsafe-call`, so that test uses an index write.

**Extra verification.** Both temporary changes were removed before the commit.
- **Adapter zone.** A probe file `src/adapters/zz-probe/probe.ts` imported `STORAGE_KEYS` and `RuleSchema`. ESLint flagged only the `domain/rules/schema` import, so the storage import is allowed and other domain schemas are still blocked.
- **Messaging mirror.** Making `send`'s payload optional made `tsc` fail at `spec-shapes.test.ts(613)`: `Types of property 'send' are incompatible`. After restoring, it was clean.

### Commands and output (committed tree `b037ae8`)

`pnpm test:contract -- test/contract/types` (gate, exit 0):
```
$ tsx scripts/run-vitest.ts contract -- test/contract/types
> vitest run --project contract test/contract/types

 RUN  v4.1.11 C:/tools/shopbadwill-wt/T-02


 Test Files  7 passed (7)
      Tests  281 passed (281)
   Start at  22:59:09
   Duration  366ms (transform 426ms, setup 212ms, import 638ms, tests 189ms, environment 0ms)
```
Per file: examples 124, messages 96, ports 21, defaults 16, storage 10, spec-shapes 8, errors 6.

`pnpm typecheck` (exit 0):
```
$ tsc --noEmit
```

`pnpm lint` (exit 0):
```
$ eslint . --max-warnings=0
```

### Updates to the main report

- **Decision 1:** adapters may now also import `domain/storage/schema.ts`.
- **Decision 15:** `RequestBudget.used` is partial.
- **New decisions:**
  - `MessagingClient.onBroadcast` and `MsgBroadcastType`.
  - `defaultSettings()` and `DeepReadonly`.
  - `GoogleCredentials` no longer has `calendarId`. This differs from §3.11, so PLAN §3.11 and §2.3 should be updated in the next contract-change PR, along with the other decisions.
- **Concern 1** (`typoAbsolute`): resolved by your ruling.
- **Concern 6** (adapter zone): resolved by this round.

## Contract change: request scheduler state (T-25)

Approved by the controller on 2026-10-07 and made in `task/T-25`.

**Why.** An MV3 background worker is killed after about 30 s idle. The daily job sends one request per 2-minute alarm tick, so each tick usually runs on a fresh `RequestScheduler`. Before this change only the budget (`sbw:requestBudget`) was persisted. A restarted worker therefore forgot:
- the 6 h pause after three 403s;
- the 1 h 403 backoff;
- the 429/5xx backoffs, including any `Retry-After`;
- the consecutive-403/429 counters;
- the 120 s gap.

It could keep calling SGW after SGW had asked it to stop. The user's "considerate guest" rule requires that a restarted worker never forgets a pause or backoff SGW asked for.

### Changes

1. **New storage key `sbw:requestSchedulerState`** (`STORAGE_KEYS.requestSchedulerState`, area `local`), validated by the new `RequestSchedulerStateSchema` in `src/domain/storage/schema.ts`. It is registered in `STORAGE_RECORDS`, so the T-33 `Repo` validates it, lists it and quarantines it like every other record.
   - `version: 1`: the literal `REQUEST_SCHEDULER_STATE_VERSION`. A reader rejects any other version, which is handled as an invalid record.
   - `pause: { cause: 'manual' | 'blocked' | 'rate-limited', reason, until: EpochMs | null } | null`: the all-lane pause. `until: null` means until `resume()`.
   - `consecutive403` and `consecutive429`: the burst counters, counted across lanes.
   - `lanes`: a partial `Lane` record. A lane that has nothing a restart needs has no entry. Each entry is `{ lastEndAt?, gapJitterMs, backoffUntil?, backoffKind?: 'rate-limited' | 'blocked' | 'server', failures }`, which holds the lane gap, the lane backoff and the exponent n of min(2^n × 30 s, 30 min).
2. **Scheduler behaviour (`src/adapters/sgw/request-scheduler.ts`).**
   - It writes the record on every change: after each request settles, and on `pause()` and `resume()`.
   - It reads the record at construction.
   - On read, a pause or backoff that has already expired is ignored. A live one is merged, keeping whichever is stricter, so refusals carry the correct `retryAfterMs`.
   - A missing record means no pause.
   - An invalid record also means no pause. It is quarantined as a `QuarantineRecord` at `sbw:quarantine:sbw:requestSchedulerState` (generation 0; the record is copied first, then removed, as the Repo does) and flagged with a `{ type: 'state-invalid', key, error }` scheduler event. `sbw:requestBudget` is handled the same way.
   - Persistence is always on; there is no opt-out.
3. **`RequestSchedulerStatsSchema` gains `paused?: { until: EpochMs | null, reason: string }`** (`src/domain/types.ts`).
   - It is present only while every lane is paused. `null` means open-ended: a manual or health pause.
   - A lane's `backoffUntil` now reports only that lane's backoff. A timed pause still raises every lane's `nextAllowedAt`.
   - The `pauseState()` method drafted in T-25 is gone.
   - `health.get`'s `budget` reply (`ReturnType<RequestScheduler['stats']>`) inherits the field.
4. **No migration.** This is a new key with nothing stored under it before, and `sbw:meta.schemaVersion` stays 1 (§2.3: adding a key or an optional field is not a migration).

### Tests and fixtures updated

- `test/contract/types/examples/RequestSchedulerState.{valid,invalid}.json`: new. The invalid example is rejected at `["version"]`.
- `test/contract/types/examples/RequestSchedulerStats.valid.json`: now includes `paused`.
- `test/contract/types/examples.test.ts`: `RequestSchedulerState` added to the locked schema list for `src/domain/storage/schema.ts`.
- `test/contract/types/storage.test.ts`:
  - the new key is in the local-key list and the per-key sample values;
  - a new test checks versioning, the empty and open-ended-pause shapes, and that unknown lanes are rejected.
- `test/contract/types/spec-shapes.test.ts`: `SpecSchedulerStats` gains `paused?`.

**Follow-up for the next PLAN edit.** Add `sbw:requestSchedulerState` to PLAN §2.3's table, and `paused?` to §3.4's `stats()` return type.

## Contract change: Listing.pickupOnly optional (T-24)

`Listing.pickupOnly` becomes `boolean | undefined` (`src/domain/types.ts`); undefined means unknown. `ItemDetail` still requires it (its schema overrides the field).

**Why.** SGW search rows carry no pickup flag, so the adapter had to invent `false`. The rules matcher then showed items that a "hide pickup-only" rule should hide, and matched `pickupOnly: false` conditions it could not know, which can lead to SGW favorite writes.

**Changes.**
- `matcher.ts`: the `pickupOnly` condition returns UNKNOWN when `listing.pickupOnly` is undefined (same pattern as `location`).
- `normalizeSearch` sets `pickupOnly` from the query filter only: `pickupOnly: true` gives true, `excludePickupOnly: true` gives false, neither leaves it unset.
- `test/contract/types/spec-shapes.test.ts`: `SpecListing.pickupOnly` is optional, `SpecItemDetail` requires it.
- Tests: two matcher cases (unknown for both condition values); `test/fakes/ports/fake-shared.test.ts` detail builder now sets `pickupOnly` explicitly.

## T-51 contract change: JobRun.candidates

Approved by the controller on 2026-10-08 (T-51 ruling R5) and made in `task/T-51`.

**Why.** Per-item, per-watch working state must survive service-worker death between ticks.

The daily job runs one SGW request per alarm tick, and the worker dies between ticks. The only state that survives is the persisted `JobRun` (PLAN §2.3: "resumable state lives in the active run"). The two-pass evaluation (rulings R1–R3) has to carry some per-item state from one tick to the next:
- which watch or watches selected an item;
- the search row and the fetched detail, until the item's quote arrives;
- the quote;
- the per-watch ids the run will add to `seenItemIds`.

The frozen `JobRun` had no field for any of this. `Repo.set` parses before writing, so zod strips any extra key. Without per-watch attribution, an item that only a `local` watch found could be favorited on SGW for an `sgw` watch.

### Changes

1. **`JobRun.candidates?: JobCandidate[]`** in `src/domain/watches/schema.ts`. It is optional; runs written before this change have none. Each `JobCandidate` has:
   - `itemId`;
   - `watchIds`: at least one; the watches whose search returned the item and whose optimistic pass selected it;
   - `endTime`;
   - `status`: one of `pending`, `matched`, `rejected`, `skipped-budget` or `failed`;
   - optional `row` (`Listing`) and `detail` (`ItemDetail`). T-51 drops both once the strict pass decides, which keeps `sbw:jobRuns` small;
   - optional `quote`: `{ shipping, handling }`, or `null` when no quote is available;
   - optional `note`.
2. **Exports.** `type JobCandidate` is exported. Its zod schema is module-private and validated only through `JobRunSchema`. Exporting a new `*Schema` would add it to the locked list in `test/contract/types/examples.test.ts` and require example files, which are outside T-51's ownership.
3. **Who reads it.** T-52 reads it through `seenUpdates(run)` (`src/domain/jobs/daily-job.ts`): candidates that are `matched` or `rejected`, grouped per watch, to record with `recordSeen` at the end of the run. Candidates that are `skipped-budget` or `failed` are left out so tomorrow's run retries them. No other card needs to read it.
4. **No migration.** This adds an optional field, and `sbw:meta.schemaVersion` stays 1 (§2.3).

### Tests

- `test/contract/types/spec-shapes.test.ts`:
  - adds `SpecJobCandidate`;
  - `SpecJobRun` gains `candidates?`;
  - asserts `JobCandidate` equals `SpecJobCandidate`.
- `test/unit/domain/jobs/daily-job.test.ts`:
  - **"R5 JobRun.candidates"**: a `Repo.set` → `get` round trip of a run whose candidates include `row`, `detail` and `quote`, which proves nothing is stripped;
  - the property test asserts `JobRunSchema.parse(run)` equals `run` for every finished run.

**Follow-up for the next PLAN edit.** Add `candidates?` to PLAN §3.6 `JobRun` and to contracts.md.
