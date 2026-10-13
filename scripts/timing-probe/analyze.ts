// S-7 timing probe: analysis. THROWAWAY spike code.
//
//   pnpm exec tsx scripts/timing-probe/analyze.ts <results-dir>      -> summary.md + summary.json
//   pnpm exec tsx scripts/timing-probe/analyze.ts --selftest
//
// Reads events.jsonl (probe reports), sgw-*.log.json (fake server request logs)
// and run-config.json written by run.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

type Ev = Record<string, unknown> & { lane: string; browser: string; mode: string; inst: string; type: string; at: number; cycle?: number };
interface SgwEntry { path: string; query: string; receivedAtMs: number; status: number }

/** Nearest-rank percentile of a non-empty list. */
export function pct(xs: number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * s.length));
  return s[rank - 1]!;
}
export function stats(xs: number[]): { n: number; min: number; p50: number; p90: number; p95: number; max: number; mean: number } | null {
  if (xs.length === 0) return null;
  return {
    n: xs.length,
    min: Math.min(...xs),
    p50: pct(xs, 50),
    p90: pct(xs, 90),
    p95: pct(xs, 95),
    max: Math.max(...xs),
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
  };
}

export interface CycleResult {
  lane: string;
  browser: string;
  mode: string;
  cycle: number;
  wakeLatencyMs: number | null;
  workerStartVsScheduledMs: number | null;
  cold: boolean | null;
  aliveThroughRelease: boolean;
  holdMs: number | null;
  hbCount: number;
  hbMaxIntervalMs: number | null;
  hbIntervals: number[];
  tickMaxGapMs: number | null;
  fireErrMs: number | null;
  perfErrMs: number | null;
  singleErrMs: number | null;
  singlePerfErrMs: number | null;
  workerErrMs: number | null;
  runnerAErrMs: number | null;
  runnerBErrMs: number | null;
  runnerVisibility: string | null;
  sendLagMs: number | null;
  timerDelayMs: number | null;
  arrivalVsTargetMs: number | null;
  offsetEstErrMs: number | null;
  bestRttMs: number | null;
  bid: { kind: string; elapsedMs: number } | null;
  died: boolean;
  lastSeenAfterWakeMs: number | null;
  lastSeenAfterFireMs: number | null;
  recovered: { phaseAtDeath: string; ambiguous: boolean; postReadOk: boolean | null; missedFire: boolean } | null;
  gapLastTickAfterReleaseMs: number | null;
  nextWakeCold: boolean | null;
}

