// T-80: the snipe state machine (PLAN §3.9 `reduce`). Tests first, per the
// card: the exhaustive transition table, `sent` terminal for sending,
// ambiguous → post-read → classifyOutcome, extended → re-arm proposal, disarm
// → killed, and the fast-check money properties (R1–R5, C1–C5).
import { readFileSync } from 'node:fs';

import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CAPS } from '../../../../src/domain/settings/defaults';
import { exposure, spentToday } from '../../../../src/domain/snipe/caps';
import { classifyOutcome } from '../../../../src/domain/snipe/outcome';
import type * as OutcomeModule from '../../../../src/domain/snipe/outcome';
import { fallbackDecision } from '../../../../src/domain/snipe/preflight';
import type * as PreflightModule from '../../../../src/domain/snipe/preflight';
import {
  ASSUME_EXTENSION_MS,
  capsForEvent,
  FIRE_EARLY_TOLERANCE_MS,
  reduce,
  TRANSITIONS,
  WAKE_BEFORE_FIRE_MS,
  type ReduceContext,
  type ReduceResult,
  type RejectReason,
  type TransitionCell,
} from '../../../../src/domain/snipe/state-machine';
import {
  EffectSchema,
  SnipeEventSchema,
  SnipeSchema,
  SnipeStateSchema,
  type CapsResult,
  type Effect,
  type Reduce,
  type Snipe,
  type SnipeEvent,
  type SnipeState,
} from '../../../../src/domain/snipe/types';
import { BidResultKindSchema, type BidResult, type ItemDetail } from '../../../../src/domain/types';

// Pass-through spies: the real T-83 / T-87 functions run, and the tests can
// see that the reducer calls them (I-18) and with what (C3).
vi.mock('../../../../src/domain/snipe/preflight', async (importOriginal) => {
  const actual = await importOriginal<typeof PreflightModule>();
  return { ...actual, fallbackDecision: vi.fn(actual.fallbackDecision) };
});
vi.mock('../../../../src/domain/snipe/outcome', async (importOriginal) => {
  const actual = await importOriginal<typeof OutcomeModule>();
  return { ...actual, classifyOutcome: vi.fn(actual.classifyOutcome) };
});

// ── Fixtures ────────────────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const TZ = 'America/New_York';
const ITEM = 279250057;
const END = '2026-10-09T23:42:00.000Z'; // 7:42 PM ET
const END_MS = Date.UTC(2026, 9, 9, 23, 42);
const OFFSET = 1300; // server - local
const RTT = 150;
const ARM_AT = END_MS - 24 * HOUR;
const WAKE_AT = END_MS - 8000 - 5 * MIN;
const VERIFY_AT = END_MS - MIN;
const FIRE_AT_SERVER = END_MS - 8000 - RTT / 2; // end - lead - rtt/2, written out
const FIRE_LOCAL = FIRE_AT_SERVER - OFFSET;
const SENT_LOCAL = FIRE_LOCAL + 5;
const RESULT_LOCAL = FIRE_LOCAL + 300;
const POST_LOCAL = END_MS + 10_000;
const PREFLIGHT_AT = END_MS - 15 * MIN;

const CAPS_OK: CapsResult = { ok: true, violations: [] };
const CAPS_BAD: CapsResult = { ok: false, violations: ['per-day: $120.00 would exceed the $100.00 daily cap'] };
const CTX: ReduceContext = { timeZone: TZ, sessionUsable: true, writesAllowed: true };

const iso = (ms: number): string => new Date(ms).toISOString();

function snipe(over: Partial<Snipe> = {}): Snipe {
  return {
    id: 's1',
    itemId: ITEM,
    title: 'Pyrex bowl',
    endTime: END,
    endTimeAtArm: END,
    maxBid: 2000,
    leadMs: 8000,
    fallback: 'early-proxy',
    dryRun: false,
    state: 'draft',
    armedAt: ARM_AT,
    attempt: {},
    history: [],
    ...over,
  };
}

/** A snipe as it would be stored in `state`, with the fields earlier steps set. */
function inState(state: SnipeState, over: Partial<Snipe> = {}): Snipe {
  const armed = { state, fireAt: END_MS - 8000 };
  const verified = { ...armed, fireAt: FIRE_AT_SERVER, measured: { offsetMs: OFFSET, rttMs: RTT } };
  const firing = { ...verified, measured: { ...verified.measured, firedAt: FIRE_AT_SERVER } };
  const byState: Record<SnipeState, Partial<Snipe>> = {
    draft: { state },
    armed,
    'fallback-applied': { ...armed, outcome: 'fallback-proxy-placed', outcomeDetail: 'early proxy' },
    waking: armed,
    verified,
    firing,
    sent: { ...firing, attempt: { sentAt: FIRE_AT_SERVER + 5, idempotencyKey: 'k1' } },
    resolved: { ...firing, outcome: 'won', outcomeDetail: 'won' },
    killed: { ...armed, outcome: 'killed', outcomeDetail: 'killed' },
  };
  return snipe({ ...byState[state], ...over });
}

/** The T−60 verify read: auction open, SGW's clock before the end. */
function detail(over: Partial<ItemDetail> = {}): ItemDetail {
  return {
    itemId: ITEM,
    title: 'Pyrex bowl',
    currentPrice: 1000,
    startingMinimumBid: 500,
    numBids: 3,
    endTime: END,
    endTimeRaw: '2026-10-09T16:42:00',
    sellerId: 1,
    pickupOnly: false,
    source: 'api',
    observedAt: VERIFY_AT,
    minimumBid: 1100,
    bidIncrement: 100,
    serverTime: iso(VERIFY_AT + OFFSET),
    serverTimeRaw: '2026-10-09T16:41:01',
    isClosed: false,
    isHighBidder: false,
    inWatchlist: null,
    bidHistory: [],
    ...over,
  };
}

/** The outcome read after the end: auction closed. */
function closedDetail(over: Partial<ItemDetail> = {}): ItemDetail {
  return detail({ isClosed: true, serverTime: iso(END_MS + 10_000), observedAt: POST_LOCAL, ...over });
}

function bid(kind: BidResult['kind'], over: Partial<BidResult> = {}): BidResult {
  return { kind, rawStatus: 200, rawResult: 0, messageText: 'msg', isHighBidder: null, observedAt: RESULT_LOCAL, ...over };
}

const E = {
  arm: (now = ARM_AT): SnipeEvent => ({ type: 'arm', now }),
  disarm: (by: 'user' | 'kill' | 'anomaly' = 'user', why = 'stopped in a test', now = VERIFY_AT): SnipeEvent => ({
    type: 'disarm',
    now,
    by,
    why,
  }),
  wake: (now = WAKE_AT): SnipeEvent => ({ type: 'wake', now }),
  verified: (d: ItemDetail = detail(), offsetMs = OFFSET, rttMs = RTT, now = VERIFY_AT): SnipeEvent => ({
    type: 'verified',
    now,
    detail: d,
    offsetMs,
    rttMs,
  }),
  verifyFailed: (reason: Extract<SnipeEvent, { type: 'verify-failed' }>['reason'], now = VERIFY_AT): SnipeEvent => ({
    type: 'verify-failed',
    now,
    reason,
  }),
  fire: (now = FIRE_LOCAL): SnipeEvent => ({ type: 'fire', now }),
  sent: (key = 'k1', now = SENT_LOCAL): SnipeEvent => ({ type: 'sent', now, key }),
  result: (result: BidResult = bid('accepted', { isHighBidder: true }), now = RESULT_LOCAL): SnipeEvent => ({
    type: 'result',
    now,
    result,
  }),
  ambiguous: (now = RESULT_LOCAL): SnipeEvent => ({ type: 'ambiguous', now }),
  postRead: (d: ItemDetail = closedDetail(), now = POST_LOCAL): SnipeEvent => ({ type: 'post-read', now, detail: d }),
  postReadFailed: (now = POST_LOCAL): SnipeEvent => ({ type: 'post-read-failed', now }),
  notSent: (reason = 'the bid modal could not be read', now = RESULT_LOCAL): SnipeEvent => ({ type: 'not-sent', now, reason }),
  preflightFailed: (reason: string, now = PREFLIGHT_AT): SnipeEvent => ({ type: 'preflight-failed', now, reason }),
  applyFallback: (mode: 'early-proxy' | 'skip', now = VERIFY_AT): SnipeEvent => ({ type: 'apply-fallback', now, mode }),
};

type EventType = SnipeEvent['type'];
const STATES: readonly SnipeState[] = SnipeStateSchema.options;
const EVENT_TYPES: readonly EventType[] = SnipeEventSchema.options.map((o) => o.shape.type.value);
const TERMINAL: readonly SnipeState[] = ['resolved', 'killed'];
const PRE_SENT: readonly SnipeState[] = ['draft', 'armed', 'fallback-applied', 'waking', 'verified', 'firing'];

/** One accepted event of each type, valid in the states that accept it. */
const CANON: Record<EventType, SnipeEvent> = {
  arm: E.arm(),
  disarm: E.disarm('user'),
  wake: E.wake(),
  verified: E.verified(),
  'verify-failed': E.verifyFailed('network'),
  fire: E.fire(),
  sent: E.sent(),
  result: E.result(),
  ambiguous: E.ambiguous(),
  'post-read': E.postRead(),
  'post-read-failed': E.postReadFailed(),
  'not-sent': E.notSent(),
  'preflight-failed': E.preflightFailed('clock'),
  'apply-fallback': E.applyFallback('early-proxy'),
};

interface Step {
  e: SnipeEvent;
  caps?: CapsResult;
  ctx?: ReduceContext;
}

/** Feeds events in order; each result's `next` is the input to the following event. */
function play(start: Snipe, steps: ReadonlyArray<SnipeEvent | Step>): { results: ReduceResult[]; last: Snipe } {
  const results: ReduceResult[] = [];
  let s = start;
  for (const raw of steps) {
    const step: Step = 'type' in raw ? { e: raw } : raw;
    const r = reduce(s, step.e, step.caps ?? CAPS_OK, step.ctx ?? CTX);
    results.push(r);
    s = r.next;
  }
  return { results, last: s };
}

const kinds = (effects: readonly Effect[]): string[] => effects.map((x) => x.kind);
/** Text that says no bid went out: never allowed once a bid may have been sent. */
const NO_BID_CLAIM = /no bid was placed|not bid|no bid sent|no bid was sent/i;
const ofKind = <K extends Effect['kind']>(effects: readonly Effect[], kind: K): Extract<Effect, { kind: K }>[] =>
  effects.filter((x): x is Extract<Effect, { kind: K }> => x.kind === kind);
const money = (effects: readonly Effect[]): Effect[] =>
  effects.filter((x) => x.kind === 'placeBid' || x.kind === 'applyFallbackProxy');
const audits = (effects: readonly Effect[]): string[] => ofKind(effects, 'audit').map((a) => a.entry.kind);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function cellText(cell: TransitionCell): string {
  if ('reject' in cell) return `✗ ${cell.reject}`;
  const guards = cell.guards !== undefined && cell.guards.length > 0 ? ` (guards: ${cell.guards.join(', ')})` : '';
  return `${cell.to.join(' | ')}${guards}`;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fallbackDecision).mockClear();
  vi.mocked(classifyOutcome).mockClear();
});

// ── Constants ───────────────────────────────────────────────────────────────

describe('constants (pinned)', () => {
  it('ASSUME_EXTENSION_MS is 0, per the S-3 verdict (docs/spikes/S-3.md)', () => {
    expect(ASSUME_EXTENSION_MS).toBe(0);
  });

  it('the wake alarm is 5 min before the fire (PLAN §1.3)', () => {
    expect(WAKE_BEFORE_FIRE_MS).toBe(5 * MIN);
  });

  it('fire is refused more than 2 s before the planned fire (m2)', () => {
    expect(FIRE_EARLY_TOLERANCE_MS).toBe(2000);
  });

  it('reduce implements the frozen Reduce contract type (I-08)', () => {
    const asContract: Reduce = reduce; // compile-time check: an optional 4th parameter only
    expect(asContract).toBe(reduce);
  });
});

