// T-56: notifications. Three pieces, one file because they share the gates:
//
//   deliverDigest   the `notifyDigest` step (steps/notify-digest.ts) and the
//                   quiet-hours alarm call this. One plain notification per run:
//                   "3 new matches in Pyrex".
//   sendLateAdds    an immediate alert for each new match that ends in under
//                   60 min (isLateAdd, I-18). Bypasses quiet hours.
//   register(ctx)   job self-registration (I-01): the deferral alarm and the
//                   click handling for our notifications.
//
// Gates, in order: settings.notifications.enabled (+ .digest for the digest);
// the optional `notifications` permission (absent: audit `notify.skipped`, send
// nothing, R3); quiet hours (digest only: deferred to their end by an alarm that
// carries the run id, so nothing but the alarm needs to survive a restart).
//
// Never sends an SGW request (R6): everything comes from storage.
// Text is plain (R5): tags and control characters are stripped, titles truncated.
// Policy skips (favorite/step skips) are not failures and are never reported.
import { browser } from 'wxt/browser';

import { isFirefox } from '../../adapters/browser/env';
import type { AuditLog } from '../../domain/audit/types';
import { isLateAdd } from '../../domain/notify/late-add';
import type { Repo } from '../../domain/storage/repo';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import { wallParts, zonedWallToInstant } from '../../domain/time/zoned';
import type { EpochMs, ItemId, TrackedItem } from '../../domain/types';
import type { JobRun, Watch } from '../../domain/watches/schema';
import type { Alarms } from '../../ports/alarms';
import type { Notification, Notifier } from '../../ports/notifier';
import type { Permissions } from '../../ports/permissions';
import type { BackgroundContext } from '../context';
import { FAVORITE_SKIP_PREFIX } from './steps/favorite';

export const DIGEST_ALARM_PREFIX = 'sbw:notify:digest:';
export const DIGEST_ID_PREFIX = 'sbw:notify:digest:';
export const LATE_ID_PREFIX = 'sbw:notify:late:';
/** Starts the message of a no-op step skip (T-52's STEP_SKIP_PREFIX; matched by text to avoid a cross-card import). */
const STEP_SKIP_TEXT = 'step skipped: ';

export const TITLE_MAX = 60;
const LISTED_TITLES = 3;

export interface NotifyDeps {
  repo: Repo;
  audit: Pick<AuditLog, 'append' | 'list'>;
  notifier: Notifier;
  permissions: Pick<Permissions, 'contains'>;
  alarms: Pick<Alarms, 'create'>;
}

export type DigestResult = 'sent' | 'deferred' | 'skipped';

// ── Text ────────────────────────────────────────────────────────────────────

