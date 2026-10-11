// T-101: the idempotent SendStrategy (PLAN §3.9, §6 T-101; rulings R0–R7).
// It replaces the default one-send strategy in the runner's seam (I-12) and is
// registered through the jobs glob, so `snipe-runner.ts` is never edited.
//
// Money rules (T-101 rulings, restated):
// - R1. A `BidNotSentError` means the request provably never left. Retry ONCE
//   with the same amount and the same idempotency key, but only while
//   `serverNow()` shows at least `MIN_TIME_LEFT_TO_SEND_MS` (1.5 s) before the
//   end. Otherwise: not-sent. The retry never needs a proof read: nothing left.
// - R2. Any other rejection (timeout, network, 5xx, unreadable reply) means the
//   request MAY have left. Make ONE proof read on lane `snipe`
//   (`api.itemDetail`):
//   - our bid present (`isHighBidder === true`) → result accepted, never resend;
//   - provably nothing changed (not the high bidder and zero bids on the item:
//     if any bid had registered, `numBids` would be at least 1) AND
//     `serverNow()` shows at least `PROOF_RESEND_MIN_TIME_LEFT_MS` (2 s) before
//     the end → resend ONCE, same amount, same key;
//   - under 2 s left, or the read failed or is inconclusive → no resend,
//     ambiguous. NEVER not-sent on this path.
// - R3. Once any request of the attempt MAY have left, the strategy never
//   returns `not-sent` for that attempt, even when a later retry throws
//   `BidNotSentError` (it would mean the retry itself left nothing, but the
//   first request is still unaccounted for).
// - R4. At most TWO PlaceBid wire sends per attempt. The second only after a
//   `BidNotSentError` first, or a no-change proof read with ≥ 2 s left. Both
//   sends carry exactly `req.amount` (`snipe.maxBid`) and the same
//   `idempotencyKey`, so exposure never exceeds the max.
// - R6. Any resolved reply, including `rejected-unknown`, is a `result`; the
//   classifier handles it. It is never a reason to resend.
//
// Worker death between persist and send (R5) is the runner's own path: the
// restart finds `sent {key}` stored with no reply, marks the attempt ambiguous
// and settles it through the outcome read, without calling this strategy.
import { bidMayHaveBeenSent } from '../../adapters/sgw/bid';
import { isoMs } from '../../domain/snipe/preflight';
import type { BidResult, ItemDetail } from '../../domain/types';
import type { BackgroundContext } from '../context';
import {
  MIN_TIME_LEFT_TO_SEND_MS,
  snipeSeams,
  type SendDeps,
  type SendOutcome,
  type SendRequest,
  type SendStrategy,
} from './snipe-runner';

/** R2: the proof read must show at least this long before the end for the one resend. */
export const PROOF_RESEND_MIN_TIME_LEFT_MS = 2000;

const SNIPE_LANE = 'snipe' as const;

function placeBid(req: SendRequest, deps: SendDeps): Promise<BidResult> {
  return deps.api.placeBid(
    { itemId: req.snipe.itemId, sellerId: req.sellerId, bidAmount: req.amount, quantity: 1 },
    { idempotencyKey: req.idempotencyKey, timeoutMs: req.timeoutMs },
  );
}

/** The proof read shows this attempt's bid present: the authenticated high-bidder flag is on. */
function bidPresent(detail: ItemDetail): boolean {
  return detail.isHighBidder === true;
}

/**
 * The proof read proves nothing of ours registered: with zero bids on the item
 * no bid of anyone's (ours included) has landed, so both the price and the bid
 * count are unchanged from before the send. `isHighBidder !== true` per R2.
 */
function nothingChanged(detail: ItemDetail): boolean {
  return detail.isHighBidder !== true && detail.numBids === 0;
}

/**
 * The accepted `BidResult` when the proof read shows the bid present (R2).
 * It is our own inference, so `messageText` says exactly that; the outcome
 * classifier then settles the snipe through the recorded reply and the
 * post-read, and never through this text.
 */
function acceptedFromProof(detail: ItemDetail, deps: SendDeps): BidResult {
  return {
    kind: 'accepted',
    rawStatus: null,
    rawResult: null,
    messageText: 'Bid confirmed by the proof read (isHighBidder)',
    isHighBidder: detail.isHighBidder,
    observedAt: deps.clock.now(),
  };
}

/** R2: the one proof read and, only under its no-change proof with ≥ 2 s left, the one resend. */
async function resolveAmbiguous(req: SendRequest, deps: SendDeps, error: unknown): Promise<SendOutcome> {
  let detail: ItemDetail;
  try {
    detail = await deps.api.itemDetail(req.snipe.itemId, SNIPE_LANE);
  } catch {
    // The read failed: no resend, and never a not-sent claim (R3).
    return { kind: 'ambiguous', error };
  }
  if (bidPresent(detail)) return { kind: 'result', result: acceptedFromProof(detail, deps) };
  const endMs = isoMs(req.snipe.endTime);
  if (nothingChanged(detail) && endMs - deps.serverNow() >= PROOF_RESEND_MIN_TIME_LEFT_MS) {
    try {
      return { kind: 'result', result: await placeBid(req, deps) };
    } catch (retryError) {
      // R3: the first request may have left, so this attempt is ambiguous even
      // when the retry provably never left.
      return { kind: 'ambiguous', error: retryError };
    }
  }
  return { kind: 'ambiguous', error };
}

/**
 * The idempotent send (T-101). One PlaceBid, plus exactly one retry under
 * R1's or R2's proof; every send carries `req.amount` and `req.idempotencyKey`.
 */
export const IDEMPOTENT_SEND_STRATEGY: SendStrategy = {
  async send(req, deps) {
    const endMs = isoMs(req.snipe.endTime);
    try {
      return { kind: 'result', result: await placeBid(req, deps) };
    } catch (error) {
      if (!bidMayHaveBeenSent(error)) {
        // R1: provably nothing left (BidNotSentError, or a plain write-gate `paused`).
        if (endMs - deps.serverNow() >= MIN_TIME_LEFT_TO_SEND_MS) {
          try {
            return { kind: 'result', result: await placeBid(req, deps) };
          } catch (retryError) {
            // The retry itself may have left → ambiguous; proven never left → not-sent.
            return bidMayHaveBeenSent(retryError)
              ? { kind: 'ambiguous', error: retryError }
              : { kind: 'not-sent', error: retryError };
          }
        }
        return { kind: 'not-sent', error };
      }
      return resolveAmbiguous(req, deps, error);
    }
  },
};

/** T-36 self-registration (I-12): the runner keeps the default until this runs; the glob loads it. */
export function register(ctx: BackgroundContext): void {
  snipeSeams(ctx).setSendStrategy(IDEMPOTENT_SEND_STRATEGY);
}
