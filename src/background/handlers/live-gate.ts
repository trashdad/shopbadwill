// T-102: the live-bidding gate (PLAN §6, R1–R6). The background is the only
// authority: this module hooks `settings.set` through T-36's interceptor seam
// and judges every write. Any UI is a convenience.
//
// The gate:
//   - refuses turning `dryRun.bidding` OFF while
//     completedDryRuns < requiredDryRuns (R2), judging the KEPT count in
//     `next` (T-90 keeps it; a crafted patch can never raise it — R3);
//   - when the soak's on-time rate is below 95% (src/domain/snipe/soak.ts),
//     requires a typed confirmation (R2, I-25) and audits every override;
//   - refuses any `requiredDryRuns` decrease through settings.set (R3);
//   - always allows turning dry-run back ON with no confirmation (R2).
//
// The typed confirmation travels over a Port, NOT over settings.set: the
// frozen settings.set payload (SettingsSchema.partial()) has no field for it
// and zod strips unknown keys, and this task may not change the contract. A
// settings.set sent directly — without a confirmation through this port —
// is refused, so no UI can bypass the gate (R6). The port name is module
// private (not in the frozen PORT_NAMES map): it is a non-contract channel,
// like the test hooks' `sbw:test:*` ports.
import type { Cents, EpochMs } from '../../domain/types';
import type { AuditLog } from '../../domain/audit/types';
import { formatMoney } from '../../domain/money';
import { soakSummary } from '../../domain/snipe/soak';
import type { Snipe } from '../../domain/snipe/types';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { Repo } from '../../domain/storage/repo';
import type { Clock } from '../../ports/clock';
import type { BackgroundContext, RuntimePort, SettingsSetChange, SettingsSetVerdict } from '../context';

/** The port the UI opens to send the typed confirmation. One message per port: `{ confirmation }` → `{ ok }`. */
export const LIVE_GATE_PORT = 'sbw:live-gate';
/** The exact text the user must type to override the on-time warning. The match is exact (===): no trimming, no case folding. */
export const GO_LIVE_CONFIRMATION = 'GO LIVE';
/** How long a typed confirmation stays usable (the user types, then the UI sends settings.set). */
export const CONFIRM_TTL_MS = 2 * 60_000;
/** The on-time rate below which turning live needs the typed confirmation (R2: "below 95%"). */
export const ON_TIME_RATE_MIN = 0.95;
/**
 * The fewest completed dry runs live bidding ever needs: the schema default of
 * `requiredDryRuns` (R3). A stored value below it (corrupt, or from before
 * T-90) is judged as this floor, so the gate never opens on fewer.
 */
export const REQUIRED_DRY_RUNS_FLOOR = 5;
/** The "first live snipe" checklist link (R5): `docs/ACCEPTANCE.md` A-5 (T-105). */
export const FIRST_LIVE_CHECKLIST_URL = 'https://github.com/trashdad/shopbadwill/blob/main/docs/ACCEPTANCE.md#a-5-first-real-snipe-phase-5';
/** Audit kind for a `dryRun.bidding` → off transition (both the confirmed override and the clean switch). */
export const AUDIT_KIND_BIDDING_OFF = 'dryrun.bidding.off';

/** A confirmation the gate's port accepted, with when. */
export interface LiveGateConfirmation {
  at: EpochMs;
}

/** What the audit entry records when bidding goes live. */
export interface BiddingOffAudit {
  /** True when the user typed the confirmation (the <95% override); false at ≥95%. */
  confirmed: boolean;
  completedDryRuns: number;
  requiredDryRuns: number;
  firesAttempted: number;
  onTimeRate: number;
  maxBid: Cents;
  perDayMax: Cents;
}

export type LiveGateVerdict = { ok: true; audit: BiddingOffAudit | null } | { ok: false; veto: string };

/** The rate shown in copy, rounded to a whole percent. */
function percent(rate: number): number {
  return Math.round(rate * 100);
}

/**
 * The pure gate (R1): judges one settings.set change. `snipes` is the stored
 * snipe record (the soak's input); `confirmation` is what the port accepted,
 * or null; `now` is the wall clock for the confirmation TTL. Never throws,
 * never writes.
 */
