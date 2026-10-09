import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { hashDesired } from '../../../../src/domain/calendar/event-builder';
import { eventIdFor } from '../../../../src/domain/calendar/event-id';
import {
  applyOps,
  MAX_RETRIES,
  RETRY_BACKOFF_BASE_MS,
  RETRY_BACKOFF_CAP_MS,
  reconcile,
  retryBackoffMs,
  type ReconcileOp,
  type ReconcileOptions,
  type RecreateStrategy,
} from '../../../../src/domain/calendar/reconciler';
import type { CalendarLink, DesiredEvent } from '../../../../src/domain/calendar/types';

const CAL = 'cal-sbw';
const NOW = Date.parse('2026-10-08T00:00:00.000Z');
const END = '2026-10-08T04:30:00.000Z';
const END2 = '2026-10-08T05:00:00.000Z';

type SbwState = DesiredEvent['privateProps']['sbwState'];

const desired = (itemId: number, o: { gen?: number; end?: string; state?: SbwState; title?: string } = {}): DesiredEvent => {
  const gen = o.gen ?? 0;
  return {
    itemId,
    generation: gen,
    title: o.title ?? `SGW ends: item ${String(itemId)}`,
    description: 'd',
    startUtc: o.end ?? END,
    durationMin: 15,
    sourceUrl: `https://shopgoodwill.com/item/${String(itemId)}`,
    reminders: [60, 15, 5].map((minutes) => ({ method: 'popup' as const, minutes })),
    privateProps: { sbwItemId: String(itemId), sbwGen: String(gen), sbwState: o.state ?? 'open' },
  };
};
const synced = (d: DesiredEvent, over: Partial<CalendarLink> = {}): CalendarLink => ({
  itemId: d.itemId,
  eventId: eventIdFor(d.itemId, d.generation),
  generation: d.generation,
  calendarId: CAL,
  lastSyncedHash: hashDesired(d),
  status: 'synced',
  ...over,
});
const opts = (over: Partial<ReconcileOptions> = {}): ReconcileOptions => ({
  calendarId: CAL,
  isLateAdd: () => false,
  ...over,
});
const only = (ops: ReconcileOp[]): ReconcileOp => {
  expect(ops).toHaveLength(1);
  return ops[0] as ReconcileOp;
};

interface Row {
  name: string;
  desired: DesiredEvent[];
  links: CalendarLink[];
  options?: Partial<ReconcileOptions>;
  expectOp: ReconcileOp['op'];
  check?: (op: ReconcileOp) => void;
}

