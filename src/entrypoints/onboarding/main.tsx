import { render } from 'preact';
import { browser } from 'wxt/browser';

import { BrowserPermissions } from '../../adapters/browser/permissions';
import { createMessagingClient } from '../../messaging/client';
import { pickSearchTab } from '../options/sections/watches/draft';
import { Onboarding } from './Onboarding';
import { googleOptionsUrl } from './steps';
import './style.css';

/** The most recently used ShopGoodwill search tab, or undefined when none is open. */
async function activeSgwSearchTab(): Promise<string | undefined> {
  try {
    const tabs = await browser.tabs.query({ url: ['https://shopgoodwill.com/*'] });
    return pickSearchTab(tabs);
  } catch {
    return undefined;
  }
}

const root = document.getElementById('app');
if (root !== null) {
  render(
    <Onboarding
      client={createMessagingClient(browser.runtime)}
      permissions={new BrowserPermissions()}
      getActiveTabUrl={activeSgwSearchTab}
      openGoogleOptions={() => {
        // openOptionsPage() cannot carry a hash, so open the page at the Google anchor (T-70).
        void browser.tabs
          .create({ url: googleOptionsUrl(browser.runtime.getURL('/options.html')) })
          .then(
            () => undefined,
            () => undefined,
          );
      }}
      openOptions={() => {
        void browser.runtime.openOptionsPage().then(
          () => undefined,
          () => undefined,
        );
      }}
    />,
    root,
  );
}
