// S-7 timing probe: "runner page" (the T-116 SnipeHost fallback shape), an
// unfocused extension popup window opened by the background at T-verify. It
// runs timer A (single setTimeout) and timer B (staged hops) to the same
// target as the background and reports both. Measure-only. THROWAWAY.
'use strict';
const R = JSON.parse(decodeURIComponent(location.hash.slice(1)));
const send = (type, data) =>
  fetch(`${R.collector}/ev`, {
    method: 'POST',
    body: JSON.stringify({ lane: R.lane, browser: R.browser, mode: R.mode, inst: 'runner', type, at: Date.now(), cycle: R.cycle, ...data }),
  }).catch(() => undefined);

const setPerf = performance.now();
const delay = R.target - Date.now();
const perfTarget = setPerf + delay;
let a = null;
let b = null;
const done = () => {
  if (a === null || b === null) return;
  void send('runner-fire', {
    aErrMs: a - R.target,
    bErrMs: b - R.target,
    visibility: document.visibilityState,
    hasFocus: document.hasFocus(),
  });
};
setTimeout(() => {
  a = Date.now();
  done();
}, delay);
const step = () => {
  const rem = perfTarget - performance.now();
  if (rem <= 0) {
    b = Date.now();
    done();
    return;
  }
  setTimeout(step, rem <= R.finalHopMs ? rem : rem * 0.75);
};
step();
void send('runner-open', { delay, visibility: document.visibilityState, hasFocus: document.hasFocus() });