// ── R1: the exhaustive transition table ─────────────────────────────────────

/**
 * The spec, written out (tests first). Every state × event is either the next
 * state(s) or a typed rejection. "guards" are data-dependent rejections that
 * an accepting cell may still return (e.g. a failing CapsResult at arm).
 */
const EXPECTED: Record<SnipeState, Record<EventType, string>> = {
  draft: {
    arm: 'armed (guards: caps, invalid-snipe)',
    disarm: 'killed',
    wake: '✗ not-armed',
    verified: '✗ not-armed',
    'verify-failed': '✗ not-armed',
    fire: '✗ not-armed',
    sent: '✗ not-armed',
    result: '✗ not-armed',
    ambiguous: '✗ not-armed',
    'post-read': '✗ not-armed',
    'post-read-failed': '✗ not-armed',
    'not-sent': '✗ not-armed',
    'preflight-failed': '✗ not-armed',
    'apply-fallback': '✗ not-armed',
  },
  armed: {
    arm: '✗ already-armed',
    disarm: 'killed | fallback-applied',
    wake: 'waking',
    verified: '✗ not-awake',
    'verify-failed': '✗ not-awake',
    fire: '✗ not-verified',
    sent: '✗ not-firing',
    result: '✗ not-sent',
    ambiguous: '✗ not-sent',
    'post-read': '✗ not-sent',
    'post-read-failed': '✗ not-sent',
    'not-sent': '✗ not-firing',
    'preflight-failed': 'resolved | fallback-applied (guards: invalid-event)',
    'apply-fallback': 'resolved | fallback-applied',
  },
  'fallback-applied': {
    arm: '✗ already-armed',
    disarm: 'killed (guards: fallback-applied)',
    wake: '✗ fallback-applied',
    verified: '✗ fallback-applied',
    'verify-failed': '✗ fallback-applied',
    fire: '✗ fallback-applied',
    sent: 'sent (guards: dry-run, already-sent, invalid-event)',
    result: '✗ not-sent',
    ambiguous: '✗ not-sent',
    'post-read': '✗ not-sent',
    'post-read-failed': '✗ not-sent',
    'not-sent': '✗ not-sent',
    'preflight-failed': '✗ fallback-applied',
    'apply-fallback': '✗ fallback-applied',
  },
  waking: {
    arm: '✗ already-armed',
    disarm: 'killed | fallback-applied',
    wake: '✗ step-passed',
    verified: 'verified | resolved | fallback-applied (guards: invalid-event)',
    'verify-failed': 'resolved | fallback-applied',
    fire: '✗ not-verified',
    sent: '✗ not-firing',
    result: '✗ not-sent',
    ambiguous: '✗ not-sent',
    'post-read': '✗ not-sent',
    'post-read-failed': '✗ not-sent',
    'not-sent': '✗ not-firing',
    'preflight-failed': '✗ step-passed',
    'apply-fallback': 'resolved | fallback-applied',
  },
  verified: {
    arm: '✗ already-armed',
    disarm: 'killed | fallback-applied',
    wake: '✗ step-passed',
    verified: '✗ step-passed',
    'verify-failed': 'resolved | fallback-applied',
    fire: 'firing | resolved (guards: too-early)',
    sent: '✗ not-firing',
    result: '✗ not-sent',
    ambiguous: '✗ not-sent',
    'post-read': '✗ not-sent',
    'post-read-failed': '✗ not-sent',
    'not-sent': '✗ not-firing',
    'preflight-failed': '✗ step-passed',
    'apply-fallback': 'resolved | fallback-applied',
  },
  firing: {
    arm: '✗ already-armed',
    disarm: 'killed',
    wake: '✗ step-passed',
    verified: '✗ step-passed',
    'verify-failed': '✗ step-passed',
    fire: '✗ already-fired',
    sent: 'sent (guards: dry-run, already-sent, invalid-event)',
    result: '✗ not-sent',
    ambiguous: '✗ not-sent',
    // Only a dry run's measure read. A live firing snipe has sent nothing, so the
    // read and a give-up are both refused. The give-up settles the dry run.
    'post-read': 'resolved (guards: not-sent, invalid-event)',
    'post-read-failed': 'resolved (guards: not-sent)',
    'not-sent': '✗ not-sent',
    'preflight-failed': '✗ step-passed',
    'apply-fallback': '✗ step-passed',
  },
  sent: {
    arm: '✗ already-sent',
    disarm: '✗ already-sent',
    wake: '✗ already-sent',
    verified: '✗ already-sent',
    'verify-failed': '✗ already-sent',
    fire: '✗ already-sent',
    sent: '✗ already-sent',
    result: 'sent | resolved (guards: dry-run, duplicate)',
    ambiguous: 'sent (guards: dry-run, duplicate)',
    'post-read': 'resolved (guards: invalid-event)',
    'post-read-failed': 'resolved (guards: dry-run)',
    'not-sent': 'resolved (guards: dry-run, duplicate)',
    'preflight-failed': '✗ already-sent',
    'apply-fallback': '✗ already-sent',
  },
  resolved: Object.fromEntries(EVENT_TYPES.map((t) => [t, '✗ terminal'])) as Record<EventType, string>,
  killed: Object.fromEntries(EVENT_TYPES.map((t) => [t, '✗ terminal'])) as Record<EventType, string>,
};

describe('R1: exhaustive transition table (state × event → next or a typed rejection)', () => {
  it('has a row for every SnipeState and a cell for every SnipeEvent type (generated from the zod unions)', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...STATES].sort());
    for (const state of STATES) expect(Object.keys(TRANSITIONS[state]).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it('matches the written spec cell by cell', () => {
    const rendered = Object.fromEntries(
      STATES.map((s) => [s, Object.fromEntries(EVENT_TYPES.map((t) => [t, cellText(TRANSITIONS[s][t])]))]),
    );
    expect(rendered).toEqual(EXPECTED);
  });

  it('is frozen: no importer can change the money path', () => {
    expect(Object.isFrozen(TRANSITIONS)).toBe(true);
    for (const state of STATES) {
      expect(Object.isFrozen(TRANSITIONS[state])).toBe(true);
      for (const type of EVENT_TYPES) {
        const cell = TRANSITIONS[state][type];
        expect(Object.isFrozen(cell)).toBe(true);
        if ('to' in cell) expect(Object.isFrozen(cell.to)).toBe(true);
      }
    }
  });

  it('terminal states reject every event', () => {
    for (const state of TERMINAL) {
      for (const type of EVENT_TYPES) expect(TRANSITIONS[state][type]).toEqual({ reject: 'terminal' });
    }
  });

  describe.each(STATES)('from %s', (state) => {
    it.each(EVENT_TYPES)('%s behaves as the table says', (type) => {
      const cell = TRANSITIONS[state][type];
      // A live firing snipe has nothing for a post-read to settle. The dry run's
      // measure read does, and so does giving up on that read.
      const dryMeasure = state === 'firing' && (type === 'post-read' || type === 'post-read-failed');
      const s = deepFreeze(dryMeasure ? inState(state, { dryRun: true }) : inState(state));
      const before = structuredClone(s);
      const r = reduce(s, CANON[type], CAPS_OK, CTX);
      if ('reject' in cell) {
        expect(r.rejection?.reason).toBe(cell.reject);
        expect(r.next).toBe(s);
        expect(r.effects).toEqual([]);
      } else {
        expect(r.rejection).toBeNull();
        expect(cell.to).toContain(r.next.state);
        expect(r.next.history).toHaveLength(s.history.length + 1);
        expect(r.next.history.at(-1)).toMatchObject({ at: CANON[type].now, from: state, to: r.next.state });
      }
      expect(s).toEqual(before);
    });
  });

  it('a rejection is typed, explains itself, and changes nothing', () => {
    const s = deepFreeze(inState('armed'));
    const r = reduce(s, E.fire(), CAPS_OK, CTX);
    expect(r).toEqual({
      next: s,
      effects: [],
      rejection: { reason: 'not-verified' satisfies RejectReason, detail: expect.any(String) as string },
    });
    expect(r.next).toBe(s);
  });
});

// ── The happy paths ─────────────────────────────────────────────────────────

describe('live path: draft → armed → waking → verified → firing → sent → resolved', () => {
  const steps = [
    E.arm(),
    E.wake(),
    E.verified(),
    E.fire(),
    E.sent('key-1'),
    E.result(bid('accepted', { isHighBidder: true })),
    E.postRead(closedDetail({ isHighBidder: true, currentPrice: 1500 })),
  ];

  it('walks every state once and places exactly one bid, for exactly maxBid', () => {
    const { results, last } = play(snipe(), steps);
    expect(results.map((r) => r.rejection)).toEqual(steps.map(() => null));
    expect(results.map((r) => r.next.state)).toEqual(['armed', 'waking', 'verified', 'firing', 'sent', 'sent', 'resolved']);
    expect(results.flatMap((r) => money(r.effects))).toEqual([{ kind: 'placeBid', snipeId: 's1', amount: 2000 }]);
    expect(last.history.map((h) => `${h.from}>${h.to}`)).toEqual([
      'draft>armed',
      'armed>waking',
      'waking>verified',
      'verified>firing',
      'firing>sent',
      'sent>sent',
      'sent>resolved',
    ]);
    expect(last.outcome).toBe('won');
  });

  it('arm schedules the wake 5 min before the planned fire and holds keep-awake', () => {
    const r = reduce(snipe(), E.arm(), CAPS_OK, CTX);
    expect(kinds(r.effects)).toEqual(['scheduleWake', 'holdKeepAwake', 'audit']);
    expect(r.effects[0]).toEqual({ kind: 'scheduleWake', snipeId: 's1', at: END_MS - 8000 - 5 * MIN });
    expect(r.effects[1]).toEqual({ kind: 'holdKeepAwake', snipeId: 's1', hold: true });
    expect(audits(r.effects)).toEqual(['snipe.arm']);
    expect(r.next).toMatchObject({ state: 'armed', armedAt: ARM_AT, fireAt: END_MS - 8000 });
  });

  it('wake samples the clock and asks for the T−60 verify read', () => {
    const r = reduce(inState('armed'), E.wake(), CAPS_OK, CTX);
    expect(r.effects.slice(0, 2)).toEqual([
      { kind: 'sampleClock', snipeId: 's1' },
      { kind: 'readDetail', snipeId: 's1', purpose: 'verify' },
    ]);
    expect(audits(r.effects)).toEqual(['snipe.wake']);
  });

  it('verified plans the fire in server time: end − lead − rtt/2 (T-81), and records offset and rtt', () => {
    const r = reduce(inState('waking'), E.verified(), CAPS_OK, CTX);
    expect(r.next.state).toBe('verified');
    expect(r.next.fireAt).toBe(FIRE_AT_SERVER);
    expect(r.next.measured).toEqual({ offsetMs: OFFSET, rttMs: RTT });
    expect(kinds(r.effects)).toEqual(['audit']);
  });

  it('verified adopts an earlier end from the read and plans the fire from it', () => {
    const earlier = END_MS - 30_000;
    const r = reduce(inState('waking'), E.verified(detail({ endTime: iso(earlier) })), CAPS_OK, CTX);
    expect(r.next.state).toBe('verified');
    expect(r.next.endTime).toBe(iso(earlier));
    expect(r.next.fireAt).toBe(earlier - 8000 - RTT / 2);
    expect(r.next.endTimeAtArm).toBe(END);
  });

  it('fire emits placeBid first (timing-critical), then the audit; firedAt is server time', () => {
    // The amount comes only from maxBid, never from the all-in max or the estimates.
    const r = reduce(inState('verified', { allInMax: 2600, estShipping: 500, estHandling: 100 }), E.fire(), CAPS_OK, CTX);
    expect(r.effects[0]).toEqual({ kind: 'placeBid', snipeId: 's1', amount: 2000 });
    expect(audits(r.effects)).toEqual(['bid.fire']);
    expect(r.next.measured?.firedAt).toBe(FIRE_LOCAL + OFFSET);
  });

  it('sent records the idempotency key and the send instant', () => {
    const r = reduce(inState('firing'), E.sent('key-1'), CAPS_OK, CTX);
    expect(r.next.state).toBe('sent');
    expect(r.next.attempt).toEqual({ idempotencyKey: 'key-1', sentAt: SENT_LOCAL + OFFSET });
    expect(audits(r.effects)).toEqual(['bid.sent']);
    expect(money(r.effects)).toEqual([]);
  });

  it('an accepted reply waits for the post-read, which settles it through classifyOutcome', () => {
    const { results, last } = play(snipe(), steps);
    const afterResult = results[5]?.next;
    expect(afterResult?.state).toBe('sent');
    expect(afterResult?.attempt.reply).toEqual(bid('accepted', { isHighBidder: true }));
    expect(results[5]?.effects.slice(0, 1)).toEqual([{ kind: 'readDetail', snipeId: 's1', purpose: 'post-read' }]);
    expect(audits(results[5]?.effects ?? [])).toEqual(['bid.result']);
    const final = results[6];
    if (afterResult === undefined || final === undefined) throw new Error('missing steps');
    const c = classifyOutcome(afterResult, bid('accepted', { isHighBidder: true }), closedDetail({ isHighBidder: true, currentPrice: 1500 }), { userTz: TZ });
    expect(last).toMatchObject({ state: 'resolved', outcome: c.outcome, outcomeDetail: c.detail });
    expect(kinds(final.effects)).toEqual(['notify', 'stampCalendar', 'audit', 'holdKeepAwake']);
    expect(final.effects[0]).toEqual(c.notify);
    expect(final.effects[1]).toEqual(c.stamp);
    expect(final.effects[3]).toEqual({ kind: 'holdKeepAwake', snipeId: 's1', hold: false });
  });
});

