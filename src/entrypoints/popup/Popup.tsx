import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';

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
}

const DRY_RUN_LABELS = { favorites: 'Favorites', calendar: 'Calendar', bidding: 'Bidding' } as const;

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

export function Popup({ messaging, actions, now, sections }: PopupProps): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [kill, setKill] = useState<boolean | null>(null);
  const [health, setHealth] = useState<Health | null | 'error'>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError(null);
    const [s, h] = await Promise.allSettled([
      messaging.send('settings.get', undefined),
      messaging.send('health.get', undefined),
    ]);
    if (s.status === 'fulfilled') {
      setSettings(s.value);
      // A broadcast that arrived first is newer than the loaded value.
      setKill((k) => k ?? s.value.killSwitch);
    } else {
      setLoadError(`Cannot reach the background: ${errorText(s.reason)}`);
    }
    setHealth(h.status === 'fulfilled' ? h.value : 'error');
  }, [messaging]);

  useEffect(() => {
    // Subscribe before loading, so no change is missed in between.
    const off = messaging.onBroadcast('switches.changed', (p) => {
      setKill(p.killSwitch);
    });
    void load();
    return off;
  }, [messaging, load]);

  const toggleKill = async (): Promise<void> => {
    const on = !(kill ?? false);
    setActionError(null);
    setBusy(true);
    try {
      await messaging.send('kill.set', { on });
      setKill(on);
    } catch (e) {
      setActionError(`Could not change the kill switch: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };

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
        <button
          type="button"
          class={stopped ? 'kill-button on' : 'kill-button'}
          aria-pressed={stopped}
          disabled={busy}
          onClick={() => void toggleKill()}
        >
          <span class="kill-title">Kill switch</span>
          <span class="kill-action">{stopped ? 'Resume automation' : 'Stop all automation'}</span>
        </button>
        <p class="kill-state" data-testid="kill-state" role="status">
          <span class="symbol" aria-hidden="true">
            {stopped ? '■' : '●'}
          </span>{' '}
          {kill === null ? 'Checking…' : stopped ? 'STOPPED: all automated writes are off' : 'Automation on'}
        </p>
        <p class="hint">
          Shortcut: <kbd>Alt+Shift+K</kbd>
        </p>
      </section>

      {loadError !== null && (
        <div class="error" role="alert">
          <p>{loadError}</p>
          <button type="button" onClick={() => void load()}>
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
