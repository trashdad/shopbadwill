import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { AuthStatus } from '../../../../domain/calendar/types';
import type { Settings } from '../../../../domain/settings/schema';
import { describeError } from '../../../../ui/components/describeError';
import { Card } from '../../../../ui/components/Field';
import { Status } from '../../../../ui/components/Status';
import { Switch } from '../../../../ui/components/Switch';
import type { SectionDef, SectionProps } from '../../registry';
import {
  CLIENT_ID_RE,
  createGoogleConfigStore,
  maskSecret,
  type ClientConfigView,
  type GoogleConfigStore,
} from './config-store';
import { ERROR_HINTS } from './hints';
import { canAddReminder, DEFAULT_REMINDERS, parseReminders } from './reminders';

export interface GoogleSectionProps extends SectionProps {
  /** Injectable for tests. */
  store?: GoogleConfigStore;
  now?: () => number;
}

const DAY_MS = 86_400_000;
/** Google's Testing-mode refresh-token lifetime. */
const TESTING_WINDOW_MS = 7 * DAY_MS;

type Msg = { message: string; tone: 'ok' | 'error' };

function Alert(props: { id: string; text: string | undefined }): VNode | null {
  if (props.text === undefined) return null;
  return (
    <p class="sbw-error" id={props.id} role="alert">
      <strong>Error:</strong> {props.text}
    </p>
  );
}

