// T-69: the ntfy (phone push) options section. Opt-in only: the enable toggle,
// a "Generate topic" button (128-bit secret, R3), copy-topic for subscribing in
// the ntfy app, and the optional host permission for the server, requested
// straight from the click handler (I-21) through the Permissions port — there
// is no background handler for it. One-line third-party privacy note (R4) and
// the Firefox `technicalAndInteraction` note (R9).
//
// T-123: the server may be any https origin (default https://ntfy.sh), with an
// optional access token for a self-hosted server that needs one. The token
// lives in `sbw:ntfyAuth` (auth-store.ts), is shown only as its last 4
// characters, and is never logged, audited, put in a message or exported.
// Changing the server or the token while phone push is on works like a topic
// rotation: the scheduled pushes are DELETEd on the OLD server and topic with
// the OLD token first. "Send a test push" publishes one immediate message.
import { onSettingsSaved } from '../../settings-events';
import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { BrowserClock } from '../../../../adapters/browser/clock';
import { isFirefox } from '../../../../adapters/browser/env';
import { BrowserHttp } from '../../../../adapters/browser/http';
import { BrowserPermissions } from '../../../../adapters/browser/permissions';
import { NTFY_SERVER, cancelScheduledMessages, testPushRequest } from '../../../../adapters/ntfy/ntfy-sink';
import { isAllowedServer, normalizeToken, parseServer, serverHost, serverPermissionPattern } from '../../../../adapters/ntfy/server';
import { generateTopic, isValidTopic, maskTopic } from '../../../../adapters/ntfy/topic';
import type { Settings } from '../../../../domain/settings/schema';
import type { NtfyState } from '../../../../domain/storage/schema';
import type { Clock } from '../../../../ports/clock';
import { HttpTimeoutError } from '../../../../ports/errors';
import type { Http } from '../../../../ports/http';
import type { Permissions } from '../../../../ports/permissions';
import { Card, Field } from '../../../../ui/components/Field';
import { describeError } from '../../../../ui/components/describeError';
import { Status } from '../../../../ui/components/Status';
import { Switch } from '../../../../ui/components/Switch';
import type { SectionDef, SectionProps } from '../../registry';
import { createNtfyAuthStore, maskToken, type NtfyAuthStore } from './auth-store';
import { createNtfyScheduledStore, type NtfyScheduledStore } from './scheduled-store';

export interface NtfySectionProps extends SectionProps {
  /** Injectable for tests. */
  permissions?: Pick<Permissions, 'contains' | 'request'>;
  generate?: () => string;
  firefox?: boolean;
  clipboard?: { writeText(text: string): Promise<void> };
  /** Stored seqs (`sbw:ntfy`). The click path cancels them before saving. */
  scheduled?: NtfyScheduledStore;
  /** T-123: the access token (`sbw:ntfyAuth`). */
  auth?: NtfyAuthStore;
  http?: Http;
  clock?: Clock;
  /** 0 in tests; production uses the sink's 1 s pace. */
  minIntervalMs?: number;
}

const MAY_STILL_ARRIVE = 'Already-scheduled pushes may still arrive: they could not be cancelled.';
const TOPIC_KEPT =
  'The topic was not changed: the pushes already scheduled on it could not be cancelled. Try again later.';
const SERVER_KEPT =
  'The server was not changed: the pushes already scheduled on the old server could not be cancelled. Try again later, or turn phone push off first (those pushes may then still arrive).';
const TOKEN_NOT_CANCELLED =
  'The pushes already scheduled could not be cancelled with the old token. ShopBadwill schedules them again with the new one, which replaces them on the server.';

function hasScheduled(state: NtfyState): boolean {
  return Object.values(state.items).some((item) => item.entries.some((entry) => entry.status === 'scheduled'));
}

type Msg = { message: string; tone: 'ok' | 'error' };
type Granted = 'unknown' | 'yes' | 'no';

