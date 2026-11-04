import type { VNode } from 'preact';

export interface SwitchProps {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

/** An on/off setting. The state is also written out ("On"/"Off"), never colour alone. */
export function Switch(props: SwitchProps): VNode {
  const hintId = `${props.id}-hint`;
  return (
    <div class="sbw-switch">
      <input
        id={props.id}
        type="checkbox"
        role="switch"
        checked={props.checked}
        disabled={props.disabled === true}
        aria-describedby={props.hint === undefined ? undefined : hintId}
        onChange={(e) => {
          props.onChange(e.currentTarget.checked);
        }}
      />
      <label for={props.id}>{props.label}</label>
      <span class="sbw-switch-state" aria-hidden="true">
        {props.checked ? 'On' : 'Off'}
      </span>
      {props.hint === undefined ? null : (
        <p class="sbw-hint" id={hintId}>
          {props.hint}
        </p>
      )}
    </div>
  );
}
