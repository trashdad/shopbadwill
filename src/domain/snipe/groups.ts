// T-112: bid groups, "win at most N of these items". Pure rules: no I/O, no
// clock reads; every instant comes from the inputs. The background job
// (src/background/jobs/snipe-groups.ts) enforces them through T-84's ArmHooks
// and the runner's public `disarm`; the dashboard (sections/groups) shows them.
//
// Money rules (the group must NEVER cause more wins than N, and must never
// cancel a snipe on a guess):
// - Cancel only on proof. A member counts as won ONLY when T-87's
//   `classifyOutcome`, run on a read made after the end, says `won` with
//   `final: true`, AND the reducer stored `won` for it, AND the closing price
//   is not above the max (an anonymous read lets T-87 fall back to the bid
//   reply's own high-bidder flag; a price above the max proves that flag stale).
//   Leading (not final), Unconfirmed, ambiguous, an unreadable item or reads
//   that disagree never count: the group keeps going and says plainly that this
//   risks winning more than N. A dry run counts "would have won" (T-87's dry-run
//   classification of a read after the end) only once the auction closed.
// - Cancelling goes through the runner's public `disarm` (the reducer decides):
//   a snipe whose bid was already sent cannot be stopped, and the group says so.
// - A group never touches caps or exposure: every member is armed, checked and
//   counted on its own. A group is all dry run or all live, so a simulated win
//   never cancels a live snipe.
// - Spacing: members end at least 2 minutes apart (checked at arm), so a win
//   can be confirmed (end + 5 s) and the next member stopped before it fires.
// - Edit freeze: from 2 minutes before the next end until that member is
//   settled, the group cannot be changed (N, name, delete, new members).
import { formatMoney } from '../money';
import type { SnipeGroup, SnipeGroupResult } from '../storage/schema';
import { formatDual } from '../time/pacific';
import type { Cents, EpochMs, ItemDetail, Lane } from '../types';
import { classifyOutcome } from './outcome';
import type { Snipe, SnipeState } from './types';

const SEC = 1000;
const MIN = 60 * SEC;

/** Members' ends must be at least this far apart (arm time). */
export const GROUP_MIN_SPACING_MS = 2 * MIN;
/** No edit from this long before the next end. */
export const GROUP_EDIT_FREEZE_MS = 2 * MIN;
/** The confirming read is due this long after the end (local clock), as the runner's outcome read. */
export const GROUP_CONFIRM_AFTER_END_MS = 5 * SEC;
/**
 * When each confirming read is due, from the first one. After the last, a
 * member that may have been won stays `unconfirmed` and the group keeps going.
 */
export const GROUP_CONFIRM_OFFSETS_MS: readonly number[] = [0, 10 * SEC, 30 * SEC, 60 * SEC, 5 * MIN, 30 * MIN];
/** The attempts within a minute of the first, before the next member (2 min later at the earliest) fires. */
export const GROUP_CONFIRM_FAST_ATTEMPTS = 4;

/**
 * The first confirming read may use the snipe lane only if no other snipe
 * needs that lane (its T-60 s verify, its fire, its first outcome read) within
 * this long. One 429/5xx backs the lane off for up to 37.5 s (30 s + 25 %).
 * A member that ends 2 min later verifies 55 s after the read: still allowed.
 */
export const SNIPE_LANE_GUARD_FIRST_MS = 45 * SEC;
/** A retry may use the snipe lane only if no other snipe needs it within this long (failures in a row double the backoff). */
export const SNIPE_LANE_GUARD_RETRY_MS = 10 * MIN;

const TERMINAL: ReadonlySet<SnipeState> = new Set(['resolved', 'killed']);

export const isOpenSnipe = (s: Snipe): boolean => !TERMINAL.has(s.state);

const endMsOf = (s: Pick<Snipe, 'endTime'>): number => new Date(s.endTime).getTime();

/** The local end of `s` (its measured offset, else the current estimate). */
const endLocalOf = (s: Snipe, offsetMs: number): number => endMsOf(s) - (s.measured?.offsetMs ?? offsetMs);

