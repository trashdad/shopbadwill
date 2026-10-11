// T-57: the `quote` step executor (R6; T-51 plans the steps, I-07). One
// landed-cost shipping quote per step, on the run's lane (background on a
// tick, interactive while job.runNow drains). It shares the 24 h
// `sbw:quoteCache` with the landedCost.get handler: a fresh entry (same ZIP
// hash) is never re-fetched. It does nothing — outcome `{ kind: 'quote',
// quote: null }` — when the feature is off, the kill switch is on, or homeZip
// is unset or invalid, so a plan made while the feature was on cannot start
// making requests after the user turned it off.
//
// A fetched quote is audited `quote.fetched` for the item (R4: never the ZIP;
// the cache stores only the ZIP's hash). Errors propagate to the runner, which
// maps paused/budget to "not run" and retryable kinds to a paused run.
import { STORAGE_KEYS } from '../../../domain/storage/schema';
import { isValidZip, hashZip, readCachedQuote, writeCachedQuote } from '../../handlers/landed-cost';
import type { JobStep, StepOutcome } from '../../../domain/watches/schema';
import type { StepDeps } from './index';

export async function executeQuoteStep(step: JobStep, deps: StepDeps): Promise<StepOutcome> {
  if (step.kind !== 'quote') return { kind: 'error', message: `quote executor got a '${step.kind}' step`, retryable: false };
  const { repo, lane } = deps;

  const settings = await repo.get(STORAGE_KEYS.settings);
  const zip = (settings.homeZip ?? '').trim();
  if (!settings.features.landedCost || settings.killSwitch || !isValidZip(zip)) {
    return { kind: 'quote', quote: null }; // feature off: no request (R3, R6)
  }

  const zipHash = await hashZip(zip);
  const now = repo.now();
  const cached = await readCachedQuote(repo, step.itemId, zipHash, now);
  if (cached !== undefined) {
    return { kind: 'quote', quote: { shipping: cached.shipping, handling: cached.handling } };
  }

  const quote = await deps.api.shippingQuote(step.itemId, zip, lane);
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
