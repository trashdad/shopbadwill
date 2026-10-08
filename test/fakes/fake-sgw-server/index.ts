// `pnpm fake:sgw`: starts the fake buyerapi on 127.0.0.1:8787.
// Env: SBW_FAKE_SGW_PORT (default 8787), SBW_FAKE_SGW_SCENARIO (named preset).
import { startFakeSgw } from './server';

export { startFakeSgw } from './server';
export type { FakeSgw, FakeSgwOptions } from './server';

const isMain = process.argv[1] !== undefined && /fake-sgw-server[\\/]index\.ts$/.test(process.argv[1]);
if (isMain) {
  const port = Number(process.env.SBW_FAKE_SGW_PORT ?? 8787);
  const scenario = process.env.SBW_FAKE_SGW_SCENARIO;
  const sgw = await startFakeSgw({ port, ...(scenario ? { scenario } : {}) });
  console.log(`fake:sgw listening on ${sgw.url}`);
  const stop = (): void => {
    void sgw.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
