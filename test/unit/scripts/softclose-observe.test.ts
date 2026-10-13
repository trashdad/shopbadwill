import { describe, expect, it } from 'vitest';
import { parsePacific } from '../../../src/domain/time/pacific';
import type { RequestLogEntry } from '../../../scripts/capture-fixtures';
import {
  analyzeItem,
  assertSoftcloseLog,
  computeVerdict,
  earliestSendMs,
  formatRel,
  labelFor,
  parseDetail,
  parseSearchRows,
  rereadAt,
  requestsRemaining,
  scheduleReads,
  selectItems,
  SC_MAX_REQUESTS,
  SC_MIN_LEAD_MS,
  SC_POST_DELAY_MS,
  SC_SPACING_MS,
  verdictLabel,
  type ItemAnalysis,
  type SearchRow,
} from '../../../scripts/softclose-observe';

const NOW = parsePacific('2026-10-08T01:00:00');
const MIN = 60_000;

const row = (itemId: number, minutesAhead: number, numBids: number, endRaw?: string): SearchRow => {
  const ms = NOW + minutesAhead * MIN;
  return { itemId, endRaw: endRaw ?? '2026-10-08T01:00:00', endMs: ms, numBids };
};

const entry = (seq: number, sentAtMs: number, endedAtMs: number): RequestLogEntry => ({
  seq,
  stepId: `s${String(seq)}`,
  kind: 'api',
  method: 'GET',
  url: 'https://buyerapi.shopgoodwill.com/api/x',
  sentAtMs,
  endedAtMs,
  status: 200,
  sent: { hadCookieHeader: false, hadAuthorizationHeader: false, origin: null, userAgent: 'UA' },
  outFiles: [],
});

describe('parseSearchRows', () => {
  it('reads rows and skips unparseable ones', () => {
    const rows = parseSearchRows({
      searchResults: {
        items: [
          { itemId: 1, endTime: '2026-10-08T01:30:00', numBids: 4 },
          { itemId: 2, endTime: 'garbage', numBids: 9 },
          { itemId: 3, numBids: 1 },
        ],
      },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ itemId: 1, numBids: 4, endMs: parsePacific('2026-10-08T01:30:00') });
  });
  it('throws without searchResults.items', () => {
    expect(() => parseSearchRows({})).toThrow(/no searchResults/);
  });
});

describe('request planning: selectItems', () => {
  it('applies the bid, lead, horizon and precision filters', () => {
    const rows = [
      row(1, 5, 9), // too soon (< 12 min)
      row(2, 30, 2), // too few bids
      row(3, 200, 8), // beyond 3 h
      { ...row(4, 40, 8), endRaw: '2026-10-08T01:40:00.5' }, // fractional
      row(5, 40, 3), // ok
      row(5, 40, 3), // duplicate id
    ];
    const sel = selectItems(rows, NOW);
    expect(sel.chosen.map((r) => r.itemId)).toEqual([5]);
    expect(sel.excluded).toEqual({ fewBids: 1, tooSoon: 1, tooLate: 1, fractionalEnd: 1, duplicate: 1 });
  });
  it('keeps the lead boundary: exactly SC_MIN_LEAD_MS ahead qualifies', () => {
    expect(selectItems([{ ...row(1, 0, 3), endMs: NOW + SC_MIN_LEAD_MS }], NOW).chosen).toHaveLength(1);
    expect(selectItems([{ ...row(1, 0, 3), endMs: NOW + SC_MIN_LEAD_MS - 1 }], NOW).chosen).toHaveLength(0);
  });
  it('picks at most 6, preferring more bids and distinct end times, returned in end order', () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(100 + i, 20 + i * 5, 3 + i));
    const sel = selectItems(rows, NOW);
    expect(sel.chosen).toHaveLength(6);
    expect(sel.chosen.map((r) => r.itemId)).toEqual([104, 105, 106, 107, 108, 109]); // the six with most bids
    const ends = sel.chosen.map((r) => r.endMs);
    expect([...ends].sort((a, b) => a - b)).toEqual(ends);
  });
  it('prefers distinct end times, then fills from duplicates of an end time', () => {
    const a = { ...row(1, 30, 9) };
    const b = { ...row(2, 30, 8) }; // same end as a
    const c = { ...row(3, 50, 3) };
    expect(selectItems([a, b, c], NOW, 2).chosen.map((r) => r.itemId)).toEqual([1, 3]);
    expect(selectItems([a, b, c], NOW, 3).chosen.map((r) => r.itemId)).toEqual([1, 2, 3]);
  });
  it('labels items A, B, C in order', () => {
    expect([0, 1, 5].map(labelFor)).toEqual(['A', 'B', 'F']);
  });
});

