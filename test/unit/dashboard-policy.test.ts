import { describe, expect, it, vi } from 'vitest';

import { FAVORITE_SKIP_PREFIX as BACKGROUND_PREFIX } from '../../src/background/jobs/steps/favorite';
import { createMessagingClient, type ClientPort, type ClientRuntime } from '../../src/messaging/client';
import { PORT_NAMES } from '../../src/messaging/protocol';
import { FAVORITE_SKIP_PREFIX } from '../../src/ui/dashboard/policy';

describe('dashboard policy-skip prefix', () => {
  it('equals the background constant it copies', () => {
    expect(FAVORITE_SKIP_PREFIX).toBe(BACKGROUND_PREFIX);
  });
});

describe('messaging client connect onDisconnect', () => {
  function fakeRuntime() {
    let gone: (() => void) | undefined;
    const port: ClientPort = {
      onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
      disconnect: vi.fn(),
      onDisconnect: {
        addListener: (l) => {
          gone = l;
        },
        removeListener: vi.fn(() => {
          gone = undefined;
        }),
      },
    };
    const runtime = { sendMessage: vi.fn(), connect: vi.fn(() => port), onMessage: { addListener: vi.fn(), removeListener: vi.fn() } } as unknown as ClientRuntime;
    return { runtime, port, fire: () => gone?.() };
  }

  it('calls the callback when the port disconnects, and not after we disconnect', () => {
    const { runtime, fire } = fakeRuntime();
    const cb = vi.fn();
    const stop = createMessagingClient(runtime).connect(PORT_NAMES.jobProgress, () => undefined, cb);
    fire();
    expect(cb).toHaveBeenCalledTimes(1);
    stop();
    fire();
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('does not touch onDisconnect when no callback is given', () => {
    const { runtime, fire } = fakeRuntime();
    const stop = createMessagingClient(runtime).connect(PORT_NAMES.jobProgress, () => undefined);
    expect(() => {
      fire();
      stop();
    }).not.toThrow();
  });
});
