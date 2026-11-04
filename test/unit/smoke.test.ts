import { beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';

// Toolchain smoke test: proves Vitest runs with the WxtVitest() plugin, which
// swaps `wxt/browser` for WXT's in-memory fake browser.
describe('toolchain smoke', () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('resolves wxt/browser to the fake browser under test', () => {
    expect(browser).toBe(fakeBrowser);
  });

  it('round-trips a value through storage.local', async () => {
    const value = { cents: 5000, tags: ['lamp', 'brass'] };

    await browser.storage.local.set({ 'sbw:smoke': value });
    const read = await browser.storage.local.get('sbw:smoke');

    expect(read).toEqual({ 'sbw:smoke': value });
  });

  it('starts from empty storage after reset', async () => {
    await browser.storage.local.set({ 'sbw:smoke': 1 });
    fakeBrowser.reset();

    expect(await browser.storage.local.get('sbw:smoke')).toEqual({});
  });
});