/**
 * Whether no snipe other than `selfId` needs the snipe lane between `now` and
 * `now + horizonMs`: its T-60 s verify, its fire, or its first outcome read
 * (end + 5 s). A snipe firing, or with an early proxy bid to send, always
 * needs it. Group reads must never make another snipe's critical read wait
 * out a backoff they caused.
 */
export function snipeLaneFree(selfId: string, snipes: readonly Snipe[], now: EpochMs, offsetMs: number, horizonMs: number): boolean {
  return snipes.every((s) => {
    if (s.id === selfId || !isOpenSnipe(s) || s.state === 'draft') return true;
    if (s.state === 'firing' || s.state === 'fallback-applied') return false;
    const end = endLocalOf(s, offsetMs);
    const needs = s.state === 'sent' ? [end + GROUP_CONFIRM_AFTER_END_MS] : [end - MIN, end - s.leadMs, end + GROUP_CONFIRM_AFTER_END_MS];
    return !needs.some((t) => t >= now - 5 * SEC && t <= now + horizonMs);
  });
}

/**
 * The lane of confirming read number `attempt` (0-based). `free` is
 * snipeLaneFree with SNIPE_LANE_GUARD_FIRST_MS for attempt 0, with
 * SNIPE_LANE_GUARD_RETRY_MS for the others.
 * - The snipe lane whenever it is free: it carries the session's bearer, so
 *   SGW says who is the high bidder. Until SGW's PlaceBid result codes are
 *   catalogued (P5), every reply is `rejected-unknown` and T-87 trusts only
 *   that flag: a live win can be confirmed ONLY by such a read.
 * - Otherwise the interactive lane for the fast attempts (its own backoff) and
 *   the background lane for the slow ones. Anonymous: they confirm a dry run,
 *   or a live win whose reply T-87 recognises, never a live win otherwise.
 */
export function confirmLane(attempt: number, free: boolean): Lane {
  if (free) return 'snipe';
  return attempt < GROUP_CONFIRM_FAST_ATTEMPTS ? 'interactive' : 'background';
}

const titleOf = (s: Pick<Snipe, 'title' | 'itemId'>): string => (s.title === '' ? `item ${String(s.itemId)}` : s.title);

