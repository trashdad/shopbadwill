import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { Settings } from '../../../../domain/settings/schema';
import type { Lane, SgwSessionState } from '../../../../domain/types';
import type { MsgReply } from '../../../../messaging/protocol';
import { Card } from '../../../../ui/components/Field';
import { PacificTime } from '../../../../ui/time';
import type { SectionDef, SectionProps } from '../../registry';
import { ERROR_HINTS } from '../google/hints';

type Health = MsgReply<'health.get'>;
type Sticky = NonNullable<Health['sticky']>[number];
type Load<T> = { kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ok'; value: T };

const DRIFT_CHECKS = new Set(['search-schema', 'detail-schema', 'card-selectors']);
const LANES: readonly Lane[] = ['interactive', 'background', 'snipe', 'canary'];

const ACCOUNT_HINT =
  'Signed in as a different ShopGoodwill account? Disconnect first (the extension only accepts the account it already knows).';

function Session(props: { state: SgwSessionState; expiresAt: number | null; tz: string }): VNode {
  const time = props.expiresAt === null ? null : <PacificTime ms={props.expiresAt} userTz={props.tz} />;
  switch (props.state) {
    case 'ok':
      return <p>Signed in to ShopGoodwill{time === null ? '.' : <>. Sign-in lasts until {time}.</>}</p>;
    case 'expiring':
      return (
        <p class="sbw-warn">
          Your ShopGoodwill sign-in expires {time ?? 'soon'}. Sign in on shopgoodwill.com to renew it.
        </p>
      );
    case 'expired':
      return (
        <p class="sbw-warn">
          ShopGoodwill rejected your sign-in. Sign in again on shopgoodwill.com; armed snipes are at risk until you do.
        </p>
      );
    case 'logged-out':
      return <p>Not signed in to ShopGoodwill. Sign in on shopgoodwill.com so ShopBadwill can act for you.</p>;
  }
}

const featureLabel = (features: readonly string[]): string => (features.length >= 3 ? 'all features' : features.join(', '));

/**
 * T-30b: the sticky schema failures. Each has a "resume" button that asks first
 * (an inline alertdialog, Escape cancels, focus starts on Cancel) and only then
 * sends `health.clearSticky`. Stale, clock and session failures have no button:
 * they clear only through probes or real state.
 */
function StickyFailures(props: {
  items: readonly Sticky[];
  tz: string;
  resume: (endpoint: string) => Promise<void>;
}): VNode | null {
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (asking !== null) cancelRef.current?.focus();
  }, [asking]);
  if (props.items.length === 0) return null;

  const close = (): void => {
    setAsking(null);
    openerRef.current?.focus();
  };
  const confirm = (endpoint: string): void => {
    setBusy(true);
    setError(null);
    props.resume(endpoint).then(
      () => {
        setBusy(false);
        setAsking(null);
      },
      (e: unknown) => {
        setBusy(false);
        setAsking(null);
        setError(`Could not resume: ${e instanceof Error ? e.message : String(e)}`);
        openerRef.current?.focus();
      },
    );
  };

  return (
    <div>
      <p class="sbw-warn">
        ShopGoodwill sent a reply ShopBadwill did not understand. The affected features stay blocked until a good reply
        arrives, or until you have checked and choose to resume.
      </p>
      <ul>
        {props.items.map((x) => {
          const label = featureLabel(x.features);
          return (
            <li key={x.endpoint}>
              <strong>{x.endpoint}</strong> (<PacificTime ms={x.at} userTz={props.tz} />): {x.detail}. Blocks {label}.{' '}
              {asking === x.endpoint ? (
                <div
                  role="alertdialog"
                  aria-label={`Confirm resume ${label}`}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Escape') close();
                  }}
                >
                  <p>
                    Resume {label} without a good reply from {x.endpoint}? Only do this after checking that ShopGoodwill still works
                    for you.
                  </p>
                  <button type="button" ref={cancelRef} class="sbw-secondary" disabled={busy} onClick={close}>
                    Cancel
                  </button>{' '}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      confirm(x.endpoint);
                    }}
                  >
                    {`Yes, resume ${label}`}
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  class="sbw-secondary"
                  onClick={(ev) => {
                    openerRef.current = ev.currentTarget;
                    setAsking(x.endpoint);
                  }}
                >
                  {`I've checked; resume ${label}`}
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {error === null ? null : (
        <p class="sbw-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** The loading / unavailable placeholder, or null once there is a value. */
function pending(h: Load<unknown>): VNode | null {
  if (h.kind === 'loading') return <p>Checking...</p>;
  if (h.kind === 'unavailable') return <p>Unavailable right now.</p>;
  return null;
}

export function HealthSection(props: SectionProps): VNode {
  const { client } = props;
  const [health, setHealth] = useState<Load<Health>>({ kind: 'loading' });
  const [settings, setSettings] = useState<Load<Settings>>({ kind: 'loading' });

  const refreshRef = useRef<HTMLButtonElement>(null);
  const load = (): void => {
    setHealth({ kind: 'loading' });
    client.send('health.get', undefined).then(
      (value) => {
        setHealth({ kind: 'ok', value });
      },
      () => {
        // No handler yet (T-30/T-36), or the background is not answering.
        setHealth({ kind: 'unavailable' });
      },
    );
  };
  useEffect(() => {
    load();
    client.send('settings.get', undefined).then(
      (value) => {
        setSettings({ kind: 'ok', value });
      },
      () => {
        setSettings({ kind: 'unavailable' });
      },
    );
  }, [client]);

  const resume = async (endpoint: string): Promise<void> => {
    await client.send('health.clearSticky', { endpoint });
    load();
    // The resume button is gone after the reload: keep focus on a control that stays.
    refreshRef.current?.focus();
  };

  const tz = settings.kind === 'ok' ? settings.value.locale.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone;
  const h = health.kind === 'ok' ? health.value : null;

  return (
    <div class="sbw-health">
      <div class="sbw-actions">
        <button type="button" class="sbw-secondary" ref={refreshRef} onClick={load}>
          Refresh health
        </button>
      </div>

      <Card>
        <h3>ShopGoodwill sign-in</h3>
        {h === null ? pending(health) : <Session state={h.sessionState} expiresAt={h.session} tz={tz} />}
        <p class="sbw-hint">{ACCOUNT_HINT}</p>
      </Card>

      <Card>
        <h3>Google</h3>
        {h === null ? (
          pending(health)
        ) : (
          <p>
            {h.google.connected ? 'Connected' : 'Not connected'}
            {h.google.account === undefined ? null : <> as {h.google.account}</>}
            {h.google.needsInteraction ? '. Google needs you to sign in again (see Google Calendar above).' : '.'}
            {h.google.lastError === undefined ? null : <> Last error: {ERROR_HINTS[h.google.lastError]}</>}
          </p>
        )}
      </Card>

      <Card>
        <h3>Page changes (selector drift)</h3>
        {h === null ? (
          pending(health)
        ) : h.sgw === null ? (
          <p>No report yet. Open a ShopGoodwill page and check again.</p>
        ) : (
          (() => {
            const failing = h.sgw.checks.filter((c) => DRIFT_CHECKS.has(c.name) && !c.ok);
            return failing.length === 0 ? (
              <p>
                No drift detected (page rules {h.sgw.configVersion}, checked <PacificTime ms={h.sgw.checkedAt} userTz={tz} />).
              </p>
            ) : (
              <div>
                <p class="sbw-warn">
                  ShopGoodwill may have changed its pages. Some features may not work until ShopBadwill is updated.
                </p>
                <ul>
                  {failing.map((c) => (
                    <li key={c.name}>{c.detail === undefined ? c.name : `${c.name}: ${c.detail}`}</li>
                  ))}
                </ul>
              </div>
            );
          })()
        )}
      </Card>

      {h?.sticky === undefined || h.sticky.length === 0 ? null : (
        <Card>
          <h3>Blocked after an unexpected reply</h3>
          <StickyFailures items={h.sticky} tz={tz} resume={resume} />
        </Card>
      )}

      <Card>
        <h3>Request budget today</h3>
        {h === null ? (
          pending(health)
        ) : (
          <div>
            <dl class="sbw-caps">
              {LANES.map((lane) => {
                const l = h.budget.lanes[lane];
                return (
                  <div key={lane}>
                    <dt>{lane}</dt>
                    <dd>{`${String(l.usedToday)} of ${String(l.budget)} requests`}</dd>
                  </div>
                );
              })}
            </dl>
            {h.budget.paused === undefined ? null : (
              <p class="sbw-warn">Requests to ShopGoodwill are paused: {h.budget.paused.reason}</p>
            )}
          </div>
        )}
        <p>
          Considerate mode:{' '}
          <strong>
            {settings.kind === 'ok' ? (settings.value.considerateMode === 'tight' ? 'Tight' : 'Normal') : 'unavailable'}
          </strong>
        </p>
      </Card>
    </div>
  );
}

export const section: SectionDef = { id: 'health', title: 'Health', order: 26, Component: HealthSection };