/** Plain text: markup and control characters removed, whitespace collapsed. */
export function plainText(s: string): string {
  return (
    s
      .replace(/<[^>]*>/g, ' ')
      // eslint-disable-next-line no-control-regex -- stripping control characters is the point
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function truncateTitle(s: string, max: number = TITLE_MAX): string {
  const t = plainText(s);
  const chars = Array.from(t);
  return chars.length <= max ? t : `${chars
    .slice(0, max - 1)
    .join('')
    .trimEnd()}…`;
}

const plural = (n: number, one: string, many: string): string => `${String(n)} ${n === 1 ? one : many}`;

/** Errors that are policy skips, not failures (never counted, never notified). */
export function isSkipMessage(message: string): boolean {
  const body = message.replace(/^[A-Za-z]+: /, '');
  return body.startsWith(FAVORITE_SKIP_PREFIX) || body.startsWith(STEP_SKIP_TEXT);
}

// ── Quiet hours ─────────────────────────────────────────────────────────────

const minutesOf = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * When quiet hours that cover `now` end (the next `to` on the user's wall
 * clock), or null when `now` is not inside them. Windows may cross midnight
 * ("22:00"-"07:00"); `from === to` means no quiet hours. The end is resolved
 * through the zone, so DST days land on the real instant. A bad zone means "not
 * quiet": a notification is better than a lost one.
 */
export function quietHoursEnd(
  now: EpochMs,
  quiet: { from: string; to: string } | undefined,
  timeZone: string,
): EpochMs | null {
  if (quiet === undefined) return null;
  const from = minutesOf(quiet.from);
  const to = minutesOf(quiet.to);
  if (from === to) return null;
  let w: ReturnType<typeof wallParts>;
  try {
    w = wallParts(now, timeZone);
  } catch {
    return null;
  }
  const m = w.hour * 60 + w.minute;
  const inside = from < to ? m >= from && m < to : m >= from || m < to;
  if (!inside) return null;
  const nextDay = from > to && m >= from ? 1 : 0;
  const wall = Date.UTC(w.year, w.month - 1, w.day + nextDay, Math.floor(to / 60), to % 60);
  const end = zonedWallToInstant(wall, timeZone).ms;
  return end > now ? end : now + 60_000;
}

// ── Gates ───────────────────────────────────────────────────────────────────

async function permitted(deps: NotifyDeps, why: { run: string; itemId?: ItemId }): Promise<boolean> {
  let ok: boolean;
  try {
    ok = await deps.permissions.contains({ permissions: ['notifications'] });
  } catch {
    ok = false;
  }
  if (!ok) {
    await deps.audit.append({
      actor: 'daily-job',
      kind: 'notify.skipped',
      ...(why.itemId === undefined ? {} : { itemId: why.itemId }),
      ref: why.run,
      details: { why: 'notifications permission not granted' },
    });
  }
  return ok;
}

async function alreadyAudited(
  deps: NotifyDeps,
  kind: string,
  match: (e: { ref?: string | undefined; itemId?: number | undefined }) => boolean,
): Promise<boolean> {
  const rows = await deps.audit.list({ limit: 200, kinds: [kind] });
  return rows.some(match);
}

async function safeNotify(
  deps: NotifyDeps,
  n: Notification,
  ctx: { ref: string; itemId?: ItemId },
): Promise<boolean> {
  try {
    await deps.notifier.notify(n);
    return true;
  } catch (e) {
    await deps.audit.append({
      actor: 'daily-job',
      kind: 'notify.failed',
      ...(ctx.itemId === undefined ? {} : { itemId: ctx.itemId }),
      ref: ctx.ref,
      details: { error: plainText(e instanceof Error ? e.message : String(e)).slice(0, 200) },
    });
    return false;
  }
}

// ── Digest ──────────────────────────────────────────────────────────────────

export interface DigestText {
  title: string;
  message: string;
  count: number;
}

/**
 * "3 new matches in Pyrex" (one watch) or "5 new matches in 2 watches". Only
 * matches of watches with `notify` on are counted. Null when there is nothing
 * to say. The body lists up to three titles and, when real failures happened
 * (policy skips excluded), how many.
 */
export function buildDigest(
  run: Pick<JobRun, 'results'>,
  tracked: Readonly<Record<number, TrackedItem | undefined>>,
  watches: readonly Pick<Watch, 'id' | 'name' | 'notify'>[],
): DigestText | null {
  const byId = new Map(watches.map((w) => [w.id, w] as const));
  const titles: string[] = [];
  const names: string[] = [];
  for (const itemId of run.results.newMatches) {
    const item = tracked[itemId];
    if (item === undefined) continue;
    const notifying: Array<Pick<Watch, 'name'>> = [];
    for (const r of item.reasons) {
      if (r.kind !== 'watch' || r.id === undefined) continue;
      const w = byId.get(r.id);
      if (w?.notify === true) notifying.push(w);
    }
    if (notifying.length === 0) continue;
    titles.push(truncateTitle(item.title));
    for (const w of notifying) if (!names.includes(w.name)) names.push(w.name);
  }
  if (titles.length === 0) return null;
  const where = names.length === 1 ? truncateTitle(names[0] ?? '', 40) : plural(names.length, 'watch', 'watches');
  const failures = run.results.errors.filter((e) => !isSkipMessage(e.message)).length;
  const lines = titles.slice(0, LISTED_TITLES);
  if (titles.length > LISTED_TITLES) lines.push(`and ${String(titles.length - LISTED_TITLES)} more`);
  if (failures > 0) lines.push(`${plural(failures, 'step', 'steps')} had errors`);
  return {
    title: `${plural(titles.length, 'new match', 'new matches')} in ${where}`,
    message: lines.join('\n'),
    count: titles.length,
  };
}

/**
 * Sends (or defers) the digest of `run`. Idempotent per run: an audit entry
 * `notify.digest` with ref = run id marks it sent. Never throws for a
 * notification problem; those are audited.
 */
export async function deliverDigest(deps: NotifyDeps, run: Pick<JobRun, 'id' | 'results'>): Promise<DigestResult> {
  const { repo } = deps;
  const settings = await repo.get(STORAGE_KEYS.settings);
  if (!settings.notifications.enabled || !settings.notifications.digest) return 'skipped';
  const [tracked, watches] = await Promise.all([repo.get(STORAGE_KEYS.tracked), repo.get(STORAGE_KEYS.watches)]);
  const digest = buildDigest(run, tracked, watches);
  if (digest === null) return 'skipped';
  if (await alreadyAudited(deps, 'notify.digest', (e) => e.ref === run.id)) return 'skipped';
  if (!(await permitted(deps, { run: run.id }))) return 'skipped';

  const now = repo.now();
  const until = quietHoursEnd(now, settings.notifications.quietHours, settings.locale.timeZone);
  if (until !== null) {
    await deps.alarms.create(DIGEST_ALARM_PREFIX + run.id, { when: until });
    await deps.audit.append({
      actor: 'daily-job',
      kind: 'notify.deferred',
      ref: run.id,
      details: { until, matches: digest.count },
    });
    return 'deferred';
  }
  const ok = await safeNotify(
    deps,
    {
      id: DIGEST_ID_PREFIX + run.id,
      title: digest.title,
      message: digest.message,
      priority: 0,
      ...(deps.notifier.supportsActions ? { actions: [{ id: 'dashboard', title: 'Open dashboard' }] } : {}),
    },
    { ref: run.id },
  );
  if (!ok) return 'skipped';
  await deps.audit.append({ actor: 'daily-job', kind: 'notify.digest', ref: run.id, details: { matches: digest.count } });
  return 'sent';
}

// ── Late add ────────────────────────────────────────────────────────────────

export const itemUrl = (itemId: ItemId): string => `https://shopgoodwill.com/item/${String(itemId)}`;

/**
 * One immediate alert per new match ending in under 60 minutes (isLateAdd),
 * once per item. Quiet hours do not apply: the auction will not wait.
 * Returns the item ids alerted.
 */
export async function sendLateAdds(deps: NotifyDeps, run: Pick<JobRun, 'id' | 'results'>): Promise<ItemId[]> {
  const { repo } = deps;
  const settings = await repo.get(STORAGE_KEYS.settings);
  if (!settings.notifications.enabled) return [];
  const [tracked, watches] = await Promise.all([repo.get(STORAGE_KEYS.tracked), repo.get(STORAGE_KEYS.watches)]);
  const notifyWatch = new Set(watches.filter((w) => w.notify).map((w) => w.id));
  const now = repo.now();
  const sent: ItemId[] = [];
  for (const itemId of run.results.newMatches) {
    const item = tracked[itemId];
    if (item === undefined) continue;
    if (!item.reasons.some((r) => r.kind === 'watch' && r.id !== undefined && notifyWatch.has(r.id))) continue;
    if (!isLateAdd({ itemId, endTime: item.endTime }, now)) continue;
    if (await alreadyAudited(deps, 'notify.late-add', (e) => e.itemId === itemId)) continue;
    if (!(await permitted(deps, { run: run.id, itemId }))) return sent; // same answer for every item
    const minutes = Math.max(1, Math.ceil((new Date(item.endTime).getTime() - now) / 60_000));
    const ok = await safeNotify(
      deps,
      {
        id: LATE_ID_PREFIX + String(itemId),
        title: `Ends in ${String(minutes)} min: ${truncateTitle(item.title, 50)}`,
        message: 'A new match that is ending soon.',
        priority: 1,
        ...(deps.notifier.supportsActions
          ? {
              actions: [
                { id: 'open-item', title: 'Open item' },
                { id: 'dashboard', title: 'Open dashboard' },
              ],
            }
          : {}),
      },
      { itemId, ref: run.id },
    );
    if (!ok) continue;
    await deps.audit.append({ actor: 'daily-job', kind: 'notify.late-add', itemId, ref: run.id, details: { minutes } });
    sent.push(itemId);
  }
  return sent;
}

// ── Click handling ──────────────────────────────────────────────────────────

export interface DashboardBrowser {
  sidebarAction?: { open(): Promise<void> };
  runtime: { openOptionsPage(): Promise<void> };
  tabs?: { create(o: { url: string }): Promise<unknown> };
}
export type DashboardOpened = 'sidebar' | 'options';

/**
 * R4. Firefox: open the sidebar (a notification click is a user action there);
 * if it refuses, the options page. Chrome: sidePanel.open() needs a window and a
 * page gesture a notification click does not give, so the options page.
 */
export async function openDashboardFromNotification(b: DashboardBrowser, firefox: boolean): Promise<DashboardOpened> {
  if (firefox && b.sidebarAction !== undefined) {
    try {
      await b.sidebarAction.open();
      return 'sidebar';
    } catch {
      // fall through to the options page
    }
  }
  await b.runtime.openOptionsPage();
  return 'options';
}

/** Handles `ctx.notifier.onAction` for notifications this module sent; others are ignored. */
export async function handleNotificationAction(
  deps: { browser: DashboardBrowser; firefox: boolean },
  id: string,
  actionId: string,
): Promise<void> {
  const late = id.startsWith(LATE_ID_PREFIX);
  if (!late && !id.startsWith(DIGEST_ID_PREFIX)) return;
  if (actionId === 'open-item' && late) {
    const itemId = Number(id.slice(LATE_ID_PREFIX.length));
    if (Number.isSafeInteger(itemId) && itemId > 0) await deps.browser.tabs?.create({ url: itemUrl(itemId) });
    return;
  }
  if (actionId === 'click' || actionId === 'dashboard') {
    await openDashboardFromNotification(deps.browser, deps.firefox);
  }
}

// ── Registration ────────────────────────────────────────────────────────────

/** The deferral alarm fired: rebuild the digest from the stored run and try again (quiet hours may have changed). */
export async function onDigestAlarm(deps: NotifyDeps, runId: string): Promise<DigestResult> {
  const runs = await deps.repo.get(STORAGE_KEYS.jobRuns);
  const run = runs.find((r) => r.id === runId);
  return run === undefined ? 'skipped' : deliverDigest(deps, run);
}

export function register(ctx: BackgroundContext): void {
  const deps: NotifyDeps = {
    repo: ctx.repo,
    audit: ctx.audit,
    notifier: ctx.notifier,
    permissions: ctx.permissions,
    alarms: ctx.alarms,
  };
  ctx.alarms.onAlarm((alarm) => {
    if (!alarm.name.startsWith(DIGEST_ALARM_PREFIX)) return;
    void onDigestAlarm(deps, alarm.name.slice(DIGEST_ALARM_PREFIX.length)).catch(() => undefined);
  });
  ctx.notifier.onAction((id, actionId) => {
    void handleNotificationAction({ browser: browser, firefox: isFirefox() }, id, actionId).catch(
      () => undefined,
    );
  });
}
