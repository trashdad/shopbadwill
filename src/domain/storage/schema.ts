// Contract v1 (T-02): PLAN §2.3 storage schema, version 1. Key names, the
// area each key lives in, and the zod schema its record is validated with on
// every read (T-33's repo quarantines an invalid record to
// `sbw:quarantine:<key>` and returns defaults).
//
// The store is versioned as a whole by `sbw:meta.schemaVersion`; Settings
// also carries `schemaVersion: 1` (§3.10). Renaming or re-keying is a
// migration (src/domain/storage/migrations.ts, T-33); adding an optional or
// defaulted field is not. Never `storage.sync`.
import { z } from 'zod';

import { AuditEntrySchema } from '../audit/types';
import { CalendarLinkSchema } from '../calendar/types';
import { RuleSchema } from '../rules/schema';
import { SettingsSchema } from '../settings/schema';
import { EffectSchema, SnipeIdSchema, SnipeSchema } from '../snipe/types';
import {
  CentsSchema,
  ClockSampleSchema,
  EpochMsSchema,
  FavoriteSchema,
  GoogleCredentialsSchema,
  HealthReportSchema,
  ItemDetailSchema,
  ItemIdSchema,
  LaneSchema,
  ListingSchema,
  SgwSessionRecordSchema,
  TrackedItemSchema,
} from '../types';
import { JobRunSchema, WatchSchema } from '../watches/schema';

export const STORAGE_SCHEMA_VERSION = 1;

export const STORAGE_KEYS = {
  meta: 'sbw:meta',
  settings: 'sbw:settings',
  rules: 'sbw:rules',
  watches: 'sbw:watches',
  tracked: 'sbw:tracked',
  listingCache: 'sbw:listingCache',
  detailCache: 'sbw:detailCache',
  shippingCache: 'sbw:shippingCache',
  /** Optional (T-57, ruling R2): landed-cost shipping quotes, keyed by item id. */
  quoteCache: 'sbw:quoteCache',
  /**
   * Optional (T-57 final check): the per-install random key for the quote
   * cache's `zip-hash`, created on first quote. Absent until then; an invalid
   * one is replaced (the cache then misses). No migration; `schemaVersion` stays 1.
   */
  quoteSalt: 'sbw:quoteSalt',
  favoritesCache: 'sbw:favoritesCache',
  jobRuns: 'sbw:jobRuns',
  calendar: 'sbw:calendar',
  /** Optional (T-69): what the ntfy ReminderSink has scheduled, per item. */
  ntfy: 'sbw:ntfy',
  snipes: 'sbw:snipes',
  auditMeta: 'sbw:auditMeta',
  sgwSession: 'sbw:sgwSession',
  sgwSessionRejection: 'sbw:sgwSessionRejection',
  google: 'sbw:google',
  googleClient: 'sbw:googleClient',
  requestBudget: 'sbw:requestBudget',
  requestSchedulerState: 'sbw:requestSchedulerState',
  awake: 'sbw:awake',
  clock: 'sbw:clock',
  googleAccess: 'sbw:googleAccess',
  runtimeHealth: 'sbw:runtimeHealth',
  /** Optional (T-30): the last HealthReport, in local so a failure survives a browser restart. */
  healthReport: 'sbw:healthReport',
  /** Optional (T-30): probe bookkeeping for SgwHealth; local so it survives a restart. */
  healthProbe: 'sbw:healthProbe',
  /**
   * Optional (T-84): the snipe runner's effect outbox and per-snipe bookkeeping.
   * Written in the same `storage.local.set` as `sbw:snipes`. Absent means nothing
   * is pending. No migration; `schemaVersion` stays 1.
   */
  snipeRunner: 'sbw:snipeRunner',
  /**
   * Optional (T-90): snipe ids whose completed dry run already incremented
   * `settings.snipe.completedDryRuns`. Absent means none counted. No migration;
   * `schemaVersion` stays 1. Invalid data parses to the empty record.
   */
  dryRunCounted: 'sbw:dryRunCounted',
  /**
   * Optional (T-111): the wake tasks the T2 companion may hold, per snipe,
   * kept 15 days after the wake for the awake-history filter. Absent means
   * none. No migration; `schemaVersion` stays 1. Invalid data parses to empty.
   */
  companionWakes: 'sbw:companionWakes',
  /**
   * Optional (T-118, L6): the deferred one-shot alarms (quiet-hours digest and
   * outcome notices, auth-health warnings), alarm name -> when. Re-created by
   * the startup reconcile if the browser dropped them; removed when they fire.
   * Absent means none. No migration; `schemaVersion` stays 1.
   */
  deferredAlarms: 'sbw:deferredAlarms',
  /**
   * Optional (T-113): the relist detector's history of public listings seen
   * (item id -> fingerprint, last seen price, last seen time). At most 2,000
   * entries and 60 days, oldest evicted first; written only while
   * `features.relistDetector` is on. Absent means none. No migration;
   * `schemaVersion` stays 1. Invalid data parses to empty.
   */
  relistSeen: 'sbw:relistSeen',
  /**
   * Optional (T-112): the bid groups ("win at most N of these items"), their
   * per-member verdicts and the cancellations they made. Members are the
   * snipes whose `groupId` names the group. Absent means no group. No
   * migration; `schemaVersion` stays 1. Invalid data parses to empty.
   */
  snipeGroups: 'sbw:snipeGroups',
} as const;

