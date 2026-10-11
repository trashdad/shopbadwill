import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';

// Integration-suite smoke test: fake browser alarms plus MSW intercepting
// fetch. The host is a reserved .test name, so nothing can reach the network.
const server = setupServer(
  http.get('https://api.example.test/ping', () => HttpResponse.json({ pong: true })),
);

describe('integration suite smoke', () => {
  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' });
  });
  afterAll(() => {
    server.close();
  });
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it('creates and reads an alarm on the fake browser', async () => {
    await browser.alarms.create('sbw:smoke', { delayInMinutes: 1 });
    expect(await browser.alarms.get('sbw:smoke')).toMatchObject({ name: 'sbw:smoke' });
  });

  it('serves a mocked HTTP response', async () => {
    const response = await fetch('https://api.example.test/ping');
    expect(await response.json()).toEqual({ pong: true });
  });
});
