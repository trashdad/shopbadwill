// T-69: the options page's view of `sbw:ntfy`. Turning phone push off, or
// rotating the topic, cancels stored messages and then clears this record
// before the new setting is saved. Invalid data reads as empty.
import { browser } from 'wxt/browser';

import { EMPTY_NTFY_STATE } from '../../../../adapters/ntfy/ntfy-sink';
import { STORAGE_KEYS, parseNtfyState, type NtfyState } from '../../../../domain/storage/schema';

export interface NtfyScheduledStore {
  load(): Promise<NtfyState>;
  clear(): Promise<void>;
}

/** The slice of browser.storage.local the store uses. */
export interface LocalArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export function createNtfyScheduledStore(area: () => LocalArea = () => browser.storage.local): NtfyScheduledStore {
  const key = STORAGE_KEYS.ntfy;
  return {
    async load() {
      try {
        const raw = (await area().get(key))[key];
        return parseNtfyState(raw);
      } catch {
        return structuredClone(EMPTY_NTFY_STATE);
      }
    },
    async clear() {
      await area().set({ [key]: structuredClone(EMPTY_NTFY_STATE) });
    },
  };
}
