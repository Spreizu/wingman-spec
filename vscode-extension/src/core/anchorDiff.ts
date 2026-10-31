/**
 * Is an `@spec` anchor still about the code it sits on? The anchored unit of every marker (whole function when the marker is in
 * its doc comment, else the lines directly below it) and the marker-level differences between two versions of a file. A unit's
 * body ignores blank lines, comments and spacing. A TS port of the CLI's anchors.Analyze/Compare (internal/anchors/analyze.go).
 */
import { ANNOTATION, CLOSING, COMMENT_LINE, MARKER_LEADER, docLines, isUnitStart, keysOf } from './placement.ts';

export interface AnchoredUnit {
  key: string;
  /** 1-based marker line. */
  line: number;
  /** 0-based, inclusive. */
  start: number;
  end: number;
  whole: boolean;
  header: string;
  body: string;
}

const indentOf = (l: string): number => (/^\s*/.exec(l)?.[0] ?? '').replace(/\t/g, '    ').length;
const normLine = (l: string): string => l.replace(/\s+(?:\/\/+|#+)(?:\s.*)?$/, '').replace(/\s+/g, ' ').trim();
const stripStrings = (l: string): string => l.replace(/\\./g, '').replace(/'[^']*'|"[^"]*"|`[^`]*`/g, '""').replace(/\s\/\/.*$/, '');

/** The anchored unit of every marker of one text. */
export function analyze(text: string): AnchoredUnit[] {
  const out: AnchoredUnit[] = [];
  if (!/@spec\b/.test(text)) return out;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const at = (i: number): string => lines[i] ?? '';
  const doc = docLines(lines);
  const isComment = (i: number): boolean => COMMENT_LINE.test(at(i)) || doc[i] === true;
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (!isComment(i) && isUnitStart(l)) starts.push(i);
  });
  const endCache = new Map<number, number>();
  const unitEnd = (s: number): number => {
    const cached = endCache.get(s);
    if (cached !== undefined) return cached;
    let brace = -1;
    if (!/:\s*$/.test(at(s))) {
      for (let j = s; j < Math.min(lines.length, s + 3); j++) {
        if (isComment(j)) continue;
        if (at(j).includes('{')) { brace = j; break; }
        if (/;\s*$/.test(at(j)) || (j > s && isUnitStart(at(j)))) break;
      }
    }
    let end = s;
    if (brace >= 0) {
      let depth = 0;
      let seen = false;
      end = lines.length - 1;
      for (let j = brace; j < lines.length; j++) {
        if (isComment(j)) continue;
        for (const ch of stripStrings(at(j))) {
          if (ch === '{') { depth++; seen = true; } else if (ch === '}') depth--;
        }
        if (seen && depth <= 0) { end = j; break; }
      }
    } else {
      const ind = indentOf(at(s));
      for (let j = s + 1; j < lines.length; j++) {
        if (!/\S/.test(at(j))) continue;
        if (indentOf(at(j)) > ind || (isComment(j) && indentOf(at(j)) >= ind)) { end = j; continue; }
        if (indentOf(at(j)) === ind && /^\s*end\b/.test(at(j))) end = j;
        break;
      }
    }
    endCache.set(s, end);
    return end;
  };
  const bodyOf = (a: number, b: number): string => {
    const o: string[] = [];
    for (let j = a; j <= b && j < lines.length; j++) {
      if (!/\S/.test(at(j)) || isComment(j)) continue;
      const n = normLine(at(j));
      if (n) o.push(n);
    }
    return o.join('\n');
  };
  lines.forEach((l, i) => {
    const keys = keysOf(l);
    if (!keys.length) return;
    const lead = l.slice(0, MARKER_LEADER.exec(l)?.index ?? 0).replace(/\/\*+|\*+/g, '');
    let start = -1;
    let end = -1;
    let whole = false;
    let header = '';
    let enclosing = -1;
    for (const s of starts) if (s <= i && unitEnd(s) >= i) enclosing = s;
    if (doc[i] && enclosing >= 0 && enclosing < i) {
      start = enclosing; end = unitEnd(enclosing); whole = true;
    } else {
      let j = i + 1;
      while (j < lines.length && (COMMENT_LINE.test(at(j)) || ANNOTATION.test(at(j)) || doc[j])) j++;
      if (j < lines.length && starts.includes(j) && /\S/.test(at(j)) && !/\S/.test(lead)) { start = j; end = unitEnd(j); whole = true; }
    }
    if (whole) header = normLine(at(start));
    else {
      const ind = indentOf(l);
      start = i + 1; end = i; header = enclosing >= 0 ? normLine(at(enclosing)) : '';
      if (/\S/.test(lead)) { start = i; end = i; } else {
        for (let j = i + 1; j < lines.length; j++) {
          if (!/\S/.test(at(j)) || CLOSING.test(at(j)) || indentOf(at(j)) < ind || keysOf(at(j)).length) break;
          end = j;
        }
      }
      if (end < start) { start = i; end = i; }
    }
    for (const key of keys) out.push({ key, line: i + 1, start, end, whole, header, body: bodyOf(start, end) });
  });
  return out;
}

export interface AnchorEvent {
  kind: 'modified' | 'added' | 'removed';
  key: string;
  line: number;
  header: string;
  whole: boolean;
  /** A modified unit whose header changed (same key, the unit was renamed or its signature changed). */
  renamed?: boolean;
  /** The unit body of an added or removed marker (to fold moves together). */
  body?: string;
}

/** Marker-level differences between two versions of one file. */
export function compareAnchors(baseText: string, curText: string): AnchorEvent[] {
  const id = (u: AnchoredUnit): string => `${u.key}|${u.whole ? 'U' : 'P'}|${u.header}`;
  const group = (xs: AnchoredUnit[]): Map<string, AnchoredUnit[]> => {
    const m = new Map<string, AnchoredUnit[]>();
    for (const u of xs) m.set(id(u), [...(m.get(id(u)) ?? []), u]);
    return m;
  };
  const ga = group(analyze(baseText));
  const gb = group(analyze(curText));
  const ev: AnchorEvent[] = [];
  const loseA: AnchoredUnit[] = [];
  const loseB: AnchoredUnit[] = [];
  for (const [k, bs] of gb) {
    const as = ga.get(k) ?? [];
    bs.forEach((b, i) => {
      const a = as[i];
      if (!a) loseB.push(b);
      else if (a.body !== b.body) ev.push({ kind: 'modified', key: b.key, line: b.line, header: b.header, whole: b.whole });
    });
  }
  for (const [k, as] of ga) {
    const bs = gb.get(k) ?? [];
    as.forEach((a, i) => {
      if (!bs[i]) loseA.push(a);
    });
  }
  for (const b of loseB) {
    const j = loseA.findIndex((a) => a.key === b.key);
    if (j >= 0) {
      loseA.splice(j, 1);
      ev.push({ kind: 'modified', key: b.key, line: b.line, header: b.header, whole: b.whole, renamed: true });
    } else ev.push({ kind: 'added', key: b.key, line: b.line, header: b.header, whole: b.whole, body: b.body });
  }
  for (const a of loseA) ev.push({ kind: 'removed', key: a.key, line: a.line, header: a.header, whole: a.whole, body: a.body });
  return ev;
}

const anchorDiff = { analyze, compareAnchors };
export default anchorDiff;
