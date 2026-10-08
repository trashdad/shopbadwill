import type { Notification, Notifier } from '../../../src/ports/notifier';

export class FakeNotifier implements Notifier {
  readonly supportsActions: boolean;
  /** Every notification passed to notify(), in order, with its assigned id. */
  readonly sent: Array<{ id: string; notification: Notification }> = [];
  private seq = 0;
  private readonly listeners = new Set<(id: string, actionId: string) => void>();

  constructor(opts: { supportsActions?: boolean } = {}) {
    this.supportsActions = opts.supportsActions ?? true;
  }

  notify(n: Notification): Promise<string> {
    this.seq += 1;
    const id = n.id ?? `fake-notification-${String(this.seq)}`;
    this.sent.push({ id, notification: structuredClone(n) });
    return Promise.resolve(id);
  }

  onAction(cb: (notificationId: string, actionId: string) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  /** Test helper: the user pressed an action button. */
  triggerAction(notificationId: string, actionId: string): void {
    for (const cb of [...this.listeners]) cb(notificationId, actionId);
  }

  /** Test helper: the user clicked the notification body. */
  click(notificationId: string): void {
    this.triggerAction(notificationId, 'click');
  }
}
