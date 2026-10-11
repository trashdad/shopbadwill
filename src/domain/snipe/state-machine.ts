// T-80: the snipe state machine, PLAN §3.9 `reduce(snipe, event, capsResult)
// → { next, effects }`. Pure domain code: it reads no clock, does no I/O and
// uses no randomness. Every instant comes in on the event (`now`, the local
// clock), every outside fact through the precomputed CapsResult (I-08) or the
// optional ReduceContext. The runner (T-84) persists `next` and executes the
// effects in order.
//
// Money rules, in one place (the core of the product):
// - `placeBid` is emitted only by `fire` in state 'verified', for a live
//   snipe, with a passing CapsResult, no more than 2 s before the planned
//   fire and before the end (server time). Its amount is exactly
//   `Snipe.maxBid`. `fire` moves the snipe to 'firing' and nothing leads back
//   to 'verified', so a snipe emits at most one `placeBid` (R2).
// - `applyFallbackProxy` comes only from T-83's `fallbackDecision` (I-18),
//   always called on the snipe BEFORE it changes state (C3). It answers null
//   once the snipe has fired, and a dry run gets an audit entry instead, so a
//   fallback never adds a second bid and `fire` is refused once a fallback is
//   applied. A cap failure never reaches the fallback: an early proxy for the
//   same amount cannot pass the same caps, so it ends 'cap-blocked'.
// - 'sent' is terminal for sending (R3). The runner dispatches `sent {key}`
//   BEFORE any PlaceBid leaves (the snipe's or the early proxy's, C5) and
//   sends ONLY if the reducer accepted it. A second `sent` or `fire` is
//   refused, and so is a `sent` for a snipe that already holds a key. After
//   `sent` nothing stops the snipe: every disarm is refused, so a possibly
//   live bid stays open (exposure) until the outcome read settles it.
// - One reply per attempt: `result` records SGW's reply on `attempt.reply`;
//   a second `result`, or one after `ambiguous` (and vice versa), is refused.
// - A sent snipe settles one of three ways (T-80b R1/R2): the `post-read`
//   outcome read; `post-read-failed` when the runner gives up reading it
//   (resolves through classifyOutcome with the reply and no ItemDetail:
//   "Unconfirmed … check ShopGoodwill", never "Not bid"); or `not-sent` when
//   bid.ts proved nothing went out (BidNotSentError: resolves as "No bid was
//   sent (…)", never through the judge path, and the proof is recorded on
//   `attempt.notSent`).
// - A dry run walks the same states. Its `fire` emits a `measure` read and a
//   `bid.dry-run` audit entry in place of `placeBid`, and the measure read's
//   `post-read` resolves it as 'dry-run' (C4). If that read never arrives,
//   `post-read-failed` in `firing` resolves it as Unconfirmed (the dry-run
//   measure failed). The same event in `firing` is refused for a live snipe:
//   nothing has been sent, so there is nothing to give up on.
// - Every outcome and its copy come from T-87's `classifyOutcome` (I-18),
//   pre-bid ends included (its `abort` reasons).
//
// Every state × event pair is in TRANSITIONS (R1): either the possible next
// states or a typed rejection. A rejected event returns the very same snipe
// object and no effects. The table and the handler switch are typed from the
// contract's zod unions, so a new state or event fails to compile until it is
// placed in the table.
import type { BidResultKind, EpochMs, ItemDetail } from '../types';
import { checkCaps, DEFAULT_TIME_ZONE, spentToday } from './caps';
import { classifyOutcome, type AbortReason, type Classification, type OutcomeContext } from './outcome';
import { fallbackDecision, isoMs, type Fallback, type FallbackReason, type PreflightReason } from './preflight';
import { assessClock, computeFireAt, type ClockAbortReason } from './timing';
import { LeadMsSchema, type CapsCheck, type CapsResult, type Effect, type Snipe, type SnipeEvent, type SnipeState } from './types';

/**
 * How far an auction end may move after a late bid before the engine stops
 * trusting its plan. S-3 (docs/spikes/S-3.md) found no extension for bids
 * 5.8 s and 6.8 s before the end and recommends 0 (hard close). With 0, any
 * end later than the planned one takes the 'extended' path (R4).
 */
export const ASSUME_EXTENSION_MS = 0;

/** The wake alarm goes off this long before the planned fire (PLAN §1.3). */
export const WAKE_BEFORE_FIRE_MS = 5 * 60_000;

/** `fire` is refused when it comes more than this long before the planned fire (server time). */
export const FIRE_EARLY_TOLERANCE_MS = 2000;

export type SnipeEventType = SnipeEvent['type'];

