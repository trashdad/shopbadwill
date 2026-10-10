// T-83: the T-15 min preflight and the fallback policy. `fallbackDecision` is
// the only fallback rule (I-18): T-80's reducer calls it too. Pure: no I/O and
// no clock reads; every input, `now` included, comes in through the context,
// so equal inputs always give equal results (R6).
//
// Money rules, in one place:
// - The only bid this module can ask for is `applyFallbackProxy`, and its
//   amount is exactly `Snipe.maxBid` (frozen rule). It never emits `placeBid`.
// - No early proxy without a usable session (`sessionUsable`, and never for
//   reason 'auth'), without bidding writes allowed (`writesAllowed`: kill
//   switch, health, bidding gate), without a passing `checkCaps` for that
//   amount (which fails closed with no fresh ItemDetail), in a dry run (an
//   audit entry only), or once the snipe has left the pre-fire states (a bid
//   may already be out).
// - "Nothing to win" never applies the fallback: the auction is over (closed,
//   SGW's clock past its end, or our clock past the end) or the next
//   acceptable bid is above the max.
//
// Callers (T-80, T-84): call `fallbackDecision` BEFORE any disarm or kill
// transition. It returns null once the snipe is 'killed' (or otherwise past
// 'armed' / 'waking' / 'verified'), so a fallback asked for after the kill is
// silently lost.
import { formatMoney, nextAcceptable } from '../money';
import { formatDual, relative } from '../time/pacific';
import type { Cents, EpochMs, ItemDetail, SgwSessionState } from '../types';
import { checkCaps } from './caps';
import { assessClock, type ClockAbortReason, type ClockOffsetInput } from './timing';
import type { CapsCheck, CapsResult, Effect, Snipe, SnipeOutcome, SnipeState } from './types';

/** The runner's `:preflight` alarm fires this long before the auction end. */
export const PREFLIGHT_LEAD_MS = 15 * 60_000;
/** A preflight earlier than PREFLIGHT_LEAD_MS + this before the end is "not due": a no-op. */
export const PREFLIGHT_EARLY_SLACK_MS = 2 * 60_000;
/** R1: the saved session must stay valid until at least this long after the auction end. */
export const SESSION_MARGIN_AFTER_END_MS = 5 * 60_000;

export type Fallback = Snipe['fallback'];

/**
 * Why a preflight failed, in priority order. 'ended' and 'price' mean there is
 * nothing to win: the fallback is not applied. Every other reason applies it.
 */
export type PreflightReason = 'ended' | 'price' | 'auth' | 'clock' | 'keep-awake' | 'cap';

/**
 * Why a fallback is being applied: the fallback-applying preflight reasons,
 * plus T-80's verify-failed 'network' and T-84's auto-kill 'anomaly'.
 */
export type FallbackReason = Exclude<PreflightReason, 'ended' | 'price'> | 'network' | 'anomaly';

export interface PreflightFailure {
  reason: PreflightReason;
  /**
   * Machine-readable sub-cause: ended 'closed' | 'server-past-end' |
   * 'past-end'; price 'next-bid-above-max' | 'invalid-amount'; auth
   * 'logged-out' | 'expired' | 'no-token' | 'expires-before-end'; clock: T-81's
   * ClockAbortReason; keep-awake 'not-held'; cap: the violated kinds,
   * comma-separated ('per-day,exposure').
   */
  cause: string;
  /** Plain text for the user. Never contains a token. */
  detail: string;
}

export interface PreflightContext {
  now: EpochMs;
  /** The user's IANA zone (`settings.locale.timeZone`): notification times and the caps' local day. */
  timeZone: string;
  /**
   * `SgwSession.state()` and `current()`. Only `expiresAt` is read from the
   * token; passing `current()` as is is fine (the bearer is never touched).
   */
  session: { state: SgwSessionState; token: { readonly expiresAt: EpochMs } | null };
  /** `SgwClock.offset()`, judged by T-81's `assessClock`. */
  clockOffset: ClockOffsetInput | null;
  /**
   * 'not-required' unless the runner holds KeepAwake for this snipe (tier T1
   * on Chrome with `power` granted). The port has no "held" query, so the
   * runner reports what it did.
   */
  keepAwake: 'held' | 'not-held' | 'not-required';
  /**
   * `GlobalSwitches.writesAllowed('bidding').ok`, asked just before preflight.
   * It only gates the early proxy; it never fails preflight by itself (dry
   * runs run with bidding writes blocked).
   */
  writesAllowed: boolean;
  /** The preflight ItemDetail read (lane `background`); null when the read failed. */
  detail: ItemDetail | null;
  /** Inputs to T-82's `checkCaps` for `snipe.maxBid`. */
  caps: { limits: CapsCheck; others: readonly Snipe[]; spentToday: Cents };
}

