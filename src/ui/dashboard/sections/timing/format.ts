// T-90: display helpers for the Timing section. Pure text formatting: the page
// is text-only, no canvas, no innerHTML (R4).
import type { Snipe } from '../../../../domain/snipe/types';

/** 'not recorded' for a measurement that was never persisted (R3). */
export const NOT_RECORDED = 'not recorded';

/** A measured ms value with its sign: +150 ms, −1.20 s, 0 ms; null → 'not recorded'. */
export function formatMs(ms: number | null): string {
  if (ms === null) return NOT_RECORDED;
  const rounded = Math.round(ms);
  const sign = rounded > 0 ? '+' : '';
  if (Math.abs(rounded) < 1000) return `${sign}${String(rounded)} ms`;
  return `${sign}${(rounded / 1000).toFixed(2)} s`;
}

/** A plain lead (a setting, not a measurement): '8 s', '10.5 s'. */
export function formatLead(ms: number): string {
  return `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} s`;
}

/** The per-snipe table's "Snipe" label: a short id and a truncated title. */
export function snipeLabel(s: Snipe): string {
  const title = s.title.length > 40 ? `${s.title.slice(0, 39)}…` : s.title;
  const id = s.id.length > 12 ? `${s.id.slice(0, 11)}…` : s.id;
  return `${id} · ${title}`;
}
