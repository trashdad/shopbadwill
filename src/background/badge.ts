// T-86: the action badge. This module is the ONLY writer of the action badge
// (R3): nothing else calls `setBadgeText`/`setBadgeBackgroundColor`, and every
// change funnels through one serialized, idempotent writer.
//
// What it shows, in priority order (R3):
//   - `KILL` on a red background while the kill switch is on;
//   - otherwise the armed count, when it is greater than 0;
//   - otherwise `!` when Google needs the user to reconnect (the flag
//     `ctx.googleNeedsInteraction`, raised by the auth provider and
//     calendar-sync; main.ts wires it here — see its "T-86 owns the action
//     badge" comment). R3's "otherwise empty" still holds whenever the flag is
//     not raised;
//   - otherwise empty.
//
// It recomputes on snipe changes (storage.onChanged for `sbw:snipes`, which
// also covers writes made by another context), on switch changes
// (switches.onChange) and on the Google flag, and is idempotent: a recompute
// that does not change the shown text/color writes nothing.
//
// Registered from jobs/kill-disarm.ts (both are T-86 files): main.ts is frozen
// and the jobs/ glob cannot see this file directly.
import { browser } from 'wxt/browser';

import type { SnipeState } from '../domain/snipe/types';
import { STORAGE_KEYS } from '../domain/storage/schema';
import type { BackgroundContext } from './context';

export const KILL_BADGE_TEXT = 'KILL';
/** Red, matching the popup's `--danger` token. */
export const KILL_BADGE_COLOR = '#a1181f';
/** The browsers' default badge grey, restored when the kill switch is off. */
export const BADGE_DEFAULT_COLOR = '#5f5d5b';
/** "Google needs you to reconnect", when nothing else takes the badge. */
export const RECONNECT_BADGE_TEXT = '!';

/**
 * The snipe states that count as "armed" for the badge — the same set
 * kill-disarm targets: everything that could still act, including a `sent`
 * snipe whose outcome is pending.
 */
export const LIVE_SNIPE_STATES: ReadonlySet<SnipeState> = new Set([
  'armed',
  'fallback-applied',
  'waking',
  'verified',
  'firing',
  'sent',
]);

/** Serialized, idempotent action-badge writer. A failed write is retried on the next change. */
class ActionBadge {
  private text: string | undefined;
  private color: string | undefined;
  private chain: Promise<void> = Promise.resolve();

  apply(kill: boolean, googleNeedsInteraction: boolean, armed: number): void {
    const text = kill
      ? KILL_BADGE_TEXT
      : armed > 0
        ? String(armed)
        : googleNeedsInteraction
          ? RECONNECT_BADGE_TEXT
          : '';
    const color = kill ? KILL_BADGE_COLOR : BADGE_DEFAULT_COLOR;
    if (text === this.text && color === this.color) return;
    this.text = text;
    this.color = color;
    this.chain = this.chain
      .then(async () => {
        await browser.action.setBadgeText({ text });
        await browser.action.setBadgeBackgroundColor({ color });
      })
      .catch((e: unknown) => {
        // A failing badge must never take the background down; forget what was
        // "written" so the next change retries.
        this.text = undefined;
        this.color = undefined;
        console.warn('badge: writing the action badge failed', e);
      });
  }
}

/** T-36 self-registration pattern; called by kill-disarm.ts's register(ctx). */
export function registerBadge(ctx: BackgroundContext): void {
  const badge = new ActionBadge();
  let kill = ctx.switches.view().killSwitch;
  let googleNeedsInteraction = ctx.googleNeedsInteraction.get();
  let armed = 0;
  const recompute = (): void => {
    badge.apply(kill, googleNeedsInteraction, armed);
  };

  const readCount = (): void => {
    void ctx.repo
      .get(STORAGE_KEYS.snipes)
      .then((all) => {
        armed = Object.values(all).filter((s) => LIVE_SNIPE_STATES.has(s.state)).length;
        recompute();
      })
      .catch((e: unknown) => {
        // The badge keeps its last text rather than flickering on a failed read.
        console.warn('badge: reading the snipes failed; the badge stays as it is', e);
      });
  };

  ctx.switches.onChange((view) => {
    kill = view.killSwitch;
    recompute();
  });
  ctx.googleNeedsInteraction.subscribe((on) => {
    googleNeedsInteraction = on;
    recompute();
  });
  ctx.storage.local.onChanged((changes) => {
    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.snipes)) readCount();
  });
  // Kill (and !) must show before the snipe read returns. The count fills in when it does.
  kill = ctx.switches.view().killSwitch;
  googleNeedsInteraction = ctx.googleNeedsInteraction.get();
  recompute();
  readCount();
}
