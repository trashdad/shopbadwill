// T-112: the dashboard's Bid groups section (I-06 registry), text only.
// Each group shows its items, N ("win at most"), the confirmed wins so far and
// the next end, and says plainly when the group risks winning more than N: a
// win it could not confirm, or a snipe whose bid was already sent when the
// group tried to stop it. Edits (N, name, delete, new items) are refused from
// 2 minutes before the next end; the background enforces it, this only says so.
// Every rule comes from src/domain/snipe/groups.ts (groupView), the same one
// the background applies.
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { groupView, membersOf, type GroupView } from '../../../../domain/snipe/groups';
import type { Snipe } from '../../../../domain/snipe/types';
import type { Settings } from '../../../../domain/settings/schema';
import { SNIPE_GROUP_LIMITS, type SnipeGroup } from '../../../../domain/storage/schema';
import type { MessagingClient } from '../../../../ports/messaging';
import { describeError } from '../../../components/describeError';
import { Field } from '../../../components/Field';
import { Status } from '../../../components/Status';
import { ErrorAlert, LoadNotice, useLoad } from '../../parts';
import type { SectionDef, SectionProps } from '../../registry';
import { DRY_RUN_LABEL } from '../snipes/arm-form';
import { formatEndDual } from '../snipes/end-time';
import { GroupArmForm } from './arm';

/** How often the section re-reads the groups and snipes while open. */
export const GROUPS_REFRESH_MS = 15_000;

export const GROUPS_INTRO =
  'A bid group wins at most N of its items. It stops its other snipes only once a win is confirmed: a read after the auction ends shows you as the high bidder. Until then it keeps bidding, which can win more than N. Items in a group must end at least 2 minutes apart. Each snipe still counts in full against your caps: a group never raises a cap.';

