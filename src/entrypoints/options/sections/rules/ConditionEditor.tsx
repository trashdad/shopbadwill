import type { VNode } from 'preact';

import { Field } from '../../../../ui/components/Field';
import { KIND_LABELS, type ConditionDraft, type DraftError, type DraftGroup, type KeywordField } from './draft';

export interface ConditionEditorProps {
  group: DraftGroup;
  index: number;
  draft: ConditionDraft;
  errors: readonly DraftError[];
  onChange: (patch: Partial<ConditionDraft>) => void;
  onRemove: () => void;
}

const KEYWORD_FIELDS: readonly { value: KeywordField; label: string }[] = [
  { value: 'title', label: 'Title' },
  { value: 'category', label: 'Category' },
  { value: 'seller', label: 'Seller name' },
];

/** One condition: a fieldset with a legend, so screen readers announce which condition each control belongs to. */
export function ConditionEditor(props: ConditionEditorProps): VNode {
  const { draft: d, group } = props;
  const base = `cond-${group}-${String(d.key)}`;
  const errorFor = (field: string): string | undefined =>
    props.errors.find((e) => e.path === `${group}.${String(d.key)}.${field}`)?.message;
  const title = `${group === 'all' ? 'Condition' : 'Alternative'} ${String(props.index + 1)}: ${KIND_LABELS[d.kind]}`;

  const range = (minLabel: string, maxLabel: string, hint?: string): VNode => (
    <div class="sbw-row">
      <Field id={`${base}-min`} label={minLabel} {...(hint === undefined ? {} : { hint })} error={errorFor('min')}>
        {(c) => (
          <input
            {...c}
            type="text"
            inputMode="decimal"
            value={d.min}
            onInput={(e) => {
              props.onChange({ min: e.currentTarget.value });
            }}
          />
        )}
      </Field>
      <Field id={`${base}-max`} label={maxLabel} error={errorFor('max')}>
        {(c) => (
          <input
            {...c}
            type="text"
            inputMode="decimal"
            value={d.max}
            onInput={(e) => {
              props.onChange({ max: e.currentTarget.value });
            }}
          />
        )}
      </Field>
    </div>
  );

  const modeSelect = (options: readonly [string, string][], label: string): VNode => (
    <Field id={`${base}-mode`} label={label}>
      {(c) => (
        <select
          {...c}
          value={d.mode}
          onChange={(e) => {
            props.onChange({ mode: e.currentTarget.value });
          }}
        >
          {options.map(([value, text]) => (
            <option key={value} value={value}>
              {text}
            </option>
          ))}
        </select>
      )}
    </Field>
  );

  let body: VNode;
  switch (d.kind) {
    case 'keyword':
      body = (
        <>
          {modeSelect(
            [
              ['any', 'Matches any of the terms'],
              ['all', 'Matches all of the terms'],
              ['none', 'Matches none of the terms'],
            ],
            'Match',
          )}
          <Field
            id={`${base}-terms`}
            label="Terms (one per line)"
            hint="Case does not matter. Accents and look-alike characters are normalised."
            error={errorFor('terms')}
          >
            {(c) => (
              <textarea
                {...c}
                rows={3}
                value={d.terms}
                onInput={(e) => {
                  props.onChange({ terms: e.currentTarget.value });
                }}
              />
            )}
          </Field>
          <div class="sbw-checks">
            <label>
              <input
                type="checkbox"
                checked={d.wholeWord}
                onChange={(e) => {
                  props.onChange({ wholeWord: e.currentTarget.checked });
                }}
              />{' '}
              Whole words only
            </label>
            <label>
              <input
                type="checkbox"
                checked={d.regex}
                onChange={(e) => {
                  props.onChange({ regex: e.currentTarget.checked });
                }}
              />{' '}
              Terms are regular expressions
            </label>
          </div>
          <fieldset class="sbw-inline-fieldset" aria-describedby={errorFor('fields') === undefined ? undefined : `${base}-fields-error`}>
            <legend>Look in</legend>
            {KEYWORD_FIELDS.map((f) => (
              <label key={f.value}>
                <input
                  type="checkbox"
                  checked={d.fields.includes(f.value)}
                  onChange={(e) => {
                    const on = e.currentTarget.checked;
                    props.onChange({
                      fields: on ? [...d.fields.filter((x) => x !== f.value), f.value] : d.fields.filter((x) => x !== f.value),
                    });
                  }}
                />{' '}
                {f.label}
              </label>
            ))}
            {errorFor('fields') === undefined ? null : (
              <p class="sbw-error" id={`${base}-fields-error`}>
                <strong>Error:</strong> {errorFor('fields')}
              </p>
            )}
          </fieldset>
        </>
      );
      break;
    case 'price':
      body = range('Minimum price ($)', 'Maximum price ($)', 'Leave a box empty for no limit.');
      break;
    case 'landedCost':
      body = (
        <>
          {range('Minimum total ($)', 'Maximum total ($)', 'Bid plus shipping and handling to your ZIP. Needs the landed-cost feature in Settings.')}
        </>
      );
      break;
    case 'seller':
      body = (
        <>
          {modeSelect(
            [
              ['exclude', 'Seller is not one of these'],
              ['include', 'Seller is one of these'],
            ],
            'Match',
          )}
          <Field id={`${base}-names`} label="Seller names (one per line)" error={errorFor('sellerNames')}>
            {(c) => (
              <textarea
                {...c}
                rows={2}
                value={d.sellerNames}
                onInput={(e) => {
                  props.onChange({ sellerNames: e.currentTarget.value });
                }}
              />
            )}
          </Field>
          <Field id={`${base}-ids`} label="Seller numbers (comma separated)" error={errorFor('sellerIds')}>
            {(c) => (
              <input
                {...c}
                type="text"
                value={d.sellerIds}
                onInput={(e) => {
                  props.onChange({ sellerIds: e.currentTarget.value });
                }}
              />
            )}
          </Field>
        </>
      );
      break;
    case 'location':
      body = (
        <>
          {modeSelect(
            [
              ['exclude', 'Seller is not in these states'],
              ['include', 'Seller is in these states'],
            ],
            'Match',
          )}
          <Field id={`${base}-states`} label="States (two letters, comma separated)" hint="For example: OH, PA" error={errorFor('states')}>
            {(c) => (
              <input
                {...c}
                type="text"
                value={d.states}
                onInput={(e) => {
                  props.onChange({ states: e.currentTarget.value });
                }}
              />
            )}
          </Field>
        </>
      );
      break;
    case 'category':
      body = (
        <>
          <Field id={`${base}-cats`} label="Category numbers (comma separated)" error={errorFor('categoryIds')}>
            {(c) => (
              <input
                {...c}
                type="text"
                value={d.categoryIds}
                onInput={(e) => {
                  props.onChange({ categoryIds: e.currentTarget.value });
                }}
              />
            )}
          </Field>
          <div class="sbw-checks">
            <label>
              <input
                type="checkbox"
                checked={d.includeChildren}
                onChange={(e) => {
                  props.onChange({ includeChildren: e.currentTarget.checked });
                }}
              />{' '}
              Include subcategories
            </label>
          </div>
        </>
      );
      break;
    case 'endsWithin':
      body = range('Ends no sooner than (minutes from now)', 'Ends within (minutes from now)', 'For example 60 for one hour, 1440 for one day.');
      break;
    case 'bidCount':
      body = range('At least this many bids', 'At most this many bids', 'Use 0 as the maximum for listings with no bids.');
      break;
    case 'pickupOnly':
      body = (
        <Field id={`${base}-pickup`} label="Listing is">
          {(c) => (
            <select
              {...c}
              value={d.pickup ? 'yes' : 'no'}
              onChange={(e) => {
                props.onChange({ pickup: e.currentTarget.value === 'yes' });
              }}
            >
              <option value="yes">Pickup only</option>
              <option value="no">Can be shipped</option>
            </select>
          )}
        </Field>
      );
      break;
  }

  return (
    <fieldset class="sbw-condition" id={base}>
      <legend>{title}</legend>
      {body}
      <button type="button" class="sbw-secondary" aria-label={`Remove ${title}`} onClick={props.onRemove}>
        Remove
      </button>
    </fieldset>
  );
}