describe('dry run: the identical path, placeBid replaced by an audit and a measure read (C4)', () => {
  const steps = [E.arm(), E.wake(), E.verified(), E.fire(), E.postRead(detail({ observedAt: FIRE_LOCAL + 250 }), FIRE_LOCAL + 250)];

  it('walks the same states as a live snipe up to firing, then resolves as dry-run', () => {
    const live = play(snipe(), steps.slice(0, 4)).results.map((r) => r.next.state);
    const dry = play(snipe({ dryRun: true }), steps);
    expect(dry.results.map((r) => r.rejection)).toEqual(steps.map(() => null));
    expect(dry.results.slice(0, 4).map((r) => r.next.state)).toEqual(live);
    expect(dry.last.state).toBe('resolved');
    expect(dry.last.outcome).toBe('dry-run');
  });

  it('never emits placeBid; fire emits the measure read and a bid.dry-run audit with the amount', () => {
    const dry = play(snipe({ dryRun: true }), steps);
    expect(dry.results.flatMap((r) => money(r.effects))).toEqual([]);
    const fire = dry.results[3];
    expect(fire?.effects[0]).toEqual({ kind: 'readDetail', snipeId: 's1', purpose: 'measure' });
    const entry = ofKind(fire?.effects ?? [], 'audit')[0]?.entry;
    expect(entry).toMatchObject({ kind: 'bid.dry-run', dryRun: true, details: { amount: 2000 } });
  });

  it('records the measured timing: firedAt at fire, responseAt at the measure read', () => {
    const dry = play(snipe({ dryRun: true }), steps);
    expect(dry.last.measured).toMatchObject({
      offsetMs: OFFSET,
      rttMs: RTT,
      firedAt: FIRE_LOCAL + OFFSET,
      responseAt: FIRE_LOCAL + 250 + OFFSET,
    });
    expect(dry.last.outcomeDetail).toMatch(/would have bid \$20\.00/i);
    expect(dry.last.outcomeDetail).toContain('before the end');
  });

  it('a dry run can never be marked sent (nothing is ever sent)', () => {
    const s = inState('firing', { dryRun: true });
    expect(reduce(s, E.sent(), CAPS_OK, CTX).rejection?.reason).toBe('dry-run');
    expect(reduce(inState('fallback-applied', { dryRun: true }), E.sent(), CAPS_OK, CTX).rejection?.reason).toBe('dry-run');
  });

  it('a live firing snipe rejects a post-read: the bid has not been sent', () => {
    expect(reduce(inState('firing'), E.postRead(), CAPS_OK, CTX).rejection?.reason).toBe('not-sent');
  });
});

// ── R3: `sent` is terminal for sending ──────────────────────────────────────

describe('R3: sent is terminal for sending', () => {
  it('a second fire is rejected while firing and after sent', () => {
    const firing = deepFreeze(inState('firing'));
    expect(reduce(firing, E.fire(), CAPS_OK, CTX)).toMatchObject({ next: firing, effects: [], rejection: { reason: 'already-fired' } });
    const sent = deepFreeze(inState('sent'));
    expect(reduce(sent, E.fire(), CAPS_OK, CTX)).toMatchObject({ next: sent, effects: [], rejection: { reason: 'already-sent' } });
  });

  it('a second sent is rejected (the runner must not send again)', () => {
    const r = reduce(inState('sent'), E.sent('key-2'), CAPS_OK, CTX);
    expect(r.rejection?.reason).toBe('already-sent');
  });

  it('after a restart, a firing snipe that already holds a key cannot be marked sent again', () => {
    const s = inState('firing', { attempt: { idempotencyKey: 'k-old' } });
    expect(reduce(s, E.sent('k-new'), CAPS_OK, CTX).rejection?.reason).toBe('already-sent');
  });

  it('after sent, only result, ambiguous, post-read, post-read-failed and not-sent are accepted', () => {
    const accepted = EVENT_TYPES.filter((t) => reduce(inState('sent'), CANON[t], CAPS_OK, CTX).rejection === null);
    expect(accepted.sort()).toEqual(['ambiguous', 'not-sent', 'post-read', 'post-read-failed', 'result']);
    for (const by of ['user', 'kill', 'anomaly'] as const) {
      expect(reduce(inState('sent'), E.disarm(by), CAPS_OK, CTX).rejection?.reason).toBe('already-sent');
    }
  });

  it('nothing after sent emits a bid', () => {
    for (const type of EVENT_TYPES) {
      expect(money(reduce(inState('sent'), CANON[type], CAPS_OK, CTX).effects)).toEqual([]);
    }
  });

  it('a sent empty key is rejected: idempotency needs a real key', () => {
    expect(reduce(inState('firing'), E.sent('  '), CAPS_OK, CTX).rejection?.reason).toBe('invalid-event');
  });
});

// ── ambiguous → post-read → classifyOutcome (§3.9) ──────────────────────────

describe('ambiguous → post-read → won | outbid | network through classifyOutcome', () => {
  function afterAmbiguous(): Snipe {
    const r = reduce(inState('sent'), E.ambiguous(), CAPS_OK, CTX);
    expect(r.next.state).toBe('sent');
    expect(r.next.attempt.ambiguous).toBe(true);
    expect(r.effects[0]).toEqual({ kind: 'readDetail', snipeId: 's1', purpose: 'post-read' });
    expect(audits(r.effects)).toEqual(['bid.ambiguous']);
    return r.next;
  }

  it.each([
    ['won', closedDetail({ isHighBidder: true, currentPrice: 1500 })],
    ['outbid', closedDetail({ isHighBidder: false, currentPrice: 2100 })],
    ['network', closedDetail({ isHighBidder: null, currentPrice: 2000 })],
  ] as const)('%s', (expected, post) => {
    const s = afterAmbiguous();
    vi.mocked(classifyOutcome).mockClear();
    const r = reduce(s, E.postRead(post), CAPS_OK, CTX);
    expect(vi.mocked(classifyOutcome)).toHaveBeenCalledTimes(1);
    // An ambiguous send has no reply: the outcome is judged from the item.
    expect(vi.mocked(classifyOutcome).mock.calls[0]?.[1]).toBeNull();
    const c = classifyOutcome(s, null, post, { userTz: TZ });
    expect(c.outcome).toBe(expected);
    expect(r.next).toMatchObject({ state: 'resolved', outcome: expected, outcomeDetail: c.detail });
    expect(r.effects[0]).toEqual(c.notify);
    expect(c.notify.message).not.toMatch(/Not bid|No bid was placed/);
    expect(money(r.effects)).toEqual([]);
  });

  it('I2: one reply per attempt: an ambiguous or a second result after a result is a duplicate', () => {
    const replied = deepFreeze(reduce(inState('sent'), E.result(bid('accepted', { isHighBidder: true })), CAPS_OK, CTX).next);
    expect(reduce(replied, E.ambiguous(), CAPS_OK, CTX)).toMatchObject({ next: replied, effects: [], rejection: { reason: 'duplicate' } });
    expect(reduce(replied, E.result(bid('outbid')), CAPS_OK, CTX)).toMatchObject({ next: replied, effects: [], rejection: { reason: 'duplicate' } });
  });

  it('I2: a result after an ambiguous is refused: the ambiguity stays and nothing claims "Not bid"', () => {
    const s = deepFreeze(afterAmbiguous());
    for (const kind of BidResultKindSchema.options) {
      const r = reduce(s, E.result(bid(kind)), CAPS_OK, CTX);
      expect(r).toMatchObject({ next: s, effects: [], rejection: { reason: 'duplicate' } });
      expect(r.next.attempt.ambiguous).toBe(true);
    }
    const after = reduce(s, E.postRead(closedDetail({ isHighBidder: null, currentPrice: 2000 })), CAPS_OK, CTX);
    expect(after.next.outcomeDetail).not.toMatch(NO_BID_CLAIM);
    expect(ofKind(after.effects, 'notify')[0]?.message).not.toMatch(NO_BID_CLAIM);
  });

  it('a second ambiguous is a duplicate', () => {
    expect(reduce(afterAmbiguous(), E.ambiguous(), CAPS_OK, CTX).rejection?.reason).toBe('duplicate');
  });

  it('a post-read straight after sent (worker died before the reply) is judged from the item, never "Not bid"', () => {
    const r = reduce(inState('sent'), E.postRead(closedDetail({ isHighBidder: null, currentPrice: 2000 })), CAPS_OK, CTX);
    expect(r.next.outcome).toBe('network');
    expect(ofKind(r.effects, 'notify')[0]?.message).not.toMatch(/Not bid|No bid was placed/);
  });

  it('a post-read for another item is rejected', () => {
    expect(reduce(inState('sent'), E.postRead(closedDetail({ itemId: 1 })), CAPS_OK, CTX).rejection?.reason).toBe('invalid-event');
  });
});

// ── T-80b R1: post-read-failed settles a snipe the runner can never read ────

