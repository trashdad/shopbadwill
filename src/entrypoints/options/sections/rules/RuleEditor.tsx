import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { Rule } from '../../../../domain/rules/schema';
import type { MessagingClient } from '../../../../ports/messaging';
import { Field } from '../../../../ui/components/Field';
import { describeError } from '../../../../ui/components/describeError';
import { Status } from '../../../../ui/components/Status';
import { ConditionEditor } from './ConditionEditor';
import {
  CONDITION_KINDS,
  KIND_LABELS,
  fromDraft,
  newCondition,
  newRuleDraft,
  nextKey,
  toDraft,
  type ConditionDraft,
  type ConditionKind,
  type DraftError,
  type DraftGroup,
  type RuleDraft,
} from './draft';
import { summarizeRule } from './summary';

export interface RuleEditorProps {
  client: MessagingClient;
  /** The rule being edited; undefined creates a new one. */
  rule: Rule | undefined;
  now: () => number;
  newId: () => string;
  /** Wait before asking for a preview after an edit. */
  previewDelayMs: number;
  onSaved: (rule: Rule) => void;
  onCancel: () => void;
}

type Preview =
  | { state: 'incomplete' }
  | { state: 'loading' }
  | { state: 'ready'; matched: number; total: number }
  | { state: 'failed'; message: string };

