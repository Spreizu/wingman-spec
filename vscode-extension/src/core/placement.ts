/**
 * Where `@spec <capability>/<requirement-slug>` markers sit: a language-agnostic line heuristic (no parser). A TS port of the
 * CLI's internal/anchors/placement.go; test/golden/placement.json (written by the Go suite) keeps the two in step.
 */

/** Comment leaders in front of `@spec` (any comment syntax), or a bare `@spec <key>` line (docstring, Javadoc-like text). */
export const MARKER_LEADER = /(?:(?:\/\/+|#+|\/\*+|\*+|--+|;+|<!--|%+|\{#|"""|''')\s*@spec\b|^\s*@spec\b(?=\s+[a-z0-9][a-z0-9-]*\/[a-z0-9]))/;
export const COMMENT_LINE = /^\s*(?:\/\/|#(?!\[)|\/\*|\*|--|;|<!--|%|\{#|"""|''')/;
/** `@Test`, `@pytest.fixture`, `#[test]`, `[Fact]`. */
export const ANNOTATION = /^\s*(?:@[\w.]+(?:\(.*\))?\s*$|#\[.*\]\s*$|\[[A-Z]\w*.*\]\s*$)/;
export const CLOSING = /^\s*(?:[}\])]+[;,]?|end|<\/\w+>)\s*$/;
export const KEY = /^\s*[,;]?\s*([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)/;

const CONTROL = /^\s*(?:if|else|for|foreach|while|switch|catch|try|do|return|elif|except|with|match|case|using|lock|synchronized)\b/;
const MODS = '(?:(?:export|default|public|private|protected|internal|static|final|abstract|async|override|virtual|sealed|pub|unsafe|extern|readonly|open|suspend|inline)\\s+)*';
const UNIT_KW = new RegExp(`^\\s*${MODS}(?:function\\b|def\\b|class\\b|interface\\b|struct\\b|impl\\b|trait\\b|enum\\b|func\\b|fn\\b|fun\\b|sub\\b|object\\b|module\\b|record\\b|type\\s+\\w+\\s+(?:struct|interface)\\b)`);
const UNIT_ARROW = /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::\s*[^=]+?)?=>/;
const UNIT_TEST = /^\s*(?:it|test|describe|context|suite|specify)(?:\.\w+)*\s*\(/;
const UNIT_METHOD = /^\s*(?:(?:public|private|protected|static|final|async|override|virtual|abstract|synchronized|readonly|get|set)\s+)*(?:[\w<>[\],.?*&:]+\s+)?[A-Za-z_$][\w$]*\s*\([^;{}]*\)\s*(?::\s*[\w<>[\]|,.? ]+)?\s*(?:throws\s+[\w., ]+)?\s*\{\s*$/;
const UNIT_TAG = /^\s*<(?:script|template|style)\b/;

/** The first line of a function, method, class, test or component block. */
export const isUnitStart = (l: string): boolean =>
  !CONTROL.test(l) && (UNIT_KW.test(l) || UNIT_ARROW.test(l) || UNIT_TEST.test(l) || UNIT_METHOD.test(l) || UNIT_TAG.test(l));

/** Keys of the markers on one line (a comment may list several: `@spec a/b, c/d`). */
export function keysOf(l: string): string[] {
  const m = MARKER_LEADER.exec(l);
  if (!m) return [];
  const keys: string[] = [];
  let rest = l.slice(m.index + m[0].length);
  for (let k = KEY.exec(rest); k; k = KEY.exec(rest)) {
    keys.push(`${k[1]}/${k[2]}`);
    rest = rest.slice(k[0].length);
  }
  return keys;
}

/** Docstring lines (python-style triple quotes): a marker inside one is the doc comment of the unit above it. */
export function docLines(lines: string[]): boolean[] {
  const out: boolean[] = [];
  let inDoc = false;
  for (const l of lines) {
    const odd = (l.match(/"""|'''/g) ?? []).length % 2 === 1;
    out.push(inDoc || odd);
    if (odd) inDoc = !inDoc;
  }
  return out;
}

export type PlacementKind = 'trailing-marker' | 'duplicate-marker' | 'file-top-marker' | 'detached-marker';

export const PLACEMENT_FIX: Record<PlacementKind, string> = {
  'trailing-marker': 'the marker is at the end of a code line: put it on its own line directly above the code it covers (or in the doc comment of the whole function)',
  'duplicate-marker': 'the same requirement is marked more than once in this function/unit: one marker per requirement per unit (doc comment for the whole unit, or one comment before the lines for a part)',
  'file-top-marker': 'the marker sits at the top of a file with several functions, so it does not say which one implements the requirement: move it into the doc comment of that function, or above the lines that implement it',
  'detached-marker': 'the marker is not directly above code (a blank line or the end of a block follows): put it on the line(s) it covers, or in the doc comment of the whole function',
};

export interface PlacementFinding {
  /** 1-based. */
  line: number;
  kind: PlacementKind;
  keys: string[];
  text: string;
}

/** Placement findings of one file's text. Test files may carry one marker at the top for the whole file (no `file-top-marker`). */
export function placementFindings(text: string, isTest: boolean): PlacementFinding[] {
  const out: PlacementFinding[] = [];
  if (!/@spec\b/.test(text)) return out;
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const doc = docLines(lines);
  const starts: number[] = [];
  lines.forEach((l, i) => {
    if (!COMMENT_LINE.test(l) && !doc[i] && isUnitStart(l)) starts.push(i);
  });
  const before = (i: number): number => starts.filter((s) => s < i).length;
  const seen = new Map<string, number>();
  lines.forEach((l, i) => {
    const m = MARKER_LEADER.exec(l);
    if (!m) return;
    const keys = keysOf(l);
    if (!keys.length) return;
    const push = (kind: PlacementKind): void => {
      out.push({ line: i + 1, kind, keys, text: PLACEMENT_FIX[kind] });
    };
    const lead = l.slice(0, m.index);
    if (/\S/.test(lead) && !/^\s*(?:\/\*+|\*+)?\s*$/.test(lead)) push('trailing-marker');
    let seg = before(i);
    if (!doc[i] && !/\S/.test(lead.replace(/\/\*+|\*+/g, ''))) {
      let j = i + 1;
      while (j < lines.length && (COMMENT_LINE.test(lines[j] ?? '') || ANNOTATION.test(lines[j] ?? '') || doc[j])) j++;
      const target = lines[j] ?? '';
      const attached = j < lines.length && target.trim() !== '' && !CLOSING.test(target);
      if (attached && starts.includes(j)) seg = before(i) + 1;
      else if (!isTest && before(i) === 0 && starts.length >= 2) push('file-top-marker');
      else if (!attached) push('detached-marker');
    }
    for (const key of keys) {
      const id = `${seg}|${key}`;
      if (seen.has(id)) out.push({ line: i + 1, kind: 'duplicate-marker', keys: [key], text: PLACEMENT_FIX['duplicate-marker'] });
      else seen.set(id, i + 1);
    }
  });
  return out;
}

const placement = { MARKER_LEADER, COMMENT_LINE, ANNOTATION, CLOSING, KEY, isUnitStart, keysOf, placementFindings, PLACEMENT_FIX };
export default placement;
