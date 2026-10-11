// T-85: the dashboard Snipes section (prepare → arm, money-safety guards,
// countdown, disarm, outcome list, exposure meter) and the card "Snipe…"
// deep-link badge. Tests first, per the brief:
//   - cannot submit above the per-item cap;
//   - the typo guard requires the retyped amount to equal the max;
//   - the confirmation shows both times (user zone and SGW Pacific);
//   - a dry-run snipe is visibly labelled everywhere it appears.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { badge as snipeLinkBadge } from '../../src/content/ui/badges/snipe-link';
import type { Snipe } from '../../src/domain/snipe/types';
import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import type { ItemDetail } from '../../src/domain/types';
import { PORT_NAMES, type MsgPayload } from '../../src/messaging/protocol';
import { DRY_RUN_LABEL } from '../../src/ui/dashboard/sections/snipes/arm-form';
import { SnipesSection } from '../../src/ui/dashboard/sections/snipes';
import { FakeMessaging } from '../fakes/ports/fake-messaging';

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const TZ = 'America/New_York';
const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const END = '2026-10-08T02:18:30.000Z';
const END_MS = new Date(END).getTime();
const ITEM_ID = 279250057;

const detail = (over: Partial<ItemDetail> = {}): ItemDetail => ({
  itemId: ITEM_ID,
  title: 'Vintage Pyrex Butterfly Gold Bowl 403',
  currentPrice: 1299,
  startingMinimumBid: 1299,
  numBids: 1,
  endTime: END,
  endTimeRaw: '2026-10-07T19:18:30',
  sellerId: 123,
  sellerName: 'Goodwill of Example',
  categoryId: 45,
  shippingPrice: 900,
  pickupOnly: false,
  source: 'api',
  observedAt: NOW,
  minimumBid: 1349,
  bidIncrement: 50,
  serverTime: '2026-10-07T19:00:00.000Z',
  serverTimeRaw: '2026-10-07T12:00:00',
  isClosed: false,
  isHighBidder: null,
  inWatchlist: null,
  handlingPrice: 100,
  bidHistory: [],
  ...over,
});

const snipe = (over: Partial<Snipe> = {}): Snipe => ({
  id: 's1',
  itemId: ITEM_ID,
  title: 'Vintage Pyrex Butterfly Gold Bowl 403',
  endTime: END,
  endTimeAtArm: END,
  sellerId: 123,
  maxBid: 2000,
  leadMs: 8000,
  fallback: 'early-proxy',
  dryRun: true,
  state: 'armed',
  armedAt: NOW,
  attempt: {},
  history: [{ at: NOW, from: 'draft', to: 'armed', why: 'arm' }],
  ...over,
});

const settings = (over: Partial<Settings> = {}): Settings => {
  const base = defaultSettings();
  return {
    ...base,
    snipe: { ...base.snipe, enabled: true },
    ...over,
  };
};

/** Caps that never block: the per-item/per-day guards under test are asserted explicitly. */
const generousCaps = { perItemMax: 50000, perDayMax: 100000, openExposureMax: 200000, typoMultiplier: 3 as const, typoAbsolute: 2500 };

interface SetupOptions {
  s?: Settings;
  snipes?: Snipe[];
  prepare?: (itemId: number) => { detail: ItemDetail; estAllIn: number | null; caps: { ok: boolean; violations: string[] } };
  arm?: (payload: MsgPayload<'snipe.arm'>) => Snipe;
}

function setup(opts: SetupOptions = {}) {
  const m = new FakeMessaging();
  m.handle('settings.get', () => opts.s ?? settings());
  m.handle('snipe.list', () => opts.snipes ?? []);
  m.handle('snipe.prepare', ({ itemId }) =>
    opts.prepare?.(itemId) ?? { detail: detail({ itemId }), estAllIn: 2349, caps: { ok: true, violations: [] } },
  );
  m.handle('snipe.arm', ({ snipe: s, typedConfirmation }) => {
    if (opts.arm !== undefined) return opts.arm({ snipe: s, typedConfirmation });
    return snipe({
      ...s,
      state: 'armed',
      armedAt: NOW,
      attempt: {},
      history: [{ at: NOW, from: 'draft', to: 'armed', why: 'arm' }],
    });
  });
  m.handle('snipe.disarm', () => undefined);
  render(h(SnipesSection, { client: m, userTz: TZ, openOptions: () => undefined }));
  return { m };
}

const armSent = (m: FakeMessaging): Array<{ type: string; payload: unknown }> =>
  m.sent.filter((s) => s.type === 'snipe.arm');

