// T-57: the `quote` step executor (R6; T-51 plans the steps, I-07). One
// landed-cost shipping quote per step, always on lane `background` — even
// while job.runNow drains the run on `interactive`. It shares the 24 h
// `sbw:quoteCache` with the landedCost.get handler: a fresh entry (same ZIP
// hash) is never re-fetched. It does nothing — outcome `{ kind: 'quote',
// quote: null }` — when the feature is off, the kill switch is on (persisted
// settings or the in-memory switch), or homeZip is unset or invalid, so a
// plan made while the feature was on cannot start making requests after the
// user turned it off.
//
// A closed read gate (scheduler pause, background-lane backoff, or a spent
// background budget) throws SgwApiError('paused') with no ZIP in the message,
// so the runner records the step as not run. The probe runs only when
// `ctx.scheduler.stats` exists; unit tests that pass an empty ctx are unchanged.
//
// A fetched quote is audited `quote.fetched` for the item (R4: never the ZIP;
// the cache stores only the ZIP's keyed hash, under the same per-install salt
// as the handler). Other errors propagate to the runner
// after the ZIP is stripped from the message. The runner maps paused/budget
// to "not run" and retryable kinds to a paused run.
import { STORAGE_KEYS } from '../../../domain/storage/schema';
import type { RequestSchedulerStats } from '../../../domain/types';
import { SgwApiError } from '../../../ports/errors';
import { isValidZip, readCachedQuote, writeCachedQuote, zipHashFor, type CachedQuote } from '../../handlers/landed-cost';
import type { JobStep, StepOutcome } from '../../../domain/watches/schema';
import type { StepDeps } from './index';

/** In-memory kill switch, when the switches object exposes `view()`. A throw is on. */
function memoryKill(switches: StepDeps['switches']): boolean {
  const view = (switches as { view?: () => { killSwitch?: boolean } }).view;
  if (typeof view !== 'function') return false;
  try {
    return view.call(switches).killSwitch === true;
  } catch {
    return true;
  }
}

/**
 * DailyJobRunner.laneBlocked for the background lane. Missing scheduler → not
 * blocked (the runner already applied the gate). Missing lane, a throw, a
 * pause, a future backoff, or a spent budget → blocked.
 */
function readGateClosed(deps: StepDeps): boolean {
  const scheduler = (deps.ctx as { scheduler?: { stats?: () => RequestSchedulerStats } }).scheduler;
  if (typeof scheduler?.stats !== 'function') return false;
  try {
    const stats = scheduler.stats();
    if (stats.paused !== undefined) return true;
    // A partial stats record (a lane the scheduler has not published) is blocked.
    const lane = (stats.lanes as Partial<typeof stats.lanes>).background;
    if (lane === undefined) return true;
    const now = deps.repo.now();
    return (lane.backoffUntil !== undefined && lane.backoffUntil > now) || lane.usedToday >= lane.budget;
  } catch {
    return true;
  }
}

/** Rethrow with the home ZIP removed. Kind, status and retryAfterMs stay. */
function scrubZip(err: unknown, zip: string): never {
  if (err instanceof SgwApiError && zip !== '' && (err.message.includes(zip) || jsonHasZip(err, zip))) {
    const cleaned = err.message.split(zip).join('').replace(/[ \t]{2,}/g, ' ').trim();
    throw new SgwApiError(err.kind, cleaned === '' ? err.kind : cleaned, {
      status: err.status,
      retryAfterMs: err.retryAfterMs,
    });
  }
  throw err;
}

function jsonHasZip(err: SgwApiError, zip: string): boolean {
  try {
    return JSON.stringify(err).includes(zip);
  } catch {
    return false;
  }
}

export async function executeQuoteStep(step: JobStep, deps: StepDeps): Promise<StepOutcome> {
  if (step.kind !== 'quote') return { kind: 'error', message: `quote executor got a '${step.kind}' step`, retryable: false };
  const { repo } = deps;

  const settings = await repo.get(STORAGE_KEYS.settings);
  const zip = (settings.homeZip ?? '').trim();
  if (!settings.features.landedCost || settings.killSwitch || memoryKill(deps.switches) || !isValidZip(zip)) {
    return { kind: 'quote', quote: null }; // feature off or kill switch: no request (R3, R6)
  }

  const zipHash = await zipHashFor(repo, zip);
  const now = repo.now();
  const cached = await readCachedQuote(repo, step.itemId, zipHash, now);
  if (cached !== undefined) {
    return { kind: 'quote', quote: { shipping: cached.shipping, handling: cached.handling } };
  }

  // Again, immediately before the send: settings and the kill switch can move
  // while the cache was read.
  const again = await repo.get(STORAGE_KEYS.settings);
  const zipNow = (again.homeZip ?? '').trim();
  if (!again.features.landedCost || again.killSwitch || memoryKill(deps.switches) || !isValidZip(zipNow) || zipNow !== zip) {
    return { kind: 'quote', quote: null };
  }
  if (readGateClosed(deps)) {
    throw new SgwApiError('paused', 'landed cost: the background quote lane is not accepting requests');
  }

  let quote: CachedQuote | null;
  try {
    // R6: the job quote is a background read even when the run is draining
    // on the interactive lane.
    quote = await deps.api.shippingQuote(step.itemId, zip, 'background');
  } catch (e) {
    scrubZip(e, zip);
  }
  if (quote !== null) {
    try {
      await writeCachedQuote(repo, step.itemId, zipHash, quote, now);
    } catch {
      // A failed cache write must not lose the quote already computed.
    }
    try {
      await deps.audit.append({ actor: 'daily-job', kind: 'quote.fetched', itemId: step.itemId, details: {} });
    } catch {
      // A failed audit write must not fail the step.
    }
  }
  return { kind: 'quote', quote };
}

/** R1: the shape the step registry (steps/index.ts) loads. */
export default { kind: 'quote' as const, run: executeQuoteStep };
