// T-69: the ntfy (phone push) options section. Opt-in only: the enable toggle,
// a "Generate topic" button (128-bit secret, R3), copy-topic for subscribing in
// the ntfy app, and the optional https://ntfy.sh/* host permission, requested
// straight from the click handler (I-21) through the Permissions port — there
// is no background handler for it. One-line third-party privacy note (R4), the
// Firefox `technicalAndInteraction` note (R9), and v1 supports only ntfy.sh.
import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { BrowserClock } from '../../../../adapters/browser/clock';
import { isFirefox } from '../../../../adapters/browser/env';
import { BrowserHttp } from '../../../../adapters/browser/http';
import { BrowserPermissions } from '../../../../adapters/browser/permissions';
import { NTFY_ORIGIN, NTFY_SERVER, cancelScheduledMessages } from '../../../../adapters/ntfy/ntfy-sink';
import { generateTopic, isValidTopic, maskTopic } from '../../../../adapters/ntfy/topic';
import type { Settings } from '../../../../domain/settings/schema';
import type { NtfyState } from '../../../../domain/storage/schema';
import type { Clock } from '../../../../ports/clock';
import type { Http } from '../../../../ports/http';
import type { Permissions } from '../../../../ports/permissions';
import { Card, Field } from '../../../../ui/components/Field';
import { describeError } from '../../../../ui/components/describeError';
import { Status } from '../../../../ui/components/Status';
import { Switch } from '../../../../ui/components/Switch';
import type { SectionDef, SectionProps } from '../../registry';
import { createNtfyScheduledStore, type NtfyScheduledStore } from './scheduled-store';

export interface NtfySectionProps extends SectionProps {
  /** Injectable for tests. */
  permissions?: Pick<Permissions, 'contains' | 'request'>;
  generate?: () => string;
  firefox?: boolean;
  clipboard?: { writeText(text: string): Promise<void> };
  /** Stored seqs (`sbw:ntfy`). The click path cancels them before saving. */
  scheduled?: NtfyScheduledStore;
  http?: Http;
  clock?: Clock;
  /** 0 in tests; production uses the sink's 1 s pace. */
  minIntervalMs?: number;
}

const MAY_STILL_ARRIVE = 'Already-scheduled pushes may still arrive.';

function hasScheduled(state: NtfyState): boolean {
  return Object.values(state.items).some((item) => item.entries.some((entry) => entry.status === 'scheduled'));
}

type Msg = { message: string; tone: 'ok' | 'error' };
type Granted = 'unknown' | 'yes' | 'no';

type NtfyGroup = NonNullable<Settings['ntfy']>;

export function NtfySection(props: NtfySectionProps): VNode {
  const { client } = props;
  const [api] = useState(() => props.permissions ?? new BrowserPermissions());
  const [http] = useState(() => props.http ?? new BrowserHttp());
  const [clock] = useState(() => props.clock ?? new BrowserClock());
  const [scheduled] = useState(() => props.scheduled ?? createNtfyScheduledStore());
  const generate = props.generate ?? generateTopic;
  const firefox = props.firefox ?? isFirefox();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState('');
  const [granted, setGranted] = useState<Granted>('unknown');
  const [status, setStatus] = useState<Msg>({ message: '', tone: 'ok' });
  const [busy, setBusy] = useState(false);
  const retiring = useRef(false);

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

  const save = (next: NtfyGroup, what: string, mask = false): Promise<void> => {
    const previous = settings;
    setSettings({ ...settings, ntfy: next });
    return client.send('settings.set', { ntfy: next }).then(
      () => {
        setStatus({ message: `Saved: ${mask ? maskTopic(next.topic) : what}.`, tone: 'ok' });
      },
      (e: unknown) => {
        setSettings(previous);
        setStatus({ message: `Could not save ${what}. ${describeError(e)}`, tone: 'error' });
      },
    );
  };

  // Cancel while the old topic and the host permission are still in force.
  // The sink refuses every request once the setting is saved off (R2), so the
  // DELETEs have to happen here, before `sbw:ntfy` is cleared and before save.
  const cancelCurrent = async (current: NtfyGroup): Promise<boolean> => {
    const state = await scheduled.load();
    if (!hasScheduled(state)) return true;
    if (!current.enabled || current.server !== NTFY_SERVER || !isValidTopic(current.topic)) return false;
    try {
      if (!(await api.contains({ origins: [NTFY_ORIGIN] }))) return false;
    } catch {
      return false;
    }
    const result = await cancelScheduledMessages({
      topic: current.topic,
      state,
      http,
      clock,
      ...(props.minIntervalMs === undefined ? {} : { minIntervalMs: props.minIntervalMs }),
    });
    return result.ok;
  };

  const applyChange = (current: NtfyGroup, next: NtfyGroup, what: string, mask: boolean, forceSave: boolean): void => {
    if (retiring.current) return;
    retiring.current = true;
    setBusy(true);
    void (async () => {
      let cancelOk: boolean;
      try {
        cancelOk = await cancelCurrent(current);
        if (cancelOk) await scheduled.clear();
      } catch {
        cancelOk = false;
      }
      if (forceSave || cancelOk) await save(next, what, mask);
      if (!cancelOk) setStatus({ message: MAY_STILL_ARRIVE, tone: 'error' });
      retiring.current = false;
      setBusy(false);
    })();
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
          disabled={busy}
          onChange={(v) => {
            if (retiring.current) return;
            if (v) {
              void save({ ...ntfy, enabled: true }, 'phone push');
              return;
            }
            applyChange(ntfy, { ...ntfy, enabled: false }, 'phone push', false, true);
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
            disabled={busy}
            onClick={() => {
              if (retiring.current) return;
              applyChange(ntfy, { ...ntfy, topic: generate() }, 'topic', true, false);
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