export interface FallbackInput {
  reason: FallbackReason;
  /** Plain-text cause; it starts `Snipe.outcomeDetail`. */
  detail: string;
  /** `checkCaps` for `snipe.maxBid` at fallback time, with the freshest ItemDetail. */
  caps: CapsResult;
  /** False when the session is expired, logged out, rejected, or expires too soon. */
  sessionUsable: boolean;
  /** `GlobalSwitches.writesAllowed('bidding').ok`. */
  writesAllowed: boolean;
}

export interface FallbackDecision {
  /** `snipe.fallback`. */
  requested: Fallback;
  /** What is done: an early proxy degrades to 'skip' when any guard is closed. */
  applied: Fallback;
  degradedBecause?: 'auth' | 'writes-blocked' | 'cap';
  /** Next snipe state: an early proxy keeps the snipe open (it can still win). */
  state: Extract<SnipeState, 'fallback-applied' | 'resolved'>;
  outcome: Extract<SnipeOutcome, 'fallback-proxy-placed' | 'skipped' | 'dry-run'>;
  /** For `Snipe.outcomeDetail` and the notification body. */
  detail: string;
  /** Notification title prefix: 'Early bid', 'Dry run' or 'Snipe skipped'. */
  heading: string;
  /** Early proxy: applyFallbackProxy + audit. Dry run or skip: an audit entry only. */
  effects: Effect[];
}

export type PreflightResult =
  | { ok: true; warnings: string[]; effects: Effect[] }
  | {
      ok: false;
      /** `failures[0].reason`. */
      reason: PreflightReason;
      /** Every failed check, in priority order. */
      failures: PreflightFailure[];
      /** null when there is nothing to win ('ended', 'price'). */
      fallback: FallbackDecision | null;
      state: Extract<SnipeState, 'fallback-applied' | 'resolved'>;
      outcome: SnipeOutcome;
      /** For `Snipe.outcomeDetail`. */
      detail: string;
      effects: Effect[];
    }
  /** Nothing happens: the snipe is disarmed, killed, or already past preflight. */
  | PreflightNoOp<'not-armed'>
  /** Nothing happens: more than PREFLIGHT_LEAD_MS + PREFLIGHT_EARLY_SLACK_MS before the end. */
  | PreflightNoOp<'not-due'>;

/** A preflight that does nothing (one variant per reason, so `reason` narrows). */
export interface PreflightNoOp<R extends 'not-armed' | 'not-due'> {
  ok: false;
  reason: R;
  detail: string;
  effects: [];
}

/** States from which a fallback may still act: before any bid could have been sent. */
const PRE_FIRE_STATES: ReadonlySet<SnipeState> = new Set(['armed', 'waking', 'verified']);

/** Display money without throwing on a malformed amount (the caps check reports those). */
function money(cents: number): string {
  return Number.isSafeInteger(cents) && cents >= 0 ? formatMoney(cents) : String(cents);
}

function isoMs(iso: string): number {
  return new Date(iso).getTime();
}

const CLOCK_TEXT: Readonly<Record<ClockAbortReason, string>> = {
  'no-offset': "ShopGoodwill's clock could not be measured.",
  'bad-rtt': 'ShopGoodwill is answering too slowly (round trip over 2 s) to time a snipe.',
  'clock-skew': "This computer's clock is more than 5 minutes off ShopGoodwill's.",
};

/**
 * The lowest bid SGW will accept now, in integer cents; null when the detail's
 * amounts are not whole cents. With no bids yet it is the item's minimum bid
 * (the starting price); once there are bids it is the current price plus one
 * increment, through T-21's `nextAcceptable` (increments are not re-implemented).
 */
