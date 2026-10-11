// T-85: the arming UI is text only. A sink in these files would pass a title
// through as HTML. Comments are stripped so a mention in prose is not a hit.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
  });
}

const SINK = /\b(innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|createContextualFragment)\b|document\.write/;

describe('snipes arming UI is text only', () => {
  it('the snipes section and the exposure meter have no HTML-string sink', () => {
    const sources = [...files(path.join(root, 'src/ui/dashboard/sections/snipes')), ...files(path.join(root, 'src/ui/exposure'))];
    expect(sources.length).toBeGreaterThan(2);
    const offenders = sources.filter((f) => SINK.test(readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '')));
    expect(offenders).toEqual([]);
  });
});
