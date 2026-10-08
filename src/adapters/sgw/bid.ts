// T-100: the live SgwApi.placeBid path (PLAN §6 T-100, §3.3, §3.9). It
// replaces T-26's stub; api-adapter.ts imports `placeBid` and calls it only
// after GlobalSwitches.writesAllowed('bidding') said yes (ruling C1: false for
// the kill switch, bidding dry-run, a failed health check and a bad session).
//
// One call sends PlaceBid at most once and never retries it:
// 1. The inputs are checked: positive integer cents, a positive seller id,
//    quantity 1, a non-empty idempotency key, a positive timeout. Invalid
//    input sends nothing, not even the modal read.
// 2. ShowBidModal is read first (`ctx.showBidModal`: snipe lane, bearer), as
//    the site does before its own PlaceBid. If that read fails, or names a
//    seller other than `req.sellerId` (a wrong item/seller pairing), nothing
//    is sent. Its minimumBid does not gate the bid: SGW decides, and a bid
//    below it comes back as a reply.
// 3. PlaceBid goes out ONLY through `ctx.sendWrite('placeBid', ...)`, bound
//    to feature 'bidding', audit kind `bid.place` and lane 'snipe'. sendWrite
//    asks writesAllowed again, re-checks it right before the send, and builds
//    the request with `credentials: 'omit'` and the bearer. BidContext offers
//    no other way to send. The body is {itemId, bidAmount: "12.00", sellerId,
//    quantity: 1}, in the site's order. bidAmount is made from integer cents
//    by domain/money, with no float math. Timeout: min(opts.timeoutMs, 20 s).
// 4. The reply is classified by `classifyPlaceBid`.
//
// How a call ends (ruling R1 and the §3.9 idempotency rule):
// - It resolves with a BidResult when SGW answered and the reply was read.
//   `kind` comes from the result-code map: 'accepted' or 'outbid' only for a
//   code the P5 catalogue confirmed, with the status flag it was seen with.
//   `status: true` alone is never success. `isUnauthorized` is 'auth', and
//   everything else is 'rejected-unknown'.
// - It rejects with BidNotSentError when the bid provably never left: invalid
//   input, a failed or disagreeing modal read, a write-gate refusal, a spent
//   lane budget, or Http proving no byte was sent. Nothing reached SGW.
// - Any other rejection means the bid MAY have reached SGW: a timeout or
//   abort after the send, a network error, a 5xx, a reply that cannot be read
//   (sendWrite flags it to health), or a refusal SGW itself sent (401, 403,
//   429). The caller treats it as ambiguous: post-read first, and never a
//   second send unless §3.9's proof holds. `bidMayHaveBeenSent(e)` answers
//   exactly this. Such failures are rejections, not BidResults, so they reach
//   the snipe engine as `ambiguous` (bidResult null), never as a reply.
//   When in doubt this errs toward "may have been sent": a session that
//   lapses between the modal read and the bid ('auth'), or a lane refusal
//   other than `paused`/`budget`, is never claimed as "not sent". The cost of
//   that is one extra post-read; the opposite error could double a bid.
import { bidAmount } from '../../domain/money';
import type { BidResult, BidResultKind, EpochMs } from '../../domain/types';
import { HttpNetworkError, SgwApiError } from '../../ports/errors';
import type { HttpResponse } from '../../ports/http';
import type { SgwApi } from '../../ports/sgw-api';
import type { BidContext } from './api-adapter';
import { normalizePlaceBidRaw } from './normalize';

export type PlaceBidRequest = Parameters<SgwApi['placeBid']>[0];
export type PlaceBidOptions = Parameters<SgwApi['placeBid']>[1];
export type PlaceBid = (ctx: BidContext, req: PlaceBidRequest, opts: PlaceBidOptions) => Promise<BidResult>;

/** The longest PlaceBid timeout: under the 30 s after which Chrome kills a worker's fetch (§1.3). */
export const PLACE_BID_TIMEOUT_MS = 20_000;

// ── Result-code map ─────────────────────────────────────────────────────────