const a = desired(101);
const rows: Row[] = [
  {
    name: '1 no link -> insert',
    desired: [a],
    links: [],
    expectOp: 'insert',
    check: (o) => { expect(o).toMatchObject({ eventId: 'sbv101g0', hash: hashDesired(a) }); },
  },
  { name: '2 synced, same hash -> noop', desired: [a], links: [synced(a)], expectOp: 'noop' },
  {
    name: '3 end-time change -> patch',
    desired: [desired(101, { end: END2 })],
    links: [synced(a)],
    expectOp: 'patch',
    check: (o) => { expect(o).toMatchObject({ eventId: 'sbv101g0' }); },
  },
  { name: '4 title change -> patch', desired: [desired(101, { title: 'x' })], links: [synced(a)], expectOp: 'patch' },
  {
    name: '5 no longer desired, synced -> delete',
    desired: [],
    links: [synced(a)],
    expectOp: 'delete',
    check: (o) => { expect(o).toMatchObject({ eventId: 'sbv101g0' }); },
  },
  {
    name: '6 no longer desired, pending -> delete',
    desired: [],
    links: [synced(a, { status: 'pending', lastSyncedHash: '' })],
    expectOp: 'delete',
  },
  {
    name: '7 no longer desired, error -> delete',
    desired: [],
    links: [synced(a, { status: 'error', lastError: 'x' })],
    expectOp: 'delete',
  },
  {
    name: '8 no longer desired, already deleted -> noop',
    desired: [],
    links: [synced(a, { status: 'deleted' })],
    expectOp: 'noop',
  },
  {
    name: '9 pending link -> insert',
    desired: [a],
    links: [synced(a, { status: 'pending', lastSyncedHash: '' })],
    expectOp: 'insert',
  },
  {
    name: '10 error link (never synced) -> insert retry 1',
    desired: [a],
    links: [synced(a, { status: 'error', lastSyncedHash: '', lastError: 'boom' })],
    expectOp: 'insert',
    check: (o) => { expect(o).toMatchObject({ retry: 1 }); },
  },
  {
    name: '11 error link (was synced) -> patch retry 1',
    desired: [desired(101, { end: END2 })],
    links: [synced(a, { status: 'error' })],
    expectOp: 'patch',
    check: (o) => { expect(o).toMatchObject({ retry: 1 }); },
  },
  {
    name: '12 error link retry count increments',
    desired: [a],
    links: [synced(a, { status: 'error', lastSyncedHash: '' })],
    options: { retries: { 101: { count: 3, lastAttemptAt: NOW - RETRY_BACKOFF_CAP_MS - 1 } } },
    expectOp: 'insert',
    check: (o) => { expect(o).toMatchObject({ retry: 4 }); },
  },
  {
    name: '13 error link inside backoff window -> noop',
    desired: [a],
    links: [synced(a, { status: 'error', lastSyncedHash: '' })],
    options: { retries: { 101: { count: 2, lastAttemptAt: NOW - 1000 } } },
    expectOp: 'noop',
    check: (o) => { expect(o).toMatchObject({ reason: 'backoff' }); },
  },
  {
    name: '14 error link at the retry cap -> noop (given up)',
    desired: [a],
    links: [synced(a, { status: 'error', lastSyncedHash: '' })],
    options: { retries: { 101: { count: MAX_RETRIES, lastAttemptAt: 0 } } },
    expectOp: 'noop',
    check: (o) => { expect(o).toMatchObject({ reason: 'retry-cap' }); },
  },
  {
    name: '15 error link, no longer desired -> delete retry 1',
    desired: [],
    links: [synced(a, { status: 'error' })],
    expectOp: 'delete',
    check: (o) => { expect(o).toMatchObject({ retry: 1 }); },
  },
  {
    name: '16 outcome won -> stamp',
    desired: [desired(101, { state: 'won' })],
    links: [synced(a)],
    expectOp: 'stamp',
    check: (o) => { expect(o).toMatchObject({ outcome: 'won' }); },
  },
  {
    name: '17 outcome lost -> stamp',
    desired: [desired(101, { state: 'lost' })],
    links: [synced(a)],
    expectOp: 'stamp',
    check: (o) => { expect(o).toMatchObject({ outcome: 'lost' }); },
  },
  {
    name: '18 outcome ended-early -> stamp',
    desired: [desired(101, { state: 'ended-early' })],
    links: [synced(a)],
    expectOp: 'stamp',
    check: (o) => { expect(o).toMatchObject({ outcome: 'ended-early' }); },
  },
  {
    name: '19 already stamped -> noop',
    desired: [desired(101, { state: 'won' })],
    links: [synced(desired(101, { state: 'won' }))],
    expectOp: 'noop',
  },
  {
    name: '20 outcome with no link -> noop (no event for a resolved item)',
    desired: [desired(101, { state: 'lost' })],
    links: [],
    expectOp: 'noop',
  },
  {
    name: '21 outcome on deleted link -> noop (never resurrect)',
    desired: [desired(101, { state: 'lost' })],
    links: [synced(a, { status: 'deleted' })],
    expectOp: 'noop',
  },
  {
    name: '22 cancelled (deleted) link, desired again -> recreate, bump-generation',
    desired: [a],
    links: [synced(a, { status: 'deleted' })],
    options: { strategy: 'bump-generation' },
    expectOp: 'recreate',
    check: (o) => { expect(o).toMatchObject({
        strategy: 'bump-generation',
        generation: 1,
        eventId: 'sbv101g1',
        previousEventId: 'sbv101g0',
      }); },
  },
  {
    name: '23 cancelled (deleted) link, desired again -> recreate, revive',
    desired: [a],
    links: [synced(a, { status: 'deleted' })],
    options: { strategy: 'revive' },
    expectOp: 'recreate',
    check: (o) => { expect(o).toMatchObject({
        strategy: 'revive',
        generation: 0,
        eventId: 'sbv101g0',
        previousEventId: 'sbv101g0',
      }); },
  },
  {
    name: '24 insert inside late-add window flags lateAdd',
    desired: [a],
    links: [],
    options: { isLateAdd: () => true },
    expectOp: 'insert',
    check: (o) => { expect(o).toMatchObject({ lateAdd: true }); },
  },
  {
    name: '25 foreign event id is never touched',
    desired: [],
    links: [synced(a, { eventId: 'someoneelsesevent' })],
    expectOp: 'noop',
    check: (o) => { expect(o).toMatchObject({ reason: 'not-ours' }); },
  },
];

describe('reconcile table', () => {
  it('has 25 cases', () => {
    expect(rows).toHaveLength(25);
  });
  it.each(rows)('$name', (row) => {
    const { ops } = reconcile(row.desired, row.links, NOW, opts(row.options));
    const op = only(ops);
    expect(op.op).toBe(row.expectOp);
    row.check?.(op);
  });
});

