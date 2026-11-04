import type { VNode } from 'preact';
import { formatMoney } from '../../domain/money';
import type { Cents } from '../../domain/types';

/** A price as text, "$1,299.50"; null/undefined (unknown, e.g. calculated shipping) shows an em dash. */
export function Money(props: { cents: Cents | null | undefined }): VNode<{ class: string; children: string }> {
  return (
    <span class="sbw-money">{props.cents === null || props.cents === undefined ? '—' : formatMoney(props.cents)}</span>
  );
}