export function RuleEditor(props: RuleEditorProps): VNode {
  const { client } = props;
  const [draft, setDraft] = useState<RuleDraft>(() =>
    props.rule === undefined ? newRuleDraft(props.newId(), props.now()) : toDraft(props.rule),
  );
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const [preview, setPreview] = useState<Preview>({ state: 'incomplete' });
  const [addKind, setAddKind] = useState<ConditionKind>('keyword');
  const summaryRef = useRef<HTMLDivElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const pendingFocus = useRef<string | null>(null);

  const result = fromDraft(draft, props.now());
  const errors: readonly DraftError[] = result.ok ? [] : result.errors;
  const shownErrors = submitted ? errors : [];
  const errorAt = (path: string): string | undefined => shownErrors.find((e) => e.path === path)?.message;

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Live preview: debounced, and a stale reply never overwrites a newer one.
  const previewKey = result.ok ? JSON.stringify({ ...result.rule, updatedAt: 0 }) : '';
  useEffect(() => {
    if (!result.ok) {
      setPreview({ state: 'incomplete' });
      return;
    }
    const rule = result.rule;
    let cancelled = false;
    setPreview({ state: 'loading' });
    const timer = setTimeout(() => {
      client.send('rules.preview', { rule }).then(
        (r) => {
          if (!cancelled) setPreview({ state: 'ready', matched: r.matched, total: r.total });
        },
        (e: unknown) => {
          if (!cancelled) setPreview({ state: 'failed', message: describeError(e) });
        },
      );
    }, props.previewDelayMs);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // result is derived from draft; previewKey changes exactly when the rule content does.
  }, [previewKey, client, props.previewDelayMs]);

  // Focus follows add/remove: the new condition's first control, a neighbour, or the Add button.
  useEffect(() => {
    const id = pendingFocus.current;
    if (id === null) return;
    pendingFocus.current = null;
    const el = document.getElementById(id);
    const target = el instanceof HTMLFieldSetElement ? el.querySelector<HTMLElement>('input, select, textarea') : el;
    target?.focus();
  }, [draft]);

  const patch = (p: Partial<RuleDraft>): void => {
    setDraft((d) => ({ ...d, ...p }));
  };
  const patchCondition = (group: DraftGroup, key: number, p: Partial<ConditionDraft>): void => {
    setDraft((d) => ({ ...d, [group]: d[group].map((c) => (c.key === key ? { ...c, ...p } : c)) }));
  };
  const addCondition = (group: DraftGroup): void => {
    const key = nextKey(draft);
    pendingFocus.current = `cond-${group}-${String(key)}`;
    setDraft((d) => ({ ...d, [group]: [...d[group], newCondition(addKind, key)] }));
  };
  const removeCondition = (group: DraftGroup, key: number): void => {
    const list = draft[group];
    const at = list.findIndex((c) => c.key === key);
    const neighbour = list[at + 1] ?? list[at - 1];
    pendingFocus.current = neighbour === undefined ? `add-${group}` : `cond-${group}-${String(neighbour.key)}`;
    setDraft((d) => ({ ...d, [group]: d[group].filter((c) => c.key !== key) }));
  };

  const submit = (e: Event): void => {
    e.preventDefault();
    setSubmitted(true);
    setSaveError('');
    if (!result.ok) {
      queueMicrotask(() => summaryRef.current?.focus());
      return;
    }
    const rule = result.rule;
    setSaving(true);
    client.send('rules.save', rule).then(
      () => {
        setSaving(false);
        props.onSaved(rule);
      },
      (err: unknown) => {
        setSaving(false);
        setSaveError(`The rule was not saved. ${describeError(err)}`);
        queueMicrotask(() => summaryRef.current?.focus());
      },
    );
  };

  const conditionGroup = (group: DraftGroup, heading: string, help: string): VNode => (
    <section class="sbw-group" aria-labelledby={`group-${group}`}>
      <h4 id={`group-${group}`}>{heading}</h4>
      <p class="sbw-hint">{help}</p>
      {draft[group].map((c, i) => (
        <ConditionEditor
          key={c.key}
          group={group}
          index={i}
          draft={c}
          errors={shownErrors}
          onChange={(p) => {
            patchCondition(group, c.key, p);
          }}
          onRemove={() => {
            removeCondition(group, c.key);
          }}
        />
      ))}
      <button
        id={`add-${group}`}
        type="button"
        class="sbw-secondary"
        onClick={() => {
          addCondition(group);
        }}
      >
        {group === 'all' ? 'Add condition' : 'Add alternative'}
      </button>
    </section>
  );

  const previewText =
    preview.state === 'ready'
      ? preview.total === 0
        ? 'No listings to compare. Open a ShopGoodwill search page in a tab, then edit the rule again.'
        : `Matches ${String(preview.matched)} of ${String(preview.total)} listings on this page.`
      : preview.state === 'loading'
        ? 'Checking the page you have open...'
        : preview.state === 'failed'
          ? `Preview unavailable. ${preview.message}`
          : 'The preview appears once the rule is complete.';

  const heading = props.rule === undefined ? 'New rule' : 'Edit rule';
  return (
    <form class="sbw-editor" aria-labelledby="rule-editor-heading" onSubmit={submit} noValidate>
      <h3 id="rule-editor-heading">{heading}</h3>

      <div ref={summaryRef} tabIndex={-1} role={shownErrors.length > 0 || saveError !== '' ? 'alert' : undefined}>
        {saveError === '' ? null : <p class="sbw-error">{saveError}</p>}
        {shownErrors.length === 0 ? null : (
          <>
            <p class="sbw-error">
              <strong>Fix {String(shownErrors.length)} {shownErrors.length === 1 ? 'problem' : 'problems'} before saving:</strong>
            </p>
            <ul class="sbw-error">
              {shownErrors.map((e) => (
                <li key={e.path + e.message}>{e.message}</li>
              ))}
            </ul>
          </>
        )}
      </div>

      <Field id="rule-name" label="Rule name" error={errorAt('name')}>
        {(c) => (
          <input
            {...c}
            ref={nameRef}
            type="text"
            value={draft.name}
            onInput={(e) => {
              patch({ name: e.currentTarget.value });
            }}
          />
        )}
      </Field>

      <div class="sbw-row">
        <Field id="rule-action" label="When it matches" hint="If several rules match, Hide wins over Highlight, which wins over Watch.">
          {(c) => (
            <select
              {...c}
              value={draft.action}
              onChange={(e) => {
                patch({ action: e.currentTarget.value as RuleDraft['action'] });
              }}
            >
              <option value="highlight">Highlight the listing</option>
              <option value="hide">Hide the listing</option>
              <option value="watch">Watch the listing</option>
            </select>
          )}
        </Field>
        {draft.action === 'highlight' ? (
          <Field id="rule-tone" label="Highlight colour" hint="The colour is also named on the page.">
            {(c) => (
              <select
                {...c}
                value={draft.tone}
                onChange={(e) => {
                  patch({ tone: e.currentTarget.value as RuleDraft['tone'] });
                }}
              >
                <option value="green">Green</option>
                <option value="amber">Amber</option>
                <option value="blue">Blue</option>
              </select>
            )}
          </Field>
        ) : null}
      </div>

      <div class="sbw-checks">
        <label>
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => {
              patch({ enabled: e.currentTarget.checked });
            }}
          />{' '}
          Rule is on
        </label>
      </div>

      <div class="sbw-row sbw-add">
        <Field id="add-kind" label="Kind of condition to add" hint="Used by the Add buttons below.">
          {(c) => (
            <select
              {...c}
              value={addKind}
              onChange={(e) => {
                setAddKind(e.currentTarget.value as ConditionKind);
              }}
            >
              {CONDITION_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      {conditionGroup('all', 'All of these must be true', 'Every condition here has to match.')}
      {conditionGroup('any', 'And at least one of these (optional)', 'If you add alternatives, at least one has to match as well.')}
      {errorAt('conditions') === undefined ? null : (
        <p class="sbw-error">
          <strong>Error:</strong> {errorAt('conditions')}
        </p>
      )}

      <div class="sbw-summary">
        <h4>In plain English</h4>
        <p>{result.ok ? summarizeRule(result.rule) : 'Finish the highlighted fields to see a summary.'}</p>
        <h4>Preview</h4>
        <Status message={previewText} tone={preview.state === 'failed' ? 'error' : 'ok'} />
      </div>

      <div class="sbw-actions">
        <button type="submit" disabled={saving}>
          {saving ? 'Saving...' : 'Save rule'}
        </button>
        <button type="button" class="sbw-secondary" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
