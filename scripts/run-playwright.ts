// Runs the Chromium E2E suite with optional spec filters:
//
//   pnpm test:e2e:chromium [filter...]   e.g. pnpm test:e2e:chromium -- overlay
//
// - A `--` (as written in task gates) is dropped; Playwright would otherwise
//   ignore every filter after it and run all specs.
// - With no filter, an empty suite passes (specs arrive with T-39). With a
//   filter that matches no spec, the run fails, so a mistyped gate can never
//   pass vacuously.
// - Each run gets its own fake-server ports (T-39b): three free loopback ports
//   go into SBW_FAKE_SGW_PORT, FAKE_GOOGLE_PORT and SBW_FAKE_SITE_PORT, which
//   playwright.config.ts, the fake servers and the specs read
//   (test/e2e/chromium/network.ts). A var already set is kept.
import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FAKE_PORT_ENV } from '../test/e2e/chromium/network';

// `playwright test` options that take a separate value (`--opt value`), from
// `playwright test --help` (1.63).
const OPTIONS_WITH_VALUE = new Set([
  '--add-reporter', '--browser', '-c', '--config', '-g', '--grep', '-G', '--grep-invert',
  '--global-timeout', '-j', '--workers', '--last-failed-file', '--max-failures', '--output',
  '--project', '--repeat-each', '--reporter', '--retries', '--run-agents', '--shard',
  '--test-list', '--test-list-invert', '--timeout', '--trace', '--tsconfig', '--ui-host',
  '--ui-port', '--update-source-method',
]);

const args = process.argv.slice(2).filter((arg) => arg !== '--');
const hasFilter = args.some(
  (arg, i) => !arg.startsWith('-') && !OPTIONS_WITH_VALUE.has(args[i - 1] ?? ''),
);

const playwrightArgs = ['test', ...(hasFilter ? [] : ['--pass-with-no-tests']), ...args];
console.log(`> playwright ${playwrightArgs.join(' ')}`);

/** `count` distinct free ports on 127.0.0.1: all held open together, then released for the fakes to bind. */
async function freePorts(count: number): Promise<number[]> {
  const servers = await Promise.all(
    Array.from(
      { length: count },
      () =>
        new Promise<Server>((resolve, reject) => {
          const server = createServer();
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => {
            resolve(server);
          });
        }),
    ),
  );
  const ports = servers.map((server) => {
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('free port: no address');
    return addr.port;
  });
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
  return ports;
}

const unset = Object.values(FAKE_PORT_ENV).filter((name) => !process.env[name]);
const ports = await freePorts(unset.length);
const env: NodeJS.ProcessEnv = { ...process.env };
unset.forEach((name, i) => {
  env[name] = String(ports[i]);
});
console.log(`> fake-server ports: ${Object.values(FAKE_PORT_ENV).map((name) => `${name}=${env[name] ?? ''}`).join(' ')}`);

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const playwrightCli = path.join(root, 'node_modules', '@playwright', 'test', 'cli.js');
const result = spawnSync(process.execPath, [playwrightCli, ...playwrightArgs], { cwd: root, env, stdio: 'inherit' });
process.exit(result.status ?? 1);
