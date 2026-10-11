// T-32: the content overlay (ISOLATED world).
//
// Data in: the MAIN-world api-tap relays (T-31) and the page DOM. Data out:
// `page.token`, `page.listings`, `page.domHealth`, `rules.evaluate` and the
// user's `quick.*` intents, all to the background. The overlay itself never
// talks to SGW: zero extra requests.
//
// Rules this file keeps:
//  - The nonce goes on <html> synchronously at start (document_start), so the
//    tap can stop buffering as early as possible.
//  - Tap messages are untrusted: same-window source, `parseTapMessage` (nonce,
//    schema, buyerapi URL, JWT shape), then the SGW search schema. Anything
//    else is dropped silently.
//  - Only search pages are decorated (never item pages, whose related cards
//    use the same component). A card is decorated only from the background's
//    rules.evaluate answer over the page's own API data: a card without that
//    data is never hidden (unknown never holds). Only `hide` and `highlight`
//    decorate: `watch` rules drive the daily job, never the page (a shared
//    match-everything watch rule would otherwise paint every card).
//  - Never break the page: every decoration goes through the DomAdapter (fully
//    reversible), every failure is swallowed, and stop() restores the page.
//    Our nodes are text-only Preact trees inside shadow roots.
//  - Re-scans are idempotent and cheap: same DOM, same results -> no DOM
//    change and no new message. DOM changes reach us through a debounced
//    MutationObserver that ignores our own nodes; SPA navigation through
//    onLocationChange (the entrypoint wires `wxt:locationchange`).
//  - Selector health goes to the background once per page and per change.
//    Zero parsed cards count (banner + health report) only once the page has
//    settled AND either the tap's search reply said there were results or no
//    reply came within NO_REPLY_MS; an empty search is never drift.
//  - Settings fail closed: an unreadable record keeps the last good settings
//    (honouring a readable `killSwitch: true`), and with none the overlay pauses.
//
// Settings and rule names are read (never written) from storage.local: content
// scripts may not send `settings.get`/`rules.list` (PLAN §2.4).
import { h, render } from 'preact';
import { z } from 'zod';

import { SGW_API_BASE, SGW_ENDPOINTS } from '../adapters/sgw/config';
import { createDomAdapter, type AdapterCardHandle, type DiscoveryReport } from '../adapters/sgw/dom-adapter';
import { normalizeSearch, type SearchNormalizeContext } from '../adapters/sgw/normalize';
import { searchQueryFromUrl } from '../adapters/sgw/query-url';
import { RuleSchema, type MatchResult, type Rule } from '../domain/rules/schema';
import { defaultSettings } from '../domain/settings/defaults';
import { SettingsSchema, type Settings } from '../domain/settings/schema';
import { STORAGE_KEYS } from '../domain/storage/schema';
import type { ItemId, Listing } from '../domain/types';
import type { MsgPayload } from '../messaging/protocol';
import type { MessagingClient } from '../ports/messaging';
import type { Decoration } from '../ports/sgw-dom';
import type { Storage } from '../ports/storage';
import { NONCE_ATTR } from './api-tap.main';
import { parseTapMessage } from './tap-message';
import { BADGES, type CardBadge } from './ui/badge-registry';
import { CardTools } from './ui/card-tools';
import { createOverlayDecorationUi } from './ui/decoration-ui';
import { PageStatus, type PageView } from './ui/page-status';
import { createUiHost, type UiHost } from './ui/shadow';
import { PAGE_CSS, TOOLS_CSS } from './ui/styles';
import { Why } from './ui/why';

export const OVERLAY_TIMING = Object.freeze({
  /** Quiet time after the last page mutation before a re-scan. */
  debounceMs: 250,
  /** How long after a page starts before "zero cards" counts as a layout change. */
  settleMs: 5000,
  /** Without a search reply from the tap, how long before "zero cards" counts anyway. */
  noReplyMs: 15_000,
  /** First retry after a failed rules.evaluate (the background may be restarting); doubles up to retryMaxMs. */
  retryMs: 5000,
  retryMaxMs: 60_000,
});
/** Tap listings kept in memory (oldest dropped). */
const MAX_LISTINGS = 1000;
const SEARCH_PATH = new URL(SGW_ENDPOINTS.search.path, SGW_API_BASE).pathname.toLowerCase();
/** Elements we insert: our tags, and the markers the DomAdapter and we put on our own nodes. */
const OUR_TAG = /^(sbw-|shopbadwill-)/i;
const OUR_ATTRS = ['data-sbw-stub', 'data-sbw-label', 'data-sbw-tools', 'data-sbw-why'] as const;
const NONE: Decoration = { kind: 'none' };
const RulesSchema = z.array(RuleSchema);

