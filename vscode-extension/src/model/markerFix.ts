/**
 * Text edits for the two quick fixes on `@spec` markers: point the marker at another requirement, and move a marker
 * that sits in the wrong place into the doc comment of the function it belongs to. Pure: edits are returned as
 * zero-based ranges, `applyEdits` applies them to a string (the editor applies the same ranges through a WorkspaceEdit).
 */
import placement from '../../../project-template/openspec/scripts/placement.cjs';
import { markersIn } from './anchors.ts';

export interface TextEdit {
  line: number;
  col: number;
  endLine: number;
  endCol: number;
  text: string;
}

const { MARKER_LEADER, COMMENT_LINE, ANNOTATION, isUnitStart } = placement;

const toLines = (text: string): string[] => text.split(/\r?\n/);

/**
 * Applies non-overlapping edits (zero-based line/col). Everything outside the edited ranges is returned byte for byte: a CRLF file stays
 * CRLF (the inserted text gets the file's line ending) and a missing final newline stays missing.
 */
export function applyEdits(text: string, edits: TextEdit[]): string {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  const crlf = text.includes('\r\n');
  const offset = (line: number, col: number): number => {
    const start = starts[Math.min(line, starts.length - 1)] ?? 0;
    const lineEnd = (starts[line + 1] ?? text.length + 1) - 1;
    const content = text[lineEnd - 1] === '\r' ? lineEnd - 1 : lineEnd; // the line without its \r\n
    return Math.min(start + col, Math.max(content, start));
  };
  let out = text;
  for (const e of [...edits].sort((a, b) => offset(b.line, b.col) - offset(a.line, a.col))) {
    const insert = crlf ? e.text.replace(/\r?\n/g, '\r\n') : e.text;
    out = out.slice(0, offset(e.line, e.col)) + insert + out.slice(offset(e.endLine, e.endCol));
  }
  return out;
}

/** The edit that replaces the key of a marker (as found by `markersIn`) with another key. */
export function replaceKeyEdit(m: { line: number; col: number; length: number }, newKey: string): TextEdit {
  return { line: m.line, col: m.col, endLine: m.line, endCol: m.col + m.length, text: newKey };
}

type Style = 'block' | 'slash' | 'hash' | 'py';

function styleOf(rel: string): Style {
  const ext = /\.([A-Za-z0-9]+)$/.exec(rel)?.[1]?.toLowerCase() ?? '';
  if (ext === 'py') return 'py';
  if (['rb', 'sh', 'bash', 'zsh', 'r', 'pl', 'ex', 'exs', 'yml', 'yaml', 'toml', 'ps1'].includes(ext)) return 'hash';
  if (['go', 'rs'].includes(ext)) return 'slash';
  return 'block';
}

const indentOf = (l: string): string => /^\s*/.exec(l)?.[0] ?? '';

export interface MovePlan {
  title: string;
  edits: TextEdit[];
}

/**
 * Plan for a misplaced marker on `markerLine` (zero-based): remove it where it is and put its keys into the doc
 * comment of the unit it belongs to (the unit the line sits in for a trailing marker, else the next unit below),
 * creating the doc comment when the unit has none. Undefined when no unit can be found.
 */
