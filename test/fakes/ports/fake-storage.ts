import { isDeepStrictEqual } from 'node:util';

import type { Storage, StorageAreas } from '../../../src/ports/storage';

type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;

/**
 * In-memory Storage area. Values are structured-cloned on the way in and out
 * (like the real structured-clone/JSON round trip), so callers cannot alias
 * stored state. `onChanged` fires only for keys whose value actually changed.
 */
export class FakeStorage implements Storage {
  private readonly data = new Map<string, unknown>();
  private readonly listeners = new Set<(c: Changes) => void>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.data.has(key) ? (structuredClone(this.data.get(key)) as T) : undefined);
  }

  set(entries: Record<string, unknown>): Promise<void> {
    const changes: Changes = {};
    for (const [key, value] of Object.entries(entries)) {
      const next = structuredClone(value);
      const had = this.data.has(key);
      const old = this.data.get(key);
      if (had && isDeepStrictEqual(old, next)) continue;
      this.data.set(key, next);
      changes[key] = had ? { oldValue: structuredClone(old), newValue: structuredClone(next) } : { newValue: structuredClone(next) };
    }
    this.emit(changes);
    return Promise.resolve();
  }

  remove(keys: string[]): Promise<void> {
    const changes: Changes = {};
    for (const key of keys) {
      if (!this.data.has(key)) continue;
      changes[key] = { oldValue: this.data.get(key) };
      this.data.delete(key);
    }
    this.emit(changes);
    return Promise.resolve();
  }

  onChanged(cb: (changes: Changes) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Test helper: sets values without firing onChanged. */
  seed(entries: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(entries)) this.data.set(key, structuredClone(value));
  }

  /** Test helper: a plain snapshot of everything stored. */
  dump(): Record<string, unknown> {
    return structuredClone(Object.fromEntries(this.data));
  }

  private emit(changes: Changes): void {
    if (Object.keys(changes).length === 0) return;
    for (const cb of [...this.listeners]) cb(structuredClone(changes));
  }
}

export class FakeStorageAreas implements StorageAreas {
  readonly local = new FakeStorage();
  readonly session = new FakeStorage();
}
