// T-71: the first-run onboarding wizard, driven through FakeMessaging. The five
// steps are: sign-in detection (health.get's sessionState, never a password),
// an optional home ZIP (settings.homeZip), Google connect or skip with the .ics
// fallback (calendar.enabled=false, icsFallback=true), a first watch (the
// current SGW search tab, else the whole-site template; favoriteMode is the
// Watch schema default 'sgw'), and a dry run (job.runNow sent only while
// settings.dryRun is on, R1). ToS/risk copy is plain and gated behind an
// explicit checkbox (R3); the notifications permission is requested from the
// click handler through the Permissions port (R6).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AuthStatus } from '../../src/domain/calendar/types';
import type { Rule } from '../../src/domain/rules/schema';
import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import { WatchSchema } from '../../src/domain/watches/schema';
import { Onboarding } from '../../src/entrypoints/onboarding/Onboarding';
import {
  buildFirstWatch,
  googleOptionsUrl,
  templateQuery,
  zipError,
} from '../../src/entrypoints/onboarding/steps';
import { App } from '../../src/entrypoints/options/App';
import {
  MATCH_ALL_RULE_ID,
  matchEverythingRule,
  queryFromUrl,
} from '../../src/entrypoints/options/sections/watches/draft';
import type { MsgReply } from '../../src/messaging/protocol';
import { FakeMessaging } from '../fakes/ports/fake-messaging';
import { FakePermissions } from '../fakes/ports/fake-permissions';

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const TAB = 'https://shopgoodwill.com/categories/listing?st=pyrex&p=3&catIds=12&cln=4&lp=5&layout=grid';

type SessionState = 'ok' | 'expiring' | 'expired' | 'logged-out';

const googleStatus = (over: Partial<AuthStatus> = {}): AuthStatus => ({
  connected: false,
  provider: 'pkce',
  grantedScopes: [],
  needsInteraction: false,
  configured: true,
  ...over,
});

const healthReply = (over: { sessionState?: SessionState } = {}): MsgReply<'health.get'> => ({
  sgw: null,
  session: NOW + 48 * 3_600_000,
  sessionState: 'ok',
  google: googleStatus(),
  budget: {
    lanes: {
      interactive: { usedToday: 0, budget: 300, nextAllowedAt: 0 },
      background: { usedToday: 0, budget: 120, nextAllowedAt: 0 },
      snipe: { usedToday: 0, budget: 80, nextAllowedAt: 0 },
      canary: { usedToday: 0, budget: 4, nextAllowedAt: 0 },
    },
    cacheHits: 0,
  },
  ...over,
});

interface Harness {
  fake: FakeMessaging;
  healthState: { sessionState: SessionState };
  settingsSet: Array<Record<string, unknown>>;
  watchesSaved: unknown[];
  rulesSaved: unknown[];
  runNow: unknown[];
  permissions: FakePermissions;
  openGoogle: ReturnType<typeof vi.fn>;
  openOptions: ReturnType<typeof vi.fn>;
}

function app(
  opts: {
    sessionState?: SessionState;
    settings?: Settings;
    tab?: string;
    rules?: Rule[];
    permissions?: FakePermissions;
    /** When set, calendar.status reports Google as connected under this account. */
    account?: string;
    newId?: () => string;
  } = {},
): Harness {
  const fake = new FakeMessaging();
  const healthState = { sessionState: opts.sessionState ?? 'ok' };
  const settingsSet: Array<Record<string, unknown>> = [];
  const watchesSaved: unknown[] = [];
  const rulesSaved: unknown[] = [];
  const runNow: unknown[] = [];
  fake.handle('health.get', () => healthReply(healthState));
  fake.handle('settings.get', () => opts.settings ?? defaultSettings());
  fake.handle('settings.set', (p) => {
    settingsSet.push(p);
    return undefined;
  });
  fake.handle('calendar.status', () => googleStatus(opts.account === undefined ? {} : { connected: true, account: opts.account }));
  fake.handle('watches.list', () => []);
  fake.handle('watches.save', (w) => {
    watchesSaved.push(w);
    return undefined;
  });
  fake.handle('rules.list', () => opts.rules ?? []);
  fake.handle('rules.save', (r) => {
    rulesSaved.push(r);
    return undefined;
  });
  fake.handle('job.runNow', (p) => {
    runNow.push(p);
    return undefined;
  });
  const permissions = opts.permissions ?? new FakePermissions();
  const openGoogle = vi.fn<() => void>();
  const openOptions = vi.fn<() => void>();
  render(
    h(Onboarding, {
      client: fake,
      permissions,
      openGoogleOptions: openGoogle,
      openOptions,
      getActiveTabUrl: () => Promise.resolve(opts.tab),
      now: () => NOW,
      newId: opts.newId ?? (() => 'watch-1'),
    }),
  );
  return { fake, healthState, settingsSet, watchesSaved, rulesSaved, runNow, permissions, openGoogle, openOptions };
}