/** "1 min 10 s", "45 s". */
function gapText(ms: number): string {
  const total = Math.max(0, Math.round(Math.abs(ms) / SEC));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${String(s)} s`;
  return s === 0 ? `${String(m)} min` : `${String(m)} min ${String(s)} s`;
}

export function membersOf(groupId: string, snipes: readonly Snipe[]): Snipe[] {
  return snipes.filter((s) => s.groupId === groupId);
}

/** As classifyOutcome reads the attempt: could a bid have gone out? */
function bidMayBeOut(s: Snipe): boolean {
  if (s.attempt.notSent === true) return false;
  const r = s.attempt.reply;
  if (r !== undefined) return r.kind === 'accepted' || r.kind === 'outbid' || r.kind === 'rejected-unknown';
  return s.attempt.sentAt !== undefined || s.attempt.ambiguous === true;
}

// ── A member ends ───────────────────────────────────────────────────────────

/** Local instant of the confirming read: 5 s after the end on this computer's clock, never before `now`. */
export function confirmAt(s: Snipe, now: EpochMs, offsetMs: number): EpochMs {
  return Math.max(now, endLocalOf(s, offsetMs) + GROUP_CONFIRM_AFTER_END_MS);
}

export type MemberEnd =
  | { kind: 'pending' }
  /** It may have been won: a read after the end decides (at `at`). */
  | { kind: 'confirm'; at: EpochMs }
  /** It may have been won, and no read can make the group sure of it. */
  | { kind: 'unconfirmed'; why: string }
  | { kind: 'not-won'; why: string };

type EndKind = { kind: 'pending' } | { kind: 'confirm' } | { kind: 'unconfirmed'; why: string } | { kind: 'not-won'; why: string };

function endKind(s: Snipe): EndKind {
  if (isOpenSnipe(s)) return { kind: 'pending' };
  if (s.state === 'killed') return { kind: 'not-won', why: 'stopped before a bid was placed' };
  if (s.dryRun) {
    // T-87 gives a dry run 'dry-run' exactly when a bid would have been placed
    // (the fire, or an early proxy as the fallback); every other end is an abort.
    return s.outcome === 'dry-run' ? { kind: 'confirm' } : { kind: 'not-won', why: 'no bid would have been placed' };
  }
  if (!bidMayBeOut(s)) return { kind: 'not-won', why: 'no bid was sent' };
  switch (s.outcome) {
    case 'won':
      return { kind: 'confirm' };
    case 'network':
      return { kind: 'unconfirmed', why: 'the bid may have been placed, but its result could not be read' };
    case 'extended':
      return { kind: 'unconfirmed', why: 'the auction was extended with your bid on it, so it may still be won' };
    default:
      return { kind: 'not-won', why: s.outcome === undefined ? 'no result' : `the result was ${s.outcome}` };
  }
}

/** What the group does when a member reaches `resolved` or `killed`. */
export function memberEnded(s: Snipe, now: EpochMs, offsetMs: number): MemberEnd {
  const k = endKind(s);
  return k.kind === 'confirm' ? { kind: 'confirm', at: confirmAt(s, now, offsetMs) } : k;
}

// ── Cancel only on proof ────────────────────────────────────────────────────

export type WinJudgement =
  | { verdict: 'confirmed'; why: string; finalPrice?: Cents }
  | { verdict: 'not-won'; why: string }
  /** `retry`: a later read may still settle it (the auction still open, the read failed). */
  | { verdict: 'unconfirmed'; why: string; retry: boolean };

function isClosed(d: ItemDetail): boolean {
  return d.isClosed || new Date(d.serverTime).getTime() >= new Date(d.endTime).getTime();
}

/**
 * Whether member `s` was won, from `post`, a read of its item made after the
 * end (null when the read failed). The ONLY source of a `confirmed` verdict,
 * and so of every cancellation. See the money rules above.
 */
export function judgeWin(s: Snipe, post: ItemDetail | null, userTz?: string): WinJudgement {
  const k = endKind(s);
  if (k.kind === 'pending') return { verdict: 'unconfirmed', why: 'the snipe has not finished', retry: true };
  if (k.kind === 'not-won') return { verdict: 'not-won', why: k.why };
  if (k.kind === 'unconfirmed') return { verdict: 'unconfirmed', why: k.why, retry: false };
  if (post === null) return { verdict: 'unconfirmed', why: 'the item could not be read after the end', retry: true };
  if (post.itemId !== s.itemId) return { verdict: 'unconfirmed', why: 'the read was for another item', retry: true };
  const ctx = userTz === undefined ? {} : { userTz };
  if (s.dryRun) {
    if (!isClosed(post)) return { verdict: 'unconfirmed', why: 'the auction was still open when read', retry: true };
    const c = classifyOutcome(s, null, post, ctx);
    if (c.outcome === 'dry-run' && c.final && c.wouldHaveWon === true) {
      return { verdict: 'confirmed', why: `would have won at ${formatMoney(post.currentPrice)} (dry run)`, finalPrice: post.currentPrice };
    }
    return { verdict: 'not-won', why: `would not have won: it closed at ${formatMoney(post.currentPrice)}, your max ${formatMoney(s.maxBid)}` };
  }
  const reply = s.attempt.ambiguous === true ? null : (s.attempt.reply ?? null);
  const c = classifyOutcome(s, reply, post, ctx);
  if (c.outcome === 'won' && c.final) {
    // T-87 trusts the bid reply's high-bidder flag when the read is anonymous;
    // a closing price above the max proves that flag stale.
    if (post.currentPrice > s.maxBid) {
      return { verdict: 'unconfirmed', why: `it closed at ${formatMoney(post.currentPrice)}, above your max: check the item`, retry: false };
    }
    return { verdict: 'confirmed', why: `won at ${formatMoney(post.currentPrice)}`, ...(c.finalPrice === undefined ? {} : { finalPrice: c.finalPrice }) };
  }
  if (c.final) {
    // The reducer stored a win; this read says otherwise. Never a guess either way.
    return { verdict: 'unconfirmed', why: `the reads disagree (this one says ${c.outcome}): check the item`, retry: false };
  }
  const why =
    c.outcome === 'won'
      ? 'the auction was still open when read'
      : c.outcome === 'extended'
        ? 'the auction was extended and is still open'
        : 'it could not be told whether you lead';
  return { verdict: 'unconfirmed', why, retry: true };
}

/** The member's result after one confirming attempt (`prev` is `checking`; `prev.at` is the first attempt). */
export function nextResult(prev: SnipeGroupResult, j: WinJudgement, now: EpochMs): SnipeGroupResult {
  const attempts = prev.attempts + 1;
  const base = { dryRun: prev.dryRun, attempts, why: j.why, ...(prev.warned === undefined ? {} : { warned: prev.warned }) };
  if (j.verdict === 'confirmed') return { ...base, verdict: 'confirmed', at: now, ...(j.finalPrice === undefined ? {} : { finalPrice: j.finalPrice }) };
  if (j.verdict === 'not-won') return { ...base, verdict: 'not-won', at: now };
  const offset = GROUP_CONFIRM_OFFSETS_MS[attempts];
  if (j.retry && offset !== undefined) return { ...base, verdict: 'checking', at: prev.at, nextAt: prev.at + offset };
  return { ...base, verdict: 'unconfirmed', at: now };
}

/** Confirmed wins of one mode (a dry-run win never counts for live snipes, and the reverse). */
export function confirmedWins(g: SnipeGroup, dryRun: boolean): number {
  return Object.values(g.results).filter((r) => r.verdict === 'confirmed' && r.dryRun === dryRun).length;
}

/**
 * The open members to disarm: those of a mode whose confirmed wins reached N,
 * not asked before (a refusal is final: the bid was out). Soonest end first.
 * A `sent` member is included: the runner's reducer refuses it, and the group
 * records and reports that honestly.
 */
export function cancelTargets(g: SnipeGroup, members: readonly Snipe[]): Snipe[] {
  return members
    .filter((m) => isOpenSnipe(m) && g.cancels[m.id] === undefined && confirmedWins(g, m.dryRun) >= g.maxWins)
    .sort((a, b) => endMsOf(a) - endMsOf(b));
}

// ── Freeze and arm-time rules ───────────────────────────────────────────────

/** Open, or finished with a result the group has not settled yet (a win still being checked). */
function unsettled(g: SnipeGroup, m: Snipe): boolean {
  if (m.state === 'killed') return false;
  if (isOpenSnipe(m)) return true;
  const r = g.results[m.id];
  return r === undefined ? endKind(m).kind === 'confirm' : r.verdict === 'checking';
}

/** The member whose end freezes the group now (the soonest unsettled one, from 2 min before its end), or null. */
export function frozenBy(g: SnipeGroup, members: readonly Snipe[], now: EpochMs): Snipe | null {
  const next = members.filter((m) => unsettled(g, m)).sort((a, b) => endMsOf(a) - endMsOf(b))[0];
  return next !== undefined && now >= endMsOf(next) - GROUP_EDIT_FREEZE_MS ? next : null;
}

function frozenText(g: SnipeGroup, m: Snipe, userTz: string): string {
  return `Bid group "${g.name}" is frozen: "${titleOf(m)}" ends ${formatDual(endMsOf(m), userTz)}. A group cannot change from 2 minutes before its next end until that item's result is known.`;
}

