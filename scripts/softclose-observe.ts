// S-3 (T-09) soft-close observer: does an SGW auction's end time move when
// someone bids in its last seconds?
//
// Design A of the controller ruling (at most 12 anonymous SGW requests in total):
//   1. ONE search (`search`), ending-soonest, ≥10 min before every chosen item's
//      end. Each chosen row's `endTime` is that item's `endTimeAtFirstRead`
//      (search rows and ItemDetail both carry whole-second `endTime`; the script
//      refuses fractional rows, and the analysis flags a fractional post-read).
//   2. ONE ItemDetail read per item, ≥10 min after its original end (`observe`).
//      6 items = 7 requests, leaving 5 spare for one re-search or for re-reading
//      an item that is not yet closed at its post-read.
// No polling near close: nothing is sent between the search and the post-reads.
//
// Light and anonymous (PLAN §4 S-1, §7.2): the transport, deny-by-default URL
// guard, pending-line log and lockfile logic are imported from
// capture-fixtures.ts (not modified); on top of them this script allows ONLY the
// search POST and ItemDetail GET, keeps its own log/cap (12) and also waits out
// 120 s after the last request in T-07's log, so the two scripts never send
// within 120 s of each other. No cookie, no Authorization, the browser's own UA.
//
// Raw responses go to test/fixtures/sgw/raw/softclose/ (git-ignored). Run:
//   pnpm exec tsx scripts/softclose-observe.ts search      # one request, writes plan.json
//   pnpm exec tsx scripts/softclose-observe.ts observe     # hours; run in the background
//   pnpm exec tsx scripts/softclose-observe.ts report      # offline: table + verdict from raw/
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { SGW_API_BASE, SGW_ENDPOINTS, SGW_SEARCH_BODY_DEFAULTS } from '../src/adapters/sgw/config';
import { parsePacific } from '../src/domain/time/pacific';
import {
  acquireCaptureLock,
  appendPendingRequest,
  assertLogWithinRules,
  CAPTURE_MIN_SPACING_MS,
  checkCaptureUrl,
  openCaptureSession,
  RAW_DIR,
  readRequestLog,
  runCaptureStep,
  type RequestLogEntry,
} from './capture-fixtures';

// ---------------------------------------------------------------------------
// Constants (the brief's values)
// ---------------------------------------------------------------------------

/** Controller ruling: total SGW requests for S-3, including the picking search. */
export const SC_MAX_REQUESTS = 12;
export const SC_TARGET_ITEMS = 6;
export const SC_MIN_BIDS = 3;
/** Items must end within this long after the search. */
export const SC_HORIZON_MS = 3 * 3_600_000;
/** The search must run at least this long before an item's end (10 min + 2 min margin). */
export const SC_MIN_LEAD_MS = 12 * 60_000;
/** A post-read is sent at least this long after the item's (original or extended) end (10 min + 30 s margin). */
export const SC_POST_DELAY_MS = 10 * 60_000 + 30_000;
/** Safety margin on top of the 120 s Crawl-delay. */
export const SC_SPACING_MS = CAPTURE_MIN_SPACING_MS + 10_000;
/** A bid this close to (or after) the original end counts as a "late bid". */
export const LATE_BID_WINDOW_MS = 60_000;
/** Evidence needed for a `hard-close` verdict: this many items with a late bid whose end did not move. */
export const HARD_CLOSE_MIN_ITEMS = 2;
export const MAX_REREADS_PER_ITEM = 2;

const WHOLE_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;

// ---------------------------------------------------------------------------
// Pure parts (unit-tested with synthetic data in test/unit/scripts/softclose-observe.test.ts)
// ---------------------------------------------------------------------------

export interface SearchRow {
  itemId: number;
  endRaw: string;
  endMs: number;
  numBids: number;
}

