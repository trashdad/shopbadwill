// S-7 dry-run snipe timing measurement: orchestrator. THROWAWAY spike code.
//
//   pnpm exec tsx scripts/timing-probe/run.ts [--pilot] [--browsers chrome,firefox]
//        [--main-lanes 3] [--cycles 7] [--control-cycles 3] [--no-controls] [--out <dir>]
//
// Starts two in-process fake SGW servers (150 ms latency, +1.3 s skew; PlaceBid
// stalled 25 s or 45 s), a tiny event collector, writes one unpacked probe
// extension per lane, and launches the browsers WITHOUT a driver:
//  - Chrome: Playwright's bundled Chromium (Chrome for Testing) spawned as a plain
//    process, --headless, --load-extension. No CDP/remote-debugging connection,
//    because an attached DevTools session suppresses service-worker idle timeouts.
//  - Firefox: `web-ext run` (temporary install over RDP), MOZ_HEADLESS=1, one
//    Firefox instance per lane. No toolbox is attached, so idle suspension applies.
// Probes POST every event to the collector; results land in --out as
// events.jsonl, sgw-*.log.json and run-config.json. analyze.ts summarizes them.
// Nothing here touches shopgoodwill.com.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import webExt from 'web-ext';
import { startFakeSgw, type FakeSgw } from '../../test/fakes/fake-sgw-server/index';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIREFOX = process.env.SBW_FIREFOX ?? 'C:\\Program Files\\Mozilla Firefox\\firefox.exe';
const SKEW_MS = 1300;
const LATENCY_MS = 150;
const ITEM_ID = 279250057;

type Browser = 'chrome' | 'firefox';
type Mode = 'main' | 'ctl-longfetch' | 'ctl-hbstop' | 'runner';

const argv = process.argv.slice(2);
const flag = (n: string): boolean => argv.includes(`--${n}`);
const opt = (n: string, d: string): string => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : d;
};
const pilot = flag('pilot');
// Firefox-only follow-up: background timers with vs without an unfocused runner popup (T-116 shape).
const runnerStudy = flag('runner-study');
// Firefox prefs for every Firefox instance, e.g. --ff-pref timer.maximum_firing_delay_tolerance_ms=0.0
const ffPrefs: Record<string, string> = {};
argv.forEach((a, i) => {
  if (a === '--ff-pref' && argv[i + 1] !== undefined) {
    const [k, v] = argv[i + 1]!.split('=');
    if (k !== undefined && v !== undefined) ffPrefs[k] = v;
  }
});
const browsers = opt('browsers', 'chrome,firefox').split(',') as Browser[];
const mainLanes = Number(opt('main-lanes', pilot ? '1' : '3'));
const cycles = Number(opt('cycles', pilot ? '2' : '7'));
const controlCycles = Number(opt('control-cycles', pilot ? '1' : '3'));
const controls = !flag('no-controls');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.resolve(opt('out', path.join(HERE, 'results', `${runnerStudy ? 'runner-' : Object.keys(ffPrefs).length ? 'ffpref-' : pilot ? 'pilot-' : ''}${runId}`)));

/** Timing knobs shared by every lane (ms). The full run follows architecture §1.3. */
const T = runnerStudy
  ? { holdLeadMs: 110_000, verifyLeadMs: 60_000, releaseAfterMs: 30_000, gapMs: 60_000, recoverAfterMs: 40_000 }
  : pilot
  ? { holdLeadMs: 90_000, verifyLeadMs: 30_000, releaseAfterMs: 50_000, gapMs: 70_000, recoverAfterMs: 60_000 }
  : { holdLeadMs: 300_000, verifyLeadMs: 60_000, releaseAfterMs: 90_000, gapMs: 90_000, recoverAfterMs: 100_000 };
const COMMON = { ...T, hbIntervalMs: 20_000, tickMs: 5_000, leadMs: 8_000, sampleGapMs: 20_000, finalHopMs: 20, itemId: ITEM_ID };
const STAGGER_MS = 37_000;
const FIRST_WAKE_MS = 60_000;