function nextAcceptableBid(d: ItemDetail): Cents | null {
  if (d.numBids === 0) return Number.isSafeInteger(d.minimumBid) && d.minimumBid >= 0 ? d.minimumBid : null;
  try {
    return nextAcceptable(d.currentPrice, d.bidIncrement);
  } catch {
    return null; // RangeError: malformed cents
  }
}

/**
 * Is the auction over? SGW's own clock first (the detail's serverTime against
 * its endTime), then ours: `serverNow` is local time corrected by a good clock
 * offset, or plain local time when the offset is unusable.
 */
function endedFailure(d: ItemDetail | null, serverNow: number, endMs: number): PreflightFailure | null {
  if (d?.isClosed) {
    return { reason: 'ended', cause: 'closed', detail: 'The auction has already closed (ended early or withdrawn).' };
  }
  if (d !== null && isoMs(d.serverTime) >= isoMs(d.endTime)) {
    return { reason: 'ended', cause: 'server-past-end', detail: "ShopGoodwill's own clock shows the auction end has passed." };
  }
  if (serverNow >= endMs) {
    return {
      reason: 'ended',
      cause: 'past-end',
      detail: 'The auction end time has passed: this check ran after the end (the computer may have been asleep).',
    };
  }
  return null;
}

function priceFailure(s: Snipe, d: ItemDetail): PreflightFailure | null {
  // R2 (corrected): price fails only when the next acceptable bid is above the max.
  const next = nextAcceptableBid(d);
  if (next === null) {
    return { reason: 'price', cause: 'invalid-amount', detail: 'The item price could not be read as whole cents.' };
  }
  // Written so a malformed (NaN) max also counts as nothing to win.
  if (!(next <= s.maxBid)) {
    return {
      reason: 'price',
      cause: 'next-bid-above-max',
      detail: `The next acceptable bid ${money(next)} is above your max ${money(s.maxBid)}: nothing to win.`,
    };
  }
  return null;
}

function sessionFailure(c: PreflightContext, endMs: number): PreflightFailure | null {
  const { state, token } = c.session;
  if (state === 'logged-out') {
    return { reason: 'auth', cause: 'logged-out', detail: 'You are not signed in to ShopGoodwill.' };
  }
  if (state !== 'ok' && state !== 'expiring') {
    // 'expired': SGW rejected the saved login or it ran out (S-2: the cause is unknown, so none is named).
    return { reason: 'auth', cause: 'expired', detail: 'ShopGoodwill no longer accepts the saved login.' };
  }
  if (token === null) {
    return { reason: 'auth', cause: 'no-token', detail: 'No ShopGoodwill login is saved.' };
  }
  if (!(token.expiresAt >= endMs + SESSION_MARGIN_AFTER_END_MS)) {
    const at = Number.isFinite(token.expiresAt) ? ` at ${formatDual(token.expiresAt, c.timeZone)}` : '';
    return {
      reason: 'auth',
      cause: 'expires-before-end',
      detail: `The saved ShopGoodwill login expires${at}, too close to the auction end.`,
    };
  }
  return null;
}

function auditEntry(
  s: Snipe,
  kind: string,
  details: Record<string, string | number | boolean | null>,
): Extract<Effect, { kind: 'audit' }> {
  return {
    kind: 'audit',
    snipeId: s.id,
    entry: { actor: 'snipe', kind, itemId: s.itemId, ref: s.id, details, dryRun: s.dryRun },
  };
}

function notify(s: Snipe, heading: string, message: string): Extract<Effect, { kind: 'notify' }> {
  return { kind: 'notify', snipeId: s.id, title: `${heading}: ${s.title}`, message };
}

/**
 * The fallback policy (the only one). An early proxy needs every guard open:
 * reason not 'auth', `sessionUsable`, `writesAllowed` and `caps.ok`;
 * otherwise it degrades to skip. Returns null when the snipe is not in a
 * pre-fire state ('armed', 'waking', 'verified'): after 'firing' a bid may
 * already be out, and a fallback must never add a second one. Call it before
 * any disarm or kill (see the file header).
 */
export function fallbackDecision(snipe: Snipe, input: FallbackInput): FallbackDecision | null {
  return PRE_FIRE_STATES.has(snipe.state) ? decide(snipe, input) : null;
}

