// S-7 timing probe: background script for Chrome (MV3 service worker) and
// Firefox (MV3 event page). THROWAWAY spike code, never shipped, not part of
// src/. run.ts prepends `const CFG = {...};` and writes it as bg.js.
//
// One "lane" = one extension instance that runs CFG.cycles dry-run snipe
// cycles back to back, following architecture §1.3:
//   wake alarm at fireAt - holdLead -> KeepAlive.hold (runtime.getPlatformInfo
//   every hbIntervalMs, never a network request) -> 3 clock samples
//   (ItemDetail, sampleGapMs apart, keep lowest RTT) -> T-verifyLead verify
//   read -> setTimeout to fireAt -> PlaceBid with an abortMs AbortController
//   -> post-read -> hold until fireAt + releaseAfterMs -> release, arm next.
// Every step is reported to the collector (plain fetch, text/plain, no
// extension API) so that no browser driver is attached. A "tick" report every
// tickMs (fetch only) shows exactly when the worker/event page stopped running.
/* global CFG */
'use strict';

const api = globalThis.browser ?? globalThis.chrome;
const INST = Math.random().toString(36).slice(2, 10);
const BOOT_MS = Date.now();
const T_ORIGIN = performance.timeOrigin;
let seqNo = 0;
let handledAlarm = false;

/** In-memory hold of the current cycle (lost if the worker dies). */
let H = null;
let tickTimer = null;
let tickN = 0;
let tickPhase = 'idle';
let tickCycle = 0;

function report(type, data) {
  const ev = { lane: CFG.lane, browser: CFG.browser, mode: CFG.mode, inst: INST, seq: ++seqNo, type, at: Date.now(), ...data };
  return fetch(`${CFG.collector}/ev`, { method: 'POST', body: JSON.stringify(ev) }).catch(() => undefined);
}

// ---------------------------------------------------------------- time ----
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
function ptOffsetAt(ms) {
  const o = {};
  for (const p of PT.formatToParts(new Date(Math.floor(ms / 1000) * 1000))) if (p.type !== 'literal') o[p.type] = Number(p.value);
  return Date.UTC(o.year, o.month - 1, o.day, o.hour, o.minute, o.second) - Math.floor(ms / 1000) * 1000;
}
/** Naive Pacific "YYYY-MM-DDTHH:mm:ss.SSS" -> epoch ms. */
function ptNaiveToEpoch(raw) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(raw);
  if (!m) throw new Error(`bad serverTime ${raw}`);
  const wall =
    Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) + (m[7] === undefined ? 0 : Math.round(Number(`0.${m[7]}`) * 1000));
  const e0 = wall - ptOffsetAt(wall);
  return wall - ptOffsetAt(e0);
}

// ---------------------------------------------------------------- state ---
async function getSt() {
  const r = await api.storage.local.get('st');
  return r.st ?? null;
}
async function putSt(st) {
  await api.storage.local.set({ st });
}

// ---------------------------------------------------------------- ticks ---
function startTicks(cycle, phase) {
  tickCycle = cycle;
  tickPhase = phase;
  if (tickTimer !== null) return;
  tickTimer = setInterval(() => {
    tickN += 1;
    void report('tick', { cycle: tickCycle, phase: tickPhase, n: tickN });
  }, CFG.tickMs);
}
// Ticks are measurement apparatus, not part of the engine: they are paused
// from the T-verify read until just after the fire so that the extra timers do
// not perturb the timers under test (Firefox batches timers, see S-7.md).
function pauseTicks() {
  if (tickTimer !== null) clearInterval(tickTimer);
  tickTimer = null;
}

// Staged timer: hop towards the target with hops of 3/4 of the remaining time,
// so a hop that fires late by its own delay/8 (Firefox TimerThread tolerance)
// still lands before the target; the last hop is <= finalHopMs.
function preciseAt(targetPerf, cb) {
  const step = () => {
    const rem = targetPerf - performance.now();
    if (rem <= 0) {
      cb();
      return;
    }
    setTimeout(step, rem <= CFG.finalHopMs ? rem : rem * 0.75);
  };
  step();
}

// ---------------------------------------------------------------- sgw -----
const detailUrl = (tag) => `${CFG.sgw}/api/ItemDetail/GetItemDetailModelByItemId/${CFG.itemId}?probe=${CFG.lane}.${tag}`;