/** Why an event was refused. A refused event changes nothing and emits nothing. */
export type RejectReason =
  /** The snipe is 'resolved' or 'killed': nothing more happens to it. */
  | 'terminal'
  /** Still a draft: it must be armed first. */
  | 'not-armed'
  /** `arm` on a snipe that is already past 'draft'. */
  | 'already-armed'
  /** A verify result before the wake. */
  | 'not-awake'
  /** `fire` before the T−60 s verify passed. */
  | 'not-verified'
  /** `fire` more than FIRE_EARLY_TOLERANCE_MS before the planned fire. */
  | 'too-early'
  /** `sent` before `fire`. */
  | 'not-firing'
  /** A reply or outcome read before anything was sent. */
  | 'not-sent'
  /** The event belongs to a step this snipe has already passed. */
  | 'step-passed'
  /** A second `fire` (R3). */
  | 'already-fired'
  /** Sending is over for this snipe (R3), or it already holds an idempotency key. */
  | 'already-sent'
  /** The fallback replaced the snipe and was decided: only its `sent` or a user/kill disarm apply. */
  | 'fallback-applied'
  /** A dry run never sends anything. */
  | 'dry-run'
  /** The precomputed CapsResult is not ok. */
  | 'caps'
  /** The snipe cannot be armed as it is (bad max or lead, ended, a recorded send). */
  | 'invalid-snipe'
  /** The event's data is unusable (another item's read, an unknown reason, an empty key). */
  | 'invalid-event'
  /** The same event twice, or a second reply for one attempt. */
  | 'duplicate';

export interface Rejection {
  reason: RejectReason;
  /** Plain text for logs and the audit trail. */
  detail: string;
}

/**
 * One cell of the table: either the states the event can lead to (plus the
 * data-dependent rejections, "guards", it may still return), or a rejection.
 */
export type TransitionCell =
  | { readonly to: readonly SnipeState[]; readonly guards?: readonly RejectReason[] }
  | { readonly reject: RejectReason };

/** `reduce`'s answer. `rejection` is null for an accepted event. */
export interface ReduceResult {
  next: Snipe;
  effects: Effect[];
  rejection: Rejection | null;
}

/**
 * What the reducer needs besides the snipe, the event and the CapsResult.
 * Optional, so `reduce` still fits the frozen `Reduce` type; without it every
 * fallback fails closed (no early proxy).
 */
export interface ReduceContext {
  /** The user's IANA zone (`settings.locale.timeZone`) for notification times. Default America/New_York. */
  timeZone?: string;
  /**
   * Whether the SGW session could place a bid: false when it is expired,
   * logged out, rejected or expires too soon. Default false. When false, a
   * fallback is decided with reason 'auth' (C2).
   */
  sessionUsable?: boolean;
  /**
   * `GlobalSwitches.writesAllowed('bidding').ok`. For a dry-run snipe the
   * caller passes it with the dry-run condition ignored (kill switch, health
   * and session still count), so the dry run shows what the live fallback
   * would do (C4). Default false.
   */
  writesAllowed?: boolean;
}

const accept = (...to: SnipeState[]): TransitionCell => Object.freeze({ to: Object.freeze(to) });
const guarded = (to: SnipeState[], guards: RejectReason[]): TransitionCell =>
  Object.freeze({ to: Object.freeze(to), guards: Object.freeze(guards) });
const reject = (reason: RejectReason): TransitionCell => Object.freeze({ reject: reason });

/** A row whose every event gets the same rejection. */
function rejectAll(reason: RejectReason): { readonly [E in SnipeEventType]: TransitionCell } {
  const r = reject(reason);
  return {
    arm: r,
    disarm: r,
    wake: r,
    verified: r,
    'verify-failed': r,
    fire: r,
    sent: r,
    result: r,
    ambiguous: r,
    'post-read': r,
    'post-read-failed': r,
    'not-sent': r,
    'preflight-failed': r,
    'apply-fallback': r,
  };
}

type TransitionTable = { readonly [S in SnipeState]: { readonly [E in SnipeEventType]: TransitionCell } };

/** Frozen at load: the table drives the money path, so no importer may change it. */
function freezeTable(t: TransitionTable): TransitionTable {
  for (const row of Object.values(t)) Object.freeze(row);
  return Object.freeze(t);
}

/**
 * R1: the whole state × event table. `disarm` leads to 'killed', except that a
 * `disarm(anomaly)` whose fallback places a live early proxy leads to
 * 'fallback-applied': that proxy is a real bid, so the snipe stays open for its
 * `sent` (C5) and keeps counting in the caps' exposure.
 */