export interface PageUiHooks {
  /** The (shadow-root) container to render the page status into. */
  onMount(container: HTMLElement): void;
  onRemove(): void;
}
/** Mounts the page-level UI. The entrypoint passes WXT's createShadowRootUi; the default is a plain open shadow host. */
export type MountPageUi = (hooks: PageUiHooks) => Promise<{ remove(): void }>;

export interface OverlayDeps {
  win: Window & typeof globalThis;
  messaging: MessagingClient;
  /** storage.local; read only. */
  storage: Pick<Storage, 'get' | 'onChanged'>;
  /** Default: `win.location.href`. */
  getUrl?: () => string;
  mountPageUi?: MountPageUi;
  /** Default: every src/content/ui/badges/*.tsx. */
  badges?: readonly CardBadge[];
  /** EpochMs for data timestamps (capturedAt, observedAt). Timers use the real clock. */
  now?: () => number;
  debounceMs?: number;
  settleMs?: number;
  noReplyMs?: number;
  retryMs?: number;
  nonce?: string;
}

export interface Overlay {
  /** The per-page tap nonce, already set on <html>. */
  readonly nonce: string;
  /** Settings and rules loaded, page UI mounted, first scan done. Never rejects. */
  readonly ready: Promise<void>;
  /** Scans run so far (for tests and diagnostics). */
  readonly scanCount: number;
  /** Sizes of the in-memory caches (diagnostics). */
  memory(): { listings: number; results: number; failed: number };
  /** Re-scans now; resolves when the page is decorated (joins a scan in progress). */
  scan(): Promise<void>;
  /** SPA navigation (`wxt:locationchange`). */
  onLocationChange(url: string): void;
  /** Stops everything and restores the page. */
  stop(): void;
}

interface PageState {
  url: string;
  /** Items the user re-showed on this page (kept across re-renders). */
  revealedIds: Set<ItemId>;
  settled: boolean;
  /** No search reply came within noReplyMs. */
  replyWaitOver: boolean;
  /** Cards found by the last scan of this page; null before the first. */
  cardsFound: number | null;
  /** Rows in the last tap search reply seen on this page; null when none. */
  lastSearchCount: number | null;
  healthKey: string | null;
}

interface Decorated {
  card: AdapterCardHandle;
  deco: Decoration;
}

const newPage = (url: string): PageState => ({
  url,
  revealedIds: new Set(),
  settled: false,
  replyWaitOver: false,
  cardsFound: null,
  lastSearchCount: null,
  healthKey: null,
});

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    /* never break the page */
  }
}

function domReady(doc: Document): Promise<void> {
  if (doc.readyState !== 'loading') return Promise.resolve();
  return new Promise((resolve) => {
    doc.addEventListener(
      'DOMContentLoaded',
      () => {
        resolve();
      },
      { once: true },
    );
  });
}

function defaultMountPageUi(doc: Document): MountPageUi {
  return (hooks) => {
    const host = doc.createElement('shopbadwill-badge');
    const shadow = host.attachShadow({ mode: 'open' });
    const style = doc.createElement('style');
    style.textContent = PAGE_CSS;
    const container = doc.createElement('div');
    shadow.append(style, container);
    (doc.querySelector('body') ?? doc.documentElement).append(host);
    hooks.onMount(container);
    return Promise.resolve({
      remove() {
        hooks.onRemove();
        host.remove();
      },
    });
  };
}

function isSearchApi(url: string): boolean {
  try {
    return new URL(url).pathname.toLowerCase() === SEARCH_PATH;
  } catch {
    return false;
  }
}

function searchContext(url: string, observedAt: number, authenticated: boolean): SearchNormalizeContext {
  const q = searchQueryFromUrl(url);
  const query: SearchNormalizeContext['query'] = { page: q?.page ?? 1 };
  if (q?.pickupOnly !== undefined) query.pickupOnly = q.pickupOnly;
  if (q?.excludePickupOnly !== undefined) query.excludePickupOnly = q.excludePickupOnly;
  return { observedAt, authenticated, query };
}

