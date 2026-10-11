// T-87: pure outcome classifier. Decides what happened to a snipe and what to
// tell the user. No I/O, no clock reads: every instant comes from the inputs.
//
// Honesty rule: the user must be able to tell bad luck (outbid) from a broken
// tool (late, auth, network, unconfirmed). When the evidence cannot settle a
// question, the outcome says so instead of guessing a win or a loss.
import { formatMoney } from '../money';
import { formatDual } from '../time/pacific';
import type { BidResult, Cents, EpochMs, ItemDetail, ItemId } from '../types';
import type { Effect, Snipe, SnipeId, SnipeOutcome } from './types';

/** Why the snipe stopped before a bid result existed, when the runner knows. */
export type AbortReason =
  | 'killed'
  | 'cap'
  | 'auth'
  /** The bid provably never went out (T-80b's `not-sent`, e.g. a BidNotSentError); also a network failure before the send. */
  | 'network'
  | 'ended'
  /** End moved before the bid was sent (soft close / verify-failed extended). */
  | 'extended'
  /** Next acceptable bid was above the user's max before firing. */
  | 'price'
  /** The user already led, so no bid was needed. */
  | 'already-high'
  /** The fire moment passed (browser or computer asleep, or fire after the end) and nothing was sent. */
  | 'missed';

export interface OutcomeContext {
  /** IANA zone for the notification's local time. Default America/Los_Angeles. */
  userTz?: string;
  /** Set when the snipe stopped before a bid result existed. */
  abort?: AbortReason;
  /**
   * Extra text for the abort copy, in parentheses after "No bid was sent":
   * T-80b's `not-sent` passes the BidNotSentError's message here.
   */
  abortDetail?: string;
  /**
   * The dry run's measure read was given up (`post-read-failed` in `firing`).
   * Ignored unless the snipe is a dry run and there is no post-read. The result
   * is unconfirmed (`final: false`) under the usual 'Dry run' heading. It must
   * not produce the live "Unconfirmed" heading or "bid may have been placed"
   * copy: a dry run never bids.
   */
  dryRunMeasureFailed?: boolean;
}

export interface OutcomeTiming {
  /** Planned fire instant (`Snipe.fireAt`). */
  plannedFireAt?: EpochMs;
  /** Measured fire instant. */
  firedAt?: EpochMs;
  /** firedAt - plannedFireAt (positive = fired later than planned). */
  fireErrorMs?: number;
  /** armed endTime - firedAt (positive = fired before the end). */
  firedBeforeEndMs?: number;
  /** responseAt - firedAt. */
  responseMs?: number;
  rttMs?: number;
  offsetMs?: number;
}

export interface ReportEntry {
  snipeId: SnipeId;
  itemId: ItemId;
  title: string;
  outcome: SnipeOutcome;
  detail: string;
  dryRun: boolean;
  /** false = the auction was still open when read; the result may change. */
  final: boolean;
  /** Armed end instant (ISO). */
  endTime: string;
  /** Post-read end instant (extended only). */
  newEndTime?: string;
  maxBid: Cents;
  finalPrice?: Cents;
  /** Cents the bid fell short by (outbid, below-minimum); 0 = tie. */
  marginCents?: Cents;
  /** Dry run only: whether the bid would have been the leading one. */
  wouldHaveWon?: boolean;
  timing: OutcomeTiming;
}

export interface Classification {
  outcome: SnipeOutcome;
  /** Text for `Snipe.outcomeDetail`. */
  detail: string;
  final: boolean;
  finalPrice?: Cents;
  marginCents?: Cents;
  wouldHaveWon?: boolean;
  timing: OutcomeTiming;
  notify: Extract<Effect, { kind: 'notify' }>;
  /** `null` when the auction result is not known well enough to stamp the calendar. */
  stamp: Extract<Effect, { kind: 'stampCalendar' }> | null;
  report: ReportEntry;
}

const DEFAULT_TZ = 'America/Los_Angeles';

