import type { VNode } from 'preact';

import type { Lane, SgwSessionState } from '../../../../domain/types';
import type { MsgReply } from '../../../../messaging/protocol';
import { PacificTime } from '../../../time';
import { LoadNotice, useLoad } from '../../parts';
import type { SectionDef, SectionProps } from '../../registry';

type Health = MsgReply<'health.get'>;

const DRIFT_CHECKS = new Set(['search-schema', 'detail-schema', 'card-selectors']);
const LANES: readonly Lane[] = ['interactive', 'background', 'snipe', 'canary'];

function Session(props: { state: SgwSessionState; expiresAt: number | null; tz: string }): VNode {
  const time = props.expiresAt === null ? null : <PacificTime ms={props.expiresAt} userTz={props.tz} />;
  switch (props.state) {
    case 'ok':
      return <p>Signed in to ShopGoodwill{time === null ? '.' : <>. Sign-in lasts until {time}.</>}</p>;
    case 'expiring':
      return (
        <p class="sbw-warn">Your ShopGoodwill sign-in expires {time ?? 'soon'}. Sign in on shopgoodwill.com to renew it.</p>
      );
    case 'expired':
      return <p class="sbw-warn">ShopGoodwill rejected your sign-in. Sign in again on shopgoodwill.com.</p>;
    case 'logged-out':
      return <p>Not signed in to ShopGoodwill.</p>;
  }
}

function Google(props: { google: Health['google'] }): VNode {
  const g = props.google;
  if (!g.configured) return <p>Google Calendar is not set up.</p>;
  if (!g.connected) return <p class="sbw-warn">Google is not connected.</p>;
  if (g.needsInteraction) return <p class="sbw-warn">Google needs you to sign in again.</p>;
  return <p>Google connected{g.account === undefined ? '' : ` as ${g.account}`}.</p>;
}

function Body(props: { health: Health; tz: string }): VNode {
  const h = props.health;
  const drift = (h.sgw?.checks ?? []).filter((c) => DRIFT_CHECKS.has(c.name) && !c.ok);
  const sticky = h.sticky ?? [];
  const paused = h.budget.paused;
  return (
    <>
      <h3>Session</h3>
      <Session state={h.sessionState} expiresAt={h.session} tz={props.tz} />
      <h3>Google</h3>
      <Google google={h.google} />
      <h3>Site changes</h3>
      {h.sgw === null ? (
        <p class="sbw-muted">No health check has run yet.</p>
      ) : drift.length === 0 && sticky.length === 0 ? (
        <p>
          No problems seen. Last checked <PacificTime ms={h.sgw.checkedAt} userTz={props.tz} />.
        </p>
      ) : null}
      {drift.length > 0 ? (
        <ul class="sbw-warn">
          {drift.map((c) => (
            <li key={c.name}>
              {c.name} failed{c.detail === undefined ? '' : `: ${c.detail}`}
            </li>
          ))}
        </ul>
      ) : null}
      {sticky.length > 0 ? (
        <ul class="sbw-warn">
          {sticky.map((x) => (
            <li key={x.endpoint}>
              {x.endpoint} (<PacificTime ms={x.at} userTz={props.tz} />): {x.detail}. Blocks{' '}
              {x.features.length >= 3 ? 'all features' : x.features.join(', ')}.
            </li>
          ))}
        </ul>
      ) : null}
      <h3>Request budget today</h3>
      <ul>
        {LANES.map((lane) => {
          const l = h.budget.lanes[lane];
          return (
            <li key={lane}>
              {lane}: {l.usedToday} / {l.budget}
            </li>
          );
        })}
      </ul>
      {paused === undefined ? null : (
        <p class="sbw-warn">
          Requests paused
          {paused.until === null ? null : (
            <>
              {' '}
              until <PacificTime ms={paused.until} userTz={props.tz} />
            </>
          )}
          {paused.reason === '' ? '' : `: ${paused.reason}`}
        </p>
      )}
    </>
  );
}

export function HealthSection(props: SectionProps): VNode {
  const { client } = props;
  const [health] = useLoad(() => client.send('health.get', undefined), [client]);
  return (
    <div>
      <LoadNotice state={health} what="health" />
      {health.kind === 'ok' ? <Body health={health.value} tz={props.userTz} /> : null}
      <p>
        <button
          type="button"
          class="sbw-secondary"
          onClick={() => {
            props.openOptions('health');
          }}
        >
          Open Health options
        </button>{' '}
        <span class="sbw-muted">Resume and other actions are there.</span>
      </p>
    </div>
  );
}

export const section: SectionDef = { id: 'health', title: 'Health', order: 30, Component: HealthSection };
