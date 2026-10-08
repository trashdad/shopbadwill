import { describe, expect, it } from 'vitest';
import { classifyOutcome } from '../../../../src/domain/snipe/outcome';
import type { Snipe } from '../../../../src/domain/snipe/types';
import type { BidResult, ItemDetail } from '../../../../src/domain/types';

const END = '2026-10-08T02:18:30.000Z';
const END_MS = Date.parse(END);

function snipe(over: Partial<Snipe> = {}): Snipe {
  return {
    id: 's1',
    itemId: 279250057,
    title: 'Blue vase',
    endTime: END,
    endTimeAtArm: END,
    maxBid: 2000,
    leadMs: 8000,
    fallback: 'skip',
    dryRun: false,
    state: 'sent',
    armedAt: END_MS - 3_600_000,
    fireAt: END_MS - 8000,
    attempt: { sentAt: END_MS - 8000 },
    measured: { firedAt: END_MS - 8000, responseAt: END_MS - 7800, rttMs: 200, offsetMs: 40 },
    history: [],
    ...over,
  };
}

function detail(over: Partial<ItemDetail> = {}): ItemDetail {
  return {
    itemId: 279250057,
    title: 'Blue vase',
    currentPrice: 2350,
    startingMinimumBid: 100,
    numBids: 9,
    endTime: END,
    endTimeRaw: '2026-10-07T19:18:30',
    sellerId: 1,
    pickupOnly: false,
    source: 'api',
    observedAt: END_MS + 5000,
    minimumBid: 2400,
    bidIncrement: 50,
    serverTime: new Date(END_MS + 5000).toISOString(),
    serverTimeRaw: '2026-10-07T19:18:35',
    isClosed: true,
    isHighBidder: null,
    inWatchlist: null,
    bidHistory: [],
    ...over,
  };
}

function bid(kind: BidResult['kind'], over: Partial<BidResult> = {}): BidResult {
  return { kind, rawStatus: 200, rawResult: 0, messageText: 'msg', isHighBidder: null, observedAt: END_MS - 7800, ...over };
}

describe('classifyOutcome table', () => {
  const cases: {
    name: string;
    s?: Partial<Snipe>;
    bid: BidResult | null;
    post: Partial<ItemDetail> | null;
    ctx?: Parameters<typeof classifyOutcome>[3];
    outcome: string;
    stamp: 'won' | 'lost' | 'ended-early' | null;
  }[] = [
    { name: 'won (high bidder)', bid: bid('accepted'), post: { isHighBidder: true, currentPrice: 1800 }, outcome: 'won', stamp: 'won' },
    { name: 'outbid (reported)', bid: bid('outbid'), post: { isHighBidder: false }, outcome: 'outbid', stamp: 'lost' },
    { name: 'below-minimum', bid: bid('below-minimum'), post: { minimumBid: 2400 }, outcome: 'below-minimum', stamp: 'lost' },
    { name: 'auth bid result', bid: bid('auth'), post: null, outcome: 'auth', stamp: null },
    { name: 'restricted bid result', bid: bid('restricted'), post: null, outcome: 'auth', stamp: null },
    { name: 'auth abort', bid: null, post: null, s: { attempt: {}, measured: undefined }, ctx: { abort: 'auth' }, outcome: 'auth', stamp: null },
    { name: 'network abort', bid: null, post: null, s: { attempt: {}, measured: undefined }, ctx: { abort: 'network' }, outcome: 'network', stamp: null },
    { name: 'no result and never sent', bid: null, post: null, s: { attempt: {}, measured: undefined }, outcome: 'network', stamp: null },
    { name: 'closed before fire', bid: bid('closed'), post: { currentPrice: 900 }, s: { measured: { firedAt: END_MS - 8000 } }, outcome: 'ended', stamp: 'ended-early' },
    { name: 'ended abort', bid: null, post: null, s: { attempt: {} }, ctx: { abort: 'ended' }, outcome: 'ended', stamp: 'ended-early' },
    { name: 'cap-blocked', bid: null, post: null, s: { attempt: {}, measured: undefined }, ctx: { abort: 'cap' }, outcome: 'cap-blocked', stamp: null },
    { name: 'killed', bid: null, post: null, s: { attempt: {}, measured: undefined }, ctx: { abort: 'killed' }, outcome: 'killed', stamp: null },
    { name: 'dry-run', bid: null, post: { isClosed: false, currentPrice: 1500, minimumBid: 1550 }, s: { dryRun: true }, outcome: 'dry-run', stamp: null },
    { name: 'rejected-unknown', bid: bid('rejected-unknown', { rawStatus: 500 }), post: null, outcome: 'network', stamp: null },
  ];
  it.each(cases)('$name', (c) => {
    const r = classifyOutcome(snipe(c.s), c.bid, c.post ? detail(c.post) : null, c.ctx);
    expect(r.outcome).toBe(c.outcome);
    expect(r.report.outcome).toBe(c.outcome);
    expect(r.stamp?.outcome ?? null).toBe(c.stamp);
    expect(r.notify.kind).toBe('notify');
    expect(r.notify.snipeId).toBe('s1');
    expect(r.notify.message.length).toBeGreaterThan(0);
  });
});

