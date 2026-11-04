import { browser } from 'wxt/browser';
import type { Storage, StorageAreas } from '../../ports/storage';

type AreaName = 'local' | 'session';

function makeStorage(name: AreaName): Storage {
  const area = (): typeof browser.storage.local => browser.storage[name];
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const got = await area().get(key);
      return got[key] as T | undefined;
    },
    async set(entries) {
      await area().set(entries);
    },
    async remove(keys) {
      await area().remove(keys);
    },
    onChanged(cb) {
      const listener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string): void => {
        if (areaName === name) cb(changes);
      };
      browser.storage.onChanged.addListener(listener);
      return () => {
        browser.storage.onChanged.removeListener(listener);
      };
    },
  };
}

export function createStorageAreas(): StorageAreas {
  return { local: makeStorage('local'), session: makeStorage('session') };
}
