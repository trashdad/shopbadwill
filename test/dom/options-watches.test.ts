// T-55: the Watches options section, driven through FakeMessaging.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';

import type { AuthStatus } from '../../src/domain/calendar/types';
import type { Rule } from '../../src/domain/rules/schema';
import { defaultSettings } from '../../src/domain/settings/defaults';
import { WatchSchema, type Watch } from '../../src/domain/watches/schema';
import { loadSections } from '../../src/entrypoints/options/registry';
import { activeTabUrl, section, WatchesSection } from '../../src/entrypoints/options/sections/watches';
import { RulesSection } from '../../src/entrypoints/options/sections/rules';
import { MATCH_ALL_RULE_ID, pickSearchTab } from '../../src/entrypoints/options/sections/watches/draft';
import { MessagingError } from '../../src/messaging/errors';
import { FakeMessaging } from '../fakes/ports/fake-messaging';

afterEach(cleanup);

const NOW = 1_800_000_000_000;
const TAB = 'https://shopgoodwill.com/categories/listing?st=pyrex&p=3&catIds=12&cln=4&lp=5&layout=grid';

const auth = (connected: boolean): AuthStatus => ({
  connected,
  provider: 'pkce',
  grantedScopes: [],
  needsInteraction: false,
  configured: true,
});