describe('scheduleReads and the spacing calculation', () => {
  it('sends each post-read SC_POST_DELAY_MS (>= 10 min) after its end', () => {
    const [at] = scheduleReads([NOW + 30 * MIN], NOW);
    expect(at).toBe(NOW + 30 * MIN + SC_POST_DELAY_MS);
    expect(SC_POST_DELAY_MS).toBeGreaterThanOrEqual(10 * MIN);
  });
  it('pushes reads of items ending together at least SC_SPACING_MS (> 120 s) apart', () => {
    const end = NOW + 30 * MIN;
    const at = scheduleReads([end, end, end, end + 1000], NOW);
    for (let i = 1; i < at.length; i++) expect((at[i] as number) - (at[i - 1] as number)).toBeGreaterThanOrEqual(SC_SPACING_MS);
    expect(SC_SPACING_MS).toBeGreaterThan(120_000);
    expect(at[0]).toBe(end + SC_POST_DELAY_MS);
  });
  it('never starts before the floor (spacing after the last logged request)', () => {
    const floor = NOW + 90 * MIN;
    expect(scheduleReads([NOW + 10 * MIN], floor)).toEqual([floor]);
  });
  it('sorts unsorted ends', () => {
    const at = scheduleReads([NOW + 60 * MIN, NOW + 20 * MIN], NOW);
    expect(at[0]).toBe(NOW + 20 * MIN + SC_POST_DELAY_MS);
  });
  it('earliestSendMs honours the latest END across every log, T-07 included', () => {
    const mine = [entry(1, 1000, 2000)];
    const t07 = [entry(1, 500_000, 500_400), entry(2, 700_000, 700_300)];
    expect(earliestSendMs([mine, t07])).toBe(700_300 + SC_SPACING_MS);
    expect(earliestSendMs([[], []])).toBe(0);
  });
});

describe('request budget', () => {
  it('counts down to zero and never below', () => {
    expect(requestsRemaining(0)).toBe(12);
    expect(requestsRemaining(7)).toBe(5);
    expect(requestsRemaining(12)).toBe(0);
    expect(requestsRemaining(20)).toBe(0);
    expect(SC_MAX_REQUESTS).toBe(12);
  });
  it('assertSoftcloseLog rejects a 13th request and a too-close pair', () => {
    const ok = Array.from({ length: 12 }, (_, i) => entry(i + 1, i * 200_000, i * 200_000 + 500));
    expect(() => { assertSoftcloseLog(ok); }).not.toThrow();
    expect(() => { assertSoftcloseLog([...ok, entry(13, 13 * 200_000, 13 * 200_000 + 5)]); }).toThrow(/cap 12/);
    expect(() => { assertSoftcloseLog([entry(1, 0, 500), entry(2, 60_000, 60_500)]); }).toThrow(/after request 1 ended/);
  });
  it('rereadAt: no re-read once closed or when the budget is gone; otherwise 10 min after the end', () => {
    const base = { serverTimeMs: NOW, endRaw: '2026-10-08T01:00:00', endMs: NOW - 2 * MIN, closed: false, numBids: 3, bids: [] };
    expect(rereadAt({ ...base, closed: true }, 1, 7)).toBeNull();
    expect(rereadAt(base, 1, 12)).toBeNull();
    expect(rereadAt(base, 3, 8)).toBeNull();
    expect(rereadAt(base, 1, 8)).toBe(Math.max(base.endMs + SC_POST_DELAY_MS, NOW + 10 * MIN));
  });
});

const detail = (opts: { end: string; server?: string; closed?: boolean; bids?: Array<[string, boolean?]>; n?: number }): unknown => ({
  endTime: opts.end,
  serverTime: opts.server ?? '2026-10-08T01:50:00.123',
  numberOfBids: opts.n ?? (opts.bids ?? []).length,
  isItemEndTimeExpire: opts.closed ?? true,
  bidHistory: {
    auctionClosed: opts.closed ?? true,
    bidComplete: (opts.bids ?? []).map(([t, retracted]) => ({ bidTime: t, retracted: retracted ?? false })),
    bidSummary: [],
  },
});