export interface PlaceBidCode {
  /** The boolean `status` SGW sends with this code. A reply with the other flag, or a numeric status, does not match. */
  readonly status: boolean;
  /** SGW's integer `result`. */
  readonly result: number;
  readonly kind: BidResultKind;
  /**
   * - 'catalogue': seen in a real reply the user captured (USER STEP P5). Only these decide a kind.
   * - 'placeholder': a guess from the plan, kept so stage 2 can confirm or drop it. It never decides a kind.
   */
  readonly evidence: 'catalogue' | 'placeholder';
  /** For 'catalogue', the fixture file in test/fixtures/sgw/json/; for 'placeholder', where the guess comes from. */
  readonly source: string;
}

/** What every reply the map does not explain becomes. */
export const PLACE_BID_UNKNOWN_KIND = 'rejected-unknown' satisfies BidResultKind;

/**
 * The PlaceBid result codes.
 *
 * STAGE 1: no real reply has been captured yet, so there is no 'catalogue'
 * entry, and every live reply classifies as 'rejected-unknown' (or 'auth').
 * Stage 2 adds the codes from the P5 catalogue (placebid-*.json) and confirms
 * or drops these placeholders. The fake server's codes
 * (test/fakes/fake-sgw-server/bidding/result-codes.ts) are reconciled then.
 */
export const PLACE_BID_RESULT_CODES: readonly PlaceBidCode[] = [
  { status: false, result: -3, kind: 'closed', evidence: 'placeholder', source: 'PLAN §6 T-88: -3 closed (unverified)' },
  { status: false, result: -4, kind: 'below-minimum', evidence: 'placeholder', source: 'PLAN §6 T-88: -4/-5 too low (unverified)' },
  { status: false, result: -5, kind: 'below-minimum', evidence: 'placeholder', source: 'PLAN §6 T-88: -4/-5 too low (unverified)' },
  { status: false, result: -110, kind: 'auth', evidence: 'placeholder', source: 'PLAN §6 T-88: -110 auth (unverified)' },
];

/**
 * A PlaceBid reply → BidResult (R1). It fails safe:
 * - `isUnauthorized: true` → 'auth';
 * - a boolean `status` and integer `result` that match a 'catalogue' entry → its kind;
 * - anything else → 'rejected-unknown'. That includes an unknown code, no code,
 *   a numeric status, a code seen with the other status flag, and a placeholder.
 *
 * `messageText` is SGW's HTML message as plain text (T-24's htmlToText); render
 * it as text only. Throws SgwApiError('schema') when the reply fails the
 * PlaceBid schema.
 */
export function classifyPlaceBid(raw: unknown, observedAt: EpochMs, codes: readonly PlaceBidCode[] = PLACE_BID_RESULT_CODES): BidResult {
  const p = normalizePlaceBidRaw(raw);
  const signals = { rawStatus: p.rawStatus, rawResult: p.rawResult, messageText: p.messageText, isHighBidder: p.isHighBidder, observedAt };
  if (p.isUnauthorized) return { kind: 'auth', ...signals };
  const known = codes.find((c) => c.evidence === 'catalogue' && c.status === p.statusFlag && c.result === p.rawResult);
  return { kind: known?.kind ?? PLACE_BID_UNKNOWN_KIND, ...signals };
}

/** The PlaceBid body, in the site's key order (config.ts, bundle chunk 540). `bidAmount` is "12.00", made from integer cents. */
export function placeBidBody(req: PlaceBidRequest): { itemId: number; bidAmount: string; sellerId: number; quantity: 1 } {
  return { itemId: req.itemId, bidAmount: bidAmount(req.bidAmount), sellerId: req.sellerId, quantity: 1 };
}

// ── Sent or not ─────────────────────────────────────────────────────────────

/**
 * placeBid's rejection when the bid provably never left, so nothing reached
 * SGW. `kind`, `message`, `status` and `retryAfterMs` are the original
 * failure's, and `cause` is the original error. Every other rejection means
 * the bid may have reached SGW (see `bidMayHaveBeenSent`).
 */
