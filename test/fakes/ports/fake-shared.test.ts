import { describe, expect, it } from 'vitest';

import type { GcalEventBody } from '../../../src/domain/calendar/types';
import type { ItemDetail, Listing, SearchQuery } from '../../../src/domain/types';
import { CalendarApiError, GoogleAuthError, SgwApiError } from '../../../src/ports/errors';
import { PORT_NAMES } from '../../../src/messaging/protocol';
import { FakeAuditLog } from './fake-audit-log';
import { FakeCalendarApi } from './fake-calendar-api';
import { FakeClock } from './fake-clock';
import { FakeGoogleAuth } from './fake-google-auth';
import { FakeMessaging } from './fake-messaging';
import { FakeSgwApi } from './fake-sgw-api';
import { FakeSwitches } from './fake-switches';

const listing = (itemId: number): Listing => ({
  itemId,
  title: `Item ${String(itemId)}`,
  currentPrice: 100,
  startingMinimumBid: 100,
  numBids: 0,
  endTime: '2026-10-08T00:00:00.000Z',
  endTimeRaw: '2026-10-07T17:00:00',
  sellerId: 7,
  pickupOnly: false,
  source: 'api',
  observedAt: 1,
});
const detail = (itemId: number): ItemDetail => ({
  ...listing(itemId),
  minimumBid: 150,
  bidIncrement: 50,
  serverTime: '2026-10-07T00:00:00.000Z',
  serverTimeRaw: '2026-10-06T17:00:00',
  isClosed: false,
  isHighBidder: null,
  inWatchlist: null,
  bidHistory: [],
});
const query = (page: number): SearchQuery => ({ searchText: '', categoryIds: [], sellerIds: [], page });

describe('FakeSwitches', () => {
  it('allows by default, blocks per feature or all, and resets', async () => {
    const s = new FakeSwitches();
    expect(await s.writesAllowed('bidding')).toEqual({ ok: true });
    s.block('bidding', 'dry run');
    expect(await s.writesAllowed('bidding')).toEqual({ ok: false, why: 'dry run' });
    expect(await s.writesAllowed('favorites')).toEqual({ ok: true });
    s.killAll();
    expect(await s.writesAllowed('favorites')).toEqual({ ok: false, why: 'kill switch' });
    s.reset();
    expect(await s.writesAllowed('calendar')).toEqual({ ok: true });
    expect(s.checks).toEqual(['bidding', 'bidding', 'favorites', 'favorites', 'calendar']);
  });
});

describe('FakeAuditLog', () => {
  it('stamps seq and at, lists newest first with filters, exports JSON', async () => {
    const clock = new FakeClock(1000);
    const log = new FakeAuditLog(clock);
    const a = await log.append({ actor: 'user', kind: 'favorite.add', itemId: 5, details: {} });
    clock.advance(10);
    await log.append({ actor: 'snipe', kind: 'bid.sent', details: { cents: 500 } });
    await log.append({ actor: 'user', kind: 'favorite.add', details: {} });
    expect(a).toMatchObject({ seq: 1, at: 1000 });
    expect((await log.list({ limit: 10 })).map((e) => e.seq)).toEqual([3, 2, 1]);
    expect((await log.list({ limit: 1 })).map((e) => e.seq)).toEqual([3]);
    expect((await log.list({ limit: 10, before: 3 })).map((e) => e.seq)).toEqual([2, 1]);
    expect((await log.list({ limit: 10, kinds: ['favorite.add'] })).map((e) => e.seq)).toEqual([3, 1]);
    expect(JSON.parse(await log.exportJson())).toHaveLength(3);
    expect(log.kinds).toEqual(['favorite.add', 'bid.sent', 'favorite.add']);
    expect(log.entries).toHaveLength(3);
  });
});

