// T-112: the bid-group rules (src/domain/snipe/groups.ts), pure.
//
// The money rule under test: a group cancels its other snipes ONLY on proof,
// a CONFIRMED win (T-87's classifyOutcome on a read after the end: outcome
// `won` and `final: true`; for a dry run, "would have won" at the close).
// Leading, Unconfirmed, ambiguous, an unreadable item and a contradicting read
// never confirm. Plus: ends at least 2 min apart (arm time), the edit freeze
// from T-2 min before the next end, one mode per group, and the cancel targets.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  armProblem,
  cancelTargets,
  confirmAt,
  confirmedWins,
  confirmLane,
  SNIPE_LANE_GUARD_FIRST_MS,
  SNIPE_LANE_GUARD_RETRY_MS,
  snipeLaneFree,
  deleteProblem,
  editProblem,
  frozenBy,
  GROUP_CONFIRM_FAST_ATTEMPTS,
  GROUP_CONFIRM_OFFSETS_MS,
  GROUP_CONFIRM_AFTER_END_MS,
  GROUP_EDIT_FREEZE_MS,
  GROUP_MIN_SPACING_MS,
  groupView,
  judgeWin,
  memberEnded,
  nextResult,
  type WinJudgement,
} from '../../../../src/domain/snipe/groups';
import { classifyOutcome } from '../../../../src/domain/snipe/outcome';
import { SnipeOutcomeSchema, type Snipe } from '../../../../src/domain/snipe/types';
import type { SnipeGroup, SnipeGroupResult } from '../../../../src/domain/storage/schema';
import { BidResultKindSchema, type BidResult, type ItemDetail } from '../../../../src/domain/types';

const SEC = 1000;
const MIN = 60 * SEC;
const TZ = 'America/New_York';
const END = '2026-10-08T02:18:30.000Z';
const END_MS = Date.parse(END);
const iso = (ms: number): string => new Date(ms).toISOString();

function bid(kind: BidResult['kind'], over: Partial<BidResult> = {}): BidResult {
  return { kind, rawStatus: 200, rawResult: 0, messageText: 'Bid placed', isHighBidder: null, observedAt: END_MS - 7800, ...over };
}

/** A live member, sent and settled by the outcome read as `won` (the reducer's own classification). */
function wonLive(over: Partial<Snipe> = {}): Snipe {
  return {
    id: 'a',
    itemId: 101,
    title: 'Lamp A',
    endTime: END,
    endTimeAtArm: END,
    sellerId: 9,
    maxBid: 2000,
    leadMs: 8000,
    fallback: 'skip',
    dryRun: false,
    state: 'resolved',
    outcome: 'won',
    outcomeDetail: 'Won; reported by SGW.',
    armedAt: END_MS - 3_600_000,
    fireAt: END_MS - 8000,
    attempt: { sentAt: END_MS - 8000, idempotencyKey: 'a:k', reply: bid('accepted', { isHighBidder: true }) },
    measured: { firedAt: END_MS - 8000, responseAt: END_MS - 7800, rttMs: 200, offsetMs: 1300 },
    groupId: 'g1',
    history: [{ at: END_MS + 5 * SEC, from: 'sent', to: 'resolved', why: 'post-read' }],
    ...over,
  };
}

/** A dry-run member that fired (the measure read resolved it as 'dry-run' before the end). */
function firedDryRun(over: Partial<Snipe> = {}): Snipe {
  return {
    ...wonLive(),
    dryRun: true,
    outcome: 'dry-run',
    outcomeDetail: 'Would have bid $20.00.',
    attempt: {},
    history: [{ at: END_MS - 7800, from: 'firing', to: 'resolved', why: 'post-read: dry run measured' }],
    ...over,
  };
}

/** An open member of g1 ending at `endMs`. */
function open(id: string, endMs: number, over: Partial<Snipe> = {}): Snipe {
  return {
    id,
    itemId: 200 + id.charCodeAt(0),
    title: `Lamp ${id.toUpperCase()}`,
    endTime: iso(endMs),
    endTimeAtArm: iso(endMs),
    maxBid: 1500,
    leadMs: 8000,
    fallback: 'skip',
    dryRun: false,
    state: 'armed',
    armedAt: END_MS - 3_600_000,
    attempt: {},
    groupId: 'g1',
    history: [{ at: END_MS - 3_600_000, from: 'draft', to: 'armed', why: 'arm' }],
    ...over,
  };
}