function decide(snipe: Snipe, input: FallbackInput): FallbackDecision {
  const requested = snipe.fallback;
  const max = money(snipe.maxBid);
  const dry = snipe.dryRun ? 'Dry run: ' : '';

  let degradedBecause: FallbackDecision['degradedBecause'];
  if (requested === 'early-proxy') {
    if (input.reason === 'auth' || !input.sessionUsable) degradedBecause = 'auth';
    else if (!input.writesAllowed) degradedBecause = 'writes-blocked';
    else if (!input.caps.ok) degradedBecause = 'cap';
  }
  const proxy = requested === 'early-proxy' && degradedBecause === undefined;
  const applied: Fallback = proxy ? 'early-proxy' : 'skip';
  const audit = auditEntry(snipe, 'snipe.fallback', {
    reason: input.reason,
    requested,
    applied,
    degradedBecause: degradedBecause ?? null,
    sessionUsable: input.sessionUsable,
    writesAllowed: input.writesAllowed,
    amount: proxy ? snipe.maxBid : null,
  });
  const base = { requested, applied, ...(degradedBecause ? { degradedBecause } : {}) };

  if (proxy && !snipe.dryRun) {
    return {
      ...base,
      state: 'fallback-applied',
      outcome: 'fallback-proxy-placed',
      heading: 'Early bid',
      detail: `${input.detail} Placing your max ${max} now as an early proxy bid instead of sniping.`,
      effects: [{ kind: 'applyFallbackProxy', snipeId: snipe.id, amount: snipe.maxBid }, audit],
    };
  }
  if (proxy) {
    return {
      ...base,
      state: 'resolved',
      outcome: 'dry-run',
      heading: 'Dry run',
      detail: `${input.detail} Dry run: would have placed your max ${max} now as an early proxy bid. No bid was placed.`,
      effects: [audit],
    };
  }

  let why: string;
  if (degradedBecause === 'auth') {
    why = 'An early proxy bid needs a valid ShopGoodwill session, so the snipe was skipped. Sign in on shopgoodwill.com.';
  } else if (degradedBecause === 'writes-blocked') {
    why = 'An early proxy bid is not possible while bidding is blocked (kill switch, health check or bidding gate), so the snipe was skipped.';
  } else if (degradedBecause === 'cap') {
    why = `The early proxy bid of ${max} is blocked by a spending cap (${input.caps.violations.join('; ')}), so the snipe was skipped.`;
  } else {
    why = 'Skipped, as your fallback setting says.';
  }
  return {
    ...base,
    state: 'resolved',
    outcome: 'skipped',
    heading: 'Snipe skipped',
    detail: `${input.detail} ${dry}${why} No bid was placed.`,
    effects: [audit],
  };
}

/**
 * The T-15 min preflight: can this snipe still fire safely? Checks, in
 * priority order: auction not over (closed, SGW's clock, our clock) and next
 * acceptable bid within the max (R2), session and token (R1), clock (R3),
 * keep-awake held, caps. On failure the fallback is applied (R4) unless there
 * is nothing to win. A run more than 17 min before the end is "not due" and
 * does nothing. Pure (R6): the result lists the effects for the runner; it
 * does not perform them.
 *
 * An unreadable ItemDetail (`detail` null) is not a failure by itself: the
 * price and per-item cap go unchecked here (a warning) and T-60's verify read
 * checks them before any bid. It does stop an early proxy, because `checkCaps`
 * fails closed without detail.
 */
