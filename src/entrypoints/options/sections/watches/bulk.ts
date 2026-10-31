// T-125: pure helpers for "Add several watches": pasted lines -> watch drafts.
// Each line is `Name | <search address>` or just the address. No SGW request.
import type { SearchQuery } from '../../../../domain/types';
import { searchKey } from '../../../onboarding/steps';
import { defaultWatchName, newDraft, queryFromUrl, type WatchDraft } from './draft';

export interface BulkEntry {
  lineNo: number;
  name: string;
  query: SearchQuery;
}

export interface BulkSkip {
  lineNo: number;
  /** The line as typed, trimmed and shortened for display. */
  text: string;
  reason: string;
}

export interface BulkPreview {
  add: BulkEntry[];
  skip: BulkSkip[];
}

const SHOWN_LINE = 80;
const shorten = (s: string): string => (s.length > SHOWN_LINE ? `${s.slice(0, SHOWN_LINE - 1)}…` : s);

/** Splits `Name | address` (or a bare address) into its name and address. */
function splitLine(line: string): { name: string; address: string } {
  if (/^https?:\/\//i.test(line)) return { name: '', address: line };
  const bar = line.indexOf('|');
  if (bar < 0) return { name: '', address: line };
  return { name: line.slice(0, bar).trim(), address: line.slice(bar + 1).trim() };
}

/**
 * The preview for the pasted text. Blank lines are ignored. A line whose search
 * equals an existing watch's (same identity as `watches.save` stores) or an
 * earlier line's is skipped.
 */
export function parseBulkWatches(text: string, existing: ReadonlyArray<{ query: SearchQuery }>): BulkPreview {
  const known = new Set(existing.map((w) => searchKey(w.query)));
  const earlier = new Map<string, number>();
  const add: BulkEntry[] = [];
  const skip: BulkSkip[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const lineNo = i + 1;
    const line = raw.trim();
    if (line === '') return;
    const { name, address } = splitLine(line);
    const fail = (reason: string): void => {
      skip.push({ lineNo, text: shorten(line), reason });
    };
    if (address === '') {
      fail('No search address on this line.');
      return;
    }
    const r = queryFromUrl(address);
    if (!r.ok) {
      fail(r.error);
      return;
    }
    const key = searchKey(r.query);
    if (known.has(key)) {
      fail('Already a watch.');
      return;
    }
    const first = earlier.get(key);
    if (first !== undefined) {
      fail(`The same search as line ${String(first)}.`);
      return;
    }
    earlier.set(key, lineNo);
    add.push({ lineNo, name: name === '' ? defaultWatchName(r.query) : name, query: r.query });
  });
  return { add, skip };
}

/** A new watch draft for one entry: the single-add defaults, the batch's notify choice. */
export function bulkDraft(entry: BulkEntry, id: string, notify: boolean): WatchDraft {
  return { ...newDraft(id, entry.query), name: entry.name, notify };
}