export function GoogleSection(props: GoogleSectionProps): VNode {
  const { client } = props;
  const now = props.now ?? Date.now;
  const storeRef = useRef<GoogleConfigStore | null>(null);
  storeRef.current ??= props.store ?? createGoogleConfigStore();
  const store = storeRef.current;

  const [saved, setSaved] = useState<ClientConfigView>({ clientId: '', secretTail: null });
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [idError, setIdError] = useState<string | undefined>(undefined);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authUnavailable, setAuthUnavailable] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [offerEnable, setOfferEnable] = useState(false);
  const [msg, setMsg] = useState<Msg>({ message: '', tone: 'ok' });
  const [settings, setSettings] = useState<Settings | null>(null);
  const [reminders, setReminders] = useState<string[]>(DEFAULT_REMINDERS.map(String));
  const [reminderError, setReminderError] = useState<string | undefined>(undefined);
  const [modeMsg, setModeMsg] = useState<Msg>({ message: '', tone: 'ok' });

  const refreshStatus = (): Promise<void> =>
    client.send('calendar.status', undefined).then(
      (s) => {
        setAuth(s);
        setAuthUnavailable(false);
      },
      () => {
        setAuthUnavailable(true);
      },
    );

  useEffect(() => {
    store.load().then(
      (v) => {
        setSaved(v);
        setClientId(v.clientId);
      },
      () => {
        setMsg({ message: 'Could not read your saved Google client.', tone: 'error' });
      },
    );
    void refreshStatus();
    client.send('settings.get', undefined).then(
      (s) => {
        setSettings(s);
        setReminders(s.calendar.reminders.map(String));
      },
      () => {
        /* the editors stay on their defaults */
      },
    );
  }, [client, store]);

  const idTrim = clientId.trim();
  const hasSecret = secret.trim() !== '' || saved.secretTail !== null;
  // S-4: Chrome verified; Firefox pending
  const canConnect = idTrim !== '' && hasSecret && !busy;

  const connect = async (): Promise<void> => {
    if (!CLIENT_ID_RE.test(idTrim)) {
      setIdError('That does not look like a Google client ID. It looks like 1234567890-abc123.apps.googleusercontent.com.');
      return;
    }
    setIdError(undefined);
    setBusy(true);
    setMsg({ message: '', tone: 'ok' });
    try {
      // Saved first: the background reads the client from storage when it connects.
      await store.save({ clientId: idTrim, clientSecret: secret.trim() });
      setSecret('');
      setSaved(await store.load());
      const status = await client.send('calendar.connect', undefined);
      setAuth(status);
      setAuthUnavailable(false);
      // Never turn calendar events on silently: connecting only offers the one-click prompt.
      if (status.connected && settings?.calendar.enabled === false) setOfferEnable(true);
      setMsg(
        status.connected
          ? { message: 'Connected to Google Calendar.', tone: 'ok' }
          : {
              message: status.lastError === undefined ? 'Google did not connect.' : ERROR_HINTS[status.lastError],
              tone: 'error',
            },
      );
    } catch (e) {
      setMsg({ message: `Could not connect to Google. ${describeError(e)}`, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    setConfirming(false);
    setOfferEnable(false);
    setBusy(true);
    try {
      await client.send('calendar.disconnect', undefined);
      await refreshStatus();
      setMsg({ message: 'Disconnected from Google. Your client ID and secret are kept.', tone: 'ok' });
    } catch (e) {
      setMsg({ message: `Could not disconnect. ${describeError(e)}`, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const saveCalendar = (patch: Partial<Settings['calendar']>, what: string): void => {
    if (settings === null) {
      setModeMsg({ message: `Could not save ${what}: your settings have not loaded.`, tone: 'error' });
      return;
    }
    // Only the dedicated calendar works with the narrow scope (T-62), so never store another mode.
    const next = { ...settings.calendar, ...patch, mode: 'dedicated' as const };
    client.send('settings.set', { calendar: next }).then(
      () => {
        setSettings({ ...settings, calendar: next });
        setModeMsg({ message: `Saved: ${what}.`, tone: 'ok' });
      },
      (e: unknown) => {
        setModeMsg({ message: `Could not save ${what}. ${describeError(e)}`, tone: 'error' });
      },
    );
  };

  const saveReminders = (e: Event): void => {
    e.preventDefault();
    const parsed = parseReminders(reminders);
    if (parsed === null) {
      setReminderError('Use whole minutes of 1 or more, and at most 5 reminders.');
      return;
    }
    setReminderError(undefined);
    saveCalendar({ reminders: parsed }, 'reminders');
  };

  /**
   * T-70b: the calendar on/off toggle. Turning it off only stops future syncs;
   * it never deletes events (that is the per-event audit undo). Turning it on
   * saves `calendar.enabled` first, so the sync it then starts sees it on.
   */
  const setCalendarEnabled = (on: boolean, afterSaved?: () => void): void => {
    if (settings === null) {
      setModeMsg({ message: 'Could not save calendar events: your settings have not loaded.', tone: 'error' });
      return;
    }
    const next = { ...settings.calendar, enabled: on, mode: 'dedicated' as const };
    client.send('settings.set', { calendar: next }).then(
      () => {
        setSettings({ ...settings, calendar: next });
        afterSaved?.();
        if (on) {
          setModeMsg({ message: 'Calendar events are on. Syncing your auctions now...', tone: 'ok' });
          client.send('calendar.syncNow', undefined).catch((e: unknown) => {
            setModeMsg({ message: `Calendar events are on, but the sync could not start. ${describeError(e)}`, tone: 'error' });
          });
        } else {
          setModeMsg({
            message: 'Calendar sync is off. Existing events stay on your calendar; delete them with the per-event undo.',
            tone: 'ok',
          });
        }
      },
      (e: unknown) => {
        setModeMsg({ message: `Could not save calendar events. ${describeError(e)}`, tone: 'error' });
      },
    );
  };

  const expiresAt = auth?.refreshTokenExpiresAt;
  const testingWarning = auth?.connected === true && expiresAt !== undefined && expiresAt <= now() + TESTING_WINDOW_MS;

  const calendarToggleOff = settings === null || auth === null || !auth.connected;
  const calendarToggleHint =
    auth === null
      ? authUnavailable
        ? 'Could not check Google, so this stays off. Reload the page to try again.'
        : 'Checking Google...'
      : !auth.connected
        ? 'Connect Google first'
        : settings === null
          ? 'Could not read your settings, so this stays off. Reload the page to try again.'
          : 'Adds auction ends to your calendar.';

  return (
    <div class="sbw-google">
      <Status message={msg.message} tone={msg.tone} />

      <Card>
        <h3>Your Google client</h3>
        <p class="sbw-hint">
          ShopBadwill uses your own Google OAuth client, so nothing is shared with anyone else. Create a Web application client in Google Cloud console and paste its details here. They stay on this device.
        </p>
        <div class={idError === undefined ? 'sbw-field' : 'sbw-field sbw-field-invalid'}>
          <label for="g-client-id">Client ID</label>
          <input
            id="g-client-id"
            type="text"
            autoComplete="off"
            spellcheck={false}
            value={clientId}
            aria-describedby={idError === undefined ? undefined : 'g-client-id-error'}
            aria-invalid={idError === undefined ? undefined : true}
            onInput={(e) => {
              setClientId(e.currentTarget.value);
              setIdError(undefined);
            }}
          />
          <Alert id="g-client-id-error" text={idError} />
        </div>
        <div class="sbw-field">
          <label for="g-client-secret">Client secret</label>
          <input
            id="g-client-secret"
            type="password"
            autoComplete="off"
            spellcheck={false}
            ref={(el) => {
              el?.setAttribute('spellcheck', 'false');
            }}
            placeholder={saved.secretTail === null ? '' : `Saved: ${maskSecret(saved.secretTail)}`}
            aria-describedby="g-client-secret-hint"
            value={secret}
            onInput={(e) => {
              setSecret(e.currentTarget.value);
            }}
          />
          <p class="sbw-hint" id="g-client-secret-hint">
            Required for Chrome's Web client (Google rejects the sign-in without it).
          </p>
        </div>
        <div class="sbw-actions">
          <button
            type="button"
            disabled={!canConnect}
            onClick={() => {
              void connect();
            }}
          >
            Connect to Google Calendar
          </button>
        </div>
      </Card>

      <Card>
        <h3>Connection</h3>
        {auth === null ? (
          <p>{authUnavailable ? 'Google status is unavailable right now.' : 'Checking Google...'}</p>
        ) : (
          <div>
            <p>
              <strong>{auth.connected ? 'Connected' : 'Not connected'}</strong>
              {auth.account === undefined ? null : <> as {auth.account}</>}
            </p>
            <dl class="sbw-caps">
              <dt>Permission</dt>
              <dd>{auth.grantedScopes.length === 0 ? 'None' : auth.grantedScopes.join(', ')}</dd>
              {auth.refreshTokenAgeDays === undefined ? null : (
                <>
                  <dt>Signed in</dt>
                  <dd>{`${String(Math.floor(auth.refreshTokenAgeDays))} days ago`}</dd>
                </>
              )}
              <dt>Last error</dt>
              <dd>{auth.lastError === undefined ? 'None' : ERROR_HINTS[auth.lastError]}</dd>
            </dl>
            {offerEnable && auth.connected ? (
              <div role="group" aria-label="Turn on calendar events" class="sbw-actions">
                <p>Calendar events are still off. One click turns them on:</p>
                <button
                  type="button"
                  onClick={() => {
                    setCalendarEnabled(true, () => {
                      setOfferEnable(false);
                    });
                  }}
                >
                  Turn on calendar events now?
                </button>
              </div>
            ) : null}
            {testingWarning ? (
              <p class="sbw-warn" role="note">
                <strong>Warning:</strong> Your Google app is in Testing mode, so Google signs you out every 7 days. Open Google Cloud console → OAuth consent screen → Publish app.
              </p>
            ) : null}
            {auth.needsInteraction ? (
              <div class="sbw-actions">
                <p>Google needs you to sign in again.</p>
                <button
                  type="button"
                  disabled={!canConnect}
                  onClick={() => {
                    void connect();
                  }}
                >
                  Reconnect Google
                </button>
              </div>
            ) : null}
            {auth.connected && !confirming ? (
              <div class="sbw-actions">
                <button
                  type="button"
                  class="sbw-secondary"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(true);
                  }}
                >
                  Disconnect
                </button>
              </div>
            ) : null}
            {confirming ? (
              <div role="group" aria-label="Confirm disconnect" class="sbw-actions">
                <p>
                  Disconnect Google? ShopBadwill's access to your calendar will be revoked. Events already created stay on your calendar.
                </p>
                <button
                  type="button"
                  class="sbw-danger"
                  onClick={() => {
                    void disconnect();
                  }}
                >
                  Yes, disconnect
                </button>
                <button
                  type="button"
                  class="sbw-secondary"
                  onClick={() => {
                    setConfirming(false);
                  }}
                >
                  Cancel
                </button>
              </div>
            ) : null}
          </div>
        )}
      </Card>

      <Card>
        <h3>Calendar</h3>
        <Status message={modeMsg.message} tone={modeMsg.tone} />
        <Switch
          id="g-calendar-enabled"
          label="Add auction ends to Google Calendar"
          hint={calendarToggleHint}
          checked={settings?.calendar.enabled === true}
          disabled={calendarToggleOff}
          onChange={(v) => {
            setCalendarEnabled(v);
          }}
        />
        <fieldset class="sbw-inline-fieldset">
          <legend>Which calendar</legend>
          <label>
            <input type="radio" name="calendar-mode" value="dedicated" checked readOnly aria-describedby="g-mode-hint" /> A separate
            ShopBadwill calendar (recommended)
          </label>
          <label>
            <input type="radio" name="calendar-mode" value="primary" checked={false} disabled aria-describedby="g-mode-hint" /> My
            primary calendar
          </label>
          <p class="sbw-hint" id="g-mode-hint">
            Not available: uses a narrower Google permission (only calendars this extension creates).
          </p>
        </fieldset>

        <form onSubmit={saveReminders} noValidate aria-label="Reminders">
          <fieldset class="sbw-inline-fieldset">
            <legend>Reminders (minutes before the auction ends)</legend>
            {reminders.map((r, i) => (
              <div class="sbw-row" key={i}>
                <label for={`g-rem-${String(i)}`}>{`Reminder ${String(i + 1)} (minutes)`}</label>
                <input
                  id={`g-rem-${String(i)}`}
                  type="text"
                  inputMode="numeric"
                  value={r}
                  aria-describedby={reminderError === undefined ? undefined : 'g-rem-error'}
                  aria-invalid={reminderError === undefined ? undefined : true}
                  onInput={(e) => {
                    const v = e.currentTarget.value;
                    setReminders((cur) => cur.map((x, j) => (j === i ? v : x)));
                  }}
                />
                <button
                  type="button"
                  class="sbw-secondary"
                  aria-label={`Remove reminder ${String(i + 1)}`}
                  onClick={() => {
                    setReminders((cur) => cur.filter((_, j) => j !== i));
                  }}
                >
                  Remove
                </button>
              </div>
            ))}
            <Alert id="g-rem-error" text={reminderError} />
            <p class="sbw-hint">Google allows at most 5 reminders per event.</p>
          </fieldset>
          <div class="sbw-actions">
            <button
              type="button"
              class="sbw-secondary"
              disabled={!canAddReminder(reminders.length)}
              onClick={() => {
                setReminders((cur) => [...cur, '']);
              }}
            >
              Add reminder
            </button>
            <button
              type="button"
              class="sbw-secondary"
              onClick={() => {
                setReminders(DEFAULT_REMINDERS.map(String));
                setReminderError(undefined);
              }}
            >
              Reset to 60, 15, 5
            </button>
            <button type="submit">Save reminders</button>
          </div>
        </form>
      </Card>
    </div>
  );
}

export const section: SectionDef = { id: 'google', title: 'Google Calendar', order: 25, Component: GoogleSection };
