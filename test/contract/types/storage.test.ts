// §2.3 storage schema, version 1: key names, areas, per-key record schemas.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';

import {
  AUDIT_CHUNK_KEY_PREFIX,
  AuditChunkSchema,
  CalendarStateSchema,
  QUARANTINE_KEY_PREFIX,
  QuarantineRecordSchema,
  REQUEST_SCHEDULER_STATE_VERSION,
  RequestBudgetSchema,
  RequestSchedulerStateSchema,
  parseCompanionWakes,
  parseRelistSeen,
  parseDryRunCounted,
  STORAGE_KEYS,
  STORAGE_LIMITS,
  STORAGE_RECORDS,
  STORAGE_SCHEMA_VERSION,
  StorageMetaSchema,
  type RequestBudget,
} from '../../../src/domain/storage/schema';
import { GoogleCredentialsSchema, type Lane } from '../../../src/domain/types';

const EXAMPLES_DIR = path.join(import.meta.dirname, 'examples');
const example = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(EXAMPLES_DIR, `${name}.valid.json`), 'utf8'));

// §2.3, in table order.
const LOCAL_KEYS = [
  'sbw:meta',
  'sbw:settings',
  'sbw:rules',
  'sbw:watches',
  'sbw:tracked',
  'sbw:listingCache',
  'sbw:detailCache',
  'sbw:shippingCache',
  'sbw:quoteCache',
  'sbw:quoteSalt',
  'sbw:favoritesCache',
  'sbw:jobRuns',
  'sbw:calendar',
  'sbw:ntfy',
  'sbw:snipes',
  'sbw:auditMeta',
  'sbw:sgwSession',
  'sbw:sgwSessionRejection',
  'sbw:google',
  'sbw:googleClient',
  'sbw:requestBudget',
  'sbw:requestSchedulerState',
  'sbw:awake',
  'sbw:healthReport',
  'sbw:healthProbe',
  'sbw:snipeRunner',
  'sbw:dryRunCounted',
  'sbw:companionWakes',
  'sbw:deferredAlarms',
  'sbw:relistSeen',
];
const SESSION_KEYS = ['sbw:clock', 'sbw:googleAccess', 'sbw:runtimeHealth'];

// One valid value per key, built from the per-type examples.
const SAMPLE_VALUES: Record<string, unknown> = {
  'sbw:meta': example('StorageMeta'),
  'sbw:settings': example('Settings'),
  'sbw:rules': [example('Rule')],
  'sbw:watches': [example('Watch')],
  'sbw:tracked': { '279250057': example('TrackedItem') },
  'sbw:listingCache': { '279250057': example('ListingCacheEntry') },
  'sbw:detailCache': { '279250057': example('DetailCacheEntry') },
  'sbw:shippingCache': { '279250057:14201': example('ShippingCacheEntry') },
  // T-57 (R2): the ZIP lives only as a hash; the 24 h TTL runs from fetchedAt.
  'sbw:quoteCache': { '279250057': { shipping: 500, handling: 100, 'zip-hash': 'a'.repeat(64), fetchedAt: 1791400000000 } },
  // T-57 final check: the per-install key for that hash (32 random bytes, hex).
  'sbw:quoteSalt': '0f'.repeat(32),
  'sbw:favoritesCache': example('FavoritesCache'),
  'sbw:jobRuns': [example('JobRun')],
  'sbw:calendar': example('CalendarState'),
  'sbw:ntfy': {
    status: 'disabled',
    items: {
      '279250057': {
        fingerprint: '2026-10-08T02:18:30.000Z|0|60,15,5',
        entries: [
          { seq: 'sbw-279250057-15-0', leadMin: 15, fireAt: 1791397110000, status: 'scheduled' },
          { seq: 'sbw-279250057-60-0', leadMin: 60, fireAt: 1791394410000, status: 'deferred' },
        ],
      },
    },
  },
  'sbw:snipes': { 'snp-1': example('Snipe') },
  'sbw:auditMeta': example('AuditMeta'),
  'sbw:sgwSession': example('SgwSessionRecord'),
  'sbw:sgwSessionRejection': { ids: ['jti:' + 'a'.repeat(64)], at: 1791400000000 },
  'sbw:google': example('GoogleCredentials'),
  'sbw:googleClient': { clientId: '123456789012-abc.apps.googleusercontent.com', clientSecret: 'x', updatedAt: 1791400000000 },
  'sbw:requestBudget': example('RequestBudget'),
  'sbw:requestSchedulerState': example('RequestSchedulerState'),
  'sbw:awake': [1791400000000, 1791400300000],
  'sbw:clock': [example('ClockSample')],
  'sbw:googleAccess': example('GoogleAccess'),
  'sbw:runtimeHealth': example('HealthReport'),
  'sbw:healthReport': example('HealthReport'),
  'sbw:healthProbe': {
    probedAt: 1791400000000,
    firstSeenAt: 1791300000000,
    lastGoodProbeAt: { search: 1791400000000 },
    sticky: [{ endpoint: 'favorites', at: 1791400000000, detail: 'bad rows' }],
  },
  'sbw:snipeRunner': example('SnipeRunnerRecord'),
  'sbw:dryRunCounted': { version: 1, counted: { 'snp-1': 1791400000000 } },
  // T-111: the wakes the T2 companion may hold (snipe id -> wake), kept 15 days for the awake history.
  'sbw:companionWakes': { version: 1, wakes: { 'snp-1': { wakeAt: 1791400000000, state: 'confirmed', triedAt: 1791390000000 } } },
  // T-118 (L6): deferred one-shot alarms (name -> when), re-created at startup if the browser dropped them.
  'sbw:deferredAlarms': { 'sbw:notify:digest:run-1': 1791400000000 },
  // T-113: the relist detector's history of public listings (item id -> fingerprint, last price, last seen).
  'sbw:relistSeen': { version: 1, entries: { '279250057': { fp: '42|pyrex bowl|abc.jpg', price: 1299, seenAt: 1791400000000 } } },
};

