// S-7 timing probe, timer C: a dedicated Worker spawned by the Firefox event page
// (Chrome service workers cannot create workers). Measure-only: it records when
// its own setTimeout ran, off the event page's main thread. THROWAWAY.
'use strict';
self.onmessage = (e) => {
  const { target, cycle } = e.data;
  const setPerf = performance.now();
  const delay = target - Date.now();
  setTimeout(() => {
    const actual = Date.now();
    self.postMessage({ cycle, target, actual, perfErrMs: performance.now() - (setPerf + delay) });
  }, delay);
};