export function preflight(snipe: Snipe, ctx: PreflightContext): PreflightResult {
  if (snipe.state !== 'armed') {
    return {
      ok: false,
      reason: 'not-armed',
      detail: `Preflight skipped: the snipe is '${snipe.state}', not 'armed'.`,
      effects: [],
    };
  }

  const detail = ctx.detail !== null && ctx.detail.itemId === snipe.itemId ? ctx.detail : null;
  const endMs = Math.max(isoMs(snipe.endTime), detail === null ? Number.NEGATIVE_INFINITY : isoMs(detail.endTime));

  // Local time, as the runner's alarm is scheduled.
  if (ctx.now < endMs - PREFLIGHT_LEAD_MS - PREFLIGHT_EARLY_SLACK_MS) {
    return {
      ok: false,
      reason: 'not-due',
      detail: `Preflight is not due yet: it runs 15 min before the end, and the end is ${relative(endMs, ctx.now)}.`,
      effects: [],
    };
  }

  const clock = assessClock(ctx.clockOffset);
  const serverNow = clock.ok ? ctx.now + clock.offsetMs : ctx.now;
  const failures: PreflightFailure[] = [];
  const warnings: string[] = [];

  const ended = endedFailure(detail, serverNow, endMs);
  if (ended) {
    failures.push(ended);
  } else if (detail === null) {
    warnings.push(
      'The item could not be read, so the price and the per-item cap were not checked now; they are checked again 60 s before the bid.',
    );
  } else {
    const price = priceFailure(snipe, detail);
    if (price) failures.push(price);
  }

  const auth = sessionFailure(ctx, endMs);
  if (auth) failures.push(auth);

  if (!clock.ok) failures.push({ reason: 'clock', cause: clock.reason, detail: CLOCK_TEXT[clock.reason] });

  if (ctx.keepAwake === 'not-held') {
    failures.push({
      reason: 'keep-awake',
      cause: 'not-held',
      detail: 'Keep-awake is not held, so this computer may sleep before the auction ends.',
    });
  }

  const caps = checkCaps(snipe, ctx.caps.others, ctx.caps.spentToday, ctx.caps.limits, detail ?? undefined, ctx.timeZone);
  // Without detail checkCaps fails 'per-item' closed: that is the unchecked case above, not a failure.
  const blocking = detail === null ? caps.violations.filter((v) => !v.startsWith('per-item:')) : caps.violations;
  if (blocking.length > 0) {
    failures.push({
      reason: 'cap',
      cause: [...new Set(blocking.map((v) => v.split(':')[0] ?? v))].join(','),
      detail: `A spending cap blocks this bid: ${blocking.join('; ')}.`,
    });
  }

  const first = failures[0];
  if (first === undefined) {
    const lead = snipe.dryRun ? 'Dry run, no bid will be placed: would bid' : 'Bidding';
    return {
      ok: true,
      warnings,
      effects: [
        auditEntry(snipe, 'snipe.preflight', { ok: true, warning: warnings.length > 0 ? warnings.join(' ') : null }),
        notify(
          snipe,
          snipe.dryRun ? 'Dry-run snipe soon' : 'Snipe soon',
          `${lead} up to ${money(snipe.maxBid)}, ending ${formatDual(endMs, ctx.timeZone)} (${relative(endMs, serverNow)}). Keep this computer awake and the browser open.`,
        ),
      ],
    };
  }

  const causes = failures.map((f) => `${f.reason}:${f.cause}`).join(',');
  const reason = first.reason;

  // Nothing to win: no fallback.
  if (reason === 'ended' || reason === 'price') {
    const outcome: SnipeOutcome = reason === 'ended' ? 'ended' : 'skipped';
    const heading = reason === 'price' ? 'Snipe skipped' : first.cause === 'past-end' ? 'Ended' : 'Ended early';
    const text = `${first.detail} No bid was placed.`;
    return {
      ok: false,
      reason,
      failures,
      fallback: null,
      state: 'resolved',
      outcome,
      detail: text,
      effects: [
        auditEntry(snipe, 'snipe.preflight', { ok: false, reason, causes, fallback: 'not-applied', outcome }),
        notify(snipe, heading, text),
      ],
    };
  }

  // 'auth' sorts before every other fallback-applying reason, and sessionUsable
  // says so explicitly. The raw caps result goes in: without detail it fails
  // closed, so no early proxy.
  const decision = decide(snipe, {
    reason,
    detail: first.detail,
    caps,
    sessionUsable: auth === null,
    writesAllowed: ctx.writesAllowed,
  });
  return {
    ok: false,
    reason,
    failures,
    fallback: decision,
    state: decision.state,
    outcome: decision.outcome,
    detail: decision.detail,
    effects: [
      auditEntry(snipe, 'snipe.preflight', { ok: false, reason, causes, fallback: decision.applied, outcome: decision.outcome }),
      ...decision.effects,
      notify(snipe, decision.heading, decision.detail),
    ],
  };
}