export interface ArmCheck {
  groupId: string;
  group: SnipeGroup | undefined;
  /** The snipe being armed (its effective dryRun, its fresh end time). */
  draft: Snipe;
  /** Every stored member of the group. */
  members: readonly Snipe[];
  /** Arms into this group still in progress (passed this check, not stored yet). */
  reserved: readonly Snipe[];
  now: EpochMs;
  userTz: string;
}

/** Why the draft may not join the group, or null. The background vetoes the arm with it. */
export function armProblem(a: ArmCheck): string | null {
  const g = a.group;
  if (g === undefined) return `This bid group does not exist (it may have been deleted). Pick another group, or arm the snipe without one.`;
  const others = [...a.members, ...a.reserved].filter((m) => m.id !== a.draft.id);
  const otherMode = others.find((m) => m.state !== 'killed' && m.dryRun !== a.draft.dryRun);
  if (otherMode !== undefined) {
    return `Bid group "${g.name}" holds ${otherMode.dryRun ? 'dry-run' : 'live'} snipes and this one is ${a.draft.dryRun ? 'a dry run' : 'live'}. A group is all dry run or all live, so a dry-run result never stops a live snipe.`;
  }
  const wins = confirmedWins(g, a.draft.dryRun);
  if (wins >= g.maxWins) return `Bid group "${g.name}" already won ${String(wins)} of ${String(g.maxWins)}, so it takes no more snipes.`;
  const frozen = frozenBy(g, a.members, a.now);
  if (frozen !== null) return frozenText(g, frozen, a.userTz);
  const end = endMsOf(a.draft);
  const near = others
    .filter((m) => m.state !== 'killed' && m.itemId !== a.draft.itemId)
    .map((m) => ({ m, gap: Math.abs(endMsOf(m) - end) }))
    .filter((x) => x.gap < GROUP_MIN_SPACING_MS)
    .sort((x, y) => x.gap - y.gap)[0];
  if (near !== undefined) {
    return `Bid group "${g.name}": this item ends ${formatDual(end, a.userTz)}, only ${gapText(near.gap)} from "${titleOf(near.m)}" (ends ${formatDual(endMsOf(near.m), a.userTz)}). Items in a group must end at least 2 minutes apart, so a win can be confirmed and the next snipe stopped before it fires.`;
  }
  return null;
}