describe('FakeMessaging', () => {
  it('routes send to handlers, resolves undefined for reply-less messages, rejects unhandled replies', async () => {
    const m = new FakeMessaging();
    m.handle('rules.list', () => []);
    expect(await m.send('rules.list', undefined)).toEqual([]);
    await expect(m.send('settings.get', undefined)).rejects.toThrow('no handler');
    await m.send('quick.hideKeyword', { term: 'lamp' });
    expect(m.sent.map((s) => s.type)).toEqual(['rules.list', 'settings.get', 'quick.hideKeyword']);
  });

  it('streams ticks to open ports and stops after disconnect', () => {
    const m = new FakeMessaging();
    const ticks: unknown[] = [];
    const off = m.connect(PORT_NAMES.snipeCountdown, (t) => ticks.push(t));
    expect(m.openPorts(PORT_NAMES.snipeCountdown)).toBe(1);
    const tick = { snipeId: 's1', serverNow: 1, fireAt: 2, state: 'armed' } as const;
    m.emitTick(PORT_NAMES.snipeCountdown, tick);
    off();
    m.emitTick(PORT_NAMES.snipeCountdown, tick);
    expect(ticks).toEqual([tick]);
    expect(m.openPorts(PORT_NAMES.snipeCountdown)).toBe(0);
  });

  it('delivers broadcasts until unsubscribed', () => {
    const m = new FakeMessaging();
    const got: unknown[] = [];
    const off = m.onBroadcast('switches.changed', (p) => got.push(p));
    m.broadcast('switches.changed', undefined as never);
    off();
    m.broadcast('switches.changed', undefined as never);
    expect(got).toHaveLength(1);
  });
});

describe('FakeSgwApi', () => {
  function setup(withSwitches = false) {
    const clock = new FakeClock(10_000);
    const switches = new FakeSwitches();
    const api = new FakeSgwApi({ clock, switches: withSwitches ? switches : undefined });
    return { clock, switches, api };
  }

  it('pages search results 40 at a time and serves details', async () => {
    const { api } = setup();
    api.listings = Array.from({ length: 45 }, (_, i) => listing(i + 1));
    api.details.set(1, detail(1));
    expect((await api.search(query(1), 'interactive')).items).toHaveLength(40);
    const p2 = await api.search(query(2), 'interactive');
    expect(p2).toMatchObject({ total: 45, page: 2 });
    expect(p2.items).toHaveLength(5);
    expect((await api.itemDetail(1, 'interactive')).minimumBid).toBe(150);
    await expect(api.itemDetail(2, 'interactive')).rejects.toBeInstanceOf(SgwApiError);
    expect(await api.showBidModal(1)).toEqual({ sellerId: 7, minimumBid: 150 });
    await expect(api.showBidModal(2)).rejects.toBeInstanceOf(SgwApiError);
  });

  it('quotes shipping from the seed and null otherwise', async () => {
    const { api } = setup();
    api.shipping.set('1:90210', { shipping: 500, handling: 100 });
    expect(await api.shippingQuote(1, '90210', 'background')).toEqual({ shipping: 500, handling: 100 });
    expect(await api.shippingQuote(1, '10001', 'background')).toBeNull();
  });

  it('manages favorites and notes', async () => {
    const { api } = setup();
    api.details.set(1, detail(1));
    await api.addFavorite(1);
    await api.addFavorite(1);
    await api.addFavorite(2);
    expect((await api.favorites('all', 'interactive')).map((f) => f.itemId)).toEqual([1, 2]);
    expect(await api.favorites('close', 'interactive')).toEqual([]);
    const id = api.favoriteList[0]?.watchlistId ?? -1;
    await api.saveFavoriteNote(id, 'nice');
    expect(api.favoriteList[0]?.notes).toBe('nice');
    await api.saveFavoriteNote(999, 'orphan');
    await expect(api.saveFavoriteNote(id, 'x'.repeat(257))).rejects.toMatchObject({ kind: 'schema' });
    await api.removeFavorite(1);
    expect(api.favoriteList.map((f) => f.itemId)).toEqual([2]);
    api.savedSearchList = [{ id: 1, name: 's', query: query(1) }];
    expect(await api.savedSearches('background')).toHaveLength(1);
  });

  it('scripts failures with failNext, once each, FIFO', async () => {
    const { api } = setup();
    api.failNext('search', 'rate-limited', { retryAfterMs: 5000 });
    api.failNext('search', 'server');
    await expect(api.search(query(1), 'interactive')).rejects.toMatchObject({ kind: 'rate-limited', retryAfterMs: 5000 });
    await expect(api.search(query(1), 'interactive')).rejects.toMatchObject({ kind: 'server' });
    await expect(api.search(query(1), 'interactive')).resolves.toBeDefined();
  });

  it('placeBid is idempotent per key and scriptable', async () => {
    const { api } = setup();
    const req = { itemId: 1, sellerId: 7, bidAmount: 500, quantity: 1 } as const;
    const first = await api.placeBid(req, { idempotencyKey: 'k1', timeoutMs: 1000 });
    expect(first).toMatchObject({ kind: 'accepted', observedAt: 10_000 });
    await api.placeBid(req, { idempotencyKey: 'k1', timeoutMs: 1000 });
    expect(api.bids).toHaveLength(1);
    api.bidResult = (r) => ({ ...first, kind: r.bidAmount > 400 ? 'outbid' : 'accepted' });
    expect((await api.placeBid(req, { idempotencyKey: 'k2', timeoutMs: 1000 })).kind).toBe('outbid');
    api.bidResult = { ...first, kind: 'closed' };
    expect((await api.placeBid(req, { idempotencyKey: 'k3', timeoutMs: 1000 })).kind).toBe('closed');
    expect(api.bids).toHaveLength(3);
  });

  it('throws paused for writes when switches say no, and still allows reads', async () => {
    const { api, switches } = setup(true);
    switches.block('bidding', 'dry run');
    switches.block('favorites');
    const req = { itemId: 1, sellerId: 7, bidAmount: 500, quantity: 1 } as const;
    await expect(api.placeBid(req, { idempotencyKey: 'k', timeoutMs: 1 })).rejects.toMatchObject({ kind: 'paused', message: 'dry run' });
    await expect(api.addFavorite(1)).rejects.toMatchObject({ kind: 'paused' });
    expect(api.bids).toHaveLength(0);
    await expect(api.search(query(1), 'interactive')).resolves.toBeDefined();
    switches.reset();
    await expect(api.addFavorite(1)).resolves.toBeUndefined();
  });

  it('samples server time from the clock with the configured offset', async () => {
    const { api } = setup();
    api.serverOffsetMs = 250;
    expect(await api.serverTimeSample()).toEqual({ serverMs: 10_250, sentAt: 9960, receivedAt: 10_000, rttMs: 40, source: 'getCurrentTime' });
    expect(api.calls.map((c) => c.method)).toEqual(['serverTimeSample']);
  });
});

