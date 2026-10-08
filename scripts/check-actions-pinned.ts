import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Fails if any `uses:` in .github/workflows is not `owner/repo[/path]@<40 lowercase hex>`.
// Local actions (`./...`) are allowed. Tags, branches and short SHAs are mutable (supply-chain risk).

export interface Finding {
  file: string;
  line: number;
  uses: string;
}

const PINNED = /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40}$/;
const USES_LINE = /^\s*(?:-\s+)?uses:\s*(.*)$/;

function stripValue(raw: string): string {
  const v = raw.trim();
  const quoted = /^(["'])(.*?)\1/.exec(v);
  if (quoted) return (quoted[2] ?? '').trim();
  return v.replace(/\s+#.*$/, '').trim();
}

export function checkWorkflow(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split(/\r?\n/).forEach((lineText, i) => {
    const m = USES_LINE.exec(lineText);
    if (!m) return;
    const uses = stripValue(m[1] ?? '');
    if (uses.startsWith('./')) return;
    if (!PINNED.test(uses)) findings.push({ file, line: i + 1, uses });
  });
  return findings;
}

export async function checkDirectory(dir: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  const names = (await readdir(dir)).filter((n) => /\.ya?ml$/.test(n)).sort();
  for (const name of names) {
    findings.push(...checkWorkflow(name, await readFile(path.join(dir, name), 'utf8')));
  }
  return findings;
}

async function main(): Promise<void> {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const findings = await checkDirectory(path.join(root, '.github', 'workflows'));
  for (const f of findings) {
    console.error(`${f.file}:${String(f.line)}  not pinned to a full commit SHA: ${f.uses}`);
  }
  if (findings.length > 0) process.exit(1);
  console.log('check-actions-pinned: all actions pinned');
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
