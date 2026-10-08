import { describe, expect, it, vi } from 'vitest';

import { createRouter, type RouterSender } from '../../../src/background/router';
import { createMessagingClient, MessagingError, type ClientRuntime } from '../../../src/messaging/client';

const ID = 'ext-id';
const EXT_ORIGIN = 'chrome-extension://ext-id';
const SGW_TAB: RouterSender = { id: ID, tab: { id: 1 }, url: 'https://shopgoodwill.com/item/123' };
const POPUP: RouterSender = { id: ID, url: `${EXT_ORIGIN}/popup.html` };

const env = (type: string, payload?: unknown) => ({
  v: 1,
  reqId: 'r1',
  type,
  ...(payload === undefined ? {} : { payload }),
});

function setup(quickFavorite = true) {
  const router = createRouter({
    runtimeId: ID,
    extensionOrigin: EXT_ORIGIN,
    isQuickFavoriteEnabled: () => quickFavorite,
  });
  return router;
}

describe('router sender validation', () => {
  it('rejects a wrong sender.id without calling the handler', async () => {
    const router = setup();
    const h = vi.fn(() => []);
    router.register('rules.evaluate', h);
    const res = await router.handle(env('rules.evaluate', { listings: [] }), { ...SGW_TAB, id: 'other' });
    expect(res).toMatchObject({ ok: false, error: { code: 'bad_sender' } });
    expect(h).not.toHaveBeenCalled();
  });

  it('rejects snipe.arm from a tab sender', async () => {
    const router = setup();
    const h = vi.fn();
    router.register('snipe.arm', h);
    const res = await router.handle(env('snipe.arm', { snipe: {} }), SGW_TAB);
    expect(res).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(h).not.toHaveBeenCalled();
  });

  it('rejects every UI-only type from content, and background broadcasts from anyone', async () => {
    const router = setup();
    for (const t of ['settings.set', 'kill.set', 'audit.undo', 'calendar.connect', 'favorites.sync']) {
      expect(await router.handle(env(t), SGW_TAB)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    }
    expect(await router.handle(env('rules.changed'), POPUP)).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('accepts rules.evaluate from a https://shopgoodwill.com tab', async () => {
    const router = setup();
    router.register('rules.evaluate', () => []);
    const res = await router.handle(env('rules.evaluate', { listings: [] }), SGW_TAB);
    expect(res).toEqual({ ok: true, reply: [] });
  });

  it('rejects rules.evaluate from https://evil.example (and lookalike origins)', async () => {
    const router = setup();
    const h = vi.fn(() => []);
    router.register('rules.evaluate', h);
    for (const url of [
      'https://evil.example/x',
      'https://shopgoodwill.com.evil.example/',
      'http://shopgoodwill.com/',
      'https://buyerapi.shopgoodwill.com/',
      'not a url',
    ]) {
      const res = await router.handle(env('rules.evaluate', { listings: [] }), { id: ID, tab: { id: 1 }, url });
      expect(res).toMatchObject({ ok: false, error: { code: 'bad_sender' } });
    }
    expect(h).not.toHaveBeenCalled();
  });

  it('rejects a content sender with a url but no tab, and a tab-less web url', async () => {
    const router = setup();
    router.register('rules.evaluate', () => []);
    const res = await router.handle(env('rules.evaluate', { listings: [] }), { id: ID, url: 'https://shopgoodwill.com/' });
    expect(res).toMatchObject({ ok: false, error: { code: 'bad_sender' } });
  });

  it('accepts UI types from an extension page, including one opened in a tab', async () => {
    const router = setup();
    router.register('kill.set', () => undefined);
    expect(await router.handle(env('kill.set', { on: true }), POPUP)).toEqual({ ok: true });
    const inTab = { id: ID, tab: { id: 9 }, url: `${EXT_ORIGIN}/dashboard.html` };
    expect(await router.handle(env('kill.set', { on: true }), inTab)).toEqual({ ok: true });
  });
});

describe('router quick.favorite gate', () => {
  it('rejects quick.favorite when the setting is off', async () => {
    const router = setup(false);
    const h = vi.fn();
    router.register('quick.favorite', h);
    const res = await router.handle(env('quick.favorite', { itemId: 5 }), SGW_TAB);
    expect(res).toMatchObject({ ok: false, error: { code: 'disabled' } });
    expect(h).not.toHaveBeenCalled();
  });

  it('dispatches quick.favorite when the setting is on', async () => {
    const router = setup(true);
    const h = vi.fn();
    router.register('quick.favorite', h);
    expect(await router.handle(env('quick.favorite', { itemId: 5 }), SGW_TAB)).toEqual({ ok: true });
    expect(h).toHaveBeenCalledWith({ itemId: 5 }, expect.objectContaining({ senderClass: 'content' }));
  });
});

describe('router validation and envelope', () => {
  it('returns invalid_message for a malformed payload and does not call the handler', async () => {
    const router = setup();
    const h = vi.fn(() => []);
    router.register('rules.evaluate', h);
    const res = await router.handle(env('rules.evaluate', { listings: 'nope' }), SGW_TAB);
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    expect(h).not.toHaveBeenCalled();
  });

  it('returns invalid_message for a bad envelope version', async () => {
    const router = setup();
    router.register('settings.get', vi.fn());
    const res = await router.handle({ v: 2, reqId: 'r', type: 'settings.get' }, POPUP);
    expect(res).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
  });

  it('returns unknown_type for unknown or non-object messages', async () => {
    const router = setup();
    for (const raw of [env('nope.nothing'), null, 'str', 42, env('constructor'), env('__proto__')]) {
      expect(await router.handle(raw, POPUP)).toMatchObject({ ok: false, error: { code: 'unknown_type' } });
    }
  });

  it('returns no_handler when nothing is registered', async () => {
    const router = setup();
    expect(await router.handle(env('settings.get'), POPUP)).toMatchObject({ ok: false, error: { code: 'no_handler' } });
  });

  it('wraps a throwing handler as handler_error', async () => {
    const router = setup();
    router.register('settings.get', () => {
      throw new Error('boom');
    });
    expect(await router.handle(env('settings.get'), POPUP)).toEqual({
      ok: false,
      error: { code: 'handler_error', message: 'boom' },
    });
  });

  it('validates the handler reply against MsgReplySchemas', async () => {
    const router = setup();
    router.register('rules.list', (() => 'not an array') as never);
    expect(await router.handle(env('rules.list'), POPUP)).toMatchObject({ ok: false, error: { code: 'bad_reply' } });
  });

  it('registration: duplicates and broadcast types throw; unregister frees the slot', () => {
    const router = setup();
    const off = router.register('settings.get', vi.fn());
    expect(() => router.register('settings.get', vi.fn())).toThrow(/already registered/);
    expect(() => router.register('rules.changed', vi.fn())).toThrow(/broadcast/);
    off();
    expect(() => router.register('settings.get', vi.fn())).not.toThrow();
  });
});

describe('client round trip through the router', () => {
  function wire(sender: RouterSender, quickFavorite = true) {
    const router = setup(quickFavorite);
    const runtime = {
      id: ID,
      sendMessage: (m: unknown) => router.handle(m, sender),
    } as unknown as ClientRuntime;
    return { router, client: createMessagingClient(runtime) };
  }

  it('resolves with the validated reply', async () => {
    const { router, client } = wire(SGW_TAB);
    router.register('rules.evaluate', () => []);
    await expect(client.send('rules.evaluate', { listings: [] })).resolves.toEqual([]);
  });

  it('rejects with a typed MessagingError carrying the router code', async () => {
    const { client } = wire(SGW_TAB);
    await expect(client.send('kill.set', { on: true })).rejects.toMatchObject({
      name: 'MessagingError',
      code: 'forbidden',
    });
  });

  it('rejects invalid payloads before sending', async () => {
    const send = vi.fn();
    const client = createMessagingClient({ id: ID, sendMessage: send } as unknown as ClientRuntime);
    await expect(client.send('quick.hideKeyword', { term: '' })).rejects.toBeInstanceOf(MessagingError);
    expect(send).not.toHaveBeenCalled();
  });

  it('maps a missing response and a transport failure to typed errors', async () => {
    const none = createMessagingClient({ id: ID, sendMessage: () => Promise.resolve(undefined) } as unknown as ClientRuntime);
    await expect(none.send('settings.get', undefined)).rejects.toMatchObject({ code: 'no_response' });
    const bad = createMessagingClient({
      id: ID,
      sendMessage: () => Promise.reject(new Error('no receiver')),
    } as unknown as ClientRuntime);
    await expect(bad.send('settings.get', undefined)).rejects.toMatchObject({ code: 'transport' });
  });

  it('sends a v1 envelope with a reqId and omits payload when there is none', async () => {
    const send = vi.fn(() => Promise.resolve({ ok: true }));
    const client = createMessagingClient({ id: ID, sendMessage: send } as unknown as ClientRuntime);
    await client.send('snipe.list', undefined).catch(() => undefined);
    const sent = send.mock.calls[0] as unknown as [Record<string, unknown>];
    expect(sent[0]).toMatchObject({ v: 1, type: 'snipe.list' });
    expect(typeof sent[0].reqId).toBe('string');
    expect('payload' in sent[0]).toBe(false);
  });
});

describe('client onBroadcast', () => {
  function runtimeWithListeners() {
    const listeners = new Set<(m: unknown, s: { id?: string; tab?: unknown }) => undefined | boolean>();
    const runtime = {
      id: ID,
      onMessage: {
        addListener: (l: never) => listeners.add(l),
        removeListener: (l: never) => listeners.delete(l),
      },
    } as unknown as ClientRuntime;
    const deliver = (m: unknown, s: { id?: string; tab?: unknown }) => {
      listeners.forEach((l) => l(m, s));
    };
    return { runtime, deliver, listeners };
  }

  it('delivers background broadcasts and ignores spoofed ones', () => {
    const { runtime, deliver, listeners } = runtimeWithListeners();
    const cb = vi.fn();
    const off = createMessagingClient(runtime).onBroadcast('switches.changed', cb);
    const msg = env('switches.changed', { killSwitch: true, writesAllowed: {} });
    deliver(msg, { id: ID });
    expect(cb).toHaveBeenCalledWith({ killSwitch: true, writesAllowed: {} });
    deliver(msg, { id: ID, tab: { id: 1 } }); // from a tab
    deliver(msg, { id: 'other' });
    deliver(env('rules.changed'), { id: ID }); // other type
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    expect(listeners.size).toBe(0);
  });
});

describe('client connect', () => {
  it('validates ticks and disconnects', () => {
    const handlers = new Set<(m: unknown) => void>();
    const disconnect = vi.fn();
    const runtime = {
      id: ID,
      connect: () => ({
        onMessage: { addListener: (l: never) => handlers.add(l), removeListener: (l: never) => handlers.delete(l) },
        disconnect,
      }),
    } as unknown as ClientRuntime;
    const onTick = vi.fn();
    const off = createMessagingClient(runtime).connect('sbw:snipe-countdown', onTick);
    const tick = { snipeId: 's1', serverNow: null, fireAt: null, state: 'armed' };
    handlers.forEach((h) => {
      h({ bad: true });
    });
    expect(onTick).not.toHaveBeenCalled();
    handlers.forEach((h) => {
      h(tick);
    });
    expect(onTick).toHaveBeenCalledTimes(1);
    off();
    expect(disconnect).toHaveBeenCalled();
    expect(handlers.size).toBe(0);
  });
});
