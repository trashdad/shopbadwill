// T-70: where the pasted Google OAuth client lives: `sbw:googleClient`, a record
// of its own (T-36's clientConfig() reads it). This page never touches
// `sbw:google`, the token record the background writes, so it cannot clobber a
// live connection.
//
// The secret goes in and never comes back out: load() reports only whether one
// is saved and its last four characters. Nothing here logs, throws with, or
// audits a value.
import { browser } from 'wxt/browser';

import { GoogleClientSchema, STORAGE_KEYS, type GoogleClient } from '../../../../domain/storage/schema';

/** `<digits>-<alnum>.apps.googleusercontent.com` (ruling R1). */
export const CLIENT_ID_RE = /^\d+-[A-Za-z0-9]+\.apps\.googleusercontent\.com$/;

export interface ClientConfigView {
  clientId: string;
  /** The last 4 characters of the saved secret; null when none is saved. */
  secretTail: string | null;
}

export interface ClientConfigInput {
  clientId: string;
  /** Omitted or blank: keep the saved secret. */
  clientSecret?: string | undefined;
}

export interface GoogleConfigStore {
  load(): Promise<ClientConfigView>;
  save(input: ClientConfigInput): Promise<void>;
}

/** The slice of browser.storage.local the store uses. */
export interface LocalArea {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export function createGoogleConfigStore(
  area: () => LocalArea = () => browser.storage.local,
  now: () => number = Date.now,
): GoogleConfigStore {
  const key = STORAGE_KEYS.googleClient;
  const read = async (): Promise<GoogleClient | undefined> => {
    const raw = (await area().get(key))[key];
    const parsed = GoogleClientSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  };
  return {
    async load() {
      const cur = await read();
      const secret = cur?.clientSecret;
      return {
        clientId: cur?.clientId ?? '',
        secretTail: secret === undefined || secret === '' ? null : secret.slice(-4),
      };
    },
    async save(input) {
      const cur = await read();
      const secret = input.clientSecret === undefined || input.clientSecret === '' ? cur?.clientSecret : input.clientSecret;
      // Validated before it is written; this key is the only one the page ever writes.
      const next = GoogleClientSchema.parse({
        clientId: input.clientId,
        ...(secret === undefined ? {} : { clientSecret: secret }),
        updatedAt: now(),
      });
      await area().set({ [key]: next });
    },
  };
}

/** "••••" plus the last 4 characters. */
export function maskSecret(tail: string): string {
  return `••••${tail}`;
}
