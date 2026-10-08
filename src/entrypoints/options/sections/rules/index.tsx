import type { VNode } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';

import type { Rule } from '../../../../domain/rules/schema';
import { Status } from '../../../../ui/components/Status';
import type { SectionDef, SectionProps } from '../../registry';
import { RuleEditor } from './RuleEditor';
import { summarizeRule } from './summary';

export interface RulesSectionProps extends SectionProps {
  /** Injectable for tests. */
  now?: () => number;
  newId?: () => string;
  previewDelayMs?: number;
}

type Editing = { rule: Rule | undefined } | null;

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function RulesSection(props: RulesSectionProps): VNode {
  const { client } = props;
  const now = props.now ?? Date.now;
  const newId = props.newId ?? (() => crypto.randomUUID());
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [editing, setEditing] = useState<Editing>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [status, setStatus] = useState<{ message: string; tone: 'ok' | 'error' }>({ message: '', tone: 'ok' });

  const reload = useCallback(() => {
    client.send('rules.list', undefined).then(
      (list) => {
        setRules(list);
      },
      (e: unknown) => {
        setRules((r) => r ?? []);
        setStatus({ message: `Could not load your rules. ${messageOf(e)}`, tone: 'error' });
      },
    );
  }, [client]);

  useEffect(() => {
    reload();
    return client.onBroadcast('rules.changed', reload);
  }, [client, reload]);

  const closeEditor = (): void => {
    setEditing(null);
    // Return focus to where the user started.
    queueMicrotask(() => document.getElementById('new-rule-button')?.focus());
  };

  const toggle = (rule: Rule, enabled: boolean): void => {
    const updated: Rule = { ...rule, enabled, updatedAt: now() };
    client.send('rules.save', updated).then(
      () => {
        setRules((list) => (list ?? []).map((r) => (r.id === rule.id ? updated : r)));
        setStatus({ message: `${rule.name} is now ${enabled ? 'on' : 'off'}.`, tone: 'ok' });
      },
      (e: unknown) => {
        setStatus({ message: `Could not change "${rule.name}". ${messageOf(e)}`, tone: 'error' });
      },
    );
  };

  const remove = (rule: Rule): void => {
    setConfirmDelete(null);
    client.send('rules.delete', { id: rule.id }).then(
      () => {
        setRules((list) => (list ?? []).filter((r) => r.id !== rule.id));
        setStatus({ message: `Deleted "${rule.name}".`, tone: 'ok' });
      },
      (e: unknown) => {
        setStatus({ message: `Could not delete "${rule.name}". ${messageOf(e)}`, tone: 'error' });
      },
    );
  };

  return (
    <div class="sbw-rules">
      <p class="sbw-lede">
        Rules highlight, hide or watch listings on ShopGoodwill. If two rules disagree, Hide beats Highlight, and Highlight beats Watch.
      </p>
      <Status message={status.message} tone={status.tone} />

      {editing === null ? (
        <button
          id="new-rule-button"
          type="button"
          onClick={() => {
            setEditing({ rule: undefined });
          }}
        >
          New rule
        </button>
      ) : (
        <RuleEditor
          key={editing.rule?.id ?? 'new'}
          client={client}
          rule={editing.rule}
          now={now}
          newId={newId}
          previewDelayMs={props.previewDelayMs ?? 300}
          onCancel={closeEditor}
          onSaved={(saved) => {
            setRules((list) => {
              const rest = (list ?? []).filter((r) => r.id !== saved.id);
              return [...rest, saved].sort((a, b) => a.createdAt - b.createdAt);
            });
            setStatus({ message: `Saved "${saved.name}".`, tone: 'ok' });
            closeEditor();
          }}
        />
      )}

      {rules === null ? (
        <p>Loading your rules...</p>
      ) : rules.length === 0 ? (
        <p class="sbw-empty">You have no rules yet. Choose New rule to make your first one.</p>
      ) : (
        <ul class="sbw-rule-list" aria-label="Your rules">
          {rules.map((rule) => (
            <li key={rule.id} class="sbw-rule" data-enabled={String(rule.enabled)}>
              <div class="sbw-rule-head">
                <h3>{rule.name === '' ? 'Untitled rule' : rule.name}</h3>
                <span class="sbw-tag">{rule.action}</span>
                <span class="sbw-tag">{rule.enabled ? 'On' : 'Off'}</span>
              </div>
              <p>{summarizeRule(rule)}</p>
              <div class="sbw-actions">
                <label>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={rule.enabled}
                    aria-label={`Rule "${rule.name}" is on`}
                    onChange={(e) => {
                      toggle(rule, e.currentTarget.checked);
                    }}
                  />{' '}
                  On
                </label>
                <button
                  type="button"
                  class="sbw-secondary"
                  aria-label={`Edit ${rule.name}`}
                  onClick={() => {
                    setEditing({ rule });
                  }}
                >
                  Edit
                </button>
                {confirmDelete === rule.id ? (
                  <>
                    <button
                      type="button"
                      class="sbw-danger"
                      aria-label={`Confirm delete ${rule.name}`}
                      onClick={() => {
                        remove(rule);
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
                    aria-label={`Delete ${rule.name}`}
                    onClick={() => {
                      setConfirmDelete(rule.id);
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

export const section: SectionDef = { id: 'rules', title: 'Rules', order: 10, Component: RulesSection };
