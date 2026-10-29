'use strict';
/**
 * anchorfit.cjs - does an `@spec` anchor belong where it sits, and are there too many? Package-managed (overwritten by install.sh).
 * Plain Node >= 18, no dependencies, language-agnostic line heuristics (the anchored unit comes from anchorguard.analyze).
 * Advisory: every finding is a warning unless `anchor_fit: error` (`off` silences it). It cannot read meaning, so each rule is
 * a rough signal with its own fix text; the reviewer and the tests stay the judge.
 *
 *   over-anchored      more than `anchor_max` (default 6) code anchors for one requirement AND some of them are weak (another finding below, or two
 *                      markers of the requirement in one unit: a function carries a requirement once): reported once, naming the weak anchors.
 *                      Anchors that each pass the fit are never counted against the requirement; above a high ceiling (12) one info line
 *                      (`many-anchors`) asks whether the requirement should be split. `Anchors: many` in the requirement or `anchor_many:` in the
 *                      config silences the count for a requirement that is genuinely spread over many files
 *   boilerplate-anchor the anchored unit is an import, a constant, a type declaration, a getter/setter, a log call, a
 *                      string-table entry (i18n/locale files), or configuration: none of these implements behaviour
 *   crowded-unit       more than 3 different requirements anchored in one small unit
 *   foreign-anchor     the file belongs to another capability (a path segment or a task `Files:` line says so)
 *   unrelated-anchor   no word of the requirement (name, text, scenarios, capability) appears in the unit, its header or its path
 *
 * `fitFindings` is pure: texts in, findings out. `removable` findings carry `remove: true`: deleting that marker line keeps the
 * requirement anchored by its remaining markers (the last marker of a requirement is never removable).
 */
const { analyze } = require('./anchorguard.cjs');

const DEFAULT_MAX = 6;
const CEILING = 12;
const CROWD = 3;

const STOP = new Set(('the a an and or of to in on at by for with from is are be been being as it its this that these those shall must should may can will would when then given but not no any all each every if else than into onto over under after before while who whom what which where how why '
  + 'user users system page view show shows shown display displays displayed see sees visible value values item items one two new existing current')
  .split(/\s+/));
const stem = (w) => w.replace(/(?:ing|ed|es|s)$/, '');
function words(text) {
  const out = new Set();
  const spaced = String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  for (const w of spaced.split(/[^a-z0-9]+/)) { if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue; out.add(stem(w)); }
  return out;
}
/** Two stems match when equal, or one starts with the other (4+ letters), or they share their first 5 letters. */
const same = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a))) || (a.length >= 5 && b.length >= 5 && a.slice(0, 5) === b.slice(0, 5));
const overlapOf = (reqWords, unitWords) => { let n = 0; for (const r of reqWords) for (const u of unitWords) if (same(r, u)) { n++; break; } return n; };