/** IsoUtc (RFC 3339 with Z, zod-validated) to epoch ms. */
function isoMs(iso: string): number {
  return new Date(iso).getTime();
}

function seconds(ms: number): string {
  return `${(Math.abs(ms) / 1000).toFixed(1)} s`;
}

function measureTiming(s: Snipe, endMs: number): OutcomeTiming {
  const t: OutcomeTiming = {};
  const firedAt = s.measured?.firedAt ?? s.attempt.sentAt;
  if (s.fireAt !== undefined) t.plannedFireAt = s.fireAt;
  if (firedAt !== undefined) {
    t.firedAt = firedAt;
    t.firedBeforeEndMs = endMs - firedAt;
    if (s.fireAt !== undefined) t.fireErrorMs = firedAt - s.fireAt;
    if (s.measured?.responseAt !== undefined) t.responseMs = s.measured.responseAt - firedAt;
  }
  if (s.measured?.rttMs !== undefined) t.rttMs = s.measured.rttMs;
  if (s.measured?.offsetMs !== undefined) t.offsetMs = s.measured.offsetMs;
  return t;
}

function isClosed(d: ItemDetail): boolean {
  return d.isClosed || isoMs(d.serverTime) >= isoMs(d.endTime);
}

interface Verdict {
  outcome: 'won' | 'outbid' | 'unconfirmed';
  how: string;
}

/** Won or lost for a bid SGW accepted (or whose refusal we cannot confirm). */
function judgeAccepted(s: Snipe, bid: BidResult | null, post: ItemDetail | null): Verdict {
  const accepted = bid?.kind === 'accepted';
  if (bid?.kind === 'outbid') return { outcome: 'outbid', how: 'reported by SGW' };
  // An unrecognised reply's own flag is unverified: only the post-read may speak for it.
  const high = bid?.kind === 'rejected-unknown' ? (post?.isHighBidder ?? null) : (post?.isHighBidder ?? bid?.isHighBidder ?? null);
  if (high === true) return { outcome: 'won', how: 'reported by SGW' };
  if (high === false) return { outcome: 'outbid', how: 'reported by SGW' };
  // No high-bidder flag (anonymous read): proxy bidding lets the price settle it, except at a tie.
  const price = post?.currentPrice;
  if (price !== undefined) {
    if (price > s.maxBid) return { outcome: 'outbid', how: 'inferred from the price' };
    // A price below the max proves a win only if SGW confirmed the bid landed; with a lost
    // response the bid may never have arrived.
    if (price < s.maxBid && accepted) return { outcome: 'won', how: 'inferred from the price' };
  }
  return { outcome: 'unconfirmed', how: 'could not tell whether you lead' };
}