describe('R1: post-read-failed resolves a sent snipe whose outcome read gave up', () => {
  it('with no reply recorded: Unconfirmed, never "Not bid", no money effect', () => {
    const s = inState('sent');
    vi.mocked(classifyOutcome).mockClear();
    const r = reduce(s, E.postReadFailed(), CAPS_OK, CTX);
    expect(vi.mocked(classifyOutcome)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(classifyOutcome).mock.calls[0]?.[1]).toBeNull();
    expect(vi.mocked(classifyOutcome).mock.calls[0]?.[2]).toBeNull();
    expect(r.rejection).toBeNull();
    expect(r.next).toMatchObject({ state: 'resolved', outcome: 'network' });
    const message = ofKind(r.effects, 'notify')[0]?.message ?? '';
    expect(message).toMatch(/Unconfirmed/);
    expect(message).toContain('Check ShopGoodwill');
    expect(message).not.toMatch(NO_BID_CLAIM);
    // Nothing was read: no claim that the result "comes from re-reading the item".
    expect(message).toContain('the item could not be read');
    expect(message).not.toContain('re-reading');
    expect(money(r.effects)).toEqual([]);
    expect(ofKind(r.effects, 'readDetail')).toEqual([]);
    expect(kinds(r.effects)).toEqual(['notify', 'audit', 'holdKeepAwake']);
    expect(ofKind(r.effects, 'audit')[0]?.entry.kind).toBe('snipe.post-read-failed');
  });

  it('after ambiguous: judged with no reply, Unconfirmed, never "Not bid"', () => {
    const s = reduce(inState('sent'), E.ambiguous(), CAPS_OK, CTX).next;
    vi.mocked(classifyOutcome).mockClear();
    const r = reduce(s, E.postReadFailed(), CAPS_OK, CTX);
    expect(vi.mocked(classifyOutcome).mock.calls[0]?.[1]).toBeNull();
    expect(r.next).toMatchObject({ state: 'resolved', outcome: 'network' });
    expect(ofKind(r.effects, 'notify')[0]?.message).not.toMatch(NO_BID_CLAIM);
  });

  it('with a recorded reply: judged with the reply, never "Not bid"', () => {
    const reply = bid('rejected-unknown', { rawStatus: 200, rawResult: 7, messageText: 'odd' });
    const s = reduce(inState('sent'), E.result(reply), CAPS_OK, CTX).next;
    vi.mocked(classifyOutcome).mockClear();
    const r = reduce(s, E.postReadFailed(), CAPS_OK, CTX);
    expect(vi.mocked(classifyOutcome).mock.calls[0]?.[1]).toEqual(reply);
    expect(r.next).toMatchObject({ state: 'resolved', outcome: 'network' });
    expect(ofKind(r.effects, 'notify')[0]?.message).not.toMatch(NO_BID_CLAIM);
  });

  it('is terminal: nothing more is accepted', () => {
    const r = reduce(inState('sent'), E.postReadFailed(), CAPS_OK, CTX);
    expect(reduce(r.next, E.postRead(closedDetail()), CAPS_OK, CTX).rejection?.reason).toBe('terminal');
  });

  it('is refused outside sent with a typed reason', () => {
    // Live snipes. A dry run stuck in firing is the one exception, pinned below.
    for (const state of ['draft', 'armed', 'fallback-applied', 'waking', 'verified', 'firing'] as const) {
      expect(reduce(inState(state), E.postReadFailed(), CAPS_OK, CTX).rejection?.reason).toBe(
        state === 'draft' ? 'not-armed' : 'not-sent',
      );
    }
  });

  it('with a reply that proves the outcome, that outcome stands (not a blanket Unconfirmed)', () => {
    const reply = bid('outbid', { isHighBidder: false });
    const s = reduce(inState('sent'), E.result(reply), CAPS_OK, CTX).next;
    expect(s.state).toBe('sent');
    vi.mocked(classifyOutcome).mockClear();
    const r = reduce(s, E.postReadFailed(), CAPS_OK, CTX);
    expect(vi.mocked(classifyOutcome).mock.calls[0]?.[1]).toEqual(reply);
    expect(vi.mocked(classifyOutcome).mock.calls[0]?.[2]).toBeNull();
    expect(r.next.outcome).toBe('outbid');
    const message = ofKind(r.effects, 'notify')[0]?.message ?? '';
    expect(message).not.toMatch(/Unconfirmed/);
    expect(message).not.toMatch(NO_BID_CLAIM);
    expect(money(r.effects)).toEqual([]);
  });
});

describe('dry-run measure give-up: post-read-failed in firing', () => {
  const steps = [E.arm(), E.wake(), E.verified(), E.fire(), E.postReadFailed()];

  it('settles a dry run whose measure read never arrives: Unconfirmed, measure failed, no money', () => {
    const dry = play(snipe({ dryRun: true }), steps);
    expect(dry.results.map((r) => r.rejection)).toEqual([null, null, null, null, null]);
    expect(dry.last.state).toBe('resolved');
    expect(dry.last.outcome).toBe('dry-run');
    expect(dry.last.dryRun).toBe(true);
    expect(dry.last.measured?.responseAt).toBeUndefined();
    expect(dry.last.outcomeDetail).toContain('dry-run measure failed');
    expect(dry.last.outcomeDetail).toMatch(/unconfirmed/i);
    const notify = ofKind(dry.results[4]?.effects ?? [], 'notify')[0];
    // A dry-run title, never the live "Unconfirmed" one (a real bid may be out).
    expect(notify?.title).toMatch(/^Dry run:/);
    expect(notify?.message).toContain('dry-run measure failed');
    expect(notify?.message).not.toContain('may have been placed');
    expect(notify?.message ?? '').not.toMatch(NO_BID_CLAIM);
    expect(dry.results.flatMap((r) => money(r.effects))).toEqual([]);
    expect(ofKind(dry.results[4]?.effects ?? [], 'stampCalendar')).toEqual([]);
    expect(ofKind(dry.results[4]?.effects ?? [], 'audit')[0]?.entry.kind).toBe('snipe.post-read-failed');
    expect(spentToday([dry.last], POST_LOCAL, TZ)).toBe(0);
    expect(exposure([dry.last])).toEqual({ total: 0, shippingUnknown: false, count: 0 });
    for (const type of EVENT_TYPES) {
      const after = reduce(dry.last, CANON[type], CAPS_OK, CTX);
      expect(after.rejection?.reason).toBe('terminal');
      expect(money(after.effects)).toEqual([]);
    }
  });

  it('calls classifyOutcome with no reply, no item, and the dry-run measure-failed flag', () => {
    const s = inState('firing', { dryRun: true });
    vi.mocked(classifyOutcome).mockClear();
    const r = reduce(s, E.postReadFailed(), CAPS_OK, CTX);
    expect(r.rejection).toBeNull();
    const [arg, bidArg, postArg, ctx] = vi.mocked(classifyOutcome).mock.calls[0] ?? [];
    expect(arg?.dryRun).toBe(true);
    expect(arg?.state).toBe('firing');
    expect(bidArg).toBeNull();
    expect(postArg).toBeNull();
    expect(ctx).toMatchObject({ dryRunMeasureFailed: true });
    expect(ctx?.abort).toBeUndefined();
    expect(r.next.history.at(-1)?.why).toContain('dry-run measure');
    expect(kinds(r.effects)).toEqual(['notify', 'audit', 'holdKeepAwake']);
  });

  it('is refused for a live firing snipe: same object, no effects, still exposed', () => {
    const s = deepFreeze(inState('firing'));
    const before = exposure([s]);
    const r = reduce(s, E.postReadFailed(), CAPS_OK, CTX);
    expect(r).toMatchObject({ next: s, effects: [], rejection: { reason: 'not-sent' } });
    expect(r.next).toBe(s);
    expect(r.next.state).toBe('firing');
    expect(exposure([r.next])).toEqual(before);
    expect(before.count).toBe(1);
  });

  it('a live fire then a measure give-up does not settle and does not bid again', () => {
    const live = play(snipe(), steps);
    expect(live.results[3]?.rejection).toBeNull();
    expect(ofKind(live.results[3]?.effects ?? [], 'placeBid')).toHaveLength(1);
    expect(live.results[4]?.rejection?.reason).toBe('not-sent');
    expect(live.results[4]?.effects).toEqual([]);
    expect(live.last.state).toBe('firing');
    expect(live.last).toBe(live.results[3]?.next);
  });

  it('does not accept not-sent in firing for a dry run, and accepts post-read-failed in no other dry-run state', () => {
    const firing = deepFreeze(inState('firing', { dryRun: true }));
    expect(reduce(firing, E.notSent(), CAPS_OK, CTX)).toMatchObject({
      next: firing,
      effects: [],
      rejection: { reason: 'not-sent' },
    });
    for (const state of STATES) {
      if (state === 'firing') continue;
      const s = inState(state, { dryRun: true });
      const r = reduce(s, E.postReadFailed(), CAPS_OK, CTX);
      expect(r.rejection, state).not.toBeNull();
      expect(r.next).toBe(s);
      expect(r.effects).toEqual([]);
    }
  });
});

// ── T-80b R2: not-sent resolves a bid that provably never went out ───────────

describe('R2: not-sent proves the bid never went out', () => {
  it('resolves through classifyOutcome(abort network) with "No bid was sent (reason)" copy', () => {
    const s = inState('sent');
    vi.mocked(classifyOutcome).mockClear();
    const r = reduce(s, E.notSent('the bid modal could not be read'), CAPS_OK, CTX);
    expect(vi.mocked(classifyOutcome)).toHaveBeenCalledTimes(1);
    const [arg, bidArg, postArg, ctx] = vi.mocked(classifyOutcome).mock.calls[0] ?? [];
    expect(arg?.attempt.notSent).toBe(true);
    expect(bidArg).toBeNull();
    expect(postArg).toBeNull();
    expect(ctx).toMatchObject({ abort: 'network' });
    expect(r.rejection).toBeNull();
    expect(r.next).toMatchObject({ state: 'resolved', outcome: 'network', attempt: { notSent: true } });
    const message = ofKind(r.effects, 'notify')[0]?.message ?? '';
    expect(message).toMatch(/^No bid was sent/);
    expect(message).toContain('the bid modal could not be read');
    // It must not take the judge path: no "may have been placed" hedging.
    expect(message).not.toContain('Unconfirmed');
    expect(message).not.toContain('may have been placed');
    expect(money(r.effects)).toEqual([]);
    expect(kinds(r.effects)).toEqual(['notify', 'audit', 'holdKeepAwake']);
    expect(ofKind(r.effects, 'audit')[0]?.entry.kind).toBe('bid.not-sent');
  });

  it('records the proof on the attempt, so it survives a restart', () => {
    const r = reduce(inState('sent'), E.notSent('nothing was sent'), CAPS_OK, CTX);
    const persisted = SnipeSchema.parse(JSON.parse(JSON.stringify(r.next)));
    expect(persisted.attempt.notSent).toBe(true);
    expect(persisted.state).toBe('resolved');
  });

  it('is refused after a reply or an ambiguity (duplicate), and never claims "no bid" after ambiguous', () => {
    const replied = deepFreeze(reduce(inState('sent'), E.result(bid('accepted', { isHighBidder: true })), CAPS_OK, CTX).next);
    expect(reduce(replied, E.notSent(), CAPS_OK, CTX)).toMatchObject({
      next: replied,
      effects: [],
      rejection: { reason: 'duplicate' },
    });
    const ambiguous = deepFreeze(reduce(inState('sent'), E.ambiguous(), CAPS_OK, CTX).next);
    const refused = reduce(ambiguous, E.notSent(), CAPS_OK, CTX);
    expect(refused).toMatchObject({ next: ambiguous, effects: [], rejection: { reason: 'duplicate' } });
    expect(ambiguous.attempt.ambiguous).toBe(true);
    const after = reduce(ambiguous, E.postRead(closedDetail({ isHighBidder: null, currentPrice: 2000 })), CAPS_OK, CTX);
    expect(after.next.outcomeDetail).not.toMatch(NO_BID_CLAIM);
    expect(ofKind(after.effects, 'notify')[0]?.message).not.toMatch(NO_BID_CLAIM);
  });

  it('is refused for a dry-run snipe (and so is post-read-failed)', () => {
    expect(reduce(inState('sent', { dryRun: true }), E.notSent(), CAPS_OK, CTX).rejection?.reason).toBe('dry-run');
    expect(reduce(inState('sent', { dryRun: true }), E.postReadFailed(), CAPS_OK, CTX).rejection?.reason).toBe('dry-run');
  });

  it('is refused outside sent with a typed reason', () => {
    for (const state of ['draft', 'armed', 'fallback-applied', 'waking', 'verified', 'firing'] as const) {
      const reason = reduce(inState(state), E.notSent(), CAPS_OK, CTX).rejection?.reason;
      expect(reason).toBe(
        state === 'draft'
          ? 'not-armed'
          : state === 'firing' || state === 'fallback-applied'
            ? 'not-sent'
            : 'not-firing',
      );
    }
  });

  it('is terminal: the snipe leaves exposure (resolved) and never emits money after', () => {
    const r = reduce(inState('sent'), E.notSent(), CAPS_OK, CTX);
    expect(r.next.state).toBe('resolved');
    for (const type of EVENT_TYPES) {
      const after = reduce(r.next, CANON[type], CAPS_OK, CTX);
      expect(after.rejection?.reason).toBe('terminal');
      expect(money(after.effects)).toEqual([]);
    }
  });
});