type NtfyGroup = NonNullable<Settings['ntfy']>;

/** The test push's result in plain words (T-123). Never names the topic or the token. */
export function describeTestPush(
  result: { status: number } | { error: unknown },
  host: string,
  hasToken: boolean,
): Msg {
  if ('error' in result) {
    if (result.error instanceof HttpTimeoutError) {
      return { message: `${host} did not answer in time. Check the server address and try again.`, tone: 'error' };
    }
    return { message: `Could not reach ${host}. Check the server address and your connection.`, tone: 'error' };
  }
  const code = result.status;
  if (code >= 200 && code < 300) {
    return {
      message: `Test push sent to ${host}. It should reach your phone within a few seconds if the ntfy app is subscribed to this topic.`,
      tone: 'ok',
    };
  }
  if (code === 401 || code === 403) {
    return hasToken
      ? { message: 'The server refused the token. Check the token and that it may write to this topic.', tone: 'error' }
      : {
          message:
            'The server refused the push: it needs an access token that may write to this topic. Paste one under Access token.',
          tone: 'error',
        };
  }
  if (code === 429) return { message: `${host} is limiting requests (HTTP 429). Wait a minute and try again.`, tone: 'error' };
  if (code >= 500) return { message: `${host} had a problem (HTTP ${String(code)}). Try again later.`, tone: 'error' };
  if (code === 404) {
    return { message: `${host} answered "not found" (HTTP 404). Check that the address is an ntfy server.`, tone: 'error' };
  }
  return { message: `${host} did not accept the test push (HTTP ${String(code)}).`, tone: 'error' };
}

