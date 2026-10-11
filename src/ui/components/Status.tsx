import type { VNode } from 'preact';

/** A polite live region. It stays in the DOM even when empty so screen readers announce changes. */
export function Status(props: { message: string; tone?: 'ok' | 'error' }): VNode {
  return (
    <p class="sbw-status" role="status" aria-live="polite" data-tone={props.tone ?? 'ok'}>
      {props.message !== '' && props.tone === 'error' ? <strong>Problem: </strong> : null}
      {props.message}
    </p>
  );
}
