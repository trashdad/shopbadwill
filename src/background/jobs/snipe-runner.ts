// T-84: the snipe runner (background). It executes T-80's state machine in the
// real browser: per-snipe alarms, KeepAlive and KeepAwake, the SnipeHost, the
// effect executor (reads, clock samples, the tight timer, PlaceBid, the outcome
// read, notifications, calendar stamps, audit), restart recovery and the
// auto-kill on anomalies. PLAN §1.3, §3.9, §6 T-84.
//
// Money rules (binding carries, T-84-carries.md):
// - One source of state changes. The runner never edits a snipe: every change
//   is `reduce(snipe, event, caps, ctx)` (T-80), and only the reducer's effects
//   run. preflight()'s fallback effects are never applied: its failure goes to
//   the reducer as a `preflight-failed` event.
// - Persist before send. A money effect (`placeBid`, `applyFallbackProxy`) is
//   executed only by committing `sent {key}` through the reducer. The commit
//   writes the new state AND removes the money effect from the outbox in one
//   storage write; only when the reducer accepted it and the write finished
//   does the request leave, through the SendStrategy and `SgwApi.placeBid`
//   (`ctx.sendWrite`, writesAllowed checked again there). A refused `sent`
//   drops the effect: nothing is sent.
// - Effects outbox. A commit writes the next state and the accepted event's
//   effects atomically (`sbw:snipes` and `sbw:snipeRunner` in ONE
//   storage.local.set). Effects run in order and leave the outbox once
//   done, so a worker that dies after a commit replays them on restart, money
//   only through the reducer's guards. A stale money effect after `sent` is
//   refused as `already-sent` and dropped.
// - Compare-and-set. Commits are serialised per profile (the Repo's
//   `sbw:snipes` lock) and always reduce the snipe as stored right now. A
//   caller that read an older version (history.length) loses: its event is
//   re-reduced on the fresh snipe, where the reducer refuses a step already
//   taken. Within one worker the drive loop is also serialised per snipe. The
//   background is the only writer of `sbw:snipes`.
// - A `sent` snipe always gets an exit: the outcome read after the end, a
//   recovery alarm, bounded retries (POST_READ_FAST_ATTEMPTS over 30 min), then
//   an "Unconfirmed: check the item" alert (T-87's copy for a bid with no
//   reply, never "Not bid") and slow retries until a read settles it.
// - fallbackDecision (T-83) runs inside the reducer on `disarm(anomaly)`, on
//   the snipe as it is before the kill (C3). The kill switch disarms with
//   `by: 'kill'` and asks for no fallback. A dry-run snipe passes
//   `writesAllowed` from `verdictNow('bidding', { ignoreDryRun: true })`, so
//   its audit shows the live verdict (kill, health including a pending schema
//   failure, session) without the dry-run condition. A dry run still sends nothing.
// - Live safety: a PlaceBid leaves only when the snipe is not a dry run, the
//   reducer emitted `placeBid` (or an early proxy), `verdictNow('bidding')`
//   allows it, and the adapter's own gate agrees.
//
// Lanes (I-39): `:health24` / `:health1` call the AuthHealth port only (0 SGW
// requests); `:preflight` reads on lane `background`; the lane `snipe` is used
// only from the T-5 min wake onward.
//
// Seams (I-12), so later cards add files and never edit this one:
// `snipeSeams(ctx)` takes the SendStrategy (T-101), the AuthHealth port
// (T-91), ArmHooks (T-111, T-112), the calendar stamper and the dry-run
// completion event (T-90). The SnipeHost comes from the factory in
// adapters/browser/snipe-host.ts, keyed by the S-7 verdict (T-116 adds the
// runner page). The `sbw:snipe-countdown` port is served here (§3.12).
import { createSnipeHost, type SelectedSnipeHost } from '../../adapters/browser/snipe-host';
import { bidMayHaveBeenSent, PLACE_BID_TIMEOUT_MS } from '../../adapters/sgw/bid';
import { SgwClockAdapter } from '../../adapters/sgw/clock-adapter';
import { checkCaps, confirmsAmount, spentToday, typoCheck } from '../../domain/snipe/caps';
import { classifyOutcome } from '../../domain/snipe/outcome';
import { isoMs, preflight, PREFLIGHT_LEAD_MS, type PreflightContext, type PreflightReason } from '../../domain/snipe/preflight';
import { capsForEvent, reduce, WAKE_BEFORE_FIRE_MS, type ReduceContext, type Rejection } from '../../domain/snipe/state-machine';
import { assessClock, computeFireAt, MAX_RTT_MS, planClockSamples, toLocalFireAt } from '../../domain/snipe/timing';
import { type CapsResult, type Effect, type Snipe, type SnipeEvent } from '../../domain/snipe/types';
import { formatDual } from '../../domain/time/pacific';
import { SnipeRunnerRecordSchema, STORAGE_KEYS, STORAGE_RECORDS, type SnipeRunnerRecord } from '../../domain/storage/schema';
import { BidResultSchema, type BidResult, type Cents, type EpochMs, type ItemDetail, type ItemId, type Lane } from '../../domain/types';
import type { Settings } from '../../domain/settings/schema';
import { PORT_NAMES, SnipeCountdownTickSchema } from '../../messaging/protocol';
import type { Clock } from '../../ports/clock';
import { SgwApiError } from '../../ports/errors';
import type { SgwApi } from '../../ports/sgw-api';
import { errorText, type BackgroundContext, type RuntimePort } from '../context';
import { WHY, type Verdict } from '../switches';

// ── Policy ──────────────────────────────────────────────────────────────────

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** Alarm names: `sbw:snipe:<id>:<kind>` (PLAN §1.3). */
export const SNIPE_ALARM_PREFIX = 'sbw:snipe:';
export const SNIPE_ALARM_KINDS = ['health24', 'health1', 'preflight', 'wake', 'recover', 'postread'] as const;
export type SnipeAlarmKind = (typeof SNIPE_ALARM_KINDS)[number];

/** `sbw:snipeRunner`: per snipe, the effects outbox and the runner's bookkeeping. */
export const RUNNER_KEY = STORAGE_KEYS.snipeRunner;

/** S-7: 20 s heartbeats (Firefox stretched them to 26.9 s; the idle timeout is 30 s). Do not raise. */
export const KEEP_ALIVE_INTERVAL_MS = 20_000;
/** The AuthHealth checks (0 SGW requests), before the end. */
export const HEALTH24_BEFORE_END_MS = 24 * HOUR;
export const HEALTH1_BEFORE_END_MS = HOUR;
/** The verify read, before the end (server time). */
export const VERIFY_BEFORE_END_MS = 60 * SEC;
/** Verify read attempts (the snipe lane spaces them 1 s apart). */
export const VERIFY_ATTEMPTS = 2;
/** Failed window reads in a row that count as an anomaly ("repeated errors"). */
export const MAX_CONSECUTIVE_READ_ERRORS = 3;
/** The window's recovery alarm: revives a worker that died in the window (S-7, fire + 100 s in the spike). */
export const RECOVER_PERIOD_MINUTES = 1;
/** A wait shorter than this keeps the window (KeepAlive) held; a longer one goes to an alarm. */
export const WINDOW_HOLD_MAX_WAIT_MS = 60 * SEC;
/** The outcome read waits until this long after the end (server time), so it can be final. */
export const POST_READ_AFTER_END_MS = 5 * SEC;
/**
 * Fast outcome-read attempts: at the end + 5 s, then these delays after each
 * failure: 3 attempts within 30 min, even with the up-to-60 s alarm delay the
 * Alarms port allows on each retry.
 */
export const POST_READ_RETRY_DELAYS_MS: readonly number[] = [5 * MIN, 23 * MIN];
export const POST_READ_FAST_ATTEMPTS = POST_READ_RETRY_DELAYS_MS.length + 1;
/** After the fast attempts (and the Unconfirmed alert), slow retries until a read settles the snipe. */
export const POST_READ_SLOW_INTERVAL_MS = 6 * HOUR;
export const POST_READ_SLOW_ATTEMPTS = 28;
/** A money send needs at least this much time before the end (server time), as §3.9's resend proof does. */
export const MIN_TIME_LEFT_TO_SEND_MS = 1500;
/** S-2: an auction must end at least this long before the session's `exp` to be armed. */
export const SESSION_ARM_MARGIN_MS = 15 * MIN;
/** `sbw:snipe-countdown` tick (§3.12). */
export const COUNTDOWN_INTERVAL_MS = 1000;

export function snipeAlarmName(id: string, kind: SnipeAlarmKind): string {
  return `${SNIPE_ALARM_PREFIX}${id}:${kind}`;
}

export function parseSnipeAlarm(name: string): { id: string; kind: SnipeAlarmKind } | null {
  if (!name.startsWith(SNIPE_ALARM_PREFIX)) return null;
  const rest = name.slice(SNIPE_ALARM_PREFIX.length);
  const at = rest.lastIndexOf(':');
  if (at <= 0) return null;
  const kind = rest.slice(at + 1);
  const known = SNIPE_ALARM_KINDS.find((k) => k === kind);
  return known === undefined ? null : { id: rest.slice(0, at), kind: known };
}

// ── Seams (I-12) ────────────────────────────────────────────────────────────