/** The read after the end: closed, authenticated (isHighBidder known). */
function post(over: Partial<ItemDetail> = {}): ItemDetail {
  return {
    itemId: 101,
    title: 'Lamp A',
    currentPrice: 1700,
    startingMinimumBid: 100,
    numBids: 4,
    endTime: END,
    endTimeRaw: '2026-10-07T19:18:30',
    sellerId: 9,
    pickupOnly: false,
    source: 'api',
    observedAt: END_MS + 6 * SEC,
    minimumBid: 1800,
    bidIncrement: 100,
    serverTime: iso(END_MS + 6 * SEC),
    serverTimeRaw: '2026-10-07T19:18:36',
    isClosed: true,
    isHighBidder: true,
    inWatchlist: null,
    bidHistory: [],
    ...over,
  };
}

function group(over: Partial<SnipeGroup> = {}): SnipeGroup {
  return { id: 'g1', name: 'Lamps', maxWins: 1, createdAt: END_MS - DAY, updatedAt: END_MS - DAY, results: {}, cancels: {}, ...over };
}
const DAY = 24 * 60 * MIN;

function result(verdict: SnipeGroupResult['verdict'], over: Partial<SnipeGroupResult> = {}): SnipeGroupResult {
  return { verdict, dryRun: false, at: END_MS + 6 * SEC, attempts: 1, why: 'x', ...over };
}

const confirmed = (j: WinJudgement): boolean => j.verdict === 'confirmed';

// ── Cancel only on proof ────────────────────────────────────────────────────

describe('judgeWin: only a confirmed win (T-87: won AND final) counts', () => {
  it('confirms a live win: the read after the end is closed and shows you as the high bidder', () => {
    const j = judgeWin(wonLive(), post(), TZ);
    expect(j).toMatchObject({ verdict: 'confirmed', finalPrice: 1700 });
  });

  it('Leading is NOT a win: the auction was still open when read (final: false)', () => {
    const j = judgeWin(wonLive(), post({ isClosed: false, serverTime: iso(END_MS - 1000) }), TZ);
    expect(confirmed(j)).toBe(false);
    expect(j).toMatchObject({ verdict: 'unconfirmed', retry: true });
  });

  it('a stored win whose read shows the auction extended and open is not a win yet (retried)', () => {
    const later = END_MS + 10 * MIN;
    const j = judgeWin(wonLive(), post({ isClosed: false, endTime: iso(later), serverTime: iso(END_MS + 6 * SEC) }), TZ);
    expect(j).toEqual({ verdict: 'unconfirmed', why: 'the auction was extended and is still open', retry: true });
  });

  it('an unreadable item never confirms (and is retried)', () => {
    expect(judgeWin(wonLive(), null, TZ)).toMatchObject({ verdict: 'unconfirmed', retry: true });
  });

  it('a read of another item never confirms', () => {
    expect(confirmed(judgeWin(wonLive(), post({ itemId: 999 }), TZ))).toBe(false);
  });

  it('ambiguous send (no reply) with an anonymous read: "could not tell whether you lead", never a win', () => {
    const s = wonLive({ attempt: { sentAt: END_MS - 8000, idempotencyKey: 'a:k', ambiguous: true } });
    const j = judgeWin(s, post({ isHighBidder: null, currentPrice: 1700 }), TZ);
    expect(confirmed(j)).toBe(false);
    expect(j.verdict).toBe('unconfirmed');
  });

  it('the stored outcome Unconfirmed (network, a bid may be out) never confirms, whatever a read says', () => {
    const s = wonLive({ outcome: 'network', outcomeDetail: 'could not tell whether you lead.' });
    const j = judgeWin(s, post(), TZ);
    expect(j).toMatchObject({ verdict: 'unconfirmed', retry: false });
  });

  it('an extended auction with a bid out never confirms (the bid may still win later)', () => {
    const s = wonLive({ outcome: 'extended' });
    expect(judgeWin(s, post(), TZ)).toMatchObject({ verdict: 'unconfirmed' });
  });

  it('a stale "high bidder" flag from the bid reply never confirms when the closing price is above your max', () => {
    // Anonymous read: T-87 falls back to the reply's flag. A price above the max proves the bid was beaten.
    const j = judgeWin(wonLive(), post({ isHighBidder: null, currentPrice: 2100 }), TZ);
    expect(confirmed(j)).toBe(false);
    expect(j.verdict).toBe('unconfirmed');
  });

  it('a closed read showing someone else as the high bidder contradicts the stored win: unconfirmed, never a win', () => {
    const j = judgeWin(wonLive(), post({ isHighBidder: false, currentPrice: 2100 }), TZ);
    expect(j).toMatchObject({ verdict: 'unconfirmed', retry: false });
  });

  it('lost, outbid or never sent is not a win (and needs no read)', () => {
    expect(judgeWin(wonLive({ outcome: 'outbid' }), post(), TZ).verdict).toBe('not-won');
    expect(judgeWin(wonLive({ outcome: 'below-minimum' }), post(), TZ).verdict).toBe('not-won');
    expect(judgeWin(wonLive({ state: 'killed', outcome: 'killed', attempt: {} }), post(), TZ).verdict).toBe('not-won');
    const notSent = wonLive({ outcome: 'network', attempt: { sentAt: END_MS - 8000, idempotencyKey: 'a:k', notSent: true } });
    expect(judgeWin(notSent, post(), TZ).verdict).toBe('not-won');
  });

  it('a member that has not finished is never judged a win', () => {
    expect(confirmed(judgeWin(wonLive({ state: 'sent', outcome: undefined }), post(), TZ))).toBe(false);
  });

  describe('dry run: "would have won" at the close (T-87 dry-run classification on a read after the end)', () => {
    it('confirms when the auction closed below your max', () => {
      const j = judgeWin(firedDryRun(), post({ isHighBidder: null, currentPrice: 1700 }), TZ);
      expect(j).toMatchObject({ verdict: 'confirmed', finalPrice: 1700 });
    });

    it('does not confirm while the auction is still open (extended): unconfirmed, retried', () => {
      const later = END_MS + 10 * MIN;
      const j = judgeWin(firedDryRun(), post({ isClosed: false, endTime: iso(later), serverTime: iso(END_MS + 6 * SEC) }), TZ);
      expect(j).toMatchObject({ verdict: 'unconfirmed', retry: true });
    });

    it('closing at or above your max is not a win', () => {
      expect(judgeWin(firedDryRun(), post({ isHighBidder: null, currentPrice: 2000 }), TZ).verdict).toBe('not-won');
    });

    it('a dry run stopped before it would have bid is not a win', () => {
      expect(judgeWin(firedDryRun({ outcome: 'skipped' }), post(), TZ).verdict).toBe('not-won');
    });
  });
});

