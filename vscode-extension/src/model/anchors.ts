/**
 * Code anchors: `@spec <capability>/<requirement-slug>` markers in any file and `[capability/scenario-slug]` tags in
 * test files. Mirrors the CLI's trace package (same comment leaders, same slug rule), so the
 * editor agrees with `wingman-spec anchors|drift`. Pure Node, no VS Code.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { join } from 'node:path';
import placement from '../core/placement.ts';
import quality from '../core/plan.ts';
import traceability from '../core/plan.ts';
import testPaths from '../core/testpaths.ts';

/** The requirement/scenario slug: the name lower-cased, runs of other characters become one dash. */
export const slug = (s: string): string => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scenario';

// The marker syntax lives in core/placement.ts (the same rules as the CLI for the editor and the scripts).
const { keyHits } = placement;
const { TAG_RE } = quality;
const MAX_BYTES = 1024 * 1024;

// Which files are tests lives in core/testpaths.ts (the same rules as the CLI for the editor and the scripts).
export const { isTestPath, isTestFile } = testPaths;

/** True for a file the verifier would scan (relative, `/`-separated path): the verifier's own rule. */
export const { isScannable } = traceability;

export interface Marker {
  /** `capability/requirement-slug` (a marker written with the requirement's ID: its key). */
  key: string;
  /** Zero-based line and the column range of the key itself. */
  line: number;
  col: number;
  length: number;
}

/** Markers of one text. A comment may list several keys: `@spec a/b, c/d`; a requirement ID resolves to its key. */
export function markersIn(text: string): Marker[] {
  const out: Marker[] = [];
  text.split('\n').forEach((l, i) => {
    for (const h of keyHits(l)) out.push({ key: h.key, line: i, col: h.col, length: h.length });
  });
  return out;
}

export interface Tag {
  /** `capability/scenario-slug`. */
  tag: string;
  line: number;
  col: number;
  length: number;
}

/** `[capability/scenario-slug]` tags of one (test file) text; the brackets are not part of the range. */
export function tagsIn(text: string): Tag[] {
  const out: Tag[] = [];
  text.split('\n').forEach((l, i) => {
    for (const m of l.matchAll(TAG_RE)) {
      const tag = m[1] ?? '';
      out.push({ tag, line: i, col: (m.index ?? 0) + 1, length: tag.length });
    }
  });
  return out;
}

/** The most similar known key in the same capability (word overlap), or undefined. */
export function nearest(key: string, keys: Iterable<string>): string | undefined {
  const words = (s: string): Set<string> => new Set(s.split(/[^a-z0-9]+/).filter(Boolean));
  const cap = key.split('/')[0];
  const w = words(key.split('/')[1] ?? '');
  let best: string | undefined;
  let bestScore = 0;
  for (const k of keys) {
    if (k.split('/')[0] !== cap) continue;
    const kw = words(k.split('/')[1] ?? '');
    let n = 0;
    for (const x of w) if (kw.has(x)) n++;
    const s = n / Math.max(w.size, kw.size, 1);
    if (s > bestScore) {
      bestScore = s;
      best = k;
    }
  }
  return bestScore >= 0.34 ? best : undefined;
}

export interface ScannedFile {
  /** Path relative to the code root, `/`-separated. */
  file: string;
  test: boolean;
  markers: Marker[];
  tags: Tag[];
}

type CacheEnt = { mtimeMs: number; size: number; hit?: ScannedFile };
const scanCaches = new Map<string, Map<string, CacheEnt>>();

/** The cache entry of one file from its stat and (when small enough) its text. */
function entryOf(rel: string, st: Stats, text: string | undefined): CacheEnt {
  const base = { mtimeMs: st.mtimeMs, size: st.size };
  if (text === undefined || text.includes('\0')) return base;
  const markers = text.includes('@spec') ? markersIn(text) : [];
  const tags = isTestFile(rel) ? tagsIn(text) : [];
  return markers.length || tags.length ? { ...base, hit: { file: rel, test: isTestPath(rel), markers, tags } } : base;
}

const readable = (st: Stats): boolean => st.isFile() && st.size <= MAX_BYTES;

function readOne(codeRoot: string, rel: string, known?: Stats): CacheEnt | undefined {
  const full = join(codeRoot, rel);
  let st = known;
  try {
    st ??= statSync(full);
  } catch {
    return undefined;
  }
  let text: string | undefined;
  try {
    if (readable(st)) text = readFileSync(full, 'utf8');
  } catch {
    text = undefined;
  }
  return entryOf(rel, st, text);
}

/** Drop cached scan data (tests, or a deleted file). */
export function forgetScan(codeRoot?: string, rel?: string): void {
  if (!codeRoot) {
    scanCaches.clear();
    return;
  }
  if (!rel) {
    scanCaches.delete(codeRoot);
    return;
  }
  scanCaches.get(codeRoot)?.delete(rel.split('\\').join('/'));
}