/** Why the group's name or N may not change now, or null. */
export function editProblem(g: SnipeGroup, members: readonly Snipe[], now: EpochMs, userTz: string): string | null {
  const frozen = frozenBy(g, members, now);
  return frozen === null ? null : frozenText(g, frozen, userTz);
}

/** Why the group may not be deleted now, or null. */
export function deleteProblem(g: SnipeGroup, members: readonly Snipe[], now: EpochMs, userTz: string): string | null {
  const frozen = editProblem(g, members, now, userTz);
  if (frozen !== null) return frozen;
  const open = members.filter(isOpenSnipe).length;
  if (open > 0) return `Bid group "${g.name}" still has ${String(open)} open snipe${open === 1 ? '' : 's'}. Disarm ${open === 1 ? 'it' : 'them'} or wait until ${open === 1 ? 'it ends' : 'they end'}, then delete the group.`;
  return null;
}

// ── The dashboard's view ────────────────────────────────────────────────────

export interface GroupItemView {
  snipeId: string;
  itemId: number;
  title: string;
  endMs: EpochMs;
  dryRun: boolean;
  open: boolean;
  status: string;
}

export interface GroupView {
  id: string;
  name: string;
  maxWins: number;
  /** Confirmed wins (of the group's mode). */
  wins: number;
  /** null while the group has no member. */
  mode: 'dry-run' | 'live' | null;
  /** N confirmed wins: the group stopped (or tried to stop) the rest. */
  full: boolean;
  nextEnd: { snipeId: string; title: string; endMs: EpochMs } | null;
  frozen: { snipeId: string; title: string; endMs: EpochMs } | null;
  /** Soonest end first. */
  items: GroupItemView[];
  /** Plain-text risks: wins not confirmed, snipes that could not be stopped, ends too close. */
  warnings: string[];
  canDelete: boolean;
}

const OPEN_TEXT: Readonly<Record<Exclude<SnipeState, 'resolved' | 'killed'>, string>> = {
  draft: 'Draft',
  armed: 'Armed',
  'fallback-applied': 'Early proxy bid being placed',
  waking: 'In its last minutes',
  verified: 'In its last minutes',
  firing: 'Firing',
  sent: 'Bid sent: waiting for the result',
};