describe('memberEnded: what the group does when a member finishes', () => {
  it('a live win is checked at once (the runner read it after the end already)', () => {
    expect(memberEnded(wonLive(), END_MS + 6 * SEC, 1300)).toEqual({ kind: 'confirm', at: END_MS + 6 * SEC });
  });

  it('a dry run resolves before the end: its check waits until 5 s after the end (local clock)', () => {
    const at = memberEnded(firedDryRun(), END_MS - 7 * SEC, 0);
    // endLocal = end - measured offset (1300 ms).
    expect(at).toEqual({ kind: 'confirm', at: END_MS - 1300 + GROUP_CONFIRM_AFTER_END_MS });
    expect(confirmAt(firedDryRun({ measured: undefined }), END_MS - 7 * SEC, 500)).toBe(END_MS - 500 + GROUP_CONFIRM_AFTER_END_MS);
  });

  it('Unconfirmed / extended with a bid out: unconfirmed at once (no read can make the group sure)', () => {
    expect(memberEnded(wonLive({ outcome: 'network' }), END_MS, 0).kind).toBe('unconfirmed');
    expect(memberEnded(wonLive({ outcome: 'extended' }), END_MS, 0).kind).toBe('unconfirmed');
  });

  it('a loss, a stop or a never-sent bid is not a win', () => {
    expect(memberEnded(wonLive({ outcome: 'outbid' }), END_MS, 0).kind).toBe('not-won');
    expect(memberEnded(open('b', END_MS, { state: 'killed', outcome: 'killed' }), END_MS, 0).kind).toBe('not-won');
  });

  it('an open member has not ended', () => {
    expect(memberEnded(open('b', END_MS), END_MS, 0).kind).toBe('pending');
  });
});