describe('storage schema v1', () => {
  it('is version 1', () => {
    expect(STORAGE_SCHEMA_VERSION).toBe(1);
  });

  it('names exactly the §2.3 keys', () => {
    expect(Object.values(STORAGE_KEYS).sort()).toEqual([...LOCAL_KEYS, ...SESSION_KEYS].sort());
    expect(Object.keys(STORAGE_RECORDS).sort()).toEqual([...LOCAL_KEYS, ...SESSION_KEYS].sort());
  });

  it('puts clock, googleAccess and runtimeHealth in storage.session and the rest in storage.local', () => {
    for (const key of LOCAL_KEYS) expect(STORAGE_RECORDS[key as keyof typeof STORAGE_RECORDS].area, key).toBe('local');
    for (const key of SESSION_KEYS) {
      expect(STORAGE_RECORDS[key as keyof typeof STORAGE_RECORDS].area, key).toBe('session');
    }
  });

  it('names the dynamic audit-chunk and quarantine keys', () => {
    expect(AUDIT_CHUNK_KEY_PREFIX).toBe('sbw:audit:');
    expect(QUARANTINE_KEY_PREFIX).toBe('sbw:quarantine:');
    expect(AuditChunkSchema.safeParse(example('AuditChunk')).success).toBe(true);
    expect(QuarantineRecordSchema.safeParse(example('QuarantineRecord')).success).toBe(true);
  });

  it('validates a sample record for every key', () => {
    for (const [key, spec] of Object.entries(STORAGE_RECORDS)) {
      const result = spec.schema.safeParse(SAMPLE_VALUES[key]);
      if (!result.success) expect.fail(`${key}:\n${z.prettifyError(result.error)}`);
    }
  });

  it('keeps the options-page Google client in its own optional record (T-70)', () => {
    const schema = STORAGE_RECORDS[STORAGE_KEYS.googleClient].schema;
    expect(schema.safeParse({ clientId: 'a', updatedAt: 1 }).success).toBe(true);
    expect(schema.safeParse({ clientId: '', updatedAt: 1 }).success).toBe(false);
    expect(schema.safeParse({ clientId: 'a' }).success).toBe(false);
  });

  it('keys ItemId records by positive integer ids', () => {
    const tracked = STORAGE_RECORDS[STORAGE_KEYS.tracked].schema;
    expect(tracked.safeParse({ abc: example('TrackedItem') }).success).toBe(false);
  });

  it('accepts a request budget that has used only some lanes, and rejects unknown lanes', () => {
    const day = '2026-10-07';
    expect(RequestBudgetSchema.parse({ day, used: {} })).toEqual({ day, used: {} });
    expect(RequestBudgetSchema.parse({ day, used: { snipe: 3 } })).toEqual({ day, used: { snipe: 3 } });
    const full = { day, used: { interactive: 12, background: 20, snipe: 0, canary: 1 } };
    expect(RequestBudgetSchema.parse(full)).toEqual(full);
    expect(RequestBudgetSchema.safeParse({ day, used: { bulk: 1 } }).success).toBe(false);
    expectTypeOf<RequestBudget['used']>().toEqualTypeOf<Partial<Record<Lane, number>>>();
  });

  it('versions the request scheduler state and keeps it minimal (T-25 contract change)', () => {
    const valid = example('RequestSchedulerState') as Record<string, unknown>;
    expect(REQUEST_SCHEDULER_STATE_VERSION).toBe(1);
    expect(RequestSchedulerStateSchema.safeParse({ ...valid, version: 2 }).success).toBe(false);
    const empty = { version: 1, pause: null, consecutive403: 0, consecutive429: 0, lanes: {} };
    expect(RequestSchedulerStateSchema.parse(empty)).toEqual(empty);
    const manual = { ...empty, pause: { cause: 'manual', reason: 'health check failed', until: null } };
    expect(RequestSchedulerStateSchema.parse(manual)).toEqual(manual);
    expect(RequestSchedulerStateSchema.safeParse({ ...empty, lanes: { bulk: { gapJitterMs: 0, failures: 0 } } }).success).toBe(
      false,
    );
  });

  it('keeps calendarId in one place: sbw:calendar, not the Google credentials', () => {
    const credentials = { ...(example('GoogleCredentials') as object), calendarId: 'example@group.calendar.google.com' };
    expect(GoogleCredentialsSchema.parse(credentials)).not.toHaveProperty('calendarId');
    expect(CalendarStateSchema.parse(example('CalendarState'))).toHaveProperty('calendarId');
  });

  it('registers the optional dry-run counted record; invalid data parses to empty (T-90)', () => {
    const spec = STORAGE_RECORDS[STORAGE_KEYS.dryRunCounted];
    expect(spec.area).toBe('local');
    expect(spec.schema.safeParse({ version: 1, counted: {} }).success).toBe(true);
    expect(spec.schema.safeParse({ version: 1, counted: { 'snp-1': 1791400000000 } }).success).toBe(true);
    // The strict schema still rejects, so a typed repo read can quarantine.
    expect(spec.schema.safeParse({ version: 2, counted: {} }).success).toBe(false);
    expect(spec.schema.safeParse({ version: 1, counted: { 'snp-1': -1 } }).success).toBe(false);
    // Missing or invalid parses to the empty record. No migration; schemaVersion stays 1.
    expect(parseDryRunCounted(undefined)).toEqual({ version: 1, counted: {} });
    expect(parseDryRunCounted({ version: 2, nope: true })).toEqual({ version: 1, counted: {} });
    expect(parseDryRunCounted({ junk: true })).toEqual({ version: 1, counted: {} });
    expect(parseDryRunCounted({ version: 1, counted: { 'snp-1': 1791400000000 } })).toEqual({
      version: 1,
      counted: { 'snp-1': 1791400000000 },
    });
  });

  it('registers the optional companion wake record; invalid data parses to empty (T-111)', () => {
    const spec = STORAGE_RECORDS[STORAGE_KEYS.companionWakes];
    expect(STORAGE_KEYS.companionWakes).toBe('sbw:companionWakes');
    expect(spec.area).toBe('local');
    const entry = { wakeAt: 1791400000000, state: 'asked', triedAt: 1791390000000, cancelTriedAt: 1791395000000 };
    expect(spec.schema.safeParse({ version: 1, wakes: { 'snp-1': entry } }).success).toBe(true);
    expect(spec.schema.safeParse({ version: 2, wakes: {} }).success).toBe(false);
    expect(spec.schema.safeParse({ version: 1, wakes: { 'snp-1': { ...entry, state: 'maybe' } } }).success).toBe(false);
    expect(spec.schema.safeParse({ version: 1, wakes: { 'snp-1': { wakeAt: 1791400000000 } } }).success).toBe(false);
    // Missing or invalid parses to the empty record. No migration; schemaVersion stays 1.
    expect(parseCompanionWakes(undefined)).toEqual({ version: 1, wakes: {} });
    expect(parseCompanionWakes({ version: 1, wakes: 'x' })).toEqual({ version: 1, wakes: {} });
    expect(parseCompanionWakes({ version: 1, wakes: { 'snp-1': entry } })).toEqual({ version: 1, wakes: { 'snp-1': entry } });
  });

  it('registers the optional deferred-alarm record: alarm name -> when (T-118 L6)', () => {
    const spec = STORAGE_RECORDS[STORAGE_KEYS.deferredAlarms];
    expect(STORAGE_KEYS.deferredAlarms).toBe('sbw:deferredAlarms');
    expect(spec.area).toBe('local');
    expect(spec.schema.safeParse({}).success).toBe(true);
    expect(spec.schema.safeParse({ 'sbw:notify:outcome:28': 1791400000000 }).success).toBe(true);
    expect(spec.schema.safeParse({ 'sbw:notify:outcome:28': -1 }).success).toBe(false);
    expect(spec.schema.safeParse({ '': 1791400000000 }).success).toBe(false);
  });

  it('registers the optional relist history: item id -> { fp, price, seenAt }, invalid parses empty (T-113)', () => {
    const spec = STORAGE_RECORDS[STORAGE_KEYS.relistSeen];
    expect(STORAGE_KEYS.relistSeen).toBe('sbw:relistSeen');
    expect(spec.area).toBe('local');
    const entry = { fp: '42|pyrex bowl|abc.jpg', price: 1299, seenAt: 1791400000000 };
    expect(spec.schema.safeParse({ version: 1, entries: {} }).success).toBe(true);
    expect(spec.schema.safeParse({ version: 1, entries: { '279250057': entry } }).success).toBe(true);
    expect(spec.schema.safeParse({ version: 1, entries: { '279250057': { ...entry, price: -1 } } }).success).toBe(false);
    expect(spec.schema.safeParse({ version: 1, entries: { '279250057': { ...entry, fp: '' } } }).success).toBe(false);
    expect(parseRelistSeen({ version: 2 })).toEqual({ version: 1, entries: {} });
    expect(parseRelistSeen(undefined)).toEqual({ version: 1, entries: {} });
  });

  it('registers the optional quote salt: 64 lowercase hex, nothing else (T-57 final check)', () => {
    const spec = STORAGE_RECORDS[STORAGE_KEYS.quoteSalt];
    expect(STORAGE_KEYS.quoteSalt).toBe('sbw:quoteSalt');
    expect(spec.area).toBe('local');
    expect(spec.schema.safeParse('0f'.repeat(32)).success).toBe(true);
    // Rejected, so a typed repo read quarantines it and a fresh salt is made.
    for (const bad of ['', '43004', 'AB'.repeat(32), '0f'.repeat(31), '0f'.repeat(33), 42, null]) {
      expect(spec.schema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });

  it('registers the optional snipe-runner record and rejects one that cannot be replayed (T-84)', () => {
    const schema = STORAGE_RECORDS[STORAGE_KEYS.snipeRunner].schema;
    expect(STORAGE_RECORDS[STORAGE_KEYS.snipeRunner].area).toBe('local');
    expect(schema.safeParse({ version: 1, entries: {} }).success).toBe(true);
    expect(schema.safeParse({ version: 2, entries: {} }).success).toBe(false);
    expect(schema.safeParse({ version: 1, entries: { s1: { outbox: 'not-an-array' } } }).success).toBe(false);
  });

  it('versions the store through sbw:meta.schemaVersion', () => {
    expect(StorageMetaSchema.safeParse({ ...(example('StorageMeta') as object), schemaVersion: 2 }).success).toBe(false);
  });

  it('records the §2.3 retention limits', () => {
    expect(STORAGE_LIMITS).toEqual({
      auditChunkSize: 500,
      auditChunkCount: 20,
      jobRunsKept: 30,
      listingCacheTtlMs: 6 * 60 * 60 * 1000,
      detailCacheTtlMs: 6 * 60 * 60 * 1000,
      detailCacheNearCloseTtlMs: 60 * 1000,
      shippingCacheTtlMs: 24 * 60 * 60 * 1000,
      awakeHistoryDays: 14,
    });
  });
});