/** Walks the wizard to `step` (1-based). Steps 2-4 use the no-frills choices: skip ZIP, skip Google, create the watch. */
async function toStep(h: Harness, step: 2 | 3 | 4 | 5): Promise<void> {
  if (step >= 2) {
    const cont = await screen.findByRole<HTMLButtonElement>('button', { name: 'Continue' });
    await waitFor(() => {
      expect(cont.disabled).toBe(false);
    });
    fireEvent.click(cont);
  }
  if (step >= 3) {
    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));
  }
  if (step >= 4) {
    const skip = await screen.findByRole<HTMLButtonElement>('button', { name: 'Skip for now' });
    await waitFor(() => {
      expect(skip.disabled).toBe(false);
    });
    fireEvent.click(skip);
    await screen.findByText(/\.ics downloads/);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  }
  if (step >= 5) {
    fireEvent.click(await screen.findByRole('button', { name: 'Create my first watch' }));
    await waitFor(() => {
      expect(h.watchesSaved).toHaveLength(1);
    });
  }
}

afterEach(cleanup);

describe('onboarding: calendar step (brief test: the skip path)', () => {
  it('Skip for now leaves the calendar disabled with the .ics fallback on', async () => {
    const h = app();
    await toStep(h, 3);
    fireEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await screen.findByText(/\.ics downloads/);
    expect(h.fake.sent.some((m) => m.type === 'calendar.connect')).toBe(false);
    const calendar = defaultSettings().calendar;
    expect(h.settingsSet).toEqual([{ calendar: { ...calendar, enabled: false, icsFallback: true } }]);
    expect(screen.getByText(/\.ics downloads/)).toBeTruthy();
    // Skipping never touches dry-run or sniping.
    expect(h.settingsSet[0]?.['dryRun']).toBeUndefined();
    expect(h.settingsSet[0]?.['snipe']).toBeUndefined();
  });

  it('Connect Google opens the options Google section (T-70) and sends no message', async () => {
    const h = app();
    await toStep(h, 3);
    fireEvent.click(screen.getByRole('button', { name: 'Connect Google' }));
    expect(h.openGoogle).toHaveBeenCalledTimes(1);
    expect(h.fake.sent.some((m) => m.type === 'calendar.connect')).toBe(false);
  });

  it('shows the Google connection state on the calendar step', async () => {
    const fake = new FakeMessaging();
    fake.handle('health.get', () => healthReply());
    fake.handle('settings.get', () => defaultSettings());
    fake.handle('settings.set', () => undefined);
    fake.handle('calendar.status', () => googleStatus({ connected: true, account: 'me@example.com' }));
    render(
      h(Onboarding, {
        client: fake,
        getActiveTabUrl: () => Promise.resolve(undefined),
        permissions: new FakePermissions(),
        openGoogleOptions: () => undefined,
        openOptions: () => undefined,
        now: () => NOW,
      }),
    );
    const cont = await screen.findByRole<HTMLButtonElement>('button', { name: 'Continue' });
    await waitFor(() => {
      expect(cont.disabled).toBe(false);
    });
    fireEvent.click(cont);
    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));
    await screen.findByText(/Google Calendar is connected as me@example\.com/);
  });
});

