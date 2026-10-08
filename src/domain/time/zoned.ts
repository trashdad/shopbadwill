// Zone-generic wall-clock math over Intl.DateTimeFormat (no dependencies, no
// built-in string date parsing). pacific.ts and the Watch helpers share it so
// DST handling lives in one place.

const HOUR_MS = 3_600_000;

export interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface ZonedInstant {
  /** Epoch milliseconds of the resolved instant. */
  ms: number;
  /** The wall time occurs twice (fall back); the earlier instant was chosen. */
  ambiguous: boolean;
  /** The wall time never happens (spring forward); resolved with the pre-transition offset. */
  nonexistent: boolean;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/** Cached en-US formatter for `timeZone` with `options`. */
export function formatter(timeZone: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${timeZone}|${JSON.stringify(options)}`;
  let f = formatters.get(key);
  if (f === undefined) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, ...options });
    formatters.set(key, f);
  }
  return f;
}

/** The zone's wall clock at `ms`. */
export function wallParts(ms: number, timeZone: string): Wall {
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

/** The zone's wall clock at `ms`, expressed as if it were UTC (whole seconds). */
export function wallAsUtc(ms: number, timeZone: string): number {
  const w = wallParts(ms, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

/** UTC offset (ms, east positive) of `timeZone` at instant `ms`. */
export function offsetAt(ms: number, timeZone: string): number {
  const whole = Math.floor(ms / 1000) * 1000;
  return wallAsUtc(whole, timeZone) - whole;
}

/**
 * The instant at which `timeZone` shows the wall time `wallUtc` (a wall time
 * written as UTC). Fall-back (two instants): the earlier. Spring-forward gap
 * (none): the pre-transition offset is applied (02:30 EST-gap -> 03:30 EDT).
 */
export function zonedWallToInstant(wallUtc: number, timeZone: string): ZonedInstant {
  // Offsets in force a day either side of the wall time bracket any single transition.
  const before = offsetAt(wallUtc - 24 * HOUR_MS, timeZone);
  const after = offsetAt(wallUtc + 24 * HOUR_MS, timeZone);
  const candidates = [...new Set([before, after])]
    .map((off) => wallUtc - off)
    .filter((instant) => wallAsUtc(instant, timeZone) === wallUtc)
    .sort((a, b) => a - b);
  const first = candidates[0];
  if (first === undefined) return { ms: wallUtc - before, ambiguous: false, nonexistent: true };
  return { ms: first, ambiguous: candidates.length > 1, nonexistent: false };
}
