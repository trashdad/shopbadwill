// Pure calendar reconciler (T-66). Given the desired events and the existing
// links it decides which operations T-67's CalendarSink should run. No I/O,
// no clock: time comes in as `now`. Only events that are ours (our `sbv…g<n>`
// id, on our calendar) are ever patched, stamped or deleted.
import type { EpochMs, IsoUtc, ItemId } from '../types';
import { hashDesired } from './event-builder';
import { eventIdFor } from './event-id';
import type { CalendarLink, DesiredEvent } from './types';

/**
 * How to bring a cancelled/deleted event back (S-5: what Google does with a
 * reused event id).
 * - `bump-generation`: insert under a new id `sbv<item>g<gen+1>`.
 * - `revive`: reuse the id and patch `status: 'confirmed'` back.
 */
export type RecreateStrategy = 'bump-generation' | 'revive';

// S-5 pending: default strategy. Google keeps deleted event ids reserved, so a
// fresh generation is the safe choice until T-11 records the real behaviour.
export const DEFAULT_RECREATE_STRATEGY: RecreateStrategy = 'bump-generation';

/** After this many failed attempts an errored link is left alone (surfaced in the UI, not retried). */
export const MAX_RETRIES = 8;
export const RETRY_BACKOFF_BASE_MS = 60_000;
export const RETRY_BACKOFF_CAP_MS = 30 * 60_000;

/** Wait before retry number `count + 1`: base * 2^count, capped. */
export function retryBackoffMs(count: number): number {
  return Math.min(RETRY_BACKOFF_BASE_MS * 2 ** Math.max(0, Math.floor(count)), RETRY_BACKOFF_CAP_MS);
}

/**
 * T-56's `isLateAdd` (src/domain/notify/late-add.ts) is the only late-add
 * rule (I-18) and is injected. Carry to T-56: the signature is inferred as
 * `(item, now) => boolean`; the item here is `{ itemId, endTime }`.
 */
export type IsLateAddFn = (item: { itemId: ItemId; endTime: IsoUtc }, now: EpochMs) => boolean;

export type Outcome = 'won' | 'lost' | 'ended-early';

interface OpBase {
  itemId: ItemId;
  /** Present when this op is a retry of an errored link: the new attempt count. */
  retry?: number;
}
interface WriteBase extends OpBase {
  eventId: string;
  event: DesiredEvent;
  /** hashDesired(event); stored as the link's lastSyncedHash on success. */
  hash: string;
}

export type ReconcileOp =
  | (WriteBase & { op: 'insert'; lateAdd: boolean })
  | (WriteBase & { op: 'patch' })
  | (WriteBase & { op: 'stamp'; outcome: Outcome })
  | (OpBase & { op: 'delete'; eventId: string })
  | (WriteBase & {
      op: 'recreate';
      strategy: RecreateStrategy;
      generation: number;
      previousEventId: string;
      lateAdd: boolean;
    })
  | (OpBase & {
      op: 'noop';
      reason: 'in-sync' | 'already-deleted' | 'resolved-without-event' | 'backoff' | 'retry-cap' | 'not-ours';
    });

export interface RetryState {
  /** Failed attempts so far. */
  count: number;
  lastAttemptAt: EpochMs;
}

export interface ReconcileOptions {
  /** Our dedicated calendar. Links on any other calendar are never touched. */
  calendarId: string;
  isLateAdd: IsLateAddFn;
  strategy?: RecreateStrategy;
  /** Retry bookkeeping for links in `error`, by item id. Absent means no failed attempts yet. */
  retries?: Readonly<Record<number, RetryState>>;
}

export interface ReconcileResult {
  /** Exactly one op per item, ordered by item id. */
  ops: ReconcileOp[];
  /** Links that were not considered (other calendar, or not our id format). */
  ignored: CalendarLink[];
}

function isOurs(link: CalendarLink, calendarId: string): boolean {
  return link.calendarId === calendarId && link.eventId === eventIdFor(link.itemId, link.generation);
}

/** Same instant, same string: whole seconds, `.000Z`. Unparseable input is left as is. */
function canonicalInstant(iso: string): string {
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? iso : new Date(Math.floor(ms / 1000) * 1000).toISOString();
}

/** The event as it is hashed and sent: canonical start, at the given generation. */
function normalize(d: DesiredEvent, generation: number): DesiredEvent {
  return {
    ...d,
    generation,
    startUtc: canonicalInstant(d.startUtc),
    privateProps: { ...d.privateProps, sbwGen: String(generation) },
  };
}

function outcomeOf(d: DesiredEvent): Outcome | undefined {
  const s = d.privateProps.sbwState;
  return s === 'open' ? undefined : s;
}