export function liveGateVerdict(
  change: SettingsSetChange,
  snipes: readonly Snipe[],
  confirmation: LiveGateConfirmation | null,
  now: EpochMs,
): LiveGateVerdict {
  const { current, next } = change;

  // R3: the required count is locked. A decrease is refused outright (so the
  // stored value can never drop below the schema default of 5 through this
  // path); increases are allowed.
  if (next.snipe.requiredDryRuns < current.snipe.requiredDryRuns) {
    return {
      ok: false,
      veto:
        `The required dry-run count can be raised, never lowered: it starts at ${String(REQUIRED_DRY_RUNS_FLOOR)}. ` +
        `${String(current.snipe.requiredDryRuns)} stays in place.`,
    };
  }

  const biddingOff = current.dryRun.bidding && !next.dryRun.bidding;
  if (!biddingOff) return { ok: true, audit: null }; // turning ON, a no-op, or another group: always allowed (R2)

  // R3: judge the KEPT count in `next` (T-90's merge), never a patch value,
  // against at least the schema default.
  const completed = next.snipe.completedDryRuns;
  const required = Math.max(REQUIRED_DRY_RUNS_FLOOR, next.snipe.requiredDryRuns);
  if (completed < required) {
    const left = required - completed;
    return {
      ok: false,
      veto: `Complete ${String(left)} dry-run ${left === 1 ? 'snipe' : 'snipes'} before bidding live.`,
    };
  }

  const soak = soakSummary(snipes);
  const audit: BiddingOffAudit = {
    confirmed: false,
    completedDryRuns: completed,
    requiredDryRuns: required,
    firesAttempted: soak.firesAttempted,
    onTimeRate: soak.onTimeRate,
    maxBid: next.snipe.caps.perItemMax,
    perDayMax: next.snipe.caps.perDayMax,
  };

  // R2: at >= 95% no confirmation is asked.
  if (soak.onTimeRate >= ON_TIME_RATE_MIN) return { ok: true, audit };

  // Below 95%: the warning the user overrides with the typed confirmation.
  const fresh = confirmation !== null && now - confirmation.at <= CONFIRM_TTL_MS;
  if (fresh) return { ok: true, audit: { ...audit, confirmed: true } };

  // R5 honest copy: real money, the max bid, the daily cap, the terms warning,
  // the checklist link, and the exact phrase to type.
  return {
    ok: false,
    veto:
      `Live bids are real money: at most ${formatMoney(audit.maxBid)} for one item and ${formatMoney(audit.perDayMax)} per day. ` +
      `ShopGoodwill's terms may forbid automated bidding. Your dry-run snipes fired on time ${String(percent(soak.onTimeRate))}% ` +
      `of the time (below ${String(percent(ON_TIME_RATE_MIN))}%), so going live needs a typed confirmation. ` +
      `Read the first live snipe checklist (${FIRST_LIVE_CHECKLIST_URL}) first, then type ${GO_LIVE_CONFIRMATION} in the popup's Live bidding section to confirm.`,
  };
}

/**
 * A sender that is one of the extension's own pages (runtime.onConnect only
 * carries this extension's pages and content scripts). An allowlist: a
 * content script (a web page, about:blank, file:, data:) or a sender with no
 * url is not one.
 */
function fromExtensionPage(url: string | undefined): boolean {
  return url !== undefined && /^(chrome|moz)-extension:\/\/[^/]+\//.test(url);
}

/** The one gate of a background. Holds the pending confirmation and the interceptor. */
export class LiveGate {
  private confirmation: LiveGateConfirmation | null = null;

  constructor(
    private readonly clock: Pick<Clock, 'now'>,
    private readonly repo: Pick<Repo, 'get'>,
    private readonly audit: Pick<AuditLog, 'append'>,
  ) {}

  /**
   * Serves LIVE_GATE_PORT: one message per port, `{ confirmation }`, answered
   * `{ ok: true }` only for the exact phrase (R6), then the port closes. A
   * sender that is not an extension page is disconnected unheard. Accepting a message never
   * writes anything: it only arms a short-lived confirmation that the
   * settings.set interceptor — and nothing else — can consume.
   */
  servePort(port: RuntimePort): void {
    if (!fromExtensionPage(port.sender?.url)) {
      port.disconnect();
      return;
    }
    port.onMessage.addListener((message) => {
      const exact = typeof message === 'object' && message !== null && (message as { confirmation?: unknown }).confirmation === GO_LIVE_CONFIRMATION;
      if (exact) this.confirmation = { at: this.clock.now() };
      port.postMessage({ ok: exact });
      port.disconnect();
    });
  }

  /**
   * The settings.set interceptor (R1). Runs inside the settings write lock
   * (T-36): it reads the snipes for the soak, refuses with the veto copy, and
   * audits every allowed bidding-off transition. A failed audit refuses the
   * write (fail closed). It must not write `sbw:settings` (it would wait on
   * its own lock); the audit log is a different key.
   */
  async intercept(change: SettingsSetChange): Promise<SettingsSetVerdict> {
    const biddingOff = change.current.dryRun.bidding && !change.next.dryRun.bidding;
    const decreased = change.next.snipe.requiredDryRuns < change.current.snipe.requiredDryRuns;
    if (!biddingOff && !decreased) return undefined;

    const snipes: Snipe[] = biddingOff ? Object.values(await this.repo.get(STORAGE_KEYS.snipes)) : [];
    const verdict = liveGateVerdict(change, snipes, this.confirmation, this.clock.now());
    if (!verdict.ok) return { veto: verdict.veto };
    if (verdict.audit === null) return undefined;

    await this.audit.append({
      actor: 'user',
      kind: AUDIT_KIND_BIDDING_OFF,
      details: {
        confirmed: verdict.audit.confirmed,
        completedDryRuns: verdict.audit.completedDryRuns,
        requiredDryRuns: verdict.audit.requiredDryRuns,
        firesAttempted: verdict.audit.firesAttempted,
        onTimeRate: verdict.audit.onTimeRate,
        maxBid: verdict.audit.maxBid,
        perDayMax: verdict.audit.perDayMax,
      },
    });
    if (verdict.audit.confirmed) this.confirmation = null; // one-shot: the next override types again
    return undefined;
  }
}

/** T-36 self-registration (I-01). */
export function register(ctx: BackgroundContext): void {
  const gate = new LiveGate(ctx.clock, ctx.repo, ctx.audit);
  ctx.ports.serve(LIVE_GATE_PORT, (port) => {
    gate.servePort(port);
  });
  ctx.interceptors.settingsSet.add((change) => gate.intercept(change));
}
