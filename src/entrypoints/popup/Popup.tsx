import type { JSX } from 'preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import type { Settings } from '../../domain/settings/schema';
import type { SgwSessionState } from '../../domain/types';
import type { MsgReply } from '../../messaging/protocol';
import type { MessagingClient } from '../../ports/messaging';
import { RelativeTime } from '../../ui/time';
import type { PopupSection } from './registry';

type Health = MsgReply<'health.get'>;

export interface PopupActions {
  openDashboard(): Promise<void>;
  openOptions(): Promise<void>;
}

export interface PopupProps {
  messaging: MessagingClient;
  actions: PopupActions;
  now: () => number;
  sections: readonly PopupSection[];
  /** How long to wait for the background before giving up (default 5000). */
  timeoutMs?: number;
}

const DRY_RUN_LABELS = { favorites: 'Favorites', calendar: 'Calendar', bidding: 'Bidding' } as const;

const DEFAULT_TIMEOUT_MS = 5000;

class TimeoutError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new TimeoutError(`${what} timed out (the background is not responding)`));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const SESSION_VIEW: Record<SgwSessionState, { symbol: string; text: string; hint: string }> = {
  ok: { symbol: '✓', text: 'Signed in', hint: '' },
  expiring: { symbol: '!', text: 'Session expiring soon', hint: 'Log in again soon.' },
  expired: { symbol: '✕', text: 'Session expired', hint: 'Log in on shopgoodwill.com.' },
  'logged-out': { symbol: '✕', text: 'Logged out', hint: 'Log in on shopgoodwill.com.' },
};

function SessionRow({ state, expiresAt, now }: { state: SgwSessionState; expiresAt: number | null; now: number }) {
  const v = SESSION_VIEW[state];
  return (
    <p class={`row session session-${state}`} data-testid="session-state" data-state={state}>
      <span class="symbol" aria-hidden="true">
        {v.symbol}
      </span>
      <span>
        <strong>{v.text}</strong>
        {expiresAt !== null && (state === 'ok' || state === 'expiring') && (
          <>
            {' '}
            · expires <RelativeTime ms={expiresAt} now={now} />
          </>
        )}
        {v.hint !== '' && <span class="hint"> {v.hint}</span>}
      </span>
    </p>
  );
}

function HealthRow({ health }: { health: Health | null | 'error' }) {
  if (health === null) {
    return (
      <p class="row muted" data-testid="health">
        Checking…
      </p>
    );
  }
  if (health === 'error') {
    return (
      <p class="row warn" data-testid="health">
        <span class="symbol" aria-hidden="true">
          !
        </span>{' '}
        Health unavailable
      </p>
    );
  }
  if (health.sgw === null) {
    return (
      <p class="row muted" data-testid="health">
        Site checks have not run yet.
      </p>
    );
  }
  const failing = health.sgw.checks.filter((c) => !c.ok);
  if (health.sgw.ok && failing.length === 0) {
    return (
      <p class="row" data-testid="health">
        <span class="symbol" aria-hidden="true">
          ✓
        </span>{' '}
        Site checks passing
      </p>
    );
  }
  const n = failing.length;
  return (
    <p class="row warn" data-testid="health">
      <span class="symbol" aria-hidden="true">
        !
      </span>{' '}
      {n} {n === 1 ? 'check' : 'checks'} failing{n > 0 ? `: ${failing.map((c) => c.name).join(', ')}` : ''}
    </p>
  );
}