/** What a SendStrategy is asked to send. `sent` is already persisted with `idempotencyKey`. */
export interface SendRequest {
  readonly snipe: Snipe;
  readonly kind: 'placeBid' | 'applyFallbackProxy';
  /** Exactly `snipe.maxBid` (the reducer's effect). */
  readonly amount: Cents;
  readonly sellerId: number;
  readonly idempotencyKey: string;
  /** PlaceBid's abort; bid.ts caps it at 20 s (T-100). */
  readonly timeoutMs: number;
}

export interface SendDeps {
  readonly api: SgwApi;
  readonly clock: Clock;
  /** SGW's time now (the snipe's measured offset), for T-101's "1.5 s remain" proof. */
  serverNow(): EpochMs;
}

/**
 * What came of the send. `result`: SGW answered. `ambiguous`: the bid may have
 * reached SGW (timeout, network, 5xx, unreadable reply). `not-sent`: it
 * provably never left (bid.ts BidNotSentError, or the write gate).
 */
export type SendOutcome =
  | { kind: 'result'; result: BidResult }
  | { kind: 'ambiguous'; error?: unknown }
  | { kind: 'not-sent'; error: unknown };

/** T-101 implements the idempotent send and its single retry; it never edits this file. */
export interface SendStrategy {
  send(req: SendRequest, deps: SendDeps): Promise<SendOutcome>;
}

/** The default: one `SgwApi.placeBid`, bid.ts's contract, never a retry. */
export const DEFAULT_SEND_STRATEGY: SendStrategy = {
  async send(req, deps) {
    try {
      const result = await deps.api.placeBid(
        { itemId: req.snipe.itemId, sellerId: req.sellerId, bidAmount: req.amount, quantity: 1 },
        { idempotencyKey: req.idempotencyKey, timeoutMs: req.timeoutMs },
      );
      return { kind: 'result', result };
    } catch (error) {
      return bidMayHaveBeenSent(error) ? { kind: 'ambiguous', error } : { kind: 'not-sent', error };
    }
  },
};

export type AuthHealthCheck = '24h' | '1h';
export type AuthHealthResult = { ok: true } | { ok: false; reason: string; detail: string };

/** T-91: 24 h and 1 h before the end, from cached session state (0 SGW requests, I-39). */
export interface AuthHealth {
  check(snipe: Snipe, which: AuthHealthCheck): Promise<AuthHealthResult>;
}

export const NO_OP_AUTH_HEALTH: AuthHealth = { check: () => Promise.resolve({ ok: true }) };

/** A preflight hook's failure; it reaches the reducer as `preflight-failed` with this reason. */
export interface PreflightHookFailure {
  reason: Extract<PreflightReason, 'auth' | 'clock' | 'keep-awake'>;
  detail: string;
}

/** T-111 (companion) and T-112 (bid groups). Every hook is optional; a throwing hook is logged. */
export interface ArmHooks {
  /** Before the arm is reduced; `{ veto }` refuses it with that message. */
  beforeArm?(snipe: Snipe): { veto: string } | undefined | Promise<{ veto: string } | undefined>;
  /** After the armed snipe is persisted. */
  afterArm?(snipe: Snipe): void | Promise<void>;
  /** After every accepted transition, with the snipe before it. */
  afterTransition?(next: Snipe, prev: Snipe): void | Promise<void>;
  /** At the T-15 min preflight, once it passed: a failure goes to the reducer. */
  preflight?(snipe: Snipe): PreflightHookFailure | undefined | Promise<PreflightHookFailure | undefined>;
}

/** Where `stampCalendar` goes (the CalendarSink owner registers it). Default: nothing is stamped. */
export interface CalendarStamper {
  stamp(snipe: Snipe, outcome: 'won' | 'lost' | 'ended-early', finalPrice?: Cents): Promise<void>;
}

export interface SnipeSeams {
  setSendStrategy(s: SendStrategy): void;
  setAuthHealth(a: AuthHealth): void;
  /** Returns a function that removes the hooks. */
  addArmHooks(h: ArmHooks): () => void;
  setCalendarStamper(s: CalendarStamper): void;
  /** A dry-run snipe fired and resolved (T-90 counts it). Returns an unsubscribe function. */
  onDryRunComplete(cb: (snipe: Snipe) => void): () => void;
}

class Seams implements SnipeSeams {
  sendStrategy: SendStrategy = DEFAULT_SEND_STRATEGY;
  authHealth: AuthHealth = NO_OP_AUTH_HEALTH;
  stamper: CalendarStamper | undefined;
  readonly hooks = new Set<ArmHooks>();
  readonly dryRunListeners = new Set<(snipe: Snipe) => void>();

  setSendStrategy(s: SendStrategy): void {
    this.sendStrategy = s;
  }
  setAuthHealth(a: AuthHealth): void {
    this.authHealth = a;
  }
  addArmHooks(h: ArmHooks): () => void {
    this.hooks.add(h);
    return () => {
      this.hooks.delete(h);
    };
  }
  setCalendarStamper(s: CalendarStamper): void {
    this.stamper = s;
  }
  onDryRunComplete(cb: (snipe: Snipe) => void): () => void {
    this.dryRunListeners.add(cb);
    return () => {
      this.dryRunListeners.delete(cb);
    };
  }
}

const SEAMS = new WeakMap<BackgroundContext, Seams>();
const RUNNERS = new WeakMap<BackgroundContext, SnipeRunner>();

/** The seams of this background. Any module may call it from its register(ctx), before or after the runner registers. */
export function snipeSeams(ctx: BackgroundContext): SnipeSeams {
  return seamsOf(ctx);
}

function seamsOf(ctx: BackgroundContext): Seams {
  let s = SEAMS.get(ctx);
  if (s === undefined) {
    s = new Seams();
    SEAMS.set(ctx, s);
  }
  return s;
}

/** The running runner (handlers/snipe.ts, T-86's disarm-all), or undefined when it did not register. */
export function getSnipeRunner(ctx: BackgroundContext): SnipeRunner | undefined {
  return RUNNERS.get(ctx);
}

// ── The runner record (`sbw:snipeRunner`, SnipeRunnerRecordSchema) ───────────

type Entry = SnipeRunnerRecord['entries'][string];
type RunnerRecord = SnipeRunnerRecord;

const SNIPES_SCHEMA = STORAGE_RECORDS[STORAGE_KEYS.snipes].schema;

const emptyRecord = (): RunnerRecord => ({ version: 1, entries: {} });

/** Stable JSON (sorted keys): effects are compared by value. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v !== null && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
      .join(',')}}`;
  }
  return v === undefined ? 'undefined' : JSON.stringify(v);
}

function sameEffect(a: Effect, b: Effect): boolean {
  return canon(a) === canon(b);
}

function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

type MoneyEffect = Extract<Effect, { kind: 'placeBid' | 'applyFallbackProxy' }>;
type DriveEffect = Extract<Effect, { kind: 'sampleClock' | 'readDetail' }>;

const isMoney = (e: Effect): e is MoneyEffect => e.kind === 'placeBid' || e.kind === 'applyFallbackProxy';
const isDrive = (e: Effect): e is DriveEffect => e.kind === 'sampleClock' || e.kind === 'readDetail';

/** Whether a drive effect still means something in `s`'s state (the others are moot and pruned). */
function driveRelevant(e: DriveEffect, s: Snipe): boolean {
  if (e.kind === 'sampleClock') return s.state === 'waking';
  if (e.purpose === 'verify') return s.state === 'waking';
  if (e.purpose === 'measure') return s.state === 'firing' && s.dryRun;
  return s.state === 'sent';
}

const TERMINAL: ReadonlySet<Snipe['state']> = new Set(['resolved', 'killed']);
const isTerminal = (s: Snipe): boolean => TERMINAL.has(s.state);

function usableSession(state: string): boolean {
  return state === 'ok' || state === 'expiring';
}

type ReadErrorKind = 'auth' | 'schema' | 'network';

function readErrorKind(e: unknown): ReadErrorKind {
  if (e instanceof SgwApiError) {
    if (e.kind === 'auth') return 'auth';
    if (e.kind === 'schema') return 'schema';
  }
  return 'network';
}

/** In-memory state of a snipe's window in this worker (lost on a restart, rebuilt from storage). */
interface WindowSession {
  plan: EpochMs[];
  nextSample: number;
  consecutiveErrors: number;
}

export type CommitResult =
  | { kind: 'accepted'; prev: Snipe; next: Snipe; effects: Effect[] }
  | { kind: 'rejected'; snipe: Snipe; rejection: Rejection }
  /** An outside event that belongs to a send in flight (its reply settles the attempt). */
  | { kind: 'busy'; detail: string }
  | { kind: 'missing' };

/** The events of a send attempt: only the runner, which owns the send, feeds them while it is in flight. */
const ATTEMPT_EVENTS: ReadonlySet<SnipeEvent['type']> = new Set(['sent', 'result', 'ambiguous', 'post-read']);

interface CommitOptions {
  /** Outbox effects this event completes; removed in the same write (even when the event is refused). */
  consume?: readonly Effect[];
  /** The freshest ItemDetail for the caps check (default: the last one read for this snipe). */
  detail?: ItemDetail;
  /** The history.length the caller reduced from (compare-and-set). */
  expectVersion?: number;
  /** From outside the runner's own send path (dispatch): refused while a send is in flight. */
  external?: boolean;
}