type SettingsRead = { kind: 'ok'; settings: Settings } | { kind: 'invalid'; killSwitch: boolean };

/** Absent means defaults (nothing stored yet); an unreadable record still reports a readable `killSwitch: true`. */
function readSettings(raw: unknown): SettingsRead {
  if (raw === undefined) return { kind: 'ok', settings: defaultSettings() };
  const r = SettingsSchema.safeParse(raw);
  if (r.success) return { kind: 'ok', settings: r.data };
  const kill = typeof raw === 'object' && raw !== null && (raw as Record<string, unknown>)['killSwitch'] === true;
  return { kind: 'invalid', killSwitch: kill };
}

function parseRules(raw: unknown): Map<string, Rule> {
  const r = RulesSchema.safeParse(raw);
  return new Map(r.success ? r.data.map((rule) => [rule.id, rule]) : []);
}

function ours(n: Node): boolean {
  if (n.nodeType !== 1) return true; // text and comments never change the cards
  const el = n as Element;
  return OUR_TAG.test(el.tagName) || OUR_ATTRS.some((a) => el.hasAttribute(a));
}

function foreign(r: MutationRecord): boolean {
  if (r.type === 'attributes') return r.target.nodeType === 1 && !ours(r.target);
  for (const n of Array.from(r.addedNodes)) if (!ours(n)) return true;
  for (const n of Array.from(r.removedNodes)) if (!ours(n)) return true;
  return false;
}