async function prepare(m: FakeMessaging, itemId = ITEM_ID): Promise<void> {
  fireEvent.input(screen.getByLabelText('Item id'), { target: { value: String(itemId) } });
  fireEvent.click(screen.getByRole('button', { name: /^prepare$/i }));
  await screen.findByText('Vintage Pyrex Butterfly Gold Bowl 403');
  await waitFor(() => {
    expect(m.sent.some((s) => s.type === 'snipe.prepare' && (s.payload as { itemId: number }).itemId === itemId)).toBe(true);
  });
}

const amountInput = (label: RegExp): HTMLInputElement => screen.getByLabelText<HTMLInputElement>(label);

/** A click with isTrusted defined, the way happy-dom tests emulate trusted events. */
function trustedClick(el: Element): void {
  const ev = new MouseEvent('click', { bubbles: true, composed: true, cancelable: true });
  Object.defineProperty(ev, 'isTrusted', { value: true });
  el.dispatchEvent(ev);
}

describe('dashboard snipes: money guards (tests first)', () => {
  it('cannot submit above the per-item cap', async () => {
    const { m } = setup({ s: settings({ snipe: { ...settings().snipe, caps: { ...generousCaps, perItemMax: 5000 } } }) });
    await prepare(m);
    fireEvent.input(amountInput(/^max bid \(\$\)/i), { target: { value: '60.00' } });
    fireEvent.click(screen.getByRole('button', { name: /^review and arm$/i }));
    expect(await screen.findByText(/per-item: .* exceeds the \$50\.00 per-item cap/)).toBeTruthy();
    expect(armSent(m)).toHaveLength(0);
  });

  it('cannot submit above the daily cap remaining', async () => {
    vi.useFakeTimers({ now: new Date(NOW), toFake: ['Date'] });
    const spent = snipe({
      id: 'won1',
      dryRun: false,
      state: 'resolved',
      outcome: 'won',
      maxBid: 4000,
      history: [{ at: NOW, from: 'firing', to: 'resolved', why: 'post-read' }],
    });
    const { m } = setup({
      s: settings({ snipe: { ...settings().snipe, caps: { ...generousCaps, perDayMax: 5000 } } }),
      snipes: [spent],
    });
    await prepare(m);
    fireEvent.input(amountInput(/^max bid \(\$\)/i), { target: { value: '20.00' } });
    fireEvent.click(screen.getByRole('button', { name: /^review and arm$/i }));
    expect(await screen.findByText(/per-day: .* exceed the \$50\.00 daily cap/)).toBeTruthy();
    expect(armSent(m)).toHaveLength(0);
  });

  it('the typo guard requires the retyped amount to equal the max', async () => {
    const { m } = setup({ s: settings({ snipe: { ...settings().snipe, caps: generousCaps } }) });
    await prepare(m);
    fireEvent.input(amountInput(/^max bid \(\$\)/i), { target: { value: '75.00' } });
    fireEvent.click(screen.getByRole('button', { name: /^review and arm$/i }));
    // $75 is far above the $12.99 current price: the domain typo guard trips.
    expect(await screen.findByText(/Type the amount to confirm: \$75\.00/)).toBeTruthy();
    const armButton = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name: /^arm snipe$/i });
    expect(armButton().disabled).toBe(true);
    const confirm = amountInput(/^type the amount to confirm$/i);
    fireEvent.input(confirm, { target: { value: '74.00' } });
    expect(armButton().disabled).toBe(true);
    expect(screen.getByText(/That is not the amount/)).toBeTruthy();
    fireEvent.input(confirm, { target: { value: '75.00' } });
    expect(armButton().disabled).toBe(false);
    fireEvent.click(armButton());
    await waitFor(() => {
      expect(armSent(m)).toHaveLength(1);
    });
    const sent = armSent(m)[0]?.payload as { typedConfirmation?: string; snipe: Snipe };
    expect(sent.typedConfirmation).toBe('75.00');
    expect(sent.snipe.maxBid).toBe(7500);
  });

  it('an amount below the guard arms without a typed confirmation', async () => {
    const { m } = setup({ s: settings({ snipe: { ...settings().snipe, caps: generousCaps } }) });
    await prepare(m);
    fireEvent.input(amountInput(/^max bid \(\$\)/i), { target: { value: '20.00' } });
    fireEvent.click(screen.getByRole('button', { name: /^review and arm$/i }));
    expect(await screen.findByText(/^review your snipe$/i)).toBeTruthy();
    expect(screen.queryByText(/Type the amount to confirm/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^arm snipe$/i }));
    await waitFor(() => {
      expect(armSent(m)).toHaveLength(1);
    });
    const sent = armSent(m)[0]?.payload as { typedConfirmation?: string; snipe: Snipe };
    expect(sent.typedConfirmation).toBeUndefined();
    expect(sent.snipe.maxBid).toBe(2000);
  });

  it('the confirmation shows both times (user zone and SGW Pacific)', async () => {
    const { m } = setup({ s: settings({ snipe: { ...settings().snipe, caps: generousCaps } }) });
    await prepare(m);
    fireEvent.input(amountInput(/^max bid \(\$\)/i), { target: { value: '20.00' } });
    fireEvent.click(screen.getByRole('button', { name: /^review and arm$/i }));
    const confirm = (await screen.findByText(/^review your snipe$/i)).closest('div');
    expect(confirm).not.toBeNull();
    const region = within(confirm as HTMLElement);
    expect(region.getByText(/PT/)).toBeTruthy();
    expect(region.getByText(/ET/)).toBeTruthy();
    expect(region.getAllByText(/\$20\.00/).length).toBeGreaterThanOrEqual(1);
    expect(region.getByText(/estimated all-in: \$30\.00/i)).toBeTruthy();
  });

  it('a dry-run snipe is visibly labelled everywhere it appears', async () => {
    const { m } = setup({
      s: settings({ dryRun: { favorites: true, calendar: true, bidding: true } }),
      snipes: [snipe({ dryRun: true })],
    });
    expect(await screen.findByText(DRY_RUN_LABEL)).toBeTruthy(); // the armed row
    await prepare(m);
    // The form's checkbox is forced on by the global bidding dry run, and the label shows there too.
    expect(screen.getAllByText(DRY_RUN_LABEL).length).toBeGreaterThanOrEqual(2);
    const box = screen.getByLabelText<HTMLInputElement>('Dry run (no bid will be placed)');
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
  });
});