function newGroupId(): string {
  return `grp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function parseN(text: string): number | null {
  const n = Number(text);
  return Number.isInteger(n) && n >= 1 && n <= SNIPE_GROUP_LIMITS.maxWinsMax ? n : null;
}

const N_HINT = `A whole number from 1 to ${String(SNIPE_GROUP_LIMITS.maxWinsMax)}.`;

function CreateGroup(props: { client: MessagingClient; onCreated: () => void }): VNode {
  const [name, setName] = useState('');
  const [n, setN] = useState('1');
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);

  const create = (): void => {
    const trimmed = name.trim();
    const maxWins = parseN(n);
    if (trimmed === '') {
      setError('Give the group a name.');
      return;
    }
    if (maxWins === null) {
      setError(`"Win at most" must be ${N_HINT.toLowerCase()}`);
      return;
    }
    setError('');
    setBusy(true);
    props.client.send('groups.save', { id: newGroupId(), name: trimmed.slice(0, SNIPE_GROUP_LIMITS.nameMax), maxWins }).then(
      () => {
        setBusy(false);
        setName('');
        setN('1');
        setStatus(`Group "${trimmed}" created: it wins at most ${String(maxWins)}.`);
        props.onCreated();
      },
      (e: unknown) => {
        setBusy(false);
        setError(`Could not create the group. ${describeError(e)}`);
      },
    );
  };

  return (
    <form
      class="sbw-card"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        create();
      }}
    >
      <h3>New group</h3>
      <Field id="group-new-name" label="Group name">
        {(c) => (
          <input
            {...c}
            type="text"
            maxLength={SNIPE_GROUP_LIMITS.nameMax}
            value={name}
            onInput={(e) => {
              setName((e.target as HTMLInputElement).value);
            }}
          />
        )}
      </Field>
      <Field id="group-new-n" label="Win at most" hint={N_HINT}>
        {(c) => (
          <input
            {...c}
            type="number"
            min={1}
            max={SNIPE_GROUP_LIMITS.maxWinsMax}
            value={n}
            onInput={(e) => {
              setN((e.target as HTMLInputElement).value);
            }}
          />
        )}
      </Field>
      <p>
        <button type="submit" disabled={busy}>
          Create group
        </button>
      </p>
      <ErrorAlert message={error} />
      <Status message={status} />
    </form>
  );
}

function GroupCard(props: {
  client: MessagingClient;
  group: SnipeGroup;
  view: GroupView;
  userTz: string;
  settings: Settings | null;
  snipes: readonly Snipe[];
  onChanged: () => void;
}): VNode {
  const { view: v, group: g } = props;
  const idp = `grp-${g.id}`;
  const [n, setN] = useState(String(g.maxWins));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    setN(String(g.maxWins));
  }, [g.maxWins]);

  const save = (): void => {
    const maxWins = parseN(n);
    if (maxWins === null) {
      setError(`"Win at most" must be ${N_HINT.toLowerCase()}`);
      return;
    }
    setError('');
    setBusy(true);
    props.client.send('groups.save', { id: g.id, name: g.name, maxWins }).then(
      () => {
        setBusy(false);
        props.onChanged();
      },
      (e: unknown) => {
        setBusy(false);
        setError(describeError(e));
      },
    );
  };

  const remove = (): void => {
    setError('');
    setBusy(true);
    props.client.send('groups.delete', { id: g.id }).then(
      () => {
        setBusy(false);
        props.onChanged();
      },
      (e: unknown) => {
        setBusy(false);
        setError(describeError(e));
      },
    );
  };

  const winsText = `Wins so far: ${String(v.wins)} of at most ${String(v.maxWins)}${v.mode === 'dry-run' ? ' (dry run: would have won)' : ''}.`;
  const nextN = parseN(n);
  return (
    <li class="sbw-watch" data-group-id={g.id}>
      <h3>{g.name}</h3>
      <p>
        Win at most {String(v.maxWins)}. {winsText}
        {v.mode === 'dry-run' ? <span class="sbw-tag">{DRY_RUN_LABEL}</span> : null}
      </p>
      <p>
        {v.nextEnd === null
          ? v.full
            ? 'Done: the group won what it may win.'
            : 'No open items.'
          : `Next end: ${formatEndDual(v.nextEnd.endMs, props.userTz)}, "${v.nextEnd.title}".`}
      </p>
      {v.frozen === null ? null : (
        <p class="sbw-warn">
          Frozen until "{v.frozen.title}" (ends {formatEndDual(v.frozen.endMs, props.userTz)}) is settled: a group cannot change from 2 minutes
          before its next end.
        </p>
      )}
      {v.warnings.length === 0 ? null : (
        <div class="sbw-warn" role="note" aria-label={`Risks in ${g.name}`}>
          <strong>Could win more than {String(v.maxWins)}:</strong>
          <ul>
            {v.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      )}
      {v.items.length === 0 ? (
        <p class="sbw-muted">No items yet. Add one below.</p>
      ) : (
        <ul class="sbw-list" aria-label={`Items in ${g.name}`}>
          {v.items.map((i) => (
            <li key={i.snipeId} data-snipe-id={i.snipeId}>
              {i.title}: {i.status}. Ends {formatEndDual(i.endMs, props.userTz)}.
            </li>
          ))}
        </ul>
      )}
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Field id={`${idp}-n`} label="Win at most" hint={N_HINT}>
          {(c) => (
            <input
              {...c}
              type="number"
              min={1}
              max={SNIPE_GROUP_LIMITS.maxWinsMax}
              value={n}
              disabled={v.frozen !== null}
              onInput={(e) => {
                setN((e.target as HTMLInputElement).value);
              }}
            />
          )}
        </Field>
        {nextN !== null && nextN !== g.maxWins && nextN <= v.wins && v.nextEnd !== null ? (
          <p class="sbw-warn">Saving {String(nextN)} with {String(v.wins)} confirmed stops the group's other snipes.</p>
        ) : null}
        <p>
          <button type="submit" disabled={busy || v.frozen !== null}>
            Save
          </button>{' '}
          <button type="button" class="sbw-secondary" disabled={busy || !v.canDelete} onClick={remove}>
            Delete group
          </button>{' '}
          <button
            type="button"
            class="sbw-secondary"
            aria-expanded={adding}
            disabled={v.frozen !== null || v.full}
            onClick={() => {
              setAdding((a) => !a);
            }}
          >
            {adding ? 'Close the form' : 'Add an item'}
          </button>
        </p>
      </form>
      <ErrorAlert message={error} />
      {adding && v.frozen === null && !v.full ? (
        <GroupArmForm
          client={props.client}
          groupId={g.id}
          groupName={g.name}
          userTz={props.userTz}
          settings={props.settings}
          snipes={props.snipes}
          onArmed={props.onChanged}
        />
      ) : null}
    </li>
  );
}

export function GroupsSection(props: SectionProps): VNode {
  const { client } = props;
  const [groups, reloadGroups] = useLoad(() => client.send('groups.list', undefined), [client]);
  const [snipes, reloadSnipes] = useLoad(() => client.send('snipe.list', undefined), [client]);
  const [settings] = useLoad(() => client.send('settings.get', undefined), [client]);
  const [now, setNow] = useState(() => Date.now());

  const reload = (): void => {
    reloadGroups();
    reloadSnipes();
    setNow(Date.now());
  };

  useEffect(() => {
    const t = setInterval(reload, GROUPS_REFRESH_MS);
    return () => {
      clearInterval(t);
    };
  }, [client]);

  const all = snipes.kind === 'ok' ? snipes.value : [];
  const list = groups.kind === 'ok' ? Object.values(groups.value.groups).sort((a, b) => a.createdAt - b.createdAt) : [];
  return (
    <div>
      <p class="sbw-muted">{GROUPS_INTRO}</p>
      <LoadNotice state={groups} what="bid groups" />
      <LoadNotice state={snipes} what="snipes" />
      {groups.kind === 'ok' ? <CreateGroup client={client} onCreated={reload} /> : null}
      {groups.kind === 'ok' && list.length === 0 ? <p class="sbw-muted">No bid groups yet.</p> : null}
      {list.length > 0 && snipes.kind === 'ok' ? (
        <ul class="sbw-list" aria-label="Bid groups">
          {list.map((g) => (
            <GroupCard
              key={g.id}
              client={client}
              group={g}
              view={groupView(g, membersOf(g.id, all), now, props.userTz)}
              userTz={props.userTz}
              settings={settings.kind === 'ok' ? settings.value : null}
              snipes={all}
              onChanged={reload}
            />
          ))}
        </ul>
      ) : null}
      <p>
        <button type="button" class="sbw-secondary" onClick={reload}>
          Refresh
        </button>
      </p>
    </div>
  );
}

export const section: SectionDef = { id: 'groups', title: 'Bid groups', order: 36, Component: GroupsSection };