export const TRANSITIONS: TransitionTable = freezeTable({
  draft: {
    ...rejectAll('not-armed'),
    arm: guarded(['armed'], ['caps', 'invalid-snipe']),
    disarm: accept('killed'),
  },
  armed: {
    arm: reject('already-armed'),
    disarm: accept('killed', 'fallback-applied'),
    wake: accept('waking'),
    verified: reject('not-awake'),
    'verify-failed': reject('not-awake'),
    fire: reject('not-verified'),
    sent: reject('not-firing'),
    result: reject('not-sent'),
    ambiguous: reject('not-sent'),
    'post-read': reject('not-sent'),
    'post-read-failed': reject('not-sent'),
    'not-sent': reject('not-firing'),
    'preflight-failed': guarded(['resolved', 'fallback-applied'], ['invalid-event']),
    'apply-fallback': accept('resolved', 'fallback-applied'),
  },
  'fallback-applied': {
    ...rejectAll('fallback-applied'),
    arm: reject('already-armed'),
    // m1: a disarm by anomaly would ask for a fallback that was already decided.
    disarm: guarded(['killed'], ['fallback-applied']),
    sent: guarded(['sent'], ['dry-run', 'already-sent', 'invalid-event']),
    result: reject('not-sent'),
    ambiguous: reject('not-sent'),
    'post-read': reject('not-sent'),
    'post-read-failed': reject('not-sent'),
    'not-sent': reject('not-sent'),
  },
  waking: {
    arm: reject('already-armed'),
    disarm: accept('killed', 'fallback-applied'),
    wake: reject('step-passed'),
    verified: guarded(['verified', 'resolved', 'fallback-applied'], ['invalid-event']),
    'verify-failed': accept('resolved', 'fallback-applied'),
    fire: reject('not-verified'),
    sent: reject('not-firing'),
    result: reject('not-sent'),
    ambiguous: reject('not-sent'),
    'post-read': reject('not-sent'),
    'post-read-failed': reject('not-sent'),
    'not-sent': reject('not-firing'),
    'preflight-failed': reject('step-passed'),
    'apply-fallback': accept('resolved', 'fallback-applied'),
  },
  verified: {
    arm: reject('already-armed'),
    disarm: accept('killed', 'fallback-applied'),
    wake: reject('step-passed'),
    verified: reject('step-passed'),
    'verify-failed': accept('resolved', 'fallback-applied'),
    // Resolves (cap-blocked or missed) instead of firing on a failing CapsResult or at the end.
    fire: guarded(['firing', 'resolved'], ['too-early']),
    sent: reject('not-firing'),
    result: reject('not-sent'),
    ambiguous: reject('not-sent'),
    'post-read': reject('not-sent'),
    'post-read-failed': reject('not-sent'),
    'not-sent': reject('not-firing'),
    'preflight-failed': reject('step-passed'),
    'apply-fallback': accept('resolved', 'fallback-applied'),
  },
  firing: {
    ...rejectAll('step-passed'),
    arm: reject('already-armed'),
    disarm: accept('killed'),
    fire: reject('already-fired'),
    sent: guarded(['sent'], ['dry-run', 'already-sent', 'invalid-event']),
    result: reject('not-sent'),
    ambiguous: reject('not-sent'),
    // Only a dry run's measure read. A live firing snipe has sent nothing, so
    // both the read and a give-up are refused (`not-sent`).
    'post-read': guarded(['resolved'], ['not-sent', 'invalid-event']),
    'post-read-failed': guarded(['resolved'], ['not-sent']),
    'not-sent': reject('not-sent'),
  },
  // R3: after sent, only the reply, the ambiguity, the outcome read, and the
  // two T-80b events that settle a sent snipe without an ItemDetail. No disarm (I3).
  sent: {
    ...rejectAll('already-sent'),
    result: guarded(['sent', 'resolved'], ['dry-run', 'duplicate']),
    ambiguous: guarded(['sent'], ['dry-run', 'duplicate']),
    'post-read': guarded(['resolved'], ['invalid-event']),
    // T-80b R1: the runner gave up on the outcome read; settle with the reply
    // (or none) and no ItemDetail.
    'post-read-failed': guarded(['resolved'], ['dry-run']),
    // T-80b R2: bid.ts proved nothing was sent. Refused once a reply or the
    // ambiguity is recorded (the bid may have registered after all).
    'not-sent': guarded(['resolved'], ['dry-run', 'duplicate']),
  },
  resolved: rejectAll('terminal'),
  killed: rejectAll('terminal'),
});

const TERMINAL: ReadonlySet<SnipeState> = new Set(['resolved', 'killed']);
/** T-83's pre-fire states: the only ones a fallback can act in. */
const PRE_FIRE: ReadonlySet<SnipeState> = new Set(['armed', 'waking', 'verified']);
/** Replies that prove the bid did not register: the snipe resolves on them without a post-read. */
const NOT_REGISTERED: ReadonlySet<BidResultKind> = new Set(['closed', 'below-minimum', 'auth', 'restricted']);

const REJECT_TEXT: Readonly<Record<RejectReason, string>> = {
  terminal: 'The snipe is finished; nothing more happens to it.',
  'not-armed': 'The snipe is a draft; arm it first.',
  'already-armed': 'The snipe is already armed.',
  'not-awake': 'A verify result arrived before the wake.',
  'not-verified': 'The snipe cannot fire before the 60-second verify passed.',
  'too-early': 'It is more than 2 s before the planned fire.',
  'not-firing': 'Nothing can be sent before the snipe fires.',
  'not-sent': 'Nothing has been sent, so there is no reply or outcome to read.',
  'step-passed': 'The snipe is past the step this event belongs to.',
  'already-fired': 'The snipe has already fired; it fires once.',
  'already-sent': 'The bid may already be out; nothing can be sent or stopped now. The outcome read settles it.',
  'fallback-applied': 'The fallback replaced this snipe and was already decided.',
  'dry-run': 'A dry run never sends anything.',
  caps: 'A spending cap blocks this snipe.',
  'invalid-snipe': 'The snipe cannot be armed as it is.',
  'invalid-event': 'The event data cannot be used.',
  duplicate: 'This attempt already has its reply or its ambiguity recorded.',
};

/** One audit entry per accepted event; `fire` in a dry run audits as 'bid.dry-run'. */
const AUDIT_KIND: Readonly<Record<SnipeEventType, string>> = {
  arm: 'snipe.arm',
  disarm: 'snipe.disarm',
  wake: 'snipe.wake',
  verified: 'snipe.verified',
  'verify-failed': 'snipe.verify-failed',
  fire: 'bid.fire',
  sent: 'bid.sent',
  result: 'bid.result',
  ambiguous: 'bid.ambiguous',
  'post-read': 'snipe.post-read',
  'post-read-failed': 'snipe.post-read-failed',
  'not-sent': 'bid.not-sent',
  'preflight-failed': 'snipe.preflight-failed',
  'apply-fallback': 'snipe.apply-fallback',
};