export function Popup({ messaging, actions, now, sections, timeoutMs = DEFAULT_TIMEOUT_MS }: PopupProps): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [kill, setKill] = useState<boolean | null>(null);
  const [health, setHealth] = useState<Health | null | 'error'>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  // Sequence counters: a load result is dropped if a newer load started, and
  // its kill value is dropped if a broadcast arrived while it was in flight.
  const loadSeq = useRef(0);
  const broadcastSeq = useRef(0);

  const load = useCallback(async (resync = false) => {
    setLoadError(null);
    const myLoad = ++loadSeq.current;
    const broadcastAtStart = broadcastSeq.current;
    const [s, h] = await Promise.allSettled([
      withTimeout(messaging.send('settings.get', undefined), timeoutMs, 'settings.get'),
      withTimeout(messaging.send('health.get', undefined), timeoutMs, 'health.get'),
    ]);
    if (myLoad !== loadSeq.current) return; // a newer load superseded this one
    if (s.status === 'fulfilled') {
      setSettings(s.value);
      // A broadcast is newer than any read that started before it. Otherwise
      // Retry re-syncs from the background, and the first load only fills an unknown state.
      const broadcastSince = broadcastSeq.current !== broadcastAtStart;
      if (!broadcastSince) {
        setKill((k) => (resync ? s.value.killSwitch : (k ?? s.value.killSwitch)));
        if (resync) setActionError(null);
      }
    } else {
      setLoadError(`Cannot reach the background: ${errorText(s.reason)}`);
    }
    setHealth(h.status === 'fulfilled' ? h.value : 'error');
  }, [messaging, timeoutMs]);

  useEffect(() => {
    // Subscribe before loading, so no change is missed in between.
    const off = messaging.onBroadcast('switches.changed', (p) => {
      broadcastSeq.current += 1;
      setKill(p.killSwitch);
      setActionError(null);
      if (!p.killSwitch) setConfirming(false);
    });
    void load();
    return off;
  }, [messaging, load]);

  // Stopping is one click. Resuming needs a second, deliberate step, and is
  // never offered while the state is unknown (kill === null).
  const sendKill = async (on: boolean): Promise<void> => {
    setActionError(null);
    setBusy(true);
    try {
      await withTimeout(messaging.send('kill.set', { on }), timeoutMs, 'kill.set');
      setKill(on);
      setConfirming(false);
    } catch (e) {
      if (e instanceof TimeoutError) {
        // The change may have happened after we gave up: the state is unknown, not unchanged.
        setKill(null);
        setConfirming(false);
        setActionError('Unconfirmed: the background did not reply. The state may have changed — checking…');
        void load(true);
      } else {
        setActionError(`Could not change the kill switch: ${errorText(e)}`);
      }
    } finally {
      setBusy(false);
    }
  };

  const onKillClick = (): void => {
    if (busy) return;
    if (kill === true) setConfirming(true);
    else void sendKill(true);
  };

  useEffect(() => {
    if (confirming) keepRef.current?.focus();
  }, [confirming]);

  const toggleOverlay = async (enabled: boolean): Promise<void> => {
    if (settings === null) return;
    const previous = settings;
    const overlay = { ...settings.overlay, enabled };
    setActionError(null);
    setSettings({ ...settings, overlay });
    try {
      await messaging.send('settings.set', { overlay });
    } catch (e) {
      setSettings(previous);
      setActionError(`Could not change the overlay: ${errorText(e)}`);
    }
  };

  const run = (fn: () => Promise<void>) => (): void => {
    setActionError(null);
    fn().catch((e: unknown) => {
      setActionError(errorText(e));
    });
  };

  const stopped = kill === true;
  const background = health !== null && health !== 'error' ? health.budget.lanes.background : undefined;

  return (
    <main class={stopped ? 'popup is-stopped' : 'popup'}>
      <header>
        <h1>ShopBadwill</h1>
      </header>

      <section aria-label="Kill switch section" class="kill">
        {stopped && confirming ? (
          <div class="kill-confirm" role="group" aria-label="Confirm resume">
            <p class="kill-title">Resume automation?</p>
            <div class="buttons">
              <button
                type="button"
                ref={keepRef}
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
            onClick={onKillClick}
          >
            <span class="kill-title">Kill switch</span>
            <span class="kill-action">{stopped ? 'Resume automation…' : 'Stop all automation'}</span>
          </button>
        )}
        <p class="kill-state" data-testid="kill-state" role="status">
          <span class="symbol" aria-hidden="true">
            {stopped ? '■' : '●'}
          </span>{' '}
          {kill === null ? (loadError === null ? 'Checking…' : 'State unknown: stopping is still available') : stopped ? 'STOPPED: all automated writes are off' : 'Automation on'}
        </p>
        <p class="hint">
          Shortcut: <kbd>Alt+Shift+K</kbd>
        </p>
      </section>

      {loadError !== null && (
        <div class="error" role="alert">
          <p>{loadError}</p>
          <button type="button" onClick={() => void load(true)}>
            Retry
          </button>
        </div>
      )}
      {actionError !== null && (
        <p class="error" role="alert">
          {actionError}
        </p>
      )}

      <section aria-label="Status" class="status">
        {health !== null && health !== 'error' ? (
          <SessionRow state={health.sessionState} expiresAt={health.session} now={now()} />
        ) : (
          <p class="row muted" data-testid="session-state" data-state="unknown">
            Session: {health === 'error' ? 'unavailable' : 'checking…'}
          </p>
        )}
        <HealthRow health={health} />
        {background !== undefined && (
          <p class="row muted" data-testid="budget">
            Background requests today: {background.usedToday} / {background.budget}
          </p>
        )}
        {settings !== null && (
          <div role="group" aria-label="Dry-run state" class="badges">
            {(Object.keys(DRY_RUN_LABELS) as Array<keyof typeof DRY_RUN_LABELS>).map((k) => (
              <span key={k} class={settings.dryRun[k] ? 'badge dry' : 'badge live'}>
                {DRY_RUN_LABELS[k]}: {settings.dryRun[k] ? 'Dry run' : 'LIVE'}
              </span>
            ))}
          </div>
        )}
      </section>

      <section aria-label="Controls" class="controls">
        <label class="check">
          <input
            type="checkbox"
            checked={settings?.overlay.enabled ?? false}
            disabled={settings === null}
            onChange={(e) => void toggleOverlay(e.currentTarget.checked)}
          />
          Overlay on shopgoodwill.com
        </label>
        <div class="buttons">
          <button type="button" onClick={run(() => actions.openDashboard())}>
            Open dashboard
          </button>
          <button type="button" onClick={run(() => actions.openOptions())}>
            Open options
          </button>
        </div>
      </section>

      {sections.map((s) => (
        <div key={s.id} id={`section-${s.id}`} class="extra">
          <s.Component messaging={messaging} />
        </div>
      ))}
    </main>
  );
}