/** Search reply -> rows with a parseable endTime. Throws when the reply has no `searchResults.items`. */
export function parseSearchRows(json: unknown): SearchRow[] {
  const items = (json as { searchResults?: { items?: unknown } } | null)?.searchResults?.items;
  if (!Array.isArray(items)) throw new Error('search reply has no searchResults.items');
  const rows: SearchRow[] = [];
  for (const it of items as Array<Record<string, unknown>>) {
    if (typeof it.itemId !== 'number' || typeof it.endTime !== 'string' || typeof it.numBids !== 'number') continue;
    let endMs: number;
    try {
      endMs = parsePacific(it.endTime);
    } catch {
      continue;
    }
    rows.push({ itemId: it.itemId, endRaw: it.endTime, endMs, numBids: it.numBids });
  }
  return rows;
}

export interface Selection {
  chosen: SearchRow[];
  /** Why rows were left out, for the plan log. */
  excluded: { fewBids: number; tooSoon: number; tooLate: number; fractionalEnd: number; duplicate: number };
}

/**
 * Picks up to `target` items: ≥ SC_MIN_BIDS bids, whole-second endTime, ending
 * between SC_MIN_LEAD_MS and SC_HORIZON_MS after `searchEndedAtMs`. Prefers
 * more bids (a late bid is likelier) and, first, distinct end times. Returned
 * in end-time order.
 */
export function selectItems(rows: readonly SearchRow[], searchEndedAtMs: number, target: number = SC_TARGET_ITEMS): Selection {
  const excluded = { fewBids: 0, tooSoon: 0, tooLate: 0, fractionalEnd: 0, duplicate: 0 };
  const seen = new Set<number>();
  const eligible: SearchRow[] = [];
  for (const r of rows) {
    if (seen.has(r.itemId)) {
      excluded.duplicate++;
      continue;
    }
    seen.add(r.itemId);
    if (r.numBids < SC_MIN_BIDS) excluded.fewBids++;
    else if (!WHOLE_SECOND.test(r.endRaw)) excluded.fractionalEnd++;
    else if (r.endMs - searchEndedAtMs < SC_MIN_LEAD_MS) excluded.tooSoon++;
    else if (r.endMs - searchEndedAtMs > SC_HORIZON_MS) excluded.tooLate++;
    else eligible.push(r);
  }
  const ranked = [...eligible].sort((a, b) => b.numBids - a.numBids || a.endMs - b.endMs || a.itemId - b.itemId);
  const chosen: SearchRow[] = [];
  const ends = new Set<number>();
  for (const r of ranked) {
    if (chosen.length >= target) break;
    if (ends.has(r.endMs)) continue;
    chosen.push(r);
    ends.add(r.endMs);
  }
  for (const r of ranked) {
    if (chosen.length >= target) break;
    if (!chosen.includes(r)) chosen.push(r);
  }
  return { chosen: chosen.sort((a, b) => a.endMs - b.endMs || a.itemId - b.itemId), excluded };
}

/** Labels A, B, C, ... in end-time order. */
export function labelFor(index: number): string {
  return String.fromCharCode(65 + index);
}

/**
 * Earliest send time of each post-read, in end-time order: SC_POST_DELAY_MS
 * after the item's end, and SC_SPACING_MS after the previous read. `floorMs`
 * is the earliest any request may start (spacing after the last logged one).
 */
export function scheduleReads(endsMs: readonly number[], floorMs: number): number[] {
  const out: number[] = [];
  let prev = floorMs - SC_SPACING_MS;
  for (const end of [...endsMs].sort((a, b) => a - b)) {
    const at = Math.max(end + SC_POST_DELAY_MS, prev + SC_SPACING_MS, floorMs);
    out.push(at);
    prev = at;
  }
  return out;
}

/** Earliest start of the next request given every log that shares this IP: spacing after the latest END (T-07's log included). */
export function earliestSendMs(logs: ReadonlyArray<readonly RequestLogEntry[]>): number {
  let latest = 0;
  for (const log of logs) for (const e of log) latest = Math.max(latest, e.endedAtMs + SC_SPACING_MS);
  return latest;
}

export function requestsRemaining(used: number, cap: number = SC_MAX_REQUESTS): number {
  return Math.max(0, cap - used);
}