describe('result: SGW replies', () => {
  it.each([
    ['closed', 'ended'],
    ['below-minimum', 'below-minimum'],
    ['auth', 'auth'],
    ['restricted', 'auth'],
  ] as const)('%s proves no bid registered: resolved now as %s, no post-read', (kind, outcome) => {
    const s = inState('sent');
    const r = reduce(s, E.result(bid(kind)), CAPS_OK, CTX);
    expect(r.next).toMatchObject({ state: 'resolved', outcome });
    expect(ofKind(r.effects, 'readDetail')).toEqual([]);
    expect(ofKind(r.effects, 'proposeRearm')).toEqual([]);
    expect(audits(r.effects)).toEqual(['bid.result']);
  });

  it('a closed reply to a bid fired after the end is late (a tool problem, not an outbid)', () => {
    const s = inState('sent', { measured: { offsetMs: OFFSET, rttMs: RTT, firedAt: END_MS + 2000 } });
    expect(reduce(s, E.result(bid('closed')), CAPS_OK, CTX).next.outcome).toBe('late');
  });

  it.each(['accepted', 'outbid', 'rejected-unknown'] as const)('%s may have registered: stay sent and post-read', (kind) => {
    const r = reduce(inState('sent'), E.result(bid(kind)), CAPS_OK, CTX);
    expect(r.next.state).toBe('sent');
    expect(r.next.attempt.reply).toEqual(bid(kind));
    expect(r.next.attempt.ambiguous).toBeUndefined();
    expect(r.next.measured?.responseAt).toBe(RESULT_LOCAL + OFFSET);
    expect(r.effects[0]).toEqual({ kind: 'readDetail', snipeId: 's1', purpose: 'post-read' });
  });

  it('the bid.result audit carries the raw codes and the reply text', () => {
    const r = reduce(inState('sent'), E.result(bid('rejected-unknown', { rawStatus: 200, rawResult: 7, messageText: 'odd' })), CAPS_OK, CTX);
    expect(ofKind(r.effects, 'audit')[0]?.entry.details).toMatchObject({ resultKind: 'rejected-unknown', rawStatus: 200, rawResult: 7, message: 'odd' });
  });

  it('rejected-unknown goes through the post-read judge with its reply, never "Not bid"', () => {
    const reply = bid('rejected-unknown', { rawStatus: 200, rawResult: 7, messageText: 'odd', isHighBidder: true });
    const s = reduce(inState('sent'), E.result(reply), CAPS_OK, CTX).next;
    const post = closedDetail({ isHighBidder: true, currentPrice: 1500 });
    vi.mocked(classifyOutcome).mockClear();
    const r = reduce(s, E.postRead(post), CAPS_OK, CTX);
    expect(vi.mocked(classifyOutcome).mock.calls[0]?.[1]).toEqual(reply);
    expect(r.next.outcome).toBe('won');
    const message = ofKind(r.effects, 'notify')[0]?.message ?? '';
    expect(message).toContain('not recognised');
    expect(message).not.toMatch(/Not bid|No bid was placed/);
  });

  it('contract change: after a restart (reduce from the persisted snipe), accepted + an anonymous post-read under max is Won', () => {
    const replied = reduce(inState('sent'), E.result(bid('accepted', { isHighBidder: null })), CAPS_OK, CTX).next;
    // The worker dies: the snipe goes through storage (zod strip mode) and comes back.
    const persisted = SnipeSchema.parse(JSON.parse(JSON.stringify(replied)));
    expect(persisted.attempt.reply).toEqual(bid('accepted', { isHighBidder: null }));
    const r = reduce(persisted, E.postRead(closedDetail({ isHighBidder: null, currentPrice: 1500 })), CAPS_OK, CTX);
    expect(r.next).toMatchObject({ state: 'resolved', outcome: 'won' });
    expect(ofKind(r.effects, 'notify')[0]?.message).not.toContain('Unconfirmed');
  });

  it('with no reply recorded (the worker died before it) the post-read is judged as an ambiguous send', () => {
    const r = reduce(inState('sent'), E.postRead(closedDetail({ isHighBidder: null, currentPrice: 1500 })), CAPS_OK, CTX);
    expect(vi.mocked(classifyOutcome).mock.calls.at(-1)?.[1]).toBeNull();
    expect(r.next.outcome).toBe('network');
  });

  it('a stored record with both a reply and the ambiguity (the reducer never writes one) is judged conservatively, as ambiguous', () => {
    const s = inState('sent', { attempt: { sentAt: FIRE_AT_SERVER + 5, idempotencyKey: 'k1', ambiguous: true, reply: bid('accepted') } });
    const r = reduce(s, E.postRead(closedDetail({ isHighBidder: null, currentPrice: 1500 })), CAPS_OK, CTX);
    expect(vi.mocked(classifyOutcome).mock.calls.at(-1)?.[1]).toBeNull();
    expect(r.next.outcome).toBe('network');
  });

  it('a decisive reply is recorded on the attempt and resolves at once', () => {
    const r = reduce(inState('sent'), E.result(bid('below-minimum')), CAPS_OK, CTX);
    expect(r.next).toMatchObject({ state: 'resolved', attempt: { reply: bid('below-minimum') } });
  });
});

// ── R4: extended → extended outcome + re-arm proposal, never auto-re-arm ────

describe('R4: verify-failed:extended → extended outcome and a re-arm proposal', () => {
  it.each([false, true])('dryRun %s: extended outcome, proposeRearm, no bid, no re-arm', (dryRun) => {
    const r = reduce(inState('waking', { dryRun }), E.verifyFailed('extended'), CAPS_OK, CTX);
    expect(r.next).toMatchObject({ state: 'resolved', outcome: 'extended' });
    expect(kinds(r.effects)).toEqual(['notify', 'proposeRearm', 'audit', 'holdKeepAwake']);
    expect(r.effects[1]).toEqual({ kind: 'proposeRearm', snipeId: 's1' });
    expect(money(r.effects)).toEqual([]);
    expect(ofKind(r.effects, 'scheduleWake')).toEqual([]);
    expect(ofKind(r.effects, 'notify')[0]?.message).toContain('No bid was placed');
    expect(vi.mocked(classifyOutcome).mock.calls[0]?.[3]).toMatchObject({ abort: 'extended' });
    // Never auto-re-arm: the snipe is terminal and an arm is refused.
    expect(reduce(r.next, E.arm(), CAPS_OK, CTX).rejection?.reason).toBe('terminal');
  });

  it('a verify read whose end moved later than planned takes the extended path', () => {
    const later = END_MS + 1; // ASSUME_EXTENSION_MS = 0: any later end
    const r = reduce(inState('waking'), E.verified(detail({ endTime: iso(later) })), CAPS_OK, CTX);
    expect(r.next).toMatchObject({ state: 'resolved', outcome: 'extended' });
    expect(ofKind(r.effects, 'proposeRearm')).toHaveLength(1);
    expect(money(r.effects)).toEqual([]);
    // The read goes to classifyOutcome, so the notice names the new end.
    expect(vi.mocked(classifyOutcome).mock.calls[0]?.[2]?.endTime).toBe(iso(later));
    expect(ofKind(r.effects, 'notify')[0]?.message).toContain('moved to');
  });

  it('an unchanged end is not an extension', () => {
    expect(reduce(inState('waking'), E.verified(detail({ endTime: END })), CAPS_OK, CTX).next.state).toBe('verified');
  });

  it('a post-read after the bid that shows a moved end resolves extended (classifyOutcome) and proposes a re-arm', () => {
    const post = detail({ endTime: iso(END_MS + 2 * MIN), serverTime: iso(END_MS + 10_000), isClosed: false });
    const r = reduce(inState('sent'), E.postRead(post), CAPS_OK, CTX);
    expect(r.next).toMatchObject({ state: 'resolved', outcome: 'extended' });
    expect(ofKind(r.effects, 'proposeRearm')).toEqual([{ kind: 'proposeRearm', snipeId: 's1' }]);
  });
});

// ── disarm ──────────────────────────────────────────────────────────────────

describe('disarm from any pre-sent state → killed', () => {
  for (const state of PRE_SENT) {
    for (const by of ['user', 'kill'] as const) {
      it(`${state}, by ${by}: killed, outcome killed, no bid`, () => {
        const r = reduce(inState(state), E.disarm(by), CAPS_OK, CTX);
        expect(r.next).toMatchObject({ state: 'killed', outcome: 'killed' });
        expect(money(r.effects)).toEqual([]);
        expect(kinds(r.effects)).toEqual(['notify', 'audit', 'holdKeepAwake']);
        expect(ofKind(r.effects, 'notify')[0]?.message).toContain('No bid was placed');
        expect(vi.mocked(fallbackDecision)).not.toHaveBeenCalled();
      });
    }
  }

  it('a killed early proxy can no longer be marked sent, so the runner never sends it', () => {
    const killed = reduce(inState('fallback-applied'), E.disarm('kill'), CAPS_OK, CTX).next;
    expect(reduce(killed, E.sent(), CAPS_OK, CTX).rejection?.reason).toBe('terminal');
  });

  it('I3: every disarm after sent is refused: the bid stays open and the post-read still settles it', () => {
    const s = deepFreeze(inState('sent'));
    for (const by of ['user', 'kill', 'anomaly'] as const) {
      expect(reduce(s, E.disarm(by), CAPS_OK, CTX)).toMatchObject({ next: s, effects: [], rejection: { reason: 'already-sent' } });
    }
    expect(reduce(s, E.postRead(closedDetail({ isHighBidder: true, currentPrice: 1500 })), CAPS_OK, CTX).next.outcome).toBe('won');
  });

  it('m1: fallback-applied refuses a disarm by anomaly (its fallback was already decided); user and kill still kill it', () => {
    const s = deepFreeze(inState('fallback-applied'));
    expect(reduce(s, E.disarm('anomaly'), CAPS_OK, CTX)).toMatchObject({ next: s, effects: [], rejection: { reason: 'fallback-applied' } });
    expect(vi.mocked(fallbackDecision)).not.toHaveBeenCalled();
    for (const by of ['user', 'kill'] as const) expect(reduce(s, E.disarm(by), CAPS_OK, CTX).next.state).toBe('killed');
  });
});