const rule = (id: string, over: Partial<Rule> = {}): Rule => ({
  id,
  name: `Rule ${id}`,
  enabled: true,
  action: 'highlight',
  all: [{ kind: 'price', max: 5000 }],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

interface Opts {
  tab?: string | undefined;
  rules?: Rule[];
  connected?: boolean;
  calendarEnabled?: boolean;
  noWatchHandlers?: boolean;
  failStatus?: boolean;
  watches?: Watch[];
  dryRunFavorites?: boolean;
}

function app(opts: Opts = {}) {
  const fake = new FakeMessaging();
  const store: Watch[] = [...(opts.watches ?? [])];
  const rules = [...(opts.rules ?? [])];
  const settings = defaultSettings();
  settings.calendar.enabled = opts.calendarEnabled ?? true;
  if (opts.dryRunFavorites !== undefined) settings.dryRun.favorites = opts.dryRunFavorites;
  fake.handle('settings.get', () => {
    if (opts.failStatus === true) throw new Error('boom');
    return settings;
  });
  fake.handle('calendar.status', () => {
    if (opts.failStatus === true) throw new Error('boom');
    return auth(opts.connected ?? true);
  });
  fake.handle('rules.list', () => rules);
  fake.handle('rules.save', (r) => {
    rules.push(r);
    return undefined;
  });
  if (opts.noWatchHandlers !== true) {
    fake.handle('watches.list', () => store);
    fake.handle('watches.save', (w) => {
      const i = store.findIndex((x) => x.id === w.id);
      if (i >= 0) store[i] = w;
      else store.push(w);
      return undefined;
    });
    fake.handle('watches.delete', ({ id }) => {
      const i = store.findIndex((x) => x.id === id);
      if (i >= 0) store.splice(i, 1);
      return undefined;
    });
  }
  let n = 0;
  render(
    h(WatchesSection, {
      client: fake,
      now: () => NOW,
      newId: () => `w${String(++n)}`,
      timeZone: 'America/Los_Angeles',
      getActiveTabUrl: () => Promise.resolve('tab' in opts ? opts.tab : TAB),
    }),
  );
  return { fake, store, rules };
}

const click = (name: string | RegExp): void => {
  fireEvent.click(screen.getByRole('button', { name }));
};

async function openForm(): Promise<void> {
  click('Use my current tab');
  await screen.findByRole('heading', { name: 'New watch' });
}

describe('options: Watches', () => {
  it('registers as a section', () => {
    expect(loadSections({ 'x/index.tsx': { section } })[0]?.id).toBe('watches');
  });

  it('produces a schema-valid, normalized Watch with the sgw default', async () => {
    const { store } = app({ rules: [rule('a'), rule('b')] });
    await openForm();
    expect(screen.getByLabelText<HTMLInputElement>(/Favorite on ShopGoodwill right away/).checked).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Name').value).toBe('pyrex');
    fireEvent.click(screen.getByLabelText('Rule a'));
    fireEvent.change(screen.getByLabelText('Pages to search'), { target: { value: '2' } });
    click('Save watch');
    await waitFor(() => {
      expect(store).toHaveLength(1);
    });
    const w = store[0] as Watch;
    expect(WatchSchema.safeParse(w).success).toBe(true);
    expect(w).toMatchObject({
      id: 'w1',
      name: 'pyrex',
      enabled: true,
      ruleIds: ['a'],
      maxPages: 2,
      favoriteMode: 'sgw',
      calendar: false,
      seenItemIds: [],
    });
    expect(w.query.page).toBe(1);
    expect(Object.keys(w.query.extra ?? {})).not.toContain('catIds');
    expect(Object.keys(w.query.extra ?? {})).not.toContain('cln');
    expect(w.nextRunAt).toBeGreaterThan(NOW);
    expect(w.favoriteWithinHours).toBeUndefined();
  });

  it('refuses to save a query with unparsed params and names the keys', async () => {
    const { store } = app({ tab: 'https://shopgoodwill.com/categories/listing?st=a&lp=cheap' });
    click('Use my current tab');
    const alert = await screen.findByText(/could not read: lp/);
    expect(alert.closest('[role="alert"]')).not.toBeNull();
    expect(screen.queryByRole('heading', { name: 'New watch' })).toBeNull();
    expect(store).toHaveLength(0);
  });

  it('shows a clear error for a non-search tab and offers paste when the URL is unreadable', async () => {
    app({ tab: 'https://shopgoodwill.com/item/123' });
    click('Use my current tab');
    expect((await screen.findByText(/not a ShopGoodwill search page/)).closest('[role="alert"]')).not.toBeNull();
    cleanup();
    app({ tab: undefined });
    click('Use my current tab');
    await screen.findByText(/Paste the search address below/);
    fireEvent.input(screen.getByLabelText('ShopGoodwill search address'), { target: { value: TAB } });
    click('Use this address');
    await screen.findByRole('heading', { name: 'New watch' });
  });

  it('rejects other hosts', async () => {
    app({ tab: 'https://evil.example/categories/listing?st=a' });
    click('Use my current tab');
    await screen.findByText(/not a ShopGoodwill search page/);
  });

  it('warns on a rule-less watch, allows saving it, and offers match-everything', async () => {
    const { store, rules } = app();
    await openForm();
    expect(screen.getByText('No rules: this watch will never match.')).toBeTruthy();
    click('Match everything new in this search');
    await waitFor(() => {
      expect(rules.map((r) => r.id)).toEqual([MATCH_ALL_RULE_ID]);
    });
    expect(rules[0]?.all).toEqual([{ kind: 'price', min: 0 }]);
    await waitFor(() => {
      expect(screen.queryByText('No rules: this watch will never match.')).toBeNull();
    });
    click('Save watch');
    await waitFor(() => {
      expect(store[0]?.ruleIds).toEqual([MATCH_ALL_RULE_ID]);
    });
  });

  it('saves a rule-less watch after the warning', async () => {
    const { store } = app();
    await openForm();
    screen.getByText('No rules: this watch will never match.');
    click('Save watch');
    await waitFor(() => {
      expect(store).toHaveLength(1);
    });
    expect(store[0]?.ruleIds).toEqual([]);
    expect(await screen.findAllByText('No rules: this watch will never match.')).toHaveLength(1);
  });

  it('explains the favorite modes and saves sgw-late with hours', async () => {
    const { store } = app();
    await openForm();
    expect(screen.getByText(/attract other bidders/)).toBeTruthy();
    expect(screen.getByText(/nothing is written to your ShopGoodwill account/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/shortly before the auction ends/));
    fireEvent.input(screen.getByLabelText('Hours before the end'), { target: { value: '0' } });
    click('Save watch');
    await screen.findByText(/greater than zero/);
    expect(store).toHaveLength(0);
    fireEvent.input(screen.getByLabelText('Hours before the end'), { target: { value: '4' } });
    click('Save watch');
    await waitFor(() => {
      expect(store[0]).toMatchObject({ favoriteMode: 'sgw-late', favoriteWithinHours: 4 });
    });
  });

  it('disables the calendar toggle with a hint unless Google is connected and calendar is enabled', async () => {
    app({ connected: false });
    await openForm();
    await waitFor(() => {
      expect(screen.getByText(/Connect Google Calendar/)).toBeTruthy();
    });
    expect(screen.getByLabelText<HTMLInputElement>('Add matches to my calendar').disabled).toBe(true);
    cleanup();
    app({ calendarEnabled: false });
    await openForm();
    await screen.findByText(/turned off in Settings/);
    expect(screen.getByLabelText<HTMLInputElement>('Add matches to my calendar').disabled).toBe(true);
    cleanup();
    const { store } = app();
    await openForm();
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Add matches to my calendar').disabled).toBe(false);
    });
    fireEvent.click(screen.getByLabelText('Add matches to my calendar'));
    click('Save watch');
    await waitFor(() => {
      expect(store[0]?.calendar).toBe(true);
    });
  });

  it('import is user-triggered, reports counts, reloads and is idempotent (no duplicates)', async () => {
    const fake = new FakeMessaging();
    const store: Watch[] = [];
    const saved = ['pyrex', 'corelle', 'pyrex'];
    const hash = (q: Watch['query']): string => JSON.stringify([q.searchText, q.categoryIds, q.sellerIds]);
    fake.handle('settings.get', () => defaultSettings());
    fake.handle('calendar.status', () => auth(false));
    fake.handle('rules.list', () => []);
    fake.handle('watches.list', () => store);
    fake.handle('watches.importSaved', () => {
      let imported = 0;
      let skipped = 0;
      for (const t of saved) {
        const query = { searchText: t, categoryIds: [], sellerIds: [], page: 1 };
        if (store.some((w) => hash(w.query) === hash(query))) {
          skipped++;
          continue;
        }
        // Shaped like T-52's handler: `sgw-saved-<id>`, disabled, no rules, schema-default favoriteMode.
        store.push(
          WatchSchema.parse({
            id: `sgw-saved-${String(store.length + 1)}`, name: t, enabled: false, query, ruleIds: [], maxPages: 1,
            calendar: false, notify: false, nextRunAt: NOW, seenItemIds: [],
          }),
        );
        imported++;
      }
      return { imported, skipped };
    });
    render(h(WatchesSection, { client: fake, now: () => NOW }));
    await screen.findByText('You have no watches yet.');
    expect(fake.sent.some((s) => s.type === 'watches.importSaved')).toBe(false);
    click(/Import my saved searches/);
    await screen.findByText(/Imported 2 saved searches. Skipped 1/);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    click(/Import my saved searches/);
    await screen.findByText(/Imported 0 saved searches. Skipped 3/);
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(fake.sent.filter((s) => s.type === 'watches.importSaved')).toHaveLength(2);
  });

  it('says so when the watches handler is missing', async () => {
    app({ noWatchHandlers: true });
    expect((await screen.findByText(/Watches are not available yet/)).closest('[role="status"]')).not.toBeNull();
    await openForm();
    click('Save watch');
    await waitFor(() => {
      const err = screen.getAllByText(/Could not save the watch\. Watches are not available yet/);
      expect(err.some((e) => e.closest('[role="alert"]') !== null)).toBe(true);
    });
  });

  it('renders search terms as text only', async () => {
    app({ tab: 'https://shopgoodwill.com/categories/listing?st=%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E' });
    await openForm();
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByTestId('watch-query').textContent).toContain('<img');
  });

  it('lists, toggles and deletes a watch with keyboard-reachable buttons', async () => {
    const { store } = app();
    await openForm();
    click('Save watch');
    await screen.findByRole('list', { name: 'Your watches' });
    fireEvent.click(screen.getByRole('switch', { name: 'Watch "pyrex" is on' }));
    await waitFor(() => {
      expect(store[0]?.enabled).toBe(false);
    });
    click('Delete pyrex');
    click('Confirm delete pyrex');
    await waitFor(() => {
      expect(store).toHaveLength(0);
    });
  });

  it('shows a handler error as an alert', async () => {
    const { fake } = app();
    await openForm();
    // a failing save: swap by sending through a MessagingError-throwing client
    const orig = fake.send.bind(fake);
    fake.send = ((type: string, payload: unknown) =>
      type === 'watches.save'
        ? Promise.reject(new MessagingError('handler_error', 'disk full'))
        : orig(type as never, payload as never));
    click('Save watch');
    expect((await screen.findByText(/disk full/)).closest('[role="alert"]')).not.toBeNull();
  });

  it('picks the most recently used SGW search tab', () => {
    const tabs = [
      { url: 'https://shopgoodwill.com/item/1', lastAccessed: 99 },
      { url: 'https://shopgoodwill.com/categories/listing?st=a', lastAccessed: 10 },
      { url: 'https://www.shopgoodwill.com/categories/listing?st=b', lastAccessed: 50 },
      { url: undefined, lastAccessed: 70 },
    ];
    expect(pickSearchTab(tabs)).toBe('https://www.shopgoodwill.com/categories/listing?st=b');
    expect(pickSearchTab([{ url: 'https://shopgoodwill.com/item/1', lastAccessed: 1 }])).toBeUndefined();
    expect(pickSearchTab([])).toBeUndefined();
  });

  it('chooses the apex search tab when tabs.query rejects an unpermitted host', async () => {
    const apex = 'https://shopgoodwill.com/categories/listing?st=pyrex';
    const permitted = 'https://shopgoodwill.com/*';
    // The callback overload types this as returning void. The fake still hands the tab list to `await`.
    const query = vi.spyOn(browser.tabs, 'query').mockImplementation((info) => {
      const patterns = info.url === undefined ? [] : Array.isArray(info.url) ? info.url : [info.url];
      if (patterns.length !== 1 || patterns[0] !== permitted) {
        throw new Error(`tabs.query rejected unpermitted url pattern: ${patterns.join(', ')}`);
      }
      return [
        { url: 'https://shopgoodwill.com/item/1', lastAccessed: 99 },
        { url: apex, lastAccessed: 10 },
      ] as never;
    });
    try {
      await expect(activeTabUrl()).resolves.toBe(apex);
    } finally {
      query.mockRestore();
    }
  });

  it('opens the paste field when no SGW search tab is open', async () => {
    app({ tab: undefined });
    click('Use my current tab');
    await screen.findByText(/No ShopGoodwill search tab is open\./);
    expect(screen.getByLabelText('ShopGoodwill search address')).toBeTruthy();
  });

  it('prunes deleted rule ids when editing a watch and says so', async () => {
    const w: Watch = {
      id: 'w9', name: 'old', enabled: true, query: { searchText: 'x', categoryIds: [], sellerIds: [], page: 1 },
      ruleIds: ['a', 'gone'], maxPages: 1, favoriteMode: 'sgw', calendar: false, notify: true, nextRunAt: NOW, seenItemIds: [],
    };
    const { store } = app({ rules: [rule('a')], watches: [w] });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit old' }));
    await screen.findByText(/1 rule that no longer exists was removed/);
    click('Save watch');
    await waitFor(() => {
      expect(store[0]?.ruleIds).toEqual(['a']);
    });
  });

  it('says the calendar status could not be checked instead of guessing', async () => {
    app({ failStatus: true });
    await openForm();
    await screen.findByText(/Could not check your calendar status/);
    expect(screen.getByLabelText<HTMLInputElement>('Add matches to my calendar').disabled).toBe(true);
  });

  it('explains sgw-late', async () => {
    app();
    await openForm();
    expect(screen.getByText(/favorited only in the last hours before they end/)).toBeTruthy();
  });

  it('creates and saves a watch with the keyboard only', async () => {
    // jsdom has no Tab key: walk the natural tab order (native controls, no positive tabindex)
    // and activate with element.click(), which is what Enter and Space do on native controls.
    const { store } = app({ rules: [rule('a')] });
    const tabbables = (): HTMLElement[] =>
      Array.from(document.querySelectorAll<HTMLElement>('button, input, select, a[href]')).filter(
        (e) => !(e as HTMLButtonElement).disabled,
      );
    expect(document.querySelector('[tabindex]:not([tabindex="0"]):not([tabindex="-1"])')).toBeNull();
    const useTab = await screen.findByRole('button', { name: 'Use my current tab' });
    expect(tabbables()).toContain(useTab);
    useTab.focus();
    useTab.click();
    await screen.findByRole('heading', { name: 'New watch' });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByLabelText('Name'));
    });
    const order = tabbables();
    const ruleBox = screen.getByLabelText('Rule a');
    const save = screen.getByRole('button', { name: 'Save watch' });
    expect(order.indexOf(ruleBox)).toBeGreaterThan(order.indexOf(screen.getByLabelText('Name')));
    expect(order.indexOf(save)).toBeGreaterThan(order.indexOf(ruleBox));
    ruleBox.focus();
    ruleBox.click();
    await waitFor(() => {
      expect((ruleBox as HTMLInputElement).checked).toBe(true);
    });
    save.focus();
    save.click();
    await waitFor(() => {
      expect(store[0]?.ruleIds).toEqual(['a']);
    });
  });
});