/** Audit chunks live at `sbw:audit:<chunk>` (AuditChunkSchema). */
export const AUDIT_CHUNK_KEY_PREFIX = 'sbw:audit:';
export type AuditChunkKey = `sbw:audit:${number}`;

/** An invalid record is moved to `sbw:quarantine:<key>` (QuarantineRecordSchema). */
export const QUARANTINE_KEY_PREFIX = 'sbw:quarantine:';
export type QuarantineKey = `sbw:quarantine:${string}`;

/** §2.3 retention rules, kept by the writers (not enforced by the schemas). */
export const STORAGE_LIMITS = Object.freeze({
  /** AuditEntry[] per `sbw:audit:<chunk>`. */
  auditChunkSize: 500,
  /** Ring of chunks (10,000 entries, §1.8). */
  auditChunkCount: 20,
  /** `sbw:jobRuns` keeps the last 30 runs. */
  jobRunsKept: 30,
  listingCacheTtlMs: 6 * 60 * 60 * 1000,
  detailCacheTtlMs: 6 * 60 * 60 * 1000,
  /** Detail TTL near close. */
  detailCacheNearCloseTtlMs: 60 * 1000,
  shippingCacheTtlMs: 24 * 60 * 60 * 1000,
  /** `sbw:awake` heartbeat history. */
  awakeHistoryDays: 14,
});

// ── Record shapes that §2.3 defines inline ─────────────────────────────────

/** `sbw:meta`. Migrations run before any other read; `migrating` flags a crash mid-migration. */
export const StorageMetaSchema = z.object({
  schemaVersion: z.literal(STORAGE_SCHEMA_VERSION),
  installedAt: EpochMsSchema,
  lastMigrationAt: EpochMsSchema,
  migrating: z.boolean().optional(),
});
export type StorageMeta = z.infer<typeof StorageMetaSchema>;

/** One `sbw:listingCache` entry (6 h TTL; written by the tap and the job). */
export const ListingCacheEntrySchema = z.object({ listing: ListingSchema, expiresAt: EpochMsSchema });
export type ListingCacheEntry = z.infer<typeof ListingCacheEntrySchema>;

/** One `sbw:detailCache` entry (6 h TTL, 60 s near close). */
export const DetailCacheEntrySchema = z.object({ detail: ItemDetailSchema, expiresAt: EpochMsSchema });
export type DetailCacheEntry = z.infer<typeof DetailCacheEntrySchema>;

/** One `sbw:shippingCache` entry, keyed "itemId:zip" (24 h TTL). */
export const ShippingCacheEntrySchema = z.object({
  /**
   * Shipping + handling combined, in cents: the part of the landed cost added
   * to currentPrice (landed cost = currentPrice + shipping + handling, §3.5).
   */
  cents: CentsSchema,
  expiresAt: EpochMsSchema,
});
export type ShippingCacheEntry = z.infer<typeof ShippingCacheEntrySchema>;

/** `sbw:favoritesCache`: one list read per job run. */
export const FavoritesCacheSchema = z.object({ fetchedAt: EpochMsSchema, items: z.array(FavoriteSchema) });
export type FavoritesCache = z.infer<typeof FavoritesCacheSchema>;