/** Scans the code root for markers (every scannable file) and tags (test files). Bounded, no git needed. `only` patches those relative paths into the cache. */
export function scanCode(codeRoot: string, maxFiles = 20000, only?: Iterable<string>): ScannedFile[] {
  const cache = cacheOf(codeRoot);
  if (only) {
    for (const raw of only) {
      const rel = raw.split('\\').join('/');
      if (!isScannable(rel)) {
        cache.delete(rel);
        continue;
      }
      const ent = readOne(codeRoot, rel);
      if (!ent) cache.delete(rel);
      else cache.set(rel, ent);
    }
  } else {
    const files = listScannable(codeRoot, maxFiles);
    for (const r of files) refresh(codeRoot, cache, r);
    prune(cache, files);
  }
  return hitsOf(cache);
}

/** scanCode of the whole code root without holding the event loop: the same walk, cache and result, in slices of a few milliseconds. */
export async function scanCodeAsync(codeRoot: string, maxFiles = 20000): Promise<ScannedFile[]> {
  await new Promise((done) => setImmediate(done));
  const files = listScannable(codeRoot, maxFiles);
  let slice = performance.now();
  for (const r of files) {
    if (performance.now() - slice > 8) {
      await new Promise((done) => setImmediate(done));
      slice = performance.now();
    }
    refresh(codeRoot, cacheOf(codeRoot), r);
  }
  const cache = cacheOf(codeRoot);
  const ordered = new Map<string, CacheEnt>(); // walk order, also when the cache was seeded from the last session
  for (const r of files) {
    const ent = cache.get(r);
    if (ent) ordered.set(r, ent);
  }
  scanCaches.set(codeRoot, ordered);
  return hitsOf(ordered);
}

export type ScanDump = [string, CacheEnt][];
/** The scan cache of a code root, to seed the next session (every entry is checked again against its file's size and mtime). */
export function dumpScan(codeRoot: string): ScanDump {
  return [...(scanCaches.get(codeRoot) ?? [])];
}
/** Seeds the scan cache of a code root not scanned yet in this session. */
export function seedScan(codeRoot: string, dump: ScanDump): void {
  if (!scanCaches.has(codeRoot)) scanCaches.set(codeRoot, new Map(dump));
}

function cacheOf(codeRoot: string): Map<string, CacheEnt> {
  let cache = scanCaches.get(codeRoot);
  if (!cache) {
    cache = new Map();
    scanCaches.set(codeRoot, cache);
  }
  return cache;
}

/** Re-reads one listed file into the cache unless its size and mtime are unchanged; a file that cannot be stat'ed keeps its entry. */
function refresh(codeRoot: string, cache: Map<string, CacheEnt>, r: string): void {
  let st;
  try {
    st = statSync(join(codeRoot, r));
  } catch {
    return;
  }
  const prev = cache.get(r);
  if (prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return;
  const ent = readOne(codeRoot, r, st);
  if (ent) cache.set(r, ent);
  else cache.delete(r);
}

/** The scannable files under the code root in walk order, at most maxFiles + 1 (the verifier's skip rules). */
function listScannable(codeRoot: string, maxFiles: number): string[] {
  const files: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.length > maxFiles) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (isScannable(`${r}/.`)) walk(join(dir, e.name), r);
        continue;
      }
      if (e.isFile() && isScannable(r)) files.push(r);
    }
  };
  walk(codeRoot, '');
  return files;
}

function prune(cache: Map<string, CacheEnt>, files: string[]): void {
  const seen = new Set(files);
  for (const k of [...cache.keys()]) if (!seen.has(k)) cache.delete(k);
}

function hitsOf(cache: Map<string, CacheEnt>): ScannedFile[] {
  const out: ScannedFile[] = [];
  for (const ent of cache.values()) if (ent.hit) out.push(ent.hit);
  return out;
}

/** The marker or tag under a position, for hover and go-to-definition. */
export function itemAt(text: string, line: number, col: number, isTest: boolean): { kind: 'marker' | 'tag'; key: string; col: number; length: number } | undefined {
  const lines = text.split('\n');
  const l = lines[line];
  if (l === undefined) return undefined;
  const hit = markersIn(l).find((m) => col >= m.col && col <= m.col + m.length);
  if (hit) return { kind: 'marker', key: hit.key, col: hit.col, length: hit.length };
  if (isTest) {
    const t = tagsIn(l).find((x) => col >= x.col - 1 && col <= x.col + x.length + 1);
    if (t) return { kind: 'tag', key: t.tag, col: t.col, length: t.length };
  }
  return undefined;
}
