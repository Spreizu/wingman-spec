#!/usr/bin/env node
// prose-lint.cjs - warn-only checks on the prose we ship (schema instructions, templates, commands, the AGENTS block,
// the config template, our own skills, docs, README). Rules: skills/spec-writing/SKILL.md.
// Usage: node scripts/prose-lint.cjs [--metrics] [--json] [--strict] [file...]
//   default    print one warning per sentence that breaks a limit, then a summary; exit 0
//   --metrics  print sentence counts per area (sentences, mean words, 30+ and 45+ words, vague words, 2+ parentheses)
//   --strict   exit 1 when a sentence has more than 60 words
// Skips code fences, table rows, YAML keys and the vendored skills (skills/VENDORED.md).
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '..');
const LIMIT = { warn: 30, long: 45, hard: 60, parenWords: 12 };
const VAGUE = { appropriate: 'name the value', appropriately: 'name the value', relevant: 'name which one', properly: 'say what correct means',
  gracefully: 'name the result', 'as needed': 'say when', 'if necessary': 'say when', etc: 'list them or say "for example"',
  various: 'name them', several: 'give the number', meaningful: 'say what it shows',
  really: 'delete it', simply: 'delete it', just: 'delete it', 'in order to': '"to"', utilize: '"use"', leverage: '"use"',
  'it should be noted': 'delete it', 'where relevant': 'say where', 'as expected': 'give the value' };
const VAGUE_RE = new RegExp('\\b(' + Object.keys(VAGUE).map((k) => k.replace(/ /g, '\\s+')).join('|') + ')\\b', 'gi');

