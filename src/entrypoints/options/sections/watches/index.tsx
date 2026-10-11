import type { VNode } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';

import type { AuthStatus } from '../../../../domain/calendar/types';
import { formatCents } from '../../../../domain/money';
import type { Rule } from '../../../../domain/rules/schema';
import type { Settings } from '../../../../domain/settings/schema';
import type { SearchQuery } from '../../../../domain/types';
import { nextRunAtFor } from '../../../../domain/watches/helpers';
import type { FavoriteMode, Watch } from '../../../../domain/watches/schema';
import { MessagingError } from '../../../../messaging/errors';
import { describeError } from '../../../../ui/components/describeError';
import { Card, Field } from '../../../../ui/components/Field';
import { Status } from '../../../../ui/components/Status';
import type { SectionDef, SectionProps } from '../../registry';
import {
  MATCH_ALL_RULE_ID,
  buildWatch,
  draftFromWatch,
  matchEverythingRule,
  newDraft,
  pickSearchTab,
  queryFromUrl,
  type WatchDraft,
} from './draft';

export interface WatchesSectionProps extends SectionProps {
  /** Injectable for tests. Resolves the URL of the SGW search tab to use, or undefined when there is none. */
  getActiveTabUrl?: () => Promise<string | undefined>;
  now?: () => number;
  newId?: () => string;
  timeZone?: string;
}

type Msg = { message: string; tone: 'ok' | 'error' };

/** The most recently used ShopGoodwill search tab in any window; the options page itself is never one. */
async function activeTabUrl(): Promise<string | undefined> {
  try {
    const tabs = await browser.tabs.query({ url: ['https://shopgoodwill.com/*', 'https://www.shopgoodwill.com/*'] });
    return pickSearchTab(tabs);
  } catch {
    return undefined;
  }
}

function problem(what: string, e: unknown): string {
  if (e instanceof MessagingError && e.code === 'no_handler') {
    return `${what} Watches are not available yet: the background part of the extension has no watches support.`;
  }
  return `${what} ${describeError(e)}`;
}

const MODE_COPY: Record<FavoriteMode, { label: string; text: string }> = {
  sgw: {
    label: 'Favorite on ShopGoodwill right away (recommended)',
    text: 'Matches are added to your ShopGoodwill favorites as soon as they are found, so you see them in your account.',
  },
  'sgw-late': {
    label: 'Favorite on ShopGoodwill shortly before the auction ends',
    text: 'Matches are favorited only in the last hours before they end.',
  },
  local: {
    label: 'Track in ShopBadwill only',
    text: 'Matches are tracked here and nothing is written to your ShopGoodwill account.',
  },
};

/** Plain text summary of a query; search terms are only ever rendered as text. */
export function summarizeQuery(q: SearchQuery): string {
  const parts: string[] = [q.searchText === '' ? 'Any text' : `"${q.searchText}"`];
  if (q.categoryIds.length > 0) parts.push(`${String(q.categoryIds.length)} categor${q.categoryIds.length === 1 ? 'y' : 'ies'}`);
  if (q.sellerIds.length > 0) parts.push(`${String(q.sellerIds.length)} seller${q.sellerIds.length === 1 ? '' : 's'}`);
  if (q.lowPrice !== undefined) parts.push(`from $${formatCents(q.lowPrice)}`);
  if (q.highPrice !== undefined) parts.push(`up to $${formatCents(q.highPrice)}`);
  if (q.closedAuctions === true) parts.push('closed auctions');
  return parts.join(', ');
}