async function readDetail(tag) {
  const t0 = Date.now();
  const p0 = performance.now();
  const res = await fetch(detailUrl(tag), { credentials: 'omit', cache: 'no-store' });
  const body = await res.json();
  const t1 = Date.now();
  const p1 = performance.now();
  return { t0, t1, rtt: p1 - p0, status: res.status, serverMs: ptNaiveToEpoch(body.serverTime), body };
}

// ---------------------------------------------------------------- cycle ---
async function arm(cycle, lastOffset) {
  if (cycle > CFG.cycles) {
    const st = await getSt();
    await putSt({ ...st, phase: 'done' });
    await report('lane-done', { cycles: CFG.cycles });
    return;
  }
  const off = lastOffset ?? 0;
  const now = Date.now();
  const jitter = Math.floor(Math.random() * 1000);
  const wakeWhen = now + (cycle === 1 ? CFG.firstWakeDelayMs : CFG.gapMs) + jitter;
  // The synthetic auction end, in SERVER time, such that the nominal fire is
  // holdLeadMs after the wake (fire = end - lead - oneWay in server time).
  const endServerMs = wakeWhen + CFG.holdLeadMs + CFG.leadMs + off;
  const st = { cycle, phase: 'armed', inst: INST, endServerMs, wakeWhen, lastOffset: off };
  await putSt(st);
  await api.alarms.create(`wake:${cycle}`, { when: wakeWhen });
  await report('armed', { cycle, endServerMs, wakeWhen, fireNominal: wakeWhen + CFG.holdLeadMs });
}

async function onWake(cycle, alarm, nowMs, perfNow) {
  const st = await getSt();
  await report('wake', {
    cycle,
    scheduledTime: alarm.scheduledTime,
    firedAt: nowMs,
    latencyMs: nowMs - alarm.scheduledTime,
    bootMs: BOOT_MS,
    sinceBootMs: nowMs - BOOT_MS,
    workerStartVsScheduledMs: T_ORIGIN - alarm.scheduledTime,
    perfNow,
    cold: !handledAlarm && nowMs - BOOT_MS < 10_000,
  });
  handledAlarm = true;
  if (!st || st.cycle !== cycle) {
    await report('stale-wake', { cycle, st });
    return;
  }
  H = { cycle, wakeAt: nowMs, st, samples: [], hb: null, hbN: 0, lastHb: null, done: false };
  st.phase = 'holding';
  st.inst = INST;
  await putSt(st);
  const fireNominal = st.wakeWhen + CFG.holdLeadMs;
  await api.alarms.create(`recover:${cycle}`, { when: fireNominal + CFG.recoverAfterMs });
  startTicks(cycle, 'hold');
  if (CFG.heartbeat) startHeartbeat(H);
  if (typeof Worker === 'function') {
    // Timer C (Firefox only): measure-only timer in a dedicated Worker.
    const h = H;
    h.worker = new Worker('timer-worker.js');
    h.worker.onmessage = (e) => {
      void report('fire-worker', {
        cycle: e.data.cycle,
        timer: 'worker',
        intended: e.data.target,
        actual: e.data.actual,
        errMs: e.data.actual - e.data.target,
        perfErrMs: e.data.perfErrMs,
      });
    };
  }
  void sampleLoop(H);
}

// KeepAlive.hold(): an extension API call every hbIntervalMs, never a network request.
function startHeartbeat(h) {
  h.hb = setInterval(() => {
    const at = Date.now();
    void api.runtime.getPlatformInfo().then(() => {
      h.hbN += 1;
      void report('hb', { cycle: h.cycle, n: h.hbN, callAt: at, sincePrevMs: h.lastHb === null ? null : at - h.lastHb });
      h.lastHb = at;
    });
  }, CFG.hbIntervalMs);
}
function stopHeartbeat(h) {
  if (h.hb !== null) clearInterval(h.hb);
  h.hb = null;
}

