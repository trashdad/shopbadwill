// T-90: the dashboard "Timing" section (R4, I-06). Text-only: no canvas, no
// innerHTML; everything is Preact text nodes, a real table, and CSS-width bars.
//
// Data (the protocol is frozen, so the section reuses existing messages):
//   snipe.list  -> the per-snipe measurements the runner persisted
//                  (offset, RTT, fire error; alarm delay is never persisted, R3);
//   settings.get/set -> the soak counters and the default lead. "Apply" writes
//                  defaultLeadMs only from the button's click (R2, R5).
//   The awake-history chart has no data path yet: no message carries
//   `sbw:awake`, so the chart says "not recorded" (see awake.ts; reported gap).
import type { VNode } from 'preact';
import { useState } from 'preact/hooks';

import { describeError } from '../../../components/describeError';
import type { Settings } from '../../../../domain/settings/schema';
import { soakSummary, timingMeasurements } from '../../../../domain/snipe/soak';
import type { Snipe } from '../../../../domain/snipe/types';
import { LoadNotice, useLoad } from '../../parts';
import type { SectionDef, SectionProps } from '../../registry';
import { AWAKE_DAYS_SHOWN } from './awake';
import { buildTimingExport, downloadTimingExport } from './export';
import { formatLead, formatMs, NOT_RECORDED, snipeLabel } from './format';

const pct = (rate: number): string => `${String(Math.round(rate * 1000) / 10)}%`;

function Latency(props: { p50: number | null; p95: number | null; p99: number | null }): VNode {
  if (props.p50 === null) return <p>No latency samples yet: a completed dry run measures one at fire time.</p>;
  return (
    <p>
      Latency (measure read): p50 {formatMs(props.p50)}, p95 {formatMs(props.p95)}, p99 {formatMs(props.p99)}.
    </p>
  );
}

function ApplyButton(props: {
  recommendation: number | null;
  settings: Settings | null;
  onApply: () => void;
  busy: boolean;
}): VNode {
  const current = props.settings?.snipe.defaultLeadMs ?? null;
  const disabled = props.recommendation === null || current === null || props.recommendation === current || props.busy;
  const label =
    props.recommendation === null
      ? 'Apply'
      : current !== null && props.recommendation === current
        ? 'Apply'
        : `Apply ${formatLead(props.recommendation)} lead`;
  return (
    <button type="button" class="sbw-secondary" disabled={disabled} onClick={props.onApply}>
      {label}
    </button>
  );
}

