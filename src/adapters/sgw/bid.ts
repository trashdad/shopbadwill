// T-26 STUB of SgwApi.placeBid. T-100 replaces this file with the live path
// (PLAN §6) and keeps the `placeBid` export, which api-adapter.ts imports.
// Until then every bid is refused with `paused` and nothing is sent.
//
// api-adapter.ts calls this only after `GlobalSwitches.writesAllowed('bidding')`
// said yes (ruling C1: false for the kill switch, bidding dry-run, failed
// health and a bad session). The live path is expected to:
// - build the request with `ctx.prepare('placeBid', { body })`, which applies
//   `credentials: 'omit'` and the bearer exactly like every other request;
// - send it through `ctx.scheduler` on the `snipe` lane;
// - parse with `normalizePlaceBidRaw` (`status: true` alone is never success);
// - report schema failures with `ctx.flagSchemaFailure`.
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