export function startOverlay(deps: OverlayDeps): Overlay {
  const { win, messaging: client, storage } = deps;
  const doc = win.document;
  const now = deps.now ?? ((): number => Date.now());
  const getUrl = deps.getUrl ?? ((): string => win.location.href);
  const debounceMs = deps.debounceMs ?? OVERLAY_TIMING.debounceMs;
  const maxWaitMs = debounceMs * 4;
  const settleMs = deps.settleMs ?? OVERLAY_TIMING.settleMs;
  const noReplyMs = deps.noReplyMs ?? OVERLAY_TIMING.noReplyMs;
  const retryMs = deps.retryMs ?? OVERLAY_TIMING.retryMs;
  const badges = deps.badges ?? BADGES;
  const mountPageUi = deps.mountPageUi ?? defaultMountPageUi(doc);
  const nonce = deps.nonce ?? globalThis.crypto.randomUUID();

  // First: the MAIN-world tap holds its relays until it sees this.
  doc.documentElement.setAttribute(NONCE_ATTR, nonce);

  let stopped = false;
  let initialized = false;
  let suspended = false;
  let scans = 0;
  /** Read through a call: these flags change from other callbacks while a scan awaits. */
  const live = (): boolean => !stopped && !suspended;

  let settings = defaultSettings();
  /** A good settings record has been read (absent counts: defaults). */
  let settingsGood = false;
  /** No good settings to fall back on: the overlay pauses (fail closed). */
  let settingsUnreadable = false;
  /** The last record was unreadable but said `killSwitch: true`. */
  let rawKill = false;
  /** From a `switches.changed` broadcast, until the next settings read. */
  let killOverride: boolean | null = null;
  let pillCollapsed = false;
  let rules = new Map<string, Rule>();
  let tokenSeen = false;

  const listings = new Map<ItemId, Listing>();
  /**
   * Evaluations by listing (observedAt). One from an older generation (rules or
   * settings changed since) is still shown until the re-evaluation answers, so
   * a change never flashes hidden cards back into view.
   */
  const results = new Map<ItemId, { observedAt: number; gen: number; result: MatchResult }>();
  /** Listings (by observedAt) whose evaluation failed in this generation: not retried until new data or rules. */
  const failed = new Map<ItemId, number>();
  const inflight = new Set<ItemId>();
  let generation = 0;
  let evaluateFailed = false;
  let retryDelay = retryMs;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;

  let page = newPage(getUrl());
  let cards: AdapterCardHandle[] = [];
  const decorated = new Map<Element, Decorated>();
  const tools = new Map<Element, UiHost>();
  const whys = new Map<Element, UiHost>();
  const revealers = new WeakMap<Element, () => void>();
  const revealed = new Set<Element>();
  let applying: AdapterCardHandle | null = null;
  let pageUi: { remove(): void } | null = null;
  let pageContainer: HTMLElement | null = null;

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let firstPendingAt = 0;
  let settleTimer: ReturnType<typeof setTimeout> | undefined;
  let noReplyTimer: ReturnType<typeof setTimeout> | undefined;

  const dom = createDomAdapter({
    hideStyle: () => settings.overlay.hideStyle,
    ui: createOverlayDecorationUi({
      current: () => applying,
      stubCreated(card, reveal, why) {
        revealers.set(card.root, reveal);
        revealed.delete(card.root);
        whys.get(card.root)?.destroy();
        whys.set(card.root, why);
      },
      revealed(card) {
        revealed.add(card.root);
        page.revealedIds.add(card.itemId);
        renderPage();
      },
    }),
  });

  const ruleName = (id: string): string => {
    const name = rules.get(id)?.name.trim() ?? '';
    return name === '' ? 'Unnamed rule' : name;
  };
  const killed = (): boolean => killOverride ?? (rawKill || settings.killSwitch);
  const activeOn = (kind: string): boolean =>
    settings.overlay.enabled && !settingsUnreadable && !killed() && kind === 'search';

  function applySettings(read: SettingsRead): void {
    if (read.kind === 'ok') {
      settings = read.settings;
      settingsGood = true;
      settingsUnreadable = false;
      rawKill = false;
    } else {
      // Keep the last good settings (and any broadcast kill override); with none, pause.
      rawKill = read.killSwitch;
      settingsUnreadable = !settingsGood;
      return;
    }
    killOverride = null;
  }

  /** Zero parsed cards on this search page count as a layout change (banner, health report). */
  function zeroVerdict(): boolean {
    const p = page;
    if (p.cardsFound !== 0 || !p.settled || p.lastSearchCount === 0) return false;
    return p.lastSearchCount !== null || p.replyWaitOver;
  }

  function send<K extends 'page.token' | 'page.listings' | 'page.domHealth'>(type: K, payload: MsgPayload<K>): void {
    try {
      void client.send(type, payload).catch(() => undefined);
    } catch {
      /* the background may be restarting; the page goes on */
    }
  }

  // ── results ──────────────────────────────────────────────────────────────

  /** The result for the listing as it is now, possibly from an older generation (`stale`), or null. */
  function shownResult(id: ItemId): { result: MatchResult; stale: boolean } | null {
    const entry = results.get(id);
    const listing = listings.get(id);
    if (entry === undefined || listing === undefined || entry.observedAt !== listing.observedAt) return null;
    return { result: entry.result, stale: entry.gen !== generation };
  }

  function needsEval(id: ItemId): boolean {
    const listing = listings.get(id);
    if (listing === undefined || inflight.has(id)) return false;
    const entry = results.get(id);
    if (entry !== undefined && entry.observedAt === listing.observedAt && entry.gen === generation) return false;
    return failed.get(id) !== listing.observedAt;
  }

  /** Returns true when results changed (another pass should apply them). */
  async function evaluate(ids: ItemId[]): Promise<boolean> {
    const gen = generation;
    const batch = ids.map((id) => listings.get(id)).filter((l): l is Listing => l !== undefined);
    if (batch.length === 0) return false;
    for (const l of batch) inflight.add(l.itemId);
    try {
      const reply = await client.send('rules.evaluate', { listings: batch });
      if (gen !== generation) return true; // the rules changed meanwhile: evaluate again
      const byId = new Map(reply.map((r) => [r.itemId, r]));
      for (const l of batch) {
        const result: MatchResult = byId.get(l.itemId) ?? { itemId: l.itemId, decision: 'none', matched: [], unknownConditions: 0 };
        results.set(l.itemId, { observedAt: l.observedAt, gen, result });
      }
      evaluateFailed = false;
      retryDelay = retryMs;
      return true;
    } catch {
      if (gen === generation) for (const l of batch) failed.set(l.itemId, l.observedAt);
      evaluateFailed = true;
      scheduleRetry();
      return false;
    } finally {
      for (const l of batch) inflight.delete(l.itemId);
    }
  }

  /** One pending retry at a time, with exponential backoff; it clears the failures and re-scans. */
  function scheduleRetry(): void {
    if (retryTimer !== undefined || !live()) return;
    const delay = retryDelay;
    retryDelay = Math.min(retryDelay * 2, OVERLAY_TIMING.retryMaxMs);
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      failed.clear();
      void scan();
    }, delay);
  }

  function clearRetry(): void {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
  }

  /**
   * The page decoration for a shown result. Only hide and highlight decorate
   * (watch never does). A stale result (the rules changed since) counts only
   * the rules still present and enabled here, so a rule just disabled or
   * deleted stops hiding even if the re-evaluation fails; precedence stays
   * hide over highlight.
   */
  function decorationFor(shown: { result: MatchResult; stale: boolean } | null): Decoration {
    if (shown === null) return NONE;
    const { result, stale } = shown;
    const counts = (ruleId: string): boolean => !stale || rules.get(ruleId)?.enabled === true;
    let decision: 'hide' | 'highlight' | null = null;
    if (stale) {
      if (result.matched.some((x) => x.action === 'hide' && counts(x.ruleId))) decision = 'hide';
      else if (result.matched.some((x) => x.action === 'highlight' && counts(x.ruleId))) decision = 'highlight';
    } else if (result.decision === 'hide' || result.decision === 'highlight') {
      decision = result.decision;
    }
    if (decision === null) return NONE;
    const m = result.matched.find((x) => x.action === decision && counts(x.ruleId));
    if (m === undefined) return NONE;
    const name = ruleName(m.ruleId);
    if (decision === 'hide') return { kind: 'hide', ruleId: m.ruleId, ruleName: name };
    return { kind: 'highlight', label: name, ruleId: m.ruleId, tone: rules.get(m.ruleId)?.tone ?? 'green' };
  }

  // ── decorations ──────────────────────────────────────────────────────────

  /** Our tools row goes right after the anchor (inside the card), or into it when the anchor is the card itself. */
  function place(card: AdapterCardHandle, host: Element): void {
    const a = card.anchor;
    if (a !== card.root && card.root.contains(a.parentElement)) {
      if (a.nextElementSibling !== host) a.after(host);
    } else if (host.parentElement !== a) {
      a.append(host);
    }
  }

  function ensureTools(card: AdapterCardHandle, result: MatchResult | null, t: number): void {
    let ui = tools.get(card.root);
    if (ui !== undefined && !card.root.contains(ui.host)) {
      ui.destroy();
      tools.delete(card.root);
      ui = undefined;
    }
    for (const stray of Array.from(card.root.querySelectorAll('[data-sbw-tools]'))) {
      if (stray !== ui?.host) stray.remove();
    }
    if (ui === undefined) {
      ui = createUiHost(doc, 'sbw-tools', TOOLS_CSS, { 'data-sbw-tools': String(card.itemId) });
      tools.set(card.root, ui);
    } else if (ui.host.getAttribute('data-sbw-tools') !== String(card.itemId)) {
      ui.host.setAttribute('data-sbw-tools', String(card.itemId));
    }
    place(card, ui.host);
    const host = ui;
    safe(() => {
      host.render(
        h(CardTools, {
          itemId: card.itemId,
          listing: listings.get(card.itemId) ?? null,
          result,
          ruleName,
          settings,
          client,
          badges,
          cardRoot: card.root,
          now: t,
        }),
      );
    });
  }

  function renderWhy(card: AdapterCardHandle, result: MatchResult | null): void {
    const ui = whys.get(card.root);
    if (ui === undefined || result === null || !ui.host.isConnected) return;
    const title = listings.get(card.itemId)?.title ?? null;
    safe(() => {
      ui.render(h(Why, { result, ruleName, title, client }));
    });
  }

  function applyAll(): void {
    const t = now();
    for (const card of cards) {
      const shown = shownResult(card.itemId);
      const deco = decorationFor(shown);
      // Why? explains decorated cards only (never a watch-only or dropped match).
      const result = deco.kind === 'hide' || deco.kind === 'highlight' ? (shown?.result ?? null) : null;
      const prev = decorated.get(card.root);
      if (prev !== undefined && prev.card.itemId !== card.itemId) {
        // The site reused this card for another item.
        safe(() => {
          dom.clearDecoration(prev.card);
        });
        revealed.delete(card.root);
      } else if (prev?.deco.kind === 'hide' && deco.kind !== 'hide') {
        revealed.delete(card.root);
      }
      applying = card;
      safe(() => {
        dom.applyDecoration(card, deco);
      });
      applying = null;
      decorated.set(card.root, { card, deco });
      if (
        deco.kind === 'hide' &&
        card.degraded !== true &&
        page.revealedIds.has(card.itemId) &&
        !revealed.has(card.root)
      ) {
        safe(() => revealers.get(card.root)?.());
      }
      ensureTools(card, result, t);
      renderWhy(card, result);
    }
    const present = new Set(cards.map((c) => c.root));
    for (const [root, d] of decorated) {
      if (present.has(root)) continue;
      if (root.isConnected) {
        safe(() => {
          dom.clearDecoration(d.card);
        });
      }
      decorated.delete(root);
      revealed.delete(root);
    }
    for (const [root, ui] of tools) {
      if (present.has(root)) continue;
      ui.destroy();
      tools.delete(root);
    }
    for (const [root, ui] of whys) {
      if (present.has(root) && ui.host.isConnected) continue;
      ui.destroy();
      whys.delete(root);
    }
  }

  function clearAll(): void {
    for (const { card } of decorated.values()) {
      if (card.root.isConnected) {
        safe(() => {
          dom.clearDecoration(card);
        });
      }
    }
    decorated.clear();
    revealed.clear();
    for (const ui of tools.values()) ui.destroy();
    tools.clear();
    for (const ui of whys.values()) ui.destroy();
    whys.clear();
    cards = [];
  }

  function showAll(): void {
    for (const { card, deco } of Array.from(decorated.values())) {
      if (deco.kind === 'hide' && card.degraded !== true && !revealed.has(card.root)) {
        safe(() => revealers.get(card.root)?.());
      }
    }
    renderPage();
  }

  function hideAgain(): void {
    for (const { card } of Array.from(decorated.values())) {
      if (!revealed.has(card.root)) continue;
      safe(() => {
        dom.clearDecoration(card);
      });
      revealed.delete(card.root);
      page.revealedIds.delete(card.itemId);
    }
    applyAll();
    renderPage();
  }

  // ── page UI ──────────────────────────────────────────────────────────────

  function view(): PageView {
    if (!settings.overlay.enabled) return { kind: 'off' };
    if (killed()) return { kind: 'idle', text: 'ShopBadwill paused (kill switch)' };
    if (settingsUnreadable) return { kind: 'idle', text: 'ShopBadwill paused (settings unreadable)' };
    if (dom.pageKind(page.url) !== 'search') return { kind: 'idle', text: 'ShopBadwill ready' };
    if (zeroVerdict()) return { kind: 'banner' };
    let hidden = 0;
    let shown = 0;
    for (const { card, deco } of decorated.values()) {
      if (deco.kind !== 'hide' || card.degraded === true) continue;
      if (revealed.has(card.root)) shown += 1;
      else hidden += 1;
    }
    if (hidden > 0) return { kind: 'hidden', count: hidden };
    if (shown > 0) return { kind: 'shown', count: shown };
    if (evaluateFailed) return { kind: 'idle', text: "ShopBadwill couldn't check your rules" };
    return { kind: 'idle', text: 'ShopBadwill: nothing hidden' };
  }

  function renderPage(): void {
    const container = pageContainer;
    if (container === null || stopped) return;
    safe(() => {
      render(
        h(PageStatus, {
          view: view(),
          collapsed: pillCollapsed,
          onShowAll: showAll,
          onHideAgain: hideAgain,
          onCollapse: () => {
            pillCollapsed = true;
            renderPage();
          },
          onExpand: () => {
            pillCollapsed = false;
            renderPage();
          },
        }),
        container,
      );
    });
  }

  // ── health ───────────────────────────────────────────────────────────────

  function reportHealth(url: string, kind: string, report: DiscoveryReport | null): void {
    if (report === null || (report.count === 0 && !zeroVerdict())) return;
    const fallbackUsed = report.rank !== null && report.rank > 0;
    const key = `${String(report.count)}|${String(fallbackUsed)}|${report.configVersion}`;
    if (key === page.healthKey) return;
    page.healthKey = key;
    send('page.domHealth', { url, configVersion: report.configVersion, pageKind: kind, cardsFound: report.count, fallbackUsed });
  }

  // ── scanning ─────────────────────────────────────────────────────────────

  function clearPageTimers(): void {
    if (settleTimer !== undefined) clearTimeout(settleTimer);
    if (noReplyTimer !== undefined) clearTimeout(noReplyTimer);
    settleTimer = undefined;
    noReplyTimer = undefined;
  }

  /** The page's clocks: settleMs, then (without a search reply) noReplyMs; a zero-card page re-scans at each. */
  function startSettle(): void {
    clearPageTimers();
    const p = page;
    const rescanIfEmpty = (): void => {
      if (p.cardsFound === null || p.cardsFound === 0) void scan();
    };
    settleTimer = setTimeout(() => {
      settleTimer = undefined;
      if (stopped || p !== page) return;
      p.settled = true;
      rescanIfEmpty();
    }, settleMs);
    noReplyTimer = setTimeout(() => {
      noReplyTimer = undefined;
      if (stopped || p !== page) return;
      p.replyWaitOver = true;
      rescanIfEmpty();
    }, noReplyMs);
  }

  function beginPage(url: string): void {
    page = newPage(url);
    if (initialized) startSettle();
  }

  /** The committed URL is the truth: a new one starts a new page (decorations cleared, reveals and health reset). */
  function syncPage(url: string): void {
    if (url === page.url) return;
    clearAll();
    beginPage(url);
  }

  /** One pass; true when another pass should follow (new results to apply). */
  async function scanOnce(): Promise<boolean> {
    scans += 1;
    const url = getUrl();
    syncPage(url);
    const kind = dom.pageKind(url);
    if (!activeOn(kind)) {
      clearAll();
      renderPage();
      return false;
    }
    let found: AdapterCardHandle[];
    try {
      found = dom.discoverCards(doc);
    } catch {
      found = [];
    }
    page.cardsFound = found.length;
    reportHealth(url, kind, dom.lastReport);
    cards = found;
    applyAll();
    renderPage();
    const need = [...new Set(found.map((c) => c.itemId))].filter(needsEval);
    if (need.length === 0) return false;
    const changed = await evaluate(need);
    if (!changed) renderPage();
    return changed;
  }

  let running: Promise<void> | null = null;
  let again = false;

  function scan(): Promise<void> {
    if (stopped || !initialized || suspended) return running ?? Promise.resolve();
    if (running !== null) {
      again = true;
      return running;
    }
    // `running` is set before any work, so a scan requested during this one only queues another pass.
    let done = (): void => undefined;
    const current = new Promise<void>((resolve) => {
      done = resolve;
    });
    running = current;
    void (async () => {
      try {
        do {
          again = false;
          if (await scanOnce()) again = true;
        } while (again && live());
      } catch {
        /* never break the page */
      } finally {
        running = null;
        done();
      }
    })();
    return current;
  }

  function clearDebounce(): void {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }

  /** Debounced scan with a maximum wait, so a constantly changing page still gets scanned. */
  function schedule(): void {
    if (stopped || suspended) return;
    const t = Date.now();
    if (debounceTimer === undefined) firstPendingAt = t;
    else clearTimeout(debounceTimer);
    const wait = Math.max(0, Math.min(debounceMs, firstPendingAt + maxWaitMs - t));
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void scan();
    }, wait);
  }

  const observer = new win.MutationObserver((records) => {
    if (records.some(foreign)) schedule();
  });
  function observe(): void {
    const body = doc.querySelector('body');
    if (body === null) return;
    // href/id: a re-used card that now shows another item.
    observer.observe(body, { childList: true, subtree: true, attributes: true, attributeFilter: ['href', 'id'] });
  }

  // ── inputs ───────────────────────────────────────────────────────────────

  function remember(l: Listing): void {
    listings.delete(l.itemId);
    listings.set(l.itemId, l);
    while (listings.size > MAX_LISTINGS) {
      const oldest = listings.keys().next();
      if (oldest.done === true) break;
      listings.delete(oldest.value);
      results.delete(oldest.value);
      failed.delete(oldest.value);
    }
  }

  function ingestSearch(body: unknown): void {
    const url = getUrl();
    const observedAt = now();
    let items: Listing[];
    try {
      items = normalizeSearch(body, searchContext(url, observedAt, tokenSeen)).items.map((l) => ({ ...l, source: 'tap' as const }));
    } catch {
      return; // not a search reply we understand: ignore it
    }
    for (const l of items) remember(l);
    syncPage(url);
    page.lastSearchCount = items.length;
    send('page.listings', { url, listings: items, capturedAt: observedAt });
    if (items.length > 0) void scan();
    else renderPage();
  }

  function onMessage(ev: MessageEvent): void {
    if (stopped || ev.source !== win) return;
    let msg;
    try {
      msg = parseTapMessage(ev.data, nonce);
    } catch {
      return;
    }
    if (msg === null) return;
    if (msg.kind === 'token') {
      tokenSeen = true;
      send('page.token', { bearer: msg.bearer, capturedAt: now() });
      return;
    }
    if (msg.status === 200 && isSearchApi(msg.url)) ingestSearch(msg.body);
  }

  async function loadSettings(): Promise<void> {
    let read: SettingsRead;
    try {
      read = readSettings(await storage.get(STORAGE_KEYS.settings));
    } catch {
      read = { kind: 'invalid', killSwitch: false };
    }
    applySettings(read);
  }

  async function loadRules(): Promise<void> {
    try {
      rules = parseRules(await storage.get(STORAGE_KEYS.rules));
    } catch {
      rules = new Map();
    }
  }

  /** Rules or settings changed: every evaluation is stale (still shown until re-evaluated). */
  function bump(): void {
    generation += 1;
    failed.clear();
    evaluateFailed = false;
    void scan();
  }

  function onPageHide(): void {
    suspended = true;
    observer.disconnect();
    clearDebounce();
    clearRetry();
  }

  function onPageShow(ev: Event): void {
    if (stopped || !suspended || !(ev as PageTransitionEvent).persisted) return;
    suspended = false;
    failed.clear();
    observe();
    void scan();
  }

  win.addEventListener('message', onMessage);
  const offStorage = storage.onChanged((changes) => {
    const s = changes[STORAGE_KEYS.settings];
    const r = changes[STORAGE_KEYS.rules];
    if (s !== undefined) applySettings(readSettings(s.newValue));
    if (r !== undefined) rules = parseRules(r.newValue);
    if (s !== undefined || r !== undefined) bump();
  });
  const offRules = client.onBroadcast('rules.changed', () => {
    void loadRules().then(bump);
  });
  const offSwitches = client.onBroadcast('switches.changed', (p) => {
    killOverride = p.killSwitch;
    void scan();
  });

  const ready = (async () => {
    await Promise.all([loadSettings(), loadRules()]);
    await domReady(doc);
    if (!live()) return;
    try {
      const ui = await mountPageUi({
        onMount(container) {
          pageContainer = container;
        },
        onRemove() {
          const container = pageContainer;
          pageContainer = null;
          if (container !== null) {
            safe(() => {
              render(null, container);
            });
          }
        },
      });
      if (!live()) {
        ui.remove();
        return;
      }
      pageUi = ui;
    } catch {
      /* without the page UI, decorations still work */
    }
    initialized = true;
    if (page.url !== getUrl()) page = newPage(getUrl());
    startSettle();
    observe();
    win.addEventListener('pagehide', onPageHide);
    win.addEventListener('pageshow', onPageShow);
    renderPage();
    await scan();
  })().catch(() => undefined);

  return {
    nonce,
    ready,
    get scanCount() {
      return scans;
    },
    memory() {
      return { listings: listings.size, results: results.size, failed: failed.size };
    },
    scan,
    onLocationChange(url) {
      if (stopped) return;
      // With the Navigation API the event can precede the URL commit: the scans
      // go by the committed URL (syncPage), now and once more after the debounce.
      if (url === getUrl()) syncPage(url);
      void scan();
      schedule();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      observer.disconnect();
      clearDebounce();
      clearRetry();
      clearPageTimers();
      win.removeEventListener('message', onMessage);
      win.removeEventListener('pagehide', onPageHide);
      win.removeEventListener('pageshow', onPageShow);
      offStorage();
      offRules();
      offSwitches();
      clearAll();
      const ui = pageUi;
      pageUi = null;
      safe(() => ui?.remove());
      if (doc.documentElement.getAttribute(NONCE_ATTR) === nonce) doc.documentElement.removeAttribute(NONCE_ATTR);
    },
  };
}
