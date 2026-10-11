import type { ComponentChildren, VNode } from 'preact';

/** Attributes a control must spread to be wired to its label, hint and error. */
export interface FieldControlProps {
  id: string;
  'aria-describedby': string | undefined;
  'aria-invalid': true | undefined;
}

export interface FieldProps {
  /** Unique within the page; becomes the control's id. */
  id: string;
  label: string;
  hint?: string;
  /** Shown as text with an "Error:" prefix, so it never relies on colour. */
  error?: string | undefined;
  children: (control: FieldControlProps) => VNode;
}

/** A label, optional hint and optional error around one control. */
export function Field(props: FieldProps): VNode {
  const hintId = `${props.id}-hint`;
  const errorId = `${props.id}-error`;
  const describedBy = [props.hint === undefined ? '' : hintId, props.error === undefined ? '' : errorId]
    .filter((s) => s !== '')
    .join(' ');
  return (
    <div class={props.error === undefined ? 'sbw-field' : 'sbw-field sbw-field-invalid'}>
      <label for={props.id}>{props.label}</label>
      {props.children({
        id: props.id,
        'aria-describedby': describedBy === '' ? undefined : describedBy,
        'aria-invalid': props.error === undefined ? undefined : true,
      })}
      {props.hint === undefined ? null : (
        <p class="sbw-hint" id={hintId}>
          {props.hint}
        </p>
      )}
      {props.error === undefined ? null : (
        <p class="sbw-error" id={errorId}>
          <strong>Error:</strong> {props.error}
        </p>
      )}
    </div>
  );
}

/** A bordered group of related content. */
export function Card(props: { children: ComponentChildren; class?: string }): VNode {
  return <div class={props.class === undefined ? 'sbw-card' : `sbw-card ${props.class}`}>{props.children}</div>;
}