describe('FakeGoogleAuth', () => {
  it('requires connect, mints fresh tokens, reports status, and revokes on disconnect', async () => {
    const a = new FakeGoogleAuth();
    await expect(a.getAccessToken({ interactive: false })).rejects.toBeInstanceOf(GoogleAuthError);
    expect(await a.status()).toMatchObject({ connected: false, provider: 'none', configured: true });
    expect(await a.connect()).toMatchObject({ connected: true, provider: 'pkce', account: 'user@example.test' });
    expect(await a.getAccessToken({ interactive: false })).toBe('fake-token-1');
    expect(await a.getAccessToken({ interactive: false })).toBe('fake-token-2');
    await a.disconnect();
    expect(a.revokes).toBe(1);
    expect((await a.status()).connected).toBe(false);
  });

  it('models needs_interaction, injected failures and an unconfigured build', async () => {
    const a = new FakeGoogleAuth({ connected: true });
    a.needsInteraction = true;
    await expect(a.getAccessToken({ interactive: false })).rejects.toMatchObject({ code: 'needs_interaction' });
    expect(await a.getAccessToken({ interactive: true })).toBe('fake-token-1');
    expect((await a.status()).needsInteraction).toBe(false);
    a.failNext = 'invalid_grant';
    await expect(a.getAccessToken({ interactive: false })).rejects.toMatchObject({ code: 'invalid_grant' });
    expect(await a.getAccessToken({ interactive: false })).toBe('fake-token-2');
    a.failNext = 'user_cancelled';
    await expect(a.connect()).rejects.toMatchObject({ code: 'user_cancelled' });

    const off = new FakeGoogleAuth({ configured: false });
    await expect(off.getAccessToken({ interactive: true })).rejects.toMatchObject({ code: 'not_configured' });
    await expect(off.connect()).rejects.toMatchObject({ code: 'not_configured' });
    expect(a.calls.filter((c) => c.method === 'getAccessToken')).toHaveLength(4);
  });
});

