import { browser } from 'wxt/browser';
import type { KeepAwake } from '../../ports/keep-awake';

interface PowerApi {
  requestKeepAwake(level: 'system'): void;
  releaseKeepAwake(): void;
}

function powerApi(): PowerApi | undefined {
  const p = (browser as unknown as { power?: Partial<PowerApi> }).power;
  return p?.requestKeepAwake && p.releaseKeepAwake ? (p as PowerApi) : undefined;
}

/**
 * Chrome `power` (optional-permission gated). When the API is missing or the
 * permission is not granted, hold/release are no-ops.
 */
export class BrowserKeepAwake implements KeepAwake {
  private held = false;

  get available(): boolean {
    return powerApi() !== undefined;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the reason is informational; Chrome's API takes none
  async hold(_reason: string): Promise<void> {
    const power = powerApi();
    if (!power) return;
    try {
      if (!(await browser.permissions.contains({ permissions: ['power'] as never }))) return;
      power.requestKeepAwake('system');
      this.held = true;
    } catch {
      // Degrade gracefully: keep-awake is best effort.
    }
  }

  release(): Promise<void> {
    const power = powerApi();
    if (power && this.held) {
      try {
        power.releaseKeepAwake();
      } catch {
        // Best effort.
      }
    }
    this.held = false;
    return Promise.resolve();
  }
}
