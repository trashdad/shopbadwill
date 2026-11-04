// T-71: the onboarding page opens on runtime.onInstalled reason `install` only.
// Update, browser start, extension reload, and loading the module itself must
// not open it. The module subscribes through ctx.lifecycle (main.ts already
// owns the browser listener) and never adds its own.
import { afterEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';

import type { BackgroundContext, InstalledDetails } from '../../../src/background/context';
import { ONBOARDING_PATH, register } from '../../../src/background/jobs/onboarding';

type Triggerable = {
  trigger: (...args: unknown[]) => Promise<unknown>;
  hasListeners: () => boolean;
};

function onboardingUrls(): Promise<string[]> {
  return browser.tabs.query({}).then((tabs) => tabs.flatMap((t) => (t.url?.includes('onboarding.html') === true ? [t.url] : [])));
}

async function settle(): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, 30);
  });
}

describe('onboarding install opener', () => {
  const installed: Array<(details: InstalledDetails) => void> = [];
  const startups: Array<() => void> = [];

  afterEach(() => {
    installed.length = 0;
    startups.length = 0;
  });

  function mount(): void {
    register({
      lifecycle: {
        onInstalled(cb) {
          installed.push(cb);
          return () => {
            const i = installed.indexOf(cb);
            if (i >= 0) installed.splice(i, 1);
          };
        },
        onStartup(cb) {
          startups.push(cb);
          return () => undefined;
        },
      },
    } as BackgroundContext);
  }

  it('opens onboarding.html on install only, not on update, browser start, or reload', async () => {
    const runtimeOnInstalled = browser.runtime.onInstalled as unknown as Triggerable;
    const runtimeOnStartup = browser.runtime.onStartup as unknown as Triggerable;
    mount();

    // Loading the module (service-worker start / extension reload) opens nothing,
    // and it must not listen to the browser events itself.
    expect(startups).toHaveLength(0);
    expect(runtimeOnInstalled.hasListeners()).toBe(false);
    expect(runtimeOnStartup.hasListeners()).toBe(false);
    expect(await onboardingUrls()).toEqual([]);

    await runtimeOnInstalled.trigger({ reason: 'update' });
    await runtimeOnInstalled.trigger({ reason: 'install' });
    await runtimeOnStartup.trigger();
    await settle();
    expect(await onboardingUrls()).toEqual([]);

    for (const reason of ['update', 'chrome_update', 'shared_module_update', 'reload']) {
      for (const cb of installed) cb({ reason });
    }
    await settle();
    expect(await onboardingUrls()).toEqual([]);

    for (const cb of installed) cb({ reason: 'install' });
    await settle();
    expect(await onboardingUrls()).toEqual([browser.runtime.getURL(ONBOARDING_PATH)]);

    for (const cb of installed) cb({ reason: 'update' });
    await settle();
    expect(await onboardingUrls()).toEqual([browser.runtime.getURL(ONBOARDING_PATH)]);
  });
});