describe('imported saved searches (T-52 carry): say they favorite on ShopGoodwill once enabled with rules', () => {
  // Shaped like T-52's `watches.importSaved`: `sgw-saved-<id>`, disabled, no rules, favoriteMode the schema default.
  const imported = (over: Partial<Watch> = {}): Watch =>
    WatchSchema.parse({
      id: 'sgw-saved-41', name: 'pyrex', enabled: false,
      query: { searchText: 'pyrex', categoryIds: [], sellerIds: [], page: 1 },
      ruleIds: [], maxPages: 1, calendar: false, notify: false, nextRunAt: NOW, seenItemIds: [], ...over,
    });
  const mine: Watch = {
    id: 'w9', name: 'mine', enabled: false, query: { searchText: 'mine', categoryIds: [], sellerIds: [], page: 1 },
    ruleIds: [], maxPages: 1, favoriteMode: 'sgw', calendar: false, notify: true, nextRunAt: NOW, seenItemIds: [],
  };
  const item = async (name: string): Promise<HTMLElement> => {
    const heading = await screen.findByRole('heading', { name });
    const li = heading.closest('li');
    if (li === null) throw new Error(`no list item for ${name}`);
    return li;
  };

  it('the import status and the imported watch say it starts disabled and will favorite for real', async () => {
    const { fake, store } = app({ watches: [mine] });
    fake.handle('watches.importSaved', () => {
      store.push(imported());
      return { imported: 1, skipped: 0 };
    });
    expect(imported().favoriteMode).toBe('sgw');
    await item('mine');
    click(/Import my saved searches/);
    const status = await screen.findByText(/Imported watches start disabled/);
    expect(status.closest('[role="status"]')).not.toBeNull();
    expect(status.textContent).toContain(
      'Imported 1 saved search. Skipped 0 already here. Imported watches start disabled with no rules. Once you enable one and add rules, matches are favorited on your ShopGoodwill account (unless dry-run is on).',
    );
    const li = await item('pyrex');
    expect(li.textContent).toContain(
      'Imported disabled. Once you enable it and add rules, matches are favorited on your ShopGoodwill account (unless dry-run is on). Favorites dry-run is on right now, so nothing is written to your ShopGoodwill account yet.',
    );
    // The switch that turns it on is described by that note.
    const sw = screen.getByRole('switch', { name: 'Watch "pyrex" is on' });
    const describedBy = sw.getAttribute('aria-describedby');
    expect(describedBy).not.toBeNull();
    expect(document.getElementById(describedBy ?? '')?.textContent).toContain('Imported disabled.');
    // A watch the user made is not labelled as imported.
    expect((await item('mine')).textContent).not.toContain('Imported');
  });

  it('an enabled imported watch with rules, with favorites dry-run off, says its favorites are real', async () => {
    app({ dryRunFavorites: false, rules: [rule('a')], watches: [imported({ enabled: true, ruleIds: ['a'] })] });
    expect((await item('pyrex')).textContent).toContain(
      'Imported from your ShopGoodwill saved searches. Matches are favorited on your ShopGoodwill account (unless dry-run is on). Favorites dry-run is off right now, so these favorites are real.',
    );
  });

  it('a local-only imported watch says nothing is favorited on ShopGoodwill', async () => {
    app({ watches: [imported({ favoriteMode: 'local' })] });
    const text = (await item('pyrex')).textContent;
    expect(text).toContain(
      'Imported disabled. Once you enable it and add rules, matches are tracked in ShopBadwill only; nothing is favorited on your ShopGoodwill account.',
    );
    expect(text).not.toContain('dry-run');
  });

  it('the editor shows the note for an imported watch and follows the draft', async () => {
    app({ rules: [rule('a')], watches: [imported()] });
    fireEvent.click(await screen.findByRole('button', { name: 'Edit pyrex' }));
    await screen.findByRole('heading', { name: 'Edit watch' });
    const note = (): string => screen.getByTestId('watch-imported-editor-note').textContent;
    await waitFor(() => {
      expect(note()).toContain(
        'Imported disabled. Once you enable it and add rules, matches are favorited on your ShopGoodwill account (unless dry-run is on).',
      );
    });
    fireEvent.click(screen.getByLabelText('Rule a'));
    await waitFor(() => {
      expect(note()).toContain(
        'Imported disabled. Once you enable it, matches are favorited on your ShopGoodwill account (unless dry-run is on).',
      );
    });
    fireEvent.click(screen.getByLabelText(/Track in ShopBadwill only/));
    await waitFor(() => {
      expect(note()).toContain('nothing is favorited on your ShopGoodwill account');
    });
  });

  it('a new watch from a search tab has no imported note', async () => {
    app();
    await openForm();
    expect(screen.queryByTestId('watch-imported-editor-note')).toBeNull();
  });
});

