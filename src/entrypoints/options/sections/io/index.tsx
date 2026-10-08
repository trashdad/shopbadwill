import type { VNode } from 'preact';
import { useRef, useState } from 'preact/hooks';

import { exportRules, importRules, RULE_TEMPLATES, ruleFromTemplate, type RuleTemplate } from '../../../../domain/rules/io';
import type { Rule } from '../../../../domain/rules/schema';
import { describeError } from '../../../../ui/components/describeError';
import { Card, Field } from '../../../../ui/components/Field';
import { Status } from '../../../../ui/components/Status';
import type { SectionDef, SectionProps } from '../../registry';
import { summarizeRule } from '../rules/summary';

export interface IoSectionProps extends SectionProps {
  /** Injectable for tests. */
  now?: () => number;
  newId?: () => string;
}

interface Preview {
  rules: Rule[];
  duplicates: string[];
}

type StatusState = { message: string; tone: 'ok' | 'error' };

export function IoSection(props: IoSectionProps): VNode {
  const { client } = props;
  const now = props.now ?? Date.now;
  const newId = props.newId ?? (() => crypto.randomUUID());

  const [status, setStatus] = useState<StatusState>({ message: '', tone: 'ok' });
  const [exported, setExported] = useState('');
  const exportRef = useRef<HTMLTextAreaElement>(null);

  const [pasted, setPasted] = useState('');
  const [errors, setErrors] = useState<string[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  const doExport = (): void => {
    client.send('rules.list', undefined).then(
      (rules) => {
        setExported(exportRules(rules, now()));
        setStatus({
          message: `Exported ${String(rules.length)} ${rules.length === 1 ? 'rule' : 'rules'}. Copy the text below and keep it somewhere safe.`,
          tone: 'ok',
        });
      },
      (e: unknown) => {
        setStatus({ message: `Could not read your rules. ${describeError(e)}`, tone: 'error' });
      },
    );
  };

  const copy = (): void => {
    const el = exportRef.current;
    el?.focus();
    el?.select();
    const clip = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
    if (clip === undefined) {
      setStatus({ message: 'The text is selected. Press Ctrl+C (Command+C on a Mac) to copy it.', tone: 'ok' });
      return;
    }
    clip.writeText(exported).then(
      () => {
        setStatus({ message: 'Copied to the clipboard.', tone: 'ok' });
      },
      () => {
        setStatus({ message: 'Could not copy automatically. The text is selected: press Ctrl+C (Command+C on a Mac).', tone: 'error' });
      },
    );
  };

  const runPreview = (text: string): void => {
    setPreview(null);
    setErrors([]);
    client.send('rules.list', undefined).then(
      (existing) => {
        const r = importRules(text, existing, { now: now(), newId });
        if (r.ok) {
          setPreview({ rules: r.rules, duplicates: r.duplicates });
          setStatus({ message: `Ready to add ${String(r.rules.length)} ${r.rules.length === 1 ? 'rule' : 'rules'}. Nothing is saved until you confirm.`, tone: 'ok' });
        } else {
          setErrors(r.errors);
          setStatus({ message: 'That text could not be imported. Nothing was changed.', tone: 'error' });
        }
      },
      (e: unknown) => {
        setStatus({ message: `Could not check your existing rules. ${describeError(e)}`, tone: 'error' });
      },
    );
  };

  const onFile = (e: Event): void => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (file === undefined) return;
    file.text().then(
      (text) => {
        setPasted(text);
        runPreview(text);
      },
      () => {
        setStatus({ message: 'Could not read that file.', tone: 'error' });
      },
    );
  };

  const confirmImport = async (): Promise<void> => {
    if (preview === null) return;
    setBusy(true);
    let saved = 0;
    try {
      for (const rule of preview.rules) {
        await client.send('rules.save', rule);
        saved += 1;
      }
      setStatus({ message: `Added ${String(saved)} ${saved === 1 ? 'rule' : 'rules'}. You can find them under Rules.`, tone: 'ok' });
      setPreview(null);
      setPasted('');
    } catch (e) {
      const left = preview.rules.length - saved;
      setPreview({ ...preview, rules: preview.rules.slice(saved) });
      setStatus({
        message: `Added ${String(saved)}, but could not add the other ${String(left)}. ${describeError(e)}`,
        tone: 'error',
      });
    } finally {
      setBusy(false);
    }
  };

  const addTemplate = (t: RuleTemplate): void => {
    client.send('rules.save', ruleFromTemplate(t, { now: now(), newId })).then(
      () => {
        setStatus({ message: `Added "${t.name}". You can find it under Rules.`, tone: 'ok' });
      },
      (e: unknown) => {
        setStatus({ message: `Could not add "${t.name}". ${describeError(e)}`, tone: 'error' });
      },
    );
  };

  return (
    <div class="sbw-io">
      <p class="sbw-lede">
        Back up your rules, move them to another browser, or start from a ready-made rule. Rules stay on this device.
      </p>
      <Status message={status.message} tone={status.tone} />

      <Card>
        <h3>Export your rules</h3>
        <button type="button" onClick={doExport}>
          Export rules
        </button>
        {exported === '' ? null : (
          <div>
            <Field id="io-export" label="Exported rules" hint="Copy this text and save it in a file or note.">
              {(c) => <textarea {...c} ref={exportRef} readOnly rows={10} value={exported} onFocus={(e) => { e.currentTarget.select(); }} />}
            </Field>
            <button type="button" class="sbw-secondary" onClick={copy}>
              Copy
            </button>
          </div>
        )}
      </Card>

      <Card>
        <h3>Import rules</h3>
        <Field
          id="io-import"
          label="Paste exported rules"
          hint="Paste text from a ShopBadwill export. You will see what would be added before anything is saved."
        >
          {(c) => (
            <textarea
              {...c}
              rows={6}
              value={pasted}
              onInput={(e) => {
                setPasted(e.currentTarget.value);
                setPreview(null);
                setErrors([]);
              }}
            />
          )}
        </Field>
        <div class="sbw-actions">
          <button
            type="button"
            onClick={() => {
              runPreview(pasted);
            }}
          >
            Preview import
          </button>
        </div>
        <Field id="io-file" label="Or choose an exported file" hint="A .json file saved from an export.">
          {(c) => <input {...c} type="file" accept=".json,application/json,text/plain" onChange={onFile} />}
        </Field>

        {errors.length === 0 ? null : (
          <ul class="sbw-error" aria-label="Problems with the import">
            {errors.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}

        {preview === null ? null : (
          <section aria-labelledby="io-preview-h">
            <h4 id="io-preview-h">Will be added ({preview.rules.length})</h4>
            {preview.duplicates.length === 0 ? null : (
              <p class="sbw-warn">
                <strong>Note:</strong> you already have, or are importing twice, a rule named {preview.duplicates.map((d) => `"${d}"`).join(', ')}. Adding it
                again makes a second copy.
              </p>
            )}
            <ul class="sbw-rule-list" aria-label="Rules to add">
              {preview.rules.map((r) => (
                <li key={r.id} class="sbw-rule">
                  <div class="sbw-rule-head">
                    <h5>{r.name === '' ? 'Untitled rule' : r.name}</h5>
                    <span class="sbw-tag">{r.action}</span>
                    <span class="sbw-tag">{r.enabled ? 'On' : 'Off'}</span>
                  </div>
                  <p>{summarizeRule(r)}</p>
                </li>
              ))}
            </ul>
            <div class="sbw-actions">
              <button type="button" disabled={busy || preview.rules.length === 0} onClick={() => void confirmImport()}>
                {`Add ${String(preview.rules.length)} ${preview.rules.length === 1 ? 'rule' : 'rules'}`}
              </button>
              <button
                type="button"
                class="sbw-secondary"
                disabled={busy}
                onClick={() => {
                  setPreview(null);
                  setStatus({ message: 'Import cancelled. Nothing was changed.', tone: 'ok' });
                }}
              >
                Cancel
              </button>
            </div>
          </section>
        )}
      </Card>

      <Card>
        <h3>Ready-made rules</h3>
        <ul class="sbw-rule-list" aria-label="Rule templates">
          {RULE_TEMPLATES.map((t) => (
            <li key={t.id} class="sbw-rule">
              <div class="sbw-rule-head">
                <h4>{t.name}</h4>
              </div>
              <p>{t.description}</p>
              {t.note === undefined ? null : (
                <p class="sbw-hint">
                  <strong>Note:</strong> {t.note}
                </p>
              )}
              <div class="sbw-actions">
                <button
                  type="button"
                  aria-label={`Add "${t.name}"`}
                  onClick={() => {
                    addTemplate(t);
                  }}
                >
                  Add
                </button>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

export const section: SectionDef = { id: 'io', title: 'Import, export and templates', order: 30, Component: IoSection };