/** The preflight reasons a `preflight-failed` event may carry (T-83's PreflightReason). */
const PREFLIGHT_REASONS = ['ended', 'price', 'auth', 'clock', 'keep-awake', 'cap'] as const satisfies readonly PreflightReason[];

const CLOCK_CAUSE: Readonly<Record<ClockAbortReason, string>> = {
  'no-offset': "At the 60-second check, ShopGoodwill's clock could not be measured.",
  'bad-rtt': 'At the 60-second check, ShopGoodwill answered too slowly (round trip over 2 s) to time the snipe.',
  'clock-skew': "At the 60-second check, this computer's clock was more than 5 minutes off ShopGoodwill's.",
};

const VERIFY_CAUSE: Readonly<Record<'auth' | 'network' | 'clock', string>> = {
  auth: 'At the 60-second check, the ShopGoodwill session could not place a bid.',
  network: 'At the 60-second check, ShopGoodwill could not be reached.',
  clock: "At the 60-second check, ShopGoodwill's clock could not be confirmed.",
};

const PREFLIGHT_CAUSE: Readonly<Record<'auth' | 'clock' | 'keep-awake', string>> = {
  auth: 'The 15-minute check found the ShopGoodwill session unusable.',
  clock: "The 15-minute check could not confirm ShopGoodwill's clock.",
  'keep-awake': 'Keep-awake is not held, so this computer may sleep before the auction ends.',
};

type Details = Record<string, string | number | boolean | null>;
type AuditEffect = Extract<Effect, { kind: 'audit' }>;

/** What a handler decided for an accepted event (the reducer adds the audit entry). */
interface Accepted {
  next: Snipe;
  effects: Effect[];
  details?: Details;
  auditKind?: string;
}
type Handled = Accepted | { rejection: Rejection };

// ── Small helpers ───────────────────────────────────────────────────────────

/** A local instant in SGW's time, once the T−60 s verify measured the offset (server − local). */
function serverTime(s: Snipe, localMs: EpochMs): EpochMs {
  return localMs + (s.measured?.offsetMs ?? 0);
}

function clip(text: string, max = 200): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function refuse(reason: RejectReason, detail: string = REJECT_TEXT[reason]): Handled {
  return { rejection: { reason, detail } };
}

/** The snipe after an accepted event: the new state, `patch`, and one history entry. */
function step(s: Snipe, e: SnipeEvent, to: SnipeState, why: string, patch: Partial<Snipe> = {}): Snipe {
  return { ...s, ...patch, state: to, history: [...s.history, { at: e.now, from: s.state, to, why }] };
}

function notify(s: Snipe, heading: string, message: string): Extract<Effect, { kind: 'notify' }> {
  return { kind: 'notify', snipeId: s.id, title: `${heading}: ${s.title}`, message };
}

function audit(s: Snipe, kind: string, details: Details): AuditEffect {
  return { kind: 'audit', snipeId: s.id, entry: { actor: 'snipe', kind, itemId: s.itemId, ref: s.id, details, dryRun: s.dryRun } };
}

function outcomeContext(ctx: ReduceContext, abort?: AbortReason, abortDetail?: string): OutcomeContext {
  return {
    userTz: ctx.timeZone ?? DEFAULT_TIME_ZONE,
    ...(abort !== undefined ? { abort } : {}),
    ...(abortDetail !== undefined ? { abortDetail } : {}),
  };
}

// ── Outcomes ────────────────────────────────────────────────────────────────

/** Resolve (or kill) on a T-87 classification: its notification, its calendar stamp, and a re-arm proposal when extended (R4). */
function settled(s: Snipe, e: SnipeEvent, to: 'resolved' | 'killed', c: Classification, why: string): Accepted {
  const effects: Effect[] = [c.notify];
  if (c.stamp !== null) effects.push(c.stamp);
  // R4: propose, never re-arm by itself.
  if (c.outcome === 'extended') effects.push({ kind: 'proposeRearm', snipeId: s.id });
  return { next: step(s, e, to, why, { outcome: c.outcome, outcomeDetail: c.detail }), effects, details: { final: c.final } };
}

/**
 * A pre-bid end, classified by T-87 from its `abort` reason (killed, ended,
 * cap, extended, price, already-high, missed). `post` is the read that showed
 * it, when there is one.
 */
function aborted(
  s: Snipe,
  e: SnipeEvent,
  ctx: ReduceContext,
  to: 'resolved' | 'killed',
  abort: AbortReason,
  why: string,
  post: ItemDetail | null = null,
): Accepted {
  return settled(s, e, to, classifyOutcome(s, null, post, outcomeContext(ctx, abort)), why);
}

/** I1: a cap failure ends the snipe 'cap-blocked'; it never reaches the fallback. */
function capBlocked(s: Snipe, e: SnipeEvent, ctx: ReduceContext, caps: CapsResult, why: string): Accepted {
  const done = aborted(s, e, ctx, 'resolved', 'cap', why);
  return { ...done, details: { ...done.details, violations: caps.violations.join('; ') } };
}

/**
 * Apply the user's fallback through T-83's `fallbackDecision` (I-18), called
 * on the snipe as it is now, before any transition (C3). `requested` can only
 * narrow the user's choice to 'skip'. An early proxy leads to
 * 'fallback-applied'; anything else to `onSkip`.
 */
