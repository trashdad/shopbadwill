import { browser } from 'wxt/browser';

import { createMessagingClient } from '../../messaging/client';
import { mountDashboard } from '../../ui/dashboard/mount';
import '../../ui/dashboard/style.css';

const root = document.getElementById('app');
if (root !== null) {
  mountDashboard(root, createMessagingClient(browser.runtime), (section) => {
    // openOptionsPage() cannot carry a hash, so open the page in a tab at the section anchor.
    void browser.tabs.create({ url: `${browser.runtime.getURL('/options.html')}#${section ?? ''}` });
  });
}
