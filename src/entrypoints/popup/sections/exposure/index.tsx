// T-102 (I-06): the popup's exposure section — the one live-bidding surface
// in the popup. It mounts T-85's exposure meter (R4, never a fork) and shows
// the live gate: the dry-run progress, the soak's on-time rate, the honest
// copy (R5) and the go-live flow with the typed confirmation.
//
// The background gate (src/background/handlers/live-gate.ts) is the authority;
// everything here is convenience (R1). Going live with an on-time rate below
// 95% sends the typed confirmation over the gate's port and then settings.set;
// at >= 95% it sends settings.set directly (the gate allows it). Turning the
// dry run back on is one click, no confirmation (R2). A vetoed settings.set is
// shown as the gate's own message.
import type { JSX } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import { browser } from 'wxt/browser';

import { FIRST_LIVE_CHECKLIST_URL, GO_LIVE_CONFIRMATION, LIVE_GATE_PORT, ON_TIME_RATE_MIN } from '../../../../background/handlers/live-gate';
import { formatMoney } from '../../../../domain/money';
import type { Settings } from '../../../../domain/settings/schema';
import { soakSummary } from '../../../../domain/snipe/soak';
import type { Snipe } from '../../../../domain/snipe/types';
import type { EpochMs } from '../../../../domain/types';
import { describeError } from '../../../../ui/components/describeError';
import { ExposureMeter, measureExposure } from '../../../../ui/exposure';
import { Money } from '../../../../ui/money';
import type { PopupSection, SectionProps } from '../../registry';
import './exposure.css';

/** How long the section waits for the gate's port reply before giving up. */
const HANDSHAKE_TIMEOUT_MS = 2000;

/** The slice of runtime.Port the section needs. */
export interface LiveGatePortLike {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(l: (message: unknown) => void): void; removeListener(l: (message: unknown) => void): void };
}

export interface ExposureSectionProps extends SectionProps {
  /** Injectable for tests; the default opens browser.runtime.connect on the gate's port. */
  connectPort?: (name: string) => LiveGatePortLike | undefined;
  now?: () => EpochMs;
}

const defaultConnectPort = (name: string): LiveGatePortLike | undefined => {
  try {
    return browser.runtime.connect({ name });
  } catch {
    return undefined;
  }
};

