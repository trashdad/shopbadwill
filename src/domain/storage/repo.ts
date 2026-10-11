// T-33: the typed Repo over StorageAreas (PLAN §2.3). Every durable read goes
// through here: records are validated with the key's zod schema, an invalid
// record is moved to `sbw:quarantine:<key>` and replaced by its default, and
// the audit "ring" (20 chunks of 500) and the TTL caches are kept within
// quota. Never `storage.sync`: only `local` and `session` exist on the port.
import { z } from 'zod';

import type { Clock } from '../../ports/clock';
import type { Storage, StorageAreas } from '../../ports/storage';
import type { AuditEntry } from '../audit/types';
import { defaultSettings } from '../settings/defaults';
import type { EpochMs } from '../types';
import {
  AUDIT_CHUNK_KEY_PREFIX,
  AuditChunkSchema,
  type AuditChunkKey,
  type AuditMeta,
  AuditMetaSchema,
  QUARANTINE_KEY_PREFIX,
  type QuarantineKey,
  type QuarantineRecord,
  QuarantineRecordSchema,
  STORAGE_KEYS,
  STORAGE_LIMITS,
  STORAGE_RECORDS,
  type StorageArea,
  type StorageKey,
  type StorageValue,
} from './schema';

/** Keys whose absence (or corruption) yields a default value. */
const DEFAULTS = {
  [STORAGE_KEYS.settings]: () => defaultSettings(),
  [STORAGE_KEYS.rules]: () => [],
  [STORAGE_KEYS.watches]: () => [],
  [STORAGE_KEYS.tracked]: () => ({}),
  [STORAGE_KEYS.listingCache]: () => ({}),
  [STORAGE_KEYS.detailCache]: () => ({}),
  [STORAGE_KEYS.shippingCache]: () => ({}),
  [STORAGE_KEYS.favoritesCache]: () => ({ fetchedAt: 0, items: [] }),
  [STORAGE_KEYS.jobRuns]: () => [],
  [STORAGE_KEYS.calendar]: () => ({ links: {} }),
  [STORAGE_KEYS.snipes]: () => ({}),
  [STORAGE_KEYS.auditMeta]: () => ({ nextSeq: 1, head: 0, tail: 0 }),
  [STORAGE_KEYS.requestBudget]: () => ({ day: '1970-01-01', used: {} }),
  [STORAGE_KEYS.awake]: () => [],
  [STORAGE_KEYS.clock]: () => [],
} as const satisfies Partial<{ [K in StorageKey]: () => StorageValue<K> }>;

export type DefaultedKey = keyof typeof DEFAULTS;
export type CacheKey = typeof STORAGE_KEYS.listingCache | typeof STORAGE_KEYS.detailCache | typeof STORAGE_KEYS.shippingCache;

/** The entry type of a cache key's record. */
export type CacheEntryOf<K extends CacheKey> = StorageValue<K> extends Record<string, infer V> ? V : never;

const CACHE_KEYS: readonly CacheKey[] = [STORAGE_KEYS.listingCache, STORAGE_KEYS.detailCache, STORAGE_KEYS.shippingCache];

/**
 * Entry caps per cache (quota guard: the extension has the 10 MB default and
 * never asks for unlimitedStorage). Expired entries go first, then the ones
 * closest to expiry.
 */
export const CACHE_MAX_ENTRIES: Readonly<Record<CacheKey, number>> = Object.freeze({
  [STORAGE_KEYS.listingCache]: 1000,
  [STORAGE_KEYS.detailCache]: 200,
  [STORAGE_KEYS.shippingCache]: 1000,
});

/** Quarantine generations kept per key (newest first), so a repeat corruption never destroys an earlier record. */
export const QUARANTINE_KEEP = 3;

/** Internal recency list (oldest first) per cache, since JS objects order integer-like keys numerically. */
const CACHE_ORDER_PREFIX = 'sbw:cacheOrder:';

type Entries = Record<string, { expiresAt: number }>;

export interface QuarantinedItem {
  /** The original key (without the quarantine prefix). */
  key: string;
  /** 0 is the newest quarantined record, 1 the one before it, and so on. */
  generation: number;
  record: QuarantineRecord;
}

