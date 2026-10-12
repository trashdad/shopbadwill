// T-69: the ntfy.sh ReminderSink (T-67's ReminderSink seam, I-34). Calendar
// sync feeds it every desired event (upsert on change, remove when an item is
// gone or decided); it publishes delayed phone push messages with ntfy's
// X-Delay header so ntfy, not the extension, fires them at the right moment.
//
// - Opt-in (R2): zero requests unless the settings toggle is on, the topic is
//   valid, the server is https://ntfy.sh (the only optional host v1 declares)
//   and the optional host permission is granted. Otherwise it records a status
//   (`disabled` / `needs-permission`) and sends nothing.
// - Deferral (R6): leads whose fire time is more than 3 days away are stored as
//   `deferred`, not sent; the next upsert (calendar sync re-feeds after every
//   daily job run) publishes them once they are inside the window.
// - Idempotent (R5): seqs are `sbw-<itemId>-<leadMin>-<gen>`, so a restart or a
//   repeated upsert overwrites on ntfy instead of duplicating. An end-time (or
//   generation, or reminder) change first DELETEs the stored seqs, then
//   publishes the new ones under the same seqs.
// - Pacing and failures (R8): at most one request per second; a 429 or 5xx
//   backs off and gives up for this sync (the next upsert retries); a failure
//   never throws into calendar sync — it is caught and audited without the
//   topic.
//
// The topic is a secret (R3): it never appears in the audit log, console
// output or an error message, and this module never throws it.
import type { AuditLog } from '../../domain/audit/types';
import type { DesiredEvent } from '../../domain/calendar/types';
import type { NtfyState } from '../../domain/storage/schema';
import type { EpochMs, ItemId } from '../../domain/types';
import { formatDual } from '../../domain/time/pacific';
import type { Clock } from '../../ports/clock';
import { HttpNetworkError, HttpTimeoutError } from '../../ports/errors';
import type { Http, HttpRequest } from '../../ports/http';
import type { Permissions } from '../../ports/permissions';
import { isValidTopic } from './topic';

export const NTFY_SERVER = 'https://ntfy.sh';
export const NTFY_ORIGIN = 'https://ntfy.sh/*';
/** R6: reminders more than 3 days out are deferred, not sent. */
export const DEFER_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
/** R5: only leads still more than 10 s in the future are scheduled. */
export const MIN_LEAD_MS = 10_000;
/** R8: at most 1 request per second. */
export const DEFAULT_MIN_INTERVAL_MS = 1000;
/** R8: backoff after a 429/5xx (unless ntfy names a Retry-After). */
export const BACKOFF_MS = 60_000;
export const BACKOFF_CAP_MS = 60 * 60_000;
export const REQUEST_TIMEOUT_MS = 15_000;

export const EMPTY_NTFY_STATE: NtfyState = { items: {} };

export type NtfyItem = NtfyState['items'][number];
export type NtfyEntry = NtfyItem['entries'][number];

/** What the sink needs from Settings; the background wires the repo reads. */
export interface NtfySettingsView {
  ntfy?: { enabled: boolean; server: string; topic: string };
  /** The user's IANA zone, for the end time in the message (R4). */
  timeZone: string;
}

/** Read-modify-write of `sbw:ntfy`, serialized by the caller (the Repo lock). */
export interface NtfyStore {
  load(): Promise<NtfyState>;
  update(fn: (s: NtfyState) => NtfyState): Promise<NtfyState>;
}

export interface NtfySinkDeps {
  http: Http;
  clock: Clock;
  permissions: Pick<Permissions, 'contains'>;
  audit: Pick<AuditLog, 'append'>;
  settings: () => Promise<NtfySettingsView>;
  store: NtfyStore;
  /** 0 in tests; production uses the 1 s default. */
  minIntervalMs?: number;
}

export interface NtfyMessage {
  seq: string;
  title: string;
  body: string;
  clickUrl: string;
  fireAt: EpochMs;
}

/**
 * The ONE place that knows ntfy.sh's wire shape. PROVISIONAL — the shapes below
 * come from the ntfy.sh documentation and MUST BE CHECKED LIVE against the real
 * server before v1 ships:
 *
 *   publish: POST   https://ntfy.sh/<topic>   body = plain text
 *            headers: X-Title, X-Click, X-Tags: hourglass,
 *                     X-Delay: <unix seconds>, X-Sequence-ID: <seq>
 *   cancel:  DELETE https://ntfy.sh/<topic>/<seq>
 *
 * HTTP header values are bytes: fetch throws on a character above U+00FF (curly
 * quotes, emoji, the "…" sanitizeTitle appends) and sends U+0080-U+00FF as raw
 * Latin-1, which ntfy would garble. A title that is not plain printable ASCII
 * therefore goes as RFC 2047 encoded-words (`=?UTF-8?B?...?=`), which the ntfy
 * server decodes. Also check that live.
 */