export function WatchesSection(props: WatchesSectionProps): VNode {
  const { client } = props;
  const now = props.now ?? Date.now;
  const newId = props.newId ?? (() => crypto.randomUUID());
  const readTab = props.getActiveTabUrl ?? activeTabUrl;
  const timeZone = props.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const [watches, setWatches] = useState<Watch[] | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [statusFailed, setStatusFailed] = useState(false);
  const [prunedNote, setPrunedNote] = useState('');
  const [rulesLoaded, setRulesLoaded] = useState(false);
  const [status, setStatus] = useState<Msg>({ message: '', tone: 'ok' });
  const [pasteUrl, setPasteUrl] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const [sourceError, setSourceError] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState<WatchDraft | null>(null);
  const [editingBase, setEditingBase] = useState<Watch | undefined>(undefined);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadWatches = useCallback(() => {
    client.send('watches.list', undefined).then(
      (list) => {
        setWatches(list);
      },
      (e: unknown) => {
        setWatches((w) => w ?? []);
        setStatus({ message: problem('Could not load your watches.', e), tone: 'error' });
      },
    );
  }, [client]);

  const loadRules = useCallback(() => {
    client.send('rules.list', undefined).then(
      (list) => {
        setRules(list);
        setRulesLoaded(true);
      },
      () => {
        /* the rule list stays empty; the no-rules warning still shows */
      },
    );
  }, [client]);

  useEffect(() => {
    loadWatches();
    loadRules();
    const failed = (): void => {
      setStatusFailed(true);
    };
    client.send('settings.get', undefined).then(setSettings, failed);
    client.send('calendar.status', undefined).then(setAuth, failed);
    return client.onBroadcast('rules.changed', loadRules);
  }, [client, loadWatches, loadRules]);

  const openDraft = (d: WatchDraft, base?: Watch): void => {
    const known = d.ruleIds.filter((id) => rules.some((r) => r.id === id));
    const gone = d.ruleIds.length - known.length;
    if (rulesLoaded && gone > 0) {
      d = { ...d, ruleIds: known };
      setPrunedNote(
        `${String(gone)} rule${gone === 1 ? '' : 's'} that no longer exist${gone === 1 ? 's' : ''} ${gone === 1 ? 'was' : 'were'} removed from this watch. Save to keep the change.`,
      );
    } else {
      setPrunedNote('');
    }
    setDraft(d);
    setEditingBase(base);
    setErrors({});
    queueMicrotask(() => document.getElementById('watch-name')?.focus());
  };

  const fromUrl = (url: string | undefined): void => {
    if (url === undefined) {
      setShowPaste(true);
      setSourceError('No ShopGoodwill search tab is open. Paste the search address below instead.');
      return;
    }
    const r = queryFromUrl(url);
    if (!r.ok) {
      setSourceError(r.error);
      return;
    }
    setSourceError(undefined);
    openDraft(newDraft(newId(), r.query));
  };

  const useCurrentTab = (): void => {
    void readTab().then(fromUrl);
  };

  const closeDraft = (): void => {
    setDraft(null);
    setEditingBase(undefined);
    queueMicrotask(() => document.getElementById('use-tab-button')?.focus());
  };

  const calendarOn = settings?.calendar.enabled === true;
  const calendarConnected = auth?.connected === true;
  const calendarDisabled = !calendarOn || !calendarConnected;
  const calendarHint = statusFailed
    ? 'Could not check your calendar status, so this stays off. Reload the page to try again.'
    : !calendarConnected
    ? 'Connect Google Calendar in the Google Calendar section to turn this on.'
    : !calendarOn
      ? 'Calendar events are turned off in Settings. Turn them on to use this.'
      : 'Adds matches to your calendar.';

  const enabledSelected = (d: WatchDraft): number =>
    d.ruleIds.filter((id) => rules.some((r) => r.id === id && r.enabled)).length;

  const save = async (): Promise<void> => {
    if (draft === null) return;
    let nextRunAt = editingBase?.nextRunAt ?? now();
    if (editingBase === undefined && settings !== null) {
      try {
        nextRunAt = nextRunAtFor(settings, now(), timeZone);
      } catch {
        /* keep now(): the scheduler recomputes */
      }
    }
    const built = buildWatch(draft, nextRunAt, editingBase);
    if (!built.ok) {
      setErrors(built.errors);
      return;
    }
    setBusy(true);
    try {
      await client.send('watches.save', built.watch);
      setStatus({ message: `Saved "${built.watch.name}".`, tone: 'ok' });
      closeDraft();
      loadWatches();
    } catch (e) {
      setErrors({ form: problem('Could not save the watch.', e) });
    } finally {
      setBusy(false);
    }
  };

  const addMatchAll = async (): Promise<void> => {
    if (draft === null) return;
    try {
      if (!rules.some((r) => r.id === MATCH_ALL_RULE_ID)) {
        const rule = matchEverythingRule(now());
        await client.send('rules.save', rule);
        setRules((l) => [...l, rule]);
      }
      setDraft((d) =>
        d === null || d.ruleIds.includes(MATCH_ALL_RULE_ID) ? d : { ...d, ruleIds: [...d.ruleIds, MATCH_ALL_RULE_ID] },
      );
    } catch (e) {
      setErrors({ form: problem('Could not create the rule.', e) });
    }
  };

  const toggleEnabled = (w: Watch, enabled: boolean): void => {
    client.send('watches.save', { ...w, enabled }).then(
      () => {
        setWatches((l) => (l ?? []).map((x) => (x.id === w.id ? { ...x, enabled } : x)));
        setStatus({ message: `"${w.name}" is now ${enabled ? 'on' : 'off'}.`, tone: 'ok' });
      },
      (e: unknown) => {
        setStatus({ message: problem(`Could not change "${w.name}".`, e), tone: 'error' });
      },
    );
  };

  const remove = (w: Watch): void => {
    setConfirmDelete(null);
    client.send('watches.delete', { id: w.id }).then(
      () => {
        setWatches((l) => (l ?? []).filter((x) => x.id !== w.id));
        setStatus({ message: `Deleted "${w.name}".`, tone: 'ok' });
      },
      (e: unknown) => {
        setStatus({ message: problem(`Could not delete "${w.name}".`, e), tone: 'error' });
      },
    );
  };

  const importSaved = (): void => {
    setBusy(true);
    setStatus({ message: 'Importing your saved searches...', tone: 'ok' });
    client.send('watches.importSaved', undefined).then(
      (r) => {
        setBusy(false);
        setStatus({
          message:
            r.imported === 0 && r.skipped === 0
              ? 'No saved searches were found on your ShopGoodwill account.'
              : `Imported ${String(r.imported)} saved search${r.imported === 1 ? '' : 'es'}. Skipped ${String(r.skipped)} already here.`,
          tone: 'ok',
        });
        loadWatches();
      },
      (e: unknown) => {
        setBusy(false);
        setStatus({ message: problem('Could not import your saved searches.', e), tone: 'error' });
      },
    );
  };

  const patch = (p: Partial<WatchDraft>): void => {
    setDraft((d) => (d === null ? d : { ...d, ...p }));
  };

  return (
    <div class="sbw-watches">
      <p class="sbw-lede">
        A watch is a ShopGoodwill search that ShopBadwill runs for you each day. Open a search on shopgoodwill.com, then
        choose Use my current tab.
      </p>
      <Status message={status.message} tone={status.tone} />

      <div class="sbw-actions">
        <button id="use-tab-button" type="button" onClick={useCurrentTab}>
          Use my current tab
        </button>
        <button
          type="button"
          class="sbw-secondary"
          aria-expanded={showPaste}
          onClick={() => {
            setShowPaste((v) => !v);
          }}
        >
          Paste a search address
        </button>
        <button type="button" class="sbw-secondary" disabled={busy} onClick={importSaved}>
          Import my saved searches from ShopGoodwill
        </button>
      </div>
      {sourceError === undefined ? null : (
        <p class="sbw-error" role="alert">
          <strong>Error:</strong> {sourceError}
        </p>
      )}
      {showPaste ? (
        <Field id="watch-paste" label="ShopGoodwill search address" hint="Copy the address from a search results page.">
          {(c) => (
            <div class="sbw-actions">
              <input
                {...c}
                type="url"
                value={pasteUrl}
                onInput={(e) => {
                  setPasteUrl(e.currentTarget.value);
                }}
              />
              <button
                type="button"
                onClick={() => {
                  fromUrl(pasteUrl);
                }}
              >
                Use this address
              </button>
            </div>
          )}
        </Field>
      ) : null}

      {draft === null ? null : (
        <Card>
          <h3>{editingBase === undefined ? 'New watch' : 'Edit watch'}</h3>
          <p>
            Search: <span data-testid="watch-query">{summarizeQuery(draft.query)}</span>
          </p>
          {errors['query'] === undefined ? null : (
            <p class="sbw-error" role="alert">
              <strong>Error:</strong> {errors['query']}
            </p>
          )}
          {prunedNote === '' ? null : (
            <p class="sbw-hint" role="status">
              {prunedNote}
            </p>
          )}
          <Field id="watch-name" label="Name" error={errors['name']}>
            {(c) => (
              <input
                {...c}
                type="text"
                value={draft.name}
                onInput={(e) => {
                  patch({ name: e.currentTarget.value });
                }}
              />
            )}
          </Field>

          <fieldset>
            <legend>Rules that decide a match</legend>
            {rules.length === 0 ? <p class="sbw-empty">You have no rules yet.</p> : null}
            {rules.map((r) => (
              <div key={r.id}>
                <label>
                  <input
                    type="checkbox"
                    checked={draft.ruleIds.includes(r.id)}
                    onChange={(e) => {
                      const on = e.currentTarget.checked;
                      patch({ ruleIds: on ? [...draft.ruleIds, r.id] : draft.ruleIds.filter((id) => id !== r.id) });
                    }}
                  />{' '}
                  {r.name === '' ? 'Untitled rule' : r.name}
                  {r.enabled ? '' : ' (off)'}
                </label>
              </div>
            ))}
            {enabledSelected(draft) === 0 ? (
              <div class="sbw-warning" role="alert">
                <p>No rules: this watch will never match.</p>
                <button
                  type="button"
                  class="sbw-secondary"
                  onClick={() => {
                    void addMatchAll();
                  }}
                >
                  Match everything new in this search
                </button>
              </div>
            ) : null}
          </fieldset>

          <fieldset>
            <legend>Favorites</legend>
            <p class="sbw-hint">
              Some shoppers report that favoriting an item can attract other bidders to it. That is anecdotal and not
              confirmed. If you worry about it, pick one of the last two choices.
            </p>
            {(['sgw', 'sgw-late', 'local'] as const).map((m) => (
              <div key={m}>
                <label>
                  <input
                    type="radio"
                    name="watch-favorite-mode"
                    value={m}
                    checked={draft.favoriteMode === m}
                    aria-describedby={`watch-mode-${m}`}
                    onChange={() => {
                      patch({ favoriteMode: m });
                    }}
                  />{' '}
                  {MODE_COPY[m].label}
                </label>
                <p class="sbw-hint" id={`watch-mode-${m}`}>
                  {MODE_COPY[m].text}
                </p>
              </div>
            ))}
            {draft.favoriteMode === 'sgw-late' ? (
              <Field id="watch-within" label="Hours before the end" error={errors['within']}>
                {(c) => (
                  <input
                    {...c}
                    type="number"
                    min="1"
                    value={draft.withinHours}
                    onInput={(e) => {
                      patch({ withinHours: e.currentTarget.value });
                    }}
                  />
                )}
              </Field>
            ) : null}
          </fieldset>

          <Field id="watch-pages" label="Pages to search" hint="Each page has 40 listings.">
            {(c) => (
              <select
                {...c}
                value={String(draft.maxPages)}
                onChange={(e) => {
                  patch({ maxPages: Number(e.currentTarget.value) as 1 | 2 | 3 });
                }}
              >
                <option value="1">1 page</option>
                <option value="2">2 pages</option>
                <option value="3">3 pages</option>
              </select>
            )}
          </Field>

          <div>
            <label>
              <input
                id="watch-calendar"
                type="checkbox"
                checked={draft.calendar && !calendarDisabled}
                disabled={calendarDisabled}
                aria-describedby="watch-calendar-hint"
                onChange={(e) => {
                  patch({ calendar: e.currentTarget.checked });
                }}
              />{' '}
              Add matches to my calendar
            </label>
            <p class="sbw-hint" id="watch-calendar-hint">
              {calendarHint}
            </p>
          </div>
          <div>
            <label>
              <input
                type="checkbox"
                checked={draft.notify}
                onChange={(e) => {
                  patch({ notify: e.currentTarget.checked });
                }}
              />{' '}
              Notify me about new matches
            </label>
          </div>

          {errors['form'] === undefined ? null : (
            <p class="sbw-error" role="alert">
              <strong>Error:</strong> {errors['form']}
            </p>
          )}
          <div class="sbw-actions">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void save();
              }}
            >
              Save watch
            </button>
            <button type="button" class="sbw-secondary" onClick={closeDraft}>
              Cancel
            </button>
          </div>
        </Card>
      )}

      {watches === null ? (
        <p>Loading your watches...</p>
      ) : watches.length === 0 ? (
        <p class="sbw-empty">You have no watches yet.</p>
      ) : (
        <ul class="sbw-rule-list" aria-label="Your watches">
          {watches.map((w) => (
            <li key={w.id} class="sbw-rule" data-enabled={String(w.enabled)}>
              <div class="sbw-rule-head">
                <h3>{w.name === '' ? 'Untitled watch' : w.name}</h3>
                <span class="sbw-tag">{w.enabled ? 'On' : 'Off'}</span>
              </div>
              <p>
                {summarizeQuery(w.query)}. {w.maxPages} page{w.maxPages === 1 ? '' : 's'}, favorites: {w.favoriteMode}
                {w.calendar ? ', calendar' : ''}.
              </p>
              {w.ruleIds.length === 0 ? <p class="sbw-hint">No rules: this watch will never match.</p> : null}
              {w.lastError === undefined ? null : <p class="sbw-hint">Last error: {w.lastError}</p>}
              <div class="sbw-actions">
                <label>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={w.enabled}
                    aria-label={`Watch "${w.name}" is on`}
                    onChange={(e) => {
                      toggleEnabled(w, e.currentTarget.checked);
                    }}
                  />{' '}
                  On
                </label>
                <button
                  type="button"
                  class="sbw-secondary"
                  aria-label={`Edit ${w.name}`}
                  onClick={() => {
                    openDraft(draftFromWatch(w), w);
                  }}
                >
                  Edit
                </button>
                {confirmDelete === w.id ? (
                  <>
                    <button
                      type="button"
                      class="sbw-danger"
                      aria-label={`Confirm delete ${w.name}`}
                      onClick={() => {
                        remove(w);
                      }}
                    >
                      Yes, delete
                    </button>
                    <button
                      type="button"
                      class="sbw-secondary"
                      onClick={() => {
                        setConfirmDelete(null);
                      }}
                    >
                      Keep it
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    class="sbw-secondary"
                    aria-label={`Delete ${w.name}`}
                    onClick={() => {
                      setConfirmDelete(w.id);
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const section: SectionDef = { id: 'watches', title: 'Watches', order: 15, Component: WatchesSection };
