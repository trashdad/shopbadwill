// T-126: the popup's "Sync now". One click runs, in order, the Google Calendar
// sync (which also feeds the phone push) and the ShopGoodwill favorites sync,
// and shows one plain line per part. A part that fails never stops the next.
// Watch searches are NOT run here: each one is a shopgoodwill.com request, and
// they have their own Run now in the options page.
//
// Disabled while running and while the kill switch is on (read from
// settings.get, then followed through the `switches.changed` broadcast).
import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { calendarSyncMessage } from '../../../../ui/calendar-sync-message';
import { describeError } from '../../../../ui/components/describeError';
import type { PopupSection, SectionProps } from '../../registry';

interface PartResult {
  part: 'Calendar' | 'Favorites';
  ok: boolean;
  text: string;
}

export function SyncSection({ messaging }: SectionProps): JSX.Element {
  const [kill, setKill] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<PartResult[]>([]);
  // A broadcast is newer than a settings.get that started before it.
  const broadcastSeen = useRef(false);

  useEffect(() => {
    const off = messaging.onBroadcast('switches.changed', (p) => {
      broadcastSeen.current = true;
      setKill(p.killSwitch);
    });
    messaging.send('settings.get', undefined).then(
      (s) => {
        if (!broadcastSeen.current) setKill(s.killSwitch);
      },
      () => undefined, // unknown: the background still gates every write
    );
    return off;
  }, [messaging]);

  const syncAll = async (): Promise<void> => {
    setBusy(true);
    setResults([]);
    const out: PartResult[] = [];
    try {
      const m = calendarSyncMessage(await messaging.send('calendar.syncNow', undefined));
      out.push({ part: 'Calendar', ...m });
    } catch (e) {
      out.push({ part: 'Calendar', ok: false, text: describeError(e) });
    }
    setResults([...out]);
    try {
      await messaging.send('favorites.sync', undefined);
      out.push({ part: 'Favorites', ok: true, text: 'Favorites synced.' });
    } catch (e) {
      out.push({ part: 'Favorites', ok: false, text: describeError(e) });
    }
    setResults([...out]);
    setBusy(false);
  };

  const stopped = kill === true;

  return (
    <section class="sync" aria-label="Sync" data-testid="sync-section">
      <button
        type="button"
        disabled={busy || stopped}
        onClick={() => {
          if (!busy && !stopped) void syncAll();
        }}
      >
        Sync now
      </button>
      {stopped ? <p class="hint warn">Kill switch is on</p> : null}
      <p class="hint">Searches run on their schedule; use Run now in Options → Watches to check them now.</p>
      <div role="status" data-testid="sync-results">
        {busy && results.length < 2 ? <p class="muted">Syncing…</p> : null}
        {results.map((r) => (
          <p key={r.part} class={r.ok ? 'row' : 'row warn'} data-ok={String(r.ok)}>
            {r.part}: {r.text}
          </p>
        ))}
      </div>
    </section>
  );
}

export const section: PopupSection = { id: 'sync', order: 15, Component: SyncSection };