export function NtfySection(props: NtfySectionProps): VNode {
  const { client } = props;
  const [api] = useState(() => props.permissions ?? new BrowserPermissions());
  const [http] = useState(() => props.http ?? new BrowserHttp());
  const [clock] = useState(() => props.clock ?? new BrowserClock());
  const [scheduled] = useState(() => props.scheduled ?? createNtfyScheduledStore());
  const [auth] = useState(() => props.auth ?? createNtfyAuthStore());
  const generate = props.generate ?? generateTopic;
  const firefox = props.firefox ?? isFirefox();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loadError, setLoadError] = useState('');
  const [granted, setGranted] = useState<Granted>('unknown');
  const [status, setStatus] = useState<Msg>({ message: '', tone: 'ok' });
  const [busy, setBusy] = useState(false);
  const [serverDraft, setServerDraft] = useState<string | null>(null);
  const [tokenDraft, setTokenDraft] = useState('');
  const [tokenTail, setTokenTail] = useState<string | null>(null);
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
    // T-70c: the calendar toggle elsewhere on the page changes what this section says.
    const offSettings = onSettingsSaved(() => {
      client.send('settings.get', undefined).then(
        (s) => {
          if (!cancelled) setSettings(s);
        },
        () => {
          /* keep the settings already shown */
        },
      );
    });
    void auth.load().then(
      (view) => {
        if (!cancelled) setTokenTail(view.tokenTail);
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
      offSettings();
    };
  }, [client, auth]);

  const savedServer = settings?.ntfy?.server ?? NTFY_SERVER;
  const serverValid = isAllowedServer(savedServer);
  const pattern = serverValid ? serverPermissionPattern(savedServer) : null;

  // The host permission follows the saved server.
  useEffect(() => {
    if (pattern === null) {
      setGranted('no');
      return;
    }
    let cancelled = false;
    setGranted('unknown');
    api
      .contains({ origins: [pattern] })
      .then((ok) => {
        if (!cancelled) setGranted(ok ? 'yes' : 'no');
      })
      .catch(() => {
        if (!cancelled) setGranted('no');
      });
    return () => {
      cancelled = true;
    };
  }, [api, pattern]);

  if (settings === null) {
    return loadError === '' ? <p>Loading your settings...</p> : <Status message={loadError} tone="error" />;
  }
  const ntfy: NtfyGroup = settings.ntfy ?? { enabled: false, server: NTFY_SERVER, topic: '' };
  const host = serverValid ? serverHost(ntfy.server) : 'the server';

  /** Saves the group (restoring the old one on failure) and resolves with the line to show. */
  const persist = (next: NtfyGroup, what: string, mask: boolean): Promise<Msg & { saved: boolean }> => {
    const previous = settings;
    setSettings({ ...settings, ntfy: next });
    return client.send('settings.set', { ntfy: next }).then(
      () => ({ saved: true, message: `Saved: ${mask ? maskTopic(next.topic) : what}.`, tone: 'ok' as const }),
      (e: unknown) => {
        setSettings(previous);
        return { saved: false, message: `Could not save ${what}. ${describeError(e)}`, tone: 'error' as const };
      },
    );
  };

  const save = async (next: NtfyGroup, what: string, mask = false): Promise<boolean> => {
    const { message, tone, saved } = await persist(next, what, mask);
    setStatus({ message, tone });
    return saved;
  };

  // Cancel while the old server, topic, token and host permission are still in
  // force. The sink refuses every request once the setting is saved off (R2),
  // so the DELETEs have to happen here, before `sbw:ntfy` is cleared and before save.
  const cancelCurrent = async (current: NtfyGroup): Promise<boolean> => {
    const state = await scheduled.load();
    if (!hasScheduled(state)) return true;
    if (!current.enabled || !isAllowedServer(current.server) || !isValidTopic(current.topic)) return false;
    try {
      if (!(await api.contains({ origins: [serverPermissionPattern(current.server)] }))) return false;
    } catch {
      return false;
    }
    const result = await cancelScheduledMessages({
      server: current.server,
      topic: current.topic,
      token: await auth.token(),
      state,
      http,
      clock,
      ...(props.minIntervalMs === undefined ? {} : { minIntervalMs: props.minIntervalMs }),
    });
    return result.ok;
  };

  /** Runs one change at a time, with the controls disabled while it runs. */
  const exclusive = (fn: () => Promise<void>): void => {
    if (retiring.current) return;
    retiring.current = true;
    setBusy(true);
    void (async () => {
      try {
        await fn();
      } catch (e) {
        setStatus({ message: `Something went wrong. ${describeError(e)}`, tone: 'error' });
      } finally {
        retiring.current = false;
        setBusy(false);
      }
    })();
  };

  /** Cancel on the current server/topic, then clear `sbw:ntfy`. False when a cancel did not finish. */
  const retire = async (current: NtfyGroup): Promise<boolean> => {
    try {
      const ok = await cancelCurrent(current);
      if (ok) await scheduled.clear();
      return ok;
    } catch {
      return false;
    }
  };

  const applyChange = (current: NtfyGroup, next: NtfyGroup, what: string, mask: boolean, forceSave: boolean): void => {
    exclusive(async () => {
      if (await retire(current)) {
        await save(next, what, mask);
      } else if (forceSave) {
        // Turning off still turns off (the sink makes no request once it is saved off).
        const result = await persist(next, what, mask);
        setStatus({
          message: result.saved ? `Phone push is off. ${MAY_STILL_ARRIVE}` : `${result.message} ${MAY_STILL_ARRIVE}`,
          tone: 'error',
        });
      } else {
        setStatus({ message: TOPIC_KEPT, tone: 'error' });
      }
    });
  };

  // T-123: a new server. While phone push is on, the pushes on the old server
  // are cancelled first, and a failed cancel keeps the old server. While it is
  // off nothing is sent; entries left from a forced turn-off carry the old
  // server's tag, so they are never taken as scheduled on the new one.
  const saveServer = (): void => {
    const parsed = parseServer(serverDraft ?? ntfy.server);
    if (!parsed.ok) {
      setStatus({ message: parsed.message, tone: 'error' });
      return;
    }
    if (parsed.origin === ntfy.server) {
      setServerDraft(null);
      setStatus({ message: `${serverHost(parsed.origin)} is already the server.`, tone: 'ok' });
      return;
    }
    const next = { ...ntfy, server: parsed.origin };
    const what = `the server ${serverHost(parsed.origin)}`;
    exclusive(async () => {
      if (ntfy.enabled && !(await retire(ntfy))) {
        setStatus({ message: SERVER_KEPT, tone: 'error' });
        return;
      }
      if (await save(next, what)) setServerDraft(null);
    });
  };

  // T-123: a new token, or none. While phone push is on, the scheduled pushes
  // are cancelled with the OLD token first. Unlike a topic or server change the
  // token is saved even if that cancel fails: server and topic are unchanged,
  // so the new token's publishes reuse the same seqs and replace them.
  const changeToken = (next: string | undefined): void => {
    exclusive(async () => {
      let note = '';
      if (ntfy.enabled) {
        const state = await scheduled.load().catch((): NtfyState => ({ items: {} }));
        if (hasScheduled(state)) {
          const ok = await cancelCurrent(ntfy).catch(() => false);
          if (!ok) note = ` ${TOKEN_NOT_CANCELLED}`;
          await scheduled.clear();
        }
      }
      try {
        if (next === undefined) await auth.remove();
        else await auth.save(next);
      } catch (e) {
        setStatus({ message: `Could not save the access token. ${describeError(e)}${note}`, tone: 'error' });
        return;
      }
      setTokenDraft('');
      setTokenTail(next === undefined ? null : next.slice(-4));
      setStatus({
        message: next === undefined ? `Removed the access token.${note}` : `Saved the access token ${maskToken(next.slice(-4))}.${note}`,
        tone: note === '' ? 'ok' : 'error',
      });
    });
  };

  const saveToken = (): void => {
    const parsed = normalizeToken(tokenDraft);
    if (!parsed.ok) {
      setStatus({ message: parsed.message, tone: 'error' });
      return;
    }
    changeToken(parsed.token);
  };

  const sendTestPush = (): void => {
    if (settings.killSwitch) {
      setStatus({ message: 'The kill switch is on, so nothing is sent. Turn it off to send a test push.', tone: 'error' });
      return;
    }
    if (!serverValid || !isValidTopic(ntfy.topic)) {
      setStatus({ message: 'Generate a topic and save a valid server first.', tone: 'error' });
      return;
    }
    const target = { server: ntfy.server, topic: ntfy.topic };
    exclusive(async () => {
      const allowed = await api.contains({ origins: [serverPermissionPattern(target.server)] }).catch(() => false);
      if (!allowed) {
        setStatus({ message: `Allow ${host} first (see Permission below).`, tone: 'error' });
        return;
      }
      const token = await auth.token();
      let result: { status: number } | { error: unknown };
      try {
        result = { status: (await http.send(testPushRequest({ ...target, token }))).status };
      } catch (e) {
        result = { error: e };
      }
      setStatus(describeTestPush(result, host, token !== undefined));
    });
  };

  // The permission prompt needs the click's gesture (I-21): the request is the
  // first thing that happens, before any await.
  const allow = (): void => {
    if (pattern === null) return;
    let pending: Promise<boolean>;
    try {
      pending = api.request({ origins: [pattern] });
    } catch (e) {
      setStatus({ message: `Could not ask for ${host} access. ${describeError(e)}`, tone: 'error' });
      return;
    }
    void pending.then(
      (ok) => {
        if (ok) {
          setGranted('yes');
          setStatus({ message: `${host} access is allowed.`, tone: 'ok' });
        } else {
          setGranted('no');
          setStatus({ message: `The browser did not allow ${host}. Nothing was changed.`, tone: 'error' });
        }
      },
      (e: unknown) => {
        setStatus({ message: `Could not ask for ${host} access. ${describeError(e)}`, tone: 'error' });
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
          label="Phone push (ntfy)"
          hint="Sends the auction end reminders (60, 15 and 5 minutes before) to your phone through ntfy."
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
        {ntfy.enabled ? (
          <Switch
            id="ntfy-alerts"
            label="Also send snipe alerts (won, lost, not sent, at risk, reconnect) to this topic"
            hint="Sent at once, even during quiet hours, so an alert reaches your phone while you sleep."
            checked={ntfy.alerts !== false}
            disabled={busy}
            onChange={(v) => {
              if (retiring.current) return;
              void save({ ...ntfy, alerts: v }, 'snipe alerts');
            }}
          />
        ) : null}
        <p class="sbw-hint">Auction titles and end times are sent to {host}.</p>
        {firefox ? (
          <p class="sbw-hint">
            On Firefox, ShopBadwill declares this as optional <code>technicalAndInteraction</code> data collection: the
            auction titles and end times above, sent only while phone push is on.
          </p>
        ) : null}
        {ntfy.enabled && !settings.calendar.enabled ? (
          <Status
            message="Calendar events are off, so no new pushes are scheduled: phone push follows the auctions calendar sync tracks. Turn them on in the Google Calendar section."
            tone="error"
          />
        ) : null}
        {ntfy.enabled && settings.dryRun.calendar ? (
          <p class="sbw-warn">
            While “Dry run: calendar” is on, no phone pushes are sent: phone push follows calendar sync, which only
            practises in dry run. Turn it off in the Settings section.
          </p>
        ) : null}
        {serverValid ? null : (
          <Status
            message="The saved server is not a valid https address, so phone push cannot use it. Enter one under Server."
            tone="error"
          />
        )}
      </Card>
      <Card>
        <h3>Server</h3>
        <p class="sbw-hint">
          https://ntfy.sh, or your own ntfy server (https only). For a self-hosted server, see docs/SETUP-NTFY.md.
        </p>
        <Field id="ntfy-server" label="Server">
          {(c) => (
            <input
              {...c}
              type="url"
              value={serverDraft ?? ntfy.server}
              disabled={busy}
              autocomplete="off"
              spellcheck={false}
              onInput={(e) => {
                setServerDraft(e.currentTarget.value);
              }}
            />
          )}
        </Field>
        <button type="button" disabled={busy} onClick={saveServer}>
          Save server
        </button>
        <Field
          id="ntfy-token"
          label="Access token (optional)"
          hint="Only for a server that needs one (made with ntfy token add). It stays on this computer, and only its last 4 characters are shown."
        >
          {(c) => (
            <input
              {...c}
              type="password"
              value={tokenDraft}
              disabled={busy}
              autocomplete="off"
              spellcheck={false}
              placeholder={tokenTail === null ? '' : `Saved: ${maskToken(tokenTail)}`}
              onInput={(e) => {
                setTokenDraft(e.currentTarget.value);
              }}
            />
          )}
        </Field>
        {tokenTail === null ? null : <p>Saved token: {maskToken(tokenTail)}</p>}
        <button type="button" disabled={busy || tokenDraft.trim() === ''} onClick={saveToken}>
          Save token
        </button>
        {tokenTail === null ? null : (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              changeToken(undefined);
            }}
          >
            Remove token
          </button>
        )}
      </Card>
      {ntfy.enabled && serverValid ? (
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
          <button type="button" onClick={sendTestPush} disabled={ntfy.topic === '' || busy}>
            Send a test push
          </button>
        </Card>
      ) : null}
      {ntfy.enabled && serverValid ? (
        <Card>
          <h3>Permission</h3>
          {granted === 'yes' ? (
            <p>ShopBadwill may reach {host}.</p>
          ) : (
            <>
              <p>
                Sending the reminders needs access to {host}, which your browser asks for separately. Until you allow
                it, nothing is sent.
              </p>
              <button type="button" onClick={allow}>
                Allow {host}
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