/** Throws when the S-3 log breaks the 12-request cap, the 120 s spacing or the anonymity rule. */
export function assertSoftcloseLog(log: readonly RequestLogEntry[]): void {
  if (log.length > SC_MAX_REQUESTS) throw new Error(`softclose log has ${String(log.length)} requests (cap ${String(SC_MAX_REQUESTS)})`);
  assertLogWithinRules(log);
}

export interface BidPoint {
  timeMs: number;
  retracted: boolean;
}

export interface DetailSnapshot {
  serverTimeMs: number;
  endRaw: string;
  endMs: number;
  closed: boolean;
  numBids: number;
  bids: BidPoint[];
}

/** ItemDetail reply -> what the verdict needs. Throws on a reply without endTime/serverTime. */
export function parseDetail(json: unknown): DetailSnapshot {
  const d = json as Record<string, unknown> | null;
  if (d === null || typeof d !== 'object' || typeof d.endTime !== 'string' || typeof d.serverTime !== 'string') {
    throw new Error('ItemDetail reply has no endTime/serverTime');
  }
  const h = (d.bidHistory ?? {}) as { auctionClosed?: unknown; bidComplete?: unknown; bidSummary?: unknown };
  const complete = Array.isArray(h.bidComplete) ? (h.bidComplete as Array<Record<string, unknown>>) : [];
  const summary = Array.isArray(h.bidSummary) ? (h.bidSummary as Array<Record<string, unknown>>) : [];
  const toBids = (rows: Array<Record<string, unknown>>, timeKey: string): BidPoint[] =>
    rows.flatMap((r) => (typeof r[timeKey] === 'string' ? [{ timeMs: parsePacific(r[timeKey]), retracted: r.retracted === true }] : []));
  const bids = complete.length > 0 ? toBids(complete, 'bidTime') : toBids(summary, 'time');
  return {
    serverTimeMs: parsePacific(d.serverTime),
    endRaw: d.endTime,
    endMs: parsePacific(d.endTime),
    closed: h.auctionClosed === true || d.isItemEndTimeExpire === true,
    numBids: typeof d.numberOfBids === 'number' ? d.numberOfBids : bids.length,
    bids,
  };
}

export interface ItemAnalysis {
  label: string;
  originalEndMs: number;
  finalEndMs: number;
  /** finalEnd - originalEnd. */
  shiftMs: number;
  moved: boolean;
  closedAtRead: boolean;
  /** Last non-retracted bid, relative to the ORIGINAL end (negative = before). null with no bids. */
  lastBidRelMs: number | null;
  /** Last bid relative to the FINAL end (negative = before the final end). */
  lastBidToFinalEndMs: number | null;
  /** Non-retracted bids within LATE_BID_WINDOW_MS before the original end, or after it. */
  lateBids: number;
  bidsAfterOriginalEnd: number;
  bidsAtSearch: number;
  /** Bids placed since the search (numBids at read - at search). */
  newBidsSinceSearch: number;
  readAfterFinalEndMs: number;
  /** Post-read endTime had a fraction (the precision match for design A fails). */
  fractionalFinalEnd: boolean;
}

export function analyzeItem(label: string, originalEndMs: number, numBidsAtSearch: number, snap: DetailSnapshot): ItemAnalysis {
  const live = snap.bids.filter((b) => !b.retracted).sort((a, b) => a.timeMs - b.timeMs);
  const last = live.at(-1);
  return {
    label,
    originalEndMs,
    finalEndMs: snap.endMs,
    shiftMs: snap.endMs - originalEndMs,
    moved: snap.endMs !== originalEndMs,
    closedAtRead: snap.closed,
    lastBidRelMs: last === undefined ? null : last.timeMs - originalEndMs,
    lastBidToFinalEndMs: last === undefined ? null : last.timeMs - snap.endMs,
    lateBids: live.filter((b) => b.timeMs - originalEndMs >= -LATE_BID_WINDOW_MS).length,
    bidsAfterOriginalEnd: live.filter((b) => b.timeMs > originalEndMs).length,
    bidsAtSearch: numBidsAtSearch,
    newBidsSinceSearch: snap.numBids - numBidsAtSearch,
    readAfterFinalEndMs: snap.serverTimeMs - snap.endMs,
    fractionalFinalEnd: !WHOLE_SECOND.test(snap.endRaw),
  };
}