describe('late', () => {
  it('is late when the fire happened after endTime (closed result)', () => {
    const s = snipe({ measured: { firedAt: END_MS + 2300 } });
    const r = classifyOutcome(s, bid('closed'), detail({ currentPrice: 2100 }));
    expect(r.outcome).toBe('late');
    expect(r.timing.firedBeforeEndMs).toBe(-2300);
    expect(r.notify.message).toContain('2.3 s after');
    expect(r.notify.message).toContain('not an outbid');
    expect(r.stamp).toEqual({ kind: 'stampCalendar', snipeId: 's1', outcome: 'lost', finalPrice: 2100 });
  });
  it('is late when there is no bid response and the fire was after the end', () => {
    const s = snipe({ measured: { firedAt: END_MS + 500 } });
    const r = classifyOutcome(s, null, null);
    expect(r.outcome).toBe('late');
    expect(r.stamp).toBeNull();
  });
  it('is not late when fired before the end', () => {
    expect(classifyOutcome(snipe(), bid('closed'), null).outcome).toBe('ended');
  });
});

describe('extended', () => {
  const later = new Date(END_MS + 120_000).toISOString();
  it('is extended when the post-read endTime is after the armed endTime', () => {
    const r = classifyOutcome(
      snipe(),
      bid('accepted', { isHighBidder: true }),
      detail({ isClosed: false, endTime: later, serverTime: new Date(END_MS - 1000).toISOString() }),
    );
    expect(r.outcome).toBe('extended');
    expect(r.final).toBe(false);
    expect(r.report.newEndTime).toBe(later);
    expect(r.stamp).toBeNull();
    expect(r.notify.message).toContain('re-arm');
  });
  it('detects an extension even when snipe.endTime was refreshed to the new end', () => {
    const r = classifyOutcome(
      snipe({ endTime: later }),
      bid('accepted', { isHighBidder: true }),
      detail({ isClosed: false, endTime: later, serverTime: new Date(END_MS - 1000).toISOString() }),
    );
    expect(r.outcome).toBe('extended');
    expect(r.report.detail).toContain(END);
  });
  it('is not extended when the endTime is unchanged', () => {
    const r = classifyOutcome(snipe(), bid('accepted', { isHighBidder: true }), detail({ isHighBidder: true }));
    expect(r.outcome).toBe('won');
  });
  it('a closed item with a later endTime is not extended', () => {
    const r = classifyOutcome(snipe(), bid('accepted'), detail({ endTime: later, isHighBidder: true }));
    expect(r.outcome).toBe('won');
  });
});

