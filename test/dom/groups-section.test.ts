// T-112: the dashboard's Bid groups section (text only). Each group shows its
// items, N, the wins so far and the next end; the risks of winning more than N
// are said plainly; edits are disabled while the group is frozen; items join a
// group through `snipe.arm` with `snipe.groupId`, and a background refusal
// (spacing, freeze, mode) is shown as it comes.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import type { Snipe } from '../../src/domain/snipe/types';
import type { SnipeGroup, SnipeGroupsRecord } from '../../src/domain/storage/schema';
import type { ItemDetail } from '../../src/domain/types';
import type { MsgPayload } from '../../src/messaging/protocol';
import { GROUPS_INTRO, GroupsSection } from '../../src/ui/dashboard/sections/groups';
import { FakeMessaging } from '../fakes/ports/fake-messaging';

afterEach(() => {
  cleanup();
});

const TZ = 'America/New_York';
const MIN = 60_000;
/** Ends well in the future, so nothing is frozen unless a test says so. */
const END_MS = Date.now() + 3 * 60 * MIN;
const iso = (ms: number): string => new Date(ms).toISOString();
const DRY_RUN = 'DRY RUN — no bid will be placed';

const settings = (over: Partial<Settings['dryRun']> = {}): Settings => {
  const base = defaultSettings();
  return { ...base, snipe: { ...base.snipe, enabled: true }, dryRun: { ...base.dryRun, ...over } };
};

const snipe = (id: string, endMs: number, over: Partial<Snipe> = {}): Snipe => ({
  id,
  itemId: 1000 + id.charCodeAt(0),
  title: `Lamp ${id.toUpperCase()}`,
  endTime: iso(endMs),
  endTimeAtArm: iso(endMs),
  maxBid: 2000,
  leadMs: 8000,
  fallback: 'skip',
  dryRun: false,
  state: 'armed',
  armedAt: END_MS - 60 * MIN,
  attempt: {},
  groupId: 'g1',
  history: [{ at: END_MS - 60 * MIN, from: 'draft', to: 'armed', why: 'arm' }],
  ...over,
});

const group = (over: Partial<SnipeGroup> = {}): SnipeGroup => ({
  id: 'g1',
  name: 'Lamps',
  maxWins: 1,
  createdAt: 1,
  updatedAt: 1,
  results: {},
  cancels: {},
  ...over,
});

const detail = (over: Partial<ItemDetail> = {}): ItemDetail => ({
  itemId: 4242,
  title: 'Brass lamp',
  currentPrice: 1000,
  startingMinimumBid: 500,
  numBids: 2,
  endTime: iso(END_MS + 30 * MIN),
  endTimeRaw: '2026-10-07T19:18:30',
  sellerId: 7,
  sellerName: 'Goodwill of Example',
  categoryId: 45,
  shippingPrice: 900,
  pickupOnly: false,
  source: 'api',
  observedAt: END_MS - 60 * MIN,
  minimumBid: 1100,
  bidIncrement: 100,
  serverTime: iso(END_MS - 60 * MIN),
  serverTimeRaw: '2026-10-07T12:00:00',
  isClosed: false,
  isHighBidder: null,
  inWatchlist: null,
  bidHistory: [],
  ...over,
});

function setup(opts: { groups?: SnipeGroup[]; snipes?: Snipe[]; s?: Settings; arm?: (p: MsgPayload<'snipe.arm'>) => Snipe } = {}) {
  const m = new FakeMessaging();
  const record: SnipeGroupsRecord = { version: 1, groups: Object.fromEntries((opts.groups ?? []).map((g) => [g.id, g])) };
  m.handle('groups.list', () => record);
  m.handle('groups.save', () => undefined);
  m.handle('groups.delete', () => undefined);
  m.handle('snipe.list', () => opts.snipes ?? []);
  m.handle('settings.get', () => opts.s ?? settings({ bidding: false }));
  m.handle('snipe.prepare', ({ itemId }) => ({ detail: detail({ itemId }), estAllIn: 2000, caps: { ok: true, violations: [] } }));
  m.handle('snipe.arm', (p) => {
    if (opts.arm !== undefined) return opts.arm(p);
    return { ...snipe('n', END_MS + 30 * MIN), ...p.snipe, state: 'armed' as const, armedAt: 1, history: [] };
  });
  render(h(GroupsSection, { client: m, userTz: TZ, openOptions: () => undefined }));
  return m;
}

async function card(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole('heading', { name });
  const li = heading.closest('li');
  if (li === null) throw new Error('no group card');
  return li;
}

