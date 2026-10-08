// T-37: options page (rule editor + settings), driven through FakeMessaging.
/* eslint-disable import/no-restricted-paths -- the options page lives in src/entrypoints; this suite is its test. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';

import { RuleSchema, type Rule } from '../../src/domain/rules/schema';
import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import { MessagingError } from '../../src/messaging/errors';
import { describeError } from '../../src/ui/components/describeError';
import { App } from '../../src/entrypoints/options/App';
import { loadSections } from '../../src/entrypoints/options/registry';
import { RulesSection, section as rulesSection } from '../../src/entrypoints/options/sections/rules';
import { fromDraft, newCondition, newRuleDraft, toDraft, CONDITION_KINDS } from '../../src/entrypoints/options/sections/rules/draft';
import { formatMinutes, summarizeRule } from '../../src/entrypoints/options/sections/rules/summary';
import { SettingsSection, section as settingsSection } from '../../src/entrypoints/options/sections/settings';
import { FakeMessaging } from '../fakes/ports/fake-messaging';

afterEach(cleanup);

const NOW = 1_800_000_000_000;

const sampleRule = (over: Partial<Rule> = {}): Rule => ({
  id: 'r1',
  name: 'Pyrex',
  enabled: true,
  action: 'highlight',
  tone: 'green',
  all: [{ kind: 'keyword', mode: 'any', terms: ['pyrex'], wholeWord: true, regex: false, fields: ['title'] }],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

function rulesApp(initial: Rule[] = [], opts: { previewReply?: { matched: number; total: number } } = {}) {
  const fake = new FakeMessaging();
  fake.handle('rules.list', () => initial);
  fake.handle('rules.save', () => undefined);
  fake.handle('rules.delete', () => undefined);
  fake.handle('rules.preview', () => ({ ...(opts.previewReply ?? { matched: 0, total: 0 }), ids: [] }));
  let n = 0;
  render(
    h(RulesSection, { client: fake, now: () => NOW, newId: () => `new-${String(++n)}`, previewDelayMs: 0 }),
  );
  return fake;
}

function settingsApp(patch: (s: Settings) => void = () => undefined) {
  const fake = new FakeMessaging();
  const s = defaultSettings();
  patch(s);
  fake.handle('settings.get', () => s);
  fake.handle('settings.set', () => undefined);
  render(h(SettingsSection, { client: fake }));
  return fake;
}

const type = (el: HTMLElement, value: string) => fireEvent.input(el, { target: { value } });
const lastSent = (fake: FakeMessaging, t: string) => fake.sent.filter((m) => m.type === t).at(-1)?.payload;

async function openNewRule() {
  fireEvent.click(await screen.findByRole('button', { name: 'New rule' }));
  return screen.findByRole('form', { name: 'New rule' });
}

describe('rule editor', () => {
  it('saving a rule sends rules.save with a schema-valid payload', async () => {
    const fake = rulesApp();
    await openNewRule();
    type(screen.getByLabelText('Rule name'), 'Fire King');
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    type(screen.getByLabelText('Terms (one per line)'), 'fire king\njadeite');
    fireEvent.click(screen.getByLabelText('Whole words only'));
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }));

    await waitFor(() => {
      expect(fake.sent.some((m) => m.type === 'rules.save')).toBe(true);
    });
    const payload = RuleSchema.parse(lastSent(fake, 'rules.save'));
    expect(payload).toMatchObject({
      id: 'new-1',
      name: 'Fire King',
      enabled: true,
      action: 'highlight',
      tone: 'green',
      createdAt: NOW,
      updatedAt: NOW,
      all: [{ kind: 'keyword', mode: 'any', terms: ['fire king', 'jadeite'], wholeWord: true, regex: false, fields: ['title'] }],
    });
    // The new rule appears in the list with a plain-English summary.
    expect(await screen.findByText(/Highlight in green listings when title contains any of "fire king", "jadeite"/)).toBeTruthy();
  });

  it('shows a regex syntax error and does not send', async () => {
    const fake = rulesApp();
    await openNewRule();
    type(screen.getByLabelText('Rule name'), 'Bad');
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    type(screen.getByLabelText('Terms (one per line)'), '(unclosed');
    fireEvent.click(screen.getByLabelText('Terms are regular expressions'));
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/"\(unclosed" is not a valid regular expression/);
    const terms = screen.getByLabelText('Terms (one per line)');
    expect(terms.getAttribute('aria-invalid')).toBe('true');
    expect(terms.getAttribute('aria-describedby')).toMatch(/-error/);
    expect(fake.sent.some((m) => m.type === 'rules.save')).toBe(false);
  });

  it('shows a regex error that comes back from rules.save', async () => {
    const fake = new FakeMessaging();
    fake.handle('rules.list', () => []);
    fake.handle('rules.preview', () => ({ matched: 0, total: 0, ids: [] }));
    fake.handle('rules.save', () => {
      throw new Error('regex "(a+)+" is too complex');
    });
    render(h(RulesSection, { client: fake, now: () => NOW, newId: () => 'x', previewDelayMs: 0 }));
    await openNewRule();
    type(screen.getByLabelText('Rule name'), 'Hairy');
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    type(screen.getByLabelText('Terms (one per line)'), '(a+)+');
    fireEvent.click(screen.getByLabelText('Terms are regular expressions'));
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('The rule was not saved.');
    expect(alert.textContent).toContain('regex "(a+)+" is too complex');
    // The editor stays open so nothing typed is lost.
    expect((screen.getByLabelText<HTMLInputElement>('Rule name')).value).toBe('Hairy');
  });

  it('renders the preview count from the rules.preview reply', async () => {
    const fake = rulesApp([], { previewReply: { matched: 7, total: 40 } });
    await openNewRule();
    type(screen.getByLabelText('Rule name'), 'Cheap');
    // Switch the kind to Price, then add it.
    fireEvent.change(screen.getByLabelText('Kind of condition to add'), { target: { value: 'price' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    type(screen.getByLabelText('Maximum price ($)'), '20');

    await waitFor(() => {
      expect(screen.getByText('Matches 7 of 40 listings on this page.')).toBeTruthy();
    });
    const sent = lastSent(fake, 'rules.preview') as { rule: Rule };
    expect(RuleSchema.safeParse(sent.rule).success).toBe(true);
  });

  it('says so when there is no page to preview against', async () => {
    rulesApp([], { previewReply: { matched: 0, total: 0 } });
    await openNewRule();
    type(screen.getByLabelText('Rule name'), 'x');
    fireEvent.change(screen.getByLabelText('Kind of condition to add'), { target: { value: 'pickupOnly' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }));
    expect(await screen.findByText(/No listings to compare/)).toBeTruthy();
  });

  it('requires a name and at least one condition, and moves focus to the problems', async () => {
    const fake = rulesApp();
    await openNewRule();
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Give the rule a name.');
    expect(alert.textContent).toContain('Add at least one condition');
    await waitFor(() => {
      expect(document.activeElement).toBe(alert);
    });
    expect(fake.sent.some((m) => m.type === 'rules.save')).toBe(false);
  });

  it('opens an existing rule for editing and saves it under the same id', async () => {
    const fake = rulesApp([sampleRule()]);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Pyrex' }));
    const name = await screen.findByLabelText<HTMLInputElement>('Rule name');
    expect(name.value).toBe('Pyrex');
    expect(document.activeElement).toBe(name);
    type(name, 'Pyrex bowls');
    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }));
    await waitFor(() => {
      expect(fake.sent.some((m) => m.type === 'rules.save')).toBe(true);
    });
    expect(lastSent(fake, 'rules.save')).toMatchObject({ id: 'r1', name: 'Pyrex bowls', createdAt: 1, updatedAt: NOW });
  });
});

describe('rule list', () => {
  it('toggles a rule on or off through rules.save', async () => {
    const fake = rulesApp([sampleRule()]);
    fireEvent.click(await screen.findByRole('switch', { name: 'Rule "Pyrex" is on' }));
    await waitFor(() => {
      expect(lastSent(fake, 'rules.save')).toMatchObject({ id: 'r1', enabled: false });
    });
    expect(await screen.findByText('Pyrex is now off.')).toBeTruthy();
  });

  it('asks before deleting, then sends rules.delete', async () => {
    const fake = rulesApp([sampleRule()]);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete Pyrex' }));
    expect(fake.sent.some((m) => m.type === 'rules.delete')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete Pyrex' }));
    await waitFor(() => {
      expect(lastSent(fake, 'rules.delete')).toEqual({ id: 'r1' });
    });
    expect(await screen.findByText(/You have no rules yet/)).toBeTruthy();
  });

  it('reloads when the background announces rules.changed', async () => {
    const fake = new FakeMessaging();
    let list: Rule[] = [];
    fake.handle('rules.list', () => list);
    render(h(RulesSection, { client: fake }));
    await screen.findByText(/You have no rules yet/);
    list = [sampleRule({ name: 'From elsewhere' })];
    fake.broadcast('rules.changed', undefined);
    expect(await screen.findByText('From elsewhere')).toBeTruthy();
  });
});

describe('settings', () => {
  it('persists a dry-run toggle through settings.set, sending the whole group', async () => {
    const fake = settingsApp();
    const toggle = await screen.findByRole('switch', { name: 'Dry run: bidding' });
    expect((toggle as HTMLInputElement).checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(lastSent(fake, 'settings.set')).toEqual({ dryRun: { favorites: true, calendar: true, bidding: false } });
    });
    expect(await screen.findByText('Saved: bidding dry run.')).toBeTruthy();
    expect((screen.getByRole<HTMLInputElement>('switch', { name: 'Dry run: bidding' })).checked).toBe(false);
  });

  it('puts a toggle back and says so when the save fails', async () => {
    const fake = new FakeMessaging();
    fake.handle('settings.get', () => defaultSettings());
    fake.handle('settings.set', () => {
      throw new Error('storage is full');
    });
    render(h(SettingsSection, { client: fake }));
    const toggle = await screen.findByRole('switch', { name: 'Dry run: calendar' });
    fireEvent.click(toggle);
    expect(await screen.findByText(/Could not save calendar dry run\. storage is full/)).toBeTruthy();
    await waitFor(() => {
      expect((screen.getByRole<HTMLInputElement>('switch', { name: 'Dry run: calendar' })).checked).toBe(true);
    });
  });

  it('explains landed cost, defaults it off, and saves the switch', async () => {
    const fake = settingsApp();
    const toggle = await screen.findByRole<HTMLInputElement>('switch', { name: 'Landed cost' });
    expect(toggle.checked).toBe(false);
    expect(screen.getByText('Estimates bid + shipping + handling to your ZIP; makes extra requests to ShopGoodwill.')).toBeTruthy();
    expect(toggle.getAttribute('aria-describedby')).toBe('set-landed-hint');
    fireEvent.click(toggle);
    await waitFor(() => {
      expect(lastSent(fake, 'settings.set')).toMatchObject({ features: { landedCost: true } });
    });
    expect(await screen.findByText(/landed cost needs a home ZIP/)).toBeTruthy();
  });

  it('validates and saves the home ZIP', async () => {
    const fake = settingsApp();
    const zip = await screen.findByLabelText('Home ZIP');
    type(zip, '123');
    fireEvent.click(screen.getByRole('button', { name: 'Save ZIP' }));
    expect(await screen.findByText(/Enter a 5-digit ZIP/)).toBeTruthy();
    expect(fake.sent.some((m) => m.type === 'settings.set')).toBe(false);
    type(zip, '44114');
    fireEvent.click(screen.getByRole('button', { name: 'Save ZIP' }));
    await waitFor(() => {
      expect(lastSent(fake, 'settings.set')).toEqual({ homeZip: '44114' });
    });
  });

  it('shows the 07:00 default run time and saves a new one', async () => {
    const fake = settingsApp();
    const time = await screen.findByLabelText<HTMLInputElement>(/Run time/);
    expect(time.value).toBe('07:00');
    expect(screen.getByLabelText(/Run time \(America\/New_York\)/)).toBeTruthy();
    fireEvent.change(time, { target: { value: '06:30' } });
    await waitFor(() => {
      expect(lastSent(fake, 'settings.set')).toEqual({ dailyRun: { enabled: true, catchUp: true, localTime: '06:30' } });
    });
  });

  it('saves overlay style and considerate mode, and explains considerate mode', async () => {
    const fake = settingsApp();
    fireEvent.click(await screen.findByLabelText('Dim them but keep them in place'));
    await waitFor(() => {
      expect(lastSent(fake, 'settings.set')).toMatchObject({ overlay: { hideStyle: 'dim', enabled: true } });
    });
    expect(screen.getByText(/halves ShopBadwill's daily request budgets and doubles the time between background requests/)).toBeTruthy();
    expect(screen.getByText(/Normal: ShopBadwill's standard/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('Tight'));
    await waitFor(() => {
      expect(lastSent(fake, 'settings.set')).toEqual({ considerateMode: 'tight' });
    });
  });

  it('shows the spend caps read-only as $50 / $100 / $200', async () => {
    settingsApp();
    const heading = await screen.findByRole('heading', { name: 'Spending limits' });
    const card = heading.parentElement as HTMLElement;
    expect(within(card).getByText('$50.00')).toBeTruthy();
    expect(within(card).getByText('$100.00')).toBeTruthy();
    expect(within(card).getByText('$200.00')).toBeTruthy();
    expect(within(card).queryAllByRole('textbox')).toHaveLength(0);
  });

  it('keeps every dry-run state readable without colour', async () => {
    settingsApp();
    const toggle = await screen.findByRole('switch', { name: 'Dry run: favorites' });
    expect(toggle.parentElement?.textContent).toContain('On');
  });
});

describe('shell and registry', () => {
  it('renders the registered sections in order, with a nav and a skip link', async () => {
    const fake = new FakeMessaging();
    fake.handle('rules.list', () => []);
    fake.handle('settings.get', () => defaultSettings());
    render(h(App, { client: fake, sections: loadSections({ './sections/settings/index.tsx': { section: settingsSection }, './sections/rules/index.tsx': { section: rulesSection } }) }));
    expect(screen.getByRole('link', { name: 'Skip to content' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Options sections' });
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Rules', 'Settings']);
    expect(screen.getByRole('heading', { level: 1, name: 'ShopBadwill options' })).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Settings' })).toBeTruthy();
  });

  it('rejects a malformed or duplicate section', () => {
    expect(() => loadSections({ './sections/a/index.tsx': { section: { id: 'A b' } } })).toThrow(/valid "section"/);
    expect(() => loadSections({ './sections/a/index.tsx': {} })).toThrow(/valid "section"/);
    expect(() =>
      loadSections({ './sections/a/index.tsx': { section: rulesSection }, './sections/b/index.tsx': { section: rulesSection } }),
    ).toThrow(/duplicate/);
  });

  it('a section failing to load its data does not break the page', async () => {
    const fake = new FakeMessaging(); // no handlers: every send fails with no_handler
    render(h(App, { client: fake, sections: [settingsSection, rulesSection] }));
    expect(await screen.findByText(/Could not load your settings/)).toBeTruthy();
  });
});

describe('focus management', () => {
  it('focuses the new condition, and a neighbour or the Add button after Remove', async () => {
    rulesApp();
    await openNewRule();
    const add = screen.getByRole('button', { name: 'Add condition' });
    fireEvent.click(add);
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('combobox', { name: 'Match' }));
    });
    fireEvent.click(add);
    const second = screen.getByRole('group', { name: /Condition 2/ });
    await waitFor(() => {
      expect(second.contains(document.activeElement)).toBe(true);
    });
    // Remove the second: focus goes to the previous one.
    fireEvent.click(within(second).getByRole('button', { name: /Remove/ }));
    const first = screen.getByRole('group', { name: /Condition 1/ });
    await waitFor(() => {
      expect(first.contains(document.activeElement)).toBe(true);
    });
    // Remove the last one: focus goes to the Add button.
    fireEvent.click(within(first).getByRole('button', { name: /Remove/ }));
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add condition' }));
    });
  });
});

describe('describeError', () => {
  it('maps messaging codes to plain text', () => {
    const e = (code: ConstructorParameters<typeof MessagingError>[0], m = 'raw') => describeError(new MessagingError(code, m));
    expect(e('no_response')).toMatch(/background isn't responding/);
    expect(e('transport')).toMatch(/reloading the extension/);
    expect(e('forbidden')).toBe('Not allowed.');
    expect(e('bad_sender')).toBe('Not allowed.');
    expect(e('invalid_message')).toBe("That change wasn't valid.");
    expect(e('disabled')).toBe('Turned off in settings.');
    expect(e('handler_error', 'regex too complex')).toBe('regex too complex');
    expect(e('no_handler')).toBe('Something went wrong.');
    expect(describeError(new Error('boom'))).toBe('Something went wrong.');
  });

  it('shows plain text when the background is missing', async () => {
    const fake = new FakeMessaging();
    render(h(SettingsSection, { client: fake }));
    expect(await screen.findByText(/Could not load your settings\. Something went wrong\./)).toBeTruthy();
  });
});

describe('draft conversion and summaries', () => {
  it('builds a schema-valid rule for every condition kind, and round-trips it', () => {
    const inputs: Record<string, Record<string, unknown>> = {
      keyword: { terms: 'pyrex\nfire king' },
      price: { min: '5', max: '20.50' },
      landedCost: { max: '30' },
      seller: { sellerNames: 'Some Store', sellerIds: '12, 34' },
      location: { states: 'oh, pa' },
      category: { categoryIds: '7 8' },
      endsWithin: { max: '90' },
      bidCount: { max: '0' },
      pickupOnly: { pickup: false },
    };
    for (const kind of CONDITION_KINDS) {
      const draft = newRuleDraft('id', 1);
      draft.name = `kind ${kind}`;
      draft.action = 'hide';
      draft.all = [{ ...newCondition(kind, 0), ...inputs[kind] }];
      const result = fromDraft(draft, 5);
      expect(result.ok, kind).toBe(true);
      if (!result.ok) continue;
      expect(RuleSchema.safeParse(result.rule).success, kind).toBe(true);
      const again = fromDraft(toDraft(result.rule), 5);
      expect(again.ok && again.rule, kind).toEqual(result.rule);
      expect(summarizeRule(result.rule).length, kind).toBeGreaterThan(20);
    }
  });

  it('reports field-level errors for bad numbers, states and ranges', () => {
    const draft = newRuleDraft('id', 1);
    draft.name = 'x';
    draft.all = [
      { ...newCondition('price', 0), min: '30', max: '20' },
      { ...newCondition('location', 1), states: 'Ohio' },
      { ...newCondition('bidCount', 2), min: '1.5' },
      { ...newCondition('keyword', 3), terms: ' \n ' },
    ];
    const result = fromDraft(draft, 5);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((e) => e.path)).toEqual(['all.0.max', 'all.1.states', 'all.2.min', 'all.3.terms']);
  });

  it('writes plain-English summaries', () => {
    const rule = sampleRule({
      action: 'hide',
      tone: undefined,
      all: [
        { kind: 'keyword', mode: 'any', terms: ['pyrex', 'fire king'], wholeWord: true, regex: false, fields: ['title', 'category'] },
        { kind: 'price', max: 2000 },
        { kind: 'bidCount', max: 0 },
      ],
      any: [{ kind: 'location', mode: 'include', states: ['OH', 'PA', 'NY'] }],
    });
    expect(summarizeRule(rule)).toBe(
      'Hide listings when title or category contains any of "pyrex", "fire king" (whole words only) and the price is at most $20.00 and it has no bids, and at least one of these is true: the seller is located in OH, PA, or NY.',
    );
    expect(formatMinutes(90)).toBe('1 hour 30 minutes');
    expect(formatMinutes(2880)).toBe('2 days');
    expect(formatMinutes(1)).toBe('1 minute');
  });
});
