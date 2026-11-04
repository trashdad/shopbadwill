// T-112: arm a snipe INTO a bid group. The same path as the Snipes section's
// form (T-85): `snipe.prepare`, the local money guards, a confirmation, then
// `snipe.arm` with the group's id in `snipe.groupId`. The background re-checks
// everything at arm (caps, the typo guard, the kill switch) and the group's own
// rules (ends 2 min apart, one mode, not frozen, N not reached): its refusal
// is shown as it comes. Amounts are integer cents through src/domain/money.ts.
// Text only. Field ids carry the group id, so several forms never share an id.
import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { formatMoney, parseCents } from '../../../../domain/money';
import { checkCaps, confirmsAmount, spentToday, typoCheck } from '../../../../domain/snipe/caps';
import type { Snipe } from '../../../../domain/snipe/types';
import type { Settings } from '../../../../domain/settings/schema';
import type { Cents } from '../../../../domain/types';
import type { MsgReply } from '../../../../messaging/protocol';
import type { MessagingClient } from '../../../../ports/messaging';
import { describeError } from '../../../components/describeError';
import { Field } from '../../../components/Field';
import { Status } from '../../../components/Status';
import { ErrorAlert } from '../../parts';
import { DRY_RUN_LABEL, DRY_RUN_OPTION } from '../snipes/arm-form';
import { formatEndDual } from '../snipes/end-time';

type PrepareReply = MsgReply<'snipe.prepare'>;

interface Planned {
  maxBid: Cents;
  leadMs: number;
  fallback: Snipe['fallback'];
  dryRun: boolean;
  needsTypo: boolean;
  typoPrompt?: string;
}

export interface GroupArmFormProps {
  client: MessagingClient;
  groupId: string;
  groupName: string;
  userTz: string;
  settings: Settings | null;
  /** Every stored snipe: the caps count all of them (a group never raises a cap). */
  snipes: readonly Snipe[];
  onArmed: () => void;
}