describe('C3: disarm(anomaly) applies the fallback, deciding BEFORE the kill transition', () => {
  for (const state of ['armed', 'waking', 'verified'] as const) {
    it(`${state}: fallbackDecision sees the pre-kill snipe; an early proxy keeps it open`, () => {
      const s = inState(state);
      const r = reduce(s, E.disarm('anomaly', 'clock drift'), CAPS_OK, CTX);
      expect(vi.mocked(fallbackDecision)).toHaveBeenCalledTimes(1);
      const [arg, input] = vi.mocked(fallbackDecision).mock.calls[0] ?? [];
      expect(arg?.state).toBe(state);
      expect(input).toEqual({
        reason: 'anomaly',
        detail: expect.stringContaining('clock drift') as string,
        caps: CAPS_OK,
        sessionUsable: true,
        writesAllowed: true,
      });
      expect(r.next).toMatchObject({ state: 'fallback-applied', outcome: 'fallback-proxy-placed' });
      expect(money(r.effects)).toEqual([{ kind: 'applyFallbackProxy', snipeId: 's1', amount: 2000 }]);
    });
  }

  it("with fallback 'skip' the snipe is killed with the fallback's outcome", () => {
    const r = reduce(inState('verified', { fallback: 'skip' }), E.disarm('anomaly'), CAPS_OK, CTX);
    expect(r.next).toMatchObject({ state: 'killed', outcome: 'skipped' });
    expect(money(r.effects)).toEqual([]);
  });

  it('after fire there is no fallback (a bid may be on its way)', () => {
    const r = reduce(inState('firing'), E.disarm('anomaly'), CAPS_OK, CTX);
    expect(r.next).toMatchObject({ state: 'killed', outcome: 'killed' });
    expect(money(r.effects)).toEqual([]);
  });
});

// ── C1: caps on the verified event, all other snipes, through CapsResult ────

describe('C1: caps through the precomputed CapsResult', () => {
  const limits = { ...DEFAULT_CAPS }; // $50 item / $100 day / $200 exposure

  it('capsForEvent runs checkCaps with the verified detail, the time zone and ALL other snipes', () => {
    const self = inState('waking');
    const committed = snipe({ id: 's2', state: 'verified', maxBid: 9000 }); // same local day, in flight
    const ok = capsForEvent(self, E.verified(), { limits, snipes: [self], timeZone: TZ });
    expect(ok).toEqual({ ok: true, violations: [] });
    const day = capsForEvent(self, E.verified(), { limits, snipes: [self, committed], timeZone: TZ });
    expect(day.ok).toBe(false);
    expect(day.violations.map((v) => v.split(':')[0])).toEqual(['per-day']);
    // The event's own detail is the one checked: a next bid above the per-item cap.
    const item = capsForEvent(self, E.verified(detail({ minimumBid: 6000 })), { limits, snipes: [self], timeZone: TZ });
    expect(item.violations.map((v) => v.split(':')[0])).toEqual(['per-item']);
  });

  it("capsForEvent judges the per-day cap in the caller's time zone", () => {
    const self = inState('waking'); // ends Oct 9 19:42 ET = Oct 10 08:42 in Tokyo
    const other = snipe({ id: 's2', state: 'verified', maxBid: 9000, endTime: '2026-10-10T05:00:00.000Z' }); // Oct 10 01:00 ET, 14:00 Tokyo
    expect(capsForEvent(self, E.verified(), { limits, snipes: [self, other], timeZone: TZ }).ok).toBe(true);
    const tokyo = capsForEvent(self, E.verified(), { limits, snipes: [self, other], timeZone: 'Asia/Tokyo' });
    expect(tokyo.violations.map((v) => v.split(':')[0])).toEqual(['per-day']);
  });

  it('capsForEvent counts what was spent today from the other snipes', () => {
    const self = inState('waking');
    const won = snipe({ id: 's3', state: 'resolved', outcome: 'won', maxBid: 9000, history: [{ at: VERIFY_AT - HOUR, from: 'sent', to: 'resolved', why: 'won' }] });
    const r = capsForEvent(self, E.verified(), { limits, snipes: [self, won], timeZone: TZ });
    expect(r.violations.map((v) => v.split(':')[0])).toEqual(['per-day']);
  });

  it('without an ItemDetail (no verified event, none supplied) the check fails closed', () => {
    const r = capsForEvent(inState('verified'), E.fire(), { limits, snipes: [], timeZone: TZ });
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toMatch(/^per-item/);
    const withDetail = capsForEvent(inState('verified'), E.fire(), { limits, snipes: [], timeZone: TZ, detail: detail() });
    expect(withDetail.ok).toBe(true);
  });

  it('verified with a failing CapsResult never fires: cap-blocked through classifyOutcome, no fallback', () => {
    const r = reduce(inState('waking'), E.verified(), CAPS_BAD, CTX);
    expect(r.next).toMatchObject({ state: 'resolved', outcome: 'cap-blocked' });
    expect(money(r.effects)).toEqual([]);
    expect(vi.mocked(fallbackDecision)).not.toHaveBeenCalled();
    expect(vi.mocked(classifyOutcome).mock.calls[0]?.[3]).toMatchObject({ abort: 'cap' });
    expect(ofKind(r.effects, 'audit').at(-1)?.entry.details).toMatchObject({ violations: CAPS_BAD.violations.join('; ') });
    expect(reduce(r.next, E.fire(), CAPS_OK, CTX).rejection?.reason).toBe('terminal');
  });

  it('fire with a failing CapsResult places no bid: cap-blocked, no fallback', () => {
    const r = reduce(inState('verified'), E.fire(), CAPS_BAD, CTX);
    expect(r.next).toMatchObject({ state: 'resolved', outcome: 'cap-blocked' });
    expect(money(r.effects)).toEqual([]);
    expect(vi.mocked(fallbackDecision)).not.toHaveBeenCalled();
  });

  it('arm with a failing CapsResult is rejected', () => {
    const s = deepFreeze(snipe());
    expect(reduce(s, E.arm(), CAPS_BAD, CTX)).toMatchObject({ next: s, effects: [], rejection: { reason: 'caps' } });
  });

  it.each([
    ['a zero max', { maxBid: 0 }],
    ['a fractional max', { maxBid: 12.5 }],
    ['a lead outside 3–30 s', { leadMs: 1000 }],
    ['an ended auction', { endTime: iso(ARM_AT - 1) }],
    ['an auction ending right now', { endTime: iso(ARM_AT) }],
    ['a recorded send', { attempt: { sentAt: ARM_AT - 5 } }],
  ])('arm rejects %s as invalid-snipe', (_label, over) => {
    expect(reduce(snipe(over), E.arm(), CAPS_OK, CTX).rejection?.reason).toBe('invalid-snipe');
  });
});

// ── C2, fallbacks and verify failures ───────────────────────────────────────

describe('verify failures and fallbacks (fallbackDecision, I-18)', () => {
  it("C2: verify-failed:auth passes reason 'auth' with the session unusable", () => {
    const r = reduce(inState('waking'), E.verifyFailed('auth'), CAPS_OK, CTX);
    expect(vi.mocked(fallbackDecision).mock.calls[0]?.[1]).toMatchObject({ reason: 'auth', sessionUsable: false });
    expect(r.next).toMatchObject({ state: 'resolved', outcome: 'skipped' });
    expect(money(r.effects)).toEqual([]);
  });

  it("C2: any fallback with an unusable session is reason 'auth'", () => {
    reduce(inState('armed'), E.preflightFailed('clock'), CAPS_OK, { ...CTX, sessionUsable: false });
    expect(vi.mocked(fallbackDecision).mock.calls[0]?.[1]).toMatchObject({ reason: 'auth', sessionUsable: false });
  });

  it.each(['network', 'clock'] as const)('verify-failed:%s applies the fallback', (reason) => {
    const r = reduce(inState('waking'), E.verifyFailed(reason), CAPS_OK, CTX);
    expect(vi.mocked(fallbackDecision).mock.calls[0]?.[1]).toMatchObject({ reason });
    expect(r.next.state).toBe('fallback-applied');
    expect(money(r.effects)).toEqual([{ kind: 'applyFallbackProxy', snipeId: 's1', amount: 2000 }]);
    expect(audits(r.effects)).toEqual(['snipe.fallback', 'snipe.verify-failed']);
    expect(kinds(r.effects)).toContain('notify');
  });

  describe('I1: a cap failure never triggers the fallback (cap-blocked through classifyOutcome)', () => {
    const probes: Array<[string, SnipeState, SnipeEvent]> = [
      ['verify-failed:cap', 'waking', E.verifyFailed('cap')],
      ['verify-failed:cap after verified', 'verified', E.verifyFailed('cap')],
      ['preflight-failed:cap', 'armed', E.preflightFailed('cap')],
    ];
    for (const [label, state, e] of probes) {
      for (const [capsLabel, caps] of [['passing', CAPS_OK], ['failing', CAPS_BAD]] as const) {
        it(`${label} with ${capsLabel} caps: no money effect, cap-blocked`, () => {
          const r = reduce(inState(state), e, caps, CTX);
          expect(money(r.effects)).toEqual([]);
          expect(r.next).toMatchObject({ state: 'resolved', outcome: 'cap-blocked' });
          expect(vi.mocked(fallbackDecision)).not.toHaveBeenCalled();
          expect(vi.mocked(classifyOutcome).mock.calls[0]?.[3]).toMatchObject({ abort: 'cap' });
        });
      }
    }
  });

  it('verify-failed:ended resolves through classifyOutcome (abort ended), no fallback', () => {
    const r = reduce(inState('waking'), E.verifyFailed('ended'), CAPS_OK, CTX);
    expect(r.next).toMatchObject({ state: 'resolved', outcome: 'ended' });
    expect(vi.mocked(classifyOutcome).mock.calls[0]?.[3]).toMatchObject({ abort: 'ended' });
    expect(vi.mocked(fallbackDecision)).not.toHaveBeenCalled();
    expect(money(r.effects)).toEqual([]);
  });

  it.each([
    ['price-over-max', 'price'],
    ['already-high', 'already-high'],
  ] as const)('verify-failed:%s: nothing to win, classifyOutcome abort %s, skipped, no fallback', (reason, abort) => {
    const r = reduce(inState('verified'), E.verifyFailed(reason), CAPS_OK, CTX);
    expect(r.next).toMatchObject({ state: 'resolved', outcome: 'skipped' });
    expect(vi.mocked(fallbackDecision)).not.toHaveBeenCalled();
    expect(vi.mocked(classifyOutcome).mock.calls[0]?.[3]).toMatchObject({ abort });
    expect(money(r.effects)).toEqual([]);
    expect(ofKind(r.effects, 'notify')[0]?.message).toContain('No bid was placed');
  });

  it('a verify read showing the auction closed resolves as ended', () => {
    const r = reduce(inState('waking'), E.verified(detail({ isClosed: true })), CAPS_OK, CTX);
    expect(r.next).toMatchObject({ state: 'resolved', outcome: 'ended' });
  });

  it('a verify read with an unusable clock (rtt > 2 s) applies the fallback', () => {
    const r = reduce(inState('waking'), E.verified(detail(), OFFSET, 2500), CAPS_OK, CTX);
    expect(vi.mocked(fallbackDecision).mock.calls[0]?.[1]).toMatchObject({ reason: 'clock' });
    expect(r.next.state).toBe('fallback-applied');
  });

  it('a verify read for another item is rejected', () => {
    expect(reduce(inState('waking'), E.verified(detail({ itemId: 1 })), CAPS_OK, CTX).rejection?.reason).toBe('invalid-event');
  });

  it.each([
    ['ended', 'resolved', 'ended'],
    ['price', 'resolved', 'skipped'],
    ['auth', 'resolved', 'skipped'],
    ['clock', 'fallback-applied', 'fallback-proxy-placed'],
    ['keep-awake', 'fallback-applied', 'fallback-proxy-placed'],
    ['cap', 'resolved', 'cap-blocked'],
  ] as const)('preflight-failed:%s → %s (%s)', (reason, state, outcome) => {
    const r = reduce(inState('armed'), E.preflightFailed(reason), CAPS_OK, CTX);
    expect(r.next).toMatchObject({ state, outcome });
  });

  it('preflight-failed with an unknown reason is rejected', () => {
    expect(reduce(inState('armed'), E.preflightFailed('gremlins'), CAPS_OK, CTX).rejection?.reason).toBe('invalid-event');
  });

  it("apply-fallback can only downgrade: mode 'early-proxy' never overrides the user's 'skip'", () => {
    const up = reduce(inState('armed', { fallback: 'skip' }), E.applyFallback('early-proxy'), CAPS_OK, CTX);
    expect(up.next).toMatchObject({ state: 'resolved', outcome: 'skipped', fallback: 'skip' });
    expect(money(up.effects)).toEqual([]);
    const down = reduce(inState('armed'), E.applyFallback('skip'), CAPS_OK, CTX);
    expect(down.next).toMatchObject({ state: 'resolved', outcome: 'skipped', fallback: 'early-proxy' });
    expect(money(down.effects)).toEqual([]);
    const same = reduce(inState('armed'), E.applyFallback('early-proxy'), CAPS_OK, CTX);
    expect(money(same.effects)).toEqual([{ kind: 'applyFallbackProxy', snipeId: 's1', amount: 2000 }]);
  });

  it('without a context the fallback fails closed: no early proxy', () => {
    const r = reduce(inState('waking'), E.verifyFailed('network'), CAPS_OK);
    expect(r.next.state).toBe('resolved');
    expect(money(r.effects)).toEqual([]);
  });
});

