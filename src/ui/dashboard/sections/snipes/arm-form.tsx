// T-85: prepare → arm (R2, R3). `snipe.prepare` fills the item detail, the
// next acceptable bid and the estimated all-in; the arm form sends
// `snipe.arm` only after the money guards pass locally, with the exact shapes
// the T-84 handler and runner expect. Amounts are integer cents throughout,
// parsed and formatted with src/domain/money.ts — never float math.
//
// Money-safety guards (R3), all in the domain:
//   - checkCaps: no submit above the per-item cap, the daily cap remaining, or
//     the open-exposure cap (the background re-checks the same rules at arm);
//   - typoCheck / confirmsAmount: an amount far above the current price (the
//     domain rule: over 3x the current price or over the absolute threshold)
//     requires retyping the exact max;
//   - the confirmation shows the max, the estimated all-in (with shipping and
//     handling when known) and the end time in both zones;
//   - a dry-run snipe carries the DRY RUN label everywhere it appears.
import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { allInToBid, formatMoney, parseCents } from '../../../../domain/money';
import { checkCaps, confirmsAmount, spentToday, typoCheck } from '../../../../domain/snipe/caps';
import type { Snipe } from '../../../../domain/snipe/types';
import type { Settings } from '../../../../domain/settings/schema';
import type { Cents, ItemId } from '../../../../domain/types';
import type { MsgReply } from '../../../../messaging/protocol';
import type { MessagingClient } from '../../../../ports/messaging';
import { describeError } from '../../../components/describeError';
import { Field } from '../../../components/Field';
import { Status } from '../../../components/Status';
import { Money } from '../../../money';
import { PacificTime } from '../../../time';
import { ErrorAlert } from '../../parts';

/** R3: the exact label a dry-run snipe carries everywhere it appears. */
export const DRY_RUN_LABEL = 'DRY RUN — no bid will be placed';
/** The dry-run checkbox text. */
export const DRY_RUN_OPTION = 'Dry run (no bid will be placed)';

type PrepareReply = MsgReply<'snipe.prepare'>;
type Stage = 'idle' | 'preparing' | 'ready' | 'confirm';

/** What the user confirmed: everything `snipe.arm` needs, recomputed at arm time. */
interface PlannedArm {
  itemId: ItemId;
  title: string;
  endTime: string;
  maxBid: Cents;
  allInMax?: Cents;
  estShipping?: Cents;
  estHandling?: Cents;
  leadMs: number;
  fallback: Snipe['fallback'];
  dryRun: boolean;
  needsTypo: boolean;
  typoPrompt?: string;
}

export interface ArmFormProps {
  client: MessagingClient;
  userTz: string;
  /** Settings, or null while they load. */
  settings: Settings | null;
  /** The stored snipes (spent-today and committed snipes feed the caps). */
  snipes: readonly Snipe[];
  /** The deep link (ui.openSnipe): prepare this item. */
  openItem: ItemId | null;
  /** Called after a successful arm so the section reloads its list. */
  onArmed: () => void;
}

const isKnownShipping = (d: PrepareReply['detail']): d is PrepareReply['detail'] & { shippingPrice: Cents } =>
  d.shippingPrice !== null && d.shippingPrice !== undefined;

/** The all-in for the user's max: max + known shipping + known handling; null when shipping is unknown. */
function allInFor(detail: PrepareReply['detail'], maxBid: Cents): Cents | null {
  if (!isKnownShipping(detail)) return null;
  return maxBid + detail.shippingPrice + (detail.handlingPrice ?? 0);
}

