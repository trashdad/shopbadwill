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
import { SnipeIdSchema, SnipeSchema } from '../snipe/types';
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
  favoritesCache: 'sbw:favoritesCache',
  jobRuns: 'sbw:jobRuns',
  calendar: 'sbw:calendar',
  snipes: 'sbw:snipes',
  auditMeta: 'sbw:auditMeta',
  sgwSession: 'sbw:sgwSession',
  google: 'sbw:google',
  requestBudget: 'sbw:requestBudget',
  awake: 'sbw:awake',
  clock: 'sbw:clock',
  googleAccess: 'sbw:googleAccess',
  runtimeHealth: 'sbw:runtimeHealth',
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
export const ShippingCacheEntrySchema = z.object({ cents: CentsSchema, expiresAt: EpochMsSchema });
export type ShippingCacheEntry = z.infer<typeof ShippingCacheEntrySchema>;

/** `sbw:favoritesCache`: one list read per job run. */
export const FavoritesCacheSchema = z.object({ fetchedAt: EpochMsSchema, items: z.array(FavoriteSchema) });
export type FavoritesCache = z.infer<typeof FavoritesCacheSchema>;

/** `sbw:calendar`: event id generations per item. */
export const CalendarStateSchema = z.object({
  calendarId: z.string().optional(),
  links: z.record(ItemIdSchema, CalendarLinkSchema),
});
export type CalendarState = z.infer<typeof CalendarStateSchema>;

/** `sbw:audit:<chunk>`. */
export const AuditChunkSchema = z.array(AuditEntrySchema);
export type AuditChunk = z.infer<typeof AuditChunkSchema>;

/** `sbw:auditMeta`: ring bookkeeping. */
export const AuditMetaSchema = z.object({
  nextSeq: z.number().int().nonnegative(),
  head: z.number().int().nonnegative(),
  tail: z.number().int().nonnegative(),
});
export type AuditMeta = z.infer<typeof AuditMetaSchema>;

/** `sbw:requestBudget`; budgets reset at local midnight. */
export const RequestBudgetSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  used: z.record(LaneSchema, z.number().int().nonnegative()),
});
export type RequestBudget = z.infer<typeof RequestBudgetSchema>;

/** `sbw:googleAccess` (storage.session only; never persisted to disk). */
export const GoogleAccessSchema = z.object({ token: z.string().min(1), expiresAt: EpochMsSchema });
export type GoogleAccess = z.infer<typeof GoogleAccessSchema>;

/** `sbw:quarantine:<key>`: the rejected value and why, shown on the health panel. */
export const QuarantineRecordSchema = z.object({ at: EpochMsSchema, error: z.string(), value: z.unknown() });
export type QuarantineRecord = z.infer<typeof QuarantineRecordSchema>;

// ── Key → area and schema ──────────────────────────────────────────────────

export type StorageArea = 'local' | 'session';

export const STORAGE_RECORDS = {
  [STORAGE_KEYS.meta]: { area: 'local', schema: StorageMetaSchema },
  [STORAGE_KEYS.settings]: { area: 'local', schema: SettingsSchema },
  [STORAGE_KEYS.rules]: { area: 'local', schema: z.array(RuleSchema) },
  [STORAGE_KEYS.watches]: { area: 'local', schema: z.array(WatchSchema) },
  [STORAGE_KEYS.tracked]: { area: 'local', schema: z.record(ItemIdSchema, TrackedItemSchema) },
  [STORAGE_KEYS.listingCache]: { area: 'local', schema: z.record(ItemIdSchema, ListingCacheEntrySchema) },
  [STORAGE_KEYS.detailCache]: { area: 'local', schema: z.record(ItemIdSchema, DetailCacheEntrySchema) },
  [STORAGE_KEYS.shippingCache]: { area: 'local', schema: z.record(z.string(), ShippingCacheEntrySchema) },
  [STORAGE_KEYS.favoritesCache]: { area: 'local', schema: FavoritesCacheSchema },
  [STORAGE_KEYS.jobRuns]: { area: 'local', schema: z.array(JobRunSchema) },
  [STORAGE_KEYS.calendar]: { area: 'local', schema: CalendarStateSchema },
  [STORAGE_KEYS.snipes]: { area: 'local', schema: z.record(SnipeIdSchema, SnipeSchema) },
  [STORAGE_KEYS.auditMeta]: { area: 'local', schema: AuditMetaSchema },
  [STORAGE_KEYS.sgwSession]: { area: 'local', schema: SgwSessionRecordSchema },
  [STORAGE_KEYS.google]: { area: 'local', schema: GoogleCredentialsSchema },
  [STORAGE_KEYS.requestBudget]: { area: 'local', schema: RequestBudgetSchema },
  [STORAGE_KEYS.awake]: { area: 'local', schema: z.array(EpochMsSchema) },
  [STORAGE_KEYS.clock]: { area: 'session', schema: z.array(ClockSampleSchema) },
  [STORAGE_KEYS.googleAccess]: { area: 'session', schema: GoogleAccessSchema },
  [STORAGE_KEYS.runtimeHealth]: { area: 'session', schema: HealthReportSchema },
} as const satisfies Record<string, { area: StorageArea; schema: z.ZodType }>;

export type StorageKey = keyof typeof STORAGE_RECORDS;
export type StorageValue<K extends StorageKey> = z.infer<(typeof STORAGE_RECORDS)[K]['schema']>;
