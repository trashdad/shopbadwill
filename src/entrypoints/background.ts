// The background entrypoint (T-36): the Chrome service worker / Firefox event
// page. All wiring is in src/background/main.ts; this only starts it with the
// real `browser`. WXT runs `main` synchronously at the top level of the
// worker, so main.ts can add its listeners in the worker's first turn.
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';

import { startBackground } from '../background/main';

export default defineBackground(() => {
  startBackground({ browser });
});