interface Lane {
  lane: string;
  browser: Browser;
  mode: Mode;
  cycles: number;
  heartbeat: boolean;
  hbStopAtFire: boolean;
  abortMs: number;
  sgwKey: 'main' | 'long';
  firstWakeDelayMs: number;
  runner?: boolean;
}

function planLanes(): Lane[] {
  const lanes: Lane[] = [];
  if (runnerStudy) {
    const n = Number(opt('cycles', '6'));
    const base = { browser: 'firefox' as const, cycles: n, heartbeat: true, hbStopAtFire: false, abortMs: 20_000, sgwKey: 'main' as const };
    lanes.push({ ...base, lane: 'firefox-runner1', mode: 'runner', runner: true, firstWakeDelayMs: FIRST_WAKE_MS });
    lanes.push({ ...base, lane: 'firefox-base1', mode: 'main', firstWakeDelayMs: FIRST_WAKE_MS + 67_000 });
    lanes.push({ ...base, lane: 'firefox-runner2', mode: 'runner', runner: true, firstWakeDelayMs: FIRST_WAKE_MS + 134_000 });
    return lanes;
  }
  for (const b of browsers) {
    for (let i = 1; i <= mainLanes; i++)
      lanes.push({ lane: `${b}-main${i}`, browser: b, mode: 'main', cycles, heartbeat: true, hbStopAtFire: false, abortMs: 20_000, sgwKey: 'main', firstWakeDelayMs: 0 });
    if (controls) {
      // >30 s stalled fetch with heartbeats running: does the fetch alone kill the worker?
      lanes.push({ lane: `${b}-longfetch`, browser: b, mode: 'ctl-longfetch', cycles: controlCycles, heartbeat: true, hbStopAtFire: false, abortMs: 60_000, sgwKey: 'long', firstWakeDelayMs: 0 });
      // Heartbeats stop at fire, fetch stalls 45 s: forces a death mid-fetch to exercise the restart path.
      lanes.push({ lane: `${b}-hbstop`, browser: b, mode: 'ctl-hbstop', cycles: controlCycles, heartbeat: true, hbStopAtFire: true, abortMs: 60_000, sgwKey: 'long', firstWakeDelayMs: 0 });
    }
  }
  // Interleave browsers so fires are spread STAGGER_MS apart across all lanes.
  const order = [...lanes].sort((a, b) => {
    const ia = lanes.filter((l) => l.browser === a.browser).indexOf(a);
    const ib = lanes.filter((l) => l.browser === b.browser).indexOf(b);
    return ia - ib || a.browser.localeCompare(b.browser);
  });
  order.forEach((l, i) => (l.firstWakeDelayMs = FIRST_WAKE_MS + i * STAGGER_MS));
  return order;
}

function writeExtension(dir: string, l: Lane, cfg: Record<string, unknown>): void {
  mkdirSync(dir, { recursive: true });
  const manifest: Record<string, unknown> = {
    manifest_version: 3,
    name: `SBW S-7 timing probe ${l.lane}`,
    version: '0.0.1',
    description: 'Throwaway S-7 timing probe (never shipped).',
    permissions: ['alarms', 'storage'],
    host_permissions: ['http://127.0.0.1/*'],
    background: l.browser === 'chrome' ? { service_worker: 'bg.js' } : { scripts: ['bg.js'] },
  };
  if (l.browser === 'firefox')
    manifest.browser_specific_settings = { gecko: { id: `s7-${l.lane}@timing-probe.sbw.test`, strict_min_version: '140.0' } };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const probe = readFileSync(path.join(HERE, 'ext', 'probe.js'), 'utf8');
  writeFileSync(path.join(dir, 'bg.js'), `const CFG = ${JSON.stringify(cfg, null, 2)};\n${probe}`);
  for (const f of ['timer-worker.js', 'runner.html', 'runner.js'])
    writeFileSync(path.join(dir, f), readFileSync(path.join(HERE, 'ext', f), 'utf8'));
}

const log = (s: string): void => {
  console.log(`[${new Date().toISOString().slice(11, 23)}] ${s}`);
};

