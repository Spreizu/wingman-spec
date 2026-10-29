'use strict';
/**
 * placement.cjs - where `@spec <capability>/<requirement-slug>` markers sit, and a language-agnostic check of it.
 * Package-managed (overwritten by install.sh). No dependencies; also used by the VS Code extension.
 *
 * The rules (also in the schema, the commands and the implementer prompt):
 *   - A requirement implemented by a whole function / method / class: put the marker in that unit's doc comment
 *     (JSDoc, docstring, Javadoc, PHPDoc, Go doc comment), once.
 *   - A requirement implemented by part of a unit: put the marker on its own line directly above those line(s), once.
 *   - Never at the end of a code line, never at the top of a file with several functions, never detached from code.
 *   - One marker per requirement per unit; different requirements in one unit each get their own marker.
 *
 * The check is a heuristic on lines of text (no parser), so it works for any language but can misjudge unusual
 * layouts. It reports findings; the project decides how hard they bite (`anchor_placement: warn|error|off`).
 */

// Comment leaders in front of `@spec` (any comment syntax), or a bare `@spec <key>` line (docstring, Javadoc-like text).
const MARKER_LEADER = /(?:(?:\/\/+|#+|\/\*+|\*+|--+|;+|<!--|%+|\{#|"""|''')\s*@spec\b|^\s*@spec\b(?=\s+[a-z0-9][a-z0-9-]*\/[a-z0-9]))/;

const COMMENT_LINE = /^\s*(?:\/\/|#(?!\[)|\/\*|\*|--|;|<!--|%|\{#|"""|''')/;
const ANNOTATION = /^\s*(?:@[\w.]+(?:\(.*\))?\s*$|#\[.*\]\s*$|\[[A-Z]\w*.*\]\s*$)/; // @Test, @pytest.fixture, #[test], [Fact]
const CONTROL = /^\s*(?:if|else|for|foreach|while|switch|catch|try|do|return|elif|except|with|match|case|using|lock|synchronized)\b/;
const CLOSING = /^\s*(?:[}\])]+[;,]?|end|<\/\w+>)\s*$/;
const MODS = '(?:(?:export|default|public|private|protected|internal|static|final|abstract|async|override|virtual|sealed|pub|unsafe|extern|readonly|open|suspend|inline)\\s+)*';
const UNIT_KW = new RegExp(`^\\s*${MODS}(?:function\\b|def\\b|class\\b|interface\\b|struct\\b|impl\\b|trait\\b|enum\\b|func\\b|fn\\b|fun\\b|sub\\b|object\\b|module\\b|record\\b|type\\s+\\w+\\s+(?:struct|interface)\\b)`);
const UNIT_ARROW = /^\s*(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::\s*[^=]+?)?=>/;
const UNIT_TEST = /^\s*(?:it|test|describe|context|suite|specify)(?:\.\w+)*\s*\(/;
const UNIT_METHOD = /^\s*(?:(?:public|private|protected|static|final|async|override|virtual|abstract|synchronized|readonly|get|set)\s+)*(?:[\w<>[\],.?*&:]+\s+)?[A-Za-z_$][\w$]*\s*\([^;{}]*\)\s*(?::\s*[\w<>[\]|,.? ]+)?\s*(?:throws\s+[\w., ]+)?\s*\{\s*$/;
const UNIT_TAG = /^\s*<(?:script|template|style)\b/;
const isUnitStart = (l) => !CONTROL.test(l) && (UNIT_KW.test(l) || UNIT_ARROW.test(l) || UNIT_TEST.test(l) || UNIT_METHOD.test(l) || UNIT_TAG.test(l));

const KEY = /^\s*[,;]?\s*([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)/;

const FIX = {
  'trailing-marker': 'the marker is at the end of a code line: put it on its own line directly above the code it covers (or in the doc comment of the whole function)',
  'duplicate-marker': 'the same requirement is marked more than once in this function/unit: one marker per requirement per unit (doc comment for the whole unit, or one comment before the lines for a part)',
  'file-top-marker': 'the marker sits at the top of a file with several functions, so it does not say which one implements the requirement: move it into the doc comment of that function, or above the lines that implement it',
  'detached-marker': 'the marker is not directly above code (a blank line or the end of a block follows): put it on the line(s) it covers, or in the doc comment of the whole function',
};

/**
 * Placement findings of one file's text: [{ line (1-based), kind, keys, text }].
 * `isTest`: test files may carry one marker at the top for the whole file, so `file-top-marker` is not reported there.
 */
function placementFindings(text, isTest) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n'); const out = [];
  if (!/@spec\b/.test(text)) return out;
  // docstring lines (python-style triple quotes): a marker inside one is the doc comment of the unit above it
  const docLine = []; let inDoc = false;
  lines.forEach((l, i) => { const q = (l.match(/"""|'''/g) || []).length; docLine[i] = inDoc || q % 2 === 1; if (q % 2 === 1) inDoc = !inDoc; });
  const starts = []; lines.forEach((l, i) => { if (!COMMENT_LINE.test(l) && !docLine[i] && isUnitStart(l)) starts.push(i); });
  const before = (i) => starts.filter((s) => s < i).length;
  const seen = new Map();
  lines.forEach((l, i) => {
    const m = MARKER_LEADER.exec(l); if (!m) return;
    const keys = []; let rest = l.slice(m.index + m[0].length), k;
    while ((k = rest.match(KEY))) { keys.push(`${k[1]}/${k[2]}`); rest = rest.slice(k[0].length); }
    if (!keys.length) return;
    const push = (kind) => out.push({ line: i + 1, kind, keys, text: FIX[kind] });
    const lead = l.slice(0, m.index);
    if (/\S/.test(lead) && !/^\s*(?:\/\*+|\*+)?\s*$/.test(lead)) { push('trailing-marker'); }
    let seg = before(i);
    if (!docLine[i] && !/\S/.test(lead.replace(/\/\*+|\*+/g, ''))) {
      let j = i + 1; while (j < lines.length && (COMMENT_LINE.test(lines[j]) || ANNOTATION.test(lines[j]) || docLine[j])) j++;
      const target = j < lines.length ? lines[j] : '';
      const attached = j < lines.length && target.trim() !== '' && !CLOSING.test(target);
      const toUnit = attached && starts.includes(j);
      if (toUnit) seg = before(i) + 1;
      else if (!isTest && before(i) === 0 && starts.length >= 2) push('file-top-marker');
      else if (!attached) push('detached-marker');
    }
    for (const key of keys) {
      const id = `${seg}|${key}`;
      if (seen.has(id)) out.push({ line: i + 1, kind: 'duplicate-marker', keys: [key], text: FIX['duplicate-marker'] });
      else seen.set(id, i + 1);
    }
  });
  return out;
}

module.exports = { MARKER_LEADER, KEY, placementFindings, isUnitStart, COMMENT_LINE, ANNOTATION, CLOSING };
