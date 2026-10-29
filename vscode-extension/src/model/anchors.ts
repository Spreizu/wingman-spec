/**
 * Code anchors: `@spec <capability>/<requirement-slug>` markers in any file and `[capability/scenario-slug]` tags in
 * test files. Mirrors openspec/scripts/traceability.cjs and quality.cjs (same comment leaders, same slug rule), so the
 * editor agrees with `verify-task.cjs anchors|drift`. Pure Node, no VS Code.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import placement from '../../../project-template/openspec/scripts/placement.cjs';
import quality from '../../../project-template/openspec/scripts/quality.cjs';
import traceability from '../../../project-template/openspec/scripts/traceability.cjs';
import testPaths from '../../../project-template/openspec/scripts/testpaths.cjs';

/** The requirement/scenario slug: the name lower-cased, runs of other characters become one dash. */
export const slug = (s: string): string => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scenario';

// The marker syntax lives in the verifier's placement.cjs (one definition for the editor and the scripts).
const { MARKER_LEADER, KEY } = placement;
const { TAG_RE } = quality;
const MAX_BYTES = 1024 * 1024;

// Which files are tests lives in the verifier's testpaths.cjs (one definition for the editor and the scripts).
export const { isTestPath, isTestFile } = testPaths;

/** True for a file the verifier would scan (relative, `/`-separated path): the verifier's own rule. */
export const { isScannable } = traceability;

export interface Marker {
  /** `capability/requirement-slug`. */
  key: string;
  /** Zero-based line and the column range of the key itself. */
  line: number;
  col: number;
  length: number;
}

/** Markers of one text. A comment may list several keys: `@spec a/b, c/d`. */
export function markersIn(text: string): Marker[] {
  const out: Marker[] = [];
  text.split('\n').forEach((l, i) => {
    const m = MARKER_LEADER.exec(l);
    if (!m) return;
    let pos = m.index + m[0].length;
    for (;;) {
      const k = KEY.exec(l.slice(pos));
      if (!k) break;
      const key = `${k[1]}/${k[2]}`;
      out.push({ key, line: i, col: pos + k[0].length - key.length, length: key.length });
      pos += k[0].length;
    }
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

/** Scans the code root for markers (every scannable file) and tags (test files). Bounded, no git needed. */
export function scanCode(codeRoot: string, maxFiles = 20000): ScannedFile[] {
  const out: ScannedFile[] = [];
  let seen = 0;
  const walk = (dir: string, rel: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (seen > maxFiles) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (isScannable(`${r}/.`)) walk(join(dir, e.name), r);
        continue;
      }
      if (!e.isFile() || !isScannable(r)) continue;
      seen++;
      const full = join(dir, e.name);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.size > MAX_BYTES) continue;
      let text: string;
      try {
        text = readFileSync(full, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\0')) continue;
      const test = isTestPath(r);
      const markers = text.includes('@spec') ? markersIn(text) : [];
      const tags = isTestFile(r) ? tagsIn(text) : [];
      if (markers.length || tags.length) out.push({ file: r, test, markers, tags });
    }
  };
  walk(codeRoot, '');
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
