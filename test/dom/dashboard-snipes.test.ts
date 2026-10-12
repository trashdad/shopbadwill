// T-85: the dashboard Snipes section (prepare → arm, money-safety guards,
// countdown, disarm, outcome list, exposure meter) and the card "Snipe…"
// deep-link badge. Tests first, per the brief:
//   - cannot submit above the per-item cap;
//   - the typo guard requires the retyped amount to equal the max;
//   - the confirmation shows both times (user zone and SGW Pacific);
//   - a dry-run snipe is visibly labelled everywhere it appears.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { badge as snipeLinkBadge } from '../../src/content/ui/badges/snipe-link';
import { formatMoney } from '../../src/domain/money';
import { reduce } from '../../src/domain/snipe/state-machine';
import type { Snipe, SnipeEvent } from '../../src/domain/snipe/types';
import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import type { ItemDetail } from '../../src/domain/types';
import { PORT_NAMES, type MsgPayload } from '../../src/messaging/protocol';
import { itemIdFromSearch, SnipesSection } from '../../src/ui/dashboard/sections/snipes';
import { ExposureMeter, measureExposure } from '../../src/ui/exposure';
import { FakeMessaging } from '../fakes/ports/fake-messaging';
import { FakePermissions } from '../fakes/ports/fake-permissions';

