// T-56: the Notifications options section. It owns the notification toggles, the
// quiet hours, and the one button that asks for the optional `notifications`
// permission. The request is made straight from the click (I-21), through
// src/ui/permissions.ts; no background handler is involved.
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { BrowserPermissions } from '../../../../adapters/browser/permissions';
import type { Settings } from '../../../../domain/settings/schema';
import type { Permissions } from '../../../../ports/permissions';
import { Card, Field } from '../../../../ui/components/Field';
import { describeError } from '../../../../ui/components/describeError';
import { Status } from '../../../../ui/components/Status';
import { Switch } from '../../../../ui/components/Switch';
import { hasPermissions, requestPermissions } from '../../../../ui/permissions';
import type { SectionDef, SectionProps } from '../../registry';

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface NotificationsSectionProps extends SectionProps {
  /** Injectable for tests. */
  permissions?: Pick<Permissions, 'contains' | 'request'>;
}

type Msg = { message: string; tone: 'ok' | 'error' };
type Granted = 'unknown' | 'yes' | 'no';

export function NotificationsSection(props: NotificationsSectionProps): VNode {
  const { client } = props;
  const [api] = useState(() => props.permissions ?? new BrowserPermissions());
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState('');
  const [granted, setGranted] = useState<Granted>('unknown');
  const [status, setStatus] = useState<Msg>({ message: '', tone: 'ok' });
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [timeError, setTimeError] = useState<string | undefined>(undefined);

  useEffect(() => {
    client.send('settings.get', undefined).then(
      (s) => {
        setSettings(s);
        setFrom(s.notifications.quietHours?.from ?? '');
        setTo(s.notifications.quietHours?.to ?? '');
      },
      (e: unknown) => {
        setLoadError(`Could not load your settings. ${describeError(e)}`);
      },
    );
    void hasPermissions(api, ['notifications']).then((ok) => {
      setGranted(ok ? 'yes' : 'no');
    });
  }, [client, api]);

  if (settings === null) {
    return loadError === '' ? <p>Loading your settings...</p> : <Status message={loadError} tone="error" />;
  }
  const n = settings.notifications;

  const saveNotifications = (next: Settings['notifications'], what: string): void => {
    const previous = settings;
    setSettings({ ...settings, notifications: next });
    client.send('settings.set', { notifications: next }).then(
      () => {
        setStatus({ message: `Saved: ${what}.`, tone: 'ok' });
      },
      (e: unknown) => {
        setSettings(previous);
        setStatus({ message: `Could not save ${what}. ${describeError(e)}`, tone: 'error' });
      },
    );
  };

  // Not async before the request: the permission prompt needs the click's gesture.
  const grant = (): void => {
    void requestPermissions(api, ['notifications']).then((r) => {
      if (r.kind === 'granted') {
        setGranted('yes');
        setStatus({ message: 'Notifications are allowed.', tone: 'ok' });
      } else if (r.kind === 'denied') {
        setGranted('no');
        setStatus({ message: 'The browser did not allow notifications. Nothing was changed.', tone: 'error' });
      } else {
        setStatus({ message: `Could not ask for notifications. ${r.message}`, tone: 'error' });
      }
    });
  };

  const submitQuiet = (e: Event): void => {
    e.preventDefault();
    if (from === '' && to === '') {
      setTimeError(undefined);
      saveNotifications({ enabled: n.enabled, digest: n.digest }, 'quiet hours (off)');
      return;
    }
    if (!TIME.test(from) || !TIME.test(to)) {
      setTimeError('Enter both times as HH:MM, for example 22:00 and 07:00.');
      return;
    }
    setTimeError(undefined);
    saveNotifications({ ...n, quietHours: { from, to } }, 'quiet hours');
  };

  return (
    <div>
      <Card>
        <h3>Permission</h3>
        {granted === 'yes' ? (
          <p>ShopBadwill may show notifications.</p>
        ) : (
          <>
            <p>
              Notifications need a permission your browser asks for separately. Until you allow it, no notification is shown;
              the activity log still records what would have been sent.
            </p>
            <button type="button" onClick={grant}>
              Allow notifications
            </button>
          </>
        )}
      </Card>
      <Card>
        <h3>What to notify</h3>
        <Switch
          id="notify-enabled"
          label="Notifications"
          hint="Alerts for matches that end within the hour, and the digest below."
          checked={n.enabled}
          onChange={(v) => {
            saveNotifications({ ...n, enabled: v }, 'notifications');
          }}
        />
        <Switch
          id="notify-digest"
          label="One digest after each run"
          hint="For example: 3 new matches in Pyrex. Only watches with notifications turned on are included."
          checked={n.digest}
          disabled={!n.enabled}
          onChange={(v) => {
            saveNotifications({ ...n, digest: v }, 'digest');
          }}
        />
        <p class="sbw-hint">
          Firefox shows plain notifications without buttons; clicking one opens the dashboard.
        </p>
      </Card>
      <Card>
        <h3>Quiet hours</h3>
        <p class="sbw-hint">
          A digest that would arrive during quiet hours waits until they end. Alerts for items ending within the hour
          are still shown. Times use your time zone ({settings.locale.timeZone}). Leave both empty for no quiet hours.
        </p>
        <form onSubmit={submitQuiet}>
          <Field id="quiet-from" label="From" error={timeError}>
            {(c) => (
              <input
                {...c}
                type="time"
                value={from}
                onInput={(e) => {
                  setFrom(e.currentTarget.value);
                }}
              />
            )}
          </Field>
          <Field id="quiet-to" label="Until">
            {(c) => (
              <input
                {...c}
                type="time"
                value={to}
                onInput={(e) => {
                  setTo(e.currentTarget.value);
                }}
              />
            )}
          </Field>
          <button type="submit">Save quiet hours</button>
        </form>
      </Card>
      <Status message={status.message} tone={status.tone} />
    </div>
  );
}

export const section: SectionDef = {
  id: 'notifications',
  title: 'Notifications',
  order: 22,
  Component: NotificationsSection,
};