export function ntfyRequest(kind: 'publish', topic: string, message: NtfyMessage): HttpRequest;
export function ntfyRequest(kind: 'cancel', topic: string, message: Pick<NtfyMessage, 'seq'>): HttpRequest;
export function ntfyRequest(kind: 'publish' | 'cancel', topic: string, message: NtfyMessage | Pick<NtfyMessage, 'seq'>): HttpRequest {
  if (kind === 'cancel' || !('title' in message)) {
    return { url: `${NTFY_SERVER}/${topic}/${message.seq}`, method: 'DELETE', timeoutMs: REQUEST_TIMEOUT_MS, credentials: 'omit' };
  }
  return {
    url: `${NTFY_SERVER}/${topic}`,
    method: 'POST',
    headers: {
      'X-Title': headerText(message.title),
      'X-Click': message.clickUrl,
      'X-Tags': 'hourglass',
      'X-Delay': String(Math.floor(message.fireAt / 1000)),
      'X-Sequence-ID': message.seq,
    },
    body: message.body,
    timeoutMs: REQUEST_TIMEOUT_MS,
    credentials: 'omit',
  };
}

/** Bytes per encoded-word: 45 bytes → 60 base64 chars → 72 with the `=?UTF-8?B?` / `?=` frame (RFC 2047 caps a word at 75). */
const RFC2047_WORD_BYTES = 45;

/**
 * The title as an ASCII header value: unchanged when it is printable ASCII (and
 * has no `=?` an RFC 2047 decoder could mistake for a word); otherwise UTF-8
 * RFC 2047 B encoded-words, split on code-point boundaries, joined by spaces.
 */
function headerText(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text) && !text.includes('=?')) return text;
  const encoder = new TextEncoder();
  const words: string[] = [];
  let chunk: number[] = [];
  const flush = (): void => {
    words.push(`=?UTF-8?B?${btoa(String.fromCharCode(...chunk))}?=`);
    chunk = [];
  };
  for (const ch of text) {
    const bytes = encoder.encode(ch);
    if (chunk.length + bytes.length > RFC2047_WORD_BYTES) flush();
    chunk.push(...bytes);
  }
  if (chunk.length > 0) flush();
  return words.join(' ');
}

/** `sbw-<itemId>-<leadMin>-<gen>`: deterministic, so a re-publish overwrites (R5). */
export function sequenceId(itemId: ItemId, leadMin: number, generation: number): string {
  return `sbw-${String(itemId)}-${String(leadMin)}-${String(generation)}`;
}

/** Stable identity of the event the stored entries belong to: end, generation, reminder minutes. */
export function fingerprintOf(e: DesiredEvent): string {
  const minutes = [...new Set(e.reminders.map((r) => r.minutes))].sort((a, b) => b - a).join(',');
  return `${e.startUtc}|${String(e.generation)}|${minutes}`;
}

/**
 * T-118 (L4): which topic a stored item's entries were published on, without
 * storing the topic (R3): 32-bit FNV-1a, hex. A record written by a publish
 * that raced a topic rotation then no longer reads as "already scheduled".
 */
