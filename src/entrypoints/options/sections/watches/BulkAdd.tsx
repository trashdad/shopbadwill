// T-125: "Add several watches": one watch per pasted line, previewed before anything is saved.
import type { VNode } from 'preact';
import { useMemo, useState } from 'preact/hooks';

import type { SearchQuery } from '../../../../domain/types';
import type { Watch } from '../../../../domain/watches/schema';
import { Card, Field } from '../../../../ui/components/Field';
import { buildWatch } from './draft';
import { bulkDraft, parseBulkWatches } from './bulk';

export interface BulkAddProps {
  /** The current watches, or null while they load (Add then waits). */
  watches: Watch[] | null;
  /** Saves one watch (the section's `watches.save`). */
  saveWatch: (w: Watch) => Promise<void>;
  newId: () => string;
  /** The first-run time for a new watch, the same as the single-add form's. */
  nextRunAt: () => number;
  summarize: (q: SearchQuery) => string;
  describe: (e: unknown) => string;
  /** Called once when the batch is done, with the result line. */
  onDone: (message: string, tone: 'ok' | 'error') => void;
}

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

export function BulkAdd(props: BulkAddProps): VNode {
  const [text, setText] = useState('');
  const [notify, setNotify] = useState(true);
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => parseBulkWatches(text, props.watches ?? []), [text, props.watches]);
  const n = preview.add.length;

  const addAll = async (): Promise<void> => {
    setBusy(true);
    const at = props.nextRunAt();
    const failed: string[] = [];
    let firstError: unknown;
    let added = 0;
    // One at a time: each save is one local message; no SGW request (the daily job paces the searches).
    for (const entry of preview.add) {
      const built = buildWatch(bulkDraft(entry, props.newId(), notify), at);
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
      <p class="sbw-hint">
        New watches start with no rules and favorite on ShopGoodwill right away, like a single new watch. Edit each one to
        add rules; without rules a watch never matches.
      </p>
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
