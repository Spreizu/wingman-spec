import { basename, join } from 'node:path';
import { computeAdrSync, parseRootAdr } from './adrSync.ts';
import { isPlaceholder } from './frontMatter.ts';
import type { RootAdr, SourceAdr } from './types.ts';

export interface FileWrite {
  path: string;
  content: string;
  kind: 'create' | 'update';
}

export interface PromotePlan {
  writes: FileWrite[];
  /** Human-readable lines, one per decision. */
  notes: string[];
  /** Problems that stopped an ADR from being promoted. */
  errors: string[];
}

export interface PromoteInput {
  change: string;
  sources: SourceAdr[];
  roots: RootAdr[];
  adrDir: string;
  /** Current raw text of a file in the ADR directory, or undefined when it does not exist. */
  read(path: string): string | undefined;
}

function nextNumber(roots: RootAdr[]): string {
  const max = roots.reduce((m, r) => Math.max(m, Number(r.number)), 0);
  return String(max + 1).padStart(4, '0');
}

/**
 * Sets header keys in an ADR's front matter without touching anything else: other keys, comments, order, blank lines, the body
 * and the line endings (LF or CRLF) stay as written. A missing key is added before the closing `---`.
 */
export function setHeader(raw: string, updates: Array<[string, string]>): string {
  const lines = raw.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const bare = (l: string): string => l.replace(/\r?\n$/, '');
  if (lines.length === 0 || bare(lines[0] ?? '') !== '---') return raw;
  let end = lines.findIndex((l, i) => i > 0 && bare(l) === '---');
  if (end < 0) return raw;
  const eol = /\r\n$/.test(lines[0] ?? '') ? '\r\n' : '\n';
  for (const [key, value] of updates) {
    const i = lines.findIndex((l, n) => n > 0 && n < end && l.startsWith(`${key}:`));
    if (i >= 0) {
      const old = lines[i] ?? '';
      lines[i] = `${key}: ${value}${/\r\n$/.test(old) ? '\r\n' : /\n$/.test(old) ? '\n' : eol}`;
    } else {
      lines.splice(end, 0, `${key}: ${value}${eol}`);
      end++;
    }
  }
  return lines.join('');
}

/** Length of the front matter block of `raw`, closing `---` line included. */
function headerLength(raw: string): number {
  const m = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  return m ? m[0].length : 0;
}

function setStatus(raw: string, status: string): string {
  return setHeader(raw, [['status', status]]);
}

/**
 * Plans the same promotion `/spec-sync` step 2 performs: number or update the root ADR that carries
 * `source: <change>/<slug>` and mark a superseded ADR. The ADR directory has no generated index (parallel branches would conflict on it),
 * and a promoted ADR keeps the header keys and comments a person added. Pure; the caller performs the writes.
 */
export function planPromote(input: PromoteInput): PromotePlan {
  const { change, sources, adrDir, read } = input;
  let working = [...input.roots];
  const writes = new Map<string, FileWrite>();
  const notes: string[] = [];
  const errors: string[] = [];

  const put = (path: string, content: string): void => {
    const before = writes.get(path)?.content ?? read(path);
    if (before === content) return;
    writes.set(path, { path, content, kind: before === undefined ? 'create' : 'update' });
  };

  for (const source of sources) {
    const f = source.fields;
    const sync = computeAdrSync(change, source, working);
    if (sync.state === 'none') {
      notes.push(`${source.slug}: skipped (status none)`);
      continue;
    }
    if (sync.state === 'unfilled' || sync.state === 'error') {
      errors.push(`${source.slug}: ${sync.detail}`);
      continue;
    }
    if (sync.state === 'up-to-date') {
      notes.push(`${source.slug}: unchanged (${basename(sync.target?.path ?? '')})`);
      continue;
    }

    const title = (f['title'] ?? '').trim();
    const date = (f['date'] ?? '').trim();
    const supersedes = isPlaceholder(f['supersedes']) ? '' : (f['supersedes'] ?? '').trim();
    const target = working.find((r) => r.source === `${change}/${source.slug}`);
    const number = target?.number ?? nextNumber(working);
    const fileName = target ? basename(target.path) : `${number}-${source.slug}.md`;
    const path = target?.path ?? join(input.adrDir, fileName);
    const status = target && /^(superseded|deprecated)/i.test(target.status) ? target.status : 'Accepted';

    const keys: Array<[string, string]> = [['title', title], ['status', status], ['date', date], ['change', change], ['source', `${change}/${source.slug}`]];
    if (supersedes) keys.push(['supersedes', supersedes]);
    const existing = target ? read(target.path) : undefined;
    const withBody = (head: string): string => `${head}${source.body}`;
    const content =
      existing !== undefined && /^---\r?\n/.test(existing)
        ? withBody(setHeader(existing.slice(0, headerLength(existing)), keys))
        : `${['---', ...keys.map(([k, v]) => `${k}: ${v}`)].join('\n')}\n---\n${source.body}`;

    const promoted = parseRootAdr(fileName, path, content);
    if (!promoted) {
      errors.push(`${source.slug}: could not build ${fileName}`);
      continue;
    }
    const before = writes.get(path)?.content ?? read(path);
    if (before !== content) {
      put(path, content);
      notes.push(`${source.slug}: ${target ? `updated ${fileName}` : `promoted as ${fileName}`}`);
    }
    working = target ? working.map((r) => (r.number === number ? promoted : r)) : [...working, promoted];

    if (supersedes) {
      const old = working.find((r) => r.number === supersedes);
      const raw = old ? (writes.get(old.path)?.content ?? read(old.path)) : undefined;
      if (old && raw !== undefined && !/^superseded/i.test(old.status)) {
        const updated = setStatus(raw, `Superseded by ${number}`);
        put(old.path, updated);
        const reparsed = parseRootAdr(basename(old.path), old.path, updated);
        if (reparsed) working = working.map((r) => (r.number === old.number ? reparsed : r));
        notes.push(`marked ${basename(old.path)} as Superseded by ${number}`);
      }
    }
  }

  return { writes: [...writes.values()], notes, errors };
}