function snipeId(itemId: ItemId): string {
  return `sn-${String(itemId)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Cap lines from checkCaps. Anything else (a bad lead, an unparsed amount) is not one. */
function isCapLine(problem: string): boolean {
  return /^(per-item|per-day|exposure|invalid):/.test(problem);
}

/**
 * Violations that make a submit impossible: per-item, the daily cap still
 * remaining (this bid's max plus known shipping and handling, on top of what
 * is already spent), and open exposure. Empty when the amount is not yet a
 * positive bid. Integer cents only, through the domain.
 */
function capViolations(
  amount: string,
  mode: 'max' | 'all-in',
  detail: PrepareReply['detail'] | undefined,
  settings: Settings | null,
  snipes: readonly Snipe[],
  dryRun: boolean,
): string[] {
  if (settings === null || detail === undefined) return [];
  const cents = parseCents(amount);
  if (cents === null) return [];
  const maxBid = mode === 'all-in' ? allInToBid(cents, detail.shippingPrice ?? null, detail.handlingPrice ?? null) : cents;
  if (maxBid <= 0) return [];
  const estShipping = isKnownShipping(detail) ? detail.shippingPrice : undefined;
  const estHandling = detail.handlingPrice;
  const now = Date.now();
  const draft: Snipe = {
    id: '__cap-check__',
    itemId: detail.itemId,
    title: detail.title,
    endTime: detail.endTime,
    endTimeAtArm: detail.endTime,
    sellerId: detail.sellerId,
    maxBid,
    ...(estShipping !== undefined ? { estShipping } : {}),
    ...(estHandling !== undefined ? { estHandling } : {}),
    leadMs: settings.snipe.defaultLeadMs,
    fallback: settings.snipe.defaultFallback,
    dryRun,
    state: 'draft',
    armedAt: now,
    attempt: {},
    history: [],
  };
  return checkCaps(
    draft,
    snipes,
    spentToday(snipes, now, settings.locale.timeZone),
    settings.snipe.caps,
    detail,
    settings.locale.timeZone,
  ).violations;
}

export function ArmForm(props: ArmFormProps): VNode {
  const { client, settings } = props;
  const [stage, setStage] = useState<Stage>('idle');
  const [itemIdText, setItemIdText] = useState('');
  const [prep, setPrep] = useState<PrepareReply | null>(null);
  const [prepError, setPrepError] = useState('');
  const [mode, setMode] = useState<'max' | 'all-in'>('max');
  const [amount, setAmount] = useState('');
  const [leadS, setLeadS] = useState('');
  const [fallback, setFallback] = useState<Snipe['fallback'] | null>(null);
  const [dryRun, setDryRun] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const [planned, setPlanned] = useState<PlannedArm | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [armError, setArmError] = useState('');
  const [arming, setArming] = useState(false);
  const [status, setStatus] = useState('');
  const defaultsApplied = useRef(false);

  // Form defaults come from the settings once they load (and are not re-applied over user edits).
  useEffect(() => {
    if (settings === null || defaultsApplied.current) return;
    defaultsApplied.current = true;
    setLeadS(String(Math.round(settings.snipe.defaultLeadMs / 1000)));
    setFallback(settings.snipe.defaultFallback);
    setDryRun(settings.dryRun.bidding);
  }, [settings]);

  // The deep link: pre-fill the item and prepare it. Never arms (R1, R2).
  useEffect(() => {
    if (props.openItem !== null) {
      setItemIdText(String(props.openItem));
      void prepare(props.openItem);
    }
  }, [props.openItem]);

  const effectiveDryRun = settings?.dryRun.bidding === true || dryRun;

  const prepare = async (id: ItemId): Promise<void> => {
    setStage('preparing');
    setPrepError('');
    setArmError('');
    setProblems([]);
    setPlanned(null);
    setAmount('');
    setConfirmText('');
    try {
      const reply = await client.send('snipe.prepare', { itemId: id });
      setPrep(reply);
      setStage('ready');
    } catch (e) {
      setPrep(null);
      setStage('idle');
      setPrepError(`Could not prepare the item. ${describeError(e)}`);
    }
  };

  const prepareFromInput = (): void => {
    const id = Number(itemIdText.replace(/\D/g, ''));
    if (!Number.isSafeInteger(id) || id <= 0) {
      setPrepError('Enter the shopgoodwill.com item number first.');
      return;
    }
    void prepare(id);
  };

  /** Runs the local money guards; on success moves to the confirmation step. */
  const review = (): void => {
    const s = settings;
    const d = prep?.detail;
    if (s === null || d === undefined) return;
    // Caps refuse here, not only via the disabled button. Enter in the field
    // submits the form even when that button is disabled.
    const blocked = capViolations(amount, mode, d, s, props.snipes, effectiveDryRun);
    if (blocked.length > 0) {
      setProblems(blocked);
      return;
    }
    setProblems([]);
    const found: string[] = [];
    const cents = parseCents(amount);
    let maxBid: Cents | null = null;
    let allInMax: Cents | undefined;
    if (cents === null) {
      found.push('Enter the max in dollars, e.g. 12.50.');
    } else {
      if (mode === 'all-in') {
        allInMax = cents;
        maxBid = allInToBid(cents, d.shippingPrice ?? null, d.handlingPrice ?? null);
      } else {
        maxBid = cents;
      }
      if (maxBid <= 0) found.push('The max bid must be more than zero.');
    }
    const lead = Number(leadS);
    const leadMs = Math.round(lead * 1000);
    if (!Number.isInteger(lead) || leadMs < 3000 || leadMs > 30000) {
      found.push('The lead must be a whole number of seconds from 3 to 30.');
    }
    if (maxBid !== null && maxBid > 0 && Number.isInteger(lead) && leadMs >= 3000 && leadMs <= 30000 && fallback !== null) {
      const estShipping = isKnownShipping(d) ? d.shippingPrice : undefined;
      const estHandling = d.handlingPrice;
      const now = Date.now();
      const draft: Snipe = {
        id: snipeId(d.itemId),
        itemId: d.itemId,
        title: d.title,
        endTime: d.endTime,
        endTimeAtArm: d.endTime,
        sellerId: d.sellerId,
        maxBid,
        ...(allInMax !== undefined ? { allInMax } : {}),
        ...(estShipping !== undefined ? { estShipping } : {}),
        ...(estHandling !== undefined ? { estHandling } : {}),
        leadMs,
        fallback,
        dryRun: effectiveDryRun,
        state: 'draft',
        armedAt: now,
        attempt: {},
        history: [],
      };
      const caps = checkCaps(draft, props.snipes, spentToday(props.snipes, now, s.locale.timeZone), s.snipe.caps, d, s.locale.timeZone);
      found.push(...caps.violations);
      if (caps.ok) {
        const typo = typoCheck(maxBid, d, s.snipe.caps);
        setPlanned({
          itemId: d.itemId,
          title: d.title,
          endTime: d.endTime,
          maxBid,
          ...(allInMax !== undefined ? { allInMax } : {}),
          ...(estShipping !== undefined ? { estShipping } : {}),
          ...(estHandling !== undefined ? { estHandling } : {}),
          leadMs,
          fallback,
          dryRun: effectiveDryRun,
          needsTypo: typo.needsConfirmation,
          ...(typo.prompt !== undefined ? { typoPrompt: typo.prompt } : {}),
        });
        setConfirmText('');
        setStage('confirm');
        return;
      }
    }
    setProblems(found);
  };

  const arm = (): void => {
    const p = planned;
    const d = prep?.detail;
    if (p === null || d === undefined || arming) return;
    setArmError('');
    const typed = p.needsTypo ? confirmText.trim() : undefined;
    // The button is disabled until the retyped text is the max to the cent.
    // Refuse here too: a click that bypasses `disabled` must not send.
    if (p.needsTypo && !confirmsAmount(typed ?? '', p.maxBid)) return;
    const payload = {
      id: snipeId(p.itemId),
      itemId: p.itemId,
      title: p.title,
      endTime: p.endTime,
      endTimeAtArm: p.endTime,
      sellerId: d.sellerId,
      maxBid: p.maxBid,
      ...(p.allInMax !== undefined ? { allInMax: p.allInMax } : {}),
      ...(p.estShipping !== undefined ? { estShipping: p.estShipping } : {}),
      ...(p.estHandling !== undefined ? { estHandling: p.estHandling } : {}),
      leadMs: p.leadMs,
      fallback: p.fallback,
      dryRun: p.dryRun,
      attempt: {},
    };
    setArming(true);
    client
      .send('snipe.arm', { snipe: payload, ...(typed !== undefined ? { typedConfirmation: typed } : {}) })
      .then(
        (armedSnipe) => {
          setArming(false);
          setStatus(armedSnipe.dryRun ? `Snipe armed. ${DRY_RUN_LABEL}.` : 'Snipe armed.');
          setPrep(null);
          setPlanned(null);
          setAmount('');
          setConfirmText('');
          setStage('idle');
          props.onArmed();
        },
        (e: unknown) => {
          setArming(false);
          setArmError(describeError(e));
        },
      );
  };

  const d = prep?.detail;
  const endMs = d === undefined ? undefined : new Date(d.endTime).getTime();
  const blocked = capViolations(amount, mode, d, settings, props.snipes, effectiveDryRun);
  const shownProblems = [...blocked, ...problems.filter((p) => !isCapLine(p))];
  const typoProblem =
    planned?.needsTypo === true && confirmText.trim() !== '' && !confirmsAmount(confirmText, planned.maxBid)
      ? 'That is not the amount. Type the exact max to confirm.'
      : undefined;
  const armDisabled = arming || (planned?.needsTypo === true && !confirmsAmount(confirmText.trim(), planned.maxBid));
  const allInText =
    d === undefined || planned === null
      ? null
      : (() => {
          const total = allInFor(d, planned.maxBid);
          if (total === null) return 'unknown — shipping is calculated at checkout';
          const bits = [`max ${formatMoney(planned.maxBid)}`];
          if (isKnownShipping(d)) bits.push(`shipping ${formatMoney(d.shippingPrice)}`);
          if (d.handlingPrice !== undefined) bits.push(`handling ${formatMoney(d.handlingPrice)}`);
          return `${formatMoney(total)} (${bits.join(' + ')})`;
        })();

  return (
    <div class="sbw-arm">
      <h3>Snipe an item</h3>
      {settings?.snipe.enabled === false ? (
        <p class="sbw-warn">Sniping is turned off in the snipe settings; arming will be refused until it is on.</p>
      ) : null}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          prepareFromInput();
        }}
      >
        <Field id="snipe-item-id" label="Item id" hint="The shopgoodwill.com item number, e.g. 279250057.">
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
          <button
            type="button"
            disabled={stage === 'preparing'}
            onClick={() => {
              prepareFromInput();
            }}
          >
            Prepare
          </button>
        </p>
      </form>
      {stage === 'preparing' ? <p class="sbw-muted">Preparing…</p> : null}
      <ErrorAlert message={prepError} />

      {stage === 'ready' && d !== undefined && prep !== null ? (
        <div class="sbw-ready">
          <p>{d.title}</p>
          <ul class="sbw-list">
            <li>Next acceptable bid: <Money cents={d.minimumBid} /></li>
            <li>Current price: <Money cents={d.currentPrice} /></li>
            <li>
              Estimated all-in at the next acceptable bid:{' '}
              {prep.estAllIn === null ? 'unknown — shipping is calculated at checkout' : <Money cents={prep.estAllIn} />}
            </li>
            {endMs === undefined ? null : (
              <li>
                Ends <PacificTime ms={endMs} userTz={props.userTz} />
              </li>
            )}
          </ul>
          {prep.caps.ok ? null : (
            <p role="alert" class="sbw-error">
              <strong>Problem: </strong>
              {prep.caps.violations.join(' ')}
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              review();
            }}
          >
            <fieldset>
              <legend>Amount</legend>
              <p>
                <label>
                  <input
                    type="radio"
                    name="sbw-snipe-mode"
                    checked={mode === 'max'}
                    onChange={(e) => {
                      if ((e.target as HTMLInputElement).checked) setMode('max');
                    }}
                  />{' '}
                  Max bid
                </label>{' '}
                <label>
                  <input
                    type="radio"
                    name="sbw-snipe-mode"
                    checked={mode === 'all-in'}
                    onChange={(e) => {
                      if ((e.target as HTMLInputElement).checked) setMode('all-in');
                    }}
                  />{' '}
                  All-in max (the bid is the all-in minus shipping and handling)
                </label>
              </p>
              <Field
                id="snipe-amount"
                label={mode === 'max' ? 'Max bid ($)' : 'All-in max ($)'}
                hint="Whole dollars and cents, e.g. 25.00."
              >
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
            </fieldset>
            <Field id="snipe-lead" label="Lead (seconds)" hint="How long before the auction ends the bid fires; 3–30.">
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
            <Field id="snipe-fallback" label="If the snipe cannot fire">
              {(c) => (
                <select
                  {...c}
                  value={fallback ?? 'early-proxy'}
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
            {shownProblems.length > 0 ? (
              <div role="alert" class="sbw-error">
                <strong>Problem: </strong>
                <ul>
                  {shownProblems.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            <p>
              <button
                type="button"
                disabled={blocked.length > 0}
                onClick={() => {
                  review();
                }}
              >
                Review and arm
              </button>
            </p>
          </form>
        </div>
      ) : null}

      {stage === 'confirm' && planned !== null && d !== undefined && endMs !== undefined ? (
        <div class="sbw-confirm">
          <h3>Review your snipe</h3>
          <ul class="sbw-list">
            <li>Item: {planned.title}</li>
            <li>
              {planned.allInMax !== undefined
                ? `All-in max: ${formatMoney(planned.allInMax)}`
                : `Max bid: ${formatMoney(planned.maxBid)}`}
            </li>
            {planned.allInMax !== undefined ? (
              <li>Max bid (all-in minus shipping and handling): {formatMoney(planned.maxBid)}</li>
            ) : null}
            <li>Estimated all-in: {allInText}</li>
            <li>
              Ends <PacificTime ms={endMs} userTz={props.userTz} />
            </li>
            <li>Lead: {String(Math.round(planned.leadMs / 1000))} seconds</li>
            <li>
              If the snipe cannot fire: {planned.fallback === 'early-proxy' ? 'place the max as an early proxy bid' : 'skip the item'}
            </li>
          </ul>
          {planned.dryRun ? <p class="sbw-warn">{DRY_RUN_LABEL}</p> : null}
          {planned.needsTypo ? (
            <>
              <p class="sbw-warn">{planned.typoPrompt}</p>
              <Field id="snipe-confirm-amount" label="Type the amount to confirm" error={typoProblem}>
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
                setArmError('');
              }}
            >
              Back
            </button>{' '}
            <button
              type="button"
              disabled={armDisabled}
              onClick={() => {
                arm();
              }}
            >
              Arm snipe
            </button>
          </p>
          <ErrorAlert message={armError} />
        </div>
      ) : null}
      <Status message={status} />
    </div>
  );
}