/** `sbw:calendar`: event id generations per item. */
export const CalendarStateSchema = z.object({
  /** The dedicated calendar's id (`CalendarSink.ensureCalendar()`); its only home. */
  calendarId: z.string().optional(),
  links: z.record(ItemIdSchema, CalendarLinkSchema),
});
export type CalendarState = z.infer<typeof CalendarStateSchema>;

/** `sbw:audit:<chunk>`. */
export const AuditChunkSchema = z.array(AuditEntrySchema);
export type AuditChunk = z.infer<typeof AuditChunkSchema>;

/**
 * `sbw:ntfy` (T-69, optional): what the ntfy ReminderSink has scheduled, per
 * item. Module-private schema (an exported *Schema would join the locked list
 * in test/contract/types/examples.test.ts). The change is additive and
 * `schemaVersion` stays 1. An invalid record is quarantined by the Repo and
 * reads as empty, so it can never cause a resend storm: the seqs are
 * deterministic, so a re-publish overwrites rather than duplicates.
 */
const NtfyStateSchema = z.object({
  /** Why the sink made no requests the last time it ran; absent when it ran. */
  status: z.enum(['disabled', 'needs-permission']).optional(),
  items: z.record(
    ItemIdSchema,
    z.object({
      /** Stable identity of the event the entries belong to: end time, generation, reminder minutes. */
      fingerprint: z.string().min(1),
      /**
       * T-118 (L4): a short non-reversible tag of the topic the entries were
       * published on (never the topic itself). Absent on records written before it.
       */
      topicTag: z.string().min(1).optional(),
      entries: z.array(
        z.object({
          /** `sbw-<itemId>-<leadMin>-<gen>`; deterministic, so a re-publish overwrites. */
          seq: z.string().min(1),
          leadMin: z.number().int().nonnegative(),
          fireAt: EpochMsSchema,
          status: z.enum(['scheduled', 'deferred']),
        }),
      ),
    }),
  ),
});
export type NtfyState = z.infer<typeof NtfyStateSchema>;

/**
 * Missing or invalid `sbw:ntfy` reads as empty. Callers that cannot see the
 * Repo (the options page) use this so a bad record cannot be treated as a list
 * of messages to send again.
 */
export function parseNtfyState(raw: unknown): NtfyState {
  const parsed = NtfyStateSchema.safeParse(raw);
  return parsed.success ? parsed.data : { items: {} };
}

/** `sbw:auditMeta`: ring bookkeeping. */
export const AuditMetaSchema = z.object({
  nextSeq: z.number().int().nonnegative(),
  head: z.number().int().nonnegative(),
  tail: z.number().int().nonnegative(),
});
export type AuditMeta = z.infer<typeof AuditMetaSchema>;

/**
 * `sbw:requestBudget`; budgets reset at local midnight. `used` is partial: a
 * lane with no requests yet today has no entry (read a missing lane as 0).
 */
export const RequestBudgetSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  used: z.partialRecord(LaneSchema, z.number().int().nonnegative()),
});
export type RequestBudget = z.infer<typeof RequestBudgetSchema>;

/** Version of the `sbw:requestSchedulerState` record; a reader rejects any other. */
export const REQUEST_SCHEDULER_STATE_VERSION = 1;

/**
 * `sbw:requestSchedulerState` (contract change, T-25): what a restarted worker
 * needs so it never forgets a pause or backoff SGW asked for. The scheduler
 * writes it on every change and reads it at construction; a pause or backoff
 * that has already expired is ignored, and a missing or invalid record means
 * no pause (an invalid one is quarantined and flagged).
 */