describe('FakeCalendarApi', () => {
  const body = (itemId: string, state: 'open' | 'won' = 'open'): GcalEventBody => ({
    summary: 's',
    description: 'd',
    start: { dateTime: '2026-10-08T00:00:00Z', timeZone: 'UTC' },
    end: { dateTime: '2026-10-08T00:15:00Z', timeZone: 'UTC' },
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { sbwItemId: itemId, sbwGen: '0', sbwState: state } },
  });

  it('creates calendars and looks them up', async () => {
    const api = new FakeCalendarApi();
    const { id } = await api.calendarsInsert('ShopGoodwill Auctions', 'UTC');
    expect(await api.calendarListGet(id)).toEqual({ id });
    expect(await api.calendarListGet('nope')).toBeNull();
    api.seedCalendar('seeded');
    expect(await api.calendarListGet('seeded')).toEqual({ id: 'seeded' });
  });

  it('inserts, conflicts on a duplicate id, gets, and patches', async () => {
    const api = new FakeCalendarApi();
    const ev = await api.eventsInsert('c', { ...body('1'), id: 'abcde1' });
    expect(ev).toMatchObject({ id: 'abcde1', status: 'confirmed', etag: '"etag-1"' });
    await expect(api.eventsInsert('c', { ...body('1'), id: 'abcde1' })).rejects.toMatchObject({ code: 'conflict', status: 409 });
    expect((await api.eventsGet('c', 'abcde1'))?.summary).toBe('s');
    expect(await api.eventsGet('c', 'zzzzz')).toBeNull();
    const patched = await api.eventsPatch('c', 'abcde1', { summary: 'new', description: undefined });
    expect(patched).toMatchObject({ summary: 'new', description: 'd', etag: '"etag-2"' });
    await expect(api.eventsPatch('c', 'missing', {})).rejects.toMatchObject({ code: 'not-found' });
  });

  it('delete cancels (get still sees it, list does not), keeps the id taken, and tolerates absent events', async () => {
    const api = new FakeCalendarApi();
    await api.eventsInsert('c', { ...body('1'), id: 'abcde1' });
    await api.eventsInsert('c', { ...body('2', 'won'), id: 'abcde2' });
    await api.eventsDelete('c', 'abcde1');
    await api.eventsDelete('c', 'ghost');
    await api.eventsDelete('other-cal', 'ghost');
    expect((await api.eventsGet('c', 'abcde1'))?.status).toBe('cancelled');
    expect((await api.eventsListByPrivateProp('c', 'sbwItemId', '1')).length).toBe(0);
    expect((await api.eventsListByPrivateProp('c', 'sbwItemId', '2')).map((e) => e.id)).toEqual(['abcde2']);
    expect(await api.eventsListByPrivateProp('nothing', 'k', 'v')).toEqual([]);
    await expect(api.eventsInsert('c', { ...body('1'), id: 'abcde1' })).rejects.toBeInstanceOf(CalendarApiError);
    expect(api.allEvents('c')).toHaveLength(2);
  });

  it('scripts failures with failNext and records calls', async () => {
    const api = new FakeCalendarApi();
    api.failNext('calendarsInsert', 'rate-limited', 429);
    await expect(api.calendarsInsert('x', 'UTC')).rejects.toMatchObject({ code: 'rate-limited', status: 429 });
    api.failNext('eventsGet', 'offline');
    await expect(api.eventsGet('c', 'e')).rejects.toMatchObject({ code: 'offline' });
    await expect(api.calendarsInsert('x', 'UTC')).resolves.toBeDefined();
    expect(api.calls.map((c) => c.method)).toEqual(['calendarsInsert', 'eventsGet', 'calendarsInsert']);
  });
});
