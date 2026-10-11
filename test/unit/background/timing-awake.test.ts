// T-90: `timing.awake` returns the persisted sbw:awake heartbeat history.
// UI only, empty request. A missing or invalid record answers an empty array
// (the repo's default after quarantine), never a thrown error.
import { beforeEach, describe, expect, it } from 'vitest';

import { register } from '../../../src/background/handlers/timing';
import { createRouter, type Router, type RouterSender } from '../../../src/background/router';
import type { BackgroundContext } from '../../../src/background/context';
import { Repo } from '../../../src/domain/storage/repo';
import { STORAGE_KEYS } from '../../../src/domain/storage/schema';
import { FakeClock } from '../../fakes/ports/fake-clock';
import { FakeStorageAreas } from '../../fakes/ports/fake-storage';

const EXT_ID = 'ext-id';
const CONTENT: RouterSender = { id: EXT_ID, url: 'https://shopgoodwill.com/categories/listing?st=x', tab: { id: 3 } };
const UI: RouterSender = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/dashboard.html` };
const BEAT = 1_791_400_000_000;

const env = () => ({ v: 1, reqId: 'r-timing-awake', type: 'timing.awake' });

let areas: FakeStorageAreas;
let repo: Repo;
let router: Router;

beforeEach(() => {
  areas = new FakeStorageAreas();
  repo = new Repo(areas, new FakeClock(BEAT));
  router = createRouter({
    runtimeId: EXT_ID,
    getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
    isQuickFavoriteEnabled: () => false,
    log: () => undefined,
  });
  register({ router, repo } as unknown as BackgroundContext);
});

describe('timing.awake', () => {
  it('answers an empty array when nothing is stored', async () => {
    expect(await router.handle(env(), UI)).toEqual({ ok: true, reply: [] });
  });

  it('answers the persisted heartbeat history', async () => {
    await repo.set(STORAGE_KEYS.awake, [BEAT, BEAT + 60_000]);
    expect(await router.handle(env(), UI)).toEqual({ ok: true, reply: [BEAT, BEAT + 60_000] });
  });

  it('an invalid record is quarantined and answers an empty array', async () => {
    await areas.local.set({ [STORAGE_KEYS.awake]: [-1, 'nope'] });
    expect(await router.handle(env(), UI)).toEqual({ ok: true, reply: [] });
    const quarantined = await areas.local.get<unknown>(`sbw:quarantine:${STORAGE_KEYS.awake}`);
    expect(quarantined).toMatchObject({ value: [-1, 'nope'] });
    expect(await areas.local.get(STORAGE_KEYS.awake)).toBeUndefined();
  });

  it('a content script may not send it', async () => {
    await repo.set(STORAGE_KEYS.awake, [BEAT]);
    const r = await router.handle(env(), CONTENT);
    expect(r).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await repo.get(STORAGE_KEYS.awake)).toEqual([BEAT]);
  });
});
