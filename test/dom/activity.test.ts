import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuditEntry } from '../../src/domain/audit/types';
import { loadSections } from '../../src/entrypoints/options/registry';
import { section } from '../../src/entrypoints/options/sections/activity';
import { MessagingError } from '../../src/messaging/errors';
import { ActivityList } from '../../src/ui/activity';
import { FakeMessaging } from '../fakes/ports/fake-messaging';

afterEach(cleanup);

const entry = (seq: number, over: Partial<AuditEntry> = {}): AuditEntry => ({
  seq,
  at: 1_790_000_000_000,
  actor: 'daily-job',
  kind: 'favorite.add',
  itemId: 100 + seq,
  details: {},
  undo: { kind: 'unfavorite', ref: `removeFavorite:${String(100 + seq)}` },
  ...over,
});

function app(entries: AuditEntry[], pageSize = 50) {
  const fake = new FakeMessaging();
  fake.handle('audit.list', ({ before }) =>
    entries
      .filter((e) => before === undefined || e.seq < before)
      .sort((a, b) => b.seq - a.seq)
      .slice(0, pageSize),
  );
  return fake;
}
const mount = (fake: FakeMessaging, pageSize = 50) =>
  render(h(ActivityList, { client: fake, userTz: 'America/New_York', pageSize }));
const undos = (f: FakeMessaging) => f.sent.filter((m) => m.type === 'audit.undo');

describe('activity list', () => {
  it('registers as a valid section', () => {
    expect(loadSections({ './x': { section } })).toHaveLength(1);
  });

  it('undo sends audit.undo and disables the button once done', async () => {
    const fake = app([entry(1)]);
    fake.handle('audit.undo', () => undefined);
    mount(fake);
    fireEvent.click(await screen.findByRole('button', { name: /Undo: Unfavorite for item 101/ }));
    await waitFor(() => {
      expect(screen.getByRole<HTMLButtonElement>('button', { name: /Undone: Unfavorite/ }).disabled).toBe(true);
    });
    expect(undos(fake)).toEqual([{ type: 'audit.undo', payload: { seq: 1 } }]);
  });

  it('shows done entries disabled and leaves a failed undo retryable', async () => {
    const fake = app([entry(2), entry(1, { undo: { kind: 'unfavorite', ref: 'removeFavorite:101', done: true } })]);
    let fail = true;
    fake.handle('audit.undo', () => {
      if (fail) throw new MessagingError('handler_error', 'not now: kill switch is on');
      return undefined;
    });
    mount(fake);
    const btns = await screen.findAllByRole<HTMLButtonElement>('button', { name: /Undo/ });
    expect(btns.map((b) => b.disabled)).toEqual([false, true]);
    fireEvent.click(btns[0] as HTMLButtonElement);
    await screen.findByText(/not now: kill switch is on/);
    const retry = screen.getByRole<HTMLButtonElement>('button', { name: /^Undo: Unfavorite for item 102/ });
    expect(retry.disabled).toBe(false);
    fail = false;
    fireEvent.click(retry);
    await waitFor(() => {
      expect(undos(fake)).toHaveLength(2);
    });
  });

  it('renders site-derived strings as text, never HTML', async () => {
    const fake = app([entry(1, { details: { title: '<img src=x onerror=alert(1)>' } })]);
    mount(fake);
    await screen.findByText(/<img src=x/);
    expect(document.querySelector('img')).toBeNull();
  });

  it('loads more with before', async () => {
    const fake = app([entry(1), entry(2), entry(3)], 2);
    mount(fake, 2);
    fireEvent.click(await screen.findByRole('button', { name: 'Load more' }));
    await waitFor(() => {
      expect(screen.getAllByRole('listitem')).toHaveLength(3);
    });
    expect(fake.sent.filter((m) => m.type === 'audit.list').map((m) => m.payload)).toEqual([
      { limit: 2 },
      { limit: 2, before: 2 },
    ]);
  });
});