function newSnipeId(itemId: number): string {
  return `sn-${String(itemId)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function GroupArmForm(props: GroupArmFormProps): VNode {
  const { client, settings } = props;
  const idp = `grp-${props.groupId}`;
  const [stage, setStage] = useState<'idle' | 'preparing' | 'ready' | 'confirm'>('idle');
  const [itemIdText, setItemIdText] = useState('');
  const [prep, setPrep] = useState<PrepareReply | null>(null);
  const [amount, setAmount] = useState('');
  const [leadS, setLeadS] = useState('');
  const [fallback, setFallback] = useState<Snipe['fallback']>('skip');
  const [dryRun, setDryRun] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [planned, setPlanned] = useState<Planned | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [error, setError] = useState('');
  const [arming, setArming] = useState(false);
  const [status, setStatus] = useState('');
  const defaulted = useRef(false);

  useEffect(() => {
    if (settings === null || defaulted.current) return;
    defaulted.current = true;
    setLeadS(String(Math.round(settings.snipe.defaultLeadMs / 1000)));
    setFallback(settings.snipe.defaultFallback);
    setDryRun(settings.dryRun.bidding);
  }, [settings]);

  const effectiveDryRun = settings?.dryRun.bidding === true || dryRun;
  const d = prep?.detail;

  const prepare = (): void => {
    const id = Number(itemIdText.replace(/\D/g, ''));
    if (!Number.isSafeInteger(id) || id <= 0) {
      setError('Enter the shopgoodwill.com item number first.');
      return;
    }
    setStage('preparing');
    setError('');
    setProblems([]);
    setPlanned(null);
    setAmount('');
    setConfirmText('');
    client.send('snipe.prepare', { itemId: id }).then(
      (reply) => {
        setPrep(reply);
        setStage('ready');
      },
      (e: unknown) => {
        setPrep(null);
        setStage('idle');
        setError(`Could not prepare the item. ${describeError(e)}`);
      },
    );
  };

  const review = (): void => {
    if (settings === null || d === undefined) return;
    const found: string[] = [];
    const maxBid = parseCents(amount);
    if (maxBid === null || maxBid <= 0) found.push('Enter the max bid in dollars, e.g. 12.50.');
    const lead = Number(leadS);
    const leadMs = Math.round(lead * 1000);
    if (!Number.isInteger(lead) || leadMs < 3000 || leadMs > 30000) found.push('The lead must be a whole number of seconds from 3 to 30.');
    if (found.length > 0 || maxBid === null) {
      setProblems(found);
      return;
    }
    const now = Date.now();
    const draft: Snipe = {
      id: '__group-check__',
      itemId: d.itemId,
      title: d.title,
      endTime: d.endTime,
      endTimeAtArm: d.endTime,
      sellerId: d.sellerId,
      maxBid,
      ...(d.shippingPrice === null || d.shippingPrice === undefined ? {} : { estShipping: d.shippingPrice }),
      ...(d.handlingPrice === undefined ? {} : { estHandling: d.handlingPrice }),
      leadMs,
      fallback,
      dryRun: effectiveDryRun,
      state: 'draft',
      armedAt: now,
      attempt: {},
      groupId: props.groupId,
      history: [],
    };
    // Every member counts in full against the caps: a group never raises one.
    const tz = settings.locale.timeZone;
    const caps = checkCaps(draft, props.snipes, spentToday(props.snipes, now, tz), settings.snipe.caps, d, tz);
    if (!caps.ok) {
      setProblems(caps.violations);
      return;
    }
    setProblems([]);
    const typo = typoCheck(maxBid, d, settings.snipe.caps);
    setPlanned({
      maxBid,
      leadMs,
      fallback,
      dryRun: effectiveDryRun,
      needsTypo: typo.needsConfirmation,
      ...(typo.prompt === undefined ? {} : { typoPrompt: typo.prompt }),
    });
    setConfirmText('');
    setStage('confirm');
  };

  const arm = (): void => {
    const p = planned;
    if (p === null || d === undefined || arming) return;
    const typed = p.needsTypo ? confirmText.trim() : undefined;
    if (p.needsTypo && !confirmsAmount(typed ?? '', p.maxBid)) return;
    setError('');
    setArming(true);
    const snipe = {
      id: newSnipeId(d.itemId),
      itemId: d.itemId,
      title: d.title,
      endTime: d.endTime,
      endTimeAtArm: d.endTime,
      sellerId: d.sellerId,
      maxBid: p.maxBid,
      ...(d.shippingPrice === null || d.shippingPrice === undefined ? {} : { estShipping: d.shippingPrice }),
      ...(d.handlingPrice === undefined ? {} : { estHandling: d.handlingPrice }),
      leadMs: p.leadMs,
      fallback: p.fallback,
      dryRun: p.dryRun,
      attempt: {},
      groupId: props.groupId,
    };
    client.send('snipe.arm', { snipe, ...(typed === undefined ? {} : { typedConfirmation: typed }) }).then(
      (armed) => {
        setArming(false);
        setStatus(`Snipe armed in "${props.groupName}".${armed.dryRun ? ` ${DRY_RUN_LABEL}.` : ''}`);
        setPrep(null);
        setPlanned(null);
        setAmount('');
        setItemIdText('');
        setStage('idle');
        props.onArmed();
      },
      (e: unknown) => {
        setArming(false);
        setError(describeError(e));
      },
    );
  };

  const endMs = d === undefined ? undefined : new Date(d.endTime).getTime();
  const typoProblem =
    planned?.needsTypo === true && confirmText.trim() !== '' && !confirmsAmount(confirmText, planned.maxBid)
      ? 'That is not the amount. Type the exact max to confirm.'
      : undefined;

  return (
    <div class="sbw-arm">
      <h4>Add an item to "{props.groupName}"</h4>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          prepare();
        }}
      >
        <Field id={`${idp}-item`} label="Item id" hint="The shopgoodwill.com item number. It must end at least 2 minutes from the group's other items.">
          {(c) => (
            <input
              {...c}
              type="text"
              inputMode="numeric"
              value={itemIdText}
              onInput={(e) => {
                setItemIdText((e.target as HTMLInputElement).value);
              }}
            />
          )}
        </Field>
        <p>
          <button type="button" disabled={stage === 'preparing'} onClick={prepare}>
            Prepare
          </button>
        </p>
      </form>
      {stage === 'preparing' ? <p class="sbw-muted">Preparing…</p> : null}

      {stage === 'ready' && d !== undefined && endMs !== undefined ? (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            review();
          }}
        >
          <p>{d.title}</p>
          <ul class="sbw-list">
            <li>Next acceptable bid: {formatMoney(d.minimumBid)}</li>
            <li>Ends {formatEndDual(endMs, props.userTz)}</li>
          </ul>
          <Field id={`${idp}-max`} label="Max bid ($)" hint="Whole dollars and cents, e.g. 25.00.">
            {(c) => (
              <input
                {...c}
                type="text"
                inputMode="decimal"
                value={amount}
                onInput={(e) => {
                  setAmount((e.target as HTMLInputElement).value);
                }}
              />
            )}
          </Field>
          <Field id={`${idp}-lead`} label="Lead (seconds)" hint="How long before the end the bid fires; 3–30.">
            {(c) => (
              <input
                {...c}
                type="number"
                min={3}
                max={30}
                value={leadS}
                onInput={(e) => {
                  setLeadS((e.target as HTMLInputElement).value);
                }}
              />
            )}
          </Field>
          <Field id={`${idp}-fallback`} label="If the snipe cannot fire">
            {(c) => (
              <select
                {...c}
                value={fallback}
                onChange={(e) => {
                  setFallback((e.target as HTMLSelectElement).value as Snipe['fallback']);
                }}
              >
                <option value="early-proxy">Place the max as an early proxy bid</option>
                <option value="skip">Skip the item</option>
              </select>
            )}
          </Field>
          <p>
            <label>
              <input
                type="checkbox"
                checked={effectiveDryRun}
                disabled={settings?.dryRun.bidding === true}
                onChange={(e) => {
                  setDryRun((e.target as HTMLInputElement).checked);
                }}
              />{' '}
              {DRY_RUN_OPTION}
            </label>
          </p>
          {effectiveDryRun ? <p class="sbw-warn">{DRY_RUN_LABEL}</p> : null}
          {problems.length > 0 ? (
            <div role="alert" class="sbw-error">
              <strong>Problem: </strong>
              <ul>
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <p>
            <button type="button" onClick={review}>
              Review and arm
            </button>
          </p>
        </form>
      ) : null}

      {stage === 'confirm' && planned !== null && d !== undefined && endMs !== undefined ? (
        <div class="sbw-confirm">
          <h4>Review the snipe</h4>
          <ul class="sbw-list">
            <li>Item: {d.title}</li>
            <li>Max bid: {formatMoney(planned.maxBid)}</li>
            <li>Ends {formatEndDual(endMs, props.userTz)}</li>
            <li>Lead: {String(Math.round(planned.leadMs / 1000))} seconds</li>
            <li>If the snipe cannot fire: {planned.fallback === 'early-proxy' ? 'place the max as an early proxy bid' : 'skip the item'}</li>
            <li>Bid group: {props.groupName}. This max counts in full against your caps.</li>
          </ul>
          {planned.dryRun ? <p class="sbw-warn">{DRY_RUN_LABEL}</p> : null}
          {planned.needsTypo ? (
            <>
              <p class="sbw-warn">{planned.typoPrompt}</p>
              <Field id={`${idp}-confirm`} label="Type the amount to confirm" error={typoProblem}>
                {(c) => (
                  <input
                    {...c}
                    type="text"
                    inputMode="decimal"
                    value={confirmText}
                    onInput={(e) => {
                      setConfirmText((e.target as HTMLInputElement).value);
                    }}
                  />
                )}
              </Field>
            </>
          ) : null}
          <p>
            <button
              type="button"
              class="sbw-secondary"
              disabled={arming}
              onClick={() => {
                setStage('ready');
                setError('');
              }}
            >
              Back
            </button>{' '}
            <button
              type="button"
              disabled={arming || (planned.needsTypo && !confirmsAmount(confirmText.trim(), planned.maxBid))}
              onClick={arm}
            >
              Arm in group
            </button>
          </p>
        </div>
      ) : null}
      <ErrorAlert message={error} />
      <Status message={status} />
    </div>
  );
}
