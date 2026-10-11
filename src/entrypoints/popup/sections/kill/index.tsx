// T-86 (R5): the popup kill section, registered through the popup's section
// registry (I-06: one folder under sections/, nothing else changes). It has:
//   - a Kill / Resume toggle that sends `kill.set` (a ui sender): turning kill
//     ON is one click, turning it OFF needs a confirm step;
//   - the last auto-kill reasons, from the audit log, rendered as text only.
//
// The kill state comes from `switches.changed` broadcasts and the initial
// `settings.get`; a broadcast wins over a read it is newer than. While the
// state is unknown, only Stop is offered (fail closed, as in the shell).
import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';

import type { PopupSection, SectionProps } from '../../registry';
import { killReasons, type KillReason } from './reasons';

/** How many newest audit entries to fetch; killReasons keeps at most KILL_REASON_LIMIT lines. */
const AUDIT_LOOKBACK = 20;

export function KillSection({ messaging }: SectionProps): JSX.Element {
  const [kill, setKill] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<KillReason[]>([]);

  const loadReasons = useCallback(async (): Promise<void> => {
    try {
      const entries = await messaging.send('audit.list', { limit: AUDIT_LOOKBACK });
      setReasons(killReasons(entries));
    } catch {
      // The reasons are informative only; the shell reports an unreachable background.
    }
  }, [messaging]);

  useEffect(() => {
    const off = messaging.onBroadcast('switches.changed', (p) => {
      setKill(p.killSwitch);
      if (!p.killSwitch) setConfirming(false);
    });
    void messaging.send('settings.get', undefined).then(
      (s) => {
        setKill((k) => k ?? s.killSwitch); // a broadcast is newer than this read
      },
      () => undefined,
    );
    void loadReasons();
    return off;
  }, [messaging, loadReasons]);

  const sendKill = async (on: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await messaging.send('kill.set', { on });
      setKill(on);
      setConfirming(false);
      void loadReasons(); // the kill's disarms are audited right after the reply
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const onToggle = (): void => {
    if (busy) return;
    if (kill === true) setConfirming(true);
    else void sendKill(true); // unknown state: Stop is still available (fail closed)
  };

  const stopped = kill === true;
  return (
    <section class="auto-kill" aria-label="Auto-kill" data-testid="kill-section">
      <p class="kill-state" data-testid="kill-section-state" role="status">
        <span class="symbol" aria-hidden="true">
          {stopped ? '■' : '●'}
        </span>{' '}
        {kill === null ? 'Kill switch: unknown' : stopped ? 'Kill switch: ON — snipes are stopped' : 'Kill switch: OFF'}
      </p>
      {stopped && confirming ? (
        <div class="kill-confirm" role="group" aria-label="Confirm resume">
          <p class="kill-title">Resume automation?</p>
          <div class="buttons">
            <button
              type="button"
              class="keep"
              onClick={() => {
                setConfirming(false);
              }}
            >
              Keep stopped
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!busy) void sendKill(false);
              }}
            >
              Resume
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          class={stopped ? 'kill-button on' : 'kill-button'}
          aria-pressed={stopped}
          disabled={busy}
          onClick={onToggle}
        >
          <span class="kill-title">Auto-kill</span>
          <span>{stopped ? 'Resume automation…' : 'Stop all automation'}</span>
        </button>
      )}
      {error !== null && (
        <p class="error" role="alert">
          {error}
        </p>
      )}
      <div data-testid="kill-section-reasons">
        <p class="hint">Recently stopped automatically:</p>
        {reasons.length === 0 ? (
          <p class="muted">None yet.</p>
        ) : (
          <ul class="kill-reasons">
            {reasons.map((r) => (
              <li key={`${String(r.at)}:${r.text}`}>{r.text}</li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

export const section: PopupSection = { id: 'kill', order: 10, Component: KillSection };