export function analyzeCycles(events: Ev[], sgwLogs: SgwEntry[], skewMs: number, leadMs: number, trueOffsetMs: number): CycleResult[] {
  const out: CycleResult[] = [];
  const byLane = new Map<string, Ev[]>();
  for (const e of events) {
    if (typeof e.lane !== 'string') continue;
    const list = byLane.get(e.lane) ?? [];
    list.push(e);
    byLane.set(e.lane, list);
  }
  for (const [lane, evs] of byLane) {
    evs.sort((a, b) => a.at - b.at);
    const cycles = [...new Set(evs.filter((e) => e.type === 'armed').map((e) => e.cycle!))].sort((a, b) => a - b);
    for (const c of cycles) {
      const of = (t: string): Ev | undefined => evs.find((e) => e.type === t && e.cycle === c);
      const wake = of('wake');
      const release = of('release');
      const fire = of('fire');
      const single = of('fire-single');
      const workerFire = of('fire-worker');
      const runnerFire = of('runner-fire');
      const verifyEv = of('verify') ?? of('verify-error');
      const offset = of('offset');
      const bid = of('bid-result');
      const rec = of('recovered');
      const timerSet = of('timer-set');
      const armed = of('armed')!;
      const hbs = evs.filter((e) => e.type === 'hb' && e.cycle === c);
      const hbIntervals = hbs.map((h) => h.sincePrevMs).filter((x): x is number => typeof x === 'number');
      const alive = wake !== undefined && release !== undefined && release.inst === wake.inst;
      // Ticks from the instance that woke for this cycle, during the hold.
      const holdTicks = wake ? evs.filter((e) => e.type === 'tick' && e.inst === wake.inst && e.cycle === c && e.phase === 'hold' && e.at >= wake.at) : [];
      const seen = [wake?.at, ...holdTicks.map((t) => t.at), ...evs.filter((e) => wake && e.inst === wake.inst && e.cycle === c && e.type !== 'tick').map((e) => e.at)].filter(
        (x): x is number => typeof x === 'number',
      );
      const lastSeen = seen.length ? Math.max(...seen.filter((x) => !release || x <= release.at)) : null;
      const tickTimes = holdTicks.map((t) => t.at).sort((a, b) => a - b);
      // Ticks are paused on purpose from the verify read until timer A has reported.
      const pausedFrom = verifyEv?.at ?? Infinity;
      const pausedTo = single?.at ?? fire?.at ?? Infinity;
      let tickMaxGap: number | null = null;
      for (let i = 1; i < tickTimes.length; i++) {
        const a = tickTimes[i - 1]!;
        const b = tickTimes[i]!;
        if (a <= pausedTo && b >= pausedFrom) continue;
        tickMaxGap = Math.max(tickMaxGap ?? 0, b - a);
      }
      let arrival: number | null = null;
      const bidLog = sgwLogs.find((l) => l.path.toLowerCase().endsWith('/placebid') && l.query === `?probe=${lane}.${String(c)}.bid`);
      if (bidLog && offset) arrival = bidLog.receivedAtMs + skewMs - ((offset.endServerMs as number) - leadMs);
      const gapTicks = release ? evs.filter((e) => e.type === 'tick' && e.inst === release.inst && e.phase === 'gap' && e.at > release.at && e.cycle === c) : [];
      const nextWake = evs.find((e) => e.type === 'wake' && e.cycle === c + 1);
      out.push({
        lane,
        browser: armed.browser,
        mode: armed.mode,
        cycle: c,
        wakeLatencyMs: (wake?.latencyMs as number | undefined) ?? null,
        workerStartVsScheduledMs: (wake?.workerStartVsScheduledMs as number | undefined) ?? null,
        cold: (wake?.cold as boolean | undefined) ?? null,
        aliveThroughRelease: alive,
        holdMs: alive ? (release.holdMs as number) : null,
        hbCount: hbs.length,
        hbMaxIntervalMs: hbIntervals.length ? Math.max(...hbIntervals) : null,
        hbIntervals,
        tickMaxGapMs: tickMaxGap,
        fireErrMs: (fire?.errMs as number | undefined) ?? null,
        perfErrMs: (fire?.perfErrMs as number | undefined) ?? null,
        singleErrMs: (single?.errMs as number | undefined) ?? null,
        singlePerfErrMs: (single?.perfErrMs as number | undefined) ?? null,
        workerErrMs: (workerFire?.errMs as number | undefined) ?? null,
        runnerAErrMs: (runnerFire?.aErrMs as number | undefined) ?? null,
        runnerBErrMs: (runnerFire?.bErrMs as number | undefined) ?? null,
        runnerVisibility: runnerFire ? `${String(runnerFire.visibility)}/focus=${String(runnerFire.hasFocus)}` : null,
        sendLagMs: (fire?.sendLagMs as number | undefined) ?? null,
        timerDelayMs: (timerSet?.delay as number | undefined) ?? null,
        arrivalVsTargetMs: arrival,
        offsetEstErrMs: offset ? (offset.offset as number) - trueOffsetMs : null,
        bestRttMs: (offset?.rtt as number | undefined) ?? null,
        bid: bid ? { kind: bid.kind as string, elapsedMs: bid.elapsedMs as number } : null,
        died: wake !== undefined && !alive,
        lastSeenAfterWakeMs: lastSeen !== null && wake ? lastSeen - wake.at : null,
        lastSeenAfterFireMs: lastSeen !== null && fire ? lastSeen - (fire.actual as number) : null,
        recovered: rec
          ? {
              phaseAtDeath: rec.phaseAtDeath as string,
              ambiguous: rec.ambiguous as boolean,
              postReadOk: rec.postRead ? ((rec.postRead as { ok: boolean }).ok ?? null) : null,
              missedFire: rec.missedFire === true,
            }
          : null,
        gapLastTickAfterReleaseMs: release ? (gapTicks.length ? Math.max(...gapTicks.map((t) => t.at)) - release.at : 0) : null,
        nextWakeCold: (nextWake?.cold as boolean | undefined) ?? null,
      });
    }
  }
  return out;
}

