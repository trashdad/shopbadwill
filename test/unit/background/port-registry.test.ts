// T-118 (L9): the read-only UI streams (`sbw:snipe-countdown`, `sbw:job-progress`)
// are served only to the extension's own pages, like `sbw:live-gate`. A content
// script on shopgoodwill.com that connects is disconnected before any handler sees it.
import { describe, expect, it, vi } from 'vitest';

import { Channel, createPortRegistry, EventGate, type RuntimePort } from '../../../src/background/context';
import { PORT_NAMES } from '../../../src/messaging/protocol';

function port(name: string, url: string | undefined) {
  const disconnect = vi.fn<() => void>();
  const p: RuntimePort = {
    name,
    ...(url === undefined ? {} : { sender: { id: 'sbwtestid', url } }),
    postMessage: () => undefined,
    disconnect,
    onMessage: { addListener: () => undefined, removeListener: () => undefined },
    onDisconnect: { addListener: () => undefined, removeListener: () => undefined },
  };
  return { port: p, disconnect };
}

function registry() {
  const gate = new EventGate(() => undefined);
  gate.open();
  const connections = new Channel<[RuntimePort]>(gate);
  return { connections, ports: createPortRegistry(connections) };
}

describe('port registry: UI-only streams (T-118 L9)', () => {
  for (const name of [PORT_NAMES.snipeCountdown, PORT_NAMES.jobProgress]) {
    it(`${name}: a content script or an unknown sender is disconnected, an extension page is served`, () => {
      const { connections, ports } = registry();
      const served: string[] = [];
      ports.serve(name, (p) => served.push(p.sender?.url ?? 'none'));
      const content = port(name, 'https://shopgoodwill.com/item/1');
      const anon = port(name, undefined);
      const page = port(name, 'chrome-extension://sbwtestid/sidepanel.html');
      const firefoxPage = port(name, 'moz-extension://abc/sidebar.html');
      for (const p of [content, anon, page, firefoxPage]) connections.emit(p.port);
      expect(served).toEqual(['chrome-extension://sbwtestid/sidepanel.html', 'moz-extension://abc/sidebar.html']);
      expect(content.disconnect).toHaveBeenCalled();
      expect(anon.disconnect).toHaveBeenCalled();
      expect(page.disconnect).not.toHaveBeenCalled();
    });
  }

  it('other port names are dispatched as before', () => {
    const { connections, ports } = registry();
    const served: string[] = [];
    ports.serve('sbw:snipe-host', (p) => served.push(p.name));
    connections.emit(port('sbw:snipe-host', 'https://shopgoodwill.com/').port);
    expect(served).toEqual(['sbw:snipe-host']);
  });
});