export type Verdict =
  | { kind: 'hard-close'; extensionMs: 0; why: string }
  | { kind: 'soft-close'; extensionMs: number; why: string }
  | { kind: 'inconclusive'; extensionMs: null; why: string };

/** `hard-close` | `soft-close(+N s)` | `inconclusive`, as PLAN §4 S-3 words it. */
export function verdictLabel(v: Verdict): string {
  return v.kind === 'soft-close' ? `soft-close(+${String(Math.round(v.extensionMs / 1000))} s)` : v.kind;
}

/**
 * - soft-close: at least one CLOSED item's endTime moved. N = the largest shift
 *   seen (the engine must wait at least that long past the original end).
 * - hard-close: no item moved and at least HARD_CLOSE_MIN_ITEMS closed items
 *   took a bid within LATE_BID_WINDOW_MS of their original end (or after it).
 * - inconclusive: anything else (too few late bids, or items still open).
 */
export function computeVerdict(items: readonly ItemAnalysis[]): Verdict {
  const closed = items.filter((i) => i.closedAtRead);
  const moved = closed.filter((i) => i.moved && i.shiftMs > 0);
  if (moved.length > 0) {
    const n = Math.max(...moved.map((i) => i.shiftMs));
    return { kind: 'soft-close', extensionMs: n, why: `${String(moved.length)} of ${String(closed.length)} closed items ended later than their original endTime (largest shift ${String(n)} ms)` };
  }
  const late = closed.filter((i) => i.lateBids > 0);
  if (late.length >= HARD_CLOSE_MIN_ITEMS) {
    return { kind: 'hard-close', extensionMs: 0, why: `${String(late.length)} closed items took a bid within ${String(LATE_BID_WINDOW_MS / 1000)} s of their original end and none moved` };
  }
  return {
    kind: 'inconclusive',
    extensionMs: null,
    why: `only ${String(late.length)} closed item(s) took a bid within ${String(LATE_BID_WINDOW_MS / 1000)} s of the original end (need ${String(HARD_CLOSE_MIN_ITEMS)}); ${String(items.length - closed.length)} item(s) not closed at their read`,
  };
}

/** Relative time as "+1.234 s" / "-5.84 s" (ms precision, sign always shown); "n/a" for null. */
export function formatRel(ms: number | null): string {
  if (ms === null) return 'n/a';
  const sign = ms < 0 ? '-' : '+';
  return `${sign}${(Math.abs(ms) / 1000).toFixed(3)} s`;
}

/** Whether (and when) an item still open at its post-read should be read again. null = no more reads. */
export function rereadAt(snap: DetailSnapshot, readsSoFar: number, requestsUsed: number): number | null {
  if (snap.closed || readsSoFar > MAX_REREADS_PER_ITEM || requestsRemaining(requestsUsed) <= 0) return null;
  return Math.max(snap.endMs + SC_POST_DELAY_MS, snap.serverTimeMs + 10 * 60_000);
}

/** Markdown table for docs/spikes/S-3.md: labels and relative times only, no identifiers. */
export function renderTable(items: readonly ItemAnalysis[]): string {
  const head = '| Item | Bids at search | New bids | Last bid vs original end | Late bids (<=60 s before end or after) | Final endTime vs original | Moved | Closed at read | Read after final end |';
  const sep = '|---|---|---|---|---|---|---|---|---|';
  const rows = items.map(
    (i) => `| ${i.label} | ${String(i.bidsAtSearch)} | ${String(i.newBidsSinceSearch)} | ${formatRel(i.lastBidRelMs)} | ${String(i.lateBids)} | ${formatRel(i.shiftMs)} | ${i.moved ? 'YES' : 'no'} | ${i.closedAtRead ? 'yes' : 'NO'} | ${formatRel(i.readAfterFinalEndMs)} |`,
  );
  return [head, sep, ...rows].join('\n');
}

