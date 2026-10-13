import type { VNode } from 'preact';
import { formatDual, relative } from '../../domain/time/pacific';

/** Dual Pacific/user-zone time, e.g. "7:18 PM PT · 10:18 PM ET". Text only. */
export function PacificTime(props: { ms: number; userTz: string }): VNode<{ dateTime: string; children: string }> {
  return <time dateTime={new Date(props.ms).toISOString()}>{formatDual(props.ms, props.userTz)}</time>;
}

/** Relative time, e.g. "in 2h 5m". The caller supplies `now` so it can re-render on its own tick. */
export function RelativeTime(props: { ms: number; now: number }): VNode<{ dateTime: string; children: string }> {
  return <time dateTime={new Date(props.ms).toISOString()}>{relative(props.ms, props.now)}</time>;
}