type StepResult = 'continue' | 'wait';

export interface ArmInput {
  id: string;
  itemId: ItemId;
  title: string;
  maxBid: Cents;
  allInMax?: Cents;
  estShipping?: Cents;
  estHandling?: Cents;
  leadMs: number;
  fallback: Snipe['fallback'];
  dryRun: boolean;
  groupId?: string;
}

export interface PrepareReply {
  detail: ItemDetail;
  estAllIn: Cents | null;
  caps: CapsResult;
}

const ITEM_URL = 'https://shopgoodwill.com/item/';

// ── The runner ──────────────────────────────────────────────────────────────

export class SnipeRunner {
  /** The last known stored snipes (the countdown reads it). */
  private readonly cache = new Map<string, Snipe>();
  private readonly drives = new Map<string, { again: boolean }>();
  private readonly timers = new Map<string, number>();
  /** Snipes whose window holds KeepAlive and the host. */
  private readonly windows = new Set<string>();
  /** Snipes for which KeepAwake is held (the port has no "held" query; this is the record). */
  private readonly awake = new Set<string>();
  private readonly sessions = new Map<string, WindowSession>();
  /** The freshest ItemDetail read for each snipe (caps, sellerId). */
  private readonly details = new Map<string, ItemDetail>();
  /** Snipes whose armed-state alarms were (re)created by this worker. */
  private readonly alarmsSet = new Set<string>();
  /** Snipes with a send in flight in this worker. */
  private readonly inFlight = new Set<string>();
  /**
   * Snipes inside a window read. `flagSchemaFailure` notifies switches during
   * that read; react() must not disarm for it, or the audit says "health check
   * failed" instead of the read's own reason (schema drift). The kill switch
   * still stops the snipe. The step checks again once the read returns.
   */
  private readonly reading = new Set<string>();
  /** Why a money effect was dropped (the close-out disarm says it). */
  private readonly closeWhy = new Map<string, { by: 'kill' | 'anomaly'; why: string }>();
  private readonly degradedNoted = new Set<string>();
  private readonly offs: Array<() => void> = [];
  private readonly sampler: SgwClockAdapter;
  private readonly host: SelectedSnipeHost;
  private disposed = false;
  private runnerInvalidNoted = false;
  /** Diagnostics: events re-reduced because the caller's version was stale. */
  readonly stats = { casLost: 0 };

  constructor(
    private readonly ctx: BackgroundContext,
    private readonly seams: Seams,
    private readonly log: (message: string, error?: unknown) => void = (m, e) => {
      console.warn(`[ShopBadwill] ${m}`, e);
    },
  ) {
    this.sampler = new SgwClockAdapter(ctx.clock);
    this.host = createSnipeHost({ clock: ctx.clock, log });
  }