describe('onboarding: completing (brief test)', () => {
  it('creates one watch with the schema default favoriteMode and dry-runs it with dry-run re-asserted on first', async () => {
    const h = app({
      settings: { ...defaultSettings(), dryRun: { favorites: false, calendar: false, bidding: false } },
    });
    await toStep(h, 5);

    expect(h.watchesSaved).toHaveLength(1);
    const watch = WatchSchema.parse(h.watchesSaved[0]);
    expect(watch).toMatchObject({ id: 'watch-1', enabled: true, maxPages: 1, favoriteMode: 'sgw', notify: true, calendar: false });
    expect(watch.ruleIds).toEqual([MATCH_ALL_RULE_ID]);
    expect(h.rulesSaved).toHaveLength(1);

    // The ToS checkbox gates the dry run (R3).
    const dry = screen.getByRole<HTMLButtonElement>('button', { name: 'Dry-run it now' });
    expect(dry.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/understand the risks/i));
    expect(dry.disabled).toBe(false);

    fireEvent.click(dry);
    await waitFor(() => {
      expect(h.runNow).toEqual([{ watchIds: ['watch-1'] }]);
    });
    // R1: settings.dryRun was turned ON before job.runNow was sent.
    const order = h.fake.sent.map((m) => m.type);
    const runIdx = order.lastIndexOf('job.runNow');
    expect(runIdx).toBeGreaterThan(-1);
    const before = [...h.fake.sent.slice(0, runIdx)].reverse().find((m) => m.type === 'settings.set');
    expect(before?.payload).toEqual({ dryRun: { favorites: true, calendar: true, bidding: true } });

    // Finishing never enables live sniping (R3).
    fireEvent.click(await screen.findByRole('button', { name: 'Finish' }));
    await screen.findByText(/You're all set/);
    expect(h.fake.sent.some((m) => m.type === 'settings.set' && 'snipe' in (m.payload as Record<string, unknown>))).toBe(false);
  });

  it('does not re-save the match-everything rule when it already exists', async () => {
    const h = app({ rules: [matchEverythingRule(NOW)] });
    await toStep(h, 5);
    expect(h.rulesSaved).toHaveLength(0);
  });
});

describe('onboarding: sign-in step (R2: detect only, never a password)', () => {
  it('logged out: tells the user to sign in on shopgoodwill.com, asks for no password, and Check again re-checks', async () => {
    const h = app({ sessionState: 'logged-out' });
    await screen.findByText(/ShopBadwill could not see your ShopGoodwill sign-in/);
    expect(screen.getByText(/sign in on shopgoodwill\.com in a normal tab/i)).toBeTruthy();
    expect(screen.getByText(/never asks for your password/i)).toBeTruthy();
    expect(document.querySelector('input[type="password"]')).toBeNull();
    const cont = screen.getByRole<HTMLButtonElement>('button', { name: 'Continue' });
    expect(cont.disabled).toBe(true);
    h.healthState.sessionState = 'ok';
    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => {
      expect(cont.disabled).toBe(false);
    });
    expect(h.fake.sent.filter((m) => m.type === 'health.get')).toHaveLength(2);
  });

  it('an expired session is treated as signed out', async () => {
    app({ sessionState: 'expired' });
    await screen.findByText(/ShopBadwill could not see your ShopGoodwill sign-in/);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Continue' }).disabled).toBe(true);
  });

  it('an expiring session still continues, with a renewal hint', async () => {
    app({ sessionState: 'expiring' });
    await screen.findByText(/sign-in expires soon/);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Continue' }).disabled).toBe(false);
  });

  it('a failed health check keeps Continue disabled and offers Check again', async () => {
    const fake = new FakeMessaging(); // no health.get handler
    fake.handle('settings.get', () => defaultSettings());
    fake.handle('settings.set', () => undefined);
    render(
      h(Onboarding, {
        client: fake,
        getActiveTabUrl: () => Promise.resolve(undefined),
        permissions: new FakePermissions(),
        openGoogleOptions: () => undefined,
        openOptions: () => undefined,
        now: () => NOW,
      }),
    );
    await screen.findByText(/could not check your sign-in right now/i);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Continue' }).disabled).toBe(true);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Check again' })).toBeTruthy();
  });
});

