// T-85 R6: the outcome list repeats each outcome's OWN heading and message —
// the T-80b/T-87 classifier copy, never re-worded. A terminal snipe stores
// only `outcome` and `outcomeDetail` (the classifier's `detail`), so the
// settle-time copy is re-derived by running classifyOutcome on the snipe as
// stored, with the inputs the reducer used for the event that settled it (the
// last history entry names it). A candidate is accepted only when it
// reproduces the stored detail exactly: several settles share an outcome
// ('network' is both "No bid was sent" and "Unconfirmed"), and a near match
// would show the wrong copy.
//
// A settle by the outcome read (`post-read`) used an ItemDetail the snipe does
// not store, so it cannot be re-derived: the row shows that settle's heading
// and the stored classifier text verbatim. Snipes settled through T-83's
// fallback carry T-83's copy in outcomeDetail; it is shown verbatim with
// T-83's own headings.
import { classifyOutcome, type AbortReason, type Classification, type OutcomeContext } from '../../../../domain/snipe/outcome';
import type { Snipe, SnipeOutcome } from '../../../../domain/snipe/types';

export interface OutcomeDisplay {
  /** The settle-time notification title: `Heading: title`. Shown verbatim. */
  title: string;
  /** The settle-time notification message, or the stored classifier text when it cannot be re-derived. */
  message: string;
  /** The classifier's `final` flag (a non-final win reads "Leading"); false when unknown. */
  final: boolean;
  outcome: SnipeOutcome;
}

const ABORTS: readonly AbortReason[] = ['killed', 'cap', 'auth', 'ended', 'extended', 'price', 'already-high', 'missed', 'network'];

/** The reducer's `why` for a settle by the outcome read (src/domain/snipe/state-machine.ts onPostRead). */
const READ_SETTLES: ReadonlySet<string> = new Set(['post-read', 'post-read: dry run measured']);
/** The reducer's `why` prefix for T-80b's not-sent settle; the rest is the (clipped) reason it passed as abortDetail. */
const NOT_SENT_WHY = 'not-sent: ';

/** T-83's fallback copy: it is the only copy ending "No bid was placed." or naming the early proxy. */
function isFallbackCopy(s: Snipe): boolean {
  return (
    s.outcomeDetail !== undefined &&
    (s.outcomeDetail.includes('early proxy bid') || s.outcomeDetail.endsWith('No bid was placed.'))
  );
}

/** As classifyOutcome decides it with no reply in hand: could a bid have gone out? */
function bidMayHaveGone(s: Snipe): boolean {
  if (s.attempt.notSent === true) return false;
  const r = s.attempt.reply;
  if (r !== undefined) return r.kind === 'accepted' || r.kind === 'outbid' || r.kind === 'rejected-unknown';
  return s.attempt.sentAt !== undefined || s.attempt.ambiguous === true;
}

/**
 * The heading the classifier (or T-83) gave this outcome, for a settle that
 * cannot be re-derived. 'network' is "Unconfirmed" whenever a bid may be out:
 * it must never read "Not bid" then. A win or loss read by the outcome read is
 * shown as final ("Won" / "Lost"): that read runs after the end, and its
 * stored text says "Won" / "Outbid" either way.
 */
function heading(s: Snipe, outcome: SnipeOutcome, byRead: boolean): string {
  switch (outcome) {
    case 'won':
      return 'Won';
    case 'outbid':
    case 'below-minimum':
    case 'late':
      return 'Lost';
    case 'auth':
      return 'Not bid';
    case 'network':
      return bidMayHaveGone(s) ? 'Unconfirmed' : 'Not bid';
    case 'ended':
      return 'Ended early';
    case 'extended':
      return byRead ? 'Extended' : 'Not bid: end time changed';
    case 'cap-blocked':
      return 'Blocked';
    case 'killed':
      return 'Stopped';
    case 'dry-run':
      return 'Dry run';
    case 'fallback-proxy-placed':
      return 'Early bid';
    case 'skipped':
      return 'Snipe skipped';
  }
}

/** The classifier runs the reducer could have made for this settle, most specific first. */
function candidates(s: Snipe, userTz: string): Classification[] {
  const why = s.history.at(-1)?.why ?? '';
  const reply = s.attempt.ambiguous === true ? null : (s.attempt.reply ?? null);
  const run = (ctx: OutcomeContext): Classification => classifyOutcome(s, reply, null, { userTz, ...ctx });
  const out: Classification[] = [];
  if (why.startsWith(NOT_SENT_WHY)) out.push(run({ abort: 'network', abortDetail: why.slice(NOT_SENT_WHY.length) }));
  out.push(run({}));
  if (s.dryRun) out.push(run({ dryRunMeasureFailed: true }));
  for (const abort of ABORTS) out.push(classifyOutcome(s, null, null, { userTz, abort }));
  return out;
}

/** The settle-time copy for a terminal snipe, or null when the snipe has no outcome. */
export function outcomeDisplay(s: Snipe, userTz: string): OutcomeDisplay | null {
  const outcome = s.outcome;
  if (outcome === undefined) return null;
  const stored = s.outcomeDetail;
  const byRead = READ_SETTLES.has(s.history.at(-1)?.why ?? '');
  if (!isFallbackCopy(s) && !byRead) {
    const c = candidates(s, userTz).find((x) => x.outcome === outcome && (stored === undefined || x.detail === stored));
    if (c !== undefined) return { title: c.notify.title, message: c.notify.message, final: c.final, outcome };
  }
  // T-83's copy, a settle by the outcome read, or one no classifier run
  // reproduces: the stored text verbatim, under that settle's heading.
  return { title: `${heading(s, outcome, byRead)}: ${s.title}`, message: stored ?? '', final: false, outcome };
}