export const RequestSchedulerStateSchema = z.object({
  version: z.literal(REQUEST_SCHEDULER_STATE_VERSION),
  /** The all-lane pause, or null. `until: null` = until resume() (manual / health). */
  pause: z
    .object({
      cause: z.enum(['manual', 'blocked', 'rate-limited']),
      reason: z.string(),
      until: EpochMsSchema.nullable(),
    })
    .nullable(),
  /** Consecutive 403 answers on any lane (three pause every lane 6 h). */
  consecutive403: z.number().int().nonnegative(),
  /** Consecutive 429 answers on any lane (three pause every lane until the backoff ends). */
  consecutive429: z.number().int().nonnegative(),
  /** Per lane; a lane that never sent has no entry. */
  lanes: z.partialRecord(
    LaneSchema,
    z.object({
      /** When the last request settled; the next one waits out the lane gap from here. */
      lastEndAt: EpochMsSchema.optional(),
      /** Jitter drawn for that gap. */
      gapJitterMs: z.number().int().nonnegative(),
      backoffUntil: EpochMsSchema.optional(),
      /** The error kind a request refused during the backoff gets. */
      backoffKind: z.enum(['rate-limited', 'blocked', 'server']).optional(),
      /** Consecutive 429/5xx on this lane: the n in min(2^n × 30 s, 30 min). */
      failures: z.number().int().nonnegative(),
    }),
  ),
});
export type RequestSchedulerState = z.infer<typeof RequestSchedulerStateSchema>;

/**
 * `sbw:googleClient` (T-70): the OAuth client the user pasted on the options
 * page. Optional; the options page is its only writer, and the background
 * (`clientConfig()`) only reads it, so the token record `sbw:google` has a
 * single writer.
 */
export const GoogleClientSchema = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  updatedAt: EpochMsSchema,
});
export type GoogleClient = z.infer<typeof GoogleClientSchema>;

/**
 * `sbw:healthProbe` (T-30): when SgwHealth last probed (`probedAt`, the only
 * clock for its 6 h / 10 min rules), when each schema check last succeeded
 * (24 h escalation), and the per-endpoint schema failures that stay failing
 * until that endpoint succeeds (`sticky`).
 */
export const HealthProbeSchema = z.object({
  probedAt: EpochMsSchema.nullable(),
  /** Set once, at the first run or recorded failure: the clock for escalating a check that was never good. */
  firstSeenAt: EpochMsSchema.optional(),
  lastGoodProbeAt: z.object({ search: EpochMsSchema.optional(), detail: EpochMsSchema.optional() }),
  sticky: z.array(z.object({ endpoint: z.string().min(1), at: EpochMsSchema, detail: z.string() })),
});
export type HealthProbe = z.infer<typeof HealthProbeSchema>;

/**
 * One snipe's row in `sbw:snipeRunner`. Not exported: an exported `*Schema`
 * joins the locked example list, and the record schema is the contract.
 */
const SnipeRunnerEntrySchema = z.object({
  /** Effects of accepted events not yet executed, in order. */
  outbox: z.array(EffectSchema),
  /** When the T-15 min preflight ran. */
  preflightAt: EpochMsSchema.optional(),
  /** The preflight was "not due" (the end moved later): not before this. */
  preflightNotBefore: EpochMsSchema.optional(),
  /** An AuthHealth failure before T-15 min (the preflight decides). */
  atRisk: z.string().optional(),
  /** Failed outcome (or dry-run measure) reads, and when the last one was tried. */
  readFailures: z.number().int().nonnegative().optional(),
  lastReadAt: EpochMsSchema.optional(),
  /** When the user was told the outcome is unconfirmed. */
  unconfirmedAt: EpochMsSchema.optional(),
});

/**
 * `sbw:snipeRunner` (T-84). Optional. The runner writes this shape and reads it
 * back with the same schema. A record that fails it is not replayed: no outbox
 * means no money effect leaves on restart.
 */
export const SnipeRunnerRecordSchema = z.object({
  version: z.literal(1),
  entries: z.record(SnipeIdSchema, SnipeRunnerEntrySchema),
});
export type SnipeRunnerRecord = z.infer<typeof SnipeRunnerRecordSchema>;

/**
 * `sbw:dryRunCounted` (T-90). Optional. Module-private schema: an exported
 * `*Schema` would join the locked example list. Idempotency for the live-gate
 * counter: snipe id → when it was counted. Invalid data parses to empty
 * (`parseDryRunCounted`); the counter itself refuses to adopt that empty set
 * when a record is present but invalid, so a corrupt set cannot be counted again.
 */
const DryRunCountedRecordSchema = z.object({
  version: z.literal(1),
  counted: z.record(SnipeIdSchema, EpochMsSchema),
});
export type DryRunCountedRecord = z.infer<typeof DryRunCountedRecordSchema>;

/** Missing is empty. Present-but-invalid is `'invalid'` (the counter refuses it). */
export function readDryRunCounted(raw: unknown): DryRunCountedRecord | 'invalid' {
  if (raw === undefined) return { version: 1, counted: {} };
  const parsed = DryRunCountedRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'invalid';
}