describe('reconcile rules', () => {
  it('bumps generation only under bump-generation (both strategies)', () => {
    const links = [synced(a, { status: 'deleted', generation: 2, eventId: eventIdFor(101, 2) })];
    const bump = only(reconcile([a], links, NOW, opts({ strategy: 'bump-generation' })).ops);
    const revive = only(reconcile([a], links, NOW, opts({ strategy: 'revive' })).ops);
    expect(bump).toMatchObject({ op: 'recreate', generation: 3, eventId: 'sbv101g3' });
    expect(revive).toMatchObject({ op: 'recreate', generation: 2, eventId: 'sbv101g2' });
  });
  it('defaults to bump-generation', () => {
    const op = only(reconcile([a], [synced(a, { status: 'deleted' })], NOW, opts()).ops);
    expect(op).toMatchObject({ strategy: 'bump-generation', generation: 1 });
  });
  it('recreate event carries the new generation in its body', () => {
    const op = only(reconcile([a], [synced(a, { status: 'deleted' })], NOW, opts()).ops);
    if (op.op !== 'recreate') throw new Error('expected recreate');
    expect(op.event.generation).toBe(1);
    expect(op.event.privateProps.sbwGen).toBe('1');
  });
  it('ignores links on another calendar', () => {
    const { ops, ignored } = reconcile([], [synced(a, { calendarId: 'primary' })], NOW, opts());
    expect(ops).toEqual([]);
    expect(ignored).toHaveLength(1);
  });
  it('never emits delete, patch or stamp for foreign ids, whatever is desired', () => {
    const foreign = synced(a, { eventId: 'abcde12345' });
    const r = reconcile([a], [foreign], NOW, opts());
    for (const op of r.ops) expect(['delete', 'patch', 'stamp']).not.toContain(op.op);
  });
  it('ignores a link whose id does not match its item', () => {
    const r = reconcile([], [synced(a, { eventId: 'sbv999g0' })], NOW, opts());
    expect(r.ops.map((o) => o.op)).toEqual(['noop']);
  });
  it('backoff doubles and is capped', () => {
    expect(retryBackoffMs(0)).toBe(RETRY_BACKOFF_BASE_MS);
    expect(retryBackoffMs(1)).toBe(RETRY_BACKOFF_BASE_MS * 2);
    expect(retryBackoffMs(60)).toBe(RETRY_BACKOFF_CAP_MS);
  });
  it('orders ops by item id and covers every item once', () => {
    const { ops } = reconcile([desired(300), desired(200)], [synced(desired(100))], NOW, opts());
    expect(ops.map((o) => o.itemId)).toEqual([100, 200, 300]);
  });
  it('does not mutate its inputs', () => {
    const d = [desired(1)];
    const l = [synced(desired(2))];
    const snap = JSON.stringify([d, l]);
    reconcile(d, l, NOW, opts());
    expect(JSON.stringify([d, l])).toBe(snap);
  });
});

describe('idempotence', () => {
  it('running twice yields only noops', () => {
    for (const row of rows) {
      const o = opts(row.options);
      const first = reconcile(row.desired, row.links, NOW, o);
      const next = applyOps(row.links, first.ops, row.desired, CAL);
      const second = reconcile(row.desired, next, NOW, o);
      for (const op of second.ops) expect(op.op, row.name).toBe('noop');
    }
  });
  it('property: reconcile on its own output state yields only noops', () => {
    const itemArb = fc.record({
      id: fc.integer({ min: 1, max: 12 }),
      wanted: fc.boolean(),
      hasLink: fc.boolean(),
      status: fc.constantFrom<CalendarLink['status']>('synced', 'pending', 'error', 'deleted'),
      linkGen: fc.nat({ max: 3 }),
      linkEnd: fc.constantFrom(END, END2),
      end: fc.constantFrom(END, END2),
      state: fc.constantFrom<SbwState>('open', 'won', 'lost', 'ended-early'),
    });
    fc.assert(
      fc.property(
        fc.uniqueArray(itemArb, { selector: (i) => i.id, maxLength: 12 }),
        fc.constantFrom<RecreateStrategy>('bump-generation', 'revive'),
        (items, strategy) => {
          const want: DesiredEvent[] = [];
          const links: CalendarLink[] = [];
          for (const i of items) {
            if (i.wanted) want.push(desired(i.id, { end: i.end, state: i.state, gen: i.linkGen }));
            if (i.hasLink) {
              const old = desired(i.id, { gen: i.linkGen, end: i.linkEnd });
              links.push(
                synced(old, { status: i.status, lastSyncedHash: i.status === 'pending' ? '' : hashDesired(old) }),
              );
            }
          }
          const o = opts({ strategy });
          const first = reconcile(want, links, NOW, o);
          const next = applyOps(links, first.ops, want, CAL);
          const second = reconcile(want, next, NOW, o);
          for (const op of second.ops) expect(op.op).toBe('noop');
        },
      ),
      { numRuns: 500 },
    );
  });
});