describe('nextResult: the bounded retries of the confirming read', () => {
  const checking = (attempts: number): SnipeGroupResult => ({ verdict: 'checking', dryRun: false, at: END_MS, attempts, nextAt: END_MS, why: 'checking' });

  it('a retryable miss schedules the next attempt from the first one', () => {
    const r = nextResult(checking(0), { verdict: 'unconfirmed', why: 'the item could not be read', retry: true }, END_MS + 1000);
    expect(r).toMatchObject({ verdict: 'checking', attempts: 1, nextAt: END_MS + (GROUP_CONFIRM_OFFSETS_MS[1] ?? 0), at: END_MS });
  });

  it('after the last attempt the verdict is unconfirmed (the group keeps going)', () => {
    const last = GROUP_CONFIRM_OFFSETS_MS.length - 1;
    const r = nextResult(checking(last), { verdict: 'unconfirmed', why: 'still open', retry: true }, END_MS + DAY);
    expect(r).toMatchObject({ verdict: 'unconfirmed', attempts: last + 1 });
    expect(r.nextAt).toBeUndefined();
  });

  it('a confirmed win or a loss ends the checks', () => {
    expect(nextResult(checking(0), { verdict: 'confirmed', why: 'won', finalPrice: 1700 }, END_MS + 6 * SEC)).toMatchObject({
      verdict: 'confirmed',
      finalPrice: 1700,
      attempts: 1,
    });
    expect(nextResult(checking(2), { verdict: 'not-won', why: 'outbid' }, END_MS).verdict).toBe('not-won');
  });

  it('the fast attempts all fall within 2 minutes of the first (before a member 2 min later fires)', () => {
    expect(GROUP_CONFIRM_OFFSETS_MS[GROUP_CONFIRM_FAST_ATTEMPTS - 1]).toBeLessThan(GROUP_MIN_SPACING_MS - 8 * SEC);
  });

  it('reads on the snipe lane (its bearer) when free; else the interactive lane, then the background lane', () => {
    for (let i = 0; i < GROUP_CONFIRM_OFFSETS_MS.length; i++) expect(confirmLane(i, true)).toBe('snipe');
    for (let i = 0; i < GROUP_CONFIRM_FAST_ATTEMPTS; i++) expect(confirmLane(i, false)).toBe('interactive');
    for (let i = GROUP_CONFIRM_FAST_ATTEMPTS; i < GROUP_CONFIRM_OFFSETS_MS.length; i++) expect(confirmLane(i, false)).toBe('background');
  });
});

describe('snipeLaneFree: a group read must never make another snipe wait out a backoff it caused', () => {
  // The read happens 5 s after A's end (local clock); offsets are measured (1300 ms) or 0.
  const now = END_MS - 1300 + 5 * SEC;

  it('the next member 2 min later (verify 55 s after the read) leaves the first read free', () => {
    const b = open('b', END_MS + GROUP_MIN_SPACING_MS, { state: 'waking', measured: { offsetMs: 1300 } });
    expect(snipeLaneFree('a', [wonLive(), b], now, 1300, SNIPE_LANE_GUARD_FIRST_MS)).toBe(true);
    // ...but not a retry: its verify, fire and outcome read are within 10 min.
    expect(snipeLaneFree('a', [wonLive(), b], now, 1300, SNIPE_LANE_GUARD_RETRY_MS)).toBe(false);
  });

  it('any snipe (in a group or not) whose verify, fire or first outcome read falls within the guard blocks it', () => {
    const verifySoon = open('x', END_MS + 90 * SEC, { groupId: undefined, state: 'waking' });
    expect(snipeLaneFree('a', [verifySoon], now, 1300, SNIPE_LANE_GUARD_FIRST_MS)).toBe(false);
    const outcomeReadSoon = open('y', END_MS + 20 * SEC, { groupId: undefined, state: 'sent', attempt: { sentAt: END_MS } });
    expect(snipeLaneFree('a', [outcomeReadSoon], now, 1300, SNIPE_LANE_GUARD_FIRST_MS)).toBe(false);
    expect(snipeLaneFree('a', [open('z', END_MS + 5 * MIN, { state: 'firing' })], now, 1300, SNIPE_LANE_GUARD_FIRST_MS)).toBe(false);
    expect(snipeLaneFree('a', [open('w', END_MS + 5 * MIN, { state: 'fallback-applied' })], now, 1300, SNIPE_LANE_GUARD_FIRST_MS)).toBe(false);
  });

  it('far-away, finished or past-their-first-read snipes do not block it', () => {
    const far = open('f', END_MS + 40 * MIN);
    const sentLongAgo = open('s', END_MS - 10 * MIN, { state: 'sent', attempt: { sentAt: END_MS - 10 * MIN } });
    const done = open('d', END_MS + 60 * SEC, { state: 'resolved', outcome: 'outbid' });
    expect(snipeLaneFree('a', [far, sentLongAgo, done], now, 1300, SNIPE_LANE_GUARD_RETRY_MS)).toBe(true);
  });
});

