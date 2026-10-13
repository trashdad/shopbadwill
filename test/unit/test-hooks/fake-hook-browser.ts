// A TestHookBrowser for unit tests: WXT's fakeBrowser for storage and alarms,
// plus a hand-written runtime.onConnect (fakeBrowser does not mock ports).
import { fakeBrowser } from 'wxt/testing/fake-browser';

import type { TestHookBrowser, TestHookPort } from '../../../src/test-hooks';

export const EXTENSION_ID = 'test-extension-id';
const ORIGIN = `moz-extension://${EXTENSION_ID}/`;
export const EXTENSION_PAGE = `${ORIGIN}sidebar.html`;

export interface Reply {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** The page side of an open port: what the background posted, and whether it hung up. */
export interface ClientPort {
  readonly replies: Reply[];
  readonly disconnected: boolean;
  post(message: unknown): void;
  /** Resolves with the first reply (fails the test after 1 s). */
  nextReply(): Promise<Reply>;
}

export interface FakeHookBrowser extends TestHookBrowser {
  /** Opens a port to the background, as `runtime.connect({ name })` from `senderUrl`. */
  connect(name: string, sender?: { id?: string; url?: string }): ClientPort;
  readonly connectListenerCount: number;
}

export function fakeHookBrowser(): FakeHookBrowser {
  const listeners: ((port: TestHookPort) => void)[] = [];

  return {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) => ORIGIN + path.replace(/^\//, ''),
      onConnect: { addListener: (cb) => listeners.push(cb) },
    },
    storage: fakeBrowser.storage,
    alarms: fakeBrowser.alarms,
    get connectListenerCount() {
      return listeners.length;
    },
    connect(name, sender = { id: EXTENSION_ID, url: EXTENSION_PAGE }) {
      const replies: Reply[] = [];
      const waiters: ((reply: Reply) => void)[] = [];
      const backgroundOnMessage: ((message: unknown) => void)[] = [];
      let disconnected = false;

      const backgroundSide: TestHookPort = {
        name,
        sender,
        postMessage(message) {
          const reply = message as Reply;
          replies.push(reply);
          waiters.shift()?.(reply);
        },
        disconnect() {
          disconnected = true;
        },
        onMessage: { addListener: (cb) => backgroundOnMessage.push(cb) },
      };
      for (const listener of listeners) listener(backgroundSide);

      return {
        replies,
        get disconnected() {
          return disconnected;
        },
        post(message) {
          for (const cb of backgroundOnMessage) cb(message);
        },
        nextReply() {
          const ready = replies[0];
          if (ready) return Promise.resolve(ready);
          return new Promise<Reply>((resolve, reject) => {
            const timer = setTimeout(() => {
              reject(new Error(`no reply on port ${name}`));
            }, 1000);
            waiters.push((reply) => {
              clearTimeout(timer);
              resolve(reply);
            });
          });
        },
      };
    },
  };
}
