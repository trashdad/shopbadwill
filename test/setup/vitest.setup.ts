import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

/**
 * Shared MSW server for every suite. Tests add handlers with `mswServer.use()`;
 * they are dropped after each test.
 *
 * Unhandled requests to loopback (the in-process fake servers on 127.0.0.1) are
 * bypassed, so MSW never intercepts them. Any other unhandled request fails
 * loudly: no test may reach a real host.
 */
export const mswServer = setupServer();

function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

beforeAll(() => {
  mswServer.listen({
    onUnhandledRequest(request, print) {
      if (isLoopback(request.url)) return;
      print.error();
    },
  });
});

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  mswServer.resetHandlers();
});

afterAll(() => {
  mswServer.close();
});