describe('Bid groups section', () => {
  it('says what a group does, including the risk and the caps', async () => {
    setup();
    expect(await screen.findByText(GROUPS_INTRO)).toBeTruthy();
    expect(GROUPS_INTRO).toMatch(/only once a win is confirmed/);
    expect(GROUPS_INTRO).toMatch(/can win more than N/);
    expect(GROUPS_INTRO).toMatch(/at least 2 minutes apart/);
    expect(GROUPS_INTRO).toMatch(/never raises a cap/);
    expect(await screen.findByText('No bid groups yet.')).toBeTruthy();
  });

  it("shows each group's items, N, the wins so far and the next end", async () => {
    const a = snipe('a', END_MS - 30 * MIN, { state: 'resolved', outcome: 'won' });
    const b = snipe('b', END_MS);
    setup({ groups: [group({ maxWins: 2, results: { a: { verdict: 'confirmed', dryRun: false, at: 1, attempts: 1, why: 'won' } } })], snipes: [a, b] });
    const c = await card('Lamps');
    expect(within(c).getByText(/Win at most 2\. Wins so far: 1 of at most 2\./)).toBeTruthy();
    expect(within(c).getByText(/^Next end: .*"Lamp B"\.$/)).toBeTruthy();
    const items = within(c).getByRole('list', { name: 'Items in Lamps' });
    expect(within(items).getByText(/^Lamp A: Won \(confirmed\)\. Ends /)).toBeTruthy();
    expect(within(items).getByText(/^Lamp B: Armed\. Ends /)).toBeTruthy();
  });

  it('says plainly that an unconfirmed win, or a bid that could not be stopped, risks winning more than N', async () => {
    const a = snipe('a', END_MS - 30 * MIN, { state: 'resolved', outcome: 'won' });
    const b = snipe('b', END_MS - 20 * MIN, { state: 'sent', attempt: { sentAt: 1 } });
    const c = snipe('c', END_MS);
    setup({
      groups: [
        group({ results: { a: { verdict: 'unconfirmed', dryRun: false, at: 1, attempts: 6, why: 'the item could not be read after the end' } } }),
        group({
          id: 'g2',
          name: 'Clocks',
          createdAt: 2,
          results: { x: { verdict: 'confirmed', dryRun: false, at: 1, attempts: 1, why: 'won' } },
          cancels: { y: { at: 1, ok: false, why: 'The bid may already be out; nothing can be sent or stopped now.' } },
        }),
      ],
      snipes: [a, c, { ...b, groupId: 'g2', id: 'y', title: 'Clock Y' }, snipe('x', END_MS - 40 * MIN, { groupId: 'g2', title: 'Clock X', state: 'resolved', outcome: 'won' })],
    });
    const lamps = within(await card('Lamps')).getByRole('note', { name: 'Risks in Lamps' });
    expect(lamps.textContent).toMatch(/"Lamp A" may have been won, but the win is not confirmed \(the item could not be read after the end\)\. The group keeps bidding on its other items, so you could win more than 1\./);
    const clocks = within(await card('Clocks')).getByRole('note', { name: 'Risks in Clocks' });
    expect(clocks.textContent).toMatch(/could not stop "Clock Y": The bid may already be out.*A bid already sent cannot be stopped, so you could win more than 1\./);
  });

  it('creates a group with a name and N', async () => {
    const m = setup();
    await screen.findByText('No bid groups yet.');
    fireEvent.input(screen.getByLabelText('Group name'), { target: { value: '  Table lamps ' } });
    fireEvent.input(screen.getByLabelText('Win at most'), { target: { value: '2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
    await waitFor(() => {
      expect(m.sent.filter((s) => s.type === 'groups.save')).toHaveLength(1);
    });
    const sent = m.sent.find((s) => s.type === 'groups.save')?.payload as MsgPayload<'groups.save'>;
    expect(sent).toMatchObject({ name: 'Table lamps', maxWins: 2 });
    expect(sent.id).toMatch(/^grp-[a-z0-9-]+$/);
  });

  it('refuses a bad N locally', async () => {
    const m = setup();
    await screen.findByText('No bid groups yet.');
    fireEvent.input(screen.getByLabelText('Group name'), { target: { value: 'Lamps' } });
    fireEvent.input(screen.getByLabelText('Win at most'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create group' }));
    expect(await screen.findByText(/"Win at most" must be a whole number from 1 to 50\./)).toBeTruthy();
    expect(m.sent.filter((s) => s.type === 'groups.save')).toEqual([]);
  });

  it('while frozen (2 min before the next end) the group cannot be edited or joined, and says why', async () => {
    const soon = Date.now() + 60_000;
    setup({ groups: [group()], snipes: [snipe('b', soon)] });
    const c = await card('Lamps');
    expect(within(c).getByText(/^Frozen until "Lamp B" \(ends .*\) is settled: a group cannot change from 2 minutes before its next end\.$/)).toBeTruthy();
    expect(within(c).getByRole<HTMLButtonElement>('button', { name: 'Save' }).disabled).toBe(true);
    expect(within(c).getByRole<HTMLButtonElement>('button', { name: 'Add an item' }).disabled).toBe(true);
    expect(within(c).getByRole<HTMLButtonElement>('button', { name: 'Delete group' }).disabled).toBe(true);
  });

  it('adds an item through snipe.arm with the group id; the max is checked and confirmed', async () => {
    const m = setup({ groups: [group()], snipes: [] });
    const c = await card('Lamps');
    fireEvent.click(within(c).getByRole('button', { name: 'Add an item' }));
    fireEvent.input(within(c).getByLabelText('Item id'), { target: { value: '4242' } });
    fireEvent.click(within(c).getByRole('button', { name: 'Prepare' }));
    await within(c).findByText('Brass lamp');
    fireEvent.input(within(c).getByLabelText('Max bid ($)'), { target: { value: '20.00' } });
    fireEvent.click(within(c).getByRole('button', { name: 'Review and arm' }));
    expect(await within(c).findByText('Bid group: Lamps. This max counts in full against your caps.')).toBeTruthy();
    fireEvent.click(within(c).getByRole('button', { name: 'Arm in group' }));
    await waitFor(() => {
      expect(m.sent.filter((s) => s.type === 'snipe.arm')).toHaveLength(1);
    });
    const p = m.sent.find((s) => s.type === 'snipe.arm')?.payload as MsgPayload<'snipe.arm'>;
    expect(p.snipe).toMatchObject({ itemId: 4242, maxBid: 2000, groupId: 'g1', dryRun: false });
    expect(await within(c).findByText('Snipe armed in "Lamps".')).toBeTruthy();
  });

  it("shows the background's refusal (e.g. ends too close) as it comes", async () => {
    setup({
      groups: [group()],
      arm: () => {
        throw new Error('Bid group "Lamps": this item ends 10:01 AM PT, only 1 min 10 s from "Lamp A". Items in a group must end at least 2 minutes apart.');
      },
    });
    const c = await card('Lamps');
    fireEvent.click(within(c).getByRole('button', { name: 'Add an item' }));
    fireEvent.input(within(c).getByLabelText('Item id'), { target: { value: '4242' } });
    fireEvent.click(within(c).getByRole('button', { name: 'Prepare' }));
    await within(c).findByText('Brass lamp');
    fireEvent.input(within(c).getByLabelText('Max bid ($)'), { target: { value: '20.00' } });
    fireEvent.click(within(c).getByRole('button', { name: 'Review and arm' }));
    fireEvent.click(await within(c).findByRole('button', { name: 'Arm in group' }));
    expect((await within(c).findByRole('alert')).textContent).toMatch(/at least 2 minutes apart/);
  });

  it('a dry-run group and its arm form carry the DRY RUN label', async () => {
    const a = snipe('a', END_MS - 30 * MIN, { dryRun: true, state: 'resolved', outcome: 'dry-run' });
    setup({
      s: settings({ bidding: true }),
      groups: [group({ maxWins: 2, results: { a: { verdict: 'confirmed', dryRun: true, at: 1, attempts: 1, why: 'would have won' } } })],
      snipes: [a],
    });
    const c = await card('Lamps');
    expect(within(c).getByText(DRY_RUN)).toBeTruthy();
    expect(within(c).getByText(/Lamp A: Would have won \(dry run, confirmed at the close\)\./)).toBeTruthy();
    fireEvent.click(within(c).getByRole('button', { name: 'Add an item' }));
    fireEvent.input(within(c).getByLabelText('Item id'), { target: { value: '4242' } });
    fireEvent.click(within(c).getByRole('button', { name: 'Prepare' }));
    await within(c).findByText('Brass lamp');
    const box = within(c).getByLabelText<HTMLInputElement>('Dry run (no bid will be placed)');
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(within(c).getAllByText(DRY_RUN).length).toBeGreaterThanOrEqual(2);
  });
});