/** Missing or invalid `sbw:dryRunCounted` parses to the empty record. */
export function parseDryRunCounted(raw: unknown): DryRunCountedRecord {
  const read = readDryRunCounted(raw);
  return read === 'invalid' ? { version: 1, counted: {} } : read;
}

/** The record the counter is about to store. Throws when it does not match. */
export function checkedDryRunCounted(record: DryRunCountedRecord): DryRunCountedRecord {
  return DryRunCountedRecordSchema.parse(record);
}

/**
 * `sbw:companionWakes` (T-111). Optional. Module-private schema (an exported
 * `*Schema` would join the locked example list). Snipe id → the wake the
 * companion was asked for:
 * - `state`: `confirmed` (the host made the task), `asked` (a `schedule` left
 *   but no usable answer came back: the task may exist), `none` (nothing was
 *   made: not sent, or refused). An entry is written BEFORE the request leaves.
 * - `triedAt` / `cancelTriedAt`: the last schedule / cancel attempt, to space
 *   out retries after a restart.
 * A confirmed cancel removes the entry. Entries stay 15 days after `wakeAt`:
 * the awake history uses `confirmed` and `asked` ones to leave out the runs a
 * companion wake caused.
 */
const CompanionWakesRecordSchema = z.object({
  version: z.literal(1),
  wakes: z.record(
    SnipeIdSchema,
    z.object({
      wakeAt: EpochMsSchema,
      state: z.enum(['confirmed', 'asked', 'none']),
      triedAt: EpochMsSchema,
      cancelTriedAt: EpochMsSchema.optional(),
    }),
  ),
});
export type CompanionWakesRecord = z.infer<typeof CompanionWakesRecordSchema>;

/** Missing or invalid `sbw:companionWakes` parses to the empty record. */
export function parseCompanionWakes(raw: unknown): CompanionWakesRecord {
  const parsed = CompanionWakesRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : { version: 1, wakes: {} };
}

/** T-112: the limits of a bid group, shared by the storage record, the `groups.save` payload and the UI. */
export const SNIPE_GROUP_LIMITS = Object.freeze({
  /** Group ids: 1-64 of `A-Z a-z 0-9 _ -`. */
  idPattern: /^[A-Za-z0-9_-]{1,64}$/,
  nameMax: 80,
  /** N in "win at most N". */
  maxWinsMax: 50,
  /** Stored groups (a create beyond it is refused). */
  groupsMax: 100,
});

/**
 * `sbw:snipeGroups` (T-112). Optional. Module-private schema (an exported
 * `*Schema` would join the locked example list). Group id → the group:
 * - `name`, `maxWins` (N): what the user set; editable until 2 minutes before
 *   the next member's end (the background enforces the freeze).
 * - `results`: per member snipe, what the group concluded about its result.
 *   `checking` (a confirming read is due at `nextAt`), `confirmed` (T-87's
 *   classifier: won and final, on a read after the end; for a dry run, would
 *   have won at the close), `unconfirmed` (it may have been won, but nothing
 *   proves it: the group keeps going), `not-won`. `warned`: the user was told
 *   the group keeps going without a confirmation.
 * - `cancels`: the members the group asked the runner to disarm once N wins
 *   were confirmed; `ok: false` when the runner refused (the bid was out).
 */
const SnipeGroupsRecordSchema = z.object({
  version: z.literal(1),
  groups: z.record(
    z.string().regex(SNIPE_GROUP_LIMITS.idPattern),
    z.object({
      id: z.string().regex(SNIPE_GROUP_LIMITS.idPattern),
      name: z.string().min(1).max(SNIPE_GROUP_LIMITS.nameMax),
      maxWins: z.number().int().min(1).max(SNIPE_GROUP_LIMITS.maxWinsMax),
      createdAt: EpochMsSchema,
      updatedAt: EpochMsSchema,
      results: z.record(
        SnipeIdSchema,
        z.object({
          verdict: z.enum(['checking', 'confirmed', 'unconfirmed', 'not-won']),
          dryRun: z.boolean(),
          at: EpochMsSchema,
          attempts: z.number().int().nonnegative(),
          nextAt: EpochMsSchema.optional(),
          why: z.string(),
          finalPrice: CentsSchema.optional(),
          warned: z.boolean().optional(),
        }),
      ),
      cancels: z.record(SnipeIdSchema, z.object({ at: EpochMsSchema, ok: z.boolean(), why: z.string() })),
    }),
  ),
});
export type SnipeGroupsRecord = z.infer<typeof SnipeGroupsRecordSchema>;
export type SnipeGroup = SnipeGroupsRecord['groups'][string];
export type SnipeGroupResult = SnipeGroup['results'][string];
export type SnipeGroupCancel = SnipeGroup['cancels'][string];

