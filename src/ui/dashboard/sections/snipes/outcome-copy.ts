// T-85 R6: the outcome list repeats each outcome's OWN heading and message —
// the T-80b/T-87 classifier copy, never re-worded. A terminal snipe stores
// only `outcome` and `outcomeDetail` (the classifier's `detail`), so the copy
// is re-derived by running classifyOutcome on the snipe as stored (its
// attempt.reply survives restarts; the measured timing too). Abort-driven
// outcomes are matched on the stored outcome and, where several aborts share
// it ('skipped'), on the stored detail, which is the classifier's own text.
// Snipes settled through T-83's fallback carry T-83's copy in outcomeDetail
// (it ends with "No bid was placed." or names the early proxy bid); it is
// shown verbatim with T-83's own headings.
import { classifyOutcome, type AbortReason, type Classification } from '../../../../domain/snipe/outcome';
import type { Snipe, SnipeOutcome } from '../../../../domain/snipe/types';

export interface OutcomeDisplay {
  /** The classifier's notification title: `Heading: title`. Shown verbatim. */
  title: string;
  /** The classifier's notification message. Shown verbatim. */
  message: string;
  /** The classifier's `final` flag (a non-final win reads "Leading"). */
  final: boolean;
  outcome: SnipeOutcome;
  /** The stored classifier detail when it adds something the re-derived message lacks. */
  extraDetail?: string;
}

const ABORTS: readonly AbortReason[] = ['killed', 'cap', 'auth', 'ended', 'extended', 'price', 'already-high', 'missed', 'network'];

/** T-83's fallback copy: it is the only copy ending "No bid was placed." or naming the early proxy. */
function isFallbackCopy(s: Snipe): boolean {
  return (
    s.outcomeDetail !== undefined &&
    (s.outcomeDetail.includes('early proxy bid') || s.outcomeDetail.endsWith('No bid was placed.'))
  );
}

function fallbackHeading(outcome: SnipeOutcome): string {
  // The classifier's own headings (src/domain/snipe/outcome.ts), used verbatim
  // when the stored snipe cannot reproduce the settle-time classification.
  const HEADING: Record<SnipeOutcome, string> = {
    won: 'Won',
    outbid: 'Lost',
    'below-minimum': 'Lost',
    auth: 'Not bid',
    network: 'Not bid',
    late: 'Lost',
    ended: 'Ended early',
    extended: 'Extended',
    'cap-blocked': 'Blocked',
    killed: 'Stopped',
    'dry-run': 'Dry run',
    'fallback-proxy-placed': 'Early bid',
    skipped: 'Snipe skipped',
  };
  return HEADING[outcome];
}

/** The classifier copy for a terminal snipe, or null when the snipe has no outcome. */
export function outcomeDisplay(s: Snipe, userTz: string): OutcomeDisplay | null {
  const outcome = s.outcome;
  if (outcome === undefined) return null;
  if (isFallbackCopy(s)) {
    return { title: `${fallbackHeading(outcome)}: ${s.title}`, message: s.outcomeDetail ?? '', final: false, outcome };
  }
  const reply = s.attempt.reply ?? null;
  const direct = classifyOutcome(s, reply, null, { userTz });
  let c = direct.outcome === outcome ? direct : null;
  if (
    c === null &&
    outcome === 'network' &&
    (s.attempt.notSent === true || (s.attempt.sentAt === undefined && s.attempt.ambiguous !== true))
  ) {
    // A pre-send network failure (or a proven not-sent): settled with abort 'network'.
    c = classifyOutcome(s, reply, null, { userTz, abort: 'network' });
  }
  if (c === null) {
    let first: Classification | null = null;
    for (const abort of ABORTS) {
      const cand = classifyOutcome(s, reply, null, { userTz, abort });
      if (cand.outcome !== outcome) continue;
      if (first === null) first = cand;
      // The stored detail is the settle-time classifier text: accept the
      // candidate only when it reproduces it exactly (several aborts share an
      // outcome, and a wrong abort would show the wrong copy). Without a stored
      // detail there is nothing to compare, so the first outcome match wins.
      if (s.outcomeDetail === undefined || cand.detail === s.outcomeDetail) {
        c = cand;
        break;
      }
    }
    if (c === null && s.outcomeDetail === undefined) c = first;
  }
  if (c === null) {
    // No classifier run reproduces the settle-time copy (e.g. a win from a
    // post-read whose reply is not stored): show the stored copy verbatim.
    return { title: `${fallbackHeading(outcome)}: ${s.title}`, message: s.outcomeDetail ?? '', final: false, outcome };
  }
  return {
    title: c.notify.title,
    message: c.notify.message,
    final: c.final,
    outcome,
    ...(s.outcomeDetail !== undefined && s.outcomeDetail !== c.detail ? { extraDetail: s.outcomeDetail } : {}),
  };
}
