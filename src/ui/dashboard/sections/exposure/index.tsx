// T-102 (I-06): the dashboard's exposure section — a display-only mount of
// T-85's exposure meter (R4, never a fork) beside the live gate's status: the
// dry-run progress, the soak's on-time rate, and the honest copy with the
// "first live snipe" checklist link (R5). The go-live action with the typed
// confirmation lives in the popup section and the options page; the background
// gate (src/background/handlers/live-gate.ts) is the authority either way (R1).
import type { VNode } from 'preact';

import { FIRST_LIVE_CHECKLIST_URL } from '../../../../background/handlers/live-gate';
import { formatMoney } from '../../../../domain/money';
import { soakSummary } from '../../../../domain/snipe/soak';
import { ExposureMeter, measureExposure } from '../../../exposure';
import { Money } from '../../../money';
import { LoadNotice, useLoad } from '../../parts';
import type { SectionDef, SectionProps } from '../../registry';

export function ExposureSection(props: SectionProps): VNode {
  const { client } = props;
  const [settings] = useLoad(() => client.send('settings.get', undefined), [client]);
  const [snipes] = useLoad(() => client.send('snipe.list', undefined), [client]);

  if (settings.kind !== 'ok') {
    return (
      <div data-testid="exposure-section">
        <p class="sbw-muted">Live bidding is unavailable right now.</p>
      </div>
    );
  }
  const s = settings.value;
  const list = snipes.kind === 'ok' ? snipes.value : [];
  const soak = soakSummary(list);
  const meter = measureExposure(list, Date.now(), s.locale.timeZone);
  const detail = [
    `${String(meter.open.count)} armed`,
    meter.spentToday > 0 ? `${formatMoney(meter.spentToday)} spent or unconfirmed today` : '',
  ]
    .filter((t) => t !== '')
    .join(' · ');
  const left = Math.max(0, s.snipe.requiredDryRuns - s.snipe.completedDryRuns);

  return (
    <div data-testid="exposure-section">
      {snipes.kind !== 'ok' ? <LoadNotice state={snipes} what="snipes" /> : null}

      <ExposureMeter used={meter.used} cap={s.snipe.caps.perDayMax} detail={detail === '' ? undefined : detail} />

      <p>
        <span class="sbw-tag" data-testid="bidding-state" data-state={s.dryRun.bidding ? 'dry' : 'live'}>
          Bidding: {s.dryRun.bidding ? 'Dry run' : 'LIVE'}
        </span>
      </p>
      <p class="sbw-muted">
        {String(s.snipe.completedDryRuns)} of {String(s.snipe.requiredDryRuns)} dry-run snipes completed
        {soak.firesAttempted > 0
          ? ` · ${String(Math.round(soak.onTimeRate * 100))}% on time (${String(soak.onTime)} of ${String(soak.firesAttempted)} fires)`
          : ''}
      </p>

      {s.dryRun.bidding ? (
        <>
          {left > 0 ? (
            <p class="sbw-warn">
              Live bidding is locked: complete {String(left)} more dry-run {left === 1 ? 'snipe' : 'snipes'} first. Go live from the
              popup once the count is met.
            </p>
          ) : null}
          <p>
            Live bids are real money: at most <Money cents={s.snipe.caps.perItemMax} /> for one item and{' '}
            <Money cents={s.snipe.caps.perDayMax} /> per day. ShopGoodwill's terms may forbid automated bidding.
          </p>
          <p class="sbw-muted">
            Read the{' '}
            <a href={FIRST_LIVE_CHECKLIST_URL} target="_blank" rel="noopener noreferrer">
              first live snipe checklist
            </a>{' '}
            before your first live snipe.
          </p>
        </>
      ) : (
        <p class="sbw-warn">Live bidding is on: armed snipes can place real bids. Turn the dry run back on in the popup or options.</p>
      )}
    </div>
  );
}

export const section: SectionDef = { id: 'exposure', title: 'Exposure', order: 34, Component: ExposureSection };
