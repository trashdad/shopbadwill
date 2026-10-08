// T-58: `audit.list` and `audit.undo`. Registered by T-36's register(ctx), not here.
//
// Undo is a real write (e.g. it unfavorites on the user's SGW account), so:
//   - dry-run entries are refused (nothing was ever done);
//   - the write itself is gated inside the adapter (writesAllowed); a refusal
//     (SgwApiError 'paused') becomes "not now: <why>" and the entry stays NOT done;
//   - success appends an `undo` audit entry ({undoneSeq}); an entry is "done" when
//     such an entry exists. The log has no in-place update, so `audit.list` overlays
//     `undo.done` from those entries. A second undo is a no-op;
//   - concurrent undos of one seq share one in-flight promise (one write).
// Kinds with no executor yet are refused ("undo not available yet").
import type { AuditEntry, AuditLog } from '../../domain/audit/types';
import type { Repo } from '../../domain/storage/repo';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import { SgwApiError } from '../../ports/errors';
import type { SgwApi } from '../../ports/sgw-api';
import { parseUnfavoriteRef } from '../jobs/steps/favorite';
import type { Handler } from '../router';

export type UndoKind = NonNullable<AuditEntry['undo']>['kind'];

/** Performs the reverse write. Throws to refuse; resolves when the undo is complete. */
export type UndoExecutor = (ref: string, entry: AuditEntry) => Promise<void>;

export const UNDO_AUDIT_KIND = 'undo';
/** Entries per scan batch in `audit.list` / undo's done check. */
export const SCAN_BATCH = 100;

export interface AuditHandlerDeps {
  audit: AuditLog;
  /** Kinds without an executor are refused with "undo not available yet". */
  executors: Partial<Record<UndoKind, UndoExecutor>>;
}

export function createUndoExecutors(deps: { api: Pick<SgwApi, 'removeFavorite'>; repo: Repo }): Partial<Record<UndoKind, UndoExecutor>> {
  return {
    // favoriteState stays 'favorited' on purpose (T-53): handled, the user owns it now.
    // A worker restart mid-undo (after the write, before the `undo` audit append) leaves the
    // entry not done; a retried removeFavorite on an item already removed is harmless.
    unfavorite: async (ref) => {
      const itemId = parseUnfavoriteRef(ref);
      if (itemId === undefined) throw new Error('This entry has no valid favorite to undo.');
      try {
        await deps.api.removeFavorite(itemId);
      } catch (e) {
        if (e instanceof SgwApiError && e.kind === 'paused') throw new Error(`not now: ${e.message}`, { cause: e });
        throw e;
      }
    },
    // undo.ref = the rule id (T-58 decision, docs/CONTRACT-DECISIONS.md); no writer exists yet.
    disableRule: async (ref) => {
      const hits: string[] = [];
      await deps.repo.update(STORAGE_KEYS.rules, (rules) =>
        rules.map((r) => {
          if (r.id !== ref) return r;
          hits.push(r.id);
          return { ...r, enabled: true, updatedAt: deps.repo.now() };
        }),
      );
      if (hits.length === 0) throw new Error('That rule no longer exists.');
    },
  };
}

export function createAuditHandlers(deps: AuditHandlerDeps): {
  'audit.list': Handler<'audit.list'>;
  'audit.undo': Handler<'audit.undo'>;
} {
  const inFlight = new Map<number, Promise<void>>();

  /**
   * Seqs undone by `undo` entries newer than `minSeq`. An undo entry is always newer
   * than its original, so the scan walks newest-first in batches and stops as soon as
   * it passes `minSeq`: the cost is the entries newer than the page, not the ring.
   */
  const undoneAfter = async (minSeq: number): Promise<Set<number>> => {
    const out = new Set<number>();
    let before: number | undefined;
    for (;;) {
      const batch = await deps.audit.list({ limit: SCAN_BATCH, ...(before === undefined ? {} : { before }) });
      for (const e of batch) {
        if (e.seq <= minSeq) return out;
        const s = e.details['undoneSeq'];
        if (e.kind === UNDO_AUDIT_KIND && typeof s === 'number') out.add(s);
      }
      const last = batch[batch.length - 1];
      if (batch.length < SCAN_BATCH || !last) return out;
      before = last.seq;
    }
  };

  const runUndo = async (seq: number): Promise<void> => {
    const [entry] = await deps.audit.list({ limit: 1, before: seq + 1 });
    if (entry?.seq !== seq) throw new Error('That activity entry no longer exists.');
    const undo = entry.undo;
    if (!undo) throw new Error('That activity cannot be undone.');
    if (entry.dryRun === true) throw new Error('That was a dry run: nothing was done, so there is nothing to undo.');
    if (undo.done === true || (await undoneAfter(seq)).has(seq)) return; // no-op
    const exec = deps.executors[undo.kind];
    if (!exec) throw new Error('Undo not available yet for this kind of activity.');
    await exec(undo.ref, entry);
    await deps.audit.append({
      actor: 'user',
      kind: UNDO_AUDIT_KIND,
      ...(entry.itemId === undefined ? {} : { itemId: entry.itemId }),
      ref: undo.ref,
      details: { undoneSeq: seq, undoKind: undo.kind },
    });
  };

  return {
    'audit.list': async (p) => {
      const page = await deps.audit.list({ limit: p.limit, ...(p.before === undefined ? {} : { before: p.before }) });
      const pending = page.filter((e) => e.undo && e.undo.done !== true).map((e) => e.seq);
      if (pending.length === 0) return page;
      const done = await undoneAfter(Math.min(...pending));
      return page.map((e) => (e.undo && done.has(e.seq) ? { ...e, undo: { ...e.undo, done: true } } : e));
    },
    'audit.undo': async (p) => {
      let run = inFlight.get(p.seq);
      if (!run) {
        run = runUndo(p.seq).finally(() => {
          inFlight.delete(p.seq);
        });
        inFlight.set(p.seq, run);
      }
      await run;
      return undefined;
    },
  };
}
