// SGW sends `endTime` as naive Pacific wall-clock time with no offset
// ("2026-10-07T19:18:30", sometimes "...:17.45"). It is converted with the IANA
// zone America/Los_Angeles through Intl.DateTimeFormat, never with the built-in
// string parser (ESLint bans it). No dependencies.

const PACIFIC = 'America/Los_Angeles';
const NAIVE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/;
const HOUR_MS = 3_600_000;

export interface PacificParse {
  /** Epoch milliseconds of the resolved instant. */
  ms: number;
  /** The wall time occurs twice (fall back); the earlier instant was chosen. */
  ambiguous: boolean;
  /** The wall time never happens (spring forward); resolved with the pre-transition offset. */
  nonexistent: boolean;
}

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, ...options });
    formatters.set(key, f);
  }
  return f;
}

function wallParts(ms: number, timeZone: string): Wall {
  const parts = formatter(timeZone, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(ms);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const p = parts.find((x) => x.type === type);
    return p === undefined ? Number.NaN : Number(p.value);
  };
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Wall clock of `ms` in `timeZone`, expressed as if it were UTC (whole seconds). */
function wallAsUtc(ms: number, timeZone: string): number {
  const w = wallParts(ms, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

/** UTC offset (ms, east positive) of `timeZone` at instant `ms`. */
function offsetAt(ms: number, timeZone: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  return wallAsUtc(whole, timeZone) - whole;
}

function bad(raw: string): RangeError {
  return new RangeError(`Not a naive Pacific timestamp: ${JSON.stringify(raw)}`);
}

/**
 * Parses SGW naive Pacific time. Throws RangeError for anything that is not
 * `YYYY-MM-DDTHH:MM:SS[.fff]` or is not a real calendar date/time.
 * DST edge cases are reported, not thrown: see `PacificParse`.
 */
export function parsePacificDetailed(raw: string): PacificParse {
  const m = NAIVE.exec(raw);
  if (m === null) throw bad(raw);
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const millis = m[7] === undefined ? 0 : Math.floor(Number(`0.${m[7]}`) * 1000 + 1e-6);

  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const check = new Date(asUtc);
  if (
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    throw bad(raw);
  }

  // Offsets in force a day either side of the wall time bracket any single transition.
  const before = offsetAt(asUtc - 24 * HOUR_MS, PACIFIC);
  const after = offsetAt(asUtc + 24 * HOUR_MS, PACIFIC);
  const candidates = [...new Set([before, after])]
    .map((off) => asUtc - off)
    .filter((instant) => wallAsUtc(instant, PACIFIC) === asUtc)
    .sort((a, b) => a - b);

  const first = candidates[0];
  if (first === undefined) {
    // Spring-forward gap: reuse the pre-transition offset (02:30 PST -> 03:30 PDT).
    return { ms: asUtc - before + millis, ambiguous: false, nonexistent: true };
  }
  return { ms: first + millis, ambiguous: candidates.length > 1, nonexistent: false };
}

/** Epoch milliseconds for SGW naive Pacific time. See `parsePacificDetailed`. */
export function parsePacific(raw: string): number {
  return parsePacificDetailed(raw).ms;
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Inverse of `parsePacific`: naive Pacific wall time, fractional seconds only when non-zero. */
export function formatPacificNaive(ms: number): string {
  const w = wallParts(ms, PACIFIC);
  const frac = Math.floor(((ms % 1000) + 1000) % 1000);
  const base = `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}`;
  return frac === 0 ? base : `${base}.${pad(frac, 3)}`;
}

function clock(ms: number, timeZone: string): string {
  return formatter(timeZone, { hour: 'numeric', minute: '2-digit', hour12: true })
    .format(ms)
    .replaceAll(String.fromCharCode(0x202f), ' ')
    .replaceAll(String.fromCharCode(0xa0), ' ');
}

/** "PT", "ET", "CT", "MT" from the zone's short name; other zones keep Intl's short name. */
function zoneLabel(ms: number, timeZone: string): string {
  const name =
    formatter(timeZone, { timeZoneName: 'short' })
      .formatToParts(ms)
      .find((p) => p.type === 'timeZoneName')?.value ?? timeZone;
  const generic = /^([PMCE])[SD]T$/.exec(name);
  return generic?.[1] === undefined ? name : `${generic[1]}T`;
}

/**
 * Dual display, "7:18 PM PT · 10:18 PM ET". Labels are always the generic
 * "PT"/"ET" (I-09), never PDT/EDT. A user on Pacific time sees a single time.
 * When the user's calendar date differs from Pacific's, " (+1 day)" / " (-1 day)" is appended.
 */
export function formatDual(ms: number, userTz: string): string {
  const pt = `${clock(ms, PACIFIC)} ${zoneLabel(ms, PACIFIC)}`;
  if (userTz === PACIFIC) return pt;
  const user = `${clock(ms, userTz)} ${zoneLabel(ms, userTz)}`;
  const p = wallParts(ms, PACIFIC);
  const u = wallParts(ms, userTz);
  const dayDiff = Math.round(
    (Date.UTC(u.year, u.month - 1, u.day) - Date.UTC(p.year, p.month - 1, p.day)) / 86_400_000,
  );
  const marker = dayDiff === 0 ? '' : ` (${dayDiff > 0 ? '+' : '-'}${String(Math.abs(dayDiff))} day${Math.abs(dayDiff) === 1 ? '' : 's'})`;
  return `${pt} · ${user}${marker}`;
}

/** "in 2h 5m", "45s ago", "now" (within a second). Two most significant units. */
export function relative(ms: number, now: number): string {
  const delta = ms - now;
  const totalSeconds = Math.floor(Math.abs(delta) / 1000);
  if (totalSeconds === 0) return 'now';
  const units: [string, number][] = [
    ['d', 86_400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ];
  let rest = totalSeconds;
  const out: string[] = [];
  for (const [label, size] of units) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (n > 0 || out.length > 0) out.push(`${String(n)}${label}`);
    if (out.length === 2) break;
  }
  const text = out.filter((p) => !p.startsWith('0')).join(' ');
  return delta > 0 ? `in ${text}` : `${text} ago`;
}
