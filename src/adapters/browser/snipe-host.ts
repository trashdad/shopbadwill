// T-84: the SnipeHost factory and the background host (PLAN §3.9, §1.3).
//
// A SnipeHost is where the final timer of a snipe runs. S-7
// (docs/spikes/S-7.md) measured where that may be:
// - Chrome: the service worker itself (single setTimeout p95 4.4 ms);
// - Firefox: NOT the bare event page. Firefox defers its timers by about
//   min(delay/8, 10 s) - 0.6 s (6.8 s for the T-60 s timer), so it needs the
//   runner page (an unfocused extension window, T-116).
//
// The factory is keyed by that verdict. Implementations other than the
// background one are separate modules named `./snipe-host-*.ts` that export
// `snipeHost: SnipeHostImplementation`; the glob below loads them, so T-116
// adds `snipe-host-page.ts` without editing this file or the runner (I-12).
// When the verdict asks for an implementation that is not installed, the
// factory falls back to the background host and says so (`degraded`), so the
// runner can audit it: on Firefox that means fires can come ~6.8 s late.
//
// KeepAlive is not the host's job: the runner holds it for every snipe window
// whatever the host (S-7: only parent API calls keep a Firefox event page
// alive, so a runner page alone would not).
import type { Clock } from '../../ports/clock';
import type { SnipeHost } from '../../ports/snipe-host';
import { isFirefox } from './env';

/** Where the final timer may run, per the S-7 verdict. */
export type SnipeHostVerdict = 'background' | 'runner-page';

/** S-7's verdict per browser (docs/spikes/S-7.md, "Firefox host verdict"). */
export const S7_HOST_VERDICT: Readonly<Record<'chrome' | 'firefox', SnipeHostVerdict>> = Object.freeze({
  chrome: 'background',
  firefox: 'runner-page',
});

/** The verdict for the browser this build targets. */
export function hostVerdict(firefox: boolean = isFirefox()): SnipeHostVerdict {
  return firefox ? S7_HOST_VERDICT.firefox : S7_HOST_VERDICT.chrome;
}

export interface SnipeHostDeps {
  clock: Clock;
  log: (message: string, error?: unknown) => void;
}

/** What a `./snipe-host-*.ts` module exports as `snipeHost`. */
export interface SnipeHostImplementation {
  readonly verdict: SnipeHostVerdict;
  create(deps: SnipeHostDeps): SnipeHost;
}

export interface SnipeHostModule {
  snipeHost?: SnipeHostImplementation;
}

/** Registered implementations: every `./snipe-host-*.ts` module (not this file). */
export const SNIPE_HOST_MODULES: Readonly<Record<string, SnipeHostModule>> = import.meta.glob<SnipeHostModule>(
  './snipe-host-*.ts',
  { eager: true },
);

/**
 * The background host: the runner already runs in the background context, so
 * acquire/release only record which snipes hold it. Both are idempotent.
 */
export class BackgroundSnipeHost implements SnipeHost {
  private readonly held = new Set<string>();

  acquire(snipeId: string): Promise<void> {
    this.held.add(snipeId);
    return Promise.resolve();
  }

  release(snipeId: string): Promise<void> {
    this.held.delete(snipeId);
    return Promise.resolve();
  }

  /** Whether `snipeId` holds this host (diagnostics and tests). */
  holds(snipeId: string): boolean {
    return this.held.has(snipeId);
  }
}

export interface SelectedSnipeHost {
  host: SnipeHost;
  /** The verdict the host was chosen for. */
  verdict: SnipeHostVerdict;
  /** 'background', or the module file of the registered implementation. */
  implementation: string;
  /** True when the verdict asked for an implementation that is not installed: the background host stands in. */
  degraded: boolean;
}

/**
 * Picks the host for `verdict` (default: this browser's S-7 verdict). A
 * registered implementation for the verdict wins (the first by file name);
 * 'background' always has the built-in host.
 */
export function createSnipeHost(
  deps: SnipeHostDeps,
  opts: { verdict?: SnipeHostVerdict; modules?: Readonly<Record<string, SnipeHostModule>> } = {},
): SelectedSnipeHost {
  const verdict = opts.verdict ?? hostVerdict();
  const modules = opts.modules ?? SNIPE_HOST_MODULES;
  for (const [file, mod] of Object.entries(modules).sort(([a], [b]) => a.localeCompare(b))) {
    const impl = mod.snipeHost;
    if (impl?.verdict !== verdict) continue;
    try {
      return { host: impl.create(deps), verdict, implementation: file, degraded: false };
    } catch (e) {
      deps.log(`snipe host ${file} could not be created; using the background host`, e);
    }
  }
  return { host: new BackgroundSnipeHost(), verdict, implementation: 'background', degraded: verdict !== 'background' };
}
