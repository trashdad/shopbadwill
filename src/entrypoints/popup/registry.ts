// I-06: the popup section registry. A later card adds one folder
// `sections/<name>/index.tsx` that exports `section: PopupSection`; nothing
// else in the shell changes.
import type { ComponentType } from 'preact';

import type { MessagingClient } from '../../ports/messaging';

export interface SectionProps {
  messaging: MessagingClient;
}

export interface PopupSection {
  /** Unique, stable id (also the DOM id of the section). */
  id: string;
  /** Ascending; ties are broken by id. */
  order: number;
  Component: ComponentType<SectionProps>;
}

export interface SectionModule {
  section?: PopupSection;
}

/** Sorts the sections found in `modules`; modules without a `section` export are skipped, duplicate ids throw. */
export function collectSections(modules: Record<string, SectionModule>): PopupSection[] {
  const found: PopupSection[] = [];
  const seen = new Set<string>();
  for (const mod of Object.values(modules)) {
    const s = mod.section;
    if (s === undefined) continue;
    if (seen.has(s.id)) throw new Error(`popup: duplicate section id "${s.id}"`);
    seen.add(s.id);
    found.push(s);
  }
  return found.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

// Every sections/<name>/index.tsx, bundled eagerly (the popup is tiny and must paint at once).
export function loadSections(): PopupSection[] {
  return collectSections(import.meta.glob<SectionModule>('./sections/*/index.tsx', { eager: true }));
}
