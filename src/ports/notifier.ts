// Contract v1 (T-02): PLAN §3.2 Notifier port. Implemented by T-34
// (src/adapters/browser/notifier.ts).
export interface Notification {
  id?: string;
  title: string;
  message: string;
  priority?: 0 | 1 | 2;
  actions?: Array<{ id: string; title: string }>;
  openUrlOnClick?: string;
}

export interface Notifier {
  /** false on Firefox. */
  readonly supportsActions: boolean;
  /** Resolves to the notification id. */
  notify(n: Notification): Promise<string>;
  /**
   * `actionId` is an action's id, or 'click' for a click on the body.
   * Returns an unsubscribe function.
   */
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents -- §3.2 names 'click' explicitly
  onAction(cb: (notificationId: string, actionId: string | 'click') => void): () => void;
}
