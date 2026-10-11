// T-69: the ntfy (phone push) options section. Opt-in only: the enable toggle,
// a "Generate topic" button (128-bit secret, R3), copy-topic for subscribing in
// the ntfy app, and the optional https://ntfy.sh/* host permission, requested
// straight from the click handler (I-21) through the Permissions port — there
// is no background handler for it. One-line third-party privacy note (R4), the
// Firefox `technicalAndInteraction` note (R9), and v1 supports only ntfy.sh.
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { isFirefox } from '../../../../adapters/browser/env';
import { BrowserPermissions } from '../../../../adapters/browser/permissions';
import { NTFY_ORIGIN, NTFY_SERVER } from '../../../../adapters/ntfy/ntfy-sink';
import { generateTopic, maskTopic } from '../../../../adapters/ntfy/topic';
import type { Settings } from '../../../../domain/settings/schema';
import type { Permissions } from '../../../../ports/permissions';
import { Card, Field } from '../../../../ui/components/Field';
import { describeError } from '../../../../ui/components/describeError';
import { Status } from '../../../../ui/components/Status';
import { Switch } from '../../../../ui/components/Switch';
import type { SectionDef, SectionProps } from '../../registry';

export interface NtfySectionProps extends SectionProps {
  /** Injectable for tests. */
  permissions?: Pick<Permissions, 'contains' | 'request'>;
  generate?: () => string;
  firefox?: boolean;
  clipboard?: { writeText(text: string): Promise<void> };
}

type Msg = { message: string; tone: 'ok' | 'error' };
type Granted = 'unknown' | 'yes' | 'no';

type NtfyGroup = NonNullable<Settings['ntfy']>;

export function NtfySection(props: NtfySectionProps): VNode {
  const { client } = props;
  const [api] = useState(() => props.permissions ?? new BrowserPermissions());
  const generate = props.generate ?? generateTopic;
  const firefox = props.firefox ?? isFirefox();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState('');
  const [granted, setGranted] = useState<Granted>('unknown');
  const [status, setStatus] = useState<Msg>({ message: '', tone: 'ok' });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    client.send('settings.get', undefined).then(
      (s) => {
        setSettings(s);
      },
      (e: unknown) => {
        setLoadError(`Could not load your settings. ${describeError(e)}`);
      },
    );
    let cancelled = false;
    api
      .contains({ origins: [NTFY_ORIGIN] })
      .then((ok) => {
        if (!cancelled) setGranted(ok ? 'yes' : 'no');
      })
      .catch(() => {
        if (!cancelled) setGranted('no');
      });
    return () => {
      cancelled = true;
    };
  }, [client, api]);

  if (settings === null) {
    return loadError === '' ? <p>Loading your settings...</p> : <Status message={loadError} tone="error" />;
  }
  const ntfy: NtfyGroup = settings.ntfy ?? { enabled: false, server: NTFY_SERVER, topic: '' };
  const unsupportedServer = ntfy.server !== NTFY_SERVER;

  const save = (next: NtfyGroup, what: string, mask = false): void => {
    const previous = settings;
    setSettings({ ...settings, ntfy: next });
    client.send('settings.set', { ntfy: next }).then(
      () => {
        setStatus({ message: `Saved: ${mask ? maskTopic(next.topic) : what}.`, tone: 'ok' });
      },
      (e: unknown) => {
        setSettings(previous);
        setStatus({ message: `Could not save ${what}. ${describeError(e)}`, tone: 'error' });
      },
    );
  };

  // The permission prompt needs the click's gesture (I-21): the request is the
  // first thing that happens, before any await.
  const allow = (): void => {
    let pending: Promise<boolean>;
    try {
      pending = api.request({ origins: [NTFY_ORIGIN] });
    } catch (e) {
      setStatus({ message: `Could not ask for ntfy.sh access. ${describeError(e)}`, tone: 'error' });
      return;
    }
    void pending.then(
      (ok) => {
        if (ok) {
          setGranted('yes');
          setStatus({ message: 'ntfy.sh access is allowed.', tone: 'ok' });
        } else {
          setGranted('no');
          setStatus({ message: 'The browser did not allow ntfy.sh. Nothing was changed.', tone: 'error' });
        }
      },
      (e: unknown) => {
        setStatus({ message: `Could not ask for ntfy.sh access. ${describeError(e)}`, tone: 'error' });
      },
    );
  };

  const copyTopic = (): void => {
    const clip = props.clipboard ?? (typeof navigator === 'undefined' ? undefined : navigator.clipboard);
    if (clip === undefined) {
      setStatus({ message: 'Select the topic and press Ctrl+C (Command+C on a Mac) to copy it.', tone: 'ok' });
      return;
    }
    setBusy(true);
    void clip.writeText(ntfy.topic).then(
      () => {
        setBusy(false);
        setStatus({ message: 'Copied to the clipboard.', tone: 'ok' });
      },
      () => {
        setBusy(false);
        setStatus({ message: 'Could not copy automatically. Select the topic and press Ctrl+C (Command+C on a Mac).', tone: 'error' });
      },
    );
  };

  return (
    <div>
      <Card>
        <h3>Phone push reminders</h3>
        <Switch
          id="ntfy-enabled"
          label="Phone push (ntfy.sh)"
          hint="Sends the auction end reminders (60, 15 and 5 minutes before) to your phone through ntfy.sh."
          checked={ntfy.enabled}
          onChange={(v) => {
            save({ ...ntfy, enabled: v }, 'phone push');
          }}
        />
        <p class="sbw-hint">Auction titles and end times are sent to ntfy.sh.</p>
        {firefox ? (
          <p class="sbw-hint">
            On Firefox, turning this on also asks for the optional <code>technicalAndInteraction</code> data-collection
            permission; ShopBadwill collects nothing beyond what is described here.
          </p>
        ) : null}
        {unsupportedServer ? (
          <Status
            message="This version supports only https://ntfy.sh; the saved server cannot be used yet."
            tone="error"
          />
        ) : null}
      </Card>
      {ntfy.enabled && !unsupportedServer ? (
        <Card>
          <h3>Topic</h3>
          <p class="sbw-hint">
            The topic is the private address your phone subscribes to. Keep it secret. Only the last 4 characters are
            shown outside this field.
          </p>
          <Field id="ntfy-topic" label="Topic">
            {(c) => <input {...c} type="text" value={ntfy.topic} readOnly />}
          </Field>
          <button
            type="button"
            onClick={() => {
              save({ ...ntfy, topic: generate() }, 'topic', true);
            }}
          >
            Generate topic
          </button>
          <button type="button" onClick={copyTopic} disabled={ntfy.topic === '' || busy}>
            Copy topic
          </button>
        </Card>
      ) : null}
      {ntfy.enabled ? (
        <Card>
          <h3>Permission</h3>
          {granted === 'yes' ? (
            <p>ShopBadwill may reach ntfy.sh.</p>
          ) : (
            <>
              <p>
                Sending the reminders needs access to ntfy.sh, which your browser asks for separately. Until you allow
                it, nothing is sent.
              </p>
              <button type="button" onClick={allow}>
                Allow ntfy.sh
              </button>
            </>
          )}
        </Card>
      ) : null}
      <Status message={status.message} tone={status.tone} />
    </div>
  );
}

export const section: SectionDef = {
  id: 'ntfy',
  title: 'Phone push',
  order: 24,
  Component: NtfySection,
};
