// T-123: the options page's store for the ntfy access token (`sbw:ntfyAuth`).
// The token goes in and comes out only through token() (for this page's own
// requests); load() reports just its last 4 characters.
import { describe, expect, it, vi } from 'vitest';

import { STORAGE_KEYS } from '../../../../src/domain/storage/schema';
import { createNtfyAuthStore, maskToken } from '../../../../src/entrypoints/options/sections/ntfy/auth-store';

const TOKEN = 'tk_placeholdertokenplaceholder0';

function memArea(seed: Record<string, unknown> = {}) {
  const mem: Record<string, unknown> = { ...seed };
  return {
    mem,
    area: () => ({
      get: (key: string) => Promise.resolve(key in mem ? { [key]: mem[key] } : {}),
      set: (items: Record<string, unknown>) => {
        Object.assign(mem, items);
        return Promise.resolve();
      },
      remove: (key: string) => {
        Reflect.deleteProperty(mem, key);
        return Promise.resolve();
      },
    }),
  };
}

describe('createNtfyAuthStore', () => {
  it('saves to sbw:ntfyAuth and reports only the last 4 characters', async () => {
    const m = memArea();
    const store = createNtfyAuthStore(m.area, () => 1234);
    expect(await store.load()).toEqual({ tokenTail: null });
    await store.save(TOKEN);
    expect(m.mem[STORAGE_KEYS.ntfyAuth]).toEqual({ token: TOKEN, updatedAt: 1234 });
    expect(await store.load()).toEqual({ tokenTail: 'der0' });
    expect(JSON.stringify(await store.load())).not.toContain(TOKEN);
    expect(await store.token()).toBe(TOKEN);
    expect(maskToken('der0')).toBe('••••der0');
  });

  it('remove deletes the record', async () => {
    const m = memArea({ [STORAGE_KEYS.ntfyAuth]: { token: TOKEN, updatedAt: 1 } });
    const store = createNtfyAuthStore(m.area);
    await store.remove();
    expect(STORAGE_KEYS.ntfyAuth in m.mem).toBe(false);
    expect(await store.token()).toBeUndefined();
  });

  it('reads an invalid record, or a failing area, as no token without throwing or logging', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await createNtfyAuthStore(memArea({ [STORAGE_KEYS.ntfyAuth]: { token: 5 } }).area).load()).toEqual({ tokenTail: null });
    const broken = createNtfyAuthStore(() => ({
      get: () => Promise.reject(new Error(`storage broke ${TOKEN}`)),
      set: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    }));
    expect(await broken.token()).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('refuses to save an empty token', async () => {
    await expect(createNtfyAuthStore(memArea().area).save('')).rejects.toThrow(/empty/);
  });
});