export function classifyOutcome(
  snipe: Snipe,
  bidResult: BidResult | null,
  postDetail: ItemDetail | null,
  ctx: OutcomeContext = {},
): Classification {
  const tz = ctx.userTz ?? DEFAULT_TZ;
  const armedEndMs = isoMs(snipe.endTime);
  const timing = measureTiming(snipe, armedEndMs);
  const max = formatMoney(snipe.maxBid);
  const endedAt = formatDual(armedEndMs, tz);
  const post = postDetail;
  const closed = post !== null && isClosed(post);
  const price = post?.currentPrice;
  const priceKnown = closed && price !== undefined;
  const firedAfterEnd = timing.firedBeforeEndMs !== undefined && timing.firedBeforeEndMs < 0;
  // Extension is judged against the end at arm time: the runner may have refreshed
  // `snipe.endTime` at T-60 and that refresh could itself hide a soft close.
  // Lateness uses `snipe.endTime` (latest known end): that is the end the fire aimed at.
  const extended = post !== null && !post.isClosed && isoMs(post.endTime) > isoMs(snipe.endTimeAtArm);

  let outcome: SnipeOutcome;
  let heading: string;
  let message: string;
  let detail: string;
  let final = true;
  let finalPrice: Cents | undefined;
  let marginCents: Cents | undefined;
  let wouldHaveWon: boolean | undefined;
  let stampAs: 'won' | 'lost' | 'ended-early' | null = null;
  let newEndTime: string | undefined;
  let showEnd = true;

  const bidMayHaveGone =
    snipe.attempt.notSent === true
      ? false // T-80b: proven not sent, whatever the attempt record says.
      : bidResult === null
        ? snipe.attempt.sentAt !== undefined || snipe.attempt.ambiguous === true
        : bidResult.kind === 'accepted' || bidResult.kind === 'outbid' || bidResult.kind === 'rejected-unknown';
  // An abort never overrides evidence that a bid went out: fall through to the judge path.
  const abort = bidMayHaveGone ? undefined : ctx.abort;
  const abortNote =
    ctx.abort !== undefined && bidMayHaveGone
      ? ` Stopped (${ctx.abort}) after a bid may have been sent: check the item.`
      : '';

  if (abort === 'killed') {
    outcome = 'killed';
    heading = 'Stopped';
    message = `Stopped before the bid. No bid was placed (your max ${max}).`;
    detail = 'Kill switch or disarm before firing; no bid sent.';
    showEnd = false;
  } else if (abort === 'cap') {
    outcome = 'cap-blocked';
    heading = 'Blocked';
    message = `Not bid: a spending cap blocked it (your max ${max}).`;
    detail = 'A spending cap blocked the bid; no bid sent.';
  } else if (abort === 'auth') {
    outcome = 'auth';
    heading = 'Not bid';
    message = 'Not bid: you were signed out of ShopGoodwill. Sign in before the next snipe.';
    detail = 'No valid session at verify time; no bid sent.';
  } else if (abort === 'network') {
    // T-80b: plain copy for a bid that provably never went out (BidNotSentError).
    outcome = 'network';
    heading = 'Not bid';
    const why = ctx.abortDetail !== undefined && ctx.abortDetail !== '' ? ` (${ctx.abortDetail})` : '';
    message = `No bid was sent${why}. This is not an outbid.`;
    detail = `The bid provably never went out${why}; nothing was sent.`;
  } else if (abort === 'ended') {
    outcome = 'ended';
    heading = 'Ended early';
    message = `Auction closed before the snipe could bid. No bid was placed (your max ${max}).`;
    detail = 'The auction ended (closed early or withdrawn) before the bid; no bid sent.';
    stampAs = 'ended-early';
  } else if (abort === 'extended') {
    outcome = 'extended';
    heading = 'Not bid: end time changed';
    final = false;
    showEnd = false;
    const moved = post !== null && !post.isClosed && isoMs(post.endTime) !== armedEndMs;
    if (moved) newEndTime = post.endTime;
    message = `The auction's end time moved${
      moved ? ` to ${formatDual(isoMs(post.endTime), tz)} (was ${formatDual(armedEndMs, tz)})` : ''
    }, so the bid was not placed. No bid was placed (your max ${max}). You can re-arm to bid at the new end.`;
    detail = `End time changed before the bid${moved ? `: ${snipe.endTime} to ${post.endTime}` : ''}; no bid sent.`;
  } else if (abort === 'price') {
    outcome = 'skipped';
    heading = 'Not bid: price passed your max';
    const next = post?.minimumBid;
    message = `${next !== undefined ? `The next acceptable bid was ${formatMoney(next)}, above` : 'The next acceptable bid was above'} your max ${max}. No bid was placed.`;
    detail = `Next acceptable bid${next !== undefined ? ` ${formatMoney(next)}` : ''} exceeded max ${max} before firing; no bid sent.`;
  } else if (abort === 'already-high') {
    outcome = 'skipped';
    heading = "No bid needed: you're the high bidder";
    message = `You were already the high bidder when the snipe was due, so no bid was needed. No bid was placed (your max ${max}).`;
    detail = 'Already the high bidder at fire time; no bid sent.';
  } else if (abort === 'missed') {
    outcome = 'skipped';
    heading = "Missed: the browser wasn't running at the end";
    message = `The fire moment passed (the browser or computer was asleep, or the fire came after the end) and no bid was sent. No bid was placed (your max ${max}). To avoid this, keep the browser running through the end, or use the companion.`;
    detail = 'Fire moment passed without the browser running; no bid sent.';
  } else if (snipe.dryRun) {
    // A dry run never bids; the post-read is the harmless measuring read at fire time.
    outcome = 'dry-run';
    heading = 'Dry run';
    showEnd = false;
    const bits: string[] = [`would have bid ${max}`];
    if (post) {
      wouldHaveWon = closed ? snipe.maxBid > post.currentPrice : snipe.maxBid >= post.minimumBid;
      bits.push(`price was ${formatMoney(post.currentPrice)}, next bid ${formatMoney(post.minimumBid)}`);
      bits.push(wouldHaveWon ? 'it would have been leading (a later bid could still beat it)' : 'it would NOT have won');
    } else if (ctx.dryRunMeasureFailed === true) {
      // The measure read never arrived. Unknown result, and no bid exists. The
      // heading stays 'Dry run': 'Unconfirmed' is the live heading for a bid
      // that may be out, and a dry run must never read like one.
      final = false;
      bits.push('the dry-run measure failed, so the result is unconfirmed');
    } else {
      bits.push('the item could not be read, so the result is unknown');
    }
    if (timing.firedBeforeEndMs !== undefined) {
      bits.push(
        firedAfterEnd
          ? `the fire was ${seconds(timing.firedBeforeEndMs)} AFTER the end (would have been late)`
          : `fired ${seconds(timing.firedBeforeEndMs)} before the end`,
      );
    }
    const text = `${bits.join('; ')}.`;
    message = `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
    detail = message;
  } else if (extended) {
    // Soft close: the post-read end is later than the armed end and the auction is still running.
    outcome = 'extended';
    heading = 'Extended';
    final = false;
    showEnd = false;
    newEndTime = post.endTime;
    message = `Auction was extended to ${formatDual(isoMs(post.endTime), tz)} (was ${formatDual(isoMs(snipe.endTimeAtArm), tz)}). This snipe is spent; re-arm to bid again (your max ${max}).`;
    detail = `Soft close: end moved from ${snipe.endTimeAtArm} to ${post.endTime}.`;
  } else if (bidResult?.kind === 'closed' || (bidResult === null && firedAfterEnd)) {
    if (firedAfterEnd) {
      outcome = 'late';
      heading = 'Lost';
      finalPrice = priceKnown ? price : undefined;
      message = `Lost: the bid went out ${seconds(timing.firedBeforeEndMs ?? 0)} after the auction ended${
        finalPrice !== undefined ? ` (final ${formatMoney(finalPrice)})` : ''
      }. This is a tool or machine problem, not an outbid.`;
      detail = `Fired ${seconds(timing.firedBeforeEndMs ?? 0)} after endTime.`;
      stampAs = priceKnown ? 'lost' : null;
    } else {
      outcome = 'ended';
      heading = 'Ended early';
      message = `Auction closed before the bid landed. No bid was placed (your max ${max}).`;
      detail = 'SGW reported the auction closed although the fire was not after the armed end.';
      stampAs = 'ended-early';
    }
  } else if (bidResult === null && snipe.attempt.sentAt === undefined && snipe.attempt.ambiguous !== true) {
    outcome = 'network';
    heading = 'Not bid';
    message = 'No bid result was recorded and no bid was sent. This is not an outbid.';
    detail = 'No bid result recorded and no send attempt.';
  } else if (bidResult?.kind === 'auth' || bidResult?.kind === 'restricted') {
    outcome = 'auth';
    heading = 'Not bid';
    message =
      bidResult.kind === 'auth'
        ? 'Not bid: ShopGoodwill rejected your session. Sign in again.'
        : 'Not bid: ShopGoodwill says your account cannot bid on this item.';
    detail = `SGW ${bidResult.kind}: ${bidResult.messageText}`;
  } else if (bidResult?.kind === 'below-minimum') {
    outcome = 'below-minimum';
    heading = 'Lost';
    const min = post?.minimumBid;
    finalPrice = priceKnown ? price : undefined;
    if (min !== undefined && min > snipe.maxBid) marginCents = min - snipe.maxBid;
    message = `Lost: your max ${max} was below the minimum bid${min !== undefined ? ` ${formatMoney(min)}` : ''}${
      marginCents !== undefined ? ` (short by ${formatMoney(marginCents)})` : ''
    }.`;
    detail = message;
    stampAs = priceKnown ? 'lost' : null;
  } else {
    // accepted, outbid, or an ambiguous send settled by re-reading the item.
    const v = judgeAccepted(snipe, bidResult, post);
    final = closed;
    finalPrice = price;
    const unknown = bidResult?.kind === 'rejected-unknown' ? bidResult : null;
    const via =
      bidResult === null
        ? ' The bid response was lost; this comes from re-reading the item.'
        : unknown
          ? " ShopGoodwill's reply was not recognised; this comes from re-reading the item."
          : '';
    const rawNote = unknown
      ? ` Unrecognised reply (status ${String(unknown.rawStatus)}, result ${String(unknown.rawResult)}): ${unknown.messageText}`
      : '';
    const at = price !== undefined ? ` at ${formatMoney(price)}` : '';
    if (v.outcome === 'won') {
      outcome = 'won';
      heading = 'Won';
      message = `Won${final ? '' : ' (leading; auction still open)'}${at} (your max ${max}).${via}`;
      detail = `Won; ${v.how}.${rawNote}`;
      stampAs = final ? 'won' : null;
    } else if (v.outcome === 'outbid') {
      outcome = 'outbid';
      heading = final ? 'Lost' : 'Outbid';
      if (price !== undefined) marginCents = price > snipe.maxBid ? price - snipe.maxBid : 0;
      message = `${final ? 'Lost: outbid' : 'Currently outbid'}${at} (${final ? '' : 'auction still open; '}your max ${max})${marginCents ? `, short by ${formatMoney(marginCents)}` : ''}.${via}`;
      detail = `Outbid; ${v.how}.${rawNote}`;
      stampAs = final ? 'lost' : null;
    } else {
      outcome = 'network';
      heading = 'Unconfirmed';
      final = false;
      finalPrice = undefined;
      message = `Unconfirmed: the bid may have been placed but the result could not be read${
        price !== undefined ? ` (price ${formatMoney(price)}, your max ${max})` : ''
      }. Check ShopGoodwill.${via}`;
      detail = `${v.how}.${rawNote}`;
    }
  }

  const notify: Classification['notify'] = {
    kind: 'notify',
    snipeId: snipe.id,
    title: `${heading}: ${snipe.title}`,
    message: `${showEnd ? `${message} Ended ${endedAt}.` : message}${abortNote}`,
  };
  const stamp: Classification['stamp'] =
    stampAs === null
      ? null
      : {
          kind: 'stampCalendar',
          snipeId: snipe.id,
          outcome: stampAs,
          ...(finalPrice !== undefined && stampAs !== 'ended-early' ? { finalPrice } : {}),
        };

  const report: ReportEntry = {
    snipeId: snipe.id,
    itemId: snipe.itemId,
    title: snipe.title,
    outcome,
    detail: `${detail}${abortNote}`,
    dryRun: snipe.dryRun,
    final,
    endTime: snipe.endTime,
    ...(newEndTime !== undefined ? { newEndTime } : {}),
    maxBid: snipe.maxBid,
    ...(finalPrice !== undefined ? { finalPrice } : {}),
    ...(marginCents !== undefined ? { marginCents } : {}),
    ...(wouldHaveWon !== undefined ? { wouldHaveWon } : {}),
    timing,
  };

  return {
    outcome,
    detail: `${detail}${abortNote}`,
    final,
    ...(finalPrice !== undefined ? { finalPrice } : {}),
    ...(marginCents !== undefined ? { marginCents } : {}),
    ...(wouldHaveWon !== undefined ? { wouldHaveWon } : {}),
    timing,
    notify,
    stamp,
    report,
  };
}
