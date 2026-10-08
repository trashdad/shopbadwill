import { browser } from 'wxt/browser';
import type { KeepAlive } from '../../ports/keep-alive';

/** runtime.getPlatformInfo() ticker; extension API calls reset the idle timer. Never a network request. */
export class BrowserKeepAlive implements KeepAlive {
  private timer: ReturnType<typeof setInterval> | undefined;

  start(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => {
      try {
        browser.runtime.getPlatformInfo().catch(() => undefined);
      } catch {
        // 'Extension context invalidated' can throw synchronously.
      }
    }, intervalMs);
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }
}
