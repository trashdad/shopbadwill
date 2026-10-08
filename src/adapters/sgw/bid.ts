// T-26 STUB of SgwApi.placeBid. T-100 replaces this file with the live path
// (PLAN §6) and keeps the `placeBid` export, which api-adapter.ts imports.
// Until then every bid is refused with `paused` and nothing is sent.
//
// api-adapter.ts calls this only after `GlobalSwitches.writesAllowed('bidding')`
// said yes (ruling C1: false for the kill switch, bidding dry-run, failed
// health and a bad session).
//
// T-100's live PlaceBid MUST send the bid with `ctx.sendWrite('placeBid',
// { body }, parse)`. Never call `ctx.scheduler` directly for it. sendWrite is
// the adapter's guarded send, bound to feature 'bidding', audit kind
// `bid.place` and lane 'snipe':
// - it asks writesAllowed('bidding') again, and keeps the verdict fresh while
//   the bid waits in the snipe lane's queue;
// - it re-checks the verdict right before the send and re-prepares the request
//   (`credentials: 'omit'`, bearer, expiry) on a retry;
// - a refusal is audited, sends nothing and rejects `paused`;
// - schema failures are flagged to health.
// The live path also parses with `normalizePlaceBidRaw` (`status: true` alone
// is never success).
import type { BidResult } from '../../domain/types';
import { SgwApiError } from '../../ports/errors';
import type { SgwApi } from '../../ports/sgw-api';
import type { BidContext } from './api-adapter';

export type PlaceBidRequest = Parameters<SgwApi['placeBid']>[0];
export type PlaceBidOptions = Parameters<SgwApi['placeBid']>[1];
export type PlaceBid = (ctx: BidContext, req: PlaceBidRequest, opts: PlaceBidOptions) => Promise<BidResult>;

/** Phase stub: always rejects with `paused`; sends nothing. */
export const placeBid: PlaceBid = () =>
  Promise.reject(new SgwApiError('paused', 'placeBid: live bidding is not built yet (T-100); nothing was sent'));