export function reconcile(
  desired: readonly DesiredEvent[],
  links: readonly CalendarLink[],
  now: EpochMs,
  options: ReconcileOptions,
): ReconcileResult {
  const strategy = options.strategy ?? DEFAULT_RECREATE_STRATEGY;
  const ignored: CalendarLink[] = [];
  const foreignHere: CalendarLink[] = [];
  const ours = new Map<ItemId, CalendarLink>();
  const stale: CalendarLink[] = [];
  for (const link of links) {
    if (isOurs(link, options.calendarId)) {
      const cur = ours.get(link.itemId);
      if (cur === undefined) {
        ours.set(link.itemId, link);
      } else if (link.generation > cur.generation) {
        stale.push(cur);
        ours.set(link.itemId, link);
      } else if (link.generation < cur.generation) {
        stale.push(link);
      }
    } else {
      ignored.push(link);
      if (link.calendarId === options.calendarId) foreignHere.push(link);
    }
  }
  const want = new Map<ItemId, DesiredEvent>();
  for (const d of desired) want.set(d.itemId, d);

  const ids = new Set<ItemId>([...want.keys(), ...ours.keys()]);
  const ops: ReconcileOp[] = [];

  for (const itemId of [...ids].sort((x, y) => x - y)) {
    const d = want.get(itemId);
    const link = ours.get(itemId);

    const st = options.retries?.[itemId];
    const count = st?.count ?? 0;

    // No longer desired: decided before retry gating, so deleting always works.
    if (d === undefined) {
      if (link === undefined) continue;
      if (link.status === 'deleted') {
        ops.push({ op: 'noop', itemId, reason: 'already-deleted' });
      } else {
        ops.push({
          op: 'delete',
          itemId,
          eventId: link.eventId,
          ...(link.status === 'error' ? { retry: count + 1 } : {}),
        });
      }
      continue;
    }

    // Retry gating for errored links.
    let retry: number | undefined;
    if (link?.status === 'error') {
      if (count >= MAX_RETRIES) {
        ops.push({ op: 'noop', itemId, reason: 'retry-cap' });
        continue;
      }
      if (st !== undefined && now < st.lastAttemptAt + retryBackoffMs(count)) {
        ops.push({ op: 'noop', itemId, reason: 'backoff' });
        continue;
      }
      retry = count + 1;
    }
    const r = retry === undefined ? {} : { retry };

    const outcome = outcomeOf(d);

    if (link === undefined || (link.status === 'deleted' && d.generation > link.generation)) {
      if (outcome !== undefined) {
        ops.push({ op: 'noop', itemId, reason: 'resolved-without-event' });
        continue;
      }
      const nd = normalize(d, d.generation);
      const lateAdd = options.isLateAdd({ itemId, endTime: d.startUtc }, now);
      ops.push({
        op: 'insert',
        itemId,
        eventId: eventIdFor(itemId, d.generation),
        event: nd,
        hash: hashDesired(nd),
        lateAdd,
      });
      continue;
    }

    if (link.status === 'deleted') {
      if (outcome !== undefined) {
        ops.push({ op: 'noop', itemId, reason: 'resolved-without-event' });
        continue;
      }
      const generation = strategy === 'bump-generation' ? Math.max(link.generation, d.generation) + 1 : link.generation;
      const event = normalize(d, generation);
      ops.push({
        op: 'recreate',
        itemId,
        strategy,
        generation,
        eventId: eventIdFor(itemId, generation),
        previousEventId: link.eventId,
        event,
        hash: hashDesired(event),
        lateAdd: options.isLateAdd({ itemId, endTime: d.startUtc }, now),
      });
      continue;
    }

    const event = normalize(d, link.generation);
    const hash = hashDesired(event);
    const base = { itemId, eventId: link.eventId, event, hash, ...r };

    if (link.status === 'pending' || (link.status === 'error' && link.lastSyncedHash === '')) {
      if (outcome !== undefined) {
        ops.push({ op: 'noop', itemId, reason: 'resolved-without-event' });
      } else {
        ops.push({ op: 'insert', ...base, lateAdd: options.isLateAdd({ itemId, endTime: d.startUtc }, now) });
      }
      continue;
    }

    if (link.status === 'synced' && link.lastSyncedHash === hash) {
      ops.push({ op: 'noop', itemId, reason: 'in-sync' });
      continue;
    }
    ops.push(outcome === undefined ? { op: 'patch', ...base } : { op: 'stamp', ...base, outcome });
  }

  // Lower live generations of an item are stale duplicates of ours: delete them.
  for (const l of stale) {
    if (l.status !== 'deleted') ops.push({ op: 'delete', itemId: l.itemId, eventId: l.eventId });
  }

  // A same-calendar link with a foreign id is reported, never touched.
  const seen = new Set(ops.map((o) => o.itemId));
  for (const f of foreignHere) {
    if (!seen.has(f.itemId)) {
      ops.push({ op: 'noop', itemId: f.itemId, reason: 'not-ours' });
      seen.add(f.itemId);
    }
  }
  ops.sort((x, y) => x.itemId - y.itemId);
  return { ops, ignored };
}

/**
 * The link set after every op succeeds. Pure; T-67 uses the real results, this
 * is the model used to prove idempotence (reconcile on its own output).
 */
export function applyOps(
  links: readonly CalendarLink[],
  ops: readonly ReconcileOp[],
  calendarId: string,
): CalendarLink[] {
  const out = new Map<string, CalendarLink>();
  const key = (l: Pick<CalendarLink, 'calendarId' | 'eventId'>): string => `${l.calendarId}\u0000${l.eventId}`;
  for (const l of links) out.set(key(l), l);
  for (const op of ops) {
    if (op.op === 'noop') continue;
    const k = `${calendarId}\u0000${op.eventId}`;
    const prev = out.get(k);
    if (op.op === 'delete') {
      if (prev !== undefined) out.set(k, { ...prev, status: 'deleted', lastError: undefined });
      continue;
    }
    const generation = op.event.generation;
    const next: CalendarLink = {
      itemId: op.itemId,
      eventId: op.eventId,
      generation,
      calendarId,
      lastSyncedHash: op.hash,
      status: 'synced',
    };
    out.set(k, next);
  }
  return [...out.values()];
}
