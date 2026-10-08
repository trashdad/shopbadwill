import type { GlobalSwitches } from '../../../src/ports/global-switches';

export type SwitchFeature = 'favorites' | 'calendar' | 'bidding';

/** GlobalSwitches where every write is allowed until a test says otherwise. */
export class FakeSwitches implements GlobalSwitches {
  /** Every writesAllowed() call, in order. */
  readonly checks: SwitchFeature[] = [];
  private readonly blocked = new Map<SwitchFeature, string>();
  private allBlocked: string | undefined;

  writesAllowed(feature: SwitchFeature): Promise<{ ok: boolean; why?: string }> {
    this.checks.push(feature);
    const why = this.allBlocked ?? this.blocked.get(feature);
    return Promise.resolve(why === undefined ? { ok: true } : { ok: false, why });
  }

  /** Blocks one feature. */
  block(feature: SwitchFeature, why = 'blocked by test'): void {
    this.blocked.set(feature, why);
  }

  /** Blocks every feature, like the kill switch. */
  killAll(why = 'kill switch'): void {
    this.allBlocked = why;
  }

  /** Allows everything again. */
  reset(): void {
    this.blocked.clear();
    this.allBlocked = undefined;
  }
}