function fallback(
  s: Snipe,
  e: SnipeEvent,
  base: Exclude<FallbackReason, 'cap'>,
  cause: string,
  caps: CapsResult,
  ctx: ReduceContext,
  onSkip: 'resolved' | 'killed',
  requested: Fallback = s.fallback,
): Accepted | null {
  const sessionUsable = ctx.sessionUsable === true && base !== 'auth';
  // C2: any session failure is reason 'auth' (it also sorts first in preflight).
  const reason: FallbackReason = sessionUsable ? base : 'auth';
  const asked = requested === s.fallback ? s : { ...s, fallback: requested };
  const d = fallbackDecision(asked, { reason, detail: cause, caps, sessionUsable, writesAllowed: ctx.writesAllowed === true });
  if (d === null) return null;
  const to = d.state === 'fallback-applied' ? 'fallback-applied' : onSkip;
  return {
    next: step(s, e, to, `${e.type}: fallback ${d.applied} (${reason})`, { outcome: d.outcome, outcomeDetail: d.detail }),
    effects: [...d.effects, notify(s, d.heading, d.detail)],
    details: { fallbackReason: reason, fallbackApplied: d.applied },
  };
}

/** `fallback` for a pre-fire snipe, where `fallbackDecision` always answers. */
function preFireFallback(
  s: Snipe,
  e: SnipeEvent,
  base: Exclude<FallbackReason, 'cap'>,
  cause: string,
  caps: CapsResult,
  ctx: ReduceContext,
  requested?: Fallback,
): Accepted {
  const r = fallback(s, e, base, cause, caps, ctx, 'resolved', requested);
  if (r === null) throw new Error(`T-80: no fallback decision for '${s.state}'; the table admits this event only before the fire`);
  return r;
}

// ── Handlers ────────────────────────────────────────────────────────────────

function invalidSnipe(s: Snipe, now: EpochMs): string | null {
  if (!(Number.isSafeInteger(s.maxBid) && s.maxBid > 0)) return 'The max bid must be a positive whole number of cents.';
  if (!LeadMsSchema.safeParse(s.leadMs).success) return 'The lead must be a whole number of ms from 3 to 30 s.';
  const endMs = isoMs(s.endTime);
  if (!Number.isFinite(endMs)) return 'The auction end time is not a valid instant.';
  if (now >= endMs) return 'The auction has already ended.';
  if (s.attempt.sentAt !== undefined || s.attempt.idempotencyKey !== undefined || s.attempt.reply !== undefined) {
    return 'A draft must not carry a send attempt (the arm handler resets it).';
  }
  return null;
}

function onArm(s: Snipe, e: Extract<SnipeEvent, { type: 'arm' }>, caps: CapsResult): Handled {
  if (!caps.ok) return refuse('caps', `A spending cap blocks this snipe: ${caps.violations.join('; ')}.`);
  const problem = invalidSnipe(s, e.now);
  if (problem !== null) return refuse('invalid-snipe', problem);
  // Provisional plan (no latency yet); `verified` replaces it with the measured one.
  const fireAt = computeFireAt(isoMs(s.endTime), s.leadMs, 0);
  const wakeAt = Math.max(e.now, fireAt - WAKE_BEFORE_FIRE_MS);
  return {
    next: step(s, e, 'armed', 'arm', { armedAt: e.now, fireAt }),
    effects: [
      { kind: 'scheduleWake', snipeId: s.id, at: wakeAt },
      { kind: 'holdKeepAwake', snipeId: s.id, hold: true },
    ],
    details: { maxBid: s.maxBid, leadMs: s.leadMs, fallback: s.fallback, fireAt, wakeAt },
  };
}

function onDisarm(s: Snipe, e: Extract<SnipeEvent, { type: 'disarm' }>, caps: CapsResult, ctx: ReduceContext): Handled {
  // m1: the early proxy was this snipe's fallback; an anomaly cannot ask for another.
  if (s.state === 'fallback-applied' && e.by === 'anomaly') return refuse('fallback-applied');
  const details = { by: e.by, why: clip(e.why) };
  if (e.by === 'anomaly' && PRE_FIRE.has(s.state)) {
    // C3: the fallback is decided on the snipe as it is, before the kill.
    const fb = fallback(s, e, 'anomaly', `Stopped automatically: ${clip(e.why)}.`, caps, ctx, 'killed');
    if (fb !== null) return { ...fb, details: { ...details, ...fb.details } };
  }
  return { ...aborted(s, e, ctx, 'killed', 'killed', `disarm:${e.by}`), details };
}

function onWake(s: Snipe, e: Extract<SnipeEvent, { type: 'wake' }>): Handled {
  return {
    next: step(s, e, 'waking', 'wake'),
    effects: [
      { kind: 'sampleClock', snipeId: s.id },
      // The runner takes it at T−60 s, after the clock samples.
      { kind: 'readDetail', snipeId: s.id, purpose: 'verify' },
    ],
  };
}

