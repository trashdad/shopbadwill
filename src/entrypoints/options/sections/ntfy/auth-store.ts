// T-123: where the ntfy access token lives: `sbw:ntfyAuth` in storage.local, a
// record of its own (never in settings, so `settings.get` never carries it and
// no other page sees it). Like the Google client secret (T-70): load() reports
// only whether one is saved and its last 4 characters. token() hands the raw
// value to this page's own requests (cancel, test push) and nothing else.
// Nothing here logs, throws with, or audits the value.
import { browser } from 'wxt/browser';

import { STORAGE_KEYS, parseNtfyAuth } from '../../../../domain/storage/schema';

export interface NtfyAuthView {
  /** The last 4 characters of the saved token; null when none is saved. */
  tokenTail: string | null;
}

export interface NtfyAuthStore {
  load(): Promise<NtfyAuthView>;
  /** The saved token, for a request this page makes. Never shown. */
  token(): Promise<string | undefined>;
  /** Saves an already-normalized token (`normalizeToken`). */
  save(token: string): Promise<void>;
  remove(): Promise<void>;
}

/** The slice of browser.storage.local the store uses. */
export interface LocalArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(key: string): Promise<void>;
}

export function createNtfyAuthStore(
  area: () => LocalArea = () => browser.storage.local,
  now: () => number = Date.now,
): NtfyAuthStore {
  const key = STORAGE_KEYS.ntfyAuth;
  const read = async (): Promise<string | undefined> => {
    try {
      return parseNtfyAuth((await area().get(key))[key])?.token;
    } catch {
      return undefined;
    }
  };
  return {
    async load() {
      const token = await read();
      return { tokenTail: token === undefined ? null : token.slice(-4) };
    },
    token: read,
    async save(token) {
      if (token === '') throw new Error('the access token is empty');
      await area().set({ [key]: { token, updatedAt: now() } });
    },
    async remove() {
      await area().remove(key);
    },
  };
}

/** "••••" plus the last 4 characters. */
export function maskToken(tail: string): string {
  return `••••${tail}`;
}