// ---------------------------------------------------------------------------
// Live session (not unit-tested)
// ---------------------------------------------------------------------------

const SC_DIR = path.join(RAW_DIR, 'softclose');
const LOG_FILE = path.join(SC_DIR, 'request-log.jsonl');
const PLAN_FILE = path.join(SC_DIR, 'plan.json');
const LOCK_FILE = path.join(SC_DIR, 'softclose.lock');
const STOPPED_FILE = path.join(SC_DIR, 'STOPPED');

/** Logs shared with other SGW scripts on this machine: T-07's capture log, wherever its checkout is. */
function foreignLogFiles(): string[] {
  const root = path.dirname(RAW_DIR); // .../test/fixtures/sgw
  const candidates = [
    path.join(RAW_DIR, 'request-log.jsonl'),
    path.resolve(root, '../../../../shopbadwill-wt/T-07/test/fixtures/sgw/raw/request-log.jsonl'),
    'C:\\tools\\shopbadwill\\test\\fixtures\\sgw\\raw\\request-log.jsonl',
    ...(process.env.SOFTCLOSE_FOREIGN_LOGS ?? '').split(path.delimiter).filter((p) => p !== ''),
  ];
  return [...new Set(candidates.map((p) => path.resolve(p)))].filter((p) => existsSync(p));
}

