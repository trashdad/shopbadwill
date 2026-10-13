import { render } from 'preact';
import { browser } from 'wxt/browser';

import { createMessagingClient } from '../../messaging/client';
import { openDashboard, openOptions, type BrowserLike } from './openers';
import { Popup } from './Popup';
import { loadSections } from './registry';
import './popup.css';

const b = browser as unknown as BrowserLike;
const messaging = createMessagingClient(browser.runtime);

// sidePanel.open() must run inside the click's user gesture, so the window id
// is looked up now rather than at click time.
let windowId: number | undefined;
void browser.windows
  .getCurrent()
  .then((w) => {
    windowId = w.id;
  })
  .catch(() => undefined);

const root = document.getElementById('app');
if (root !== null) {
  render(
    <Popup
      messaging={messaging}
      sections={loadSections()}
      now={() => Date.now()}
      actions={{
        openDashboard: async () => {
          await openDashboard(b, windowId);
          window.close();
        },
        openOptions: async () => {
          await openOptions(b);
          window.close();
        },
      }}
    />,
    root,
  );
}
