// Contract v1 (T-02): PLAN §3.2 Storage port. Implemented by T-34
// (src/adapters/browser/storage.ts); key names and record schemas are in
// src/domain/storage/schema.ts.
export interface Storage {
  /** The caller names the type it expects; the repo (T-33) validates it with the key's zod schema. */
  get<T>(key: string): Promise<T | undefined>;
  set(entries: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
  /** Returns an unsubscribe function. */
  onChanged(cb: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => void): () => void;
}

export interface StorageAreas {
  local: Storage;
  session: Storage;
}
