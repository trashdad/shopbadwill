import { browser } from 'wxt/browser';

import { createMessagingClient } from '../../messaging/client';
import { mountDashboard } from '../../ui/dashboard/mount';
import '../../ui/dashboard/style.css';

const root = document.getElementById('app');
if (root !== null) {
  mountDashboard(root, createMessagingClient(browser.runtime), () => {
    void browser.runtime.openOptionsPage();
  });
}
