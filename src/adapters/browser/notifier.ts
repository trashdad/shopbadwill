import { browser } from 'wxt/browser';
import type { Notification, Notifier } from '../../ports/notifier';
import { isFirefox } from './env';

export interface BrowserNotifierOptions {
  /** Override (defaults to `!import.meta.env.FIREFOX`). */
  supportsActions?: boolean;
}

/** Firefox supports only `basic` notifications without buttons. */
export class BrowserNotifier implements Notifier {
  readonly supportsActions: boolean;
  private readonly urls = new Map<string, string>();
  private readonly buttonIds = new Map<string, string[]>();
  private seq = 0;

  constructor(opts: BrowserNotifierOptions = {}) {
    this.supportsActions = opts.supportsActions ?? !isFirefox();
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
    if (this.supportsActions) {
      if (n.priority !== undefined) options['priority'] = n.priority;
      if (n.actions && n.actions.length > 0) {
        // Chrome allows at most two buttons.
        const actions = n.actions.slice(0, 2);
        options['buttons'] = actions.map((a) => ({ title: a.title }));
        this.buttonIds.set(id, actions.map((a) => a.id));
      }
    }
    if (n.openUrlOnClick !== undefined) this.urls.set(id, n.openUrlOnClick);
    await browser.notifications.create(id, options as never);
    return id;
  }

  onAction(cb: (notificationId: string, actionId: string) => void): () => void {
    const onClicked = (id: string): void => {
      const url = this.urls.get(id);
      if (url !== undefined) {
        this.urls.delete(id);
        void browser.tabs.create({ url });
      }
      cb(id, 'click');
    };
    const onButton = (id: string, index: number): void => {
      const actionId = this.buttonIds.get(id)?.[index];
      if (actionId !== undefined) cb(id, actionId);
    };
    const onClosed = (id: string): void => {
      this.urls.delete(id);
      this.buttonIds.delete(id);
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