export class Repo {
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly areas: StorageAreas,
    private readonly clock: Clock,
  ) {}

  now(): EpochMs {
    return this.clock.now();
  }

  // ── typed records ────────────────────────────────────────────────────────

  /** Validated read; missing or invalid yields the key's default (invalid is quarantined first). */
  async get<K extends DefaultedKey>(key: K): Promise<StorageValue<K>> {
    const found = await this.find(key);
    return found !== undefined ? found : (DEFAULTS[key]() as StorageValue<K>);
  }

  /** Validated read with no default: undefined when missing or invalid (invalid is quarantined). */
  async find<K extends StorageKey>(key: K): Promise<StorageValue<K> | undefined> {
    const { area, schema } = STORAGE_RECORDS[key];
    return this.readValidated(this.area(area), key, schema) as Promise<StorageValue<K> | undefined>;
  }

  /** Validates, then writes. A value that fails its schema throws and nothing is written. */
  async set<K extends StorageKey>(key: K, value: StorageValue<K>): Promise<void> {
    const { area, schema } = STORAGE_RECORDS[key];
    const parsed = (schema as z.ZodType).parse(value);
    await this.area(area).set({ [key]: parsed });
  }

  /** Serialised read-modify-write. `fn` returns the next value (it may mutate and return its argument). */
  update<K extends DefaultedKey>(key: K, fn: (current: StorageValue<K>) => StorageValue<K>): Promise<StorageValue<K>> {
    return this.withLock(key, async () => {
      const next = fn(await this.get(key));
      await this.set(key, next);
      return next;
    });
  }

  async remove(key: StorageKey): Promise<void> {
    await this.area(STORAGE_RECORDS[key].area).remove([key]);
  }

  /** Unvalidated access for migrations and meta bookkeeping. */
  async getRaw(key: StorageKey): Promise<unknown> {
    return this.area(STORAGE_RECORDS[key].area).get<unknown>(key);
  }

  async setRaw(key: StorageKey, value: unknown): Promise<void> {
    await this.area(STORAGE_RECORDS[key].area).set({ [key]: value });
  }

  /** Serialises async work per name (read-modify-write on the same record). */
  withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(name) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    this.locks.set(name, tail);
    void tail.then(() => {
      if (this.locks.get(name) === tail) this.locks.delete(name);
    });
    return run;
  }

  // ── quarantine ───────────────────────────────────────────────────────────

  /** Records quarantined under the known keys and audit slots (for the health panel). */
  async listQuarantined(): Promise<QuarantinedItem[]> {
    const keys: string[] = [
      ...Object.keys(STORAGE_RECORDS),
      ...Array.from({ length: STORAGE_LIMITS.auditChunkCount }, (_, i) => auditChunkKey(i)),
    ];
    const out: QuarantinedItem[] = [];
    for (const key of keys) {
      for (const storage of [this.areas.local, this.areas.session]) {
        for (let generation = 0; generation < QUARANTINE_KEEP; generation++) {
          const raw = await storage.get<unknown>(quarantineGenKey(key, generation));
          const parsed = QuarantineRecordSchema.safeParse(raw);
          if (parsed.success) out.push({ key, generation, record: parsed.data });
        }
      }
    }
    return out;
  }

  async clearQuarantine(key: string): Promise<void> {
    const keys = Array.from({ length: QUARANTINE_KEEP }, (_, g) => quarantineGenKey(key, g));
    await Promise.all([this.areas.local.remove(keys), this.areas.session.remove(keys)]);
  }

  /** Quarantines whatever is stored under `key` now (full value kept) and removes it. No-op when empty. */
  async quarantineStored(key: StorageKey, error: string): Promise<void> {
    const storage = this.area(STORAGE_RECORDS[key].area);
    const raw = await storage.get<unknown>(key);
    if (raw !== undefined) await this.quarantine(storage, key, raw, error);
  }

  /**
   * Non-destructive scan of every stored record except `sbw:meta` (audit slots
   * included): which exist, and which fail their schema. Nothing is quarantined.
   */
  async inspectStored(): Promise<{ present: string[]; invalid: string[] }> {
    const present: string[] = [];
    const invalid: string[] = [];
    const check = async (storage: Storage, key: string, schema: z.ZodType) => {
      const raw = await storage.get<unknown>(key);
      if (raw === undefined) return;
      present.push(key);
      if (!schema.safeParse(raw).success) invalid.push(key);
    };
    for (const [key, rec] of Object.entries(STORAGE_RECORDS)) {
      if (key !== STORAGE_KEYS.meta) await check(this.area(rec.area), key, rec.schema);
    }
    for (let i = 0; i < STORAGE_LIMITS.auditChunkCount; i++) await check(this.areas.local, auditChunkKey(i), AuditChunkSchema);
    return { present, invalid };
  }

  // ── audit ring ───────────────────────────────────────────────────────────
  //
  // Chunk numbers grow monotonically: `head` is the chunk being filled and
  // `tail` the oldest kept; chunk n lives at `sbw:audit:<n % 20>`. Starting a
  // chunk when 20 are held overwrites the oldest slot (the ring wraps).

  /** Appends an entry (stamping `seq` and `at`), rolling and wrapping chunks as needed. */
  appendAudit(e: Omit<AuditEntry, 'seq' | 'at'>): Promise<AuditEntry> {
    return this.withLock('audit', async () => {
      const meta = await this.loadAuditMeta();
      let { head, tail } = meta;
      let chunk = await this.readAuditChunk(head);
      // A crash between the chunk write and the meta write leaves the chunk ahead of the meta.
      const last = chunk[chunk.length - 1];
      const seq = Math.max(meta.nextSeq, last ? last.seq + 1 : 0);
      if (chunk.length >= STORAGE_LIMITS.auditChunkSize) {
        head += 1;
        chunk = [];
        if (head - tail >= STORAGE_LIMITS.auditChunkCount) tail = head - STORAGE_LIMITS.auditChunkCount + 1;
      }
      const entry: AuditEntry = { ...structuredClone(e), seq, at: this.clock.now() };
      chunk.push(entry);
      await this.areas.local.set({ [auditChunkKey(head % STORAGE_LIMITS.auditChunkCount)]: AuditChunkSchema.parse(chunk) });
      const next: AuditMeta = AuditMetaSchema.parse({ nextSeq: seq + 1, head, tail });
      await this.areas.local.set({ [STORAGE_KEYS.auditMeta]: next });
      return entry;
    });
  }

  /** Newest first. `before` keeps entries with `seq < before`. */
  async listAudit(q: { limit: number; before?: number; kinds?: string[] }): Promise<AuditEntry[]> {
    const meta = await this.loadAuditMeta();
    const out: AuditEntry[] = [];
    for (let n = meta.head; n >= meta.tail && out.length < q.limit; n--) {
      const chunk = await this.readAuditChunk(n);
      for (let i = chunk.length - 1; i >= 0 && out.length < q.limit; i--) {
        const entry = chunk[i];
        if (!entry) continue;
        if (q.before !== undefined && entry.seq >= q.before) continue;
        if (q.kinds && !q.kinds.includes(entry.kind)) continue;
        out.push(entry);
      }
    }
    return out;
  }

  /** Every kept entry, oldest first, as JSON. */
  async exportAuditJson(): Promise<string> {
    const meta = await this.loadAuditMeta();
    const all: AuditEntry[] = [];
    for (let n = meta.tail; n <= meta.head; n++) all.push(...(await this.readAuditChunk(n)));
    return JSON.stringify(all, null, 2);
  }

  /**
   * `sbw:auditMeta`, or, when it is missing or was invalid (and so quarantined),
   * rebuilt from the chunks: seq s lives in chunk floor((s - 1) / 500), so the
   * highest and lowest chunk numbers present give head and tail, and the
   * highest seq gives nextSeq. Without this an append would overwrite live chunks.
   */
  private async loadAuditMeta(): Promise<AuditMeta> {
    const found = await this.find(STORAGE_KEYS.auditMeta);
    if (found) return found;
    let head = -1;
    let tail = Number.POSITIVE_INFINITY;
    let maxSeq = 0;
    for (let slot = 0; slot < STORAGE_LIMITS.auditChunkCount; slot++) {
      const chunk = (await this.readValidated(this.areas.local, auditChunkKey(slot), AuditChunkSchema)) ?? [];
      const last = chunk[chunk.length - 1];
      if (!last) continue;
      const n = Math.floor((last.seq - 1) / STORAGE_LIMITS.auditChunkSize);
      head = Math.max(head, n);
      tail = Math.min(tail, n);
      for (const e of chunk) maxSeq = Math.max(maxSeq, e.seq);
    }
    if (head < 0) return DEFAULTS[STORAGE_KEYS.auditMeta]();
    return { nextSeq: maxSeq + 1, head, tail };
  }

  private async readAuditChunk(n: number): Promise<AuditEntry[]> {
    const slot = auditChunkKey(n % STORAGE_LIMITS.auditChunkCount);
    return (await this.readValidated(this.areas.local, slot, AuditChunkSchema)) ?? [];
  }

  // ── TTL caches ───────────────────────────────────────────────────────────

  /** The entry for `id`, or undefined when absent or expired. */
  async getCached<K extends CacheKey>(key: K, id: string): Promise<CacheEntryOf<K> | undefined> {
    const all = (await this.get(key)) as Entries;
    const entry = all[id];
    return entry && entry.expiresAt > this.clock.now() ? (entry as CacheEntryOf<K>) : undefined;
  }

  /**
   * Stores an entry, then drops expired entries and evicts down to the cap,
   * least recently written first. The entry just written is never evicted.
   */
  async putCached<K extends CacheKey>(key: K, id: string, entry: CacheEntryOf<K>): Promise<void> {
    await this.withLock(key, async () => {
      const all = { ...((await this.get(key)) as Entries), [id]: entry as { expiresAt: number } };
      const order = (await this.readCacheOrder(key)).filter((x) => x !== id);
      order.push(id);
      const { kept, order: nextOrder } = this.prune(all, key, order, id);
      await this.set(key, kept as StorageValue<K>);
      await this.areas.local.set({ [CACHE_ORDER_PREFIX + key]: nextOrder });
    });
  }

  /** Drops expired entries from every cache. Returns how many were removed. */
  async pruneCaches(): Promise<number> {
    let removed = 0;
    for (const key of CACHE_KEYS) {
      await this.withLock(key, async () => {
        const all = (await this.get(key)) as Entries;
        const { kept, order } = this.prune(all, key, await this.readCacheOrder(key));
        const n = Object.keys(all).length - Object.keys(kept).length;
        if (n > 0) {
          removed += n;
          await this.set(key, kept as StorageValue<typeof key>);
          await this.areas.local.set({ [CACHE_ORDER_PREFIX + key]: order });
        }
      });
    }
    return removed;
  }

  private async readCacheOrder(key: CacheKey): Promise<string[]> {
    const parsed = z.array(z.string()).safeParse(await this.areas.local.get<unknown>(CACHE_ORDER_PREFIX + key));
    return parsed.success ? parsed.data : [];
  }

  /** Expired entries go; over the cap, the least recently written go (never `protect`). */
  private prune(all: Entries, key: CacheKey, order: string[], protect?: string): { kept: Entries; order: string[] } {
    const now = this.clock.now();
    const known = new Set(order);
    // Entries with no recency record count as oldest.
    let ids = [...Object.keys(all).filter((id) => !known.has(id)), ...order].filter((id) => {
      const e = all[id];
      return e !== undefined && e.expiresAt > now;
    });
    const cap = Math.max(1, CACHE_MAX_ENTRIES[key]);
    if (ids.length > cap) {
      const evictable = ids.filter((id) => id !== protect);
      const drop = new Set(evictable.slice(0, ids.length - cap));
      ids = ids.filter((id) => !drop.has(id));
    }
    const kept: Entries = {};
    for (const id of ids) kept[id] = all[id] as { expiresAt: number };
    return { kept, order: ids };
  }

  // ── internals ────────────────────────────────────────────────────────────

  private area(area: StorageArea): Storage {
    return area === 'local' ? this.areas.local : this.areas.session;
  }

  private async readValidated<S extends z.ZodType>(storage: Storage, key: string, schema: S): Promise<z.infer<S> | undefined> {
    const raw = await storage.get<unknown>(key);
    if (raw === undefined) return undefined;
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    await this.quarantine(storage, key, raw, parsed.error.message);
    return undefined;
  }

  /**
   * Moves a rejected value to `sbw:quarantine:<key>`, keeping the full value and
   * the last QUARANTINE_KEEP generations. The quarantine copy is written before
   * the original is removed, so a crash cannot lose it. Caches are disposable
   * and are dropped instead.
   */
  private async quarantine(storage: Storage, key: string, value: unknown, error: string): Promise<void> {
    if ((CACHE_KEYS as readonly string[]).includes(key)) {
      await storage.remove([key]);
      return;
    }
    for (let g = QUARANTINE_KEEP - 1; g >= 1; g--) {
      const older = await storage.get<unknown>(quarantineGenKey(key, g - 1));
      if (older !== undefined) await storage.set({ [quarantineGenKey(key, g)]: older });
    }
    const record: QuarantineRecord = { at: this.clock.now(), error, value };
    await storage.set({ [quarantineGenKey(key, 0)]: record });
    await storage.remove([key]);
  }
}

export function auditChunkKey(slot: number): AuditChunkKey {
  return (AUDIT_CHUNK_KEY_PREFIX + String(slot)) as AuditChunkKey;
}

export function quarantineKey(key: string): QuarantineKey {
  return (QUARANTINE_KEY_PREFIX + key) as QuarantineKey;
}

function quarantineGenKey(key: string, generation: number): string {
  return generation === 0 ? quarantineKey(key) : quarantineKey(key) + '#' + String(generation);
}