/** Missing or invalid `sbw:snipeGroups` parses to the empty record. */
export function parseSnipeGroups(raw: unknown): SnipeGroupsRecord {
  const parsed = SnipeGroupsRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : { version: 1, groups: {} };
}

/** `sbw:deferredAlarms` (T-118, L6). Optional. Module-private schema. Alarm name -> its `when`. */
const DeferredAlarmsSchema = z.record(z.string().min(1), EpochMsSchema);

/**
 * `sbw:relistSeen` (T-113). Optional. Module-private schema. Item id -> the
 * relist fingerprint (`src/domain/relist/fingerprint.ts`), the last seen
 * current price and when it was seen. Public listing data only: never the
 * user's bids.
 */
const RelistSeenRecordSchema = z.object({
  version: z.literal(1),
  entries: z.record(ItemIdSchema, z.object({ fp: z.string().min(1).max(400), price: CentsSchema, seenAt: EpochMsSchema })),
});
export type RelistSeenRecord = z.infer<typeof RelistSeenRecordSchema>;

/** Missing or invalid `sbw:relistSeen` parses to the empty record. */
export function parseRelistSeen(raw: unknown): RelistSeenRecord {
  const parsed = RelistSeenRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : { version: 1, entries: {} };
}

/** `sbw:googleAccess` (storage.session only; never persisted to disk). */
export const GoogleAccessSchema = z.object({ token: z.string().min(1), expiresAt: EpochMsSchema });
export type GoogleAccess = z.infer<typeof GoogleAccessSchema>;

/** `sbw:quarantine:<key>`: the rejected value and why, shown on the health panel. */
export const QuarantineRecordSchema = z.object({ at: EpochMsSchema, error: z.string(), value: z.unknown() });
export type QuarantineRecord = z.infer<typeof QuarantineRecordSchema>;

// ── Key → area and schema ──────────────────────────────────────────────────

export type StorageArea = 'local' | 'session';

/**
 * Stored at `sbw:sgwSessionRejection` (T-28). Absent means "nothing rejected"
 * (no migration needed). `ids` holds the most recent identities (at most 8) of
 * tokens SGW refused: `jti:<hash of jti>` or `exp:<exp ms>:<hash of token>`.
 * The raw token and the raw jti are never stored. `at` is when the last one was
 * added. Module-private: an exported *Schema would join the locked list in
 * test/contract/types/examples.test.ts.
 */
const SgwSessionRejectionSchema = z.object({ ids: z.array(z.string().min(1)).max(8), at: EpochMsSchema });
export type SgwSessionRejection = z.infer<typeof SgwSessionRejectionSchema>;

/**
 * T-57 contract change (R2): one `sbw:quoteCache` entry, keyed by item id.
 * The 24 h TTL runs from `fetchedAt` (readers compute it; no `expiresAt`).
 * `zip-hash` is the HMAC-SHA-256 hex of the home ZIP under the per-install
 * `sbw:quoteSalt` key: the ZIP itself is never stored, a plain table of the
 * 100 000 five-digit ZIPs cannot reverse it, and a ZIP change misses the
 * cache. Module-private schema, like `SgwSessionRejectionSchema`: exporting it
 * would join the locked list in test/contract/types/examples.test.ts.
 */
const QuoteCacheEntrySchema = z.object({
  shipping: CentsSchema,
  handling: CentsSchema,
  /** T-57b (additive): SGW answered "no quote" for this item and ZIP; shipping and handling are 0 and unused. */
  none: z.literal(true).optional(),
  'zip-hash': z.string().min(1),
  fetchedAt: EpochMsSchema,
});
export type QuoteCacheEntry = z.infer<typeof QuoteCacheEntrySchema>;