/** The exact dry-run sentence. A renamed constant in the form must not keep this green. */
const DRY_RUN = 'DRY RUN — no bid will be placed';

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  window.history.replaceState(null, '', '/');
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
  /** Defaults to notifications allowed. */
  permissions?: FakePermissions;
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
  const permissions = opts.permissions ?? new FakePermissions({ permissions: ['notifications'] });
  render(h(SnipesSection, { client: m, userTz: TZ, openOptions: () => undefined, permissions }));
  return { m, permissions };
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
    const review = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name: /^review and arm$/i });
    // Exactly the cap is allowed; one cent over is not. The button is disabled
    // and the submit handler (click or Enter) still refuses.
    fireEvent.input(amountInput(/^max bid \(\$\)/i), { target: { value: '50.00' } });
    expect(review().disabled).toBe(false);
    fireEvent.input(amountInput(/^max bid \(\$\)/i), { target: { value: '50.01' } });
    expect(review().disabled).toBe(true);
    fireEvent.input(amountInput(/^max bid \(\$\)/i), { target: { value: '60.00' } });
    expect(review().disabled).toBe(true);
    fireEvent.click(review());
    fireEvent.submit(review().closest('form') as HTMLFormElement);
    expect(await screen.findByText(/per-item: .* exceeds the \$50\.00 per-item cap/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^arm snipe$/i })).toBeNull();
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
    const review = screen.getByRole<HTMLButtonElement>('button', { name: /^review and arm$/i });
    expect(review.disabled).toBe(true);
    fireEvent.click(review);
    fireEvent.submit(review.closest('form') as HTMLFormElement);
    expect(await screen.findByText(/per-day: .* exceed the \$50\.00 daily cap/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^arm snipe$/i })).toBeNull();
    expect(armSent(m)).toHaveLength(0);
  });

  it('cannot submit one cent above the daily cap still remaining, shipping included', async () => {
    vi.useFakeTimers({ now: new Date(NOW), toFake: ['Date'] });
    // $30 already spent. Cap $50, so $20 of landed cost remains. This item's
    // shipping ($9) and handling ($1) leave $10.00 of bid; $10.01 does not fit.
    const spent = snipe({
      id: 'won1',
      dryRun: false,
      state: 'resolved',
      outcome: 'won',
      maxBid: 3000,
      history: [{ at: NOW, from: 'firing', to: 'resolved', why: 'post-read' }],
    });
    const { m } = setup({
      s: settings({ snipe: { ...settings().snipe, caps: { ...generousCaps, perDayMax: 5000 } } }),
      snipes: [spent],
    });
    await prepare(m);
    const review = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name: /^review and arm$/i });
    fireEvent.input(amountInput(/^max bid \(\$\)/i), { target: { value: '10.00' } });
    expect(review().disabled).toBe(false);
    fireEvent.input(amountInput(/^max bid \(\$\)/i), { target: { value: '10.01' } });
    expect(review().disabled).toBe(true);
    fireEvent.click(review());
    expect(await screen.findByText(/per-day:/)).toBeTruthy();
    expect(armSent(m)).toHaveLength(0);
  });

  it('the daily cap still remaining counts a sent bid and an Unconfirmed one (T-80b), not a proven not-sent one', async () => {
    vi.useFakeTimers({ now: new Date(NOW), toFake: ['Date'] });
    // Cap $50. A sent $15 bid ending the same day and an Unconfirmed $10 one
    // resolved today leave $25 of landed cost; this item's $9 shipping and $1
    // handling leave $15.00 of bid. A not-sent $20 attempt counts for nothing.
    const sent = snipe({
      id: 'sent1',
      title: 'Sent bowl',
      dryRun: false,
      state: 'sent',
      maxBid: 1500,
      attempt: { sentAt: NOW - 1000, idempotencyKey: 'k' },
    });
    const resolved = (id: string, attempt: Partial<Snipe['attempt']>, maxBid: number): Snipe =>
      snipe({
        id,
        title: `Resolved ${id}`,
        dryRun: false,
        state: 'resolved',
        outcome: 'network',
        maxBid,
        attempt: { sentAt: NOW - 1000, idempotencyKey: id, ...attempt },
        history: [{ at: NOW, from: 'sent', to: 'resolved', why: 'post-read failed' }],
      });
    const { m } = setup({
      s: settings({ snipe: { ...settings().snipe, caps: { ...generousCaps, perDayMax: 5000 } } }),
      snipes: [sent, resolved('u1', { ambiguous: true }, 1000), resolved('ns1', { notSent: true }, 2000)],
    });
    await prepare(m);
    const review = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name: /^review and arm$/i });
    fireEvent.input(amountInput(/^max bid \(\$\)/i), { target: { value: '15.00' } });
    expect(review().disabled).toBe(false);
    fireEvent.input(amountInput(/^max bid \(\$\)/i), { target: { value: '15.01' } });
    expect(review().disabled).toBe(true);
    fireEvent.click(review());
    expect(await screen.findByText(/per-day: \$50\.01 would exceed the \$50\.00 daily cap/)).toBeTruthy();
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
    // One cent off is not the max. A click must not send, even though the
    // button is disabled (the handler refuses; disabled is not the only guard).
    fireEvent.input(confirm, { target: { value: '75.01' } });
    expect(armButton().disabled).toBe(true);
    expect(screen.getByText(/That is not the amount/)).toBeTruthy();
    // Bypassing the disabled attribute must still not send: the handler compares cents.
    armButton().disabled = false;
    fireEvent.click(armButton());
    expect(armSent(m)).toHaveLength(0);
    // Same cents, different spelling: "$75.00" matches 7500 and enables the button.
    fireEvent.input(confirm, { target: { value: '$75.00' } });
    expect(armButton().disabled).toBe(false);
    // A dollar off, then back. One cent was already refused above.
    fireEvent.input(confirm, { target: { value: '74.00' } });
    expect(armButton().disabled).toBe(true);
    fireEvent.input(confirm, { target: { value: '75' } });
    expect(armButton().disabled).toBe(false);
    fireEvent.click(armButton());
    await waitFor(() => {
      expect(armSent(m)).toHaveLength(1);
    });
    const sent = armSent(m)[0]?.payload as { typedConfirmation?: string; snipe: Snipe };
    expect(sent.typedConfirmation).toBe('75');
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
    // Max, estimated all-in with the known shipping and handling, and the end
    // in both zones. The time node is formatDual's own string.
    expect(region.getByText('Max bid: $20.00')).toBeTruthy();
    expect(region.getByText('Estimated all-in: $30.00 (max $20.00 + shipping $9.00 + handling $1.00)')).toBeTruthy();
    // The end with its DATE, in the user's zone and in SGW Pacific (ruling 3).
    expect(region.getByText('Wed Oct 7, 10:18:30 PM EDT (7:18:30 PM PT)')).toBeTruthy();
  });

  describe('the confirmation end date (ruling 3)', () => {
    async function confirmFor(endTime: string, userTz = TZ): Promise<HTMLElement> {
      const m = new FakeMessaging();
      m.handle('settings.get', () => settings({ snipe: { ...settings().snipe, caps: generousCaps } }));
      m.handle('snipe.list', () => []);
      m.handle('snipe.prepare', ({ itemId }) => ({ detail: detail({ itemId, endTime }), estAllIn: 2349, caps: { ok: true, violations: [] } }));
      render(h(SnipesSection, { client: m, userTz, openOptions: () => undefined }));
      await prepare(m);
      fireEvent.input(amountInput(/^max bid \(\$\)/i), { target: { value: '20.00' } });
      fireEvent.click(screen.getByRole('button', { name: /^review and arm$/i }));
      return (await screen.findByText(/^review your snipe$/i)).closest('div') as HTMLElement;
    }

    it('across midnight, each side shows its own date', async () => {
      // 12:30 AM Thursday in New York is still 9:30 PM Wednesday in Pacific.
      const region = within(await confirmFor('2026-10-08T04:30:00.000Z'));
      expect(region.getByText('Thu Oct 8, 12:30:00 AM EDT (Wed Oct 7, 9:30:00 PM PT)')).toBeTruthy();
    });

    it('at a DST boundary, each zone uses its own offset that night', async () => {
      // 2026-11-01: New York falls back at 06:00Z, Pacific at 09:00Z. At 06:30Z
      // New York is on EST (1:30 AM, the second one) while Pacific is still PDT.
      expect(within(await confirmFor('2026-11-01T06:30:00.000Z')).getByText('Sun Nov 1, 1:30:00 AM EST (Sat Oct 31, 11:30:00 PM PT)')).toBeTruthy();
      cleanup();
      // An hour earlier is the first 1:30 AM (EDT) in New York.
      expect(within(await confirmFor('2026-11-01T05:30:00.000Z')).getByText('Sun Nov 1, 1:30:00 AM EDT (Sat Oct 31, 10:30:00 PM PT)')).toBeTruthy();
    });
  });

  it('parses dollar text into cents and refuses junk', async () => {
    // $1,234.56 is over the default per-item cap. These caps still trip the
    // typo guard (3× the $12.99 price), so the big amount must be retyped.
    const high = { perItemMax: 200_000, perDayMax: 200_000, openExposureMax: 200_000, typoMultiplier: 3 as const, typoAbsolute: 2500 };
    const { m } = setup({ s: settings({ snipe: { ...settings().snipe, caps: high } }) });
    await prepare(m);

    const review = (): HTMLButtonElement => screen.getByRole<HTMLButtonElement>('button', { name: /^review and arm$/i });
    for (const junk of ['12.345', '1e2', 'abc', '12.5.0']) {
      fireEvent.input(amountInput(/^max bid \(\$\)/i), { target: { value: junk } });
      fireEvent.click(review());
      fireEvent.submit(review().closest('form') as HTMLFormElement);
      expect(screen.queryByRole('button', { name: /^arm snipe$/i })).toBeNull();
    }
    expect(screen.getByText(/Enter the max in dollars/)).toBeTruthy();
    expect(armSent(m)).toHaveLength(0);

    const armText = async (text: string, cents: number, confirm?: string): Promise<void> => {
      const before = armSent(m).length;
      fireEvent.input(amountInput(/^max bid \(\$\)/i), { target: { value: text } });
      fireEvent.click(review());
      const region = within((await screen.findByText(/^review your snipe$/i)).closest('div') as HTMLElement);
      expect(region.getByText(`Max bid: ${formatMoney(cents)}`)).toBeTruthy();
      if (confirm !== undefined) {
        fireEvent.input(amountInput(/^type the amount to confirm$/i), { target: { value: confirm } });
      }
      fireEvent.click(screen.getByRole('button', { name: /^arm snipe$/i }));
      await waitFor(() => {
        expect(armSent(m)).toHaveLength(before + 1);
      });
      const sent = armSent(m).at(-1)?.payload as { snipe: Snipe };
      expect(sent.snipe.maxBid).toBe(cents);
      expect(Number.isSafeInteger(sent.snipe.maxBid)).toBe(true);
      // Wait until the arm promise has reset the form, then prepare the next amount.
      await screen.findByText(/Snipe armed/);
      await prepare(m);
    };

    // "12.5" and "12.50" are the same 1250 cents. "12.10" is 1210, which
    // `12.10 * 100` is not.
    await armText('12.50', 1250);
    await armText('12.5', 1250);
    await armText('12.10', 1210);
    await armText('$1,234.56', 123456, '$1,234.56');
  });

  it('renders a hostile title as text, never as HTML', async () => {
    // A quote would break out of an HTML-string attribute. The DOM API must keep it text.
    const title = '<img src=x onerror=alert(1)>"><img src=y>';
    setup({ snipes: [snipe({ title, dryRun: false })] });
    const link = await screen.findByRole('link', { name: title });
    expect(document.body.querySelector('img')).toBeNull();
    expect(link.textContent).toBe(title);
    expect(link.innerHTML).not.toContain('<img');
    expect(link.innerHTML).toContain('&lt;img');
  });

  it('a dry-run snipe is visibly labelled everywhere it appears', async () => {
    const { m } = setup({
      s: settings({
        dryRun: { favorites: true, calendar: true, bidding: true },
        snipe: { ...settings().snipe, caps: generousCaps },
      }),
      snipes: [snipe({ id: 'dry', dryRun: true }), snipe({ id: 'live', dryRun: false, title: 'Live bowl' })],
    });
    const list = await screen.findByRole('list', { name: 'Armed snipes' });
    const dryRow = within(list).getByRole('link', { name: 'Vintage Pyrex Butterfly Gold Bowl 403' }).closest('li') as HTMLElement;
    const liveRow = within(list).getByRole('link', { name: 'Live bowl' }).closest('li') as HTMLElement;
    expect(within(dryRow).getByText(DRY_RUN)).toBeTruthy();
    expect(within(liveRow).queryByText(DRY_RUN)).toBeNull();

    await waitFor(() => {
      expect(m.openPorts(PORT_NAMES.snipeCountdown)).toBe(1);
    });
    m.emitTick(PORT_NAMES.snipeCountdown, { snipeId: 'dry', serverNow: NOW, fireAt: END_MS - 1000, state: 'armed' });
    expect(await within(dryRow).findByText(/in \d/)).toBeTruthy();
    expect(within(dryRow).getByText(DRY_RUN)).toBeTruthy();

    await prepare(m);
    const form = screen.getByRole('button', { name: /^review and arm$/i }).closest('form') as HTMLElement;
    expect(within(form.parentElement as HTMLElement).getByText(DRY_RUN)).toBeTruthy();
    const box = screen.getByLabelText<HTMLInputElement>('Dry run (no bid will be placed)');
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    fireEvent.input(amountInput(/^max bid \(\$\)/i), { target: { value: '20.00' } });
    fireEvent.click(screen.getByRole('button', { name: /^review and arm$/i }));
    const confirm = (await screen.findByText(/^review your snipe$/i)).closest('div') as HTMLElement;
    expect(within(confirm).getByText(DRY_RUN)).toBeTruthy();
    // The line that reports the arm names it a dry run with the same words.
    fireEvent.click(screen.getByRole('button', { name: /^arm snipe$/i }));
    expect(await screen.findByText(/^Snipe armed\./)).toBeTruthy();
    expect(screen.getByText(/^Snipe armed\./).textContent).toContain(DRY_RUN);
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
    // The new port is the one that receives ticks. A reconnect that only
    // counted an open port, and did not listen, would leave this unchanged.
    // `act` flushes the tick onto the new port. A reconnect that only reopened
    // the port, and did not listen, never paints "in 5s".
    await act(() => {
      m.emitTick(PORT_NAMES.snipeCountdown, { snipeId: 's1', serverNow: NOW, fireAt: NOW + 5000, state: 'armed' });
    });
    expect(within(row as HTMLElement).getByText('in 5s')).toBeTruthy();
  });

  it('disarm sends snipe.disarm with the id', async () => {
    const { m } = setup({ snipes: [snipe()] });
    const button = await screen.findByRole('button', { name: /^disarm/i });
    fireEvent.click(button);
    await waitFor(() => {
      expect(m.sent.some((s) => s.type === 'snipe.disarm' && (s.payload as { id: string }).id === 's1')).toBe(true);
    });
  });

  it('a sent snipe offers no disarm: the bid may already be out (the reducer and the kill switch refuse it)', async () => {
    setup({
      snipes: [
        snipe({ id: 'armed1', title: 'Armed bowl', dryRun: false }),
        snipe({ id: 'sent1', title: 'Sent bowl', dryRun: false, state: 'sent', attempt: { sentAt: NOW, idempotencyKey: 'k' } }),
      ],
    });
    const list = await screen.findByRole('list', { name: 'Armed snipes' });
    const sentRow = within(list).getByRole('link', { name: 'Sent bowl' }).closest('li') as HTMLElement;
    const armedRow = within(list).getByRole('link', { name: 'Armed bowl' }).closest('li') as HTMLElement;
    expect(within(armedRow).getByRole('button', { name: /^disarm/i })).toBeTruthy();
    expect(within(sentRow).queryByRole('button', { name: /^disarm/i })).toBeNull();
    expect(within(sentRow).getByText(/A bid may already be out: it cannot be stopped now\./)).toBeTruthy();
  });

  describe('the outcome list repeats the copy the reducer settled with (R6)', () => {
    // Each stored snipe below is produced by the real reducer from the event
    // that settles it, so the row is compared with the notification that went
    // out at settle time, not with a copy the test re-derives.
    const OK_CAPS = { ok: true, violations: [] as string[] };
    const SENT_AT = END_MS - 8000;
    const accepted = (isHighBidder: boolean | null) => ({
      kind: 'accepted' as const,
      rawStatus: 200,
      rawResult: 0,
      messageText: '',
      isHighBidder,
      observedAt: SENT_AT + 300,
    });
    const sentLive = (title: string, attempt: Partial<Snipe['attempt']> = {}): Snipe =>
      snipe({
        id: title,
        title,
        dryRun: false,
        state: 'sent',
        fireAt: SENT_AT,
        measured: { firedAt: SENT_AT, rttMs: 100, offsetMs: 0 },
        attempt: { sentAt: SENT_AT, idempotencyKey: `key-${title}`, ...attempt },
        history: [{ at: SENT_AT, from: 'firing', to: 'sent', why: 'sent' }],
      });
    const firingDry = (title: string): Snipe =>
      snipe({
        id: title,
        title,
        dryRun: true,
        state: 'firing',
        fireAt: SENT_AT,
        measured: { firedAt: SENT_AT, rttMs: 100, offsetMs: 0 },
        history: [{ at: SENT_AT, from: 'verified', to: 'firing', why: 'fire' }],
      });
    const closedRead = (over: Partial<ItemDetail> = {}): ItemDetail =>
      detail({ isClosed: true, serverTime: '2026-10-08T02:18:40.000Z', currentPrice: 1500, minimumBid: 1550, ...over });
    /** The stored snipe and the notification the reducer emitted when it settled. */
    function settle(s: Snipe, e: SnipeEvent): { stored: Snipe; title: string; message: string } {
      const r = reduce(s, e, OK_CAPS, { timeZone: TZ });
      expect(r.rejection).toBeNull();
      const n = r.effects.find((x) => x.kind === 'notify');
      if (n?.kind !== 'notify') throw new Error('the settle emitted no notification');
      return { stored: r.next, title: n.title, message: n.message };
    }
    const rowOf = async (title: string): Promise<HTMLElement> =>
      (await screen.findByText((_, el) => el?.tagName === 'STRONG' && el.textContent.endsWith(`: ${title}`))).closest(
        'li',
      ) as HTMLElement;

    it('a proven not-sent bid (T-80b/T-84b) reads "No bid was sent", never Unconfirmed', async () => {
      const ns = settle(sentLive('Not-sent bowl'), { type: 'not-sent', now: SENT_AT + 50, reason: 'the request never left (offline)' });
      expect(ns.title).toBe('Not bid: Not-sent bowl');
      expect(ns.message).toMatch(/^No bid was sent \(the request never left \(offline\)\)/);
      setup({ snipes: [ns.stored] });
      const row = await rowOf('Not-sent bowl');
      expect(within(row).getByText(ns.title)).toBeTruthy();
      expect(within(row).getByText(ns.message)).toBeTruthy();
      expect(row.textContent).not.toMatch(/Unconfirmed|may have been placed/);
    });

    it('a kill disarm (T-86) and a reply-only win (post-read failed: Leading) repeat their own copy', async () => {
      const killed = settle(snipe({ id: 'k1', title: 'Killed bowl', dryRun: false }), {
        type: 'disarm',
        now: NOW,
        by: 'kill',
        why: 'stopped before it could bid',
      });
      const leading = settle(sentLive('Leading bowl', { reply: accepted(true) }), { type: 'post-read-failed', now: END_MS + 7 * 86_400_000 });
      const unconfirmed = settle(sentLive('Ambiguous bowl', { ambiguous: true }), { type: 'post-read-failed', now: END_MS + 7 * 86_400_000 });
      expect(killed.title).toBe('Stopped: Killed bowl');
      expect(leading.title).toBe('Leading: Leading bowl');
      expect(unconfirmed.title).toBe('Unconfirmed: Ambiguous bowl');
      setup({ snipes: [killed.stored, leading.stored, unconfirmed.stored] });
      for (const x of [killed, leading, unconfirmed]) {
        const row = await rowOf(x.stored.title);
        expect(within(row).getByText(x.title)).toBeTruthy();
        expect(within(row).getByText(x.message)).toBeTruthy();
      }
      expect(screen.queryByText(/^Won:/)).toBeNull();
    });

    it('a dry run settled by its measure read, or with the measure failed, repeats its own copy', async () => {
      const measured = settle(firingDry('Measured dry bowl'), {
        type: 'post-read',
        now: SENT_AT + 200,
        detail: detail({ currentPrice: 1500, minimumBid: 1550, serverTime: '2026-10-08T02:18:22.200Z' }),
      });
      const failed = settle(firingDry('Failed dry bowl'), { type: 'post-read-failed', now: SENT_AT + 60_000 });
      setup({ snipes: [measured.stored, failed.stored] });
      for (const x of [measured, failed]) {
        const row = await rowOf(x.stored.title);
        expect(within(row).getByText(x.title)).toBeTruthy();
        expect(within(row).getByText(x.message)).toBeTruthy();
        expect(within(row).getByText(DRY_RUN)).toBeTruthy();
      }
      expect(screen.queryByText(/could not be read, so the result is unknown/)).toBeNull();
    });

    it('a win or a loss settled by the outcome read keeps its heading and never claims the item was not read', async () => {
      const won = settle(sentLive('Won bowl', { reply: accepted(true) }), {
        type: 'post-read',
        now: END_MS + 5000,
        detail: closedRead({ isHighBidder: true }),
      });
      const lost = settle(sentLive('Lost bowl', { reply: accepted(true) }), {
        type: 'post-read',
        now: END_MS + 5000,
        detail: closedRead({ isHighBidder: false, currentPrice: 2500 }),
      });
      // A tie read anonymously: the read saw the item, and still cannot say who leads.
      const unsure = settle(sentLive('Unsure bowl', { ambiguous: true }), {
        type: 'post-read',
        now: END_MS + 5000,
        detail: closedRead({ isHighBidder: null, currentPrice: 2000 }),
      });
      expect(won.title).toBe('Won: Won bowl');
      expect(lost.title).toBe('Lost: Lost bowl');
      expect(unsure.title).toBe('Unconfirmed: Unsure bowl');
      setup({ snipes: [won.stored, lost.stored, unsure.stored] });
      for (const x of [won, lost, unsure]) {
        const row = await rowOf(x.stored.title);
        // The heading the reducer used, and its own stored classifier text.
        expect(within(row).getByText(x.title)).toBeTruthy();
        expect(within(row).getByText(x.stored.outcomeDetail ?? '<missing>')).toBeTruthy();
        expect(row.textContent).not.toMatch(/could not be read|Leading/);
      }
    });
  });

  it('the exposure meter counts armed, sent and unconfirmed snipes against the daily cap', async () => {
    vi.useFakeTimers({ now: new Date(NOW), toFake: ['Date'] });
    const armedA = snipe({ id: 'a1', dryRun: false, maxBid: 2000 });
    const armedB = snipe({ id: 'a2', dryRun: false, maxBid: 3000 });
    // A sent snipe counts, including its known shipping. A dry run does not.
    const sent = snipe({ id: 'sent1', dryRun: false, maxBid: 500, estShipping: 250, state: 'sent' });
    const dry = snipe({ id: 'dry', dryRun: true, maxBid: 99_999, state: 'armed' });
    const unconfirmed = snipe({
      id: 'u1',
      dryRun: false,
      maxBid: 1000,
      state: 'resolved',
      outcome: 'network',
      attempt: { sentAt: END_MS - 8000, ambiguous: true },
      history: [{ at: NOW, from: 'sent', to: 'resolved', why: 'post-read failed' }],
    });
    const rows = [armedA, armedB, sent, dry, unconfirmed];
    const measured = measureExposure(rows, NOW, TZ);
    expect(measured.open.total).toBe(5750);
    expect(measured.open.count).toBe(3);
    expect(measured.spentToday).toBe(1000);
    expect(measured.used).toBe(6750);
    setup({ snipes: rows });
    const bar = await screen.findByRole('progressbar', { name: /exposure/i });
    expect(bar.getAttribute('aria-valuenow')).toBe('6750');
    expect(bar.getAttribute('aria-valuemax')).toBe('10000');
    expect(screen.getByText('Exposure $67.50 of $100.00')).toBeTruthy();
    expect(screen.getByText(/3 armed snipes/)).toBeTruthy();
    expect(screen.getByText(/\$10\.00 spent or unconfirmed today/)).toBeTruthy();
  });

  it('renders the exposure meter on its own, from src/ui/exposure', () => {
    cleanup();
    render(h(ExposureMeter, { used: 1500, cap: 10000 }));
    expect(screen.getByRole('progressbar', { name: /exposure/i }).getAttribute('aria-valuenow')).toBe('1500');
    expect(screen.getByText('Exposure $15.00 of $100.00')).toBeTruthy();
  });

  it('a dashboard tab opened with ?item= prepares that item and does not arm', async () => {
    window.history.replaceState(null, '', `/?item=${String(ITEM_ID)}`);
    const { m } = setup({ s: settings({ snipe: { ...settings().snipe, caps: generousCaps } }) });
    expect(await screen.findByText('Vintage Pyrex Butterfly Gold Bowl 403')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Item id').value).toBe(String(ITEM_ID));
    await waitFor(() => {
      expect(m.sent.some((s) => s.type === 'snipe.prepare' && (s.payload as { itemId: number }).itemId === ITEM_ID)).toBe(true);
    });
    expect(armSent(m)).toHaveLength(0);
  });

  it('a junk ?item= query does not prepare', async () => {
    window.history.replaceState(null, '', '/?item=12.5');
    const { m } = setup({ s: settings({ snipe: { ...settings().snipe, caps: generousCaps } }) });
    await screen.findByRole('button', { name: /^prepare$/i });
    expect(m.sent.some((s) => s.type === 'snipe.prepare')).toBe(false);
    expect(screen.getByLabelText<HTMLInputElement>('Item id').value).toBe('');
    expect(itemIdFromSearch('?item=12.5')).toBeNull();
    expect(itemIdFromSearch('?item=0')).toBeNull();
    expect(itemIdFromSearch('?item=9007199254740993')).toBeNull();
    expect(itemIdFromSearch(`?item=${String(ITEM_ID)}`)).toBe(ITEM_ID);
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

  it('is hidden on an auction that has already ended, and shown while it is open', () => {
    const props = (endTime: string) => ({
      itemId: 7,
      listing: { endTime } as unknown as NonNullable<Parameters<typeof snipeLinkBadge.Component>[0]['listing']>,
      settings: defaultSettings(),
      client: new FakeMessaging(),
      cardRoot: document.body,
      now: NOW,
    });
    render(h(snipeLinkBadge.Component, props(new Date(NOW - 1000).toISOString())));
    expect(screen.queryByRole('button', { name: /^snipe…$/i })).toBeNull();
    cleanup();
    render(h(snipeLinkBadge.Component, props(new Date(NOW + 60_000).toISOString())));
    expect(screen.getByRole('button', { name: /^snipe…$/i })).toBeTruthy();
  });

  it('registers as a card badge picked up by the registry glob', () => {
    expect(snipeLinkBadge.id).toBe('snipe-link');
    expect(snipeLinkBadge.Component).toBeTypeOf('function');
  });
});


describe('T-118 F4: the arm flow warns when notifications are off', () => {
  const WARN = /Notifications are off: you will not be told if this snipe is at risk/;

  it('warns, offers Allow, and still arms', async () => {
    const { m } = setup({ permissions: new FakePermissions(), s: settings({ snipe: { ...settings().snipe, caps: generousCaps } }) });
    expect(await screen.findByText(WARN)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Allow notifications' })).toBeTruthy();
    await prepare(m);
    fireEvent.input(amountInput(/^max bid \(\$\)/i), { target: { value: '20.00' } });
    fireEvent.click(screen.getByRole('button', { name: /^review and arm$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^arm snipe$/i }));
    await waitFor(() => {
      expect(armSent(m)).toHaveLength(1);
    });
  });

  it('Allow asks for the permission inside the click, then the warning goes away', async () => {
    const permissions = new FakePermissions();
    let syncCalls = 0;
    const orig = permissions.request.bind(permissions);
    permissions.request = (p) => {
      syncCalls += 1;
      return orig(p);
    };
    setup({ permissions });
    const allow = await screen.findByRole('button', { name: 'Allow notifications' });
    fireEvent.click(allow);
    expect(syncCalls).toBe(1);
    expect(permissions.requested).toEqual([{ permissions: ['notifications'] }]);
    await waitFor(() => {
      expect(screen.queryByText(WARN)).toBeNull();
    });
  });

  it('says so when the browser refuses', async () => {
    const permissions = new FakePermissions();
    permissions.grantRequests = false;
    setup({ permissions });
    fireEvent.click(await screen.findByRole('button', { name: 'Allow notifications' }));
    expect(await screen.findByText(/did not allow notifications/)).toBeTruthy();
    expect(screen.getByText(WARN)).toBeTruthy();
  });

  it('shows no warning when notifications are allowed', async () => {
    setup();
    await screen.findByText(/No armed snipes/);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByText(WARN)).toBeNull();
  });
});