describe('onboarding: home ZIP step (R4)', () => {
  it('validates the ZIP as a US ZIP and stores it in settings.homeZip', async () => {
    const h = app();
    await toStep(h, 2);
    const zip = screen.getByLabelText<HTMLInputElement>('Home ZIP (optional)');
    fireEvent.input(zip, { target: { value: 'abcde' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await screen.findByText(/Enter a 5-digit US ZIP code/);
    expect(h.settingsSet).toHaveLength(0);
    fireEvent.input(zip, { target: { value: '98122-1234' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => {
      expect(h.settingsSet).toEqual([{ homeZip: '98122-1234' }]);
    });
    // On the calendar step now.
    expect(screen.getByRole('button', { name: 'Connect Google' })).toBeTruthy();
  });

  it('the skip button advances without writing anything', async () => {
    const h = app();
    await toStep(h, 3);
    expect(h.settingsSet).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Connect Google' })).toBeTruthy();
  });
});

describe('onboarding: ToS and risk copy (R3)', () => {
  it('says the four required things, plainly, and gates the dry run behind the checkbox', async () => {
    const h = app();
    await toStep(h, 5);
    const copy = screen.getByText(/Automated bidding may break/).textContent;
    expect(copy).toContain("ShopGoodwill's terms");
    expect(copy).toContain('your account is at risk');
    expect(copy).toContain('Real money is involved');
    expect(screen.getByText(/capped by the max you set, and daily caps apply/)).toBeTruthy();
    expect(screen.getByText(/Dry-run is on and stays on until you turn it off yourself/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Dry-run it now' }).disabled).toBe(true);
  });
});

describe('onboarding: notifications permission (R6, I-21)', () => {
  it('requests it through the Permissions port and shows the grant', async () => {
    const h = app();
    await toStep(h, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Allow notifications' }));
    await screen.findByText('Notifications are allowed.');
    expect(h.permissions.requested).toEqual([{ permissions: ['notifications'] }]);
    expect(screen.queryByRole('button', { name: 'Allow notifications' })).toBeNull();
  });

  it('says so when the browser declines', async () => {
    const permissions = new FakePermissions();
    permissions.grantRequests = false;
    const h = app({ permissions });
    await toStep(h, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Allow notifications' }));
    await screen.findByText(/did not allow notifications/);
    expect(screen.getByRole('button', { name: 'Allow notifications' })).toBeTruthy();
  });

  it('hides the button when the permission is already granted', async () => {
    const h = app({ permissions: new FakePermissions({ permissions: ['notifications'] }) });
    await toStep(h, 5);
    await screen.findByText('Notifications are allowed.');
    expect(screen.queryByRole('button', { name: 'Allow notifications' })).toBeNull();
  });
});

describe('onboarding: first watch step', () => {
  it('uses the current SGW search tab for the watch', async () => {
    const h = app({ tab: TAB });
    await toStep(h, 4);
    const source = await screen.findByTestId('onboarding-watch-source');
    expect(source.textContent).toMatch(/current ShopGoodwill search/);
    expect((await screen.findByTestId('onboarding-watch-query')).textContent).toContain('"pyrex"');
    fireEvent.click(screen.getByRole('button', { name: 'Create my first watch' }));
    await waitFor(() => {
      expect(h.watchesSaved).toHaveLength(1);
    });
    const parsed = queryFromUrl(TAB);
    expect(parsed.ok).toBe(true);
    const watch = WatchSchema.parse(h.watchesSaved[0]);
    if (parsed.ok) expect(watch.query).toEqual(parsed.query);
    expect(watch.name).toBe('pyrex');
  });

  it('falls back to the whole-site template when no search tab is open', async () => {
    const h = app();
    await toStep(h, 4);
    expect(await screen.findByText(/No ShopGoodwill search tab is open/)).toBeTruthy();
    expect((await screen.findByTestId('onboarding-watch-query')).textContent).toContain('Any text');
    expect(screen.getByText('All items in this search')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Create my first watch' }));
    await waitFor(() => {
      expect(h.watchesSaved).toHaveLength(1);
    });
    const watch = WatchSchema.parse(h.watchesSaved[0]);
    expect(watch.query).toEqual(templateQuery());
    expect(watch.favoriteMode).toBe('sgw');
  });
});

describe('onboarding helpers (steps.ts)', () => {
  it.each(['', '1234', '123456', 'abcde', '9812a', '98122-123', '98122-12345'])('zipError rejects %j', (v) => {
    expect(zipError(v)).toBeTruthy();
  });

  it.each(['98122', '98122-1234', '00501', '99950'])('zipError accepts %j', (v) => {
    expect(zipError(v)).toBeUndefined();
  });

  it('templateQuery is the whole site, page 1', () => {
    expect(templateQuery()).toEqual({ searchText: '', categoryIds: [], sellerIds: [], page: 1 });
  });

  it('buildFirstWatch uses the schema default favoriteMode and the match-everything rule', () => {
    const built = buildFirstWatch(templateQuery(), NOW, 'w1');
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const watch = WatchSchema.parse(built.watch);
    expect(watch).toMatchObject({
      id: 'w1',
      name: 'All items in this search',
      favoriteMode: 'sgw',
      ruleIds: [MATCH_ALL_RULE_ID],
      enabled: true,
      maxPages: 1,
      calendar: false,
      notify: true,
      query: templateQuery(),
    });
  });

  it('buildFirstWatch can turn favoriting off before the watch is saved', () => {
    const built = buildFirstWatch(templateQuery(), NOW, 'w1', 'local');
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const watch = WatchSchema.parse(built.watch);
    expect(watch.favoriteMode).toBe('local');
    expect(watch.ruleIds).toEqual([MATCH_ALL_RULE_ID]);
  });

  it('googleOptionsUrl opens the T-70 options page at the Google anchor', () => {
    expect(googleOptionsUrl('chrome-extension://ext/options.html')).toBe(
      'chrome-extension://ext/options.html#section-google',
    );
  });
});

describe('onboarding: first watch favorite warning', () => {
  it('says every new item is favorited once dry-run is off, and can save without favoriting', async () => {
    const h = app();
    await toStep(h, 4);
    expect(
      await screen.findByText(
        'Once dry-run is off, every new item in this search will be favorited on your ShopGoodwill account.',
      ),
    ).toBeTruthy();
    const optOut = screen.getByRole<HTMLInputElement>('checkbox', { name: "Don't favorite on ShopGoodwill" });
    expect(optOut.checked).toBe(false);

    fireEvent.click(optOut);
    expect(
      screen.queryByText(
        'Once dry-run is off, every new item in this search will be favorited on your ShopGoodwill account.',
      ),
    ).toBeNull();
    expect(screen.getByText('Nothing in this search will be favorited on your ShopGoodwill account.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Create my first watch' }));
    await waitFor(() => {
      expect(h.watchesSaved).toHaveLength(1);
    });
    const watch = WatchSchema.parse(h.watchesSaved[0]);
    expect(watch.favoriteMode).toBe('local');
    expect(watch.ruleIds).toEqual([MATCH_ALL_RULE_ID]);
  });
});

describe('onboarding: options shell link', () => {
  it('offers Run setup again, pointing at onboarding.html', () => {
    render(h(App, { client: new FakeMessaging(), sections: [] }));
    const link = screen.getByRole('link', { name: 'Run setup again' });
    expect(link.getAttribute('href')).toBe('onboarding.html');
  });
});

describe('onboarding: text safety', () => {
  it('renders user-provided search text and the Google account as text', async () => {
    const probe = '<img id=sbw-xss src=x onerror=globalThis.__sbwXss=1>';
    const account = '<img id=sbw-xss-acct src=x>';
    const h = app({
      tab: `https://shopgoodwill.com/categories/listing?st=${encodeURIComponent(probe)}`,
      account,
    });
    await toStep(h, 3);
    const accountLine = await screen.findByText(
      (_text, el) => el !== null && el.tagName === 'STRONG' && el.textContent.includes(account),
    );
    expect(accountLine.textContent).toContain(account);
    expect(document.getElementById('sbw-xss-acct')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    const heading = await screen.findByRole('heading', { level: 3 });
    expect(heading.textContent).toBe(probe);
    expect(document.getElementById('sbw-xss')).toBeNull();
    expect((globalThis as { __sbwXss?: unknown }).__sbwXss).toBeUndefined();
    fireEvent.click(screen.getByRole('button', { name: 'Create my first watch' }));
    await waitFor(() => {
      expect(h.watchesSaved).toHaveLength(1);
    });
    expect(screen.getByText(new RegExp(`Runs "${probe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`))).toBeTruthy();
    expect(document.getElementById('sbw-xss')).toBeNull();
  });
});

describe('onboarding: ZIP is private (R4)', () => {
  it('stores the ZIP only as settings.homeZip and does not log, audit, or send it elsewhere', async () => {
    const zip = '00501';
    const logs: string[] = [];
    const record = (...args: unknown[]): void => {
      logs.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
    };
    const spies = (['log', 'info', 'warn', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(record));
    try {
      const h = app();
      await toStep(h, 2);
      fireEvent.input(screen.getByLabelText('Home ZIP (optional)'), { target: { value: zip } });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      await waitFor(() => {
        expect(h.settingsSet.some((p) => p['homeZip'] === zip)).toBe(true);
      });
      const skip = await screen.findByRole<HTMLButtonElement>('button', { name: 'Skip for now' });
      await waitFor(() => {
        expect(skip.disabled).toBe(false);
      });
      fireEvent.click(skip);
      await screen.findByText(/\.ics downloads/);
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Create my first watch' }));
      await waitFor(() => {
        expect(h.watchesSaved).toHaveLength(1);
      });
      fireEvent.click(screen.getByLabelText(/understand the risks/i));
      fireEvent.click(screen.getByRole('button', { name: 'Dry-run it now' }));
      await waitFor(() => {
        expect(h.runNow).toHaveLength(1);
      });
      for (const m of h.fake.sent) {
        const body = JSON.stringify(m);
        if (!body.includes(zip)) continue;
        expect(m.type).toBe('settings.set');
        expect(m.payload).toEqual({ homeZip: zip });
      }
      expect(h.fake.sent.some((m) => m.type.toLowerCase().includes('audit'))).toBe(false);
      expect(logs.join('\n')).not.toContain(zip);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

/**
 * Own-property trap for `document.cookie`. An own getter shadows happy-dom's
 * prototype getter, which `vi.spyOn(Document.prototype)` does not see.
 */
function trapCookie(): { reads: () => number; restore: () => void } {
  let reads = 0;
  Object.defineProperty(document, 'cookie', {
    configurable: true,
    enumerable: true,
    get() {
      reads += 1;
      return 'sbw-secret-cookie=1';
    },
  });
  return {
    reads: () => reads,
    restore() {
      Reflect.deleteProperty(document, 'cookie');
    },
  };
}

describe('onboarding: no credentials are read (R2)', () => {
  it('has no password, token, or cookie field and does not read document.cookie', async () => {
    document.cookie = 'sbw-secret-cookie=1';
    const cookie = trapCookie();
    try {
      const h = app({ sessionState: 'logged-out' });
      await screen.findByRole('button', { name: 'Check again' });
      const bad = [...document.querySelectorAll('input, textarea')].filter((el) =>
        /password|token|cookie/i.test(
          `${el.getAttribute('type') ?? ''} ${el.getAttribute('name') ?? ''} ${el.getAttribute('id') ?? ''} ${el.getAttribute('autocomplete') ?? ''}`,
        ),
      );
      expect(bad).toEqual([]);
      expect(cookie.reads()).toBe(0);
      expect(JSON.stringify(h.fake.sent)).not.toContain('sbw-secret-cookie');
    } finally {
      cookie.restore();
    }
  });
});

describe('onboarding: dry-run stays on (R1, R3)', () => {
  it('turns every dry-run flag on before job.runNow and never writes snipe', async () => {
    const h = app({
      settings: { ...defaultSettings(), dryRun: { favorites: false, calendar: true, bidding: true } },
    });
    await toStep(h, 5);
    const dry = screen.getByRole<HTMLButtonElement>('button', { name: 'Dry-run it now' });
    expect(dry.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: 'Finish' })).toBeNull();
    fireEvent.click(dry);
    expect(h.runNow).toEqual([]);
    fireEvent.click(screen.getByLabelText(/understand the risks/i));
    fireEvent.click(dry);
    await waitFor(() => {
      expect(h.runNow).toEqual([{ watchIds: ['watch-1'] }]);
    });
    const dryIdx = h.fake.sent.findIndex(
      (m) => m.type === 'settings.set' && JSON.stringify(m.payload) === JSON.stringify({ dryRun: { favorites: true, calendar: true, bidding: true } }),
    );
    const runIdx = h.fake.sent.findIndex((m) => m.type === 'job.runNow');
    expect(dryIdx).toBeGreaterThan(-1);
    expect(dryIdx).toBeLessThan(runIdx);
    expect(JSON.stringify(h.fake.sent)).not.toContain('"snipe"');
    for (const m of h.fake.sent) {
      if (m.type !== 'settings.set' || m.payload === undefined || !('dryRun' in (m.payload as object))) continue;
      expect((m.payload as { dryRun: { favorites: boolean; calendar: boolean; bidding: boolean } }).dryRun).toEqual({
        favorites: true,
        calendar: true,
        bidding: true,
      });
    }
  });
});

describe('onboarding: notification request timing (R6)', () => {
  it('does not request the permission until the click, and requests it in that turn', async () => {
    const h = app();
    await toStep(h, 5);
    expect(h.permissions.requested).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Allow notifications' }));
    expect(h.permissions.requested).toEqual([{ permissions: ['notifications'] }]);
  });
});

/** From step 5: ticks the risk checkbox, starts the dry run and clicks Finish. */
async function finish(h: Harness): Promise<void> {
  fireEvent.click(screen.getByLabelText(/understand the risks/i));
  fireEvent.click(screen.getByRole('button', { name: 'Dry-run it now' }));
  await waitFor(() => {
    expect(h.runNow).toHaveLength(1);
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Finish' }));
  await screen.findByText("You're all set.");
}

const ALL_DRY = { dryRun: { favorites: true, calendar: true, bidding: true } };

describe('onboarding: final check (Opus)', () => {
  it('re-asserts dry-run before job.runNow even when it was on at load (options may have turned it off since)', async () => {
    const s = defaultSettings();
    const h = app({ settings: s });
    await toStep(h, 5);
    // Meanwhile, in the options tab Connect Google opened, the favorites dry run is turned off.
    s.dryRun = { favorites: false, calendar: true, bidding: true };
    fireEvent.click(screen.getByLabelText(/understand the risks/i));
    fireEvent.click(screen.getByRole('button', { name: 'Dry-run it now' }));
    await waitFor(() => {
      expect(h.runNow).toEqual([{ watchIds: ['watch-1'] }]);
    });
    const runIdx = h.fake.sent.findIndex((m) => m.type === 'job.runNow');
    const dryIdx = h.fake.sent.findIndex((m) => m.type === 'settings.set' && JSON.stringify(m.payload) === JSON.stringify(ALL_DRY));
    expect(dryIdx).toBeGreaterThan(-1);
    expect(dryIdx).toBeLessThan(runIdx);
  });

  it('going Back and creating the watch again updates the same watch instead of adding a second one', async () => {
    let n = 0;
    const h = app({
      newId: () => {
        n += 1;
        return `watch-${String(n)}`;
      },
    });
    await toStep(h, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: "Don't favorite on ShopGoodwill" }));
    fireEvent.click(screen.getByRole('button', { name: 'Create my first watch' }));
    await waitFor(() => {
      expect(h.watchesSaved).toHaveLength(2);
    });
    const [first, second] = h.watchesSaved.map((w) => WatchSchema.parse(w));
    expect(second?.id).toBe(first?.id);
    expect(second?.favoriteMode).toBe('local');
    await finish(h);
    expect(h.runNow).toEqual([{ watchIds: [first?.id] }]);
  });

  it('the summary says the ZIP was skipped when one was typed and then skipped', async () => {
    const h = app();
    await toStep(h, 2);
    fireEvent.input(screen.getByLabelText('Home ZIP (optional)'), { target: { value: '98122' } });
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    const skip = await screen.findByRole<HTMLButtonElement>('button', { name: 'Skip for now' });
    await waitFor(() => {
      expect(skip.disabled).toBe(false);
    });
    fireEvent.click(skip);
    await screen.findByText(/\.ics downloads/);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create my first watch' }));
    await waitFor(() => {
      expect(h.watchesSaved).toHaveLength(1);
    });
    await finish(h);
    expect(h.settingsSet.some((p) => 'homeZip' in p)).toBe(false);
    expect(screen.getByText('Home ZIP: skipped.')).toBeTruthy();
    expect(screen.queryByText(/98122/)).toBeNull();
  });

  it('moves focus to each new heading, the summary included', async () => {
    const h = app();
    await toStep(h, 2);
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe('Home ZIP (optional)');
    });
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));
    await toStep5From3(h);
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe('Dry-run it now');
    });
    await finish(h);
    await waitFor(() => {
      expect(document.activeElement?.textContent).toBe("You're all set.");
    });
  });

  it('a re-run with favorites dry-run off says favoriting starts at the watch\'s next run', async () => {
    const h = app({ settings: { ...defaultSettings(), dryRun: { favorites: false, calendar: true, bidding: true } } });
    await toStep(h, 4);
    await screen.findByText(
      "Dry-run is off for favorites right now, so from this watch's next run, every new item in this search will be favorited on your ShopGoodwill account. Dry-run it now, on the next step, turns dry-run back on.",
    );
    expect(screen.queryByText(/^Once dry-run is off/)).toBeNull();
  });

  it('a re-run with any dry-run off says so on the risk card, and that Dry-run it now turns it back on', async () => {
    const h = app({ settings: { ...defaultSettings(), dryRun: { favorites: true, calendar: true, bidding: false } } });
    await toStep(h, 5);
    expect(
      screen.getByText(
        'Dry-run is off right now for favorites, calendar or bids. Dry-run it now turns it back on for all three, and it stays on until you turn it off yourself.',
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Dry-run is on and stays on/)).toBeNull();
  });

  it('skipping Google on a re-run with the calendar on says it is now off, not that it stays off', async () => {
    const base = defaultSettings();
    const h = app({ settings: { ...base, calendar: { ...base.calendar, enabled: true } } });
    await toStep(h, 3);
    const skip = await screen.findByRole<HTMLButtonElement>('button', { name: 'Skip for now' });
    await waitFor(() => {
      expect(skip.disabled).toBe(false);
    });
    fireEvent.click(skip);
    await screen.findByText(/^Google Calendar reminders are off\./);
    expect(screen.queryByText(/stay off/)).toBeNull();
    expect(h.settingsSet).toEqual([{ calendar: { ...base.calendar, enabled: false, icsFallback: true } }]);
  });

  it('the summary claims only what the code does about live bidding', async () => {
    const h = app();
    await toStep(h, 5);
    await finish(h);
    expect(screen.getByText(/Live bidding stays off until you turn off the bidding dry run yourself in options\./)).toBeTruthy();
    expect(screen.queryByText(/practice/)).toBeNull();
  });
});

/** From the calendar step: skip Google, continue, create the watch. */
async function toStep5From3(h: Harness): Promise<void> {
  const skip = await screen.findByRole<HTMLButtonElement>('button', { name: 'Skip for now' });
  await waitFor(() => {
    expect(skip.disabled).toBe(false);
  });
  fireEvent.click(skip);
  await screen.findByText(/\.ics downloads/);
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Create my first watch' }));
  await waitFor(() => {
    expect(h.watchesSaved).toHaveLength(1);
  });
}
