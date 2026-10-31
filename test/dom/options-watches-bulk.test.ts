// T-125: Options → Watches "Add several watches" (bulk add from pasted search addresses).
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSettings } from '../../src/domain/settings/defaults';
import { nextRunAtFor } from '../../src/domain/watches/helpers';
import { WatchSchema, type Watch } from '../../src/domain/watches/schema';
import { WatchesSection } from '../../src/entrypoints/options/sections/watches';
import { parseBulkWatches } from '../../src/entrypoints/options/sections/watches/bulk';
import { FakeMessaging } from '../fakes/ports/fake-messaging';

afterEach(cleanup);

const NOW = 1_800_000_000_000;
const TZ = 'America/Los_Angeles';
const SGW = 'https://shopgoodwill.com/categories/listing';

const existing = (id: string, st: string): Watch =>
  WatchSchema.parse({
    id,
    name: st,
    enabled: true,
    query: { searchText: st, categoryIds: [], sellerIds: [], page: 1 },
    ruleIds: [],
    maxPages: 1,
    favoriteMode: 'sgw',
    calendar: false,
    notify: true,
    nextRunAt: NOW,
    seenItemIds: [],
  });

function app(watches: Watch[] = [], failSaveOf?: string) {
  const fake = new FakeMessaging();
  const store: Watch[] = [...watches];
  const saves: Watch[] = [];
  const sgwCalls: string[] = [];
  fake.handle('settings.get', () => defaultSettings());
  fake.handle('calendar.status', () => ({ connected: true, provider: 'pkce', grantedScopes: [], needsInteraction: false, configured: true }));
  fake.handle('rules.list', () => []);
  fake.handle('watches.list', () => [...store]);
  fake.handle('watches.save', (w) => {
    if (w.name === failSaveOf) throw new Error('disk full');
    saves.push(w);
    store.push(w);
    return undefined;
  });
  fake.handle('watches.importSaved', () => {
    sgwCalls.push('importSaved');
    return { imported: 0, skipped: 0 };
  });
  let n = 0;
  render(
    h(WatchesSection, {
      client: fake,
      now: () => NOW,
      newId: () => `b${String(++n)}`,
      timeZone: TZ,
      getActiveTabUrl: () => Promise.resolve(undefined),
    }),
  );
  return { fake, store, saves, sgwCalls };
}

async function openBulk(text: string): Promise<void> {
  await waitFor(() => {
    expect(screen.queryByText('Loading your watches...')).toBeNull();
  });
  fireEvent.click(screen.getByRole('button', { name: 'Add several watches' }));
  fireEvent.input(screen.getByLabelText('Search addresses, one per line'), { target: { value: text } });
}

const MIX = [
  `Glass bowls | ${SGW}?st=bowl`,
  `${SGW}?st=lamp&p=4&catIds=9`,
  '',
  'not an address at all',
  `Bad params | ${SGW}?st=x&lp=cheap`,
  `${SGW}?st=mug`,
  `Again | ${SGW}?st=lamp`,
  `Somewhere else | https://example.com/categories/listing?st=a`,
].join('\n');

describe('options: Watches bulk add', () => {
  it('previews valid, invalid and duplicate lines and adds nothing yet', async () => {
    const { saves } = app([existing('old', 'mug')]);
    await openBulk(MIX);
    const add = screen.getByRole('list', { name: 'Watches to add' });
    const items = within(add).getAllByRole('listitem').map((li) => li.textContent);
    expect(items).toHaveLength(2);
    expect(items[0]).toContain('Glass bowls');
    expect(items[0]).toContain('"bowl"');
    expect(items[1]).toContain('lamp');
    const skip = screen.getByRole('list', { name: 'Lines that will not be added' });
    const skipped = within(skip).getAllByRole('listitem').map((li) => li.textContent);
    expect(skipped).toHaveLength(5);
    expect(skipped[0]).toMatch(/Line 4.*not an address at all/);
    expect(skipped[1]).toMatch(/Line 5.*could not read: lp/);
    expect(skipped[2]).toMatch(/Line 6.*already a watch/i);
    expect(skipped[3]).toMatch(/Line 7.*same search as line 2/);
    expect(skipped[4]).toMatch(/Line 8.*not a ShopGoodwill search page/);
    expect(screen.getByRole('button', { name: 'Add 2 watches' })).toBeTruthy();
    expect(saves).toHaveLength(0);
  });

  it('Add calls watches.save once per valid line, with single-add defaults, then reports and refreshes', async () => {
    const { saves, store, sgwCalls } = app([existing('old', 'mug')]);
    await openBulk(MIX);
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 watches' }));
    await screen.findByText('Added 2 watches; skipped 5.');
    expect(saves).toHaveLength(2);
    const next = nextRunAtFor(defaultSettings(), NOW, TZ);
    for (const w of saves) {
      expect(WatchSchema.safeParse(w).success).toBe(true);
      expect(w).toMatchObject({ enabled: true, ruleIds: [], maxPages: 1, favoriteMode: 'sgw', calendar: false, notify: true, nextRunAt: next, seenItemIds: [] });
    }
    expect(saves.map((w) => w.id)).toEqual(['b1', 'b2']);
    expect(saves[1]?.query.page).toBe(1);
    expect(Object.keys(saves[1]?.query.extra ?? {})).not.toContain('catIds');
    expect(store).toHaveLength(3);
    const list = await screen.findByRole('list', { name: 'Your watches' });
    await waitFor(() => {
      expect(within(list).getAllByRole('listitem')).toHaveLength(3);
    });
    expect(sgwCalls).toEqual([]);
  });

  it('derives names from the search text when no name is given', async () => {
    const { saves } = app();
    await openBulk([`${SGW}?st=teapot`, `  | ${SGW}?st=vase`, `${SGW}?catIds=5&lp=1`].join('\n'));
    fireEvent.click(screen.getByRole('button', { name: 'Add 3 watches' }));
    await screen.findByText('Added 3 watches; skipped 0.');
    expect(saves.map((w) => w.name)).toEqual(['teapot', 'vase', 'All items in this search']);
  });

  it('the batch notify checkbox is on by default and applies to every new watch', async () => {
    const { saves } = app();
    await openBulk([`${SGW}?st=teapot`, `${SGW}?st=vase`].join('\n'));
    const box = screen.getByLabelText<HTMLInputElement>('Notify me about new matches');
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(box.checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 watches' }));
    await screen.findByText('Added 2 watches; skipped 0.');
    expect(saves.map((w) => w.notify)).toEqual([false, false]);
  });

  it('disables Add when nothing is valid', async () => {
    app();
    await openBulk('nothing here');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add 0 watches' }).disabled).toBe(true);
  });

  it('reports a save that fails and keeps going', async () => {
    const { saves } = app([], 'teapot');
    await openBulk([`${SGW}?st=teapot`, `${SGW}?st=vase`].join('\n'));
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 watches' }));
    await screen.findByText(/Added 1 watch; skipped 0\. 1 could not be saved: "teapot"/);
    expect(saves.map((w) => w.name)).toEqual(['vase']);
  });
});

describe('parseBulkWatches', () => {
  it('ignores blank lines and keeps a name that contains no address', () => {
    const r = parseBulkWatches(`\n  \nName only |\n`, []);
    expect(r.add).toEqual([]);
    expect(r.skip).toHaveLength(1);
    expect(r.skip[0]?.lineNo).toBe(3);
  });
});
