// T-86: the kill switch's disarm-all (R1, R2, R6) and the badge's registration.
//
// Kill on — through `kill.set` (handlers/kill.ts) or T-36's Alt+Shift+K
// command (main.ts, which only ever turns it ON) — flips the switch in memory
// first, and every subscriber of `switches.onChange` sees that at once. This
// module subscribes there (R1: "subscribe through the existing switch-change
// API"), so the SOURCE of the kill does not matter.
//
// When the kill switch is on, every live snipe is disarmed through the snipe
// runner's public `dispatch` with a `disarm { by: 'kill' }` event (the
// runner's own seam comment names T-86's disarm-all; `disarm` is not an
// attempt event, so T-84b's refusal of outside attempt events does not apply).
// Each accepted disarm is audited by the reducer ('snipe.disarm', by: kill).
//
// A snipe in `sent` cannot be disarmed (a bid may be out): the reducer refuses
// with 'already-sent'. That refusal is EXPECTED (R2): it is audited as
// "kill: snipe <id> already sent; outcome pending", and this module never
// claims that snipe was stopped. Finished snipes (`resolved`, `killed`) and
// drafts are never touched. The refusal audit is deduplicated per kill episode
// (while the switch stays on, re-triggers — e.g. a storage write by the runner
// or another switch-view change — do not repeat it).
//
// R4: turning the kill switch OFF does not re-arm anything. Killed snipes stay
// `killed`; re-arming is only the user's explicit `snipe.arm` of a NEW snipe
// (T-84's path).
//
// R6: the whole pass runs without any tick or alarm — it starts the moment the
// switch view changes (or at startup, when the switch is already on) and each
// snipe is audited before the pass ends.
//
// It also calls registerBadge() (src/background/badge.ts): both files are
// T-86's, and main.ts is frozen, so the badge registers through this job
// module rather than being edited into main.ts.
import { registerBadge } from '../badge';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import { getSnipeRunner } from './snipe-runner';
import { errorText, type BackgroundContext } from '../context';

/** Why an accepted kill disarm is audited (the reducer records it as `details.why`). */
export const KILL_DISARM_WHY = 'stopped before it could bid';
/** R2: the audit kind for a snipe the kill switch could NOT stop because a bid may already be out. */
export const KILL_SNIPE_SENT_KIND = 'kill.snipe-sent';
/** A disarm refusal this module did not expect (not `sent`, not a finished snipe). */
export const KILL_DISARM_FAILED_KIND = 'kill.disarm-failed';

/** Every state that could still act: the disarm-all targets (drafts and finished snipes are skipped). */
const TARGET_STATES: ReadonlySet<string> = new Set([
  'armed',
  'fallback-applied',
  'waking',
  'verified',
  'firing',
  'sent',
]);

/** Refusals that are simply "there is nothing to stop" — silently skipped, never audited. */
const QUIET_REFUSALS: ReadonlySet<string> = new Set(['terminal', 'not-armed']);

/** The R2 audit text, verbatim (R2). */
export function sentRefusalNote(id: string): string {
  return `kill: snipe ${id} already sent; outcome pending`;
}

export function register(ctx: BackgroundContext): void {
  registerBadge(ctx);

  /** Audit entries for sent snipes already written in this kill episode (R2: audited once). */
  let sentAudited = new Set<string>();

  const audit = async (
    kind: string,
    entry: { itemId?: number; ref?: string; details: Record<string, string | number | boolean | null> },
  ): Promise<void> => {
    try {
      await ctx.audit.append({ actor: 'system', kind, ...entry });
    } catch (e) {
      console.warn('kill-disarm: auditing failed', e);
    }
  };

  const disarmAll = async (): Promise<void> => {
    const runner = getSnipeRunner(ctx);
    if (runner === undefined) {
      console.warn('kill-disarm: the snipe runner is not running; no snipes were disarmed');
      return;
    }
    let all;
    try {
      all = await runner.list();
    } catch (e) {
      console.warn('kill-disarm: reading the snipes failed', e);
      return;
    }
    for (const s of Object.values(all)) {
      if (!TARGET_STATES.has(s.state)) continue;
      let r;
      try {
        r = await runner.dispatch(s.id, { type: 'disarm', now: ctx.clock.now(), by: 'kill', why: KILL_DISARM_WHY });
      } catch (e) {
        // One failing snipe must not stop the pass for the rest.
        await audit(KILL_DISARM_FAILED_KIND, { itemId: s.itemId, ref: s.id, details: { why: errorText(e) } });
        continue;
      }
      if (r.kind === 'accepted') continue; // the reducer audits it ('snipe.disarm', by: kill)
      if (r.kind === 'rejected' && QUIET_REFUSALS.has(r.rejection.reason)) continue;
      if (r.kind === 'rejected' && r.rejection.reason === 'already-sent') {
        if (sentAudited.has(s.id)) continue;
        sentAudited.add(s.id);
        await audit(KILL_SNIPE_SENT_KIND, { itemId: s.itemId, ref: s.id, details: { note: sentRefusalNote(s.id) } });
        continue;
      }
      // 'busy' cannot apply to a disarm (it is not an attempt event); a 'missing'
      // snipe was removed meanwhile — nothing to stop, nothing to audit.
      if (r.kind === 'busy') {
        await audit(KILL_DISARM_FAILED_KIND, { itemId: s.itemId, ref: s.id, details: { why: r.detail } });
      }
    }
  };

  // Coalesce overlapping triggers into one pass; a trigger arriving during a
  // pass schedules exactly one more. `takeRerun` reads and clears the flag in
  // one step, so the loop condition is a function call (no constant narrowing).
  let running = false;
  let rerun = false;
  const takeRerun = (): boolean => {
    const r = rerun;
    rerun = false;
    return r;
  };
  const trigger = (): void => {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    void (async () => {
      // At startup the trigger fires from this module's own register(), before
      // the snipe-runner module has registered (file-name order): wait one turn
      // so getSnipeRunner(ctx) sees it. Still the same tick — no alarm, no timer.
      await Promise.resolve();
      do {
        try {
          await disarmAll();
        } catch (e) {
          console.warn('kill-disarm: the disarm-all pass failed', e);
        }
      } while (takeRerun());
    })().finally(() => {
      running = false;
      // A trigger that arrived after the last takeRerun() must not be lost.
      if (rerun) trigger();
    });
  };

  ctx.switches.onChange((view) => {
    if (view.killSwitch) trigger();
    else sentAudited = new Set(); // a fresh kill episode next time
  });
  // A snipe armed (by any writer) while the kill switch is on is stopped at once.
  ctx.storage.local.onChanged((changes) => {
    if (Object.prototype.hasOwnProperty.call(changes, STORAGE_KEYS.snipes) && ctx.switches.view().killSwitch) trigger();
  });
  // The worker started (or the switch was already on before register): catch the already-on state.
  if (ctx.switches.view().killSwitch) trigger();
}