export function moveMarkerPlan(text: string, rel: string, markerLine: number): MovePlan | undefined {
  const lines = toLines(text);
  const l = lines[markerLine];
  if (l === undefined) return undefined;
  const m = MARKER_LEADER.exec(l);
  if (!m) return undefined;
  const keys = [...new Set(markersIn(l).map((k) => k.key))];
  if (!keys.length) return undefined;
  const lead = l.slice(0, m.index);
  const trailing = /\S/.test(lead) && !/^\s*(?:\/\*+|\*+)?\s*$/.test(lead);

  // docstring lines: a unit start inside a docstring is not a unit
  const docLine: boolean[] = [];
  let inDoc = false;
  lines.forEach((x, i) => {
    const q = (x.match(/"""|'''/g) ?? []).length;
    docLine[i] = inDoc || q % 2 === 1;
    if (q % 2 === 1) inDoc = !inDoc;
  });
  const starts: number[] = [];
  lines.forEach((x, i) => {
    if (!COMMENT_LINE.test(x) && !docLine[i] && isUnitStart(x)) starts.push(i);
  });
  const unit = trailing ? [...starts].reverse().find((s) => s <= markerLine) : starts.find((s) => s > markerLine);
  if (unit === undefined) return undefined;

  const edits: TextEdit[] = [];
  // 1. take the marker out of where it is
  if (trailing) {
    edits.push({ line: markerLine, col: lead.trimEnd().length, endLine: markerLine, endCol: l.length, text: '' });
  } else if (markerLine + 1 < lines.length) {
    edits.push({ line: markerLine, col: 0, endLine: markerLine + 1, endCol: 0, text: '' });
  } else {
    edits.push({ line: markerLine, col: 0, endLine: markerLine, endCol: l.length, text: '' });
  }

  // 2. put it into the unit's doc comment
  const style = styleOf(rel);
  const list = keys.join(', ');
  const unitLine = lines[unit] ?? '';
  const ind = indentOf(unitLine);
  let a = unit - 1;
  while (a >= 0 && ANNOTATION.test(lines[a] ?? '')) a--;
  const above = a >= 0 ? (lines[a] ?? '') : '';
  const alreadyThere = (from: number, to: number): boolean => lines.slice(from, to + 1).some((x) => keys.every((k) => x.includes(k)));
  const aboveEnd = a;
  const insertAt = (line: number, body: string): void => void edits.push({ line, col: 0, endLine: line, endCol: 0, text: `${body}\n` });

  if (style === 'py') {
    let sigEnd = unit;
    while (sigEnd < lines.length - 1 && !/:\s*(?:#.*)?$/.test(lines[sigEnd] ?? '')) sigEnd++;
    const bodyLine = sigEnd + 1;
    const first = (lines[bodyLine] ?? '').trim();
    const bodyInd = /\S/.test(lines[bodyLine] ?? '') ? indentOf(lines[bodyLine] ?? '') : `${ind}    `;
    const q = /^("""|''')/.exec(first)?.[1];
    if (q && bodyLine !== markerLine && !(trailing && bodyLine === markerLine)) {
      const oneLine = first.indexOf(q, 3) > 0;
      if (oneLine) {
        const open = (lines[bodyLine] ?? '').indexOf(q);
        const close = (lines[bodyLine] ?? '').lastIndexOf(q);
        edits.push({ line: bodyLine, col: close, endLine: bodyLine, endCol: close, text: `\n${bodyInd}@spec ${list}\n${bodyInd}` });
        void open;
      } else {
        let end = bodyLine + 1;
        while (end < lines.length && !(lines[end] ?? '').includes(q)) end++;
        if (!alreadyThere(bodyLine, end)) {
          if ((lines[end] ?? '').trim() === q) insertAt(end, `${bodyInd}@spec ${list}`);
          else edits.push({ line: end, col: (lines[end] ?? '').indexOf(q), endLine: end, endCol: (lines[end] ?? '').indexOf(q), text: `\n${bodyInd}@spec ${list}\n${bodyInd}` });
        }
      }
    } else {
      insertAt(bodyLine, `${bodyInd}"""\n${bodyInd}@spec ${list}\n${bodyInd}"""`);
    }
    return { title: `Move @spec ${list} into the docstring of ${unitLine.trim().slice(0, 50)}`, edits };
  }

  const title = `Move @spec ${list} into the doc comment of ${unitLine.trim().slice(0, 50)}`;
  if (/\*\/\s*$/.test(above)) {
    let s = a;
    while (s > 0 && !(lines[s] ?? '').includes('/*')) s--;
    const startLine = lines[s] ?? '';
    if (/^\s*\/\*\*/.test(startLine)) {
      if (alreadyThere(s, aboveEnd)) return { title, edits };
      if (s === a) {
        const body = startLine.replace(/^\s*\/\*\*\s?/, '').replace(/\s*\*\/\s*$/, '').trim();
        const i2 = indentOf(startLine);
        edits.push({ line: a, col: 0, endLine: a, endCol: startLine.length, text: [`${i2}/**`, ...(body ? [`${i2} * ${body}`] : []), `${i2} * @spec ${list}`, `${i2} */`].join('\n') });
      } else if (above.trim() === '*/') {
        insertAt(a, `${indentOf(startLine)} * @spec ${list}`);
      } else {
        const close = above.lastIndexOf('*/');
        edits.push({ line: a, col: close, endLine: a, endCol: close, text: `\n${indentOf(startLine)} * @spec ${list}\n${indentOf(startLine)} ` });
      }
      return { title, edits };
    }
  }
  const run = /^\s*(\/\/\/?|#)(?!\[)/.exec(above)?.[1];
  if (run && style !== 'block') {
    let s = a;
    while (s > 0 && new RegExp(`^\\s*${run.replace(/\//g, '\\/')}`).test(lines[s - 1] ?? '')) s--;
    if (!alreadyThere(s, aboveEnd)) insertAt(a + 1, `${indentOf(above)}${run} @spec ${list}`);
    return { title, edits };
  }
  // no doc comment: create one above the unit (and its annotations)
  const at = a + 1;
  const body = style === 'hash' ? `${ind}# @spec ${list}` : style === 'slash' ? `${ind}// @spec ${list}` : `${ind}/** @spec ${list} */`;
  insertAt(at, body);
  return { title, edits };
}

/** The edit that takes the marker comment on `markerLine` (zero-based) out: the whole line when it is only a marker comment, else the trailing comment. */
export function removeMarkerEdit(text: string, markerLine: number): TextEdit | undefined {
  const lines = toLines(text);
  const l = lines[markerLine];
  if (l === undefined) return undefined;
  const m = MARKER_LEADER.exec(l);
  if (!m) return undefined;
  const lead = l.slice(0, m.index);
  const trailing = /\S/.test(lead) && !/^\s*(?:\/\*+|\*+)?\s*$/.test(lead);
  if (trailing) return { line: markerLine, col: lead.trimEnd().length, endLine: markerLine, endCol: l.length, text: '' };
  if (markerLine + 1 < lines.length) return { line: markerLine, col: 0, endLine: markerLine + 1, endCol: 0, text: '' };
  return { line: markerLine, col: 0, endLine: markerLine, endCol: l.length, text: '' };
}