function statusOf(g: SnipeGroup, m: Snipe): string {
  if (m.state === 'killed') return g.cancels[m.id]?.ok === true ? `Stopped by the group (it had won ${String(g.maxWins)})` : 'Stopped';
  if (m.state !== 'resolved') return OPEN_TEXT[m.state];
  const k = endKind(m).kind;
  const verdict = g.results[m.id]?.verdict ?? (k === 'confirm' || k === 'pending' ? 'checking' : k);
  switch (verdict) {
    case 'confirmed':
      return m.dryRun ? 'Would have won (dry run, confirmed at the close)' : 'Won (confirmed)';
    case 'checking':
      return m.dryRun ? 'Checking whether it would have won' : 'Checking whether it was won';
    case 'unconfirmed':
      return 'May have been won: not confirmed';
    case 'not-won':
      return m.dryRun ? 'Would not have won' : 'Not won';
  }
}

/** Everything the dashboard shows for one group, from its record and its members. */
export function groupView(g: SnipeGroup, members: readonly Snipe[], now: EpochMs, userTz: string): GroupView {
  const sorted = [...members].sort((a, b) => endMsOf(a) - endMsOf(b));
  const mode = sorted.length === 0 ? null : sorted.some((m) => !m.dryRun) ? 'live' : 'dry-run';
  const wins = confirmedWins(g, mode === 'dry-run');
  const full = wins >= g.maxWins;
  const n = String(g.maxWins);
  const warnings: string[] = [];
  if (!full) {
    for (const m of sorted) {
      const r = g.results[m.id];
      const k = r === undefined && m.state === 'resolved' ? endKind(m) : null;
      if (r?.verdict === 'unconfirmed' || k?.kind === 'unconfirmed') {
        const why = r?.why ?? (k?.kind === 'unconfirmed' ? k.why : '');
        warnings.push(
          `"${titleOf(m)}" may have been won, but the win is not confirmed (${why}). The group keeps bidding on its other items, so you could win more than ${n}.`,
        );
      } else if (r?.verdict === 'checking' && r.attempts > 0) {
        warnings.push(
          `The win of "${titleOf(m)}" is not confirmed yet (${r.why}); still checking. Until it is, the group keeps bidding, so you could win more than ${n}.`,
        );
      }
    }
  }
  if (wins > g.maxWins) {
    warnings.push(`This group won ${String(wins)} items, more than ${n}: a win was confirmed too late to stop the others.`);
  }
  for (const m of sorted) {
    const c = g.cancels[m.id];
    if (c !== undefined && !c.ok) {
      const why = c.why.trim().replace(/[.\s]*$/, '.');
      warnings.push(`The group could not stop "${titleOf(m)}": ${why} A bid already sent cannot be stopped, so you could win more than ${n}.`);
    }
  }
  const open = sorted.filter(isOpenSnipe);
  for (let i = 1; i < open.length; i++) {
    const a = open[i - 1];
    const b = open[i];
    if (a !== undefined && b !== undefined && endMsOf(b) - endMsOf(a) < GROUP_MIN_SPACING_MS) {
      warnings.push(
        `"${titleOf(a)}" and "${titleOf(b)}" now end less than 2 minutes apart. A win may not be confirmed before the next snipe fires, so you could win more than ${n}.`,
      );
    }
  }
  const next = open[0];
  const frozen = frozenBy(g, members, now);
  return {
    id: g.id,
    name: g.name,
    maxWins: g.maxWins,
    wins,
    mode,
    full,
    nextEnd: next === undefined ? null : { snipeId: next.id, title: titleOf(next), endMs: endMsOf(next) },
    frozen: frozen === null ? null : { snipeId: frozen.id, title: titleOf(frozen), endMs: endMsOf(frozen) },
    items: sorted.map((m) => ({
      snipeId: m.id,
      itemId: m.itemId,
      title: titleOf(m),
      endMs: endMsOf(m),
      dryRun: m.dryRun,
      open: isOpenSnipe(m),
      status: statusOf(g, m),
    })),
    warnings,
    canDelete: deleteProblem(g, members, now, userTz) === null,
  };
}