describe('dashboard snipes: prepare, arm, countdown, disarm, outcomes', () => {
  it('prepares an item: next acceptable bid, estimated all-in and the dual end time', async () => {
    const { m } = setup({ s: settings({ snipe: { ...settings().snipe, caps: generousCaps } }) });
    await prepare(m);
    expect(screen.getByText(/\$13\.49/)).toBeTruthy(); // next acceptable bid
    expect(screen.getByText(/\$23\.49/)).toBeTruthy(); // estimated all-in at the next acceptable bid
    expect(screen.getByText(/PT/)).toBeTruthy();
    expect(screen.getByText(/ET/)).toBeTruthy();
  });

  it('an all-in max becomes the bid minus shipping and handling', async () => {
    const { m } = setup({ s: settings({ snipe: { ...settings().snipe, caps: generousCaps } }) });
    await prepare(m);
    fireEvent.click(screen.getByLabelText(/^all-in max/i));
    fireEvent.input(amountInput(/^all-in max \(\$\)/i), { target: { value: '30.00' } });
    fireEvent.click(screen.getByRole('button', { name: /^review and arm$/i }));
    const confirm = (await screen.findByText(/^review your snipe$/i)).closest('div');
    const region = within(confirm as HTMLElement);
    expect(region.getByText(/all-in max: \$30\.00/i)).toBeTruthy();
    expect(region.getByText(/max bid \(all-in minus shipping and handling\): \$20\.00/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^arm snipe$/i }));
    await waitFor(() => {
      expect(armSent(m)).toHaveLength(1);
    });
    const sent = armSent(m)[0]?.payload as { snipe: Snipe };
    expect(sent.snipe.maxBid).toBe(2000);
    expect(sent.snipe.allInMax).toBe(3000);
    expect(sent.snipe.estShipping).toBe(900);
    expect(sent.snipe.estHandling).toBe(100);
  });

  it('counts down from the snipe-countdown port and reconnects on port drop', async () => {
    const { m } = setup({ snipes: [snipe()] });
    await screen.findByRole('button', { name: /^disarm/i });
    await waitFor(() => {
      expect(m.openPorts(PORT_NAMES.snipeCountdown)).toBe(1);
    });
    m.emitTick(PORT_NAMES.snipeCountdown, { snipeId: 's1', serverNow: NOW, fireAt: END_MS - 1000, state: 'armed' });
    const row = screen.getByRole('button', { name: /^disarm/i }).closest('li');
    expect(await within(row as HTMLElement).findByText(/in \d/)).toBeTruthy();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    m.disconnectPorts(PORT_NAMES.snipeCountdown);
    expect(m.openPorts(PORT_NAMES.snipeCountdown)).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(m.openPorts(PORT_NAMES.snipeCountdown)).toBe(1);
  });

  it('disarm sends snipe.disarm with the id', async () => {
    const { m } = setup({ snipes: [snipe()] });
    const button = await screen.findByRole('button', { name: /^disarm/i });
    fireEvent.click(button);
    await waitFor(() => {
      expect(m.sent.some((s) => s.type === 'snipe.disarm' && (s.payload as { id: string }).id === 's1')).toBe(true);
    });
  });

  it('the outcome list uses each outcome’s own classifier copy; a non-final win shows Leading', async () => {
    const won = snipe({
      id: 'w1',
      dryRun: false,
      state: 'resolved',
      outcome: 'won',
      attempt: {
        sentAt: END_MS - 8000,
        reply: { kind: 'accepted', rawStatus: 200, rawResult: 0, messageText: '', isHighBidder: true, observedAt: END_MS - 8000 },
      },
      measured: { firedAt: END_MS - 8100, rttMs: 100 },
      history: [{ at: NOW, from: 'sent', to: 'resolved', why: 'post-read' }],
    });
    const killed = snipe({
      id: 'k1',
      dryRun: false,
      state: 'killed',
      outcome: 'killed',
      attempt: {},
      history: [{ at: NOW, from: 'armed', to: 'killed', why: 'disarm:user' }],
    });
    setup({ snipes: [won, killed] });
    expect(await screen.findByText(/^Leading: Vintage Pyrex Butterfly Gold Bowl 403$/)).toBeTruthy();
    expect(screen.getByText(/^Stopped: Vintage Pyrex Butterfly Gold Bowl 403$/)).toBeTruthy();
    expect(screen.getByText(/Stopped before the bid\. No bid was placed \(your max \$20\.00\)\./)).toBeTruthy();
  });

  it('the exposure meter counts armed, sent and unconfirmed snipes against the daily cap', async () => {
    vi.useFakeTimers({ now: new Date(NOW), toFake: ['Date'] });
    const armedA = snipe({ id: 'a1', dryRun: false, maxBid: 2000 });
    const armedB = snipe({ id: 'a2', dryRun: false, maxBid: 3000 });
    const unconfirmed = snipe({
      id: 'u1',
      dryRun: false,
      maxBid: 1000,
      state: 'resolved',
      outcome: 'network',
      attempt: { sentAt: END_MS - 8000, ambiguous: true },
      history: [{ at: NOW, from: 'sent', to: 'resolved', why: 'post-read failed' }],
    });
    setup({ snipes: [armedA, armedB, unconfirmed] });
    const bar = await screen.findByRole('progressbar', { name: /exposure/i });
    expect(bar.getAttribute('aria-valuenow')).toBe('6000');
    expect(bar.getAttribute('aria-valuemax')).toBe('10000');
    expect(screen.getByText(/Exposure \$60\.00 of \$100\.00/)).toBeTruthy();
  });

  it('the ui.openSnipe deep link pre-fills and prepares (never arms)', async () => {
    const { m } = setup({ s: settings({ snipe: { ...settings().snipe, caps: generousCaps } }) });
    (m.broadcast as unknown as (type: string, payload: unknown) => void)('ui.openSnipe', { itemId: ITEM_ID });
    expect(await screen.findByText('Vintage Pyrex Butterfly Gold Bowl 403')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Item id').value).toBe(String(ITEM_ID));
    await waitFor(() => {
      expect(m.sent.some((s) => s.type === 'snipe.prepare')).toBe(true);
    });
    expect(armSent(m)).toHaveLength(0);
  });
});

describe('the card Snipe… badge (deep link, R1)', () => {
  it('a trusted click sends ui.openSnipe and nothing else', async () => {
    const m = new FakeMessaging();
    render(
      h(snipeLinkBadge.Component, {
        itemId: 7,
        listing: null,
        settings: defaultSettings(),
        client: m,
        cardRoot: document.body,
        now: NOW,
      }),
    );
    const button = screen.getByRole('button', { name: /^snipe…$/i });
    fireEvent.click(button); // untrusted: sends nothing
    expect(m.sent).toHaveLength(0);
    trustedClick(button);
    await waitFor(() => {
      expect(m.sent).toEqual([{ type: 'ui.openSnipe', payload: { itemId: 7 } }]);
    });
  });

  it('registers as a card badge picked up by the registry glob', () => {
    expect(snipeLinkBadge.id).toBe('snipe-link');
    expect(snipeLinkBadge.Component).toBeTypeOf('function');
  });
});