const f = (x: number | null | undefined, d = 0): string => (x === null || x === undefined ? '-' : x.toFixed(d));
function statRow(label: string, xs: number[], d = 0): string {
  const s = stats(xs);
  if (!s) return `| ${label} | 0 | - | - | - | - | - | - |`;
  return `| ${label} | ${String(s.n)} | ${f(s.min, d)} | ${f(s.p50, d)} | ${f(s.p90, d)} | ${f(s.p95, d)} | ${f(s.max, d)} | ${f(s.mean, d)} |`;
}

export function render(cycles: CycleResult[], cfg: Record<string, unknown>): { md: string; json: Record<string, unknown> } {
  const lines: string[] = [];
  const json: Record<string, unknown> = { runId: cfg.runId, perBrowser: {} };
  const browsers = [...new Set(cycles.map((c) => c.browser))].sort();
  for (const b of browsers) {
    const main = cycles.filter((c) => c.browser === b && c.mode === 'main' && c.wakeLatencyMs !== null);
    const fired = main.filter((c) => c.fireErrMs !== null);
    const abs = fired.map((c) => Math.abs(c.fireErrMs!));
    const firedA = main.filter((c) => c.singleErrMs !== null);
    const absA = firedA.map((c) => Math.abs(c.singleErrMs!));
    const firedC = main.filter((c) => c.workerErrMs !== null);
    const absC = firedC.map((c) => Math.abs(c.workerErrMs!));
    const hb = main.flatMap((c) => c.hbIntervals);
    const gap = main.filter((c) => c.gapLastTickAfterReleaseMs !== null && c.nextWakeCold !== null);
    const stallDeaths = main.filter((c) => c.died && c.bid === null);
    lines.push(`### ${b} — main lanes (${String(main.length)} fires)`, '');
    lines.push('| metric (ms) | n | min | p50 | p90 | p95 | max | mean |', '|---|---|---|---|---|---|---|---|');
    lines.push(statRow('alarm wake latency (onAlarm − scheduledTime)', main.map((c) => c.wakeLatencyMs!)));
    lines.push(statRow('worker start − scheduledTime (timeOrigin)', main.map((c) => c.workerStartVsScheduledMs!).filter((x) => x !== null), 1));
    lines.push(statRow('timer A single setTimeout: fire error, signed', firedA.map((c) => c.singleErrMs!), 1));
    lines.push(statRow('timer A single setTimeout: fire error, absolute', absA, 1));
    lines.push(statRow('timer A single setTimeout: performance.now based', firedA.map((c) => c.singlePerfErrMs!), 2));
    lines.push(statRow('timer B staged hops: fire error, signed', fired.map((c) => c.fireErrMs!), 1));
    lines.push(statRow('timer B staged hops: fire error, absolute', abs, 1));
    lines.push(statRow('timer B staged hops: performance.now based', fired.map((c) => c.perfErrMs!), 2));
    if (firedC.length) {
      lines.push(statRow('timer C worker setTimeout: fire error, signed', firedC.map((c) => c.workerErrMs!), 1));
      lines.push(statRow('timer C worker setTimeout: fire error, absolute', absC, 1));
    }
    lines.push(statRow('fire → fetch() call (persist attempt)', fired.map((c) => c.sendLagMs!), 1));
    lines.push(statRow('PlaceBid server arrival − (end − lead)', fired.map((c) => c.arrivalVsTargetMs!).filter((x) => x !== null), 1));
    lines.push(statRow('clock offset estimate − true skew', main.map((c) => c.offsetEstErrMs!).filter((x) => x !== null), 1));
    lines.push(statRow('best-sample RTT', main.map((c) => c.bestRttMs!).filter((x) => x !== null), 1));
    lines.push(statRow('KeepAlive heartbeat interval', hb, 0));
    lines.push(statRow('hold duration (wake → release)', main.filter((c) => c.holdMs !== null).map((c) => c.holdMs!)));
    lines.push(statRow('max gap between 5 s ticks during hold', main.map((c) => c.tickMaxGapMs!).filter((x) => x !== null)));
    lines.push(statRow('gap control: last tick after release', gap.map((c) => c.gapLastTickAfterReleaseMs!)));
    lines.push('');
    const alive6 = main.filter((c) => c.aliveThroughRelease && (c.holdMs ?? 0) >= 360_000).length;
    const coldN = main.filter((c) => c.cold === true).length;
    const okSpec = abs.length > 0 && pct(abs, 95) <= 50 && Math.max(...abs) <= 250;
    const okSpecA = absA.length > 0 && pct(absA, 95) <= 50 && Math.max(...absA) <= 250;
    const summary = {
      fires: fired.length,
      cycles: main.length,
      coldWakes: coldN,
      aliveThroughHold: main.filter((c) => c.aliveThroughRelease).length,
      alive6min: alive6,
      deaths: main.filter((c) => c.died).length,
      deathsDuringStall: stallDeaths.length,
      stallAborted: main.filter((c) => c.bid?.kind === 'aborted').length,
      hbMaxIntervalMs: hb.length ? Math.max(...hb) : null,
      fireErrAbsP95: abs.length ? pct(abs, 95) : null,
      fireErrAbsMax: abs.length ? Math.max(...abs) : null,
      fireSpecMet: okSpec,
      singleFires: firedA.length,
      singleErrAbsP95: absA.length ? pct(absA, 95) : null,
      singleErrAbsMax: absA.length ? Math.max(...absA) : null,
      singleSpecMet: okSpecA,
      workerFires: firedC.length,
      workerErrAbsP95: absC.length ? pct(absC, 95) : null,
      workerErrAbsMax: absC.length ? Math.max(...absC) : null,
      workerSpecMet: absC.length > 0 && pct(absC, 95) <= 50 && Math.max(...absC) <= 250,
      gapControlDeaths: gap.filter((c) => c.nextWakeCold === true).length,
      gapControlCycles: gap.length,
    };
    lines.push(
      `- fires ${String(summary.fires)}/${String(summary.cycles)}; cold wakes ${String(coldN)}/${String(main.length)}; alive wake→release ${String(summary.aliveThroughHold)}/${String(main.length)}; alive ≥ 6 min ${String(alive6)}/${String(main.length)}`,
      `- worker/event-page deaths during the hold: ${String(summary.deaths)}; during the 20 s stalled PlaceBid: ${String(summary.deathsDuringStall)}/${String(main.length)}; stalled PlaceBid aborted at 20 s: ${String(summary.stallAborted)}/${String(main.length)}`,
      `- timer A (single setTimeout, as designed): |err| p95 ${f(summary.singleErrAbsP95, 1)} ms, max ${f(summary.singleErrAbsMax, 1)} ms over ${String(firedA.length)} fires → target (p95 ≤ 50, max ≤ 250) ${okSpecA ? 'MET' : 'NOT MET'}`,
      `- timer B (staged hops): |err| p95 ${f(summary.fireErrAbsP95, 1)} ms, max ${f(summary.fireErrAbsMax, 1)} ms over ${String(fired.length)} fires → target ${okSpec ? 'MET' : 'NOT MET'}`,
      ...(firedC.length
        ? [`- timer C (dedicated Worker, measure-only): |err| p95 ${f(summary.workerErrAbsP95, 1)} ms, max ${f(summary.workerErrAbsMax, 1)} ms over ${String(firedC.length)} fires → target ${summary.workerSpecMet ? 'MET' : 'NOT MET'}`]
        : []),
      `- positive control (no heartbeat after release): the next wake was a cold start in ${String(summary.gapControlDeaths)}/${String(summary.gapControlCycles)} gaps`,
      '',
    );
    const rs = cycles.filter((c) => c.browser === b && (c.mode === 'runner' || c.lane.includes('-base')) && c.fireErrMs !== null);
    if (rs.some((c) => c.mode === 'runner')) {
      lines.push(`### ${b} — runner-page study`, '');
      lines.push('| timer (ms) | n | min | p50 | p90 | p95 | max | mean |', '|---|---|---|---|---|---|---|---|');
      const run = rs.filter((c) => c.mode === 'runner');
      const base = rs.filter((c) => c.mode !== 'runner');
      const vals = (xs: CycleResult[], k: keyof CycleResult): number[] => xs.map((c) => c[k]).filter((x): x is number => typeof x === 'number');
      lines.push(statRow('runner lanes: runner page timer A (single)', vals(run, 'runnerAErrMs'), 1));
      lines.push(statRow('runner lanes: runner page timer B (staged)', vals(run, 'runnerBErrMs'), 1));
      lines.push(statRow('runner lanes: event page timer A (single)', vals(run, 'singleErrMs'), 1));
      lines.push(statRow('runner lanes: event page timer B (staged)', vals(run, 'fireErrMs'), 1));
      lines.push(statRow('runner lanes: event page timer C (worker)', vals(run, 'workerErrMs'), 1));
      lines.push(statRow('baseline lane: event page timer A (single)', vals(base, 'singleErrMs'), 1));
      lines.push(statRow('baseline lane: event page timer B (staged)', vals(base, 'fireErrMs'), 1));
      lines.push(statRow('baseline lane: event page timer C (worker)', vals(base, 'workerErrMs'), 1));
      lines.push('', `- runner page state at fire: ${[...new Set(run.map((c) => c.runnerVisibility))].join(', ')}`, '');
    }
    const ctl = cycles.filter((c) => c.browser === b && c.mode !== 'main' && c.mode !== 'runner');
    if (ctl.length) {
      lines.push(`### ${b} — control lanes`, '');
      lines.push('| lane | cycle | hb | died | last seen after fire (ms) | PlaceBid | recovery path |', '|---|---|---|---|---|---|---|');
      for (const c of ctl)
        lines.push(
          `| ${c.lane} | ${String(c.cycle)} | ${String(c.hbCount)} | ${c.died ? 'yes' : 'no'} | ${f(c.lastSeenAfterFireMs)} | ${c.bid ? `${c.bid.kind} ${f(c.bid.elapsedMs)} ms` : '(none recorded)'} | ${c.recovered ? `phaseAtDeath=${c.recovered.phaseAtDeath} ambiguous=${String(c.recovered.ambiguous)} postReadOk=${String(c.recovered.postReadOk)}` : '-'} |`,
        );
      lines.push('');
    }
    (json.perBrowser as Record<string, unknown>)[b] = {
      summary,
      wakeLatency: stats(main.map((c) => c.wakeLatencyMs!)),
      singleErr: stats(firedA.map((c) => c.singleErrMs!)),
      singleErrAbs: stats(absA),
      stagedErr: stats(fired.map((c) => c.fireErrMs!)),
      stagedErrAbs: stats(abs),
      workerErr: stats(firedC.map((c) => c.workerErrMs!)),
      hb: stats(hb),
    };
  }
  lines.push('### Per-cycle raw', '');
  lines.push(
    '| lane | c | wake lat | cold | alive | hold ms | hb n | hb max | A err | B err | C err | B perf err | send lag | arrival | off err | rtt | PlaceBid | died | last seen after wake | gap last tick |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  );
  for (const c of cycles)
    lines.push(
      `| ${c.lane} | ${String(c.cycle)} | ${f(c.wakeLatencyMs)} | ${String(c.cold)} | ${c.aliveThroughRelease ? 'y' : 'n'} | ${f(c.holdMs)} | ${String(c.hbCount)} | ${f(c.hbMaxIntervalMs)} | ${f(c.singleErrMs, 1)} | ${f(c.fireErrMs, 1)} | ${f(c.workerErrMs, 1)} | ${f(c.perfErrMs, 2)} | ${f(c.sendLagMs)} | ${f(c.arrivalVsTargetMs)} | ${f(c.offsetEstErrMs, 1)} | ${f(c.bestRttMs, 1)} | ${c.bid ? `${c.bid.kind} ${f(c.bid.elapsedMs)}` : '-'} | ${c.died ? 'y' : 'n'} | ${f(c.lastSeenAfterWakeMs)} | ${f(c.gapLastTickAfterReleaseMs)} |`,
    );
  json.cycles = cycles;
  return { md: lines.join('\n'), json };
}

function selftest(): void {
  const eq = (a: unknown, b: unknown, m: string): void => {
    if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  };
  eq(pct([5, 1, 3, 2, 4], 50), 3, 'p50');
  eq(pct(Array.from({ length: 20 }, (_, i) => i + 1), 95), 19, 'p95 of 1..20');
  eq(pct([7], 95), 7, 'single');
  const base = { browser: 'chrome', mode: 'main' };
  const ev = (inst: string, type: string, at: number, x: Record<string, unknown> = {}): Ev => ({ lane: 'L', inst, type, at, ...base, ...x }) as Ev;
  // Cycle 1 alive through release; cycle 2 dies 40 s after wake, recovered by a new instance.
  const evs: Ev[] = [
    ev('a', 'armed', 0, { cycle: 1 }),
    ev('b', 'wake', 1000, { cycle: 1, latencyMs: 12, cold: true, workerStartVsScheduledMs: 3 }),
    ev('b', 'hb', 21000, { cycle: 1, sincePrevMs: null }),
    ev('b', 'hb', 41000, { cycle: 1, sincePrevMs: 20000 }),
    ev('b', 'offset', 42000, { cycle: 1, offset: 1375, rtt: 150, endServerMs: 400000 }),
    ev('b', 'fire', 300000, { cycle: 1, errMs: 2, perfErrMs: 1.5, sendLagMs: 3, actual: 300000 }),
    ev('b', 'bid-result', 320000, { cycle: 1, kind: 'aborted', elapsedMs: 20000 }),
    ev('b', 'release', 390000, { cycle: 1, holdMs: 389000 }),
    ev('b', 'tick', 395000, { cycle: 1, phase: 'gap' }),
    ev('b', 'armed', 390001, { cycle: 2 }),
    ev('c', 'wake', 480000, { cycle: 2, latencyMs: 8, cold: true }),
    ev('c', 'tick', 520000, { cycle: 2, phase: 'hold' }),
    ev('d', 'recovered', 900000, { cycle: 2, phaseAtDeath: 'holding', ambiguous: false, missedFire: true }),
  ];
  const sgw: SgwEntry[] = [{ path: '/api/ItemBid/PlaceBid', query: '?probe=L.1.bid', receivedAtMs: 400000 - 8000 - 1300 - 150, status: 200 }];
  const r = analyzeCycles(evs, sgw, 1300, 8000, 1300);
  eq(r.length, 2, 'two cycles');
  eq([r[0]!.aliveThroughRelease, r[0]!.holdMs, r[0]!.hbMaxIntervalMs, r[0]!.offsetEstErrMs], [true, 389000, 20000, 75], 'cycle 1');
  eq(r[0]!.arrivalVsTargetMs, -150, 'arrival');
  eq(r[0]!.gapLastTickAfterReleaseMs, 5000, 'gap tick');
  eq(r[0]!.nextWakeCold, true, 'next wake cold');
  eq([r[1]!.died, r[1]!.lastSeenAfterWakeMs, r[1]!.recovered?.missedFire], [true, 40000, true], 'cycle 2 death');
  console.log('selftest ok');
}

if (process.argv[2] === '--selftest') selftest();
else if (process.argv[2] !== undefined) {
  const dir = path.resolve(process.argv[2]);
  const cfg = JSON.parse(readFileSync(path.join(dir, 'run-config.json'), 'utf8')) as Record<string, unknown> & { skewMs: number; common: { leadMs: number } };
  const events = readFileSync(path.join(dir, 'events.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Ev)
    .filter((e) => typeof e.type === 'string');
  const sgw: SgwEntry[] = [];
  for (const k of ['main', 'long']) {
    try {
      sgw.push(...(JSON.parse(readFileSync(path.join(dir, `sgw-${k}.log.json`), 'utf8')) as { entries: SgwEntry[] }).entries);
    } catch {
      /* log missing (run interrupted) */
    }
  }
  const cycles = analyzeCycles(events, sgw, cfg.skewMs, cfg.common.leadMs, cfg.skewMs);
  const { md, json } = render(cycles, cfg);
  writeFileSync(path.join(dir, 'summary.md'), `${md}\n`);
  writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(json, null, 2));
  console.log(md);
}
