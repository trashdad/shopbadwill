// Naive-Pacific <-> epoch helpers for the fake server (independent of src/).
const PT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function ptParts(ms: number): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const o: Record<string, number> = {};
  for (const p of PT.formatToParts(new Date(Math.floor(ms / 1000) * 1000))) {
    if (p.type !== 'literal') o[p.type] = Number(p.value);
  }
  return { y: o.year ?? 0, mo: o.month ?? 0, d: o.day ?? 0, h: o.hour ?? 0, mi: o.minute ?? 0, s: o.second ?? 0 };
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0');

/** Epoch ms -> naive Pacific "YYYY-MM-DDTHH:mm:ss" (withMillis adds ".SSS"). */
export function epochToPacificNaive(ms: number, withMillis: boolean): string {
  const p = ptParts(ms);
  const base = `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
  if (!withMillis) return base;
  return `${base}.${pad(((Math.floor(ms) % 1000) + 1000) % 1000, 3)}`;
}

function offsetAt(ms: number): number {
  const p = ptParts(ms);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ms / 1000) * 1000;
}

/** Naive Pacific string (optionally with fractional seconds) -> epoch ms. */
export function pacificNaiveToEpoch(raw: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(raw);
  if (!m) throw new Error(`bad naive Pacific time: ${raw}`);
  const [, y, mo, d, h, mi, s, frac] = m;
  const wall =
    Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)) +
    (frac === undefined ? 0 : Math.round(Number(`0.${frac}`) * 1000));
  const e0 = wall - offsetAt(wall);
  return wall - offsetAt(e0);
}
