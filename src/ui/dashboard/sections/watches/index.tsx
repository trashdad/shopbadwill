import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { JobRun, Watch } from '../../../../domain/watches/schema';
import { PORT_NAMES } from '../../../../messaging/protocol';
import { describeError } from '../../../components/describeError';
import { PacificTime } from '../../../time';
import { ErrorAlert, LoadNotice, useLoad } from '../../parts';
import { isPolicySkip, policySkipReason } from '../../policy';
import type { SectionDef, SectionProps } from '../../registry';

export const NO_RULES_WARNING = 'This watch has no rules, so it will never match. Add a rule in Options → Watches.';

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

function RunSummary(props: { run: JobRun; tz: string }): VNode {
  const { run } = props;
  const real = run.results.errors.filter((e) => !isPolicySkip(e.message));
  const skipped = run.results.errors.filter((e) => isPolicySkip(e.message));
  return (
    <div class="sbw-run">
      <p>
        Last run ({run.trigger}) started <PacificTime ms={run.startedAt} userTz={props.tz} />:{' '}
        {plural(run.results.newMatches.length, 'new match', 'new matches')}
        {', '}
        {plural(real.length, 'error', 'errors')}.
      </p>
      {skipped.length > 0 ? (
        <ul class="sbw-muted">
          {skipped.map((e, i) => (
            <li key={i}>Favorite skipped (policy): {policySkipReason(e.message)}</li>
          ))}
        </ul>
      ) : null}
      {real.length > 0 ? (
        <div role="alert" class="sbw-error">
          <ul>
            {real.map((e, i) => (
              <li key={i}>{e.message}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function Progress(props: { run: JobRun }): VNode {
  const total = props.run.steps.length;
  const done = Math.min(props.run.cursor, total);
  return (
    <div>
      <div role="progressbar" aria-label="Run progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={done}>
        <div class="sbw-bar" style={{ width: `${String(total === 0 ? 0 : Math.round((done / total) * 100))}%` }} />
      </div>
      <p class="sbw-muted">
        Running: step {done} of {total}.
      </p>
    </div>
  );
}

function WatchRow(props: {
  watch: Watch;
  enabledRuleIds: ReadonlySet<string> | null;
  run: JobRun | null;
  tz: string;
  busy: boolean;
  runNow: (w: Watch) => void;
}): VNode {
  const w = props.watch;
  const hasRules =
    props.enabledRuleIds === null ? w.ruleIds.length > 0 : w.ruleIds.some((id) => props.enabledRuleIds?.has(id) === true);
  const fresh = props.run?.candidates?.filter((c) => c.status === 'matched' && c.watchIds.includes(w.id)).length;
  const lastError = w.lastError;
  return (
    <li class="sbw-watch" data-enabled={String(w.enabled)}>
      <div class="sbw-row">
        <h3>{w.name === '' ? 'Untitled watch' : w.name}</h3>
        {w.enabled ? null : <span class="sbw-tag">paused</span>}
      </div>
      {hasRules ? null : <p class="sbw-warn">{NO_RULES_WARNING}</p>}
      <p>
        Last run: {w.lastRunAt === undefined ? 'never' : <PacificTime ms={w.lastRunAt} userTz={props.tz} />}
        <br />
        Next run: <PacificTime ms={w.nextRunAt} userTz={props.tz} />
        {fresh === undefined ? null : (
          <>
            <br />
            New matches in the last run: {fresh}
          </>
        )}
      </p>
      {lastError === undefined ? null : isPolicySkip(lastError) ? (
        <p class="sbw-muted">Favorite skipped (policy): {policySkipReason(lastError)}</p>
      ) : (
        <p role="alert" class="sbw-error">
          <strong>Problem: </strong>
          {lastError}
        </p>
      )}
      <button
        type="button"
        class="sbw-secondary"
        aria-label={`Run ${w.name === '' ? 'this watch' : w.name} now`}
        disabled={props.busy}
        onClick={() => {
          props.runNow(w);
        }}
      >
        Run now
      </button>
    </li>
  );
}

export function WatchesSection(props: SectionProps): VNode {
  const { client } = props;
  const [watches, reloadWatches] = useLoad(() => client.send('watches.list', undefined), [client]);
  const [rules] = useLoad(() => client.send('rules.list', undefined), [client]);
  const [initial] = useLoad(() => client.send('job.status', undefined), [client]);
  const [live, setLive] = useState<JobRun | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(
    () =>
      client.connect(PORT_NAMES.jobProgress, (tick) => {
        setLive(tick);
        if (tick.status !== 'running') reloadWatches();
      }),
    [client],
  );

  const run: JobRun | null = live ?? (initial.kind === 'ok' ? initial.value : null);
  const running = run?.status === 'running';

  const runNow = (watch?: Watch): void => {
    if (sending || running) return;
    setSending(true);
    setError('');
    client.send('job.runNow', watch === undefined ? {} : { watchIds: [watch.id] }).then(
      () => {
        setSending(false);
      },
      (e: unknown) => {
        setSending(false);
        setError(`Could not start a run. ${describeError(e)}`);
      },
    );
  };

  const enabledRuleIds = rules.kind === 'ok' ? new Set(rules.value.filter((r) => r.enabled).map((r) => r.id)) : null;

  return (
    <div>
      <p>
        <button type="button" disabled={sending || running} onClick={() => { runNow(); }}>
          Run now
        </button>
      </p>
      <ErrorAlert message={error} />
      {run !== null && running ? <Progress run={run} /> : null}
      {run !== null && !running ? <RunSummary run={run} tz={props.userTz} /> : null}
      <LoadNotice state={watches} what="watches" />
      {watches.kind === 'ok' ? (
        watches.value.length === 0 ? (
          <p class="sbw-muted">No watches yet. Add one in Options → Watches.</p>
        ) : (
          <ul class="sbw-list">
            {watches.value.map((w) => (
              <WatchRow
                key={w.id}
                watch={w}
                enabledRuleIds={enabledRuleIds}
                run={run}
                tz={props.userTz}
                busy={sending || running}
                runNow={runNow}
              />
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}

export const section: SectionDef = { id: 'watches', title: 'Watches', order: 10, Component: WatchesSection };