describe('C4: a dry-run fallback rehearses the live decision', () => {
  it('with writesAllowed (dry-run condition ignored) the audit says it would have placed an early proxy', () => {
    const r = reduce(inState('waking', { dryRun: true }), E.verifyFailed('network'), CAPS_OK, CTX);
    expect(r.next).toMatchObject({ state: 'resolved', outcome: 'dry-run' });
    expect(r.next.outcomeDetail).toContain('would have placed');
    expect(money(r.effects)).toEqual([]);
    const fb = ofKind(r.effects, 'audit').find((a) => a.entry.kind === 'snipe.fallback');
    expect(fb?.entry.details).toMatchObject({ applied: 'early-proxy', writesAllowed: true });
  });

  it('passing the raw gate (false in a dry run) would show skipped instead', () => {
    const r = reduce(inState('waking', { dryRun: true }), E.verifyFailed('network'), CAPS_OK, { ...CTX, writesAllowed: false });
    expect(r.next.outcome).toBe('skipped');
    expect(money(r.effects)).toEqual([]);
  });
});

describe('C5: the early proxy is sent like a normal bid', () => {
  it('fallback-applied → sent → result → post-read; one money effect, amount only from maxBid', () => {
    const start = inState('armed', { maxBid: 2000, allInMax: 2600, estShipping: 500, estHandling: 100 });
    const { results, last } = play(start, [
      E.preflightFailed('clock'),
      E.sent('proxy-key'),
      E.result(bid('accepted', { isHighBidder: true })),
      E.postRead(closedDetail({ isHighBidder: true, currentPrice: 1500 })),
    ]);
    expect(results.map((r) => r.next.state)).toEqual(['fallback-applied', 'sent', 'sent', 'resolved']);
    expect(results.flatMap((r) => money(r.effects))).toEqual([{ kind: 'applyFallbackProxy', snipeId: 's1', amount: 2000 }]);
    expect(results[1]?.next.attempt).toEqual({ idempotencyKey: 'proxy-key', sentAt: SENT_LOCAL });
    expect(last.outcome).toBe('won');
  });

  it('an early proxy and a snipe bid never both go out: fire is rejected once the fallback is applied', () => {
    const s = reduce(inState('verified'), E.applyFallback('early-proxy'), CAPS_OK, CTX).next;
    expect(s.state).toBe('fallback-applied');
    expect(reduce(s, E.fire(), CAPS_OK, CTX).rejection?.reason).toBe('fallback-applied');
  });
});

// ── m2: fire timing bounds (event time, server-corrected) ──────────────────

describe('m2: fire is refused more than 2 s early, and resolves missed at or after the end', () => {
  // inState('verified'): fireAt = FIRE_AT_SERVER (server time), offset OFFSET (server − local).
  const atServer = (serverMs: number): SnipeEvent => E.fire(serverMs - OFFSET);

  it('2001 ms before fireAt: refused too-early, nothing changes', () => {
    const s = deepFreeze(inState('verified'));
    expect(reduce(s, atServer(FIRE_AT_SERVER - 2001), CAPS_OK, CTX)).toMatchObject({
      next: s,
      effects: [],
      rejection: { reason: 'too-early' },
    });
  });

  it('exactly 2000 ms before fireAt: fires', () => {
    const r = reduce(inState('verified'), atServer(FIRE_AT_SERVER - 2000), CAPS_OK, CTX);
    expect(r.next.state).toBe('firing');
    expect(money(r.effects)).toEqual([{ kind: 'placeBid', snipeId: 's1', amount: 2000 }]);
  });

  it('1 ms before the end: still fires', () => {
    const r = reduce(inState('verified'), atServer(END_MS - 1), CAPS_OK, CTX);
    expect(r.next.state).toBe('firing');
    expect(money(r.effects)).toHaveLength(1);
  });

  it.each([0, 1, 60_000])('%i ms after the end: no bid, resolved through classifyOutcome abort missed', (after) => {
    const r = reduce(inState('verified'), atServer(END_MS + after), CAPS_OK, CTX);
    expect(money(r.effects)).toEqual([]);
    expect(r.next).toMatchObject({ state: 'resolved', outcome: 'skipped' });
    expect(vi.mocked(classifyOutcome).mock.calls[0]?.[3]).toMatchObject({ abort: 'missed' });
    expect(ofKind(r.effects, 'notify')[0]?.message).toContain('No bid was placed');
  });

  it('a dry run takes the same path: missed, with no measure read', () => {
    const r = reduce(inState('verified', { dryRun: true }), atServer(END_MS), CAPS_OK, CTX);
    expect(r.next).toMatchObject({ state: 'resolved', outcome: 'skipped' });
    expect(vi.mocked(classifyOutcome).mock.calls[0]?.[3]).toMatchObject({ abort: 'missed' });
    expect(ofKind(r.effects, 'readDetail')).toEqual([]);
  });

  it('uses the end the verify read set, not the armed one', () => {
    const earlier = END_MS - 30_000;
    const s = reduce(inState('waking'), E.verified(detail({ endTime: iso(earlier) })), CAPS_OK, CTX).next;
    vi.mocked(classifyOutcome).mockClear();
    expect(money(reduce(s, atServer(earlier), CAPS_OK, CTX).effects)).toEqual([]);
    expect(vi.mocked(classifyOutcome).mock.calls[0]?.[3]).toMatchObject({ abort: 'missed' });
  });
});

// ── R5: purity ──────────────────────────────────────────────────────────────

