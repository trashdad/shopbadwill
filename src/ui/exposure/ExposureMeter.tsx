// T-85 (I-18): the one exposure meter, built once and mounted by the Snipes
// dashboard section now and by T-102 later. Text only, no browser APIs, no
// markup in content; amounts are integer cents formatted with src/domain/money.ts.
import type { VNode } from 'preact';

import { formatMoney } from '../../domain/money';
import type { Cents } from '../../domain/types';

export interface ExposureMeterProps {
  /** Cents committed against the daily cap: open exposure plus spent/unconfirmed today (see measureExposure). */
  used: Cents;
  /** The per-day cap in cents. */
  cap: Cents;
  /** Optional line describing what is counted (armed count, unknown shipping, unconfirmed spend). */
  detail?: string;
}

/** The meter: a bar against the daily cap and the numbers as text, with an "over by" warning. */
export function ExposureMeter(props: ExposureMeterProps): VNode {
  const cap = Math.max(0, Math.floor(props.cap));
  const used = Math.max(0, Math.floor(props.used));
  const over = used > cap;
  const pct = cap === 0 ? 0 : Math.min(100, Math.round((used / cap) * 100));
  return (
    <div class="sbw-exposure" data-over={over ? 'true' : 'false'}>
      <div
        role="progressbar"
        aria-label="Exposure against the daily cap"
        aria-valuemin={0}
        aria-valuemax={cap}
        aria-valuenow={Math.min(used, cap)}
      >
        <div class="sbw-bar" style={{ width: `${String(pct)}%` }} />
      </div>
      <p class={over ? 'sbw-error' : ''}>
        Exposure {formatMoney(used)} of {formatMoney(cap)}
        {over ? ` — over the daily cap by ${formatMoney(used - cap)}` : ''}
      </p>
      {props.detail === undefined || props.detail === '' ? null : <p class="sbw-muted">{props.detail}</p>}
    </div>
  );
}
