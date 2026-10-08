import { browser } from 'wxt/browser';
import type { Notification, Notifier } from '../../ports/notifier';
import { isFirefox } from './env';

export interface BrowserNotifierOptions {
  /** Override (defaults to `!import.meta.env.FIREFOX`). */
  supportsActions?: boolean;
}

/** storage.session key holding the click mappings; survives service-worker restarts. */
export const NOTIFIER_MAP_KEY = 'sbw:notifier:map';
const MAX_ENTRIES = 50;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface Entry {
  at: number;
  url?: string;
  buttons?: string[];
}
type EntryMap = Record<string, Entry>;

/** Firefox supports only `basic` notifications without buttons. */
export class BrowserNotifier implements Notifier {
  readonly supportsActions: boolean;
  private seq = 0;
  /** Serializes read-modify-write cycles on the stored map. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(opts: BrowserNotifierOptions = {}) {
    this.supportsActions = opts.supportsActions ?? !isFirefox();
  }

  private async read(): Promise<EntryMap> {
    const got = await browser.storage.session.get(NOTIFIER_MAP_KEY);
    return (got[NOTIFIER_MAP_KEY] as EntryMap | undefined) ?? {};
  }

  private update<T>(fn: (map: EntryMap) => T): Promise<T> {
    const run = async (): Promise<T> => {
      const map = await this.read();
      const out = fn(map);
      await browser.storage.session.set({ [NOTIFIER_MAP_KEY]: map });
      return out;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  async notify(n: Notification): Promise<string> {
    this.seq += 1;
    const id = n.id ?? `sbw:n:${String(Date.now())}:${String(this.seq)}`;
    const options: Record<string, unknown> = {
      type: 'basic',
      iconUrl: browser.runtime.getURL('/icon/128.png' as never),
      title: n.title,
      message: n.message,
    };
    const entry: Entry = { at: Date.now() };
    if (this.supportsActions) {
      if (n.priority !== undefined) options['priority'] = n.priority;
      if (n.actions && n.actions.length > 0) {
        // Chrome allows at most two buttons.
        const actions = n.actions.slice(0, 2);
        options['buttons'] = actions.map((a) => ({ title: a.title }));
        entry.buttons = actions.map((a) => a.id);
      }
    }
    if (n.openUrlOnClick !== undefined) entry.url = n.openUrlOnClick;
    if (entry.url !== undefined || entry.buttons !== undefined) {
      await this.update((map) => {
        const now = Date.now();
        for (const [k, v] of Object.entries(map)) if (now - v.at > MAX_AGE_MS) Reflect.deleteProperty(map, k);
        map[id] = entry;
        const keys = Object.keys(map);
        if (keys.length > MAX_ENTRIES) {
          keys
            .sort((a, b) => (map[a]?.at ?? 0) - (map[b]?.at ?? 0))
            .slice(0, keys.length - MAX_ENTRIES)
            .forEach((k) => {
              Reflect.deleteProperty(map, k);
            });
        }
      });
    }
    await browser.notifications.create(id, options as never);
    return id;
  }

  /** Reads and removes the mapping for `id` (a click consumes it). */
  private take(id: string): Promise<Entry | undefined> {
    return this.update((map) => {
      const e = map[id];
      Reflect.deleteProperty(map, id);
      return e;
    });
  }

  onAction(cb: (notificationId: string, actionId: string) => void): () => void {
    const onClicked = (id: string): void => {
      void this.take(id).then((e) => {
        if (e?.url !== undefined) void browser.tabs.create({ url: e.url });
        cb(id, 'click');
      });
    };
    const onButton = (id: string, index: number): void => {
      void this.read().then((map) => {
        const actionId = map[id]?.buttons?.[index];
        if (actionId !== undefined) cb(id, actionId);
      });
    };
    const onClosed = (id: string): void => {
      void this.update((map) => {
        Reflect.deleteProperty(map, id);
      });
    };
    browser.notifications.onClicked.addListener(onClicked);
    browser.notifications.onClosed.addListener(onClosed);
    // onButtonClicked does not exist on Firefox.
    const buttons = (browser.notifications as { onButtonClicked?: typeof browser.notifications.onButtonClicked })
      .onButtonClicked;
    buttons?.addListener(onButton);
    return () => {
      browser.notifications.onClicked.removeListener(onClicked);
      browser.notifications.onClosed.removeListener(onClosed);
      buttons?.removeListener(onButton);
    };
  }
}