async function main(): Promise<void> {
  mkdirSync(outDir, { recursive: true });
  const work = path.join(os.tmpdir(), `sbw-s7-${runId}`);
  mkdirSync(work, { recursive: true });

  const base = { skewMs: SKEW_MS, latencyMs: { '*': LATENCY_MS } };
  const sgw: Record<'main' | 'long', FakeSgw> = {
    main: await startFakeSgw({ port: 0, scenario: { ...base, latencyMs: { '*': LATENCY_MS, 'ItemBid/PlaceBid': 25_000 } } }),
    long: await startFakeSgw({ port: 0, scenario: { ...base, latencyMs: { '*': LATENCY_MS, 'ItemBid/PlaceBid': 45_000 } } }),
  };
  const token = sgw.main.mintToken({ expiresInMs: 8 * 3600_000 }).accessToken;
  const tokenLong = sgw.long.mintToken({ expiresInMs: 8 * 3600_000 }).accessToken;

  // Collector: POST /ev (text/plain JSON) -> events.jsonl with receive time.
  const eventsPath = path.join(outDir, 'events.jsonl');
  writeFileSync(eventsPath, '');
  const done = new Set<string>();
  const collector = createServer((req, res) => {
    res.setHeader('access-control-allow-origin', '*');
    if (req.method !== 'POST') {
      res.writeHead(204).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rx = Date.now();
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        const ev = JSON.parse(text) as Record<string, unknown>;
        appendFileSync(eventsPath, `${JSON.stringify({ rx, ...ev })}\n`);
        const t = ev.type as string;
        if (t === 'lane-done') done.add(ev.lane as string);
        if (t !== 'tick' && t !== 'hb' && t !== 'sample') {
          const extra =
            t === 'fire' || t === 'fire-single' || t === 'fire-worker' ? ` err=${(ev.errMs as number).toFixed(1)}ms perfErr=${(ev.perfErrMs as number).toFixed(2)}ms`
            : t === 'wake' ? ` lat=${String(ev.latencyMs)}ms cold=${String(ev.cold)}`
            : t === 'release' ? ` hold=${String(ev.holdMs)}ms hb=${String(ev.hbCount)}`
            : t === 'bid-result' ? ` ${String(ev.kind)} ${Math.round(ev.elapsedMs as number)}ms`
            : t === 'boot' ? ` prev=${JSON.stringify(ev.prev)}`
            : t === 'recovered' ? ` phaseAtDeath=${String(ev.phaseAtDeath)} ambiguous=${String(ev.ambiguous)}`
            : '';
          log(`${String(ev.lane)} ${String(ev.inst)} c${String(ev.cycle ?? '-')} ${t}${extra}`);
        }
      } catch {
        appendFileSync(eventsPath, `${JSON.stringify({ rx, bad: text })}\n`);
      }
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((r) => collector.listen(0, '127.0.0.1', r));
  const collectorUrl = `http://127.0.0.1:${String((collector.address() as AddressInfo).port)}`;

  const lanes = planLanes();
  const runConfig = {
    runId,
    pilot,
    startedAt: Date.now(),
    skewMs: SKEW_MS,
    latencyMs: LATENCY_MS,
    placeBidStallMs: { main: 25_000, long: 45_000 },
    sgw: { main: sgw.main.url, long: sgw.long.url },
    collector: collectorUrl,
    common: COMMON,
    lanes,
    host: { platform: `${os.type()} ${os.release()}`, cpus: os.cpus().length, cpuModel: os.cpus()[0]?.model, memGb: Math.round(os.totalmem() / 2 ** 30), node: process.version },
    chromium: chromium.executablePath(),
    firefox: FIREFOX,
    ffPrefs,
  };
  writeFileSync(path.join(outDir, 'run-config.json'), JSON.stringify(runConfig, null, 2));

  const extDirs: Record<string, string> = {};
  for (const l of lanes) {
    const cfg = {
      ...COMMON,
      lane: l.lane,
      browser: l.browser,
      mode: l.mode,
      cycles: l.cycles,
      heartbeat: l.heartbeat,
      hbStopAtFire: l.hbStopAtFire,
      abortMs: l.abortMs,
      firstWakeDelayMs: l.firstWakeDelayMs,
      runner: l.runner === true,
      sgw: sgw[l.sgwKey].url,
      token: l.sgwKey === 'main' ? token : tokenLong,
      collector: collectorUrl,
    };
    extDirs[l.lane] = path.join(work, 'ext', l.lane);
    writeExtension(extDirs[l.lane]!, l, cfg);
  }

  // ---- Chrome: one plain Chromium process, all chrome lanes loaded unpacked.
  const children: ChildProcess[] = [];
  const ffRunners: { exit: () => Promise<void> }[] = [];
  const chromeLanes = lanes.filter((l) => l.browser === 'chrome');
  if (chromeLanes.length > 0) {
    const dirs = chromeLanes.map((l) => extDirs[l.lane]!).join(',');
    const args = [
      `--user-data-dir=${path.join(work, 'chrome-profile')}`,
      '--headless',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-component-update',
      '--no-sandbox',
      `--disable-extensions-except=${dirs}`,
      `--load-extension=${dirs}`,
      'about:blank',
    ];
    const cp = spawn(chromium.executablePath(), args, { stdio: ['ignore', 'ignore', 'pipe'] });
    cp.stderr?.on('data', (d: Buffer) => appendFileSync(path.join(outDir, 'chrome-stderr.txt'), d));
    children.push(cp);
    log(`chromium pid ${String(cp.pid)} with ${String(chromeLanes.length)} lanes`);
  }

  // ---- Machine load during the run: total CPU % every 10 s (Windows typeperf).
  const cpu = spawn('typeperf', ['\\Processor(_Total)\\% Processor Time', '-si', '10', '-o', path.join(outDir, 'cpu.csv'), '-y'], { stdio: 'ignore' });
  children.push(cpu);

  // ---- Firefox: one headless instance per lane via web-ext (temporary install).
  process.env.MOZ_HEADLESS = '1';
  for (const l of lanes.filter((x) => x.browser === 'firefox')) {
    const runner = (await webExt.cmd.run(
      { sourceDir: extDirs[l.lane], firefox: FIREFOX, noReload: true, noInput: true, target: ['firefox-desktop'], pref: ffPrefs },
      { shouldExitProgram: false },
    )) as { exit: () => Promise<void> };
    ffRunners.push(runner);
    log(`firefox lane ${l.lane} installed`);
  }

  const cycleMs = COMMON.holdLeadMs + COMMON.releaseAfterMs + COMMON.gapMs + 2_000;
  const maxCycles = Math.max(...lanes.map((l) => l.cycles));
  const deadline = Date.now() + FIRST_WAKE_MS + lanes.length * STAGGER_MS + maxCycles * cycleMs + 5 * 60_000;
  log(`run ${runId}: ${String(lanes.length)} lanes, deadline ${new Date(deadline).toISOString()}, out ${outDir}`);

  let stopping = false;
  const stop = async (why: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log(`stopping: ${why}`);
    for (const [k, s] of Object.entries(sgw)) {
      const r = await fetch(`${s.url}/__log`);
      writeFileSync(path.join(outDir, `sgw-${k}.log.json`), JSON.stringify(await r.json()));
    }
    for (const r of ffRunners) await r.exit().catch(() => undefined);
    for (const c of children) if (c.pid !== undefined) spawnSync('taskkill', ['/PID', String(c.pid), '/T', '/F']);
    await sgw.main.close();
    await sgw.long.close();
    collector.close();
    writeFileSync(
      path.join(outDir, 'run-config.json'),
      JSON.stringify({ ...runConfig, endedAt: Date.now(), stopReason: why, lanesDone: [...done] }, null, 2),
    );
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      /* profile files may still be locked; harmless temp dir */
    }
    log('stopped');
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  const poll = setInterval(() => {
    if (done.size === lanes.length) void stop('all lanes done');
    else if (Date.now() > deadline) void stop('deadline');
  }, 2_000);
  poll.unref();
  await new Promise(() => undefined);
}

void main().catch((e: unknown) => {
  console.error(e);
  process.exit(1);
});