export function topicTag(topic: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < topic.length; i++) {
    h ^= topic.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** R4: only the title, the lead and the end time in the user's zone; the link travels as X-Click. */
export function buildMessage(e: DesiredEvent, leadMin: number, timeZone: string): Omit<NtfyMessage, 'seq' | 'fireAt'> {
  const endMs = new Date(e.startUtc).getTime();
  return {
    title: e.title,
    body: `Ends in ${String(leadMin)} min — ends ${formatDual(endMs, timeZone)}`,
    clickUrl: e.sourceUrl,
  };
}

interface Lead {
  leadMin: number;
  fireAt: EpochMs;
  seq: string;
  status: 'scheduled' | 'deferred';
}

type RequestResult = 'ok' | 'rate-limited' | 'failed';

/** Serializes sends and starts each at least `minIntervalMs` after the previous one ENDED (R8). */
class Pacer {
  private tail: Promise<unknown> = Promise.resolve();
  private lastDone = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly clock: Clock,
    private readonly minIntervalMs: number,
  ) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const wait = this.lastDone + this.minIntervalMs - this.clock.monotonic();
      if (wait > 0) {
        await new Promise<void>((resolve) => {
          this.clock.setTimeout(resolve, wait);
        });
      }
      try {
        return await fn();
      } finally {
        this.lastDone = this.clock.monotonic();
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** Scheduled seqs only, in a stable order: item id, then the longest lead first. */
function scheduledSeqs(state: NtfyState): string[] {
  const seqs: string[] = [];
  const ids = Object.keys(state.items)
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id))
    .sort((a, b) => a - b);
  for (const id of ids) {
    const item = state.items[id];
    if (item === undefined) continue;
    const entries = [...item.entries]
      .filter((entry) => entry.status === 'scheduled')
      .sort((a, b) => b.leadMin - a.leadMin || a.seq.localeCompare(b.seq));
    for (const entry of entries) seqs.push(entry.seq);
  }
  return seqs;
}

/**
 * DELETE every stored scheduled message on the old topic. Deferred entries were
 * never published. Stops on 429/5xx (the caller does not retry in this click).
 * Never throws, and never puts the topic into an error.
 */