// ── Cancellation ────────────────────────────────────────────────────────────

describe('confirmedWins and cancelTargets', () => {
  const b = open('b', END_MS + 5 * MIN);
  const c = open('c', END_MS + 10 * MIN, { state: 'sent', attempt: { sentAt: END_MS + 10 * MIN - 8000 } });

  it('nothing is cancelled before N confirmed wins', () => {
    const g = group({ maxWins: 2, results: { a: result('confirmed') } });
    expect(confirmedWins(g, false)).toBe(1);
    expect(cancelTargets(g, [wonLive(), b, c])).toEqual([]);
  });

  it('an unconfirmed, checking or lost member never counts as a win', () => {
    const g = group({ results: { a: result('unconfirmed'), x: result('checking'), y: result('not-won') } });
    expect(confirmedWins(g, false)).toBe(0);
    expect(cancelTargets(g, [wonLive(), b, c])).toEqual([]);
  });

  it('N confirmed wins: every open member is a target, the sent one too (the runner decides; it will refuse)', () => {
    const g = group({ results: { a: result('confirmed') } });
    expect(cancelTargets(g, [wonLive(), b, c]).map((s) => s.id)).toEqual(['b', 'c']);
  });

  it('a member already cancelled (or refused) is not asked again', () => {
    const g = group({ results: { a: result('confirmed') }, cancels: { b: { at: END_MS, ok: true, why: 'x' }, c: { at: END_MS, ok: false, why: 'sent' } } });
    expect(cancelTargets(g, [wonLive(), b, c])).toEqual([]);
  });

  it('a dry-run win never cancels a live snipe, and a live win never a dry-run one', () => {
    const dry = group({ results: { a: result('confirmed', { dryRun: true }) } });
    expect(confirmedWins(dry, false)).toBe(0);
    expect(confirmedWins(dry, true)).toBe(1);
    expect(cancelTargets(dry, [b])).toEqual([]);
    expect(cancelTargets(dry, [open('d', END_MS + 5 * MIN, { dryRun: true })]).map((s) => s.id)).toEqual(['d']);
  });
});

// ── Arm time: spacing, mode, N reached, freeze ──────────────────────────────

describe('armProblem', () => {
  const now = END_MS - 60 * MIN;
  const base = { groupId: 'g1', now, userTz: TZ, reserved: [] as Snipe[] };
  const draft = (endMs: number, over: Partial<Snipe> = {}): Snipe => ({ ...open('n', endMs), state: 'draft', ...over });

  it('accepts an item that ends at least 2 min from every other member', () => {
    const members = [open('b', END_MS)];
    expect(armProblem({ ...base, group: group(), draft: draft(END_MS + GROUP_MIN_SPACING_MS), members })).toBeNull();
    expect(armProblem({ ...base, group: group(), draft: draft(END_MS - GROUP_MIN_SPACING_MS), members })).toBeNull();
  });

  it('refuses an item ending less than 2 min from another member, with a clear message', () => {
    const members = [open('b', END_MS)];
    const p = armProblem({ ...base, group: group(), draft: draft(END_MS + 70 * SEC), members });
    expect(p).toMatch(/at least 2 minutes apart/);
    expect(p).toContain('Lamp B');
    expect(p).toContain('1 min 10 s');
  });

  it('spacing also counts arms still in progress (reserved) but not stopped members or the same item', () => {
    const p = armProblem({ ...base, group: group(), draft: draft(END_MS + 30 * SEC), members: [], reserved: [open('r', END_MS)] });
    expect(p).toMatch(/at least 2 minutes apart/);
    const killed = open('b', END_MS, { state: 'killed', outcome: 'killed' });
    expect(armProblem({ ...base, group: group(), draft: draft(END_MS + 30 * SEC), members: [killed] })).toBeNull();
    const sameItem = open('b', END_MS, { state: 'resolved', outcome: 'extended', itemId: 777 });
    expect(armProblem({ ...base, group: group(), draft: draft(END_MS + 30 * SEC, { itemId: 777 }), members: [sameItem] })).toBeNull();
  });

  it('refuses an unknown group', () => {
    expect(armProblem({ ...base, group: undefined, draft: draft(END_MS), members: [] })).toMatch(/does not exist/);
  });

  it('refuses mixing dry-run and live snipes in one group', () => {
    const members = [open('b', END_MS, { dryRun: true })];
    expect(armProblem({ ...base, group: group(), draft: draft(END_MS + 10 * MIN), members })).toMatch(/dry run/i);
  });

  it('refuses a group that already won N', () => {
    const g = group({ results: { a: result('confirmed') } });
    expect(armProblem({ ...base, group: g, draft: draft(END_MS + 10 * MIN), members: [wonLive()] })).toMatch(/already won 1 of 1/);
  });

  it('refuses while the group is frozen (2 min before its next end)', () => {
    const members = [open('b', END_MS)];
    const p = armProblem({ ...base, now: END_MS - GROUP_EDIT_FREEZE_MS, group: group(), draft: draft(END_MS + 10 * MIN), members });
    expect(p).toMatch(/frozen/);
  });
});