function onVerified(s: Snipe, e: Extract<SnipeEvent, { type: 'verified' }>, caps: CapsResult, ctx: ReduceContext): Handled {
  const d: ItemDetail = e.detail;
  if (d.itemId !== s.itemId) return refuse('invalid-event', 'The verify read is for another item.');
  const endMs = isoMs(d.endTime);
  if (d.isClosed || isoMs(d.serverTime) >= endMs) return aborted(s, e, ctx, 'resolved', 'ended', 'verified: auction closed', d);
  if (endMs > isoMs(s.endTime) + ASSUME_EXTENSION_MS) return aborted(s, e, ctx, 'resolved', 'extended', 'verified: end moved later', d);
  // The runner sends `verified` only with a usable sample, so the event has no
  // confidence field; 'low' re-checks the rtt and skew bounds (T-81).
  const clock = assessClock({ offsetMs: e.offsetMs, rttMs: e.rttMs, confidence: 'low' });
  if (!clock.ok) return preFireFallback(s, e, 'clock', CLOCK_CAUSE[clock.reason], caps, ctx);
  // C1: the caller ran checkCaps with this read (capsForEvent).
  if (!caps.ok) return capBlocked(s, e, ctx, caps, 'verified: cap');
  const fireAt = computeFireAt(endMs, s.leadMs, clock.oneWayMs);
  return {
    next: step(s, e, 'verified', 'verified', {
      endTime: d.endTime,
      fireAt,
      measured: { ...s.measured, offsetMs: e.offsetMs, rttMs: e.rttMs },
    }),
    effects: [],
    details: { fireAt, offsetMs: e.offsetMs, rttMs: e.rttMs, endTime: d.endTime, minimumBid: d.minimumBid },
  };
}

function onVerifyFailed(s: Snipe, e: Extract<SnipeEvent, { type: 'verify-failed' }>, caps: CapsResult, ctx: ReduceContext): Handled {
  const details = { reason: e.reason };
  const why = `verify-failed: ${e.reason}`;
  let done: Accepted;
  switch (e.reason) {
    case 'ended':
      done = aborted(s, e, ctx, 'resolved', 'ended', why);
      break;
    case 'extended':
      done = aborted(s, e, ctx, 'resolved', 'extended', why);
      break;
    case 'price-over-max':
      done = aborted(s, e, ctx, 'resolved', 'price', why);
      break;
    case 'already-high':
      done = aborted(s, e, ctx, 'resolved', 'already-high', why);
      break;
    case 'cap':
      done = capBlocked(s, e, ctx, caps, why);
      break;
    case 'auth':
    case 'network':
    case 'clock':
      done = preFireFallback(s, e, e.reason, VERIFY_CAUSE[e.reason], caps, ctx);
      break;
  }
  return { ...done, details: { ...details, ...done.details } };
}

function onFire(s: Snipe, e: Extract<SnipeEvent, { type: 'fire' }>, caps: CapsResult, ctx: ReduceContext): Handled {
  const firedAt = serverTime(s, e.now);
  const endMs = isoMs(s.endTime);
  // m2: the window is [fireAt − 2 s, end) in server time, from the event's clock.
  const plannedAt = s.fireAt ?? computeFireAt(endMs, s.leadMs, 0);
  if (firedAt < plannedAt - FIRE_EARLY_TOLERANCE_MS) {
    return refuse('too-early', `The fire came ${String(Math.round(plannedAt - firedAt))} ms before the planned fire.`);
  }
  if (firedAt >= endMs) return aborted(s, e, ctx, 'resolved', 'missed', 'fire: after the end');
  // The money transition re-checks the precomputed caps too.
  if (!caps.ok) return capBlocked(s, e, ctx, caps, 'fire: cap');
  const next = step(s, e, 'firing', 'fire', { measured: { ...s.measured, firedAt } });
  const details = { amount: s.maxBid, fireAt: plannedAt, firedAt };
  if (s.dryRun) {
    // C4: the same path; a harmless read at fire time measures real latency in place of PlaceBid.
    return { next, effects: [{ kind: 'readDetail', snipeId: s.id, purpose: 'measure' }], details, auditKind: 'bid.dry-run' };
  }
  // Timing-critical, so first. The amount comes only from Snipe.maxBid.
  return { next, effects: [{ kind: 'placeBid', snipeId: s.id, amount: s.maxBid }], details };
}

function onSent(s: Snipe, e: Extract<SnipeEvent, { type: 'sent' }>): Handled {
  if (s.dryRun) return refuse('dry-run');
  // A restarted worker treats an existing key as sent (§3.9).
  if (s.attempt.sentAt !== undefined || s.attempt.idempotencyKey !== undefined) return refuse('already-sent');
  if (e.key.trim() === '') return refuse('invalid-event', 'The idempotency key is empty.');
  const sentAt = serverTime(s, e.now);
  return {
    next: step(s, e, 'sent', s.state === 'fallback-applied' ? 'sent: early proxy' : 'sent', {
      attempt: { ...s.attempt, idempotencyKey: e.key, sentAt },
    }),
    effects: [],
    details: { key: e.key, sentAt, bid: s.state === 'fallback-applied' ? 'early-proxy' : 'snipe' },
  };
}

/** I2: one reply per attempt; T-101's SendStrategy dispatches exactly one `result` or `ambiguous`. */
function hasAnswer(s: Snipe): boolean {
  return s.attempt.reply !== undefined || s.attempt.ambiguous === true;
}