export function ExposureSection(props: ExposureSectionProps): JSX.Element {
  const { messaging } = props;
  const connectPort = props.connectPort ?? defaultConnectPort;
  const now = props.now ?? Date.now;
  const [settings, setSettings] = useState<Settings | null | 'unavailable'>(null);
  // 'unavailable': snipe.list failed, so the exposure is unknown (never shown as $0).
  const [snipes, setSnipes] = useState<Snipe[] | 'unavailable'>([]);
  const [confirming, setConfirming] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    const [s, list] = await Promise.allSettled([
      messaging.send('settings.get', undefined),
      messaging.send('snipe.list', undefined),
    ]);
    setSettings(s.status === 'fulfilled' ? s.value : 'unavailable');
    setSnipes(list.status === 'fulfilled' ? list.value : 'unavailable');
  }, [messaging]);

  useEffect(() => {
    void load();
  }, [load]);

  if (settings === null) {
    return (
      <section class="exposure" aria-label="Live bidding" data-testid="exposure-section">
        <p class="muted">Checking live bidding…</p>
      </section>
    );
  }
  if (settings === 'unavailable') {
    return (
      <section class="exposure" aria-label="Live bidding" data-testid="exposure-section">
        <p class="muted">Live-bidding status is unavailable right now.</p>
      </section>
    );
  }
  const s = settings;
  // Without the snipes the soak has no fires (rate 0), so going live asks for
  // the typed confirmation: the safe side.
  const soak = soakSummary(snipes === 'unavailable' ? [] : snipes);
  const meter = snipes === 'unavailable' ? null : measureExposure(snipes, now(), s.locale.timeZone);
  const detail =
    meter === null
      ? ''
      : [
          `${String(meter.open.count)} armed`,
          meter.open.shippingUnknown ? 'some shipping is unknown and counts as zero' : '',
          meter.spentToday > 0 ? `${formatMoney(meter.spentToday)} spent or unconfirmed today` : '',
        ]
          .filter((t) => t !== '')
          .join(' · ');
  const left = Math.max(0, s.snipe.requiredDryRuns - s.snipe.completedDryRuns);
  const needsTyped = soak.onTimeRate < ON_TIME_RATE_MIN;

  /** Sends the typed confirmation over the gate's port and waits for its ok. */
  const sendConfirmation = (typed: string): Promise<boolean> => {
    const port = connectPort(LIVE_GATE_PORT);
    if (port === undefined) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        globalThis.clearTimeout(timer);
        try {
          port.disconnect();
        } catch {
          // the background may already have closed it
        }
        resolve(ok);
      };
      const timer = globalThis.setTimeout(() => {
        finish(false);
      }, HANDSHAKE_TIMEOUT_MS);
      port.onMessage.addListener((m) => {
        const ok = typeof m === 'object' && m !== null && (m as { ok?: unknown }).ok === true;
        finish(ok);
      });
      try {
        port.postMessage({ confirmation: typed });
      } catch {
        finish(false);
      }
    });
  };

  const goLive = async (typed: string | undefined): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      if (typed !== undefined) {
        const ok = await sendConfirmation(typed);
        if (!ok) {
          setError(`The background did not accept the confirmation. Type ${GO_LIVE_CONFIRMATION} exactly and try again.`);
          return;
        }
      }
      try {
        await messaging.send('settings.set', { dryRun: { ...s.dryRun, bidding: false } });
        setConfirming(false);
        setConfirmText('');
        await load();
      } catch (e) {
        setError(describeError(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const submit = (): void => {
    if (busy) return;
    if (needsTyped && confirmText !== GO_LIVE_CONFIRMATION) {
      setError('That is not the confirmation text. Type GO LIVE exactly.');
      return;
    }
    void goLive(needsTyped ? confirmText : undefined);
  };

  const dryRunAgain = (): void => {
    setError('');
    void (async () => {
      try {
        await messaging.send('settings.set', { dryRun: { ...s.dryRun, bidding: true } });
        setConfirming(false);
        await load();
      } catch (e) {
        setError(describeError(e));
      }
    })();
  };

  return (
    <section class="exposure" aria-label="Live bidding" data-testid="exposure-section">
      {meter === null ? (
        <p class="muted">Exposure is unavailable right now: the snipes could not be read.</p>
      ) : (
        <ExposureMeter used={meter.used} cap={s.snipe.caps.perDayMax} detail={detail === '' ? undefined : detail} />
      )}

      <p class="exposure-state">
        <span class={s.dryRun.bidding ? 'badge dry' : 'badge live'} data-testid="bidding-state" data-state={s.dryRun.bidding ? 'dry' : 'live'}>
          Bidding: {s.dryRun.bidding ? 'Dry run' : 'LIVE'}
        </span>
      </p>
      <p class="muted">
        {String(s.snipe.completedDryRuns)} of {String(s.snipe.requiredDryRuns)} dry-run snipes completed
        {soak.firesAttempted > 0
          ? ` · ${String(Math.round(soak.onTimeRate * 100))}% on time (${String(soak.onTime)} of ${String(soak.firesAttempted)} fires)`
          : ''}
      </p>

      {s.dryRun.bidding ? (
        left > 0 ? (
          <p class="hint">
            Complete {String(left)} more dry-run {left === 1 ? 'snipe' : 'snipes'} before going live.
          </p>
        ) : confirming ? (
          <div class="exposure-confirm" role="group" aria-label="Confirm going live">
            <p>
              Live bids are real money: at most <Money cents={s.snipe.caps.perItemMax} /> for one item and{' '}
              <Money cents={s.snipe.caps.perDayMax} /> per day. ShopGoodwill's terms may forbid automated bidding.
            </p>
            <p class="hint">
              Read the{' '}
              <a href={FIRST_LIVE_CHECKLIST_URL} target="_blank" rel="noopener noreferrer">
                first live snipe checklist
              </a>{' '}
              before your first live snipe.
            </p>
            {needsTyped ? (
              <label class="exposure-field" for="exposure-confirm">
                Type GO LIVE to confirm
                <input
                  id="exposure-confirm"
                  type="text"
                  autoComplete="off"
                  spellcheck={false}
                  value={confirmText}
                  onInput={(e) => {
                    setConfirmText(e.currentTarget.value);
                  }}
                />
              </label>
            ) : null}
            <div class="exposure-actions">
              <button type="button" disabled={busy} onClick={submit}>
                Go live
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setConfirming(false);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            class="exposure-go"
            onClick={() => {
              setError('');
              setConfirming(true);
            }}
          >
            Go live…
          </button>
        )
      ) : (
        <button type="button" class="exposure-go" onClick={dryRunAgain}>
          Dry run again
        </button>
      )}

      {error !== '' ? (
        <p class="exposure-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

export const section: PopupSection = { id: 'exposure', order: 20, Component: ExposureSection };