  /** Subscribes to alarms, switch changes and the countdown port, then reconciles. */
  start(): void {
    this.offs.push(
      this.ctx.alarms.onAlarm((a) => {
        this.onAlarm(a.name);
      }),
      this.ctx.switches.onChange(() => {
        for (const id of [...this.windows]) void this.react(id);
      }),
      this.ctx.ports.serve(PORT_NAMES.snipeCountdown, (port) => {
        this.serveCountdown(port);
      }),
    );
    void this.reconcile().catch((e: unknown) => {
      this.log('snipe runner: reconcile failed', e);
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const off of this.offs.splice(0)) off();
    for (const t of this.timers.values()) this.ctx.clock.clearTimeout(t);
    this.timers.clear();
    if (this.windows.size > 0) this.ctx.keepAlive.stop();
    this.windows.clear();
  }

  // ── Public API (handlers/snipe.ts, T-86) ──────────────────────────────

  /**
   * Restart recovery: re-reads every snipe and its outbox, re-creates the
   * alarms of every open snipe, clears alarms of finished or unknown ones, and
   * drives each open snipe (or one with effects still pending) from storage.
   */
  async reconcile(): Promise<void> {
    const all = await this.ctx.repo.get(STORAGE_KEYS.snipes);
    const rec = await this.readRunner();
    for (const s of Object.values(all)) this.cache.set(s.id, s);
    const alarms = await this.ctx.alarms.getAll();
    for (const a of alarms) {
      const p = parseSnipeAlarm(a.name);
      if (p === null) continue;
      const s = all[p.id];
      if (s === undefined || (isTerminal(s) && rec.entries[p.id] === undefined)) await this.ctx.alarms.clear(a.name);
    }
    for (const s of Object.values(all)) {
      if (!isTerminal(s) || rec.entries[s.id] !== undefined) void this.drive(s.id);
    }
    // Entries of snipes that no longer exist.
    const orphans = Object.keys(rec.entries).filter((id) => all[id] === undefined);
    if (orphans.length > 0) {
      await this.updateRecord((r) => {
        for (const id of orphans) Reflect.deleteProperty(r.entries, id);
      });
    }
  }

  async list(): Promise<Snipe[]> {
    return Object.values(await this.ctx.repo.get(STORAGE_KEYS.snipes));
  }

  /** `snipe.prepare`: a fresh-enough detail, the estimated all-in at the next acceptable bid, and the caps for it. */
  async prepare(itemId: ItemId): Promise<PrepareReply> {
    const settings = await this.settings();
    const detail = await this.ctx.api.itemDetail(itemId, 'interactive');
    const shipping = detail.shippingPrice ?? null;
    const estAllIn = shipping === null ? null : detail.minimumBid + shipping + (detail.handlingPrice ?? 0);
    const now = this.ctx.clock.now();
    const all = Object.values(await this.ctx.repo.get(STORAGE_KEYS.snipes));
    const tz = settings.locale.timeZone;
    const probe: Snipe = {
      id: '__prepare__',
      itemId,
      title: detail.title,
      endTime: detail.endTime,
      endTimeAtArm: detail.endTime,
      maxBid: detail.minimumBid,
      ...(shipping === null ? {} : { estShipping: shipping }),
      ...(detail.handlingPrice === undefined ? {} : { estHandling: detail.handlingPrice }),
      leadMs: settings.snipe.defaultLeadMs,
      fallback: settings.snipe.defaultFallback,
      dryRun: true,
      state: 'draft',
      armedAt: now,
      attempt: {},
      history: [],
    };
    const caps = checkCaps(probe, all, spentToday(all, now, tz), settings.snipe.caps, detail, tz);
    return { detail, estAllIn, caps };
  }

  /**
   * `snipe.arm` (PLAN §3.12). The handler sets `state`, `history` and
   * `armedAt`, resets `attempt` to {} and never trusts the runner-owned fields
   * from the UI. Refuses when sniping is off, without a usable SGW session or
   * when the auction ends later than the session's exp - 15 min (S-2), when the
   * typo guard trips without the retyped amount, when the id already exists
   * (a re-arm is a NEW snipe with a new id: an old record keeps its outcome,
   * which the caps' spent-today reads), or when another open snipe targets the
   * same item. A global bidding dry run makes the snipe a dry run.
   */
  async arm(input: ArmInput, typedConfirmation?: string): Promise<Snipe> {
    const settings = await this.settings();
    if (!settings.snipe.enabled) throw new Error('Sniping is turned off. Turn it on in the snipe settings first.');
    const detail = await this.ctx.api.itemDetail(input.itemId, 'interactive', { maxAgeMs: 60 * SEC });
    const tz = settings.locale.timeZone;
    const endMs = isoMs(detail.endTime);
    const [state, token] = await Promise.all([this.ctx.session.state(), this.ctx.session.current()]);
    if (!usableSession(state) || token === null) {
      throw new Error('Sign in on shopgoodwill.com first: a snipe needs a valid ShopGoodwill session.');
    }
    if (endMs > token.expiresAt - SESSION_ARM_MARGIN_MS) {
      throw new Error(
        `Your ShopGoodwill login expires ${formatDual(token.expiresAt, tz)}, too close to the auction end (it must outlast it by 15 minutes). Sign in again on shopgoodwill.com, then arm.`,
      );
    }
    const typo = typoCheck(input.maxBid, detail, settings.snipe.caps);
    if (typo.needsConfirmation && !(typedConfirmation !== undefined && confirmsAmount(typedConfirmation, input.maxBid))) {
      throw new Error(`${typo.reason ?? 'The amount looks like a typo'}. ${typo.prompt ?? 'Retype the amount to confirm.'}`);
    }
    const now = this.ctx.clock.now();
    const draft: Snipe = {
      id: input.id,
      itemId: detail.itemId,
      title: detail.title,
      endTime: detail.endTime,
      endTimeAtArm: detail.endTime,
      sellerId: detail.sellerId,
      maxBid: input.maxBid,
      ...(input.allInMax === undefined ? {} : { allInMax: input.allInMax }),
      ...(input.estShipping === undefined ? {} : { estShipping: input.estShipping }),
      ...(input.estHandling === undefined ? {} : { estHandling: input.estHandling }),
      leadMs: input.leadMs,
      fallback: input.fallback,
      dryRun: input.dryRun || settings.dryRun.bidding,
      state: 'draft',
      armedAt: now,
      attempt: {},
      ...(input.groupId === undefined ? {} : { groupId: input.groupId }),
      history: [],
    };
    if (draft.itemId !== input.itemId) throw new Error('The item read does not match the snipe.');
    for (const h of [...this.seams.hooks]) {
      const v = await h.beforeArm?.(draft);
      if (v !== undefined) throw new Error(v.veto);
    }
    const sessionUsable = true;
    const armed = await this.ctx.repo.withLock(STORAGE_KEYS.snipes, async () => {
      const all = await this.ctx.repo.get(STORAGE_KEYS.snipes);
      if (all[draft.id] !== undefined) {
        throw new Error('A snipe with this id already exists. Re-arming creates a new snipe with a new id.');
      }
      const twin = Object.values(all).find((o) => o.itemId === draft.itemId && !isTerminal(o));
      if (twin !== undefined) throw new Error('This item already has an open snipe. Disarm it first.');
      const e: SnipeEvent = { type: 'arm', now };
      const caps = capsForEvent(draft, e, { limits: settings.snipe.caps, snipes: Object.values(all), timeZone: tz, detail });
      const r = reduce(draft, e, caps, this.reduceContext(draft, settings, sessionUsable));
      if (r.rejection !== null) throw new Error(r.rejection.detail);
      const rec = await this.readRunner();
      all[draft.id] = r.next;
      rec.entries[draft.id] = { outbox: [...r.effects] };
      await this.write(all, rec);
      return r.next;
    });
    this.cache.set(armed.id, armed);
    this.details.set(armed.id, detail);
    for (const h of [...this.seams.hooks]) await this.safely('afterArm hook', () => h.afterArm?.(armed));
    void this.drive(armed.id);
    return armed;
  }

  /** Disarms through the reducer. Throws the reducer's reason when refused (e.g. a bid may already be out). */
  async disarm(id: string, by: 'user' | 'kill' | 'anomaly' = 'user', why = 'disarmed by the user'): Promise<Snipe> {
    const r = await this.commit(id, { type: 'disarm', now: this.ctx.clock.now(), by, why });
    if (r.kind === 'missing') throw new Error('No such snipe.');
    if (r.kind === 'rejected') throw new Error(r.rejection.detail);
    if (r.kind === 'busy') throw new Error(r.detail);
    void this.drive(id);
    return r.next;
  }

  /**
   * Feeds one event to the reducer for `id` (CAS against `expectVersion` when
   * given) and runs its effects. The way in for other modules (T-86's
   * disarm-all, tests); the runner itself uses the same path.
   */
  async dispatch(id: string, event: SnipeEvent, expectVersion?: number): Promise<CommitResult> {
    const r = await this.commit(id, event, { external: true, ...(expectVersion === undefined ? {} : { expectVersion }) });
    if (r.kind === 'accepted') void this.drive(id);
    return r;
  }

  // ── Commit (CAS + outbox, one storage write) ──────────────────────────

  private async commit(id: string, e: SnipeEvent, opts: CommitOptions = {}): Promise<CommitResult> {
    const settings = await this.settings();
    const sessionUsable = usableSession(await this.ctx.session.state());
    const r = await this.ctx.repo.withLock(STORAGE_KEYS.snipes, async (): Promise<CommitResult> => {
      const all = await this.ctx.repo.get(STORAGE_KEYS.snipes);
      const rec = await this.readRunner();
      const s = all[id];
      if (s === undefined) return { kind: 'missing' };
      if (opts.external === true && this.inFlight.has(id) && ATTEMPT_EVENTS.has(e.type)) {
        return { kind: 'busy', detail: 'A bid is being sent for this snipe; its reply settles it.' };
      }
      // CAS: a caller that reduced an older version loses; its event is re-reduced on the fresh snipe.
      if (opts.expectVersion !== undefined && s.history.length !== opts.expectVersion) this.stats.casLost += 1;
      const entry: Entry = rec.entries[id] ?? { outbox: [] };
      let outbox = entry.outbox;
      for (const c of opts.consume ?? []) {
        const at = outbox.findIndex((x) => sameEffect(x, c));
        if (at >= 0) outbox = [...outbox.slice(0, at), ...outbox.slice(at + 1)];
      }
      const detail = opts.detail ?? this.details.get(id);
      const caps = capsForEvent(s, e, {
        limits: settings.snipe.caps,
        snipes: Object.values(all),
        timeZone: settings.locale.timeZone,
        ...(detail === undefined ? {} : { detail }),
      });
      const red = reduce(s, e, caps, this.reduceContext(s, settings, sessionUsable));
      if (red.rejection !== null) {
        if (outbox !== entry.outbox) {
          rec.entries[id] = { ...entry, outbox };
          await this.writeRecord(rec);
        }
        return { kind: 'rejected', snipe: s, rejection: red.rejection };
      }
      all[id] = red.next;
      rec.entries[id] = { ...entry, outbox: [...outbox, ...red.effects] };
      await this.write(all, rec);
      return { kind: 'accepted', prev: s, next: red.next, effects: red.effects };
    });
    if (r.kind === 'rejected') this.cache.set(id, r.snipe);
    if (r.kind === 'accepted') {
      this.cache.set(id, r.next);
      for (const h of [...this.seams.hooks]) await this.safely('afterTransition hook', () => h.afterTransition?.(r.next, r.prev));
      if (r.next.dryRun && r.prev.state === 'firing' && r.next.state === 'resolved') {
        for (const cb of [...this.seams.dryRunListeners]) {
          await this.safely('dry-run listener', () => {
            cb(r.next);
          });
        }
      }
    }
    return r;
  }

  private reduceContext(s: Snipe, settings: Settings, sessionUsable: boolean): ReduceContext {
    return {
      timeZone: settings.locale.timeZone,
      sessionUsable,
      // C4: a dry run asks with the dry-run condition ignored (it still never sends).
      writesAllowed: this.biddingVerdict(s).ok,
    };
  }

  private async readRunner(): Promise<RunnerRecord> {
    const raw = await this.ctx.storage.local.get<unknown>(RUNNER_KEY);
    if (raw === undefined) return emptyRecord();
    const parsed = SnipeRunnerRecordSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    // Fail closed: no outbox means no money effect is ever replayed from it.
    if (!this.runnerInvalidNoted) {
      this.runnerInvalidNoted = true;
      this.log('snipe runner: the runner record is unreadable; pending effects are dropped (nothing is sent from it)');
    }
    return emptyRecord();
  }

  /** ONE storage write for both keys: the state and its outbox never diverge. */
  private async write(all: Record<string, Snipe>, rec: RunnerRecord): Promise<void> {
    await this.ctx.storage.local.set({ [STORAGE_KEYS.snipes]: SNIPES_SCHEMA.parse(all), [RUNNER_KEY]: SnipeRunnerRecordSchema.parse(rec) });
  }

  private async writeRecord(rec: RunnerRecord): Promise<void> {
    await this.ctx.storage.local.set({ [RUNNER_KEY]: SnipeRunnerRecordSchema.parse(rec) });
  }

  /** Runner-record-only change under the snipes lock. */
  private async updateRecord(fn: (r: RunnerRecord) => void): Promise<void> {
    await this.ctx.repo.withLock(STORAGE_KEYS.snipes, async () => {
      const rec = await this.readRunner();
      fn(rec);
      await this.writeRecord(rec);
    });
  }

  private async updateEntry(id: string, patch: Partial<Entry>): Promise<void> {
    await this.updateRecord((r) => {
      const cur = r.entries[id];
      if (cur !== undefined) r.entries[id] = { ...cur, ...patch };
    });
  }

  private async removeEffects(id: string, effects: readonly Effect[]): Promise<void> {
    await this.updateRecord((r) => {
      const cur = r.entries[id];
      if (cur === undefined) return;
      let outbox = cur.outbox;
      for (const e of effects) {
        const at = outbox.findIndex((x) => sameEffect(x, e));
        if (at >= 0) outbox = [...outbox.slice(0, at), ...outbox.slice(at + 1)];
      }
      r.entries[id] = { ...cur, outbox };
    });
  }

  private async load(id: string): Promise<{ snipe: Snipe | undefined; entry: Entry }> {
    const all = await this.ctx.repo.get(STORAGE_KEYS.snipes);
    const rec = await this.readRunner();
    const snipe = all[id];
    if (snipe !== undefined) this.cache.set(id, snipe);
    return { snipe, entry: rec.entries[id] ?? { outbox: [] } };
  }

  // ── Drive loop (serialised per snipe) ─────────────────────────────────

  /** Runs the snipe forward from storage until it waits on time. Concurrent calls coalesce. */
  drive(id: string): Promise<void> {
    const running = this.drives.get(id);
    if (running !== undefined) {
      running.again = true;
      return Promise.resolve();
    }
    const slot = { again: true };
    this.drives.set(id, slot);
    return (async () => {
      try {
        while (slot.again && !this.disposed) {
          slot.again = false;
          await this.step(id);
        }
      } catch (e) {
        this.log(`snipe ${id}: the runner step failed`, e);
      } finally {
        this.drives.delete(id);
      }
    })();
  }

  private async step(id: string): Promise<void> {
    for (let guard = 0; guard < 100 && !this.disposed; guard++) {
      const { snipe: s, entry } = await this.load(id);
      if (s === undefined) {
        await this.forget(id);
        return;
      }
      const moot = entry.outbox.filter((e): e is DriveEffect => isDrive(e) && !driveRelevant(e, s));
      if (moot.length > 0) {
        await this.removeEffects(id, moot);
        continue;
      }
      const next = entry.outbox.find((e) => !isDrive(e));
      if (next !== undefined) {
        if (isMoney(next)) await this.money(s, next);
        else await this.sideEffect(s, next);
        continue;
      }
      if ((await this.stateStep(s, entry)) === 'wait') return;
    }
  }

  private async stateStep(s: Snipe, entry: Entry): Promise<StepResult> {
    switch (s.state) {
      case 'draft':
        return 'wait';
      case 'armed':
        return this.armedStep(s, entry);
      case 'waking':
        return this.wakingStep(s);
      case 'verified':
        return this.verifiedStep(s);
      case 'firing':
        return this.firingStep(s, entry);
      case 'fallback-applied':
        return this.fallbackAppliedStep(s);
      case 'sent':
        return this.sentStep(s, entry);
      case 'resolved':
      case 'killed':
        await this.finish(s);
        return 'wait';
    }
  }

  // ── Side effects (best effort; never block the money path) ────────────

  private async sideEffect(s: Snipe, eff: Exclude<Effect, MoneyEffect | DriveEffect>): Promise<void> {
    try {
      switch (eff.kind) {
        case 'audit':
          await this.ctx.audit.append(eff.entry);
          break;
        case 'notify':
          await this.ctx.notifier.notify({
            id: `sbw:snipe:${s.id}:${hash(canon(eff))}`,
            title: eff.title,
            message: eff.message,
            priority: 2,
            openUrlOnClick: `${ITEM_URL}${String(s.itemId)}`,
          });
          break;
        case 'stampCalendar':
          await this.seams.stamper?.stamp(s, eff.outcome, eff.finalPrice);
          break;
        case 'proposeRearm':
          // Never automatic: the user re-arms (a new snipe). The outcome notification already asks.
          await this.ctx.audit.append({ actor: 'snipe', kind: 'snipe.rearm-proposed', itemId: s.itemId, ref: s.id, details: {}, dryRun: s.dryRun });
          break;
        case 'holdKeepAwake':
          if (eff.hold) await this.holdAwake(s);
          else await this.releaseAwake(s.id);
          break;
        case 'scheduleWake':
          await this.ctx.alarms.create(snipeAlarmName(s.id, 'wake'), { when: eff.at });
          break;
      }
    } catch (e) {
      this.log(`snipe ${s.id}: the ${eff.kind} effect failed`, e);
    }
    await this.removeEffects(s.id, [eff]);
  }

  // ── Money ─────────────────────────────────────────────────────────────

  /**
   * A money effect: gates (nothing sent if one fails), then `sent {key}`
   * committed through the reducer together with the effect's removal, then
   * the send, then its `result` or `ambiguous`.
   */
  private async money(s: Snipe, eff: MoneyEffect): Promise<void> {
    const id = s.id;
    const drop = async (by: 'kill' | 'anomaly', why: string): Promise<void> => {
      this.closeWhy.set(id, { by, why });
      await this.safely('audit', () =>
        this.ctx.audit.append({ actor: 'snipe', kind: 'bid.not-sent', itemId: s.itemId, ref: id, details: { effect: eff.kind, why }, dryRun: s.dryRun }),
      );
      await this.removeEffects(id, [eff]);
    };
    if (s.dryRun) {
      await drop('anomaly', 'a dry run never sends');
      return;
    }
    // The reducer's money effect is always this snipe's max. Anything else is a damaged outbox: send nothing.
    if (eff.snipeId !== id || eff.amount !== s.maxBid) {
      await drop('anomaly', `the stored bid amount or snipe does not match the snipe's max (${String(eff.amount)} for ${String(s.maxBid)})`);
      return;
    }
    const verdict = this.ctx.switches.verdictNow('bidding');
    if (!verdict.ok) {
      const why = verdict.why ?? 'bidding is blocked';
      await drop(why === WHY.kill ? 'kill' : 'anomaly', `bidding is blocked: ${why}`);
      return;
    }
    const sellerId = s.sellerId ?? this.details.get(id)?.sellerId;
    if (sellerId === undefined || !(Number.isSafeInteger(sellerId) && sellerId > 0)) {
      await drop('anomaly', 'the seller is unknown, so the bid cannot be addressed');
      return;
    }
    const now = this.ctx.clock.now();
    const serverNow = now + this.offsetFor(s);
    if (serverNow >= isoMs(s.endTime) - MIN_TIME_LEFT_TO_SEND_MS) {
      await drop('anomaly', 'too late: the auction ends in under 1.5 s (or has ended)');
      return;
    }
    const key = `${id}:${crypto.randomUUID()}`;
    // The attempt is this runner's from here: outside attempt events are refused until its reply is recorded.
    this.inFlight.add(id);
    let sent: CommitResult;
    try {
      sent = await this.commit(id, { type: 'sent', now, key }, { consume: [eff] });
    } catch (e) {
      // The write may or may not be stored: never send on it. A stored `sent` with no reply is then
      // read as ambiguous by sentStep, which the in-flight mark must not block.
      this.inFlight.delete(id);
      throw e;
    }
    // Never send unless `sent` was accepted AND persisted (the commit awaited the write).
    if (sent.kind !== 'accepted') {
      this.inFlight.delete(id);
      return;
    }
    let outcome: SendOutcome;
    try {
      outcome = await this.seams.sendStrategy.send(
        { snipe: sent.next, kind: eff.kind, amount: eff.amount, sellerId, idempotencyKey: key, timeoutMs: PLACE_BID_TIMEOUT_MS },
        { api: this.ctx.api, clock: this.ctx.clock, serverNow: () => this.ctx.clock.now() + this.offsetFor(sent.next) },
      );
    } catch (error) {
      outcome = bidMayHaveBeenSent(error) ? { kind: 'ambiguous', error } : { kind: 'not-sent', error };
    }
    try {
      await this.recordOutcome(s, eff, outcome);
    } finally {
      this.inFlight.delete(id);
    }
  }

  /** The send's one answer: `result`, or `ambiguous` (the outcome read settles it). */
  private async recordOutcome(s: Snipe, eff: MoneyEffect, outcome: SendOutcome): Promise<void> {
    const id = s.id;
    const at = this.ctx.clock.now();
    if (outcome.kind === 'result' && BidResultSchema.safeParse(outcome.result).success) {
      await this.commit(id, { type: 'result', now: at, result: outcome.result });
      return;
    }
    if (outcome.kind === 'not-sent') {
      await this.safely('audit', () =>
        this.ctx.audit.append({
          actor: 'snipe',
          kind: 'bid.not-sent',
          itemId: s.itemId,
          ref: id,
          details: { effect: eff.kind, why: errorText(outcome.error), afterSent: true },
          dryRun: false,
        }),
      );
    }
    // Ambiguous, provably not sent, or a reply that is not a BidResult: the outcome read settles it.
    await this.commit(id, { type: 'ambiguous', now: at });
  }

  // ── States ────────────────────────────────────────────────────────────

  private async armedStep(s: Snipe, entry: Entry): Promise<StepResult> {
    await this.ensureArmedAlarms(s);
    await this.holdAwake(s);
    const now = this.ctx.clock.now();
    if (now >= this.wakeAtLocal(s)) {
      await this.commit(s.id, { type: 'wake', now }, { expectVersion: s.history.length });
      return 'continue';
    }
    const preflightAt = Math.max(this.endLocal(s) - PREFLIGHT_LEAD_MS, entry.preflightNotBefore ?? 0);
    if (entry.preflightAt === undefined && now >= preflightAt) {
      await this.runPreflight(s);
      return 'continue';
    }
    return 'wait';
  }

  private async wakingStep(s: Snipe): Promise<StepResult> {
    await this.openWindow(s);
    if (await this.checkAnomaly(s)) return 'continue';
    const sess = this.windowSession(s);
    const verifyAt = this.endLocal(s) - VERIFY_BEFORE_END_MS;
    const now = this.ctx.clock.now();
    // T-81: 3 ItemDetail samples, 20 s apart, from the wake; those that no longer fit before the verify are skipped.
    while (sess.nextSample < sess.plan.length) {
      const at = sess.plan[sess.nextSample] ?? Number.POSITIVE_INFINITY;
      if (at >= verifyAt) {
        sess.nextSample = sess.plan.length;
        break;
      }
      if (now < at) {
        this.setTimer(s.id, at);
        return 'wait';
      }
      sess.nextSample += 1;
      const read = await this.windowRead(s, sess);
      if (read.anomaly !== undefined) await this.commit(s.id, { type: 'disarm', now: this.ctx.clock.now(), by: 'anomaly', why: read.anomaly });
      return 'continue';
    }
    if (now < verifyAt) {
      this.setTimer(s.id, verifyAt);
      return 'wait';
    }
    await this.verify(s, sess);
    return 'continue';
  }

  /** The T-60 s verify read and its event. */
  private async verify(s: Snipe, sess: WindowSession): Promise<void> {
    const consume: Effect[] = [
      { kind: 'sampleClock', snipeId: s.id },
      { kind: 'readDetail', snipeId: s.id, purpose: 'verify' },
    ];
    let detail: ItemDetail | undefined;
    let rttMs = 0;
    let failure: ReadErrorKind = 'network';
    for (let attempt = 0; attempt < VERIFY_ATTEMPTS && detail === undefined; attempt++) {
      const read = await this.windowRead(s, sess);
      if (read.anomaly !== undefined) {
        await this.commit(s.id, { type: 'disarm', now: this.ctx.clock.now(), by: 'anomaly', why: read.anomaly }, { consume });
        return;
      }
      if (read.detail !== undefined) {
        detail = read.detail;
        rttMs = read.rttMs ?? 0;
      } else {
        failure = read.kind ?? 'network';
      }
    }
    const now = this.ctx.clock.now();
    // Latency: SGW is too slow right now for a bid to land on time (an older fast sample would hide it).
    if (detail !== undefined && rttMs > MAX_RTT_MS) {
      const why = `latency: SGW took ${String(Math.round(rttMs))} ms to answer the 60-second check (over ${String(MAX_RTT_MS)} ms)`;
      await this.commit(s.id, { type: 'disarm', now, by: 'anomaly', why }, { consume, detail });
      return;
    }
    if (detail === undefined) {
      await this.commit(s.id, { type: 'verify-failed', now, reason: failure === 'auth' ? 'auth' : 'network' }, { consume });
      return;
    }
    const sessionUsable = usableSession(await this.ctx.session.state());
    await this.commit(s.id, this.verifyEvent(s, detail, now, sessionUsable), { consume, detail, expectVersion: s.history.length });
  }

  /** Maps the verify read to `verified` / `verify-failed`; the reducer judges ended, extended, clock and caps. */
  private verifyEvent(s: Snipe, d: ItemDetail, now: EpochMs, sessionUsable: boolean): SnipeEvent {
    const offset = this.ctx.sgwClock.offset();
    const clockKnown = offset !== null && offset.confidence !== 'none';
    const endMs = isoMs(d.endTime);
    const over = d.isClosed || isoMs(d.serverTime) >= endMs;
    const later = endMs > isoMs(s.endTime);
    if ((over || later) && clockKnown) return { type: 'verified', now, detail: d, offsetMs: offset.offsetMs, rttMs: offset.rttMs };
    if (over) return { type: 'verify-failed', now, reason: 'ended' };
    if (later) return { type: 'verify-failed', now, reason: 'extended' };
    if (d.isHighBidder === true) return { type: 'verify-failed', now, reason: 'already-high' };
    // `minimumBid` is the next acceptable bid (detail value).
    if (!(d.minimumBid <= s.maxBid)) return { type: 'verify-failed', now, reason: 'price-over-max' };
    if (!sessionUsable) return { type: 'verify-failed', now, reason: 'auth' };
    if (!clockKnown) return { type: 'verify-failed', now, reason: 'clock' };
    return { type: 'verified', now, detail: d, offsetMs: offset.offsetMs, rttMs: offset.rttMs };
  }

  private async verifiedStep(s: Snipe): Promise<StepResult> {
    await this.openWindow(s);
    if (await this.checkAnomaly(s)) return 'continue';
    const fireLocal = toLocalFireAt(s.fireAt ?? computeFireAt(isoMs(s.endTime), s.leadMs, 0), s.measured?.offsetMs ?? 0);
    if (!this.details.has(s.id)) {
      // A restarted worker: re-read (a fresh clock sample, and the detail the caps check needs at fire).
      const sess = this.windowSession(s);
      const read = await this.windowRead(s, sess);
      const now = this.ctx.clock.now();
      if (read.anomaly !== undefined) await this.commit(s.id, { type: 'disarm', now, by: 'anomaly', why: read.anomaly });
      else if (read.detail === undefined) await this.commit(s.id, { type: 'verify-failed', now, reason: read.kind === 'auth' ? 'auth' : 'network' });
      return 'continue';
    }
    const now = this.ctx.clock.now();
    if (now < fireLocal) {
      this.setTimer(s.id, fireLocal);
      return 'wait';
    }
    await this.commit(s.id, { type: 'fire', now }, { expectVersion: s.history.length });
    return 'continue';
  }

  private async firingStep(s: Snipe, entry: Entry): Promise<StepResult> {
    if (!s.dryRun) {
      // No money effect left and nothing sent: it was dropped (or the outbox was lost). Close it; nothing was sent.
      const c = this.closeWhy.get(s.id) ?? { by: 'anomaly' as const, why: 'the bid could not be sent' };
      await this.commit(s.id, { type: 'disarm', now: this.ctx.clock.now(), by: c.by, why: c.why });
      return 'continue';
    }
    // C4: the harmless read at fire time, in place of PlaceBid, measures real latency.
    await this.openWindow(s);
    return this.outcomeRead(s, entry, { kind: 'readDetail', snipeId: s.id, purpose: 'measure' });
  }

  private async fallbackAppliedStep(s: Snipe): Promise<StepResult> {
    // The early proxy's money effect was dropped (blocked writes, kill, too late) or lost: close it, nothing was sent.
    // `anomaly` is refused here (the fallback was already decided, m1), so the close-out is a `kill` with its reason.
    const c = this.closeWhy.get(s.id);
    await this.commit(s.id, { type: 'disarm', now: this.ctx.clock.now(), by: 'kill', why: c?.why ?? 'the early proxy bid could not be placed' });
    return 'continue';
  }

  private async sentStep(s: Snipe, entry: Entry): Promise<StepResult> {
    if (this.inFlight.has(s.id)) return 'wait';
    if (s.attempt.reply === undefined && s.attempt.ambiguous !== true) {
      // `sent` is stored but its reply is not: the worker died mid-send. Ambiguous: read, never resend.
      await this.commit(s.id, { type: 'ambiguous', now: this.ctx.clock.now() });
      return 'continue';
    }
    return this.outcomeRead(s, entry, { kind: 'readDetail', snipeId: s.id, purpose: 'post-read' });
  }

  /**
   * The outcome read (`post-read`), or a dry run's measure read, with its
   * bounded retries. Success feeds `post-read` to the reducer. A sent snipe
   * whose fast attempts all fail is reported Unconfirmed (check the item),
   * then retried slowly; a dry run whose measure read keeps failing is closed.
   */
  private async outcomeRead(s: Snipe, entry: Entry, eff: DriveEffect): Promise<StepResult> {
    const failures = entry.readFailures ?? 0;
    const due = this.readDue(s, entry);
    if (due === null) {
      await this.closeWindow(s.id);
      if (s.state === 'firing') {
        await this.commit(s.id, { type: 'disarm', now: this.ctx.clock.now(), by: 'anomaly', why: 'the dry-run measure read kept failing' });
        return 'continue';
      }
      return 'wait';
    }
    const now = this.ctx.clock.now();
    if (now < due) {
      if (failures === 0 && due - now <= WINDOW_HOLD_MAX_WAIT_MS) {
        await this.openWindow(s);
        this.setTimer(s.id, due);
      } else {
        await this.closeWindow(s.id);
        await this.ctx.alarms.create(snipeAlarmName(s.id, 'postread'), { when: due });
      }
      return 'wait';
    }
    const lane: Lane = failures === 0 ? 'snipe' : 'background';
    let detail: ItemDetail | undefined;
    try {
      detail = await this.readItem(s, lane, false);
    } catch (e) {
      this.log(`snipe ${s.id}: the ${eff.kind === 'readDetail' ? eff.purpose : 'outcome'} read failed`, e);
    }
    const at = this.ctx.clock.now();
    if (detail !== undefined) {
      await this.commit(s.id, { type: 'post-read', now: at, detail }, { consume: [eff], detail });
      return 'continue';
    }
    const n = failures + 1;
    await this.updateEntry(s.id, { readFailures: n, lastReadAt: at });
    if (s.state === 'sent' && n >= POST_READ_FAST_ATTEMPTS && entry.unconfirmedAt === undefined) await this.unconfirmed(s, n);
    return 'continue';
  }

  /** When the next outcome read is due, or null when the attempts are spent. */
  private readDue(s: Snipe, entry: Entry): EpochMs | null {
    const failures = entry.readFailures ?? 0;
    const last = entry.lastReadAt ?? this.ctx.clock.now();
    if (failures === 0) return s.state === 'firing' ? this.ctx.clock.now() : this.endLocal(s) + POST_READ_AFTER_END_MS;
    if (failures < POST_READ_FAST_ATTEMPTS) return last + (POST_READ_RETRY_DELAYS_MS[failures - 1] ?? 0);
    if (s.state === 'sent' && failures < POST_READ_FAST_ATTEMPTS + POST_READ_SLOW_ATTEMPTS) return last + POST_READ_SLOW_INTERVAL_MS;
    return null;
  }

  /** Tell the user once: T-87's copy for a bid with no readable outcome (never "Not bid"), and "check the item". */
  private async unconfirmed(s: Snipe, attempts: number): Promise<void> {
    const settings = await this.settings();
    const reply = s.attempt.ambiguous === true ? null : (s.attempt.reply ?? null);
    const c = classifyOutcome(s, reply, null, { userTz: settings.locale.timeZone });
    const at = this.ctx.clock.now();
    await this.updateEntry(s.id, { unconfirmedAt: at });
    await this.safely('notify', () =>
      this.ctx.notifier.notify({
        id: `sbw:snipe:${s.id}:unconfirmed`,
        title: `Unconfirmed: ${s.title}`,
        message: `${c.notify.message} The result could not be read after ${String(attempts)} tries: check the item on ShopGoodwill.`,
        priority: 2,
        openUrlOnClick: `${ITEM_URL}${String(s.itemId)}`,
      }),
    );
    await this.safely('audit', () =>
      this.ctx.audit.append({
        actor: 'snipe',
        kind: 'snipe.unconfirmed',
        itemId: s.itemId,
        ref: s.id,
        details: { attempts, outcome: c.outcome, detail: c.detail },
        dryRun: s.dryRun,
      }),
    );
  }

  /** A finished snipe: drop its alarms, timers, window, keep-awake and runner entry. */
  private async finish(s: Snipe): Promise<void> {
    const id = s.id;
    this.clearTimer(id);
    await this.closeWindow(id);
    await this.releaseAwake(id);
    this.sessions.delete(id);
    this.closeWhy.delete(id);
    this.alarmsSet.delete(id);
    for (const kind of SNIPE_ALARM_KINDS) await this.ctx.alarms.clear(snipeAlarmName(id, kind));
    await this.updateRecord((r) => {
      const e = r.entries[id];
      if (e !== undefined && e.outbox.every(isDrive)) Reflect.deleteProperty(r.entries, id);
    });
  }

  /** The snipe is gone from storage: drop what this worker holds for it. */
  private async forget(id: string): Promise<void> {
    this.cache.delete(id);
    this.details.delete(id);
    this.clearTimer(id);
    await this.closeWindow(id);
    await this.releaseAwake(id);
    this.sessions.delete(id);
  }

  // ── Preflight (T-15 min, lane background) ─────────────────────────────

  private async runPreflight(s: Snipe): Promise<void> {
    let detail: ItemDetail | null = null;
    try {
      detail = await this.readItem(s, 'background', false);
    } catch (e) {
      this.log(`snipe ${s.id}: the preflight read failed (preflight warns; the verify read checks again)`, e);
    }
    // A restarted worker has no clock: sample it before the preflight (ItemDetail serverTime when possible).
    if (!assessClock(this.ctx.sgwClock.offset()).ok) {
      try {
        await this.ctx.api.serverTimeSample();
      } catch (e) {
        this.log(`snipe ${s.id}: the preflight clock sample failed`, e);
      }
    }
    const settings = await this.settings();
    const [state, token] = await Promise.all([this.ctx.session.state(), this.ctx.session.current()]);
    const all = await this.ctx.repo.get(STORAGE_KEYS.snipes);
    const fresh = all[s.id];
    if (fresh?.state !== 'armed') return;
    const now = this.ctx.clock.now();
    const tz = settings.locale.timeZone;
    const others = Object.values(all).filter((o) => o.id !== fresh.id);
    const pctx: PreflightContext = {
      now,
      timeZone: tz,
      session: { state, token: token === null ? null : { expiresAt: token.expiresAt } },
      clockOffset: this.ctx.sgwClock.offset(),
      keepAwake: await this.keepAwakeState(fresh, settings),
      writesAllowed: this.biddingVerdict(fresh).ok,
      detail,
      caps: { limits: settings.snipe.caps, others, spentToday: spentToday(others, now, tz) },
    };
    const result = preflight(fresh, pctx);
    if (!result.ok && result.reason === 'not-armed') return;
    if (!result.ok && result.reason === 'not-due') {
      // The end moved later: preflight again 15 min before the new end.
      const end = Math.max(isoMs(fresh.endTime), detail === null ? 0 : isoMs(detail.endTime));
      const when = end - this.offsetFor(fresh) - PREFLIGHT_LEAD_MS;
      await this.updateEntry(fresh.id, { preflightNotBefore: when });
      await this.ctx.alarms.create(snipeAlarmName(fresh.id, 'preflight'), { when });
      return;
    }
    await this.updateEntry(fresh.id, { preflightAt: now });
    const withDetail = detail === null ? {} : { detail };
    if (!result.ok) {
      // Only the reducer's effects run: preflight's own fallback effects are dropped (carry #1).
      await this.commit(fresh.id, { type: 'preflight-failed', now, reason: result.reason }, { ...withDetail, expectVersion: fresh.history.length });
      return;
    }
    for (const h of [...this.seams.hooks]) {
      let f: PreflightHookFailure | undefined;
      try {
        f = await h.preflight?.(fresh);
      } catch (e) {
        this.log(`snipe ${fresh.id}: a preflight hook threw`, e);
      }
      if (f !== undefined) {
        await this.safely('audit', () =>
          this.ctx.audit.append({ actor: 'snipe', kind: 'snipe.preflight', itemId: fresh.itemId, ref: fresh.id, details: { ok: false, hook: f.reason, why: f.detail }, dryRun: fresh.dryRun }),
        );
        await this.commit(fresh.id, { type: 'preflight-failed', now, reason: f.reason }, withDetail);
        return;
      }
    }
    // A passing preflight changes no state: its audit entry and its "Snipe soon" notice.
    for (const eff of result.effects) {
      if (eff.kind === 'audit' || eff.kind === 'notify') await this.sideEffect(fresh, eff);
    }
  }

  // ── Health checks (AuthHealth port, 0 SGW requests) ───────────────────

  private async healthCheck(id: string, which: 'health24' | 'health1'): Promise<void> {
    const { snipe: s, entry } = await this.load(id);
    if (s === undefined || isTerminal(s)) return;
    // From T-15 min on, the preflight decides.
    if (this.ctx.clock.now() >= this.endLocal(s) - PREFLIGHT_LEAD_MS) return;
    let r: AuthHealthResult;
    try {
      r = await this.seams.authHealth.check(s, which === 'health24' ? '24h' : '1h');
    } catch (e) {
      this.log(`snipe ${id}: the auth-health check threw`, e);
      return;
    }
    if (r.ok) return;
    // At risk: alert the user while there is time to fix it. Never a disarm here.
    await this.updateEntry(id, { atRisk: r.reason });
    await this.safely('audit', () =>
      this.ctx.audit.append({ actor: 'snipe', kind: 'snipe.at-risk', itemId: s.itemId, ref: id, details: { check: which, reason: r.reason, detail: r.detail }, dryRun: s.dryRun }),
    );
    if (entry.atRisk !== r.reason) {
      await this.safely('notify', () =>
        this.ctx.notifier.notify({
          id: `sbw:snipe:${id}:at-risk`,
          title: `Snipe at risk: ${s.title}`,
          message: `${r.detail} Fix it before the auction ends: the check 15 minutes before the end decides whether the snipe runs.`,
          priority: 2,
          openUrlOnClick: `${ITEM_URL}${String(s.itemId)}`,
        }),
      );
    }
  }

  // ── Anomalies (auto-kill) ─────────────────────────────────────────────

  /** In the window: kill switch → disarm(kill); blocked bidding (health, session, storage) → disarm(anomaly) + fallback. */
  private async checkAnomaly(s: Snipe): Promise<boolean> {
    const a = this.anomaly(s);
    if (a === null) return false;
    const r = await this.commit(s.id, { type: 'disarm', now: this.ctx.clock.now(), by: a.by, why: a.why });
    return r.kind === 'accepted';
  }

  /** Reacts to a switch change at once (not waiting for the next step), for a snipe in its window. */
  private async react(id: string): Promise<void> {
    const s = this.cache.get(id);
    if (s === undefined || !(s.state === 'waking' || s.state === 'verified' || s.state === 'firing')) return;
    const a = this.anomaly(s);
    if (a === null) return;
    // The in-progress read records schema drift itself. A health disarm here would hide that.
    if (this.reading.has(id) && a.by !== 'kill') return;
    // A firing snipe is only stopped by the kill switch here; its money gate handles the rest.
    if (s.state === 'firing' && a.by !== 'kill') return;
    const r = await this.commit(id, { type: 'disarm', now: this.ctx.clock.now(), by: a.by, why: a.why });
    if (r.kind === 'accepted') void this.drive(id);
  }

  /**
   * The live bidding verdict. A dry-run snipe ignores only the dry-run condition,
   * so kill, health (sticky scoping and a pending flagged failure), storage and
   * the session still stop it. A live snipe sees the dry run too.
   */
  private biddingVerdict(s: Snipe): Verdict {
    return this.ctx.switches.verdictNow('bidding', { ignoreDryRun: s.dryRun });
  }

  private anomaly(s: Snipe): { by: 'kill' | 'anomaly'; why: string } | null {
    const v = this.biddingVerdict(s);
    if (v.ok) return null;
    const why = v.why ?? 'bidding is blocked';
    if (why === WHY.kill) return { by: 'kill', why: 'the kill switch is on' };
    return { by: 'anomaly', why: `bidding is blocked: ${why}` };
  }

  // ── Reads ─────────────────────────────────────────────────────────────

  /**
   * One fresh ItemDetail read. On the snipe lane it is also a clock sample
   * (ms-precision serverTime of this item, T-81/T-29); `sample` false skips that.
   */
  private async readItem(s: Snipe, lane: Lane, sample: boolean): Promise<ItemDetail> {
    const sentAt = this.ctx.clock.now();
    const d = await this.ctx.api.itemDetail(s.itemId, lane, lane === 'snipe' ? undefined : { maxAgeMs: 0 });
    this.details.set(s.id, d);
    if (sample && lane === 'snipe') {
      const smp = this.sampler.sampleFromServerTime(d.serverTimeRaw, sentAt, d.observedAt);
      if (smp !== null) this.ctx.sgwClock.addSample(smp);
    }
    return d;
  }

  /** A window read (sample or verify): errors counted; schema drift and repeated errors are anomalies. */
  private async windowRead(s: Snipe, sess: WindowSession): Promise<{ detail?: ItemDetail; rttMs?: number; kind?: ReadErrorKind; anomaly?: string }> {
    const sentAt = this.ctx.clock.now();
    this.reading.add(s.id);
    try {
      const detail = await this.readItem(s, 'snipe', true);
      sess.consecutiveErrors = 0;
      return { detail, rttMs: detail.observedAt - sentAt };
    } catch (e) {
      sess.consecutiveErrors += 1;
      const kind = readErrorKind(e);
      this.log(`snipe ${s.id}: a window read failed (${kind})`, e);
      if (kind === 'schema') return { kind, anomaly: `schema drift: ${errorText(e)}` };
      if (sess.consecutiveErrors >= MAX_CONSECUTIVE_READ_ERRORS) {
        return { kind, anomaly: `repeated errors: ${String(sess.consecutiveErrors)} failed reads in a row (${errorText(e)})` };
      }
      return { kind };
    } finally {
      this.reading.delete(s.id);
    }
  }

  private windowSession(s: Snipe): WindowSession {
    let sess = this.sessions.get(s.id);
    if (sess === undefined) {
      sess = { plan: planClockSamples(this.ctx.clock.now()), nextSample: 0, consecutiveErrors: 0 };
      this.sessions.set(s.id, sess);
    }
    return sess;
  }

  // ── Window: KeepAlive + host + recovery alarm ─────────────────────────

  private async openWindow(s: Snipe): Promise<void> {
    if (this.windows.has(s.id)) return;
    this.windows.add(s.id);
    if (this.windows.size === 1) this.ctx.keepAlive.start(KEEP_ALIVE_INTERVAL_MS);
    await this.safely('host acquire', () => this.host.host.acquire(s.id));
    if (this.host.degraded && !this.degradedNoted.has(s.id)) {
      this.degradedNoted.add(s.id);
      await this.safely('audit', () =>
        this.ctx.audit.append({
          actor: 'snipe',
          kind: 'snipe.host-degraded',
          itemId: s.itemId,
          ref: s.id,
          details: { verdict: this.host.verdict, implementation: this.host.implementation },
          dryRun: s.dryRun,
        }),
      );
    }
    await this.ctx.alarms.create(snipeAlarmName(s.id, 'recover'), {
      when: this.ctx.clock.now() + RECOVER_PERIOD_MINUTES * MIN,
      periodInMinutes: RECOVER_PERIOD_MINUTES,
    });
  }

  private async closeWindow(id: string): Promise<void> {
    if (!this.windows.delete(id)) return;
    if (this.windows.size === 0) this.ctx.keepAlive.stop();
    await this.safely('host release', () => this.host.host.release(id));
    await this.ctx.alarms.clear(snipeAlarmName(id, 'recover'));
  }

  // ── KeepAwake (tier T1, Chrome with `power`) ──────────────────────────

  private async keepAwakeRequired(settings: Settings): Promise<boolean> {
    if (settings.snipe.tier !== 'T1' || !this.ctx.keepAwake.available) return false;
    try {
      return await this.ctx.permissions.contains({ permissions: ['power'] });
    } catch {
      return false;
    }
  }

  private async keepAwakeState(s: Snipe, settings: Settings): Promise<PreflightContext['keepAwake']> {
    if (!(await this.keepAwakeRequired(settings))) return 'not-required';
    return this.awake.has(s.id) ? 'held' : 'not-held';
  }

  private async holdAwake(s: Snipe): Promise<void> {
    if (this.awake.has(s.id) || isTerminal(s)) return;
    if (!(await this.keepAwakeRequired(await this.settings()))) return;
    try {
      await this.ctx.keepAwake.hold(`snipe ${s.id}`);
      this.awake.add(s.id);
    } catch (e) {
      this.log(`snipe ${s.id}: keep-awake could not be held`, e);
    }
  }

  private async releaseAwake(id: string): Promise<void> {
    if (!this.awake.delete(id) || this.awake.size > 0) return;
    await this.safely('keep-awake release', () => this.ctx.keepAwake.release());
  }

  // ── Alarms and timers ─────────────────────────────────────────────────

  private onAlarm(name: string): void {
    const p = parseSnipeAlarm(name);
    if (p === null) return;
    if (p.kind === 'health24' || p.kind === 'health1') {
      void this.healthCheck(p.id, p.kind).catch((e: unknown) => {
        this.log(`snipe ${p.id}: the health check failed`, e);
      });
      return;
    }
    void this.drive(p.id);
  }

  /** The armed snipe's alarms, (re)created once per worker: health checks, preflight, wake. */
  private async ensureArmedAlarms(s: Snipe): Promise<void> {
    if (this.alarmsSet.has(s.id)) return;
    this.alarmsSet.add(s.id);
    const now = this.ctx.clock.now();
    const end = this.endLocal(s);
    const plan: Array<[SnipeAlarmKind, EpochMs]> = [
      ['health24', end - HEALTH24_BEFORE_END_MS],
      ['health1', end - HEALTH1_BEFORE_END_MS],
      ['preflight', end - PREFLIGHT_LEAD_MS],
      ['wake', this.wakeAtLocal(s)],
    ];
    const existing = new Set((await this.ctx.alarms.getAll()).map((a) => a.name));
    for (const [kind, when] of plan) {
      const name = snipeAlarmName(s.id, kind);
      if (when <= now && kind !== 'wake') continue;
      if (existing.has(name)) continue;
      await this.ctx.alarms.create(name, { when: Math.max(when, now) });
    }
  }

  private setTimer(id: string, at: EpochMs): void {
    this.clearTimer(id);
    const t = this.ctx.clock.setTimeout(
      () => {
        this.timers.delete(id);
        void this.drive(id);
      },
      Math.max(0, at - this.ctx.clock.now()),
    );
    this.timers.set(id, t);
  }

  private clearTimer(id: string): void {
    const t = this.timers.get(id);
    if (t !== undefined) this.ctx.clock.clearTimeout(t);
    this.timers.delete(id);
  }

  // ── Time ──────────────────────────────────────────────────────────────

  /** server - local: the snipe's measured offset, else the clock's current usable one, else 0. */
  private offsetFor(s: Snipe): number {
    if (s.measured?.offsetMs !== undefined) return s.measured.offsetMs;
    const a = assessClock(this.ctx.sgwClock.offset());
    return a.ok ? a.offsetMs : 0;
  }

  private endLocal(s: Snipe): EpochMs {
    return isoMs(s.endTime) - this.offsetFor(s);
  }

  /** The wake, 5 min before the planned fire (the provisional plan before the verify). */
  private wakeAtLocal(s: Snipe): EpochMs {
    const fireServer = s.fireAt ?? computeFireAt(isoMs(s.endTime), s.leadMs, 0);
    return fireServer - this.offsetFor(s) - WAKE_BEFORE_FIRE_MS;
  }

  // ── Countdown port (§3.12) ────────────────────────────────────────────

  private serveCountdown(port: RuntimePort): void {
    let open = true;
    let timer: number | undefined;
    const stop = (): void => {
      open = false;
      if (timer !== undefined) this.ctx.clock.clearTimeout(timer);
      timer = undefined;
    };
    const tick = (): void => {
      if (!open || this.disposed) return;
      const serverNow = this.ctx.sgwClock.serverNow();
      try {
        for (const s of this.cache.values()) {
          if (isTerminal(s)) continue;
          const msg = SnipeCountdownTickSchema.parse({ snipeId: s.id, serverNow, fireAt: s.fireAt ?? null, state: s.state });
          port.postMessage(msg);
        }
      } catch (e) {
        this.log('snipe countdown: the port is gone', e);
        stop();
        return;
      }
      timer = this.ctx.clock.setTimeout(tick, COUNTDOWN_INTERVAL_MS);
    };
    port.onDisconnect.addListener(stop);
    tick();
  }

  // ── Misc ──────────────────────────────────────────────────────────────

  private async settings(): Promise<Settings> {
    return this.ctx.switches.settings() ?? (await this.ctx.repo.get(STORAGE_KEYS.settings));
  }

  private async safely(what: string, fn: () => unknown): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.log(`snipe runner: ${what} failed`, e);
    }
  }
}

/** T-36 self-registration (I-01): one runner per background; it reconciles at once (restart recovery). */
export function register(ctx: BackgroundContext): void {
  const runner = new SnipeRunner(ctx, seamsOf(ctx));
  RUNNERS.set(ctx, runner);
  runner.start();
}
