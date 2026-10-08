// T-114: the import/export/templates options section, driven through FakeMessaging.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';

import { exportRules } from '../../src/domain/rules/io';
import { RuleSchema, type Rule } from '../../src/domain/rules/schema';
import { MessagingError } from '../../src/messaging/errors';
import { loadSections } from '../../src/entrypoints/options/registry';
import { IoSection, section } from '../../src/entrypoints/options/sections/io';
import { FakeMessaging } from '../fakes/ports/fake-messaging';

afterEach(cleanup);

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: 'r1',
  name: 'Pyrex',
  enabled: true,
  action: 'highlight',
  all: [{ kind: 'pickupOnly', value: true }],
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

function app(existing: Rule[] = []) {
  const fake = new FakeMessaging();
  fake.handle('rules.list', () => existing);
  fake.handle('rules.save', () => undefined);
  let n = 0;
  render(h(IoSection, { client: fake, now: () => 1000, newId: () => `id-${String(++n)}` }));
  return fake;
}
const saved = (fake: FakeMessaging) => fake.sent.filter((m) => m.type === 'rules.save').map((m) => m.payload);

describe('io section', () => {
  it('registers as a valid section', () => {
    expect(loadSections({ './x': { section } })).toHaveLength(1);
  });

  it('exports into a textarea', async () => {
    app([rule()]);
    fireEvent.click(screen.getByRole('button', { name: 'Export rules' }));
    const box = await screen.findByLabelText<HTMLTextAreaElement>('Exported rules');
    expect(JSON.parse(box.value)).toMatchObject({ format: 'shopbadwill.rules', version: 1 });
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy();
  });

  it('previews, and saves only after confirmation', async () => {
    const fake = app([rule({ id: 'old' })]);
    fireEvent.input(screen.getByLabelText('Paste exported rules'), { target: { value: exportRules([rule({ id: 'zzz' })]) } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview import' }));
    await screen.findByText(/Will be added/);
    expect(screen.getByText(/already have/)).toBeTruthy();
    expect(saved(fake)).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Add 1 rule' }));
    await waitFor(() => { expect(saved(fake)).toHaveLength(1); });
    const p = RuleSchema.parse(saved(fake)[0]);
    expect(p.id).toBe('id-1');
  });

  it('shows errors and saves nothing for bad input', async () => {
    const fake = app();
    fireEvent.input(screen.getByLabelText('Paste exported rules'), { target: { value: '{nope' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview import' }));
    await screen.findByLabelText('Problems with the import');
    expect(saved(fake)).toHaveLength(0);
  });

  it('adds a template through rules.save', async () => {
    const fake = app();
    fireEvent.click(screen.getByRole('button', { name: 'Add "Local pickup only items: hide"' }));
    await waitFor(() => { expect(saved(fake)).toHaveLength(1); });
    expect(RuleSchema.parse(saved(fake)[0]).action).toBe('hide');
    expect(screen.getByText(/off by default/)).toBeTruthy();
  });

  it('reports a failed template save', async () => {
    const fake = new FakeMessaging();
    fake.handle('rules.list', () => []);
    fake.handle('rules.save', () => { throw new MessagingError('handler_error', 'Disk full'); });
    render(h(IoSection, { client: fake }));
    fireEvent.click(screen.getByRole('button', { name: 'Add "No clothing lots: hide by keyword"' }));
    await screen.findByText(/Could not add/);
  });

  it('reads a chosen file and previews it; re-picking the same file fires again', async () => {
    app();
    const input = screen.getByLabelText<HTMLInputElement>('Or choose an exported file');
    const file = new File([exportRules([rule()])], 'rules.json', { type: 'application/json' });
    fireEvent.change(input, { target: { files: [file] } });
    await screen.findByText(/Will be added/);
    expect(input.value).toBe('');
  });

  it('refuses an oversized file without reading it', async () => {
    const fake = app();
    const input = screen.getByLabelText('Or choose an exported file');
    let read = false;
    const big = { size: 2_000_001, text: () => { read = true; return Promise.resolve(''); } };
    fireEvent.change(input, { target: { files: [big] } });
    await screen.findByLabelText('Problems with the import');
    expect(screen.getByText(/too large/)).toBeTruthy();
    expect(read).toBe(false);
    expect(saved(fake)).toHaveLength(0);
  });

  it('reports 501 rules as too many', async () => {
    app();
    const many = Array.from({ length: 501 }, (_, i) => rule({ id: `i${String(i)}` }));
    fireEvent.input(screen.getByLabelText('Paste exported rules'), { target: { value: exportRules(many) } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview import' }));
    await screen.findByText(/more than 500/);
  });

  it('keeps only the unsaved remainder after a partial save failure', async () => {
    const fake = new FakeMessaging();
    fake.handle('rules.list', () => []);
    let calls = 0;
    fake.handle('rules.save', () => {
      if (++calls === 2) throw new MessagingError('handler_error', 'Disk full');
      return undefined;
    });
    let n = 0;
    render(h(IoSection, { client: fake, now: () => 1000, newId: () => `id-${String(++n)}` }));
    const three = [rule({ id: 'a', name: 'A' }), rule({ id: 'b', name: 'B' }), rule({ id: 'c', name: 'C' })];
    fireEvent.input(screen.getByLabelText('Paste exported rules'), { target: { value: exportRules(three) } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview import' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add 3 rules' }));
    await screen.findByText(/Added 1, but could not add the other 2/);
    expect(screen.getByRole('button', { name: 'Add 2 rules' })).toBeTruthy();
    const box = screen.getByLabelText<HTMLTextAreaElement>('Paste exported rules');
    const names = (JSON.parse(box.value) as { rules: Rule[] }).rules.map((r) => r.name);
    expect(names).toEqual(['B', 'C']);
  });

  it('ignores repeated clicks on a template while it is saving', async () => {
    const fake = new FakeMessaging();
    fake.handle('rules.list', () => []);
    fake.handle('rules.save', () => new Promise<undefined>((r) => setTimeout(() => { r(undefined); }, 20)));
    render(h(IoSection, { client: fake }));
    const btn = screen.getByRole('button', { name: 'Add "Local pickup only items: hide"' });
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    await screen.findByText(/Added "Local pickup/);
    expect(saved(fake)).toHaveLength(1);
  });
});