function onResult(s: Snipe, e: Extract<SnipeEvent, { type: 'result' }>, ctx: ReduceContext): Handled {
  if (s.dryRun) return refuse('dry-run');
  if (hasAnswer(s)) return refuse('duplicate');
  const r = e.result;
  const replied: Snipe = {
    ...s,
    attempt: { ...s.attempt, reply: r },
    measured: { ...s.measured, responseAt: serverTime(s, e.now) },
  };
  const details: Details = {
    resultKind: r.kind,
    rawStatus: r.rawStatus,
    rawResult: r.rawResult,
    isHighBidder: r.isHighBidder,
    message: clip(r.messageText),
  };
  if (NOT_REGISTERED.has(r.kind)) {
    const done = settled(replied, e, 'resolved', classifyOutcome(replied, r, null, outcomeContext(ctx)), `result: ${r.kind}`);
    return { ...done, details: { ...details, ...done.details } };
  }
  // accepted, outbid, rejected-unknown: the bid registered or may have. The
  // outcome read settles it with the recorded reply; never resend (bid.ts contract).
  return {
    next: step(replied, e, 'sent', `result: ${r.kind}; awaiting the outcome read`),
    effects: [{ kind: 'readDetail', snipeId: s.id, purpose: 'post-read' }],
    details,
  };
}

function onAmbiguous(s: Snipe, e: Extract<SnipeEvent, { type: 'ambiguous' }>): Handled {
  if (s.dryRun) return refuse('dry-run');
  if (hasAnswer(s)) return refuse('duplicate');
  return {
    next: step(s, e, 'sent', 'ambiguous: post-read first', { attempt: { ...s.attempt, ambiguous: true } }),
    effects: [{ kind: 'readDetail', snipeId: s.id, purpose: 'post-read' }],
  };
}

function onPostRead(s: Snipe, e: Extract<SnipeEvent, { type: 'post-read' }>, ctx: ReduceContext): Handled {
  const d = e.detail;
  if (d.itemId !== s.itemId) return refuse('invalid-event', 'The outcome read is for another item.');
  const details = { currentPrice: d.currentPrice, isClosed: d.isClosed, isHighBidder: d.isHighBidder };
  if (s.state === 'firing') {
    if (!s.dryRun) return refuse('not-sent');
    // The dry run's measure read: its arrival is the measured response time.
    const measured: Snipe = { ...s, measured: { ...s.measured, responseAt: serverTime(s, e.now) } };
    const done = settled(measured, e, 'resolved', classifyOutcome(measured, null, d, outcomeContext(ctx)), 'post-read: dry run measured');
    return { ...done, details: { ...details, ...done.details } };
  }
  // The recorded reply (survives a restart); an ambiguous send has none.
  const reply = s.attempt.ambiguous === true ? null : (s.attempt.reply ?? null);
  const done = settled(s, e, 'resolved', classifyOutcome(s, reply, d, outcomeContext(ctx)), 'post-read');
  return { ...done, details: { ...details, ...done.details } };
}

/** T-80b R1: the runner gave up on the outcome read; settle with the reply (or none) and no ItemDetail. */
function onPostReadFailed(s: Snipe, e: Extract<SnipeEvent, { type: 'post-read-failed' }>, ctx: ReduceContext): Handled {
  if (s.state === 'firing') {
    // The dry run's measure read never arrived. A live snipe here has not been
    // sent: accepting this would settle a bid that may still go out.
    if (!s.dryRun) return refuse('not-sent');
    return settled(
      s,
      e,
      'resolved',
      classifyOutcome(s, null, null, { ...outcomeContext(ctx), dryRunMeasureFailed: true }),
      'post-read failed: dry-run measure',
    );
  }
  if (s.dryRun) return refuse('dry-run');
  // The recorded reply, like the post-read path; an ambiguous send has none, so
  // its send evidence still leads classifyOutcome to "Unconfirmed".
  const reply = s.attempt.ambiguous === true ? null : (s.attempt.reply ?? null);
  const done = settled(s, e, 'resolved', classifyOutcome(s, reply, null, outcomeContext(ctx)), 'post-read failed');
  return done;
}

/** T-80b R2: bid.ts proved nothing was sent; never the judge path, no money effect. */
function onNotSent(s: Snipe, e: Extract<SnipeEvent, { type: 'not-sent' }>, ctx: ReduceContext): Handled {
  if (s.dryRun) return refuse('dry-run');
  if (hasAnswer(s)) return refuse('duplicate');
  // The proof survives a restart: classifyOutcome and spentToday (R4) read it.
  const proven: Snipe = { ...s, attempt: { ...s.attempt, notSent: true } };
  const reason = clip(e.reason);
  const done = settled(
    proven,
    e,
    'resolved',
    classifyOutcome(proven, null, null, outcomeContext(ctx, 'network', reason)),
    `not-sent: ${reason}`,
  );
  return { ...done, details: { reason, ...done.details } };
}

function onPreflightFailed(s: Snipe, e: Extract<SnipeEvent, { type: 'preflight-failed' }>, caps: CapsResult, ctx: ReduceContext): Handled {
  const reason = PREFLIGHT_REASONS.find((r) => r === e.reason);
  if (reason === undefined) return refuse('invalid-event', `Unknown preflight reason '${clip(e.reason, 40)}'.`);
  const why = `preflight-failed: ${reason}`;
  let done: Accepted;
  switch (reason) {
    case 'ended':
      done = aborted(s, e, ctx, 'resolved', 'ended', why);
      break;
    case 'price':
      done = aborted(s, e, ctx, 'resolved', 'price', why);
      break;
    case 'cap':
      done = capBlocked(s, e, ctx, caps, why);
      break;
    case 'auth':
    case 'clock':
    case 'keep-awake':
      done = preFireFallback(s, e, reason, PREFLIGHT_CAUSE[reason], caps, ctx);
      break;
  }
  return { ...done, details: { reason, ...done.details } };
}