describe('parseDetail', () => {
  it('parses times with ms precision and trimmed fractions', () => {
    const d = parseDetail(detail({ end: '2026-10-08T01:30:00', bids: [['2026-10-08T01:29:54.16'], ['2026-10-08T01:29:54.1625']] }));
    expect(d.endMs).toBe(parsePacific('2026-10-08T01:30:00'));
    expect(d.bids.map((b) => b.timeMs % 1000)).toEqual([160, 162]);
    expect(d.closed).toBe(true);
  });
  it('falls back to bidSummary when bidComplete is empty', () => {
    const d = parseDetail({ ...(detail({ end: '2026-10-08T01:30:00' }) as object), bidHistory: { auctionClosed: true, bidComplete: [], bidSummary: [{ time: '2026-10-08T01:29:00.5' }] } });
    expect(d.bids).toHaveLength(1);
  });
  it('rejects a reply with no endTime', () => {
    expect(() => parseDetail({})).toThrow();
  });
});

describe('analyzeItem and computeVerdict (synthetic data)', () => {
  const end = parsePacific('2026-10-08T01:30:00');
  const a = (label: string, d: unknown, atSearch = 3): ItemAnalysis => analyzeItem(label, end, atSearch, parseDetail(d));

  it('a late bid with an unchanged endTime is a hard-close data point', () => {
    const r = a('A', detail({ end: '2026-10-08T01:30:00', bids: [['2026-10-08T01:29:54.16'], ['2026-10-08T01:10:00']], n: 5 }));
    expect(r).toMatchObject({ moved: false, shiftMs: 0, lateBids: 1, bidsAfterOriginalEnd: 0, closedAtRead: true, newBidsSinceSearch: 2, bidsAtSearch: 3 });
    expect(r.lastBidRelMs).toBe(-5840);
  });
  it('ignores retracted bids when finding the last bid', () => {
    const r = a('A', detail({ end: '2026-10-08T01:30:00', bids: [['2026-10-08T01:29:59.9', true], ['2026-10-08T01:20:00']] }));
    expect(r.lastBidRelMs).toBe(-600_000);
    expect(r.lateBids).toBe(0);
  });
  it('a moved endTime with a bid after the original end is soft-close, N = the largest shift', () => {
    const items = [
      a('A', detail({ end: '2026-10-08T01:32:00', bids: [['2026-10-08T01:29:58.5'], ['2026-10-08T01:31:59.25']] })),
      a('B', detail({ end: '2026-10-08T01:31:00', bids: [['2026-10-08T01:30:30.0']] })),
      a('C', detail({ end: '2026-10-08T01:30:00', bids: [['2026-10-08T01:29:00']] })),
    ];
    expect(items[0]).toMatchObject({ moved: true, shiftMs: 120_000, bidsAfterOriginalEnd: 1 });
    const v = computeVerdict(items);
    expect(v).toMatchObject({ kind: 'soft-close', extensionMs: 120_000 });
    expect(verdictLabel(v)).toBe('soft-close(+120 s)');
  });
  it('two items with late bids and no movement give hard-close', () => {
    const items = [
      a('A', detail({ end: '2026-10-08T01:30:00', bids: [['2026-10-08T01:29:57']] })),
      a('B', detail({ end: '2026-10-08T01:30:00', bids: [['2026-10-08T01:29:30']] })),
      a('C', detail({ end: '2026-10-08T01:30:00', bids: [['2026-10-08T01:00:00']] })),
    ];
    expect(computeVerdict(items)).toMatchObject({ kind: 'hard-close', extensionMs: 0 });
  });
  it('one late bid, or none, is inconclusive', () => {
    const one = [a('A', detail({ end: '2026-10-08T01:30:00', bids: [['2026-10-08T01:29:57']] })), a('B', detail({ end: '2026-10-08T01:30:00', bids: [['2026-10-08T01:00:00']] }))];
    expect(computeVerdict(one).kind).toBe('inconclusive');
    expect(computeVerdict([]).kind).toBe('inconclusive');
    expect(verdictLabel(computeVerdict([]))).toBe('inconclusive');
  });
  it('items still open at their read do not count as evidence', () => {
    const open = a('A', detail({ end: '2026-10-08T01:32:00', closed: false, bids: [['2026-10-08T01:29:58']] }));
    expect(computeVerdict([open, open]).kind).toBe('inconclusive');
  });
  it('flags a fractional post-read endTime (precision mismatch)', () => {
    expect(a('A', detail({ end: '2026-10-08T01:30:00.5' })).fractionalFinalEnd).toBe(true);
    expect(a('A', detail({ end: '2026-10-08T01:30:00' })).fractionalFinalEnd).toBe(false);
  });
  it('formats relative times with sign and ms', () => {
    expect(formatRel(-5840)).toBe('-5.840 s');
    expect(formatRel(0)).toBe('+0.000 s');
    expect(formatRel(120_000)).toBe('+120.000 s');
    expect(formatRel(null)).toBe('n/a');
  });
});