export class BidNotSentError extends SgwApiError {
  readonly bidSent = false;
}

/**
 * Whether a placeBid rejection leaves open that the bid reached SGW (§3.9). It
 * is false only for a BidNotSentError, or for a plain `paused`: the adapter's
 * write gate refuses with that before bid.ts runs, and nothing is ever sent
 * under it. Anything else, including an error that is not an SgwApiError, may
 * have reached SGW, so the caller post-reads first.
 */
export function bidMayHaveBeenSent(e: unknown): boolean {
  if (e instanceof BidNotSentError) return false;
  return !(e instanceof SgwApiError && e.kind === 'paused');
}

/** The same failure, marked as never sent. */
function notSent(e: unknown): BidNotSentError {
  if (e instanceof BidNotSentError) return e;
  if (e instanceof SgwApiError) {
    return new BidNotSentError(e.kind, e.message, { status: e.status, retryAfterMs: e.retryAfterMs, cause: e });
  }
  return new BidNotSentError('network', `placeBid: nothing was sent: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
}

/** A sendWrite rejection raised before any byte of PlaceBid left. */
function neverLeft(e: unknown): boolean {
  if (!(e instanceof SgwApiError)) return false;
  // The write gate and the lane refuse with these before a request is built.
  if (e.kind === 'paused' || e.kind === 'budget') return true;
  // Http threw before calling fetch (ports/errors.ts, HttpNetworkError.beforeSend).
  return e.cause instanceof HttpNetworkError && e.cause.beforeSend;
}

// ── The live path ───────────────────────────────────────────────────────────

function isPositiveInt(n: number): boolean {
  return Number.isSafeInteger(n) && n > 0;
}

function invalidInput(detail: string): BidNotSentError {
  return new BidNotSentError('schema', `placeBid: invalid-input: ${detail}; nothing was sent`);
}

/** Checks the inputs (nothing is sent if they are wrong) and returns the timeout to use. */
function checkInputs(req: PlaceBidRequest, opts: PlaceBidOptions): number {
  if (!isPositiveInt(req.itemId)) throw invalidInput(`itemId must be a positive integer, got ${String(req.itemId)}`);
  if (!isPositiveInt(req.bidAmount)) {
    throw invalidInput(`bidAmount must be a positive whole number of cents, got ${String(req.bidAmount)}`);
  }
  if (!isPositiveInt(req.sellerId)) throw invalidInput(`sellerId must be a positive integer, got ${String(req.sellerId)}`);
  const quantity: unknown = req.quantity;
  if (quantity !== 1) throw invalidInput(`quantity must be 1, got ${String(quantity)}`);
  const key: unknown = opts.idempotencyKey;
  if (typeof key !== 'string' || key.trim() === '') {
    throw invalidInput('an idempotency key is required (the attempt is persisted before the send, §3.9)');
  }
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
    throw invalidInput(`timeoutMs must be a positive number, got ${String(opts.timeoutMs)}`);
  }
  return Math.min(opts.timeoutMs, PLACE_BID_TIMEOUT_MS);
}

/** The live PlaceBid path; see the header for how it ends. */
export const placeBid: PlaceBid = async (ctx, req, opts) => {
  const timeoutMs = checkInputs(req, opts);
  const modal = await ctx.showBidModal(req.itemId).catch((e: unknown) => {
    throw notSent(e);
  });
  if (modal.sellerId !== req.sellerId) {
    throw invalidInput(
      `ShowBidModal says item ${String(req.itemId)} is sold by seller ${String(modal.sellerId)}, but the bid names seller ${String(req.sellerId)}`,
    );
  }
  const parse = (res: HttpResponse, raw: unknown): BidResult => classifyPlaceBid(raw, res.endedAt);
  return ctx.sendWrite('placeBid', { body: placeBidBody(req), timeoutMs }, parse).catch((e: unknown) => {
    throw neverLeft(e) ? notSent(e) : e;
  });
};
