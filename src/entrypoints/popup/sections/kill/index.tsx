// T-86 (R5): the popup's auto-kill reasons. The shell (Popup.tsx) owns the one
// kill control and sends `kill.set` (a ui message): kill ON is one click, kill
// OFF asks first. This section is the reasons list only — text, never markup.
//
// The lines come from `audit.list`. A `switches.changed` broadcast (the shell's
// kill.set, or the shortcut) reloads them.
import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';

import type { PopupSection, SectionProps } from '../../registry';
import { killReasons, type KillReason } from './reasons';

/** How many newest audit entries to fetch; killReasons keeps at most KILL_REASON_LIMIT lines. */
const AUDIT_LOOKBACK = 20;

export function KillSection({ messaging }: SectionProps): JSX.Element {
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
    const off = messaging.onBroadcast('switches.changed', () => {
      void loadReasons();
    });
    void loadReasons();
    return off;
  }, [messaging, loadReasons]);

  return (
    <section class="auto-kill" aria-label="Auto-kill" data-testid="kill-section">
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