function onApplyFallback(s: Snipe, e: Extract<SnipeEvent, { type: 'apply-fallback' }>, caps: CapsResult, ctx: ReduceContext): Handled {
  // The runner may narrow the user's choice to 'skip', never widen it to a bid.
  const requested: Fallback = e.mode === 'skip' ? 'skip' : s.fallback;
  const fb = preFireFallback(s, e, 'anomaly', 'The snipe cannot fire as planned.', caps, ctx, requested);
  return { ...fb, details: { mode: e.mode, ...fb.details } };
}

/** The per-event handler; the `never` default makes a new event type a compile error. */
function handle(s: Snipe, e: SnipeEvent, caps: CapsResult, ctx: ReduceContext): Handled {
  switch (e.type) {
    case 'arm':
      return onArm(s, e, caps);
    case 'disarm':
      return onDisarm(s, e, caps, ctx);
    case 'wake':
      return onWake(s, e);
    case 'verified':
      return onVerified(s, e, caps, ctx);
    case 'verify-failed':
      return onVerifyFailed(s, e, caps, ctx);
    case 'fire':
      return onFire(s, e, caps, ctx);
    case 'sent':
      return onSent(s, e);
    case 'result':
      return onResult(s, e, ctx);
    case 'ambiguous':
      return onAmbiguous(s, e);
    case 'post-read':
      return onPostRead(s, e, ctx);
    case 'post-read-failed':
      return onPostReadFailed(s, e, ctx);
    case 'not-sent':
      return onNotSent(s, e, ctx);
    case 'preflight-failed':
      return onPreflightFailed(s, e, caps, ctx);
    case 'apply-fallback':
      return onApplyFallback(s, e, caps, ctx);
    default: {
      const unhandled: never = e;
      throw new Error(`T-80: unhandled snipe event ${JSON.stringify(unhandled)}`);
    }
  }
}

// ── reduce ──────────────────────────────────────────────────────────────────

/**
 * PLAN §3.9 `reduce` (it satisfies the frozen `Reduce` type; `ctx` is an
 * optional extra). The caller runs `checkCaps` first and passes its result
 * (I-08); `capsForEvent` does that for an event. A refused event returns the
 * same `s` object, no effects and a typed `rejection`. An accepted one returns
 * a new snipe with one more `history` entry, the effects to run in order, and
 * one audit entry (plus a keep-awake release when the snipe ends).
 */
export function reduce(s: Snipe, e: SnipeEvent, capsResult: CapsResult, ctx: ReduceContext = {}): ReduceResult {
  const cell = TRANSITIONS[s.state][e.type];
  if ('reject' in cell) return { next: s, effects: [], rejection: { reason: cell.reject, detail: REJECT_TEXT[cell.reject] } };

  const out = handle(s, e, capsResult, ctx);
  if ('rejection' in out) {
    if (!(cell.guards ?? []).includes(out.rejection.reason)) {
      throw new Error(`T-80: '${out.rejection.reason}' is not a guard of ${s.state} × ${e.type} in TRANSITIONS`);
    }
    return { next: s, effects: [], rejection: out.rejection };
  }
  if (!cell.to.includes(out.next.state)) {
    throw new Error(`T-80: ${s.state} --${e.type}--> ${out.next.state} is not in TRANSITIONS`);
  }

  const { next } = out;
  const base: Details = { event: e.type, from: s.state, to: next.state, outcome: next.outcome ?? null };
  const effects: Effect[] = [...out.effects, audit(next, out.auditKind ?? AUDIT_KIND[e.type], { ...base, ...out.details })];
  if (TERMINAL.has(next.state)) effects.push({ kind: 'holdKeepAwake', snipeId: s.id, hold: false });
  return { next, effects, rejection: null };
}

// ── C1: the precomputed CapsResult ──────────────────────────────────────────

export interface CapsInputs {
  /** `settings.snipe.caps`. */
  limits: CapsCheck;
  /** Every stored snipe (`sbw:snipes`); this one may be included. All the OTHER ones count (C1). */
  snipes: readonly Snipe[];
  /** `settings.locale.timeZone`: the caps' local day. */
  timeZone: string;
  /**
   * The freshest ItemDetail, for events that carry none: the prepare read for
   * `arm`, the T−60 s read for `fire` and for a fallback. Without one,
   * `checkCaps` fails closed.
   */
  detail?: ItemDetail;
}

/**
 * The CapsResult to pass to `reduce` for `e` (I-08, C1): T-82's concrete
 * `checkCaps` with the event's own ItemDetail (the `verified` read) or
 * `inputs.detail`, the user's time zone, every other snipe, and what they
 * spent today (T-82's `spentToday`). Pure.
 */
export function capsForEvent(s: Snipe, e: SnipeEvent, inputs: CapsInputs): CapsResult {
  const detail = e.type === 'verified' || e.type === 'post-read' ? e.detail : inputs.detail;
  const others = inputs.snipes.filter((o) => o.id !== s.id);
  return checkCaps(s, others, spentToday(others, e.now, inputs.timeZone), inputs.limits, detail, inputs.timeZone);
}