// Where a translation lives. `strong`: the path alone says the file is a string table (a data file in a locale directory, or a file
// type that only holds translations); `weak`: the directory is called like one but the file is code (languages/index.ts), so only
// the content decides (the ENTRY rule below). Whole path segments only: `languages.ts` is not a locale directory.
const TR_DIR = '(?:lang|langs|language|languages|locale|locales|l10n|i18n|translations?)';
const TR_DATA = '(?:json|ya?ml|php|xml|po|pot|xlf|xliff|arb|strings|stringsdict|properties|resx|ini|toml|csv|txt|mo|ts|js)';
const TR_CODE = /\.(?:tsx?|jsx?|mjs|cjs|vue|py|rb|go|java|kt|kts|cs|swift|rs|dart|scala|c|cc|cpp|h|m)$/i;
const TR_STRONG = [
  /\.(?:po|pot|xlf|xliff|arb|strings|stringsdict|xcstrings|resx)$/i, // gettext, XLIFF, Flutter ARB, Apple strings, .NET resources
  /(?:^|\/)[^/]+\.lproj\//i, // Apple localization bundles
  /(?:^|\/)values(?:-[\w+]+)*\/(?:strings|plurals|arrays)\.xml$/i, // Android res/values*/strings.xml
  /(?:^|\/)locale\/[^/]+\/lc_messages\//i, // gettext catalogs (locale/<lang>/LC_MESSAGES)
  /(?:^|\/)(?:messages|validators|security|translations?|strings|labels?|bundle|text)(?:[._-][a-z]{2,3}(?:[_-][a-z]{2,4})?)?\.properties$/i, // Java ResourceBundle (not application.properties)
  /(?:^|\/)(?:messages|validators|security|translations?|strings|labels?)[._-][a-z]{2,3}(?:[_-][a-z]{2,4})?\.(?:php|json|ya?ml|xml|ini)$/i, // messages.fr.yml, messages_fr_FR.json
  new RegExp(`(?:^|/)${TR_DIR}/(?:.+/)?[^/]+\\.(?:json|ya?ml|php|xml|ini|toml|csv|txt|mo)$`, 'i'), // language/en/site.php, lang/en/auth.php, config/locales/en.yml, locales/*.json
  /(?:^|\/)(?:messages|strings|translations?)\.(?:php|js|ts|json|ya?ml)$/i,
];
const TR_WEAK = [new RegExp(`(?:^|/)${TR_DIR}/.+\\.${TR_DATA}$`, 'i'), /(?:^|\/)(?:messages?|strings|intl)\//i];
/** 'strong' | 'weak' | null: see above. */
function i18nPath(file) {
  const f = String(file).replace(/\\/g, '/');
  if (TR_STRONG.some((re) => re.test(f))) return 'strong';
  return TR_WEAK.some((re) => re.test(f)) || (TR_CODE.test(f) && new RegExp(`(?:^|/)${TR_DIR}/`, 'i').test(f)) ? 'weak' : null;
}
const CONFIG_PATH = /(^|\/)(config|settings|configs?)(\/|\.[a-z]+$)|(^|\/)\.env|\.(json|ya?ml|toml|ini|env|cfg|conf)$|(^|\/)(package|tsconfig|webpack\.config|vite\.config|composer|pom|build)\.[a-z]+$/i;
const ENTRY = /^\s*['"]?[\w.\-:/ ]+['"]?\s*(?:=>|:|=)\s*(?:['"`].*['"`]|\[.*\]|\{.*\}|\d+|true|false|null)\s*,?\s*$/;
const IMPORT = /^\s*(?:import\b|from\s+\S+\s+import\b|use\s+[\w\\]+|using\s+[\w.]+;|require(?:_once)?\b|#include\b|package\s+[\w.]+;?\s*$|(?:const|let|var)\s+(?:\{[^}]*\}|\w+)\s*=\s*require\()/;
const SQL_TEXT = /['"`]\s*(?:SELECT\s|INSERT\s+INTO\b|UPDATE\s+\S+\s+SET\b|DELETE\s+FROM\b)/;
const CONSTANT = /^\s*(?:(?:export|public|private|protected|static|final|readonly|pub)\s+)*(?:const|val|let|var|define)\s*\(?\s*['"]?[A-Z][A-Z0-9_]{2,}['"]?\s*[:=,)]|^\s*(?:(?:public|private|protected|static|final|readonly)\s+)+(?:const\s+)?[\w<>\[\]]*\s*[A-Z][A-Z0-9_]{2,}\s*=|^[A-Z][A-Z0-9_]{2,}\s*=/;
const TYPE_DECL = /^\s*(?:export\s+)?(?:declare\s+)?(?:type\s+\w+(?:<[^>]*>)?\s*=|interface\s+\w+|enum\s+\w+|struct\s+\w+|typedef\b)/;
const ACCESSOR_HEAD = /^\s*(?:(?:public|private|protected|static|final|override|async)\s+)*(?:(?:get|set)\s+\w+\s*\(|(?:function\s+)?(?:[\w<>\[\],.?]+\s+)?(?:get|set|is|has)[A-Z]\w*\s*\(|def\s+(?:get|set|is|has)_\w+\s*\()/;
const ACCESSOR_BODY = /^\s*(?:return\s+)?(?:\$?this->|this\.|self\.|@)?\$?\w+(?:\s*=\s*\$?\w+)?\s*;?\s*$|return\s+(?:\$?this->|this\.|self\.)\$?\w+\s*;?/;
const LOGGING = /^\s*(?:console\.(?:log|warn|error|info|debug)|(?:this\.|self\.)?(?:logger|log)\.(?:info|debug|warn|warning|error|trace)|logging\.\w+|log\.(?:Print|Fatal|Panic)\w*\s*\(|print(?:ln|f)?\s*\(|System\.out\.print|fmt\.Print|Log::\w+|error_log\s*\(|Rails\.logger|puts\s)/;

/** The kind of non-behaviour a unit is, or null. `code`: its non-blank, non-comment lines. A strong translation path wins even when the unit has no code of its own. */
function boilerplateKind(file, code, test) {
  if (test) return null;
  let tr = i18nPath(file);
  // a PHP class or function in a language directory is code, not a translation array: the content decides
  if (tr === 'strong' && /\.php$/i.test(file) && code.some((l) => /^\s*(?:(?:abstract|final)\s+)?(?:class|interface|trait)\b|^\s*(?:(?:public|private|protected|static)\s+)*function\b/.test(l))) tr = 'weak';
  if (tr === 'strong') return 'i18n';
  if (!code.length) return null;
  const head = code[0];
  if (IMPORT.test(head) && code.every((l) => IMPORT.test(l) || /^\s*[}\])]/.test(l) || /^\s*\w+,?\s*$/.test(l) || /from\s+['"]/.test(l))) return 'import';
  if (TYPE_DECL.test(head)) return 'type';
  // a constant that holds a query decides which rows are read or changed: that is behaviour
  if (CONSTANT.test(head) && code.length <= 6 && !SQL_TEXT.test(code.join(' '))) return 'constant';
  if (ACCESSOR_HEAD.test(head) && code.length <= 5 && code.slice(1).every((l) => ACCESSOR_BODY.test(l) || /^\s*[{}]\s*$/.test(l))) return 'accessor';
  if (LOGGING.test(head) && code.length <= 3) return 'logging';
  const entries = code.filter((l) => ENTRY.test(l)).length;
  if (code.length >= 1 && entries / code.length >= 0.6 && entries >= 1 && !/\b(?:function|def|=>|if|for|while|return)\b/.test(code.join(' '))) return tr === 'weak' || !CONFIG_PATH.test(file) ? 'i18n' : 'config';
  if (CONFIG_PATH.test(file)) return 'config';
  return null;
}

const REASON = {
  i18n: 'a string-table entry (translations, locale or message files)',
  import: 'an import',
  type: 'a type declaration',
  constant: 'a constant',
  accessor: 'a getter or setter',
  logging: 'a log call',
  config: 'configuration',
};

const slugSeg = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/\.[a-z0-9]+$/i, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase().replace(/^-|-$/g, '');
/** Capabilities a file belongs to by its path: a whole path segment (or the file stem) equal to a capability name. */
function capsOfPath(file, capNames) {
  const out = new Set();
  const segs = file.split('/').map(slugSeg);
  for (const c of capNames) if (segs.includes(c)) out.add(c);
  return out;
}

const FIX = {
  'over-anchored': (n, max, weak) => `${n} code anchors for one requirement (more than ${max}); weak: ${weak.join(', ')} (a second marker in one unit, or a finding of its own). Remove or move those; the anchors that pass the fit stay (or mark a requirement that is truly spread over many files with \`Anchors: many\`)`,
  'many-anchors': (n) => `${n} code anchors, each of them fits: no change needed. Is this one requirement, or several that should be split? (\`Anchors: many\` in the requirement, or anchor_many in the config, silences this line)`,
  'over-anchored-again': () => 'a second marker of the requirement in a unit that already carries it (a function carries a requirement once): remove it',
  'boilerplate-anchor': (why) => `the marker sits on ${why}, which decides no behaviour: remove it; a requirement is anchored where its behaviour is decided, not on imports, types, constants, string tables, getters or logging`,
  'crowded-unit': (n) => `${n} different requirements are anchored in this one unit: anchor each where its own behaviour is decided, and remove the markers that only describe code the unit happens to contain`,
  'foreign-anchor': (cap, file) => `the file belongs to \`${cap}\`, another capability: a requirement is not anchored on code of a different feature because it is related or visible afterwards. Remove the marker, or move it to the code that decides this requirement (${file})`,
  'unrelated-anchor': () => 'no word of the requirement (name, text, scenarios) appears in this unit, its header or its file name: remove the marker, or move it to the code that implements the requirement',
};

/**
 * Findings over a code base.
 *   files    [{ file, text, test }]            all files that carry markers (test files are read but never judged)
 *   reqs     Map key -> { name, block, cap }   known requirements (living + the change's deltas); unknown keys are skipped
 *   capNames Set of capability names           for foreign-anchor
 *   taskCaps Map file -> Set(cap) | null       optional: files named in task `Files:` lines of tasks that cite one capability
 *   max      anchors per requirement above which weak ones are named (default 6)
 *   many     Set of requirement keys whose count is never reported (config `anchor_many`; `Anchors: many` in the requirement does the same)
 * Returns [{ file, line, key, kind, text, remove }] (line is the marker line, 1-based; `remove` = deleting this marker is the suggested fix).
 */
function fitFindings(o) {
  const max = o.max || DEFAULT_MAX; const many = o.many || new Set(); const reqs = o.reqs || new Map(); const capNames = o.capNames || new Set();
  const anchors = [];
  for (const f of o.files || []) {
    if (f.test || !/@spec\b/.test(f.text)) continue;
    const lines = f.text.replace(/\r\n/g, '\n').split('\n');
    const isCommentLine = (l) => /^\s*(?:\/\/|#(?!\[)|\/\*|\*|--|;|<!--|%|"""|''')/.test(l);
    const units = analyze(f.text);
    const here = [];
    for (const u of units) {
      const code = []; for (let j = u.start; j <= Math.min(u.end, u.start + 80) && j < lines.length; j++) if (/\S/.test(lines[j]) && !isCommentLine(lines[j])) code.push(lines[j]);
      here.push({ ...u, file: f.file, code, unitLines: u.end - u.start + 1 });
    }
    // stacked `@spec` lines: analyze ends a unit at the next marker, so a marker with no code of its own shares the code, header and
    // size of the next marker's unit when they are within 3 lines (three stacked markers all share the unit below them)
    for (let i = 0; i < here.length; i++) {
      if (here[i].code.length) continue;
      for (let k = i + 1; k < here.length; k++) {
        if (here[k].line - here[k - 1].line > 3) break;
        if (!here[k].code.length) continue;
        here[i].code = here[k].code;
        if (!here[i].header) here[i].header = here[k].header;
        here[i].unitLines = Math.max(here[i].unitLines, here[k].unitLines);
        break;
      }
    }
    for (const a of here) { a.kind = boilerplateKind(a.file, a.code, false); a.words = words(`${a.header} ${a.code.join(' ')} ${a.file}`); anchors.push(a); }
  }
  const out = []; const flagged = new Set(); const id = (a) => `${a.file}:${a.line}:${a.key}`;
  const add = (a, kind, text) => { if (flagged.has(`${id(a)}:${kind}`)) return; flagged.add(`${id(a)}:${kind}`); out.push({ file: a.file, line: a.line, key: a.key, kind, text: `${a.file}:${a.line}: \`${a.key}\`: ${text}`, remove: true }); };
  const byKey = new Map(); for (const a of anchors) { if (!reqs.has(a.key)) continue; if (!byKey.has(a.key)) byKey.set(a.key, []); byKey.get(a.key).push(a); }
  const bad = new Set();
  for (const [key, list] of byKey) {
    const r = reqs.get(key); const rw = words(`${r.name} ${r.block || ''} ${r.cap || key.split('/')[0]}`);
    for (const a of list) {
      a.overlap = overlapOf(rw, a.words);
      if (a.kind) { add(a, 'boilerplate-anchor', FIX['boilerplate-anchor'](REASON[a.kind])); bad.add(id(a)); continue; }
      const own = capsOfPath(a.file, capNames); const task = o.taskCaps && o.taskCaps.get(a.file); const cap = key.split('/')[0];
      const owners = new Set([...own, ...(task || [])]);
      if (owners.size && !owners.has(cap)) { add(a, 'foreign-anchor', FIX['foreign-anchor']([...owners][0], a.file)); bad.add(id(a)); continue; }
      if (rw.size >= 3 && a.overlap === 0) { add(a, 'unrelated-anchor', FIX['unrelated-anchor']()); bad.add(id(a)); }
    }
    // too many: a count alone is no finding. It counts only when some anchors are weak (a finding above, or a second marker in one unit);
    // the weak ones are named once, the ones that pass the fit are never touched. A very high count of good anchors gets one info line.
    const skip = many.has(key) || /^\s*Anchors:\s*many\b/mi.test(r.block || '');
    let weakFound = false;
    if (!skip && list.length > max) {
      const unit = new Set(); const dup = [];
      for (const a of list) { const u = `${a.file}|${a.header || `${a.start}-${a.end}`}`; if (unit.has(u)) dup.push(a); else unit.add(u); }
      const weak = list.filter((a) => bad.has(id(a)) || dup.includes(a));
      weakFound = weak.length > 0;
      // the weak ones that already carry their own finding (boilerplate, foreign, unrelated) are not repeated; the second markers of a
      // unit get the count finding, the first of them names every weak anchor
      dup.filter((a) => !bad.has(id(a))).forEach((a, i) => add(a, 'over-anchored', i === 0
        ? FIX['over-anchored'](list.length, max, weak.map((w) => `${w.file}:${w.line}`))
        : FIX['over-anchored-again']()));
    }
    if (!skip && list.length > CEILING && !weakFound) {
      const first = list[0];
      out.push({ file: first.file, line: first.line, key, kind: 'many-anchors', info: true, text: `${first.file}:${first.line}: \`${key}\`: ${FIX['many-anchors'](list.length)}`, remove: false });
    }
  }
  // crowded: many requirements on one small unit
  const perUnit = new Map();
  for (const a of anchors) { if (!reqs.has(a.key)) continue; const k = `${a.file}|${a.start}|${a.end}`; if (!perUnit.has(k)) perUnit.set(k, []); perUnit.get(k).push(a); }
  for (const list of perUnit.values()) {
    const keys = [...new Set(list.map((a) => a.key))];
    if (keys.length <= CROWD || list[0].unitLines > 60) continue;
    const ranked = [...list].sort((x, y) => y.overlap - x.overlap || x.line - y.line);
    const keep = new Set(ranked.slice(0, CROWD).map((a) => a.key));
    for (const a of list) if (!keep.has(a.key) && !bad.has(id(a))) add(a, 'crowded-unit', FIX['crowded-unit'](keys.length));
  }
  // the last marker of a requirement is never removable
  const total = new Map(); for (const [k, l] of byKey) total.set(k, l.length);
  const removing = new Map();
  for (const x of out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    if (!x.remove) continue;
    const n = removing.get(x.key) || 0;
    if (n + 1 >= (total.get(x.key) || 0)) { x.remove = false; x.text += '. It is the last anchor of the requirement: move it instead of removing it'; } else removing.set(x.key, n + 1);
  }
  return out;
}

/** `anchor_fit: warn|error|off` (default warn) `anchor_max: <n>` and `anchor_many: [cap/slug, ...]` from the first config file that sets them; env SPEC_ANCHOR_FIT beats the file. */
function fitConfig(configFiles, read) {
  const env = String(process.env.SPEC_ANCHOR_FIT || '').toLowerCase();
  let level = /^(warn|error|off)$/.test(env) ? env : null; let max = DEFAULT_MAX; const many = new Set();
  for (const f of configFiles) {
    const t = read(f); if (!t) continue;
    if (!level) { const m = t.match(/^anchor_fit:\s*['"]?(warn|error|off)\b/mi); if (m) level = m[1].toLowerCase(); }
    const am = t.match(/^anchor_many:\s*\[([^\]]*)\]/m); if (am) for (const k of am[1].split(',')) { const s = k.trim().replace(/^['"]|['"]$/g, ''); if (s) many.add(s); }
    const n = t.match(/^anchor_max:\s*(\d+)\b/m); if (n && max === DEFAULT_MAX) max = Math.max(1, Number(n[1]));
  }
  return { level: level || 'warn', max, many };
}

/**
 * Delete the given marker lines (`[{ file, line, key }]`, 1-based) from the texts of `files` ({ file -> text }); returns { file -> new text }.
 * Only the marker is removed: a comment line that holds nothing but this marker goes away whole, a marker among other keys loses just its
 * key, a marker in a comment with other words loses just `@spec key`. Code lines are never touched.
 */
function removeMarkers(texts, picks) {
  const out = {};
  const LEAD = /^\s*(?:\/\/+!?|#+|\/\*+!?|\*+|--+|;+|<!--|%+|\{#|"""|\'\'\')?\s*/;
  const TAIL = /\s*(?:\*+\/|-->|#\}|"""|\'\'\')?\s*$/;
  for (const [file, text] of Object.entries(texts)) {
    const mine = picks.filter((p) => p.file === file); if (!mine.length) continue;
    const eol = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/); const drop = new Set();
    for (const p of mine) {
      const l = lines[p.line - 1]; if (l === undefined) continue;
      const esc = p.key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const at = l.indexOf('@spec'); if (at < 0 || !new RegExp(`(?<![\\w/-])${esc}(?![\\w/-])`).test(l.slice(at))) continue;
      let head = l.slice(0, at); let rest = l.slice(at);
      rest = rest.replace(new RegExp(`(\\s*,\\s*)?(?<![\\w/-])${esc}(?![\\w/-])(\\s*,\\s*(?=[\\w-]+/))?`), (m0, lead, trail) => (lead && trail ? ', ' : ''));
      if (!/^@spec\s*[,;]?\s*(?:[\w-]+\/[\w-]+)/.test(rest)) rest = rest.replace(/^@spec\s*[,;:]?\s*(?:(?:[\u2013\u2014:]|-(?![->]))\s*)?/, ''); // no key left: the whole marker goes
      const left = head + rest.replace(/^@spec\s+,\s*/, '@spec ');
      const bare = left.replace(LEAD, '').replace(TAIL, '');
      if (!/\S/.test(bare)) { drop.add(p.line - 1); continue; }
      lines[p.line - 1] = /\S/.test(head.replace(LEAD, '')) ? left.replace(/\s*(?:\/\/+|#+|--+|;+|%+)\s*$/, '').replace(/\s+$/, '') : left.replace(/\s+$/, '');
    }
    out[file] = lines.filter((_, i) => !drop.has(i)).join(eol);
  }
  return out;
}

module.exports = { fitFindings, fitConfig, removeMarkers };
