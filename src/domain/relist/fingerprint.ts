// T-113: the relist fingerprint. A relisted item gets a new item id, so the
// detector matches on what a relist keeps: the seller, the title (normalized,
// so cosmetic edits still match) and the image file name (the basename only,
// so a different image host or query string still matches). Pure.
import type { Listing } from '../types';

/** The normalized title is capped so a stored fingerprint stays small. */
export const MAX_TITLE_CHARS = 120;

/** Lowercase, accents stripped, every run of non-letters/digits one space, trimmed, capped. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, MAX_TITLE_CHARS)
    .trim();
}

/** The last path segment of the image URL, lowercased, without query or fragment; '' when none. */
export function imageBasename(url: string | undefined): string {
  if (url === undefined) return '';
  const path = url.split(/[?#]/, 1)[0] ?? '';
  const segments = path.split(/[/\\]/);
  return (segments[segments.length - 1] ?? '').trim().toLowerCase().slice(0, 100);
}

/** `sellerId|normalized title|image basename`, or null when the title has nothing to match on. */
export function relistFingerprint(listing: Pick<Listing, 'title' | 'sellerId' | 'imageUrl'>): string | null {
  const title = normalizeTitle(listing.title);
  if (title === '') return null;
  return `${String(listing.sellerId)}|${title}|${imageBasename(listing.imageUrl)}`;
}