describe('copy and detail', () => {
  it('outbid copy gives final price, max, margin and local end time', () => {
    const r = classifyOutcome(snipe(), bid('outbid'), detail({ currentPrice: 2350, isHighBidder: false }), {
      userTz: 'America/New_York',
    });
    expect(r.notify.title).toBe('Lost: Blue vase');
    expect(r.notify.message).toContain('Lost: outbid at $23.50 (your max $20.00), short by $3.50.');
    expect(r.notify.message).toContain('7:18');
    expect(r.notify.message).toContain('ET');
    expect(r.finalPrice).toBe(2350);
    expect(r.marginCents).toBe(350);
    expect(r.stamp).toEqual({ kind: 'stampCalendar', snipeId: 's1', outcome: 'lost', finalPrice: 2350 });
  });
  it('won copy and stamp', () => {
    const r = classifyOutcome(snipe(), bid('accepted'), detail({ currentPrice: 1800, isHighBidder: true }));
    expect(r.notify.message).toContain('Won at $18.00 (your max $20.00)');
    expect(r.stamp).toEqual({ kind: 'stampCalendar', snipeId: 's1', outcome: 'won', finalPrice: 1800 });
  });
  it('infers outcome from price when the read is anonymous', () => {
    expect(classifyOutcome(snipe(), bid('accepted'), detail({ currentPrice: 2100 })).outcome).toBe('outbid');
    expect(classifyOutcome(snipe(), bid('accepted'), detail({ currentPrice: 1900 })).outcome).toBe('won');
  });
  it('does not guess at a tie with no high-bidder flag', () => {
    const r = classifyOutcome(snipe(), bid('accepted'), detail({ currentPrice: 2000 }));
    expect(r.outcome).toBe('network');
    expect(r.notify.message).toContain('Unconfirmed');
    expect(r.stamp).toBeNull();
  });
  it('does not stamp a result while the auction is still open', () => {
    const r = classifyOutcome(
      snipe(),
      bid('accepted', { isHighBidder: true }),
      detail({ isClosed: false, serverTime: new Date(END_MS - 1000).toISOString(), currentPrice: 1800 }),
    );
    expect(r.outcome).toBe('won');
    expect(r.final).toBe(false);
    expect(r.stamp).toBeNull();
  });
  it('ambiguous send is settled from the re-read and says so', () => {
    const r = classifyOutcome(snipe({ attempt: { sentAt: END_MS - 8000, ambiguous: true } }), null, detail({ isHighBidder: true, currentPrice: 1800 }));
    expect(r.outcome).toBe('won');
    expect(r.notify.message).toContain('response was lost');
  });
  it('below-minimum reports the shortfall', () => {
    const r = classifyOutcome(snipe(), bid('below-minimum'), detail({ minimumBid: 2400 }));
    expect(r.marginCents).toBe(400);
    expect(r.notify.message).toContain('short by $4.00');
  });
  it('dry-run says what would have been bid and whether it would have won', () => {
    const win = classifyOutcome(snipe({ dryRun: true }), null, detail({ isClosed: false, serverTime: new Date(END_MS - 8000).toISOString(), currentPrice: 1500, minimumBid: 1550 }));
    expect(win.wouldHaveWon).toBe(true);
    expect(win.notify.message).toContain('Would have bid $20.00');
    expect(win.notify.message).toContain('8.0 s before the end');
    const lose = classifyOutcome(snipe({ dryRun: true }), null, detail({ isClosed: false, serverTime: new Date(END_MS - 8000).toISOString(), currentPrice: 2100, minimumBid: 2150 }));
    expect(lose.wouldHaveWon).toBe(false);
    expect(lose.notify.message).toContain('NOT have won');
    expect(lose.stamp).toBeNull();
  });
  it('report entry carries measured timing', () => {
    const r = classifyOutcome(snipe({ fireAt: END_MS - 8100 }), bid('outbid'), detail());
    expect(r.report.timing).toMatchObject({ firedBeforeEndMs: 8000, fireErrorMs: 100, responseMs: 200, rttMs: 200, offsetMs: 40 });
  });
  it('is pure: does not mutate inputs', () => {
    const s = snipe();
    const copy = structuredClone(s);
    classifyOutcome(s, bid('outbid'), detail());
    expect(s).toEqual(copy);
  });
});