describe('rules section: deleting a rule that watches use', () => {
  const w = (id: string, ruleIds: string[], name = id): Watch => ({
    id, name, enabled: true, query: { searchText: id, categoryIds: [], sellerIds: [], page: 1 },
    ruleIds, maxPages: 1, favoriteMode: 'sgw', calendar: false, notify: true, nextRunAt: NOW, seenItemIds: [],
  });

  it('names the watch count, deletes, and removes the id from those watches', async () => {
    const fake = new FakeMessaging();
    const watches = [w('a', ['r1', 'r2']), w('b', ['r1']), w('c', ['r2'])];
    const deleted: string[] = [];
    fake.handle('rules.list', () => [rule('r1', { name: 'Pyrex' })]);
    fake.handle('rules.delete', ({ id }) => {
      deleted.push(id);
      return undefined;
    });
    fake.handle('watches.list', () => watches);
    fake.handle('watches.save', (x) => {
      const i = watches.findIndex((y) => y.id === x.id);
      watches[i] = x;
      return undefined;
    });
    render(h(RulesSection, { client: fake }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Pyrex' }));
    await screen.findByText(/Used by 2 watches; they will stop matching\./);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Pyrex' }));
    await waitFor(() => {
      expect(deleted).toEqual(['r1']);
      expect(watches.map((x) => x.ruleIds)).toEqual([['r2'], [], ['r2']]);
    });
  });

  it('shows an error when saving a watch fails after the rule is deleted', async () => {
    const fake = new FakeMessaging();
    const watches = [w('a', ['r1', 'r2'], 'Bowl'), w('b', ['r1'], 'Lamp'), w('c', ['r2'], 'Vase')];
    fake.handle('rules.list', () => [rule('r1', { name: 'Pyrex' })]);
    fake.handle('rules.delete', () => undefined);
    fake.handle('watches.list', () => watches);
    fake.handle('watches.save', (x) => {
      if (x.id === 'b') throw new Error('disk full');
      const i = watches.findIndex((y) => y.id === x.id);
      watches[i] = x;
      return undefined;
    });
    render(h(RulesSection, { client: fake }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Pyrex' }));
    await screen.findByText(/Used by 2 watches; they will stop matching\./);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Pyrex' }));
    const status = await screen.findByText(/could not update these watches: Lamp\./);
    expect(status.closest('[role="status"]')?.getAttribute('data-tone')).toBe('error');
    expect(status.textContent).toContain(
      'Deleted "Pyrex", but could not update these watches: Lamp. Open them to remove the missing rule.',
    );
  });
});