describe('edit freeze', () => {
  it('starts 2 min before the next end of an open member', () => {
    const b = open('b', END_MS);
    expect(frozenBy(group(), [b], END_MS - GROUP_EDIT_FREEZE_MS - 1)).toBeNull();
    expect(frozenBy(group(), [b], END_MS - GROUP_EDIT_FREEZE_MS)?.id).toBe('b');
  });

  it('lasts until the ended member is settled: open past its end, or its win still being checked', () => {
    const sent = open('b', END_MS, { state: 'sent', attempt: { sentAt: END_MS - 8000 } });
    expect(frozenBy(group(), [sent], END_MS + 10 * MIN)?.id).toBe('b');
    // Resolved as won but not judged yet, then checking: still frozen.
    expect(frozenBy(group(), [wonLive()], END_MS + 10 * SEC)?.id).toBe('a');
    expect(frozenBy(group({ results: { a: result('checking') } }), [wonLive()], END_MS + 10 * SEC)?.id).toBe('a');
    // Settled (confirmed, unconfirmed, not won): no longer frozen.
    expect(frozenBy(group({ results: { a: result('unconfirmed') } }), [wonLive()], END_MS + 10 * SEC)).toBeNull();
  });

  it('a dry run that fired is still unsettled until its check after the end', () => {
    expect(frozenBy(group(), [firedDryRun()], END_MS - 7 * SEC)?.id).toBe('a');
  });

  it('editProblem and deleteProblem refuse while frozen; delete also while snipes are open', () => {
    const b = open('b', END_MS);
    expect(editProblem(group(), [b], END_MS - MIN, TZ)).toMatch(/frozen/);
    expect(editProblem(group(), [b], END_MS - 10 * MIN, TZ)).toBeNull();
    expect(deleteProblem(group(), [b], END_MS - 10 * MIN, TZ)).toMatch(/open snipe/);
    expect(deleteProblem(group(), [], END_MS - 10 * MIN, TZ)).toBeNull();
  });
});

// ── The UI's view ───────────────────────────────────────────────────────────

