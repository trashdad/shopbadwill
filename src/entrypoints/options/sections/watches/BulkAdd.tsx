// T-125: "Add several watches": one watch per pasted line, previewed before anything is saved.
import type { VNode } from 'preact';
import { useMemo, useState } from 'preact/hooks';

import type { SearchQuery } from '../../../../domain/types';
import { DEFAULT_WATCH_FAVORITE_MODE } from '../../../../domain/settings/defaults';
import type { FavoriteMode, Watch } from '../../../../domain/watches/schema';
import { Card, Field } from '../../../../ui/components/Field';
import { DEFAULT_WITHIN_HOURS, MODE_COPY, buildWatch } from './draft';
import { bulkDraft, parseBulkWatches } from './bulk';

export interface BulkAddProps {
  /** The current watches, or null while they load (Add then waits). */
  watches: Watch[] | null;
  /** Saves one watch (the section's `watches.save`). */
  saveWatch: (w: Watch) => Promise<void>;
  newId: () => string;
  /** The first-run time for a new watch, the same as the single-add form's. */
  nextRunAt: () => number;
  /** Creates the shared match-everything rule unless it exists (`rules.save`). */
  ensureMatchAll: () => Promise<void>;
  summarize: (q: SearchQuery) => string;
  describe: (e: unknown) => string;
  /** Called once when the batch is done, with the result line. */
  onDone: (message: string, tone: 'ok' | 'error') => void;
}

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

export function BulkAdd(props: BulkAddProps): VNode {
  const [text, setText] = useState('');
  const [notify, setNotify] = useState(true);
  const [matchAll, setMatchAll] = useState(true);
  const [favoriteMode, setFavoriteMode] = useState<FavoriteMode>(DEFAULT_WATCH_FAVORITE_MODE);
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => parseBulkWatches(text, props.watches ?? []), [text, props.watches]);
  const n = preview.add.length;

  const addAll = async (): Promise<void> => {
    setBusy(true);
    if (matchAll) {
      try {
        await props.ensureMatchAll();
      } catch (e) {
        setBusy(false);
        props.onDone(`Could not create the rule, so no watches were added. ${props.describe(e)}`, 'error');
        return;
      }
    }
    const at = props.nextRunAt();
    const opts = { notify, favoriteMode, matchAll };
    const failed: string[] = [];
    let firstError: unknown;
    let added = 0;
    // One at a time: each save is one local message; no SGW request (the daily job paces the searches).
    for (const entry of preview.add) {
      const built = buildWatch(bulkDraft(entry, props.newId(), opts), at);
      if (!built.ok) {
        failed.push(entry.name);
        continue;
      }
      try {
        await props.saveWatch(built.watch);
        added++;
      } catch (e) {
        failed.push(entry.name);
        firstError ??= e;
      }
    }
    setBusy(false);
    let message = `Added ${plural(added, 'watch', 'watches')}; skipped ${String(preview.skip.length)}.`;
    if (failed.length > 0) {
      message += ` ${String(failed.length)} could not be saved: ${failed.map((f) => `"${f}"`).join(', ')}.`;
      if (firstError !== undefined) message += ` ${props.describe(firstError)}`;
    } else {
      setText('');
    }
    props.onDone(message, failed.length > 0 ? 'error' : 'ok');
  };

  return (
    <Card>
      <h3>Add several watches</h3>
      <Field
        id="watch-bulk"
        label="Search addresses, one per line"
        hint="Write each line as Name | address, or just the address. Without a name, the search text is used."
      >
        {(c) => (
          <textarea
            {...c}
            rows={8}
            value={text}
            onInput={(e) => {
              setText(e.currentTarget.value);
            }}
          />
        )}
      </Field>
      <div>
        <label>
          <input
            id="watch-bulk-notify"
            type="checkbox"
            checked={notify}
            onChange={(e) => {
              setNotify(e.currentTarget.checked);
            }}
          />{' '}
          Notify me about new matches
        </label>
      </div>
      <div>
        <label>
          <input
            id="watch-bulk-match-all"
            type="checkbox"
            checked={matchAll}
            aria-describedby="watch-bulk-match-all-hint"
            onChange={(e) => {
              setMatchAll(e.currentTarget.checked);
            }}
          />{' '}
          Alert on every new item in each search
        </label>
        <p class="sbw-hint" id="watch-bulk-match-all-hint">
          {matchAll
            ? 'Each new watch gets the rule "Match everything new in a search (price at least $0)".'
            : 'New watches start with no rules. Edit each one to add rules; without rules a watch never matches.'}
        </p>
      </div>
      <Field id="watch-bulk-mode" label="Favorites for these watches" hint={MODE_COPY[favoriteMode].text}>
        {(c) => (
          <select
            {...c}
            value={favoriteMode}
            onChange={(e) => {
              setFavoriteMode(e.currentTarget.value as FavoriteMode);
            }}
          >
            {(['sgw', 'sgw-late', 'local'] as const).map((m) => (
              <option key={m} value={m}>
                {MODE_COPY[m].label}
              </option>
            ))}
          </select>
        )}
      </Field>
      {favoriteMode === 'sgw-late' ? (
        <p class="sbw-hint">Matches are favorited {String(DEFAULT_WITHIN_HOURS)} hours before they end. Edit a watch to change that.</p>
      ) : null}
      {n === 0 ? null : (
        <>
          <h4 id="watch-bulk-add-title">Watches to add</h4>
          <ul aria-labelledby="watch-bulk-add-title">
            {preview.add.map((e) => (
              <li key={e.lineNo}>
                <strong>{e.name}</strong>: {props.summarize(e.query)}
              </li>
            ))}
          </ul>
        </>
      )}
      {preview.skip.length === 0 ? null : (
        <>
          <h4 id="watch-bulk-skip-title">Lines that will not be added</h4>
          <ul aria-labelledby="watch-bulk-skip-title">
            {preview.skip.map((s) => (
              <li key={s.lineNo}>
                Line {s.lineNo} ({s.text}): {s.reason}
              </li>
            ))}
          </ul>
        </>
      )}
      <div class="sbw-actions">
        <button
          type="button"
          disabled={busy || n === 0 || props.watches === null}
          onClick={() => {
            void addAll();
          }}
        >
          Add {plural(n, 'watch', 'watches')}
        </button>
      </div>
    </Card>
  );
}
