// T-116: the snipe runner page (the S-7 verdict's host page).
//
// Its only job is to exist: an open extension window keeps Firefox's
// TimerThread from deferring the background's tight snipe timer
// (docs/spikes/S-7.md), and the runtime port it holds open is the
// background's proof that the page is alive. Nothing here runs a snipe timer
// or touches a network. The text on the page tells the user to leave the
// window alone (R3); the window never takes focus or comes to the front.
//
// The port stays open from the T-5 min wake until the background's
// PageSnipeHost releases the snipe, which closes this window. If the
// background goes away first (a worker that died mid-window, or a suspended
// event page), the port drops while the window stays: the page reconnects
// after a short delay, a bounded number of times. That wakes the background,
// whose restarted host adopts this window (or closes it once its snipe no
// longer needs it). The `s` URL parameter is for the host's bookkeeping only
// (it matches the port to the snipe); this page never reads it.
import { browser } from 'wxt/browser';

import { SNIPE_HOST_PORT } from '../../adapters/browser/snipe-host-page';

/** Wait before reconnecting a dropped port (lets a restarting background come up). */
const RECONNECT_DELAY_MS = 1_000;
/** Reconnects over the page's life: a few worker restarts in one window, never an endless loop. */
const MAX_RECONNECTS = 5;

// Held module-wide for as long as the page lives, so the connection stays open.
let port: ReturnType<typeof browser.runtime.connect> | undefined;
let reconnects = 0;

function connect(): void {
  try {
    port = browser.runtime.connect({ name: SNIPE_HOST_PORT });
  } catch (e) {
    console.warn('[ShopBadwill] the snipe-host port could not be opened', e);
    return;
  }
  port.onDisconnect.addListener(() => {
    port = undefined;
    if (reconnects >= MAX_RECONNECTS) return;
    reconnects += 1;
    setTimeout(connect, RECONNECT_DELAY_MS);
  });
}

connect();