/** `sbw:quoteSalt` (T-57 final check): 32 random bytes as lowercase hex. Module-private, as above. */
const QuoteSaltSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const STORAGE_RECORDS = {
  [STORAGE_KEYS.meta]: { area: 'local', schema: StorageMetaSchema },
  [STORAGE_KEYS.settings]: { area: 'local', schema: SettingsSchema },
  [STORAGE_KEYS.rules]: { area: 'local', schema: z.array(RuleSchema) },
  [STORAGE_KEYS.watches]: { area: 'local', schema: z.array(WatchSchema) },
  [STORAGE_KEYS.tracked]: { area: 'local', schema: z.record(ItemIdSchema, TrackedItemSchema) },
  [STORAGE_KEYS.listingCache]: { area: 'local', schema: z.record(ItemIdSchema, ListingCacheEntrySchema) },
  [STORAGE_KEYS.detailCache]: { area: 'local', schema: z.record(ItemIdSchema, DetailCacheEntrySchema) },
  [STORAGE_KEYS.shippingCache]: { area: 'local', schema: z.record(z.string(), ShippingCacheEntrySchema) },
  [STORAGE_KEYS.quoteCache]: { area: 'local', schema: z.record(ItemIdSchema, QuoteCacheEntrySchema) },
  [STORAGE_KEYS.quoteSalt]: { area: 'local', schema: QuoteSaltSchema },
  [STORAGE_KEYS.favoritesCache]: { area: 'local', schema: FavoritesCacheSchema },
  [STORAGE_KEYS.jobRuns]: { area: 'local', schema: z.array(JobRunSchema) },
  [STORAGE_KEYS.calendar]: { area: 'local', schema: CalendarStateSchema },
  [STORAGE_KEYS.ntfy]: { area: 'local', schema: NtfyStateSchema },
  [STORAGE_KEYS.snipes]: { area: 'local', schema: z.record(SnipeIdSchema, SnipeSchema) },
  [STORAGE_KEYS.auditMeta]: { area: 'local', schema: AuditMetaSchema },
  [STORAGE_KEYS.sgwSession]: { area: 'local', schema: SgwSessionRecordSchema },
  [STORAGE_KEYS.sgwSessionRejection]: { area: 'local', schema: SgwSessionRejectionSchema },
  [STORAGE_KEYS.google]: { area: 'local', schema: GoogleCredentialsSchema },
  [STORAGE_KEYS.googleClient]: { area: 'local', schema: GoogleClientSchema },
  [STORAGE_KEYS.requestBudget]: { area: 'local', schema: RequestBudgetSchema },
  [STORAGE_KEYS.requestSchedulerState]: { area: 'local', schema: RequestSchedulerStateSchema },
  [STORAGE_KEYS.awake]: { area: 'local', schema: z.array(EpochMsSchema) },
  [STORAGE_KEYS.clock]: { area: 'session', schema: z.array(ClockSampleSchema) },
  [STORAGE_KEYS.googleAccess]: { area: 'session', schema: GoogleAccessSchema },
  [STORAGE_KEYS.runtimeHealth]: { area: 'session', schema: HealthReportSchema },
  [STORAGE_KEYS.healthReport]: { area: 'local', schema: HealthReportSchema },
  [STORAGE_KEYS.healthProbe]: { area: 'local', schema: HealthProbeSchema },
  [STORAGE_KEYS.snipeRunner]: { area: 'local', schema: SnipeRunnerRecordSchema },
  [STORAGE_KEYS.dryRunCounted]: { area: 'local', schema: DryRunCountedRecordSchema },
  [STORAGE_KEYS.companionWakes]: { area: 'local', schema: CompanionWakesRecordSchema },
  [STORAGE_KEYS.deferredAlarms]: { area: 'local', schema: DeferredAlarmsSchema },
  [STORAGE_KEYS.relistSeen]: { area: 'local', schema: RelistSeenRecordSchema },
  [STORAGE_KEYS.snipeGroups]: { area: 'local', schema: SnipeGroupsRecordSchema },
} as const satisfies Record<string, { area: StorageArea; schema: z.ZodType }>;

export type StorageKey = keyof typeof STORAGE_RECORDS;
export type StorageValue<K extends StorageKey> = z.infer<(typeof STORAGE_RECORDS)[K]['schema']>;
