import type { VNode } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';

import { MessagingError } from '../../messaging/errors';
import { describeError } from '../components/describeError';

export type Load<T> =
  | { kind: 'loading' }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string }
  | { kind: 'ok'; value: T };

/** A missing background handler (or a reply that does not match what this build expects) is "unavailable" (a parallel card may not have landed), not an error. */
export function toLoadFailure(e: unknown): Load<never> {
  if (e instanceof MessagingError && (e.code === 'no_handler' || e.code === 'unknown_type' || e.code === 'bad_reply')) return { kind: 'unavailable' };
  return { kind: 'error', message: describeError(e) };
}

/** Runs `fetch` on mount and on `reload()`. */
export function useLoad<T>(fetch: () => Promise<T>, deps: readonly unknown[]): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ kind: 'loading' });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    fetch().then(
      (value) => {
        if (live) setState({ kind: 'ok', value });
      },
      (e: unknown) => {
        if (live) setState(toLoadFailure(e));
      },
    );
    return () => {
      live = false;
    };
  }, [...deps, tick]);
  const reload = useCallback(() => {
    setTick((n) => n + 1);
  }, []);
  return [state, reload];
}

/** Non-ok states of a Load, or null when the value is ready. */
export function LoadNotice(props: { state: Load<unknown>; what: string }): VNode | null {
  const s = props.state;
  switch (s.kind) {
    case 'loading':
      return <p class="sbw-muted">Loading {props.what}…</p>;
    case 'unavailable':
      return <p class="sbw-muted">{props.what} is unavailable right now (the background has not enabled it yet).</p>;
    case 'error':
      return (
        <p role="alert" class="sbw-error">
          <strong>Problem: </strong>Could not load {props.what}. {s.message}
        </p>
      );
    case 'ok':
      return null;
  }
}

export function ErrorAlert(props: { message: string }): VNode | null {
  return props.message === '' ? null : (
    <p role="alert" class="sbw-error">
      <strong>Problem: </strong>
      {props.message}
    </p>
  );
}