function areaOf(f) {
  if (f.includes('schemas/') && f.endsWith('schema.yaml')) return 'schema';
  if (f.includes('/templates/')) return 'templates';
  if (f.includes('harness/')) return 'commands';
  if (/config\.yaml\.tmpl$|AGENTS\.block\.md$/.test(f)) return 'config + agents';
  if (f.startsWith('skills/')) return 'skills';
  return 'docs + README';
}
function defaultFiles() {
  const out = [], walk = (d, re) => { for (const e of fs.readdirSync(path.join(ROOT, d), { withFileTypes: true })) {
    const p = path.posix.join(d, e.name); if (e.isDirectory()) walk(p, re); else if (re.test(e.name)) out.push(p); } };
  out.push('internal/artifacts/artifacts.yaml'); walk('internal/artifacts/templates', /\.md$/); walk('harness', /\.md$/);
  out.push('internal/scaffold/wingman-spec.yaml.tmpl', 'README.md');
  for (const f of fs.readdirSync(path.join(ROOT, 'docs'))) if (f.endsWith('.md')) out.push('docs/' + f);
  const vendored = fs.readFileSync(path.join(ROOT, 'skills/VENDORED.md'), 'utf8');
  for (const s of fs.readdirSync(path.join(ROOT, 'skills'), { withFileTypes: true }))
    if (s.isDirectory() && !vendored.includes('`' + s.name + '`') && fs.existsSync(path.join(ROOT, 'skills', s.name, 'SKILL.md'))) out.push(`skills/${s.name}/SKILL.md`);
  return out;
}
// Text units (paragraphs and list items) with their first line number; code fences, tables and YAML keys removed.
function units(text, yaml) {
  const out = []; let cur = null, fence = false, front = false;
  const flush = () => { if (cur && cur.t.trim()) out.push(cur); cur = null; };
  text.split('\n').forEach((raw, i) => {
    let l = raw;
    if (!yaml && l === '---' && (i === 0 || front)) { front = i === 0; return; } // front matter: only its description is prose
    if (front) { const d = /^description:\s*["']?(.*?)["']?\s*$/.exec(l); if (d) out.push({ line: i + 1, t: d[1] }); return; }
    if (/^\s*(```|~~~)/.test(l)) { fence = !fence; flush(); return; }
    if (fence) return;
    if (yaml) {
      if (/^\s*#/.test(l)) l = l.replace(/^\s*#\s?/, '');
      if (/^\s*[\w.-]+:\s/.test(l) && /\s#\s/.test(l)) { flush(); out.push({ line: i + 1, t: l.slice(l.search(/\s#\s/) + 3) }); return; }
      else if (/^\s*[\w.-]+:\s*(\||>-?)?\s*$/.test(l) || /^\s*[\w.-]+:\s+[^\s'"][^\s]*\s*$/.test(l)) { flush(); return; }
      l = l.replace(/^\s*-\s+'(.*)'\s*$/, '- $1').replace(/^\s*[\w.-]+:\s+(?=\S)/, ''); }
    if (/^\s*\|/.test(l) || /^\s*$/.test(l) || /^\s*#{1,6}\s/.test(l) || /^\s*<!--.*-->\s*$/.test(l) && !/\b(WHEN|THEN)\b|\s\w+\s\w+\s\w+\s/.test(l)) { flush(); if (/^\s*#{1,6}\s/.test(l)) out.push({ line: i + 1, t: l.replace(/^\s*#+\s*/, '') }); return; }
    const item = /^\s*([-*+]|\d+\.)\s+/.test(l);
    if (item || !cur) { flush(); cur = { line: i + 1, t: '' }; }
    cur.t += ' ' + l.replace(/^\s*([-*+]|\d+\.)\s+/, '').replace(/<!--|-->/g, ' ').trim();
  });
  flush(); return out;
}
function sentences(t) {
  const s = t.replace(/`[^`]*`/g, 'CODE').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*?|__/g, '')
    .replace(/\b(e\.g|i\.e|vs|etc)\./g, '$1').replace(/(\d)\.(\d)/g, '$1,$2');
  return s.split(/(?<=[.!?])\s+(?=[A-Z"'(\[])/).map((x) => x.trim()).filter((x) => /[A-Za-z]/.test(x));
}
const words = (s) => s.split(/\s+/).filter((w) => /[A-Za-z0-9]/.test(w)).length;
function lintFile(f, text) {
  const findings = [], stats = [], yaml = /\.ya?ml(\.tmpl)?$/.test(f);
  for (const u of units(text, yaml)) for (const s of sentences(u.t)) {
    const n = words(s), parens = (s.match(/\(/g) || []).length, vague = [...s.replace(/"[^"]*"/g, "").matchAll(VAGUE_RE)].map((m) => m[1].toLowerCase().replace(/\s+/g, ' '));
    stats.push({ n, parens, vague: vague.length });
    const add = (rule, msg) => findings.push({ file: f, line: u.line, rule, message: msg, text: s.length > 90 ? s.slice(0, 87) + '...' : s });
    if (n > LIMIT.hard) add('sentence-hard', `${n} words (hard limit ${LIMIT.hard}): split it`);
    else if (n > LIMIT.long) add('sentence-long', `${n} words (limit ${LIMIT.long}): split it`);
    else if (n > LIMIT.warn) add('sentence-30', `${n} words (aim for ${LIMIT.warn} or fewer)`);
    if (parens >= 2) add('parens', `${parens} parentheses: keep one, make the rest sentences or a list`);
    for (const m of s.matchAll(/\(([^()]*)\)/g)) if (words(m[1]) > LIMIT.parenWords) add('paren-long', `a ${words(m[1])}-word parenthesis: make it its own sentence`);
    if ((s.match(/;/g) || []).length > 1) add('semicolons', 'more than one semicolon: split it');
    for (const v of new Set(vague)) add('vague', `"${v}": ${VAGUE[v] || VAGUE[v.replace(/ /g, ' ')] || 'be concrete'}`);
  }
  if (/\/templates\//.test(f)) for (const [i, l] of text.split('\n').entries())
    if (/\*\*(WHEN|THEN)\*\*.*<!--/.test(l) && !/"[^"]+"|`[^`]+`|\d/.test(l.slice(l.indexOf('<!--'))))
      findings.push({ file: f, line: i + 1, rule: 'placeholder', message: 'a WHEN/THEN placeholder needs a quoted example value', text: l.trim() });
  return { findings, stats };
}
function metrics(all) {
  const row = (st) => ({ sentences: st.length, mean: st.length ? +(st.reduce((a, s) => a + s.n, 0) / st.length).toFixed(1) : 0,
    over30: st.filter((s) => s.n >= 30).length, over45: st.filter((s) => s.n >= 45).length,
    vague: st.reduce((a, s) => a + s.vague, 0), parens2: st.filter((s) => s.parens >= 2).length, words: st.reduce((a, s) => a + s.n, 0) });
  const by = {}; for (const [f, r] of all) (by[areaOf(f)] = by[areaOf(f)] || []).push(...r.stats);
  const out = {}; for (const [a, st] of Object.entries(by)) out[a] = row(st);
  out.total = row([].concat(...Object.values(by))); return out;
}
if (require.main === module) {
  const args = process.argv.slice(2), flags = new Set(args.filter((a) => a.startsWith('--')));
  const files = args.filter((a) => !a.startsWith('--')); const list = files.length ? files : defaultFiles();
  const all = list.map((f) => [path.isAbsolute(f) ? path.relative(ROOT, f) : f, lintFile(f, fs.readFileSync(path.resolve(ROOT, f), 'utf8'))]);
  const findings = [].concat(...all.map(([, r]) => r.findings)), m = metrics(all);
  if (flags.has('--json')) console.log(JSON.stringify({ metrics: m, findings }, null, 1));
  else if (flags.has('--metrics')) {
    console.log('area | sentences | mean words | 30+ | 45+ | vague | 2+ parens | words');
    for (const [a, r] of Object.entries(m)) console.log(`${a} | ${r.sentences} | ${r.mean} | ${r.over30} | ${r.over45} | ${r.vague} | ${r.parens2} | ${r.words}`);
  } else {
    for (const f of findings) console.log(`${f.rule === 'sentence-hard' ? 'warn!' : 'warn '} ${f.file}:${f.line} ${f.rule}: ${f.message} | ${f.text}`);
    const c = {}; for (const f of findings) c[f.rule] = (c[f.rule] || 0) + 1;
    console.log(`prose-lint: ${findings.length} warnings ${JSON.stringify(c)} in ${list.length} files`);
  }
  process.exit(flags.has('--strict') && findings.some((f) => f.rule === 'sentence-hard') ? 1 : 0);
}
module.exports = { lintFile, sentences, units, words, metrics, defaultFiles };