describe('groupView', () => {
  it('shows the items, N, the wins so far and the next end', () => {
    const b = open('b', END_MS + 5 * MIN);
    const v = groupView(group({ maxWins: 2, results: { a: result('confirmed', { finalPrice: 1700 }) } }), [wonLive(), b], END_MS + MIN, TZ);
    expect(v).toMatchObject({ name: 'Lamps', maxWins: 2, wins: 1, full: false, nextEnd: { snipeId: 'b', endMs: END_MS + 5 * MIN } });
    expect(v.items.map((i) => [i.snipeId, i.status])).toEqual([
      ['a', 'Won (confirmed)'],
      ['b', 'Armed'],
    ]);
  });

  it('says plainly that an unconfirmed win risks winning more than N', () => {
    const b = open('b', END_MS + 5 * MIN);
    const v = groupView(group({ results: { a: result('unconfirmed', { why: 'the auction was still open when read' }) } }), [wonLive(), b], END_MS + MIN, TZ);
    expect(v.wins).toBe(0);
    expect(v.warnings.join(' ')).toMatch(/not confirmed.*the auction was still open when read.*could win more than 1/);
  });

  it('says honestly that a bid already sent could not be stopped', () => {
    const c = open('c', END_MS + 5 * MIN, { state: 'sent', attempt: { sentAt: END_MS + 5 * MIN - 8000 } });
    const g = group({ results: { a: result('confirmed') }, cancels: { c: { at: END_MS, ok: false, why: 'The bid may already be out; nothing can be sent or stopped now.' } } });
    const v = groupView(g, [wonLive(), c], END_MS + MIN, TZ);
    expect(v.full).toBe(true);
    expect(v.warnings.join(' ')).toMatch(/could not stop "Lamp C".*already sent cannot be stopped.*could win more than 1/);
  });

  it('marks members the group stopped', () => {
    const b = open('b', END_MS + 5 * MIN, { state: 'killed', outcome: 'killed' });
    const g = group({ results: { a: result('confirmed') }, cancels: { b: { at: END_MS, ok: true, why: 'stopped' } } });
    const v = groupView(g, [wonLive(), b], END_MS + MIN, TZ);
    expect(v.items.find((i) => i.snipeId === 'b')?.status).toMatch(/Stopped by the group/);
    expect(v.nextEnd).toBeNull();
  });

  it('warns when open members drifted closer than 2 minutes apart', () => {
    const b = open('b', END_MS + 5 * MIN);
    const c = open('c', END_MS + 5 * MIN + 30 * SEC);
    expect(groupView(group(), [b, c], END_MS, TZ).warnings.join(' ')).toMatch(/less than 2 minutes apart/);
  });

  it('says so when more than N were won (a confirmation came too late)', () => {
    const second = wonLive({ id: 'b2', itemId: 555, title: 'Lamp B2', endTime: iso(END_MS + 5 * MIN), endTimeAtArm: iso(END_MS + 5 * MIN) });
    const g = group({ results: { a: result('confirmed'), b2: result('confirmed') } });
    expect(groupView(g, [wonLive(), second], END_MS + 10 * MIN, TZ).warnings.join(' ')).toMatch(/won 2 items, more than 1/);
  });

  it('labels a dry-run group and its simulated win', () => {
    const v = groupView(group({ results: { a: result('confirmed', { dryRun: true }) } }), [firedDryRun()], END_MS + MIN, TZ);
    expect(v.mode).toBe('dry-run');
    expect(v.items[0]?.status).toMatch(/Would have won \(dry run/);
  });
});

// ── Properties: cancel only on proof ────────────────────────────────────────

const PROP_RUNS = Number(process.env.SBW_PROP_RUNS ?? (process.env.SBW_LONG_PROPS !== undefined && process.env.SBW_LONG_PROPS !== '' ? 20_000 : 2_000));

/** Any finished-or-not member, any send evidence, any stored outcome. */
const memberArb = fc
  .record({
    // Weighted toward the region that matters: finished members the reducer called a win.
    state: fc.constantFrom<Snipe['state']>('resolved', 'resolved', 'resolved', 'resolved', 'resolved', 'killed', 'sent', 'armed', 'firing'),
    dryRun: fc.constantFrom(false, false, true),
    outcome: fc.oneof(
      { arbitrary: fc.constant<Snipe['outcome']>('won'), weight: 4 },
      { arbitrary: fc.constant<Snipe['outcome']>('dry-run'), weight: 2 },
      { arbitrary: fc.constantFrom<Snipe['outcome']>(...SnipeOutcomeSchema.options), weight: 2 },
      { arbitrary: fc.constant<Snipe['outcome']>(undefined), weight: 1 },
    ),
    sent: fc.constantFrom(true, true, true, false),
    ambiguous: fc.constantFrom(false, false, true),
    notSent: fc.constantFrom(false, false, false, true),
    reply: fc.option(fc.record({ kind: fc.constantFrom(...BidResultKindSchema.options), high: fc.constantFrom(true, false, null) }), { nil: undefined }),
    maxBid: fc.integer({ min: 100, max: 5000 }),
  })
  .map(
    (m): Snipe =>
      wonLive({
        state: m.state,
        dryRun: m.dryRun,
        outcome: m.outcome,
        maxBid: m.maxBid,
        attempt: {
          ...(m.sent ? { sentAt: END_MS - 8000, idempotencyKey: 'a:k' } : {}),
          ...(m.ambiguous ? { ambiguous: true } : {}),
          ...(m.notSent ? { notSent: true } : {}),
          ...(m.reply === undefined ? {} : { reply: bid(m.reply.kind, { isHighBidder: m.reply.high }) }),
        },
      }),
  );

/** Any read after the end: open or closed, extended or not, any price, any high-bidder flag, or none at all. */
const postArb = fc.option(
  fc
    .record({
      closed: fc.boolean(),
      serverShift: fc.constantFrom(-60_000, -1000, 0, 6000, 600_000),
      endShift: fc.constantFrom(0, 0, 0, 120_000, 600_000),
      price: fc.integer({ min: 0, max: 6000 }),
      high: fc.constantFrom(true, true, false, null),
      otherItem: fc.constantFrom(false, false, false, false, true),
    })
    .map((p) =>
      post({
        itemId: p.otherItem ? 999 : 101,
        isClosed: p.closed,
        serverTime: iso(END_MS + p.serverShift),
        endTime: iso(END_MS + p.endShift),
        currentPrice: p.price,
        minimumBid: p.price + 100,
        isHighBidder: p.high,
      }),
    ),
  { nil: null },
);

const closedRead = (d: ItemDetail): boolean => d.isClosed || Date.parse(d.serverTime) >= Date.parse(d.endTime);

describe('property: a confirmed verdict (the only thing that cancels) always has its proof', () => {
  it('live: the reducer stored `won`, a bid may be out, T-87 says won AND final on this read, at or below the max; dry run: closed below the max', () => {
    fc.assert(
      fc.property(memberArb, postArb, (s, d) => {
        const j = judgeWin(s, d, TZ);
        if (j.verdict !== 'confirmed') return;
        expect(s.state).toBe('resolved');
        expect(d).not.toBeNull();
        const read = d as ItemDetail;
        expect(read.itemId).toBe(s.itemId);
        if (s.dryRun) {
          expect(s.outcome).toBe('dry-run');
          expect(closedRead(read)).toBe(true);
          expect(s.maxBid).toBeGreaterThan(read.currentPrice);
          return;
        }
        expect(s.outcome).toBe('won');
        expect(s.attempt.notSent).not.toBe(true);
        const reply = s.attempt.ambiguous === true ? null : (s.attempt.reply ?? null);
        const c = classifyOutcome(s, reply, read, { userTz: TZ });
        expect(c.outcome).toBe('won');
        expect(c.final).toBe(true);
        expect(read.currentPrice).toBeLessThanOrEqual(s.maxBid);
      }),
      { numRuns: PROP_RUNS },
    );
  });

  it('an open auction, a failed read, or a stored Unconfirmed / Leading never confirms', () => {
    fc.assert(
      fc.property(memberArb, postArb, (s, d) => {
        const j = judgeWin(s, d, TZ);
        const leading = d !== null && !s.dryRun && !classifyOutcome(s, s.attempt.ambiguous === true ? null : (s.attempt.reply ?? null), d, { userTz: TZ }).final;
        if (d === null || !closedRead(d) || s.outcome === 'network' || s.outcome === 'extended' || leading) {
          expect(j.verdict).not.toBe('confirmed');
        }
      }),
      { numRuns: PROP_RUNS },
    );
  });

  it('cancelTargets is empty unless N wins of that mode are confirmed, and only ever names open members', () => {
    const resultArb = fc.record({
      verdict: fc.constantFrom<SnipeGroupResult['verdict']>('checking', 'confirmed', 'unconfirmed', 'not-won'),
      dryRun: fc.boolean(),
    });
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3 }),
        fc.array(resultArb, { maxLength: 5 }),
        fc.array(fc.record({ state: fc.constantFrom<Snipe['state']>('armed', 'waking', 'sent', 'resolved', 'killed'), dryRun: fc.boolean() }), { maxLength: 5 }),
        (maxWins, results, ms) => {
          const g = group({ maxWins, results: Object.fromEntries(results.map((r, i) => [`r${String(i)}`, result(r.verdict, { dryRun: r.dryRun })])) });
          const members = ms.map((m, i) => open(String.fromCharCode(98 + i), END_MS + (i + 1) * 5 * MIN, { state: m.state, dryRun: m.dryRun }));
          for (const t of cancelTargets(g, members)) {
            expect(['resolved', 'killed']).not.toContain(t.state);
            const wins = results.filter((r) => r.verdict === 'confirmed' && r.dryRun === t.dryRun).length;
            expect(wins).toBeGreaterThanOrEqual(maxWins);
          }
        },
      ),
      { numRuns: PROP_RUNS },
    );
  });
});