describe('R5: pure', () => {
  const path: SnipeEvent[] = [E.arm(), E.wake(), E.verified(), E.fire(), E.sent(), E.ambiguous(), E.postRead()];

  it('reads no clock and no randomness', () => {
    vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('Date.now called');
    });
    vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Math.random called');
    });
    expect(() => play(snipe(), path)).not.toThrow();
    expect(() => play(snipe({ dryRun: true }), [E.arm(), E.wake(), E.verified(), E.fire(), E.postRead()])).not.toThrow();
  });

  it('never mutates its inputs and gives equal outputs for equal inputs', () => {
    let s = deepFreeze(snipe());
    for (const e of path) {
      const frozenEvent = deepFreeze(structuredClone(e));
      const a = reduce(s, frozenEvent, deepFreeze({ ...CAPS_OK }), deepFreeze({ ...CTX }));
      const b = reduce(s, frozenEvent, CAPS_OK, CTX);
      expect(a).toEqual(b);
      s = deepFreeze(a.next);
    }
  });

  it('the source reads no clock, no randomness and does no I/O', () => {
    const src = readFileSync(new URL('../../../../src/domain/snipe/state-machine.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/Date\.now|new Date\(\)|Math\.random|performance\.now|\bfetch\(/);
    const imports = [...src.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    for (const spec of imports) expect(spec).toMatch(/^\.\.?\//);
  });
});

// ── R2: money properties (fast-check) ──────────────────────────────────────

type Body = SnipeEvent extends infer T ? (T extends SnipeEvent ? Omit<T, 'now'> : never) : never;

const arbDetail: fc.Arbitrary<ItemDetail> = fc
  .record({
    closed: fc.boolean(),
    endShift: fc.constantFrom(-30_000, 0, 0, 0, 1, 90_000),
    high: fc.constantFrom(true, false, null),
    price: fc.integer({ min: 0, max: 6000 }),
    minimumBid: fc.integer({ min: 0, max: 6000 }),
    wrongItem: fc.integer({ min: 0, max: 9 }).map((n) => n === 0),
  })
  .map(({ closed, endShift, high, price, minimumBid, wrongItem }) =>
    detail({
      itemId: wrongItem ? 1 : ITEM,
      endTime: iso(END_MS + endShift),
      isClosed: closed,
      serverTime: iso(closed ? END_MS + 10_000 : VERIFY_AT),
      isHighBidder: high,
      currentPrice: price,
      minimumBid,
    }),
  );

const arbResult: fc.Arbitrary<BidResult> = fc
  .record({
    kind: fc.constantFrom(...BidResultKindSchema.options),
    high: fc.constantFrom(true, false, null),
    rawResult: fc.option(fc.integer({ min: -200, max: 10 }), { nil: null }),
  })
  .map(({ kind, high, rawResult }) => bid(kind, { isHighBidder: high, rawResult }));

const arbBody: fc.Arbitrary<Body> = fc.oneof(
  fc.constant({ type: 'arm' as const }),
  fc.record({ type: fc.constant('disarm' as const), by: fc.constantFrom('user' as const, 'kill' as const, 'anomaly' as const), why: fc.constant('prop') }),
  fc.constant({ type: 'wake' as const }),
  fc.record({
    type: fc.constant('verified' as const),
    detail: arbDetail,
    offsetMs: fc.constantFrom(OFFSET, -400, 400_000),
    rttMs: fc.constantFrom(RTT, 2500),
  }),
  fc.record({ type: fc.constant('verify-failed' as const), reason: fc.constantFrom(...SnipeEventReasons()) }),
  fc.constant({ type: 'fire' as const }),
  fc.record({ type: fc.constant('sent' as const), key: fc.constantFrom('k1', 'k2', ' ') }),
  fc.record({ type: fc.constant('result' as const), result: arbResult }),
  fc.constant({ type: 'ambiguous' as const }),
  fc.record({ type: fc.constant('post-read' as const), detail: arbDetail }),
  fc.constant({ type: 'post-read-failed' as const }),
  fc.record({ type: fc.constant('not-sent' as const), reason: fc.constantFrom('the bid modal could not be read', 'the write gate refused') }),
  fc.record({
    type: fc.constant('preflight-failed' as const),
    reason: fc.constantFrom('ended', 'price', 'auth', 'clock', 'keep-awake', 'cap', 'bogus'),
  }),
  fc.record({ type: fc.constant('apply-fallback' as const), mode: fc.constantFrom('early-proxy' as const, 'skip' as const) }),
);

function SnipeEventReasons(): Array<Extract<SnipeEvent, { type: 'verify-failed' }>['reason']> {
  return ['ended', 'extended', 'price-over-max', 'already-high', 'auth', 'network', 'clock', 'cap'];
}

interface PropStep {
  guided: boolean;
  body: Body;
  capsOk: boolean;
  sessionUsable: boolean;
  writesAllowed: boolean;
  jitterMs: number;
}

const arbStep: fc.Arbitrary<PropStep> = fc.record({
  guided: fc.integer({ min: 0, max: 9 }).map((n) => n < 6),
  body: arbBody,
  capsOk: fc.integer({ min: 0, max: 9 }).map((n) => n < 8),
  sessionUsable: fc.boolean(),
  writesAllowed: fc.boolean(),
  jitterMs: fc.integer({ min: -3000, max: 3000 }),
});

/** When a runner would send each event (local clock), so the fire-time bounds are exercised. */
const WHEN: Record<EventType, number> = {
  arm: ARM_AT,
  disarm: VERIFY_AT,
  wake: WAKE_AT,
  verified: VERIFY_AT,
  'verify-failed': VERIFY_AT,
  fire: FIRE_LOCAL,
  sent: SENT_LOCAL,
  result: RESULT_LOCAL,
  ambiguous: RESULT_LOCAL,
  'post-read': POST_LOCAL,
  'post-read-failed': POST_LOCAL,
  'not-sent': RESULT_LOCAL,
  'preflight-failed': PREFLIGHT_AT,
  'apply-fallback': VERIFY_AT,
};

/** The event a runner would most likely send next, so random runs reach the deep states. */
function guidedBody(s: Snipe, step: PropStep): Body {
  switch (s.state) {
    case 'draft':
      return { type: 'arm' };
    case 'armed':
      return step.body.type === 'preflight-failed' ? step.body : { type: 'wake' };
    case 'waking':
      return step.body.type === 'verified' ? step.body : { type: 'verified', detail: detail(), offsetMs: OFFSET, rttMs: RTT };
    case 'verified':
      return { type: 'fire' };
    case 'firing':
      if (s.dryRun) {
        return step.body.type === 'post-read-failed' ? { type: 'post-read-failed' } : { type: 'post-read', detail: detail() };
      }
      return { type: 'sent', key: 'k1' };
    case 'fallback-applied':
      return { type: 'sent', key: 'k1' };
    case 'sent':
      return step.body.type === 'result' ||
        step.body.type === 'ambiguous' ||
        step.body.type === 'post-read' ||
        step.body.type === 'post-read-failed' ||
        step.body.type === 'not-sent'
        ? step.body
        : { type: 'post-read', detail: closedDetail() };
    case 'resolved':
    case 'killed':
      return step.body;
  }
}

interface Trace {
  steps: Array<{ before: Snipe; e: SnipeEvent; caps: CapsResult; ctx: ReduceContext; r: ReduceResult }>;
}

function runProp(start: Snipe, steps: readonly PropStep[]): Trace {
  const trace: Trace = { steps: [] };
  let s = start;
  steps.forEach((step) => {
    const body = step.guided ? guidedBody(s, step) : step.body;
    const e: SnipeEvent = { ...body, now: WHEN[body.type] + step.jitterMs };
    const caps = step.capsOk ? CAPS_OK : CAPS_BAD;
    const ctx: ReduceContext = { timeZone: TZ, sessionUsable: step.sessionUsable, writesAllowed: step.writesAllowed };
    const r = reduce(s, e, caps, ctx);
    trace.steps.push({ before: s, e, caps, ctx, r });
    s = r.next;
  });
  return trace;
}

const arbDraft: fc.Arbitrary<Snipe> = fc
  .record({
    dryRun: fc.boolean(),
    fallback: fc.constantFrom('early-proxy' as const, 'skip' as const),
    maxBid: fc.integer({ min: 1, max: 9000 }),
  })
  .map((over) => snipe(over));

const arbAnyState: fc.Arbitrary<Snipe> = fc
  .record({
    state: fc.constantFrom(...STATES),
    dryRun: fc.boolean(),
    fallback: fc.constantFrom('early-proxy' as const, 'skip' as const),
    maxBid: fc.integer({ min: 1, max: 9000 }),
    keyed: fc.boolean(),
  })
  .map(({ state, keyed, ...over }) =>
    inState(state, { ...over, ...(keyed && state !== 'draft' ? { attempt: { idempotencyKey: 'k0', sentAt: FIRE_AT_SERVER } } : {}) }),
  );

// m3: at least 2,000 runs of 40 to 60 events in the normal suite;
// SBW_LONG_PROPS=1 runs 10,000 (the T-80 report gives the command).
const LONG = (process.env.SBW_LONG_PROPS ?? '') !== '';
const PROP_RUNS = LONG ? 10_000 : 2_000;
const SIDE_RUNS = LONG ? 2_000 : 300;
/** Per-test timeout for the property tests (each takes about 1 s in the normal suite). */
const PROP_TIMEOUT_MS = LONG ? 600_000 : 30_000;
const arbSteps = fc.array(arbStep, { minLength: 40, maxLength: 60 });

function allEffects(t: Trace): Effect[] {
  return t.steps.flatMap((x) => x.r.effects);
}

describe('R2: money properties', { timeout: PROP_TIMEOUT_MS }, () => {
  it('the generated runs are not vacuous: they reach every state and both money effects', () => {
    const reached = new Set<string>();
    const samples = fc.sample(fc.tuple(arbDraft, arbSteps), { numRuns: PROP_RUNS, seed: 80 });
    for (const [start, steps] of samples) {
      for (const { r } of runProp(start, steps).steps) {
        reached.add(r.next.state);
        for (const x of r.effects) reached.add(x.kind);
        if (r.rejection !== null) reached.add(`rejected:${r.rejection.reason}`);
      }
    }
    for (const state of STATES) expect(reached).toContain(state);
    for (const kind of ['placeBid', 'applyFallbackProxy', 'proposeRearm', 'stampCalendar']) expect(reached).toContain(kind);
    for (const reason of ['terminal', 'already-sent', 'already-fired', 'dry-run', 'caps', 'invalid-event', 'too-early', 'duplicate']) {
      expect(reached).toContain(`rejected:${reason}`);
    }
  });

  it('no path produces two placeBid effects (early proxy included: at most one money effect)', () => {
    fc.assert(
      fc.property(arbDraft, arbSteps, (start, steps) => {
        const effects = allEffects(runProp(start, steps));
        expect(ofKind(effects, 'placeBid').length).toBeLessThanOrEqual(1);
        expect(ofKind(effects, 'applyFallbackProxy').length).toBeLessThanOrEqual(1);
      }),
      { numRuns: PROP_RUNS },
    );
  });

  it('placeBid and applyFallbackProxy are never both emitted for one snipe', () => {
    fc.assert(
      fc.property(fc.oneof(arbDraft, arbAnyState), arbSteps, (start, steps) => {
        expect(money(allEffects(runProp(start, steps))).length).toBeLessThanOrEqual(1);
      }),
      { numRuns: PROP_RUNS },
    );
  });

  it('placeBid (and the early proxy) is never emitted in a dry run', () => {
    fc.assert(
      fc.property(fc.oneof(arbDraft, arbAnyState), arbSteps, (start, steps) => {
        const dry = { ...start, dryRun: true };
        expect(money(allEffects(runProp(dry, steps)))).toEqual([]);
      }),
      { numRuns: PROP_RUNS },
    );
  });

  it('I2: after an ambiguous, no outcome text claims that no bid was placed', () => {
    fc.assert(
      fc.property(fc.oneof(arbDraft, arbAnyState), arbSteps, (start, steps) => {
        let ambiguous = false;
        for (const { e, r } of runProp(start, steps).steps) {
          if (ambiguous) {
            expect(r.next.outcomeDetail ?? '').not.toMatch(NO_BID_CLAIM);
            for (const n of ofKind(r.effects, 'notify')) expect(n.message).not.toMatch(NO_BID_CLAIM);
          }
          if (e.type === 'ambiguous' && r.rejection === null) ambiguous = true;
        }
      }),
      { numRuns: PROP_RUNS },
    );
  });

  it('no effect is emitted after a terminal state; terminal snipes never change', () => {
    fc.assert(
      fc.property(fc.oneof(arbDraft, arbAnyState), arbSteps, (start, steps) => {
        for (const { before, r } of runProp(start, steps).steps) {
          if (!TERMINAL.includes(before.state)) continue;
          expect(r.effects).toEqual([]);
          expect(r.next).toBe(before);
          expect(r.rejection?.reason).toBe('terminal');
        }
      }),
      { numRuns: PROP_RUNS },
    );
  });

  it('every money effect is for exactly Snipe.maxBid, and placeBid only on fire from verified with passing caps', () => {
    fc.assert(
      fc.property(fc.oneof(arbDraft, arbAnyState), arbSteps, (start, steps) => {
        for (const { before, e, caps, r } of runProp(start, steps).steps) {
          for (const m of money(r.effects)) expect(m).toMatchObject({ snipeId: before.id, amount: before.maxBid });
          if (ofKind(r.effects, 'placeBid').length > 0) {
            expect(e.type).toBe('fire');
            expect(before.state).toBe('verified');
            expect(caps.ok).toBe(true);
            expect(before.dryRun).toBe(false);
            expect(r.next.state).toBe('firing');
            // m2: never more than 2 s early, never at or after the end (server time).
            const serverNow = e.now + (before.measured?.offsetMs ?? 0);
            expect(serverNow).toBeGreaterThanOrEqual((before.fireAt ?? Number.NaN) - 2000);
            expect(serverNow).toBeLessThan(new Date(before.endTime).getTime());
          }
          if (ofKind(r.effects, 'applyFallbackProxy').length > 0) {
            expect(['armed', 'waking', 'verified']).toContain(before.state);
            expect(before.dryRun).toBe(false);
            expect(caps.ok).toBe(true);
            expect(r.next.state).toBe('fallback-applied');
          }
        }
      }),
      { numRuns: PROP_RUNS },
    );
  });
});

describe('R1 and R5 as properties', { timeout: PROP_TIMEOUT_MS }, () => {
  it('every step follows the table; a rejection never mutates and emits nothing; history grows by one per accepted event', () => {
    fc.assert(
      fc.property(fc.oneof(arbDraft, arbAnyState), arbSteps, (start, steps) => {
        for (const { before, e, r } of runProp(start, steps).steps) {
          const cell = TRANSITIONS[before.state][e.type];
          if (r.rejection !== null) {
            const allowed = 'reject' in cell ? [cell.reject] : (cell.guards ?? []);
            expect(allowed).toContain(r.rejection.reason);
            expect(r.next).toBe(before);
            expect(r.effects).toEqual([]);
          } else {
            expect('to' in cell && cell.to.includes(r.next.state)).toBe(true);
            expect(r.next.history).toHaveLength(before.history.length + 1);
            expect(r.next.history.at(-1)).toMatchObject({ at: e.now, from: before.state, to: r.next.state });
            expect(r.next.history.slice(0, -1)).toEqual(before.history);
            expect(r.next.id).toBe(before.id);
            expect(r.next.maxBid).toBe(before.maxBid);
          }
        }
      }),
      { numRuns: PROP_RUNS },
    );
  });

  it('every next snipe is a valid stored record and every effect a valid contract Effect', () => {
    fc.assert(
      fc.property(fc.oneof(arbDraft, arbAnyState), arbSteps, (start, steps) => {
        for (const { r } of runProp(start, steps).steps) {
          expect(SnipeSchema.safeParse(r.next).error).toBeUndefined();
          for (const x of r.effects) expect(EffectSchema.safeParse(x).error).toBeUndefined();
        }
      }),
      { numRuns: SIDE_RUNS },
    );
  });

  it('is deterministic: the same run twice gives equal results', () => {
    fc.assert(
      fc.property(fc.oneof(arbDraft, arbAnyState), arbSteps, (start, steps) => {
        const a = runProp(start, steps).steps.map((x) => x.r);
        const b = runProp(start, steps).steps.map((x) => x.r);
        expect(a).toEqual(b);
      }),
      { numRuns: SIDE_RUNS },
    );
  });
});
