import { render } from 'preact';

import type { MessagingClient } from '../../ports/messaging';
import { Dashboard } from './Dashboard';
import { loadSections } from './registry';
import { builtinModules } from './sections';

/** Shared by the Chrome side panel and the Firefox sidebar; the entrypoint supplies the browser-bound pieces. */
export function mountDashboard(root: HTMLElement, client: MessagingClient, openOptions: (section?: string) => void): void {
  render(
    <Dashboard
      client={client}
      sections={loadSections(builtinModules)}
      userTz={Intl.DateTimeFormat().resolvedOptions().timeZone}
      openOptions={openOptions}
    />,
    root,
  );
}
