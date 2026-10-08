// Manual acceptance check for T-01 (not part of CI or the E2E suite):
//
//   pnpm build && node scripts/badge-check.ts
//
// Loads the unpacked Chromium build (.output/chrome-mv3) into Playwright's
// bundled Chromium, makes ONE page load of https://shopgoodwill.com/ (the home
// page; robots.txt disallows search listing URLs, so none are visited), asserts
// the "ShopBadwill ready" badge is mounted inside the content script's Shadow
// DOM, saves test-results/t01-badge.png and exits. No retries, no other pages.
//
// Needs `pnpm exec playwright install chromium` (branded Chrome ignores
// --load-extension).
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const SGW_HOME = 'https://shopgoodwill.com/';
const BADGE_HOST = 'shopbadwill-badge';
const BADGE_TEXT = 'ShopBadwill ready';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const extensionDir = path.join(root, '.output', 'chrome-mv3');
const screenshotPath = path.join(root, 'test-results', 't01-badge.png');

try {
  await access(path.join(extensionDir, 'manifest.json'));
} catch {
  console.error(`No build at ${extensionDir}; run \`pnpm build\` first.`);
  process.exit(1);
}

const userDataDir = await mkdtemp(path.join(tmpdir(), 'sbw-badge-'));
const context = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
});

try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(worker.url()).host;

  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto(SGW_HOME, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator(BADGE_HOST).waitFor({ state: 'attached', timeout: 30_000 });

  const badge = await page.evaluate(
    ([hostName]) => {
      const host = document.querySelector(hostName ?? '');
      const status = host?.shadowRoot?.querySelector('[role="status"]');
      return {
        hostFound: host !== null,
        inShadowRoot: host?.shadowRoot != null,
        text: status?.textContent ?? null,
        lightDomText: host?.textContent ?? null,
      };
    },
    [BADGE_HOST],
  );

  await mkdir(path.dirname(screenshotPath), { recursive: true });
  await page.screenshot({ path: screenshotPath });

  const ok = badge.hostFound && badge.inShadowRoot && badge.text === BADGE_TEXT && badge.lightDomText === '';
  console.log(JSON.stringify({ ok, url: page.url(), extensionId, badge, screenshot: screenshotPath }, null, 2));
  process.exitCode = ok ? 0 : 1;
} finally {
  await context.close();
  await rm(userDataDir, { recursive: true, force: true });
}