function log(msg: string): void {
  console.log(`[softclose ${new Date().toISOString()}] ${msg}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Sleeps until `targetMs`, re-checking the wall clock so a suspended machine does not oversleep the plan. */
async function sleepUntil(targetMs: number): Promise<void> {
  for (;;) {
    const left = targetMs - Date.now();
    if (left <= 0) return;
    await sleep(Math.min(left, 30_000));
  }
}

interface PlanItem {
  label: string;
  itemId: number;
  endRaw: string;
  endMs: number;
  numBidsAtSearch: number;
}

interface Plan {
  createdAtMs: number;
  searchSeq: number;
  searchEndedAtMs: number;
  rowsSeen: number;
  excluded: Selection['excluded'];
  items: PlanItem[];
}

type Step = { id: string; url: string; method: 'GET' | 'POST'; body?: unknown; out: string };

/** Guard, wait out the spacing, log pending, send, log completion. Returns the raw reply file path (moved under softclose/). */
async function sendOne(step: Step): Promise<{ entry: RequestLogEntry; file: string }> {
  const guard = checkCaptureUrl(step.url, step.method);
  const isSearch = step.url === `${SGW_API_BASE}${SGW_ENDPOINTS.search.path}` && step.method === 'POST';
  const isDetail = step.method === 'GET' && step.url.startsWith(`${SGW_API_BASE}ItemDetail/GetItemDetailModelByItemId/`);
  if (!guard.ok || guard.kind !== 'api' || !(isSearch || isDetail)) {
    throw new Error(`refused ${step.url}: ${guard.ok ? 'only the search POST and ItemDetail GET are allowed here' : guard.reason}`);
  }
  if (existsSync(STOPPED_FILE)) throw new Error(`refusing to send: ${STOPPED_FILE} exists`);
  const own = readRequestLog(LOG_FILE);
  if (requestsRemaining(own.length) <= 0) throw new Error(`cap of ${String(SC_MAX_REQUESTS)} requests reached`);
  const nextAt = earliestSendMs([own, ...foreignLogFiles().map((f) => readRequestLog(f))]);
  if (nextAt > Date.now()) {
    log(`${step.id}: waiting ${String(Math.ceil((nextAt - Date.now()) / 1000))} s for the 120 s spacing`);
    await sleepUntil(nextAt);
  }
  const seq = own.length + 1;
  log(`#${String(seq)} ${step.method} ${step.url}`);
  appendPendingRequest(LOG_FILE, { seq, stepId: step.id, kind: 'api', method: step.method, url: step.url, sentAtMs: Date.now() });
  const ctx = await openCaptureSession();
  let partial: Awaited<ReturnType<typeof runCaptureStep>>;
  let stop: string | null = null;
  try {
    try {
      partial = await runCaptureStep(ctx, { id: step.id, kind: 'api', method: step.method, url: step.url, out: step.out, ...(step.body === undefined ? {} : { body: step.body }) }, seq);
    } catch (e) {
      const entry = (e as { entry?: Awaited<ReturnType<typeof runCaptureStep>> }).entry;
      if (entry === undefined) throw e;
      stop = e instanceof Error ? e.message : String(e);
      partial = entry;
    }
  } finally {
    await ctx.context.close();
  }
  mkdirSync(path.join(SC_DIR, 'raw'), { recursive: true });
  const src = path.join(RAW_DIR, 'api', `${step.out}.json`);
  const dest = path.join(SC_DIR, 'raw', `${step.out}.json`);
  renameSync(src, dest);
  const entry: RequestLogEntry = { seq, stepId: step.id, kind: 'api', ...partial, outFiles: [`softclose/raw/${step.out}.json`] };
  appendFileSync(LOG_FILE, `${JSON.stringify(entry)}\n`);
  log(`#${String(seq)} -> ${String(entry.status)} in ${String(entry.endedAtMs - entry.sentAtMs)} ms${entry.error === undefined ? '' : ` (${entry.error})`}`);
  if (stop !== null || (entry.status !== null && entry.status !== 200) || entry.status === null) {
    writeFileSync(STOPPED_FILE, `${new Date().toISOString()} ${stop ?? `status ${String(entry.status)}`}\n`);
    throw new Error(`stopping for good: ${stop ?? `status ${String(entry.status)}`}`);
  }
  assertSoftcloseLog(readRequestLog(LOG_FILE));
  return { entry, file: dest };
}

function readReply(file: string): unknown {
  const wrapper = JSON.parse(readFileSync(file, 'utf8')) as { response: { bodyText: string } | null };
  if (wrapper.response === null) throw new Error(`no response in ${file}`);
  return JSON.parse(wrapper.response.bodyText);
}

function withLock<T>(fn: () => Promise<T>): Promise<T> {
  mkdirSync(SC_DIR, { recursive: true });
  const release = acquireCaptureLock(LOCK_FILE);
  const onSignal = (): void => {
    release();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  return fn().finally(() => {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    release();
  });
}

async function searchCommand(page: string): Promise<void> {
  await withLock(async () => {
    const used = readRequestLog(LOG_FILE).length;
    log(`log has ${String(used)}/${String(SC_MAX_REQUESTS)} requests; picking items with ONE search (page ${page})`);
    const body = { ...SGW_SEARCH_BODY_DEFAULTS, page };
    const { entry, file } = await sendOne({
      id: `search-p${page}`,
      url: `${SGW_API_BASE}${SGW_ENDPOINTS.search.path}`,
      method: 'POST',
      body,
      out: `sc-search-p${page}`,
    });
    const rows = parseSearchRows(readReply(file));
    const sel = selectItems(rows, entry.endedAtMs);
    log(`rows ${String(rows.length)}, excluded ${JSON.stringify(sel.excluded)}, chosen ${String(sel.chosen.length)}`);
    const items: PlanItem[] = sel.chosen.map((r, i) => ({ label: labelFor(i), itemId: r.itemId, endRaw: r.endRaw, endMs: r.endMs, numBidsAtSearch: r.numBids }));
    const plan: Plan = { createdAtMs: Date.now(), searchSeq: entry.seq, searchEndedAtMs: entry.endedAtMs, rowsSeen: rows.length, excluded: sel.excluded, items };
    writeFileSync(PLAN_FILE, JSON.stringify(plan, null, 2));
    const reads = scheduleReads(items.map((i) => i.endMs), earliestSendMs([readRequestLog(LOG_FILE)]));
    for (const [i, it] of items.entries()) {
      log(`${it.label}: ends in ${String(Math.round((it.endMs - entry.endedAtMs) / 60000))} min, ${String(it.numBidsAtSearch)} bids, read at ${new Date(reads[i] ?? 0).toISOString()}`);
    }
    if (items.length < SC_TARGET_ITEMS) log(`only ${String(items.length)} of ${String(SC_TARGET_ITEMS)} items qualified: consider one re-search (page 2) if the budget allows`);
  });
}

function loadPlan(): Plan {
  return JSON.parse(readFileSync(PLAN_FILE, 'utf8')) as Plan;
}

function readFiles(label: string): string[] {
  const dir = path.join(SC_DIR, 'raw');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => new RegExp(`^sc-read-${label}-\\d+\\.json$`).test(f))
    .sort()
    .map((f) => path.join(dir, f));
}

async function observeCommand(): Promise<void> {
  await withLock(async () => {
    const plan = loadPlan();
    const queue = plan.items.map((it) => ({ it, due: 0, reads: readFiles(it.label).length }));
    const floor = earliestSendMs([readRequestLog(LOG_FILE)]);
    const due = scheduleReads(plan.items.map((i) => i.endMs), floor);
    for (const [i, q] of queue.entries()) q.due = due[i] ?? floor;
    // Items already read in a previous run: due only when not closed (a re-read).
    const pendingReads: Array<{ it: PlanItem; due: number; reads: number }> = [];
    for (const q of queue) {
      if (q.reads === 0) {
        pendingReads.push(q);
        continue;
      }
      const last = parseDetail(readReply(readFiles(q.it.label).at(-1) as string));
      const again = rereadAt(last, q.reads, readRequestLog(LOG_FILE).length);
      if (again !== null) pendingReads.push({ it: q.it, due: again, reads: q.reads });
    }
    log(`observing ${String(pendingReads.length)} read(s); log has ${String(readRequestLog(LOG_FILE).length)}/${String(SC_MAX_REQUESTS)}`);
    while (pendingReads.length > 0) {
      pendingReads.sort((a, b) => a.due - b.due);
      const next = pendingReads.shift();
      if (next === undefined) break;
      await sleepUntil(next.due);
      const n = next.reads + 1;
      const { file } = await sendOne({
        id: `read-${next.it.label}-${String(n)}`,
        url: `${SGW_API_BASE}${SGW_ENDPOINTS.itemDetail.path.replace('{itemId}', String(next.it.itemId))}`,
        method: 'GET',
        out: `sc-read-${next.it.label}-${String(n)}`,
      });
      const snap = parseDetail(readReply(file));
      const a = analyzeItem(next.it.label, next.it.endMs, next.it.numBidsAtSearch, snap);
      log(`${next.it.label}: closed=${String(snap.closed)} moved=${String(a.moved)} shift=${formatRel(a.shiftMs)} lastBid=${formatRel(a.lastBidRelMs)} lateBids=${String(a.lateBids)}`);
      const again = rereadAt(snap, n, readRequestLog(LOG_FILE).length);
      if (again !== null) {
        log(`${next.it.label}: not closed at read; re-reading at ${new Date(again).toISOString()}`);
        pendingReads.push({ it: next.it, due: again, reads: n });
      }
    }
    reportCommand();
  });
}

function reportCommand(): void {
  const plan = loadPlan();
  const items: ItemAnalysis[] = [];
  for (const it of plan.items) {
    const last = readFiles(it.label).at(-1);
    if (last === undefined) continue;
    items.push(analyzeItem(it.label, it.endMs, it.numBidsAtSearch, parseDetail(readReply(last))));
  }
  const verdict = computeVerdict(items);
  const used = readRequestLog(LOG_FILE).length;
  console.log(renderTable(items));
  console.log(`\nverdict: ${verdictLabel(verdict)} (${verdict.why})`);
  console.log(`requests logged: ${String(used)}/${String(SC_MAX_REQUESTS)}; fractional post-read endTime on ${String(items.filter((i) => i.fractionalFinalEnd).length)} item(s)`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  const run =
    cmd === 'search' ? searchCommand(process.argv[3] ?? '1') : cmd === 'observe' ? observeCommand() : cmd === 'report' ? Promise.resolve().then(reportCommand) : null;
  if (run === null) {
    console.error('usage: tsx scripts/softclose-observe.ts search [page] | observe | report');
    process.exit(2);
  }
  run.catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