async function sampleLoop(h) {
  for (let i = 0; i < 3; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, CFG.sampleGapMs));
    try {
      const d = await readDetail(`${h.cycle}.s${i}`);
      const offset = d.serverMs - (d.t0 + d.t1) / 2;
      h.samples.push({ i, rtt: d.rtt, offset });
      await report('sample', { cycle: h.cycle, i, t0: d.t0, t1: d.t1, rtt: d.rtt, serverMs: d.serverMs, offset });
    } catch (e) {
      await report('sample-error', { cycle: h.cycle, i, err: String(e) });
    }
  }
  const best = h.samples.reduce((a, b) => (a === null || b.rtt < a.rtt ? b : a), null);
  if (best === null) {
    await report('no-offset', { cycle: h.cycle });
    return;
  }
  const oneWay = best.rtt / 2;
  h.offset = best.offset;
  h.fireAtLocal = h.st.endServerMs - CFG.leadMs - oneWay - best.offset;
  h.st.fireAtLocal = h.fireAtLocal;
  h.st.offset = best.offset;
  h.st.phase = 'sampled';
  await putSt(h.st);
  await report('offset', { cycle: h.cycle, offset: best.offset, rtt: best.rtt, oneWay, fireAtLocal: h.fireAtLocal, endServerMs: h.st.endServerMs });
  const verifyIn = h.fireAtLocal - CFG.verifyLeadMs - Date.now();
  setTimeout(() => void verify(h), Math.max(0, verifyIn));
}

async function verify(h) {
  try {
    const d = await readDetail(`${h.cycle}.v`);
    await report('verify', { cycle: h.cycle, rtt: d.rtt, status: d.status, untilFireMs: h.fireAtLocal - Date.now() });
  } catch (e) {
    await report('verify-error', { cycle: h.cycle, err: String(e) });
  }
  h.st.phase = 'verified';
  await putSt(h.st);
  pauseTicks();
  const setAt = Date.now();
  const setPerf = performance.now();
  const delay = h.fireAtLocal - setAt;
  const perfTarget = setPerf + delay;
  // Timer A (architecture §1.3 as written): one setTimeout from T-verify to
  // fireAt. Measured only; it records its time and does nothing else.
  setTimeout(() => {
    h.single = { actual: Date.now(), perf: performance.now() };
  }, delay);
  // Timer B (staged hops): triggers the dry-run PlaceBid.
  preciseAt(perfTarget, () => void fire(h, perfTarget));
  if (h.worker) h.worker.postMessage({ target: h.fireAtLocal, cycle: h.cycle });
  await report('timer-set', { cycle: h.cycle, delay, setAt, finalHopMs: CFG.finalHopMs });
  if (CFG.runner) {
    // Runner-page variant (T-116 shape): an unfocused popup that runs its own timers.
    const hash = encodeURIComponent(
      JSON.stringify({ lane: CFG.lane, browser: CFG.browser, mode: CFG.mode, collector: CFG.collector, finalHopMs: CFG.finalHopMs, cycle: h.cycle, target: h.fireAtLocal }),
    );
    try {
      const w = await api.windows.create({ type: 'popup', focused: false, width: 260, height: 120, url: `runner.html#${hash}` });
      h.runnerWin = w.id;
    } catch (e) {
      await report('runner-error', { cycle: h.cycle, err: String(e) });
    }
  }
}