export async function cancelScheduledMessages(opts: {
  topic: string;
  state: NtfyState;
  http: Http;
  clock: Clock;
  minIntervalMs?: number;
}): Promise<{ ok: boolean }> {
  const seqs = scheduledSeqs(opts.state);
  if (seqs.length === 0) return { ok: true };
  if (!isValidTopic(opts.topic)) return { ok: false };
  const pacer = new Pacer(opts.clock, opts.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
  let ok = true;
  for (const seq of seqs) {
    const request = ntfyRequest('cancel', opts.topic, { seq });
    let response;
    try {
      response = await pacer.run(() => opts.http.send(request));
    } catch {
      ok = false;
      continue;
    }
    if ((response.status >= 200 && response.status < 300) || response.status === 404 || response.status === 410) continue;
    ok = false;
    if (response.status === 429 || response.status >= 500) break;
  }
  return { ok };
}

export class NtfySink {
  readonly name = 'ntfy';
  private readonly pacer: Pacer;
  /** R8: after a 429/5xx, no request until this time (the next upsert retries). */
  private rateLimitedUntil = 0;
  /** The tail of each item's queue: calls for one item run one at a time (see `withItem`). */
  private readonly itemQueues = new Map<ItemId, Promise<void>>();

  constructor(private readonly deps: NtfySinkDeps) {
    this.pacer = new Pacer(deps.clock, deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
  }

  /**
   * Runs `fn` after every earlier call for the same item has finished. Calendar
   * sync and the job-run hook share this sink; without the queue two upserts
   * of one item both read "nothing stored" and both publish, and a remove that
   * overlaps an upsert reads the record before the upsert writes it, so the
   * pushes the upsert sent are never cancelled. Other items are not held up.
   */
  private withItem(itemId: ItemId, fn: () => Promise<void>): Promise<void> {
    const run = (this.itemQueues.get(itemId) ?? Promise.resolve()).then(fn);
    const tail = run.catch(() => undefined);
    this.itemQueues.set(itemId, tail);
    void tail.then(() => {
      if (this.itemQueues.get(itemId) === tail) this.itemQueues.delete(itemId);
    });
    return run;
  }

  /** R2: the three conditions, plus the v1 server allow-list. Reads settings once per call. */
  private async prepare(): Promise<
    { status: 'ok'; topic: string; timeZone: string } | { status: 'disabled' | 'needs-permission' }
  > {
    const view = await this.deps.settings();
    const n = view.ntfy;
    if (n === undefined || !n.enabled || !isValidTopic(n.topic) || n.server !== NTFY_SERVER) {
      return { status: 'disabled' };
    }
    try {
      if (!(await this.deps.permissions.contains({ origins: [NTFY_ORIGIN] }))) return { status: 'needs-permission' };
    } catch {
      return { status: 'needs-permission' };
    }
    return { status: 'ok', topic: n.topic, timeZone: view.timeZone };
  }

  /** Records the R2 status in `sbw:ntfy`, auditing only on a change. */
  private async recordStatus(status: 'disabled' | 'needs-permission'): Promise<void> {
    const prev = (await this.deps.store.load()).status;
    if (prev === status) return;
    await this.deps.store.update((s) => ({ ...s, status }));
    await this.audit({ kind: 'ntfy.status', details: { status } });
  }

  upsert(event: DesiredEvent): Promise<void> {
    return this.withItem(event.itemId, () => this.upsertNow(event));
  }

  remove(itemId: ItemId): Promise<void> {
    return this.withItem(itemId, () => this.removeNow(itemId));
  }

  /**
   * One pass that brings ntfy in line with the open events: an upsert for each
   * (a no-op, with no request and no write, when nothing is owed) and a remove
   * for every stored item no longer open. Calendar sync offers an unchanged
   * event only once, so this is what publishes items offered while the gate
   * was closed, finishes a sync a 429 cut short, republishes after a topic
   * rotation, and cancels items that left while the gate was closed.
   * `loadOpen` is only called once the gate (R2) is open. Never throws.
   */
  async reconcile(loadOpen: () => Promise<readonly DesiredEvent[]>): Promise<void> {
    try {
      const prep = await this.prepare();
      if (prep.status !== 'ok') {
        await this.recordStatus(prep.status);
        return;
      }
      const open = await loadOpen();
      const openIds = new Set<ItemId>(open.map((e) => e.itemId));
      for (const e of open) await this.upsert(e);
      const stored = Object.keys((await this.deps.store.load()).items).map(Number);
      for (const id of stored) {
        if (Number.isInteger(id) && !openIds.has(id)) await this.remove(id);
      }
      // The gate was open for this pass: drop a stale status, so a tick stops looking.
      if ((await this.prepare()).status === 'ok' && (await this.deps.store.load()).status !== undefined) {
        await this.deps.store.update((s) => ({ items: s.items }));
        await this.audit({ kind: 'ntfy.status', details: { status: 'ok' } });
      }
    } catch (e) {
      await this.audit({ kind: 'ntfy.failed', details: { error: this.errorLabel(e) } });
    }
  }

  private async upsertNow(event: DesiredEvent): Promise<void> {
    try {
      const prep = await this.prepare();
      if (prep.status !== 'ok') {
        await this.recordStatus(prep.status);
        return;
      }
      const now = this.deps.clock.now();
      const state = await this.deps.store.load();
      const tag = topicTag(prep.topic);
      const stored = state.items[event.itemId];
      // T-118 (L4): entries stored for another topic are not scheduled on this one.
      const prev = stored !== undefined && (stored.topicTag ?? tag) === tag ? stored : undefined;
      const fingerprint = fingerprintOf(event);

      let entries: NtfyEntry[] = [];
      if (prev !== undefined && prev.fingerprint !== fingerprint) {
        // R6: the end time (or generation, or reminders) changed: cancel the
        // stored seqs, then publish new ones. If a cancel does not finish
        // (429/5xx or a failed DELETE), keep the old fingerprint and every seq
        // not yet cancelled so the next upsert retries. Publishing now would
        // forget a seq whose generation changed and leave it live on ntfy.
        const remaining = await this.cancelEntries(event.itemId, prep.topic, prev.entries);
        if (remaining.some((entry) => entry.status === 'scheduled')) {
          await this.deps.store.update((s) => ({
            ...(s.status === undefined ? {} : { status: s.status }),
            items: { ...s.items, [event.itemId]: { fingerprint: prev.fingerprint, topicTag: tag, entries: remaining } },
          }));
          return;
        }
        entries = [];
      } else if (prev !== undefined) {
        entries = prev.entries;
      }

      const byLead = new Map(entries.map((x) => [x.leadMin, x]));
      const published: NtfyEntry[] = [];
      for (const lead of this.leads(event, now)) {
        if (lead === null) continue; // past: skip entirely (R5)
        const cur = byLead.get(lead.leadMin);
        if (lead.status === 'deferred') {
          if (cur !== undefined && cur.status === 'scheduled') {
            // Defensive: cannot normally happen (fireAt derives from the fingerprint).
            await this.cancelEntries(event.itemId, prep.topic, [cur]);
          }
          byLead.set(lead.leadMin, { seq: lead.seq, leadMin: lead.leadMin, fireAt: lead.fireAt, status: 'deferred' });
          if (cur === undefined || cur.fireAt !== lead.fireAt) {
            await this.audit({ kind: 'ntfy.deferred', itemId: event.itemId, details: { leadMin: lead.leadMin } });
          }
          continue;
        }
        if (cur !== undefined && cur.status === 'scheduled' && cur.seq === lead.seq && cur.fireAt === lead.fireAt) continue;
        const result = await this.publish(event.itemId, prep.topic, prep.timeZone, event, lead);
        if (result === 'ok') {
          const entry: NtfyEntry = { seq: lead.seq, leadMin: lead.leadMin, fireAt: lead.fireAt, status: 'scheduled' };
          byLead.set(lead.leadMin, entry);
          published.push(entry);
        } else {
          // failed / rate-limited: the lead stays unpublished; the next upsert retries it.
          byLead.delete(lead.leadMin);
          if (result === 'rate-limited') break; // give up for this sync (R8)
        }
      }

      // T-118 (L4): the options page may have rotated the topic, or turned phone
      // push off, while this pass published (it clears `sbw:ntfy` outside this
      // sink's queue). Take this pass's pushes back off the old topic and record
      // nothing: the next upsert publishes on the new topic.
      if (published.length > 0 && (await this.topicMoved(prep.topic))) {
        await this.cancelEntries(event.itemId, prep.topic, published);
        return;
      }

      const next = [...byLead.values()];
      const unchanged =
        prev !== undefined && prev.fingerprint === fingerprint && JSON.stringify(prev.entries) === JSON.stringify(next);
      if (unchanged && state.status === undefined) return; // nothing owed: no write either
      await this.deps.store.update((s) => ({ items: { ...s.items, [event.itemId]: { fingerprint, topicTag: tag, entries: next } } }));
      if (state.status !== undefined) await this.audit({ kind: 'ntfy.status', details: { status: 'ok' } });
    } catch (e) {
      // R8: a failure never throws into calendar sync; audit without the topic.
      await this.audit({ kind: 'ntfy.failed', itemId: event.itemId, details: { error: this.errorLabel(e) } });
    }
  }

  private async removeNow(itemId: ItemId): Promise<void> {
    try {
      const prep = await this.prepare();
      if (prep.status !== 'ok') {
        await this.recordStatus(prep.status);
        return;
      }
      const state = await this.deps.store.load();
      const item = state.items[itemId];
      if (item === undefined) return;
      if (item.topicTag !== undefined && item.topicTag !== topicTag(prep.topic)) {
        // T-118 (L4): published on another topic; nothing of it is on this one to cancel.
        await this.deps.store.update((s) => ({
          ...(s.status === undefined ? {} : { status: s.status }),
          items: Object.fromEntries(Object.entries(s.items).filter(([key]) => key !== String(itemId))),
        }));
        return;
      }
      const live = item.entries.filter((x) => x.status === 'scheduled');
      const kept: NtfyEntry[] = [];
      for (let i = 0; i < live.length; i++) {
        const entry = live[i];
        if (entry === undefined) continue;
        const result = await this.cancel(itemId, prep.topic, entry);
        if (result === 'ok') continue;
        kept.push(entry); // retried by a later remove (calendar sync re-feeds the item)
        if (result === 'rate-limited') {
          kept.push(...live.slice(i + 1)); // un-attempted entries stay stored too
          break; // give up for this sync (R8)
        }
      }
      await this.deps.store.update((s) => {
        if (kept.length === 0) {
          const items = Object.fromEntries(Object.entries(s.items).filter(([key]) => key !== String(itemId)));
          return { items };
        }
        return {
          items: {
            ...s.items,
            [itemId]: { fingerprint: item.fingerprint, ...(item.topicTag === undefined ? {} : { topicTag: item.topicTag }), entries: kept },
          },
        };
      });
    } catch (e) {
      await this.audit({ kind: 'ntfy.failed', itemId, details: { error: this.errorLabel(e) } });
    }
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /** T-118 (L4): phone push is now off, or on another topic, than when this pass started. */
  private async topicMoved(topic: string): Promise<boolean> {
    try {
      const n = (await this.deps.settings()).ntfy;
      return n === undefined || !n.enabled || n.topic !== topic;
    } catch {
      return false;
    }
  }

  /** The leads to consider now: deferred beyond the window, skipped within 10 s, else scheduled. */
  private leads(event: DesiredEvent, now: EpochMs): Array<Lead | null> {
    const endMs = new Date(event.startUtc).getTime();
    const minutes = [...new Set(event.reminders.map((r) => r.minutes))].sort((a, b) => b - a);
    return minutes.map((m) => {
      const fireAt = endMs - m * 60_000;
      if (fireAt <= now + MIN_LEAD_MS) return null; // R5: only leads still more than 10 s out
      const status: Lead['status'] = fireAt - now > DEFER_WINDOW_MS ? 'deferred' : 'scheduled';
      return { leadMin: m, fireAt, seq: sequenceId(event.itemId, m, event.generation), status };
    });
  }

  /**
   * DELETEs stored scheduled entries. Returns every entry that is still live:
   * deferred ones (never published), failed cancels, and anything not attempted
   * because a 429/5xx stopped this sync.
   */
  private async cancelEntries(itemId: ItemId, topic: string, entries: readonly NtfyEntry[]): Promise<NtfyEntry[]> {
    const cancelled = new Set<string>();
    let stop = false;
    for (const entry of entries) {
      if (stop || entry.status === 'deferred') continue;
      const result = await this.cancel(itemId, topic, entry);
      if (result === 'ok') cancelled.add(entry.seq);
      else if (result === 'rate-limited') stop = true;
    }
    return entries.filter((entry) => !cancelled.has(entry.seq));
  }

  private async publish(
    itemId: ItemId,
    topic: string,
    timeZone: string,
    event: DesiredEvent,
    lead: Lead,
  ): Promise<RequestResult> {
    if (this.deps.clock.now() < this.rateLimitedUntil) return 'rate-limited';
    const message = buildMessage(event, lead.leadMin, timeZone);
    const request = ntfyRequest('publish', topic, { seq: lead.seq, ...message, fireAt: lead.fireAt });
    let response;
    try {
      response = await this.pacer.run(() => this.deps.http.send(request));
    } catch (e) {
      await this.audit({ kind: 'ntfy.failed', itemId, details: { error: this.errorLabel(e), leadMin: lead.leadMin } });
      return 'failed';
    }
    if (response.status >= 200 && response.status < 300) {
      await this.audit({ kind: 'ntfy.published', itemId, details: { leadMin: lead.leadMin, seq: lead.seq } });
      return 'ok';
    }
    if (response.status === 429 || response.status >= 500) {
      this.rateLimitedUntil = this.deps.clock.now() + this.backoffMs(response.headers['retry-after']);
      await this.audit({ kind: 'ntfy.rate-limited', itemId, details: { leadMin: lead.leadMin, status: response.status } });
      return 'rate-limited';
    }
    await this.audit({ kind: 'ntfy.failed', itemId, details: { error: `http ${String(response.status)}`, leadMin: lead.leadMin } });
    return 'failed';
  }

  private async cancel(itemId: ItemId, topic: string, entry: NtfyEntry): Promise<RequestResult> {
    if (this.deps.clock.now() < this.rateLimitedUntil) return 'rate-limited';
    const request = ntfyRequest('cancel', topic, { seq: entry.seq });
    let response;
    try {
      response = await this.pacer.run(() => this.deps.http.send(request));
    } catch (e) {
      await this.audit({ kind: 'ntfy.failed', itemId, details: { error: this.errorLabel(e), leadMin: entry.leadMin, seq: entry.seq } });
      return 'failed';
    }
    // 404/410: already delivered or never created — the cancel is complete.
    if ((response.status >= 200 && response.status < 300) || response.status === 404 || response.status === 410) {
      await this.audit({ kind: 'ntfy.cancelled', itemId, details: { leadMin: entry.leadMin, seq: entry.seq } });
      return 'ok';
    }
    if (response.status === 429 || response.status >= 500) {
      this.rateLimitedUntil = this.deps.clock.now() + this.backoffMs(response.headers['retry-after']);
      await this.audit({ kind: 'ntfy.rate-limited', itemId, details: { leadMin: entry.leadMin, status: response.status } });
      return 'rate-limited';
    }
    await this.audit({ kind: 'ntfy.failed', itemId, details: { error: `http ${String(response.status)}`, leadMin: entry.leadMin } });
    return 'failed';
  }

  private backoffMs(retryAfter: string | undefined): number {
    const seconds = retryAfter === undefined ? Number.NaN : Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, BACKOFF_CAP_MS);
    return BACKOFF_MS;
  }

  /** A label safe to audit: never the message, which may contain the topic (R3). */
  private errorLabel(e: unknown): string {
    if (e instanceof HttpTimeoutError) return 'timeout';
    if (e instanceof HttpNetworkError) return 'network';
    return 'error';
  }

  private async audit(entry: Omit<Parameters<AuditLog['append']>[0], 'actor'>): Promise<void> {
    try {
      await this.deps.audit.append({ actor: 'calendar', ...entry });
    } catch {
      // The audit log must never break the sink (R8).
    }
  }
}
