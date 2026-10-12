// T-116: the snipe runner page (the S-7 verdict's host page).
//
// Its only job is to exist: an open extension window keeps Firefox's
// TimerThread from deferring the background's tight snipe timer
// (docs/spikes/S-7.md), and the runtime port it holds open is the
// background's proof that the page is alive. Nothing here runs a timer or
// touches a network. The text on the page tells the user to leave the window
// alone (R3); the window never takes focus or comes to the front.
//
// The port stays open from the T-5 min wake until the background's
// PageSnipeHost hangs it up on release (which closes this window). The `s`
// URL parameter is for the host's bookkeeping only (it matches the port to
// the snipe); this page never reads it.
import { browser } from 'wxt/browser';

import { SNIPE_HOST_PORT } from '../../adapters/browser/snipe-host-page';

// Held module-wide for as long as the page lives, so the connection stays open.
let port: ReturnType<typeof browser.runtime.connect> | undefined;
try {
  port = browser.runtime.connect({ name: SNIPE_HOST_PORT });
  // The background hangs up on release (which closes this window); either way
  // the reference is dropped so the port is not held after it disconnected.
  port.onDisconnect.addListener(() => {
    port = undefined;
  });
} catch (e) {
  console.warn('[ShopBadwill] the snipe-host port could not be opened', e);
}
