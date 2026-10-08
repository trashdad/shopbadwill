// I-06 section registry. The shell loads `./sections/*/index.tsx`; each module
// exports `section`. A later card adds one folder under sections/ and nothing
// else in the shell changes.
import type { ComponentType } from 'preact';

import type { MessagingClient } from '../../ports/messaging';

export interface SectionProps {
  client: MessagingClient;
}

export interface SectionDef {
  /** Unique and URL-safe: used for the anchor and element ids. */
  id: string;
  title: string;
  /** Ascending; ties break by id. */
  order: number;
  Component: ComponentType<SectionProps>;
}

function isSectionDef(value: unknown): value is SectionDef {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    /^[a-z][a-z0-9-]*$/.test(v['id']) &&
    typeof v['title'] === 'string' &&
    typeof v['order'] === 'number' &&
    typeof v['Component'] === 'function'
  );
}

/** Validates the glob result and returns the sections in display order. Throws on a malformed or duplicate section. */
export function loadSections(modules: Record<string, unknown>): SectionDef[] {
  const found: SectionDef[] = [];
  for (const [path, mod] of Object.entries(modules)) {
    const section = typeof mod === 'object' && mod !== null ? (mod as Record<string, unknown>)['section'] : undefined;
    if (!isSectionDef(section)) throw new Error(`${path} must export a valid "section" (id, title, order, Component)`);
    if (found.some((s) => s.id === section.id)) throw new Error(`duplicate options section id "${section.id}" (${path})`);
    found.push(section);
  }
  return found.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}