describe('fix round 1', () => {
  it('killed after send never says no bid was placed', () => {
    const r = classifyOutcome(snipe(), null, null, { abort: 'killed' });
    expect(r.outcome).toBe('network');
    expect(r.notify.message).not.toContain('No bid was placed');
    expect(r.notify.message).toContain('may have been placed');
    expect(r.notify.message).toContain('Stopped (killed) after a bid may have been sent');
    expect(r.stamp).toBeNull();
  });
  it('abort with an ambiguous attempt also falls through', () => {
    const r = classifyOutcome(snipe({ attempt: { ambiguous: true } }), null, null, { abort: 'cap' });
    expect(r.outcome).toBe('network');
  });
  it('abort after a registered bid uses the bid evidence', () => {
    const r = classifyOutcome(snipe(), bid('outbid'), detail({ isHighBidder: false }), { abort: 'network' });
    expect(r.outcome).toBe('outbid');
  });
  it('null bidResult with price below max is unconfirmed, not won', () => {
    const r = classifyOutcome(snipe(), null, detail({ currentPrice: 1500 }));
    expect(r.outcome).toBe('network');
    expect(r.notify.message).toContain('Unconfirmed');
    expect(r.stamp).toBeNull();
  });
  it('open-auction outbid is "Currently outbid", not "Lost"', () => {
    const r = classifyOutcome(
      snipe(),
      bid('outbid'),
      detail({ isClosed: false, serverTime: new Date(END_MS - 1000).toISOString(), isHighBidder: false }),
    );
    expect(r.outcome).toBe('outbid');
    expect(r.final).toBe(false);
    expect(r.notify.title).toMatch(/^Outbid:/);
    expect(r.notify.message).toContain('Currently outbid at $23.50 (auction still open; your max $20.00)');
    expect(r.notify.message).not.toContain('Lost');
    expect(r.stamp).toBeNull();
  });
  it('shows the next-day marker when the end crosses midnight ET', () => {
    const end = '2026-10-08T03:30:00.000Z'; // 8:30 PM PT Oct 7, 11:30 PM ET Oct 7
    const late = '2026-10-08T04:30:00.000Z'; // 9:30 PM PT Oct 7, 12:30 AM ET Oct 8
    const e = Date.parse(late);
    const r = classifyOutcome(
      snipe({ endTime: late, endTimeAtArm: late, measured: { firedAt: e - 8000 } }),
      bid('outbid'),
      detail({ endTime: late, isHighBidder: false }),
      { userTz: 'America/New_York' },
    );
    expect(end).not.toBe(late);
    expect(r.notify.message).toContain('9:30 PM PT');
    expect(r.notify.message).toContain('12:30 AM ET (+1 day)');
  });
  it('dry-run reports a would-be-late fire', () => {
    const r = classifyOutcome(
      snipe({ dryRun: true, measured: { firedAt: END_MS + 1500 } }),
      null,
      detail({ isClosed: false, serverTime: new Date(END_MS - 8000).toISOString(), currentPrice: 1500, minimumBid: 1550 }),
    );
    expect(r.outcome).toBe('dry-run');
    expect(r.notify.message).toContain('1.5 s AFTER the end (would have been late)');
  });
});


describe('T-87b rejected-unknown is settled by re-reading, never "Not bid"', () => {
  const unk = (over: Partial<BidResult> = {}) =>
    bid('rejected-unknown', { rawStatus: 200, rawResult: 77, messageText: 'weird reply', ...over });

  it('post-read isHighBidder true is Won, text mentions the re-read', () => {
    const r = classifyOutcome(snipe(), unk(), detail({ isHighBidder: true, currentPrice: 1800 }));
    expect(r.outcome).toBe('won');
    expect(r.notify.message).toContain('not recognised');
    expect(r.notify.message).toContain('re-reading the item');
    expect(r.notify.message).not.toContain('Not bid');
    expect(r.detail).toContain('status 200');
    expect(r.detail).toContain('result 77');
    expect(r.detail).toContain('weird reply');
  });
  it('post-read price above max is Lost/Outbid', () => {
    const r = classifyOutcome(snipe(), unk(), detail({ currentPrice: 2350 }));
    expect(r.outcome).toBe('outbid');
    expect(r.notify.title).toMatch(/^Lost:/);
    expect(r.notify.message).toContain('re-reading the item');
  });
  it('no high-bidder flag and price below max is Unconfirmed, never Won', () => {
    const r = classifyOutcome(snipe(), unk(), detail({ currentPrice: 1500 }));
    expect(r.outcome).toBe('network');
    expect(r.notify.message).toContain('Unconfirmed');
    expect(r.notify.message).toContain('re-reading the item');
    expect(r.stamp).toBeNull();
  });
  it('no post-read is Unconfirmed, never "Not bid"', () => {
    const r = classifyOutcome(snipe(), unk(), null);
    expect(r.outcome).toBe('network');
    expect(r.notify.title).toMatch(/^Unconfirmed:/);
    expect(r.notify.message).not.toContain('Not bid');
    expect(r.notify.message).toContain('not recognised');
    expect(r.detail).toContain('weird reply');
    expect(r.stamp).toBeNull();
  });
  it('the reply\'s own isHighBidder alone does not prove a win', () => {
    const r = classifyOutcome(snipe(), unk({ isHighBidder: true }), detail({ currentPrice: 1500, isHighBidder: null }));
    expect(r.outcome).toBe('network');
    expect(r.stamp).toBeNull();
  });
  it('the reply\'s own isHighBidder false does not prove a loss either', () => {
    const r = classifyOutcome(snipe(), unk({ isHighBidder: false }), detail({ currentPrice: 1500, isHighBidder: null }));
    expect(r.outcome).toBe('network');
  });
});