function Rows(props: { snipes: readonly Snipe[] }): VNode {
  const rows = [...props.snipes]
    .filter((s) => s.state !== 'draft')
    .sort((a, b) => b.armedAt - a.armedAt)
    .map((s) => ({ snipe: s, m: timingMeasurements(s) }));
  if (rows.length === 0) return <p class="sbw-muted">No snipes have run yet.</p>;
  return (
    <table>
      <thead>
        <tr>
          <th scope="col">Snipe</th>
          <th scope="col">Kind</th>
          <th scope="col">Offset</th>
          <th scope="col">RTT</th>
          <th scope="col">Fire error</th>
          <th scope="col">Alarm delay</th>
          <th scope="col">Latency</th>
          <th scope="col">On time</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(({ snipe, m }) => (
          <tr key={snipe.id}>
            <th scope="row">{snipeLabel(snipe)}</th>
            <td>{snipe.dryRun ? 'dry run' : 'live'}</td>
            <td>{formatMs(m.offsetMs)}</td>
            <td>{formatMs(m.rttMs)}</td>
            <td>{formatMs(m.fireErrorMs)}</td>
            <td>{formatMs(m.alarmDelayMs)}</td>
            <td>{formatMs(m.latencyMs)}</td>
            <td>{m.onTime === null ? '—' : m.onTime ? 'on time' : 'late'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TimingSection(props: SectionProps): VNode {
  const { client } = props;
  const [snipes, reloadSnipes] = useLoad(() => client.send('snipe.list', undefined), [client]);
  const [settings, reloadSettings] = useLoad(() => client.send('settings.get', undefined), [client]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const summary = snipes.kind === 'ok' ? soakSummary(snipes.value) : null;
  const recommendation = summary?.recommendedLeadMs ?? null;
  const currentLead = settings.kind === 'ok' ? settings.value.snipe.defaultLeadMs : null;

  const apply = (): void => {
    if (recommendation === null || settings.kind !== 'ok' || busy) return;
    setBusy(true);
    setNote(null);
    void client
      .send('settings.set', { snipe: { ...settings.value.snipe, defaultLeadMs: recommendation } })
      .then(() => {
        setNote(`Applied: the default lead is now ${formatLead(recommendation)}.`);
        setBusy(false);
        reloadSettings();
      })
      .catch((e: unknown) => {
        setNote(describeError(e));
        setBusy(false);
      });
  };

  const exportJson = (): void => {
    if (snipes.kind !== 'ok' || settings.kind !== 'ok') return;
    downloadTimingExport(buildTimingExport(snipes.value, settings.value));
    setNote('Exported.');
  };

  return (
    <div>
      <LoadNotice state={snipes} what="snipe timing" />
      <LoadNotice state={settings} what="settings" />
      <h3>Soak summary (dry runs)</h3>
      {snipes.kind === 'ok' && summary !== null ? (
        <>
          {settings.kind === 'ok' ? (
            <p>
              Completed dry runs: {settings.value.snipe.completedDryRuns} of {settings.value.snipe.requiredDryRuns} required
              for live bidding.
            </p>
          ) : null}
          <p>
            Fires attempted: {summary.firesAttempted}; on time: {summary.onTime} ({summary.firesAttempted === 0 ? '—' : pct(summary.onTimeRate)}).
          </p>
          <Latency p50={summary.p50Ms} p95={summary.p95Ms} p99={summary.p99Ms} />
        </>
      ) : null}
      <h3>Recommended lead</h3>
      {settings.kind === 'ok' ? (
        <p>
          Current default lead: {formatLead(currentLead ?? 0)}.
          {recommendation === null
            ? ' Not enough soak data for a recommendation: complete a dry run with a measure read first.'
            : currentLead !== null && recommendation === currentLead
              ? ' The soak recommendation matches the current default.'
              : ` The soak recommends ${formatLead(recommendation)} (p99 one-way latency + 5 s, clamped to 6–15 s).`}
        </p>
      ) : null}
      <p>
        <ApplyButton recommendation={recommendation} settings={settings.kind === 'ok' ? settings.value : null} onApply={apply} busy={busy} />
      </p>
      {note === null ? null : (
        <p role="status">
          <span class="sbw-muted">{note}</span>
        </p>
      )}
      <h3>Per-snipe timing</h3>
      {snipes.kind === 'ok' ? <Rows snipes={snipes.value} /> : null}
      <h3>Awake history</h3>
      <p class="sbw-muted">
        Awake history is {NOT_RECORDED} on this page for now: the background records it (the `sbw:awake` heartbeat history,
        one row per local hour over the last {AWAKE_DAYS_SHOWN} days) but no message exposes it to the dashboard, so the
        chart has no data to draw. Reported as a gap.
      </p>
      <h3>Export</h3>
      <p>
        <button type="button" class="sbw-secondary" disabled={snipes.kind !== 'ok' || settings.kind !== 'ok'} onClick={exportJson}>
          Export JSON
        </button>{' '}
        <span class="sbw-muted">Timing data and snipe ids only — never bid amounts. Downloads a file; no network.</span>
      </p>
      <p>
        <button type="button" class="sbw-secondary" onClick={reloadSnipes}>
          Refresh
        </button>
      </p>
    </div>
  );
}

export const section: SectionDef = { id: 'timing', title: 'Timing', order: 55, Component: TimingSection };