async function fire(h, perfTarget) {
  const actual = Date.now();
  const perfActual = performance.now();
  // Idempotency rule: persist the attempt before the request leaves.
  h.st.sentAt = actual;
  h.st.phase = 'sent';
  await putSt(h.st);
  if (CFG.hbStopAtFire) stopHeartbeat(h);
  const sendAt = Date.now();
  const ctrl = new AbortController();
  const abortTimer = setTimeout(() => ctrl.abort(), CFG.abortMs);
  const bid = fetch(`${CFG.sgw}/api/ItemBid/PlaceBid?probe=${CFG.lane}.${h.cycle}.bid`, {
    method: 'POST',
    credentials: 'omit',
    cache: 'no-store',
    headers: { authorization: `Bearer ${CFG.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ itemId: CFG.itemId, bidAmount: '17.00', sellerId: 31, quantity: 1 }),
    signal: ctrl.signal,
  });
  void report('fire', {
    cycle: h.cycle,
    timer: 'staged',
    intended: h.fireAtLocal,
    actual,
    errMs: actual - h.fireAtLocal,
    perfErrMs: perfActual - perfTarget,
    sendLagMs: sendAt - actual,
    sendAt,
  });
  // Report timer A once it has fired (it may fire after B on Firefox).
  const waitSingle = () => {
    if (h.single === undefined) {
      setTimeout(waitSingle, 250);
      return;
    }
    void report('fire-single', {
      cycle: h.cycle,
      timer: 'single',
      intended: h.fireAtLocal,
      actual: h.single.actual,
      errMs: h.single.actual - h.fireAtLocal,
      perfErrMs: h.single.perf - perfTarget,
    });
    startTicks(h.cycle, 'hold');
  };
  setTimeout(waitSingle, 1000);
  let outcome;
  const t0 = performance.now();
  try {
    const res = await bid;
    outcome = { kind: 'response', status: res.status, elapsedMs: performance.now() - t0 };
    await res.text();
  } catch (e) {
    outcome = { kind: ctrl.signal.aborted ? 'aborted' : 'error', err: String(e), elapsedMs: performance.now() - t0 };
  }
  clearTimeout(abortTimer);
  h.st.result = outcome.kind;
  h.st.phase = 'resulted';
  await putSt(h.st);
  await report('bid-result', { cycle: h.cycle, ...outcome });
  try {
    const d = await readDetail(`${h.cycle}.post`);
    await report('post-read', { cycle: h.cycle, rtt: d.rtt, status: d.status });
  } catch (e) {
    await report('post-read-error', { cycle: h.cycle, err: String(e) });
  }
  const releaseIn = h.fireAtLocal + CFG.releaseAfterMs - Date.now();
  setTimeout(() => void release(h), Math.max(0, releaseIn));
}

async function release(h) {
  stopHeartbeat(h);
  h.done = true;
  if (h.worker) h.worker.terminate();
  if (h.runnerWin !== undefined) await api.windows.remove(h.runnerWin).catch(() => undefined);
  tickPhase = 'gap';
  await api.alarms.clear(`recover:${h.cycle}`);
  h.st.phase = 'released';
  await putSt(h.st);
  await report('release', { cycle: h.cycle, holdMs: Date.now() - h.wakeAt, hbCount: h.hbN });
  await arm(h.cycle + 1, h.offset);
}

// Restart path: a fresh instance woken by the recovery alarm finds an
// unfinished cycle in storage.
async function onRecover(cycle) {
  const st = await getSt();
  if (!st || st.cycle !== cycle || st.phase === 'released' || st.phase === 'done') {
    await report('recover-noop', { cycle, phase: st?.phase ?? null });
    return;
  }
  if (H !== null && H.cycle === cycle && !H.done) {
    await report('recover-noop', { cycle, phase: st.phase, sameInstanceStillHolding: true });
    return;
  }
  startTicks(cycle, 'recover');
  const deadInst = st.inst;
  const phaseAtDeath = st.phase;
  if (st.sentAt !== undefined && st.result === undefined) {
    // Sent but no response recorded: ambiguous. Post-read before deciding.
    let postRead = null;
    try {
      const d = await readDetail(`${cycle}.recover`);
      postRead = { ok: d.status === 200, rtt: d.rtt };
    } catch (e) {
      postRead = { ok: false, err: String(e) };
    }
    await report('recovered', { cycle, deadInst, phaseAtDeath, ambiguous: true, sentAt: st.sentAt, postRead });
  } else {
    await report('recovered', { cycle, deadInst, phaseAtDeath, ambiguous: false, missedFire: st.sentAt === undefined, sentAt: st.sentAt ?? null });
  }
  st.phase = 'released';
  st.recoveredBy = INST;
  await putSt(st);
  tickPhase = 'gap';
  await arm(cycle + 1, st.offset ?? st.lastOffset);
}

// ---------------------------------------------------------------- wiring --
// Listeners first, synchronously, so a cold start delivers the waking event.
api.alarms.onAlarm.addListener((alarm) => {
  const nowMs = Date.now();
  const perfNow = performance.now();
  // Do not return the promise: a pending listener promise would itself delay
  // Firefox's idle suspension and bias the measurement.
  void (async () => {
    await bootDone;
    const [kind, c] = alarm.name.split(':');
    if (kind === 'wake') await onWake(Number(c), alarm, nowMs, perfNow);
    else if (kind === 'recover') await onRecover(Number(c));
  })();
});

const bootDone = (async () => {
  const st = await getSt();
  await report('boot', {
    bootMs: BOOT_MS,
    timeOrigin: T_ORIGIN,
    ua: navigator.userAgent,
    prev: st === null ? null : { inst: st.inst, phase: st.phase, cycle: st.cycle },
  });
  if (st === null) await arm(1, null);
  else if (st.phase === 'released' || st.phase === 'armed') startTicks(st.cycle, 'gap');
})();
