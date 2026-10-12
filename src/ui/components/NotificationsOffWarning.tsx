// T-118 (F4): `notifications` is an optional permission. Without it every snipe
// alert (at risk, soon, unconfirmed) is silently dropped. The arm flow (T-85)
// and the snipe settings (T-91) show this warning with a one-click Allow. The
// request is the first thing the click does (I-21), through src/ui/permissions.ts.
// It never blocks arming; the background audits an arm made without it.
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import type { Permissions } from '../../ports/permissions';
import { hasPermissions, requestPermissions } from '../permissions';

export const NOTIFICATIONS_OFF_TEXT = 'Notifications are off: you will not be told if this snipe is at risk.';

export function NotificationsOffWarning(props: { api: Pick<Permissions, 'contains' | 'request'> }): VNode | null {
  const { api } = props;
  const [granted, setGranted] = useState<'unknown' | 'yes' | 'no'>('unknown');
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let live = true;
    void hasPermissions(api, ['notifications']).then((ok) => {
      if (live) setGranted(ok ? 'yes' : 'no');
    });
    return () => {
      live = false;
    };
  }, [api]);

  if (granted !== 'no') return null;

  // Not async before the request: the permission prompt needs the click's gesture.
  const allow = (): void => {
    void requestPermissions(api, ['notifications']).then((r) => {
      if (r.kind === 'granted') {
        setProblem('');
        setGranted('yes');
      } else if (r.kind === 'denied') {
        setProblem('The browser did not allow notifications.');
      } else {
        setProblem(`Could not ask for notifications. ${r.message}`);
      }
    });
  };

  return (
    <div class="sbw-warn" data-notify-off="">
      <p>{NOTIFICATIONS_OFF_TEXT}</p>
      <p>
        <button type="button" onClick={allow}>
          Allow notifications
        </button>
      </p>
      {problem === '' ? null : <p role="alert">{problem}</p>}
    </div>
  );
}
