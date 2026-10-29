#!/usr/bin/env node
'use strict';
/*
 * greenfield.cjs - the new-product (greenfield) side of verify-task.cjs: the project-mode guard, the state-driven
 * `greenfield status`, the roadmap check and the handover gate. verify-task.cjs hands these commands to `main`:
 *
 *   mode [--for CMD]            greenfield | brownfield | greenfield-in-progress | implementation (+ the signals behind it)
 *   greenfield status [--json]  phase, step, the exact next action, what blocks it (derived from files only)
 *   greenfield start --by NAME --yes | new <kind> ... | approve <understood|spec> --by NAME | review <spec|plan|dryrun> ...
 *   roadmap [--next] [--json]   dependency graph, ordering flags, size caps, coverage, next-up slices (read-only)
 *   handover [--write] [--json] the readiness gate; --write records openspec/greenfield/handover.md when READY
 *
 * Nothing here calls an agent or the network. Every write is one small file; no shared index file exists:
 * status, order and coverage are derived from the files each time.
 */
// The commands end with process.exit(); on a pipe Node would drop what is still buffered (output above 64 KB was cut).
// Blocking stdout/stderr make every write complete before the exit.
for (const s of [process.stdout, process.stderr]) if (s._handle && typeof s._handle.setBlocking === 'function') s._handle.setBlocking(true);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const T = require('./traceability.cjs');
const Q = require('./quality.cjs');
const { CODE_EXT_RE: SRC_EXT } = require('./testpaths.cjs'); // the code extensions: one list (testpaths.cjs)

const EXIT_REFUSED = 6; // refused by the project-mode guard: nothing was written
const PHASES = ['Inputs', 'Questions', 'Foundation', 'Capabilities', 'Review', 'Roadmap', 'Handover'];
const TOPICS = {
  users: 'Who are the users and operators of the product? For each role: what they must achieve, how often, on which devices or channels, and what they must NOT be able to do.',
  goals: 'What is the product for, and how will we know it works? List the 3 to 7 outcomes that matter (what users want, and why) and a measurable success target for each.',
  integrations: 'Which external systems must it talk to (payments, identity, notifications, ERP, data feeds)? For each: purpose, direction, who owns it, sandbox or test access, sample data.',
  failure: 'What must happen when things go wrong: an external system is down or slow, invalid input, a double submit, a partial failure, lost data? Per integration: retry, fallback, what the user sees.',
  nfr: 'Numeric targets: response times, throughput and users, availability, data volume and retention, security and privacy rules, accessibility, supported browsers and devices.',
  constraints: 'Fixed technology, hosting, budget, deadlines, legal or regulatory rules, existing systems and data to reuse, team skills.',
  'out-of-scope': 'What is explicitly NOT part of this product or of the first release? What may be asked for later but must not be built now?',
  environments: 'Which environments exist (dev, test, staging, prod)? Who provides access and credentials (names of secrets only, never values), and which roles or test accounts are needed?',
  design: 'Is there a design to match (Figma URL, mockups, brand guide), or is the UI freeform? Where are the files, and who decides design questions?',
};
const NFR_CAP = 'non-functional-requirements';
const SKELETON_MAX_REQ = 5; // a walking skeleton covers at most this many requirements
const SIZE_REQ_CAP = { S: 3, M: 6, L: 10 }; // most requirements one slice may cover
const SECRET_RE = /\b(password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\b\s*[:=]\s*["']?([^\s"'<>{}$`]{8,})/i;

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
const isDir = (d) => { try { return fs.statSync(d).isDirectory(); } catch (e) { return false; } };
const ls = (d, ext) => { try { return fs.readdirSync(d).filter((f) => !f.startsWith('.') && (!ext || f.endsWith(ext))).sort(); } catch (e) { return []; } };
const today = () => new Date().toISOString().slice(0, 10);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const natural = (a, b) => String(a).localeCompare(String(b), 'en', { numeric: true });
const P = (root, ...p) => path.join(root, ...p);
const G = (root, ...p) => path.join(root, 'openspec', 'greenfield', ...p);

// ---------- front matter (a small YAML subset: scalars, [a, b] lists, "- a" block lists) ----------
function fm(text) {
  const t = String(text || '').replace(/\r\n/g, '\n');
  const m = t.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { data: {}, body: t, has: false };
  const data = {}; let key = null;
  for (const raw of m[1].split('\n')) {
    const line = raw.replace(/\s+#\s.*$/, '').replace(/\s+$/, '');
    let k;
    if ((k = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/))) {
      key = k[1]; const v = k[2].trim();
      if (v === '') data[key] = '';
      else if (/^\[.*\]$/.test(v)) data[key] = v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      else data[key] = v.replace(/^["']|["']$/g, '');
    } else if ((k = line.match(/^\s+-\s+(.*)$/)) && key) {
      if (!Array.isArray(data[key])) data[key] = [];
      data[key].push(k[1].trim().replace(/^["']|["']$/g, ''));
    }
  }
  return { data, body: m[2], has: true };
}
/** Set keys in a file's front matter. Byte-preserving: only the lines of the given keys change (a trailing comment on such a line is kept);
 *  other keys, comments, quoting, blank lines, key order, the body and the line endings (LF or CRLF) stay as written. A missing key is added before the closing `---`. */
function setFm(text, upd) {
  const lines = String(text).match(/[^\n]*\n|[^\n]+$/g) || [];
  const strip = (l) => l.replace(/\r?\n$/, '');
  if (!lines.length || strip(lines[0]) !== '---') { const head = Object.entries(upd).map(([k, v]) => `${k}: ${v}\n`).join(''); return `---\n${head}---\n${text}`; }
  let end = lines.findIndex((l, i) => i > 0 && strip(l) === '---');
  if (end < 0) end = lines.length;
  const eol = /\r\n$/.test(lines[0]) ? '\r\n' : '\n';
  for (const [k, v] of Object.entries(upd)) {
    const i = lines.findIndex((l, n) => n > 0 && n < end && new RegExp(`^${k}:`).test(l));
    if (i >= 0) { const m = strip(lines[i]).match(/^[^:]+:[^#]*?([ \t]*#.*)?$/); lines[i] = `${k}: ${v}${m && m[1] ? m[1] : ''}${/\r?\n$/.test(lines[i]) ? (/\r\n$/.test(lines[i]) ? '\r\n' : '\n') : eol}`; }
    else { lines.splice(end, 0, `${k}: ${v}${eol}`); end++; }
  }
  return lines.join('');
}
const list = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const section = (text, re) => {
  const out = []; let on = false;
  for (const l of String(text).split('\n')) { if (/^##\s/.test(l)) { on = re.test(l.replace(/^##\s+/, '')); continue; } if (on) out.push(l); }
  return out.join('\n');
};
const stripComments = (s) => String(s).replace(/<!--[\s\S]*?-->/g, '');

// ---------- layout and project mode ----------
function layoutOf(codeRoot, opts) {
  const root = opts.root || process.env.OPENSPEC_ROOT || codeRoot;
  const cfg = read(P(codeRoot, 'openspec/config.yaml')) || '';
  const workspace = fs.existsSync(P(codeRoot, 'openspec/workspace.yaml')) || /^store:\s*\S/m.test(cfg);
  return { root: fs.existsSync(root) ? fs.realpathSync(root) : root, workspace: workspace && !opts.root && !process.env.OPENSPEC_ROOT };
}
const SKIP_DIRS = new Set(['.git', 'node_modules', 'openspec', 'adr', 'docs', 'doc', 'vendor', 'dist', 'build', 'out', 'coverage', '__pycache__', '.venv', 'venv', 'target']);
const SRC_SKIP = /(?:\.config\.[a-z]+|\.d\.ts|\.min\.js)$|^(?:setup\.py|conftest\.py)$/i;
/** Source files outside openspec/docs/config: { files, lines, sample }. Non-trivial = at least 30 non-blank lines. */
function sourceScan(root) {
  const out = { files: 0, lines: 0, sample: [] }; let seen = 0;
  const walk = (dir, rel) => {
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const e of ents) {
      if (seen > 8000) return;
      if (e.isDirectory()) { if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && rel === '')) continue; walk(path.join(dir, e.name), path.posix.join(rel, e.name)); continue; }
      seen++;
      if (!SRC_EXT.test(e.name) || SRC_SKIP.test(e.name)) continue;
      const t = read(path.join(dir, e.name)); if (t === null) continue;
      const n = t.split('\n').filter((l) => l.trim()).length;
      out.files++; out.lines += n; if (out.sample.length < 3) out.sample.push(path.posix.join(rel, e.name));
    }
  };
  walk(root, '');
  return out;
}
/** Distinct source paths that git history touched (outside the skipped dirs). */
function historyScan(root) {
  if (!isDir(P(root, '.git'))) return { paths: 0, sample: [] };
  const r = spawnSync('git', ['log', '--name-only', '--pretty=format:', '-n', '500'], { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) return { paths: 0, sample: [] };
  const set = new Set(r.stdout.split('\n').filter((p) => p && SRC_EXT.test(p) && !SRC_SKIP.test(path.basename(p)) && !SKIP_DIRS.has(p.split('/')[0]) && !p.startsWith('.')));
  return { paths: set.size, sample: [...set].slice(0, 3) };
}
function activeChanges(root) {
  const d = P(root, 'openspec/changes');
  return ls(d).filter((n) => isDir(path.join(d, n)) && n !== 'archive');
}
function archivedChanges(root) { const d = P(root, 'openspec/changes/archive'); return ls(d).filter((n) => isDir(path.join(d, n))); }
const MARKER = (root) => P(root, 'openspec/greenfield.yaml');

function readSlices(root) {
  const dir = P(root, 'openspec/roadmap');
  return ls(dir, '.md').map((f) => { const t = read(path.join(dir, f)); const x = fm(t); return { id: f.replace(/\.md$/, ''), file: path.join(dir, f), data: x.data, body: x.body, has: x.has }; });
}
const sliceChange = (id) => `slice-${id}`;
/** planned | proposed | applying | done, from the changes themselves (the file's own `status:` is only the planned baseline). */
function sliceState(root, id) {
  const name = sliceChange(id); const dir = P(root, 'openspec/changes', name);
  if (isDir(dir)) {
    const tasks = read(path.join(dir, 'tasks.md')) || '';
    return /^\s*[-*]\s+\[[xX]\]/m.test(tasks) ? 'applying' : 'proposed';
  }
  if (archivedChanges(root).some((n) => n.replace(/^\d{4}-\d{2}-\d{2}-/, '') === name)) return 'done';
  return 'planned';
}
function slicesApplied(root) {
  return readSlices(root).filter((s) => ['applying', 'done'].includes(sliceState(root, s.id)) || ['applying', 'done'].includes(s.data.status)).map((s) => s.id);
}

/** The project mode and the evidence behind it. Pure reads; never writes. */
function modeOf(root) {
  const marker = fm(`---\n${read(MARKER(root)) || ''}\n---\n`); const hasMarker = fs.existsSync(MARKER(root));
  const out = { mode: 'greenfield', marker: hasMarker, signals: [] };
  if (hasMarker) {
    const applied = slicesApplied(root);
    out.mode = applied.length ? 'implementation' : 'greenfield-in-progress';
    if (applied.length) out.signals.push({ kind: 'slice-applied', detail: applied.join(', ') });
    out.started = marker.data.started || null; out.confirmed_by = marker.data.confirmed_by || null;
    return out;
  }
  const own = isDir(G(root)) || isDir(P(root, 'openspec/roadmap')); // files the greenfield flow created, marker lost
  const s = sourceScan(root); const h = historyScan(root);
  if (s.lines >= 30) out.signals.push({ kind: 'source', detail: `${s.files} source file(s), ${s.lines} lines (${s.sample.join(', ')})` });
  if (h.paths >= 3) out.signals.push({ kind: 'git-history', detail: `${h.paths} source path(s) in the history (${h.sample.join(', ')})` });
  if (!own) {
    const arch = archivedChanges(root); if (arch.length) out.signals.push({ kind: 'archived-changes', detail: arch.slice(0, 3).join(', ') });
    const act = activeChanges(root); if (act.length) out.signals.push({ kind: 'active-changes', detail: act.slice(0, 3).join(', ') });
    const specs = ls(P(root, 'openspec/specs')).filter((c) => fs.existsSync(P(root, 'openspec/specs', c, 'spec.md'))); if (specs.length) out.signals.push({ kind: 'living-specs', detail: specs.slice(0, 3).join(', ') });
    const adrs = ls(P(root, 'adr'), '.md').filter((f) => f !== 'README.md'); if (adrs.length) out.signals.push({ kind: 'adrs', detail: adrs.slice(0, 3).join(', ') });
  }
  if (out.signals.length) out.mode = 'brownfield';
  else if (own) { out.mode = 'greenfield-in-progress'; out.marker_missing = true; }
  return out;
}

// What each command may do in each mode. `write`: needs greenfield or greenfield-in-progress; read-only ones also work in implementation.
const ALTERNATIVE = {
  brownfield: 'This project already has code, history or specs, so it is not a new product. Use /spec-adopt [scope] to bring the existing code under spec control, /spec-propose <change> for new work, /spec-garden for the drift backlog.',
  implementation: 'The first slice is already applied: the specification phase is over. Use /spec-green-next for the next slice, /spec-propose <change> to amend the specs (rewriting the Why of a requirement or removing a requirement needs the owner), /spec-garden for the drift backlog. Greenfield commands are read-only now.',
  'greenfield-in-progress': 'A new-product spec is in progress here. Run /spec-green-start (it continues where the project is), or /spec-green-next once the handover is READY. /spec-adopt would document code that does not exist yet.',
  unsupported: 'Greenfield commands support the layout where the specs live next to the code (not a --specs/--store workspace). Run them in a repository that has openspec/ itself.',
};
const FOR = {
  start: ['greenfield', 'greenfield-in-progress'], plan: ['greenfield-in-progress'], status: ['greenfield', 'greenfield-in-progress', 'implementation'],
  adopt: ['greenfield', 'brownfield'], next: ['greenfield-in-progress', 'implementation'], propose: ['greenfield', 'greenfield-in-progress', 'brownfield', 'implementation'],
  garden: ['greenfield', 'greenfield-in-progress', 'brownfield', 'implementation'],
};
function allowed(mode, cmd) { return (FOR[cmd] || []).includes(mode); }
function refusal(m, cmd) {
  const alt = m.mode === 'brownfield' && cmd === 'start' ? ALTERNATIVE.brownfield : ALTERNATIVE[m.mode] || '';
  return { refused: true, command: cmd, mode: m.mode, why: m.signals.map((s) => `${s.kind}: ${s.detail}`), alternative: alt, wrote: 'nothing' };
}

// ---------- the files of the flow ----------
// Every analyst addition is its own new file in openspec/greenfield/records/, named by its contributor: Q-<topic>.md (a question),
// A-<slug>.md (an assumption), ENV-<name>.md (an environment). Two branches that add records add different paths, so they merge cleanly;
// nothing is appended to a shared file and no index exists (the lists are derived from the folder).
const RECORDS = 'records';
const files = (root, dir, prefix) => ls(G(root, dir), '.md').filter((f) => !prefix || f.startsWith(prefix)).map((f) => {
  const t = read(G(root, dir, f)); const x = fm(t); return { id: f.replace(/\.md$/, ''), file: G(root, dir, f), data: x.data, body: x.body };
});
const answerOf = (body) => stripComments(section(body, /^answer\b/i)).trim();
function questions(root) {
  return files(root, RECORDS, 'Q-').map((q) => {
    const status = String(q.data.status || 'open').toLowerCase(); const ans = answerOf(q.body);
    const filled = status === 'n/a' ? ans.length >= 10 : ans.length >= 15;
    const eff = (status === 'answered' || status === 'n/a') && !filled ? 'open' : status === 'assumed' ? 'assumed' : status;
    return { ...q, topic: q.data.topic || '', status: eff, declared: status, blocking: String(q.data.blocking || 'yes').toLowerCase() !== 'no', owner: q.data.owner || 'client', answer: ans };
  });
}
const PLACEHOLDER = /^<.*>$|^$/;
function assumptions(root) {
  return files(root, RECORDS, 'A-').map((a) => {
    const d = a.data; const bad = [];
    for (const k of ['owner', 'verify_by', 'replan_trigger', 'from']) if (PLACEHOLDER.test(String(d[k] || '').trim())) bad.push(k);
    return { ...a, status: String(d.status || 'open').toLowerCase(), owner: d.owner || '', from: d.from || '', verify_by: d.verify_by || '', replan_trigger: d.replan_trigger || '', bad };
  });
}
function capabilities(root) {
  return files(root, 'capabilities').map((c) => ({ ...c, cap: c.id, kind: c.data.kind === 'integration' ? 'integration' : 'capability', priority: c.data.priority || 'P1', risk: list(c.data.risk).filter((x) => x && x !== 'none'), sandbox: c.data.sandbox || '' }))
    .sort((a, b) => natural(a.priority, b.priority) || natural(a.cap, b.cap));
}
const environments = (root) => files(root, RECORDS, 'ENV-').map((e) => ({ ...e, name: e.id.slice(4) }));
const exploration = (root) => read(G(root, 'exploration.md'));
const EXPLORATION_SECTIONS = [/^capability map\b/i, /^integration inventory\b/i];
const UNDERSTOOD_SECTIONS = [['Product in one paragraph', /^product\b/i], ['Users and what they need', /^users\b/i], ['What it must do', /^what it must do\b/i], ['Systems it connects to', /^systems\b/i], ['What happens when things fail', /^what happens when things fail\b/i], ['Targets', /^targets\b/i], ['Out of scope', /^out of scope\b/i], ['Assumptions we made', /^assumptions\b/i], ['Still open', /^still open\b/i]];

function hashDir(root, rels) {
  const h = []; for (const rel of rels) {
    const abs = P(root, rel);
    const walk = (p, r) => { if (isDir(p)) { for (const f of ls(p)) walk(path.join(p, f), `${r}/${f}`); } else if (fs.existsSync(p)) { h.push(`${r}\n${(read(p) || '').replace(/\r\n/g, '\n')}`); } };
    walk(abs, rel);
  }
  return sha(h.sort().join('\n--\n'));
}
const specHash = (root) => hashDir(root, ['openspec/specs', 'adr', 'openspec/glossary.md', 'openspec/greenfield/capabilities']);
const planHash = (root) => sha(specHash(root) + hashDir(root, ['openspec/roadmap']));
function understoodState(root) {
  const t = read(G(root, 'understood.md')); if (t === null) return { exists: false, problems: ['openspec/greenfield/understood.md does not exist'], approved: false };
  const x = fm(t); const problems = []; const body = stripComments(x.body);
  const lines = body.split('\n').filter((l) => l.trim()).length;
  if (lines > 80) problems.push(`it is ${lines} lines: keep "what we understood" to one page (80 lines)`);
  for (const [name, re] of UNDERSTOOD_SECTIONS) if (!body.split('\n').some((l) => /^##\s/.test(l) && re.test(l.replace(/^##\s+/, '')))) problems.push(`missing section "## ${name}"`);
  const need = [...assumptions(root).map((a) => a.id), ...questions(root).filter((q) => !q.blocking && (q.status === 'open' || q.status === 'asked')).map((q) => q.id), ...capabilities(root).map((c) => c.cap)];
  const absent = need.filter((n) => !body.toLowerCase().includes(n.toLowerCase())); if (absent.length) problems.push(`it does not mention: ${absent.slice(0, 12).join(', ')}${absent.length > 12 ? ', ...' : ''}`);
  if (/<fill in|\bTODO\b|<[a-z][^>]*>/i.test(body.replace(/`[^`]*`/g, ''))) problems.push('it still has placeholders (<...> or TODO)');
  const hash = sha(body.replace(/\s+/g, ' ').trim() + '|' + capabilities(root).map((c) => c.cap).join(','));
  const approved = !!x.data.approved_by && x.data.approved_hash === hash;
  return { exists: true, problems, hash, approved, stale: !!x.data.approved_by && !approved, approved_by: x.data.approved_by || null };
}
function reviewOf(root, kind) {
  const r = fm(read(G(root, 'reviews', `${kind}.md`))); if (!r.has) return null;
  const cur = kind === 'spec' ? specHash(root) : planHash(root);
  return { ...r.data, score: Number(r.data.score || 0), current: r.data.hash === cur, body: r.body };
}
function signoffOf(root) {
  const r = fm(read(G(root, 'signoff.md'))); if (!r.has) return null;
  return { ...r.data, current: r.data.spec_hash === specHash(root) };
}
function glossaryTerms(root) { return [...(read(P(root, 'openspec/glossary.md')) || '').matchAll(/^[-*]\s+\*\*([^*]+)\*\*\s*[:\u2013\u2014-]\s*\S+/gm)].map((m) => m[1].trim()); }
function adrFiles(root) { return ls(P(root, 'adr'), '.md').filter((f) => f !== 'README.md'); }

// ---------- spec checks (pure reads of the living specs or of a change's delta) ----------
const MEASURE_RE = /\d+(?:[.,]\d+)?\s*%|\d+(?:[.,]\d+)?\s*(?:ms|milliseconds?|s|sec|seconds?|min|minutes?|hours?|days?|months?|years?|percent|rps|req(?:uests?)?|users?|versions?|mb|gb|kb|tb|per\s+\w+|\/\s?\w+)\b|\bnever\b/i;
/** Contract problems of an integration capability's spec (parsed spec: { purpose, reqs }). */
function contractProblems(cap, spec) {
  const out = []; const names = spec.reqs.map((r) => r.name);
  if (!names.some((n) => /^contract\b/i.test(n))) out.push(`${cap}: no "### Requirement: Contract ..." (endpoints or messages, fields, authentication, rate limits)`);
  const failures = spec.reqs.flatMap((r) => r.scenarios).filter((s) => /^failure\b/i.test(s.name));
  if (failures.length < 2) out.push(`${cap}: ${failures.length} "#### Scenario: Failure: ..." scenario(s); an integration needs at least 2 (timeout or unavailable, rejected or malformed reply, duplicate or retry)`);
  return out;
}
function nfrProblems(spec) {
  const out = [];
  if (!spec.reqs.length) out.push(`${NFR_CAP}: no requirements`);
  for (const r of spec.reqs) if (!MEASURE_RE.test(r.block.replace(/^###.*$/m, '').replace(/^.*\*\*(?:WHEN|GIVEN)\*\*.*$/gm, ''))) out.push(`${NFR_CAP}/${r.slug}: no measurable target (a number with a unit: ms, %, users, MB, per second, ...)`);
  return out;
}
function specProblems(root) {
  const reqs = T.livingRequirements(root); const p = [];
  for (const [k, r] of reqs) {
    if (!r.scenarios.length) p.push(`${k}: no scenario`);
    else if (!/\bWHEN\b/.test(r.block) || !/\bTHEN\b/.test(r.block)) p.push(`${k}: scenario without WHEN and THEN`);
    if (!r.why) p.push(`${k}: no "Why:" line (who wants it, and why)`);
  }
  return p;
}
const livingSpec = (root, cap) => { const t = read(P(root, 'openspec/specs', cap, 'spec.md')); return t === null ? null : T.parseSpec(t); };

// ---------- roadmap ----------
const SIZES = ['S', 'M', 'L'];
const STATUSES = ['planned', 'proposed', 'applying', 'done'];
function parseCovers(entry) { const i = entry.indexOf('/'); return i < 0 ? { cap: entry, req: null } : { cap: entry.slice(0, i), req: entry.slice(i + 1) }; }
function roadmap(root) {
  const slices = readSlices(root).map((s) => ({ ...s, title: s.data.title || '', size: String(s.data.size || '').toUpperCase(), fileStatus: s.data.status || 'planned', milestone: String(s.data.milestone || ''), deps: list(s.data.depends_on), covers: list(s.data.capabilities), tests: list(s.data.contract_tests), skeleton: /^true$/i.test(String(s.data.skeleton || '')) }));
  const errors = []; const warnings = [];
  const E = (code, id, text) => errors.push({ code, slice: id || null, text }); const W = (code, id, text) => warnings.push({ code, slice: id || null, text });
  const caps = new Map(capabilities(root).map((c) => [c.cap, c])); const reqs = T.livingRequirements(root);
  const specCaps = new Set([...reqs.values()].map((r) => r.cap)); const byId = new Map(slices.map((s) => [s.id, s]));
  for (const s of slices) {
    if (!s.has) E('bad-front-matter', s.id, `${s.id}: no front matter (id, title, capabilities, depends_on, size, status, milestone)`);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(s.id)) E('bad-id', s.id, `${s.id}: the file name must be a kebab-case id`);
    if (s.data.id && s.data.id !== s.id) E('id-mismatch', s.id, `${s.id}: front matter id '${s.data.id}' differs from the file name`);
    if (!s.title) E('no-title', s.id, `${s.id}: no title`);
    if (!SIZES.includes(s.size)) E('bad-size', s.id, `${s.id}: size must be S, M or L (got '${s.size || ''}')`);
    if (!STATUSES.includes(s.fileStatus)) E('bad-status', s.id, `${s.id}: status must be planned, proposed, applying or done`);
    if (!s.milestone) E('no-milestone', s.id, `${s.id}: no milestone (e.g. m1)`);
    if (!s.covers.length) E('no-capabilities', s.id, `${s.id}: capabilities is empty (list capability names or capability/requirement-slug)`);
    if (!/^##\s+Acceptance criteria\b[\s\S]*^\s*[-*]\s+\S/m.test(s.body)) E('no-acceptance', s.id, `${s.id}: no "## Acceptance criteria" bullets`);
    for (const d of s.deps) { if (d === s.id) E('self-dependency', s.id, `${s.id}: depends on itself`); else if (!byId.has(d)) E('unknown-dependency', s.id, `${s.id}: depends_on unknown slice '${d}'`); }
  }
  // order: topological with a stable tie-break (milestone, then id); a cycle is an error
  const remaining = new Map(slices.map((s) => [s.id, new Set(s.deps.filter((d) => byId.has(d) && d !== s.id))]));
  const order = []; const key = (id) => `${byId.get(id).milestone}\u0000${id}`;
  while (remaining.size) {
    const ready = [...remaining.entries()].filter(([, d]) => ![...d].some((x) => remaining.has(x))).map(([id]) => id).sort((a, b) => natural(key(a), key(b)));
    if (!ready.length) { E('cycle', null, `dependency cycle among: ${[...remaining.keys()].sort().join(', ')}`); order.push(...[...remaining.keys()].sort()); break; }
    order.push(ready[0]); remaining.delete(ready[0]);
  }
  const depth = new Map(order.map((id, i) => [id, i + 1]));
  const reach = (id, seen = new Set()) => { for (const d of byId.get(id).deps) if (byId.has(d) && !seen.has(d)) { seen.add(d); reach(d, seen); } return seen; };
  // coverage, capabilities and requirements per slice
  const covered = new Map(); const sliceReqs = new Map();
  for (const s of slices) {
    const mine = new Set();
    for (const e of s.covers) {
      const { cap, req } = parseCovers(e);
      if (!caps.has(cap) && !specCaps.has(cap)) { E('unknown-capability', s.id, `${s.id}: capability '${cap}' is neither in openspec/greenfield/capabilities/ nor a living spec`); continue; }
      const keys = [...reqs.keys()].filter((k) => k.startsWith(`${cap}/`));
      if (req) { if (!reqs.has(e)) E('unknown-requirement', s.id, `${s.id}: requirement '${e}' does not exist in openspec/specs/`); else keys.splice(0, keys.length, e); }
      else if (!keys.length) E('no-spec', s.id, `${s.id}: capability '${cap}' has no living spec yet`);
      for (const k of keys) { mine.add(k); covered.set(k, [...(covered.get(k) || []), s.id]); }
    }
    sliceReqs.set(s.id, mine);
  }
  const uncovered = [...reqs.keys()].filter((k) => !k.startsWith(`${NFR_CAP}/`) && !covered.has(k)).sort();
  if (uncovered.length) E('uncovered-requirement', null, `${uncovered.length} requirement(s) belong to no slice: ${uncovered.slice(0, 8).join(', ')}${uncovered.length > 8 ? ', ...' : ''}`);
  const overlaps = [...covered.entries()].filter(([, v]) => v.length > 1).map(([k, v]) => ({ requirement: k, slices: v }));
  if (overlaps.length) W('overlap', null, `${overlaps.length} requirement(s) are in more than one slice: ${overlaps.slice(0, 5).map((o) => `${o.requirement} (${o.slices.join(', ')})`).join('; ')}`);
  // size caps
  for (const s of slices) {
    const mine = [...(sliceReqs.get(s.id) || [])]; const capsIn = [...new Set(mine.map((k) => k.split('/')[0]))];
    const risk = [...new Set(capsIn.flatMap((c) => (caps.get(c) ? caps.get(c).risk : [])))];
    const need = Q.requiredSize({ capabilities: capsIn, requirements: mine.length, breaking: false, risk, risky_groups: [], visual_blocks: 0, adrs: [] });
    s.required = need.size; s.requirements = mine.length;
    if (SIZES.includes(s.size) && SIZES.indexOf(s.size) < SIZES.indexOf(need.size)) E('size-under', s.id, `${s.id}: declares size ${s.size} but needs ${need.size} (${[...need.reasons.L, ...(need.size === 'M' ? need.reasons.M : [])].join('; ')}): declare ${need.size} or split the slice`);
    if (SIZES.includes(s.size) && mine.length > SIZE_REQ_CAP[s.size]) E('size-cap', s.id, `${s.id}: covers ${mine.length} requirements, more than a size ${s.size} slice may (${SIZE_REQ_CAP[s.size]}): split it`);
    if (s.size === 'L' && mine.length > SIZE_REQ_CAP.L) E('size-cap', s.id, `${s.id}: even an L slice covers at most ${SIZE_REQ_CAP.L} requirements; split it`);
  }
  // walking skeleton first
  const sk = slices.filter((s) => s.skeleton);
  if (slices.length && !sk.length) E('no-skeleton', null, 'no walking skeleton: mark exactly one slice `skeleton: true` (the thinnest end-to-end path, with no dependencies)');
  if (sk.length > 1) E('multiple-skeletons', null, `more than one skeleton slice: ${sk.map((s) => s.id).join(', ')}`);
  if (sk.length === 1) {
    const k = sk[0];
    if (k.deps.length) E('skeleton-dependency', k.id, `${k.id}: the skeleton must not depend on anything`);
    if (k.requirements > SKELETON_MAX_REQ) E('skeleton-thick', k.id, `${k.id}: the skeleton covers ${k.requirements} requirements (at most ${SKELETON_MAX_REQ}); a walking skeleton is the thinnest end-to-end path: move the rest to later slices`);
    for (const s of slices) if (s !== k && !byId.has(k.id) === false && !reach(s.id).has(k.id)) E('not-after-skeleton', s.id, `${s.id}: does not depend (directly or not) on the skeleton ${k.id}; add depends_on: [${k.id}]`);
  }
  // milestones and integrations
  for (const s of slices) for (const d of s.deps) if (byId.has(d) && natural(byId.get(d).milestone, s.milestone) > 0) E('milestone-order', s.id, `${s.id} (${s.milestone}) depends on ${d} (${byId.get(d).milestone}), a later milestone`);
  const firstOf = new Map();
  for (const id of order) for (const k of sliceReqs.get(id) || []) { const c = k.split('/')[0]; if (caps.get(c) && caps.get(c).kind === 'integration' && !firstOf.has(c)) firstOf.set(c, id); }
  for (const [c, id] of firstOf) {
    if (!byId.get(id).tests.includes(c)) E('contract-test-missing', id, `${id}: first slice that touches integration '${c}' must list it under contract_tests (a stub, mock or contract test for it is built in this slice)`);
    const risky = caps.get(c).risk.length; const n = slices.length;
    if (risky && depth.get(id) > Math.max(2, Math.ceil(n / 2))) W('risky-late', id, `${id}: integration '${c}' (risk: ${caps.get(c).risk.join(', ')}) first appears at position ${depth.get(id)} of ${n}; try the risky integrations earlier`);
  }
  for (const s of slices) for (const t of s.tests) if (!(sliceReqs.get(s.id) || new Set()).size || ![...sliceReqs.get(s.id)].some((k) => k.split('/')[0] === t)) E('contract-test-unknown', s.id, `${s.id}: contract_tests lists '${t}', which this slice does not cover`);
  // live status
  for (const s of slices) {
    s.status = sliceState(root, s.id);
    if (STATUSES.indexOf(s.fileStatus) >= 0 && s.fileStatus !== s.status && STATUSES.indexOf(s.fileStatus) < STATUSES.indexOf(s.status)) W('status-stale', s.id, `${s.id}: file says '${s.fileStatus}' but the changes say '${s.status}': update the slice file's status line in the slice's own commit`);
  }
  const done = new Set(slices.filter((s) => s.status === 'done' || s.fileStatus === 'done').map((s) => s.id));
  const nextUp = order.filter((id) => !done.has(id) && byId.get(id).deps.every((d) => done.has(d)));
  // trace: slice -> requirements (each with its Why)
  const trace = {}; for (const s of slices) trace[s.id] = [...(sliceReqs.get(s.id) || [])].map((k) => ({ key: k, why: (reqs.get(k) || {}).why || '' }));
  const counts = Object.fromEntries(STATUSES.map((st) => [st, slices.filter((s) => s.status === st).length]));
  return { ok: !errors.length, slices: order.map((id) => { const s = byId.get(id); return { id, title: s.title, size: s.size, required_size: s.required, milestone: s.milestone, status: s.status, file_status: s.fileStatus, depends_on: s.deps, capabilities: s.covers, requirements: s.requirements, skeleton: s.skeleton || undefined, contract_tests: s.tests.length ? s.tests : undefined }; }), order, next_up: nextUp, counts, coverage: { requirements: [...reqs.keys()].filter((k) => !k.startsWith(`${NFR_CAP}/`)).length, uncovered, overlaps }, trace, errors, warnings };
}

// ---------- changes that carry the spec (foundation, capabilities) ----------
const isSpecOnly = (root, name) => /^\s*(?:[-*]\s+)?\**Kind\**:\s*\**spec-only\b/mi.test(read(P(root, 'openspec/changes', name, 'proposal.md')) || '');
function changeState(root, name, cap) {
  const dir = P(root, 'openspec/changes', name); const exists = isDir(dir); const out = { name, exists, missing: [], problems: [] };
  if (!exists) return out;
  for (const f of ['proposal.md', 'tasks.md']) if (!fs.existsSync(path.join(dir, f))) out.missing.push(f);
  if (!ls(path.join(dir, 'adrs'), '.md').filter((f) => !Q.isNoneAdr(f, (() => { try { return fs.readFileSync(path.join(dir, 'adrs', f), 'utf8'); } catch (e) { return ''; } })())).length && name === 'foundation') out.missing.push('adrs/ (at least one ADR: the fixed technology and architecture decisions)');
  const deltas = T.changeDeltas(dir); if (!deltas.length) out.missing.push('specs/<capability>/spec.md');
  if (fs.existsSync(path.join(dir, 'proposal.md')) && !isSpecOnly(root, name)) out.problems.push('proposal.md: add the line "Kind: spec-only" (this change only writes specs; nothing is implemented)');
  for (const d of deltas) {
    if (cap && d.cap !== cap && name !== 'foundation') out.problems.push(`specs/${d.cap}: a capability change edits only its own capability (${cap})`);
    for (const r of d.reqs) {
      if (r.op !== 'ADDED' && r.op !== 'MODIFIED') continue; const k = `${d.cap}/${r.slug}`;
      if (!r.scenarios.length) out.problems.push(`${k}: no scenario`);
      else if (!/\bWHEN\b/.test(r.block) || !/\bTHEN\b/.test(r.block)) out.problems.push(`${k}: scenario without WHEN and THEN`);
      if (!r.why) out.problems.push(`${k}: no "Why:" line (who wants it, and why)`);
    }
    if (d.cap === NFR_CAP) out.problems.push(...nfrProblems(d));
    if (cap && d.cap === cap && capabilities(root).find((c) => c.cap === cap && c.kind === 'integration')) out.problems.push(...contractProblems(cap, d));
  }
  if (name === 'foundation') {
    if (!deltas.some((d) => d.cap === NFR_CAP)) out.missing.push(`specs/${NFR_CAP}/spec.md (measurable targets)`);
    if (glossaryTerms(root).length < 3) out.missing.push('openspec/glossary.md with at least 3 terms ("- **Term**: meaning")');
  }
  out.complete = !out.missing.length && !out.problems.length;
  return out;
}
const activeExists = (root, name) => isDir(P(root, 'openspec/changes', name));

// ---------- the gate (what "ready for handover" means) ----------
function secretScan(root, rels) {
  const hits = [];
  const walk = (p, rel) => { if (isDir(p)) { for (const f of ls(p)) walk(path.join(p, f), `${rel}/${f}`); return; } if (!/\.(md|ya?ml|json|txt|env)$/i.test(p)) return; (read(p) || '').split('\n').forEach((l, i) => { const m = l.match(SECRET_RE); if (m && !/^[A-Z][A-Z0-9_]{2,}$/.test(m[2]) && !/^(?:env:|\$|\*+$|x+$|changeme|example|placeholder|redacted)/i.test(m[2])) hits.push(`${rel}:${i + 1}`); }); };
  for (const r of rels) walk(P(root, r), r);
  return hits;
}
function gate(root) {
  const items = []; const I = (id, ok, text, detail, fix) => items.push({ id, ok: !!ok, text, detail: ok ? [] : (detail || []), fix: ok ? null : fix });
  const qs = questions(root); const as = assumptions(root); const caps = capabilities(root); const us = understoodState(root);
  const inputs = inputFiles(root);
  I('inputs', inputs.length >= 1, 'client inputs are in openspec/inputs/', ['openspec/inputs/ has no files besides README.md'], 'Put the client material into openspec/inputs/, then run /spec-green-start.');
  I('understood', us.approved, '"what we understood" approved by the client', us.exists ? [...us.problems, ...(us.stale ? ['it changed after the approval'] : us.approved ? [] : ['not approved yet'])] : us.problems, 'Run /spec-green-start (it writes the page and asks for the approval).');
  const open = qs.filter((q) => q.blocking && (q.status === 'open' || q.status === 'asked'));
  const missingTopics = Object.keys(TOPICS).filter((t) => !qs.some((q) => q.topic === t));
  I('questions', !open.length && !missingTopics.length && !as.some((a) => a.bad.length) && qs.filter((q) => q.status === 'assumed').every((q) => as.some((a) => a.from === q.id)), 'every question is answered, assumed with an owner, or not applicable',
    [...open.map((q) => `${q.id} is ${q.status} (owner: ${q.owner})`), ...missingTopics.map((t) => `no question file for topic '${t}'`), ...as.filter((a) => a.bad.length).map((a) => `${a.id}: missing ${a.bad.join(', ')}`), ...qs.filter((q) => q.status === 'assumed' && !as.some((a) => a.from === q.id)).map((q) => `${q.id} is assumed but has no assumption file`)], 'Run /spec-green-start and follow its Next line.');
  const invalid = as.filter((a) => a.status === 'invalidated');
  I('assumptions', !invalid.length, 'no assumption is invalidated (an invalidated assumption triggers a re-plan)', invalid.map((a) => `${a.id}: ${a.replan_trigger}`), 'Update the affected specs and slices, then set the assumption status to verified or remove it.');
  const sp = specProblems(root);
  I('requirements', sp.length === 0 && T.livingRequirements(root).size > 0, 'every requirement has testable scenarios (WHEN/THEN) and a Why (who wants it, and why)', sp.length ? sp : ['there are no requirements'], 'Fix the listed requirements with a spec-only change.');
  const noSpec = caps.filter((c) => !livingSpec(root, c.cap));
  I('capabilities', caps.length >= 1 && !noSpec.length, 'every capability in the map has its spec', noSpec.length ? noSpec.map((c) => `${c.cap} has no openspec/specs/${c.cap}/spec.md`) : ['no capability files'], 'Run /spec-green-start (Capabilities phase).');
  const ip = []; for (const c of caps.filter((x) => x.kind === 'integration')) { const s = livingSpec(root, c.cap); if (!c.sandbox || PLACEHOLDER.test(c.sandbox)) ip.push(`${c.cap}: no sandbox (test endpoint, sample data, who provides access) in its capability file`); if (s) ip.push(...contractProblems(c.cap, s)); }
  I('integrations', !ip.length, 'every integration has a contract, 2+ failure scenarios and sandbox data', ip, 'Fix with a spec-only change (see schemas templates/integration-contract.md).');
  const ns = livingSpec(root, NFR_CAP); const np = ns ? nfrProblems(ns) : [`openspec/specs/${NFR_CAP}/spec.md does not exist`];
  I('nfr', !np.length, 'non-functional requirements are measurable', np, 'Fix with a spec-only change; every NFR needs a number and a unit.');
  I('glossary', glossaryTerms(root).length >= 3, 'glossary has at least 3 terms', ['openspec/glossary.md needs "- **Term**: meaning" lines'], 'Write openspec/glossary.md.');
  I('adrs', adrFiles(root).length >= 1, 'architecture decisions are recorded (adr/)', ['adr/ has no decision'], 'Record the fixed decisions as ADRs in the foundation change.');
  const envs = environments(root).filter((e) => !PLACEHOLDER.test(String(e.data.access || '')) && list(e.data.roles).length);
  I('environments', envs.length >= 1, 'environments, access owners and roles are written down (names only, no secrets)', ['no openspec/greenfield/records/ENV-<name>.md with `access:` and `roles:`'], 'Run: verify-task.cjs greenfield new environment <name>, then fill it in.');
  const hits = secretScan(root, ['openspec/greenfield', 'openspec/specs', 'openspec/roadmap', 'adr', 'openspec/glossary.md']);
  I('no-secrets', !hits.length, 'no credentials in the spec files', hits.map((h) => `${h} looks like a credential value; name the secret instead (e.g. PAYMENTS_API_KEY) and say who provides it`), 'Remove the value, rotate the credential if it was real.');
  const rv = reviewOf(root, 'spec'); const so = signoffOf(root);
  const rvOk = (r) => r && r.current && (r.verdict === 'pass' || r.verdict === 'waived');
  I('spec-review', rvOk(rv), 'an independent reviewer passed the spec (score 80+, no blockers)', !rv ? ['no review recorded'] : !rv.current ? ['the specs changed after the review'] : [`verdict ${rv.verdict}, score ${rv.score}`], 'Run /spec-green-start (Review phase).');
  I('signoff', !!so && so.current, 'the client signed off the reviewed spec', !so ? ['no sign-off recorded'] : ['the specs changed after the sign-off'], 'Run: verify-task.cjs greenfield approve spec --by "<name>" after the client agrees.');
  const rm = roadmap(root);
  I('roadmap', rm.slices.length > 0 && rm.ok, 'the roadmap is valid (no cycles, skeleton first, every requirement covered, sizes within caps)', rm.slices.length ? rm.errors.map((e) => e.text) : ['no slices in openspec/roadmap/'], 'Run /spec-green-plan.');
  const pr = reviewOf(root, 'plan'); const dr = reviewOf(root, 'dryrun');
  I('plan-review', rvOk(pr), 'an independent reviewer passed the plan', !pr ? ['no plan review recorded'] : !pr.current ? ['the plan changed after the review'] : [`verdict ${pr.verdict}, score ${pr.score}`], 'Run /spec-green-start (Roadmap phase).');
  I('dry-run', rvOk(dr), 'an implementability dry-run found no blocking unknowns', !dr ? ['no dry-run recorded'] : !dr.current ? ['the plan or specs changed after the dry-run'] : [`verdict ${dr.verdict}`], 'Run /spec-green-start (Roadmap phase).');
  const warnings = []; const inputHits = secretScan(root, ['openspec/inputs']); if (inputHits.length) warnings.push(`openspec/inputs has what looks like credential value(s) (${inputHits.slice(0, 3).join(', ')}): keep them out of the repository`);
  if (rv && rv.verdict === 'waived') warnings.push(`spec review waived: ${rv.reason || 'no reason'}`); if (pr && pr.verdict === 'waived') warnings.push(`plan review waived: ${pr.reason || 'no reason'}`); if (dr && dr.verdict === 'waived') warnings.push(`dry-run waived: ${dr.reason || 'no reason'}`);
  const missing = items.filter((i) => !i.ok);
  return { ready: !missing.length, items, missing, warnings, roadmap: rm };
}
function inputFiles(root) {
  const out = []; const walk = (p, rel) => { for (const f of ls(p)) { const a = path.join(p, f); if (isDir(a)) walk(a, `${rel}${f}/`); else if (!(rel === '' && f === 'README.md')) out.push(`${rel}${f}`); } };
  walk(P(root, 'openspec/inputs'), ''); return out;
}

// ---------- templates ----------
const VT = 'node openspec/scripts/verify-task.cjs';
const TEMPLATES = {
  exploration: () => `# Exploration: <product name>\n\n## Capability map\n<one line per capability or integration, with its priority; the machine-readable files are openspec/greenfield/capabilities/>\n\n## Integration inventory\n<one line per external system: purpose, direction, owner, sandbox>\n`,
  question: (topic, text) => `---\nid: Q-${topic}\ntopic: ${topic}\nstatus: open        # open | asked | answered | assumed | n/a\nblocking: yes\nowner: client\n---\n## Question\n${text || TOPICS[topic] || '<the question, in one or two sentences>'}\n\n## Answer\n<!-- Fill in and cite the source (inputs/<file>, or who answered and when). status: asked = sent to the client, waiting. status: assumed needs an A-<slug> assumption. status: n/a needs a reason here. -->\n`,
  assumption: (slug, from) => `---\nid: A-${slug}\nfrom: ${from || 'Q-<topic>'}\nowner: <who verifies it>\nstatus: open        # open | verified | invalidated\nverify_by: <the moment or milestone by which it must be verified>\nreplan_trigger: <what happens to the plan if it turns out false>\n---\n## Assumption\n<one sentence>\n`,
  capability: (name, kind) => `---\ncapability: ${name}\nkind: ${kind}        # capability | integration\npriority: P0         # P0 = the first slice needs it, P1, P2 ...\nrisk: none           # none, or any of: security, money, data-migration, concurrency, public-api\nsandbox: ${kind === 'integration' ? '' : 'n/a'}${kind === 'integration' ? '          # test endpoint, sample data and who provides access' : ''}\n---\n<one line: what a user or a system can do with it>\n`,
  environment: (name) => `---\nname: ${name}\naccess: <who provides access, and which secrets are needed (names only, never values)>\nroles: [<role or test account>]\n---\n<what runs here and who may use it>\n`,
  slice: (id) => `---\nid: ${id}\ntitle: <what a user or system can do after this slice>\ncapabilities: [<capability>, <capability>/<requirement-slug>]\ndepends_on: []\nsize: S\nstatus: planned\nmilestone: m1\nskeleton: false\ncontract_tests: []\n---\n## Acceptance criteria\n- <observable result that shows the slice is done>\n\n## Notes\n<anything the developer needs and the specs do not say; design links, sample data files>\n`,
  understood: () => `---\napproved_by:\napproved_on:\napproved_hash:\n---\n# What we understood\n\n## Product in one paragraph\n<...>\n\n## Users and what they need\n<one line per role>\n\n## What it must do\n<one line per capability, with its priority>\n\n## Systems it connects to\n<one line per integration: what flows, who owns it>\n\n## What happens when things fail\n<one line per integration or risky flow>\n\n## Targets\n<the numbers: speed, users, availability, retention>\n\n## Out of scope\n<...>\n\n## Assumptions we made\n<one line per A-id: what, who verifies, by when>\n\n## Still open\n<one line per open question that is not blocking: Q-id, owner>\n`,
};
const INPUTS_README = `# Inputs\n\nPut everything the client gave you in this folder: briefs, requirements, screenshots, API documents, e-mail threads, spreadsheets, sample data, design links.\n\n- One file per source; keep the original name. For calls and chats write a short note: date, who, what was said.\n- Never put passwords, tokens or keys here. Write the secret's name (for example PAYMENTS_API_KEY) and who provides it.\n- Messy is fine: the agent reads all of it and asks you for what is missing.\n\nThen run /spec-green-start in your agent. Run it again whenever it asks you to: it always continues where the project is.\n`;

// ---------- status: phases, the one next action, what blocks it ----------
const step = (phase, name, doText, o = {}) => ({ phase, step: name, do: doText, run: o.run || null, agent: o.agent !== false, human: o.human || null, problems: o.problems || [], blocked_by: o.blocked || [] });
const run = (c) => `${VT} ${c}`;
const capLine = (c) => `${c.cap} (${c.kind}, ${c.priority})`;
function phaseInputs(root) {
  const f = inputFiles(root);
  if (!f.length) return step('Inputs', 'add-inputs', 'Put the client material (briefs, requirements, API docs, sample data, notes of calls) into openspec/inputs/. Read openspec/inputs/README.md first. Then run /spec-green-start again.', { agent: false, human: 'analyst', blocked: [{ kind: 'inputs', who: 'analyst', text: 'client material in openspec/inputs/' }] });
  return null;
}
function phaseQuestions(root) {
  const P_ = 'Questions'; const caps = capabilities(root); const exp = exploration(root);
  const secs = exp === null ? EXPLORATION_SECTIONS : EXPLORATION_SECTIONS.filter((re) => !String(exp).split('\n').some((l) => /^##\s/.test(l) && re.test(l.replace(/^##\s+/, ''))));
  if (exp === null) return step(P_, 'explore', `Run the whole-product exploration: read openspec/inputs/, interview the analyst with a grilling interview (one question at a time) until the users and what they need, capabilities, integrations and risks are clear. Create the exploration note with \`${run('greenfield new exploration')}\` and fill it in. Write one file per capability or integration with \`${run('greenfield new capability <name> [--integration]')}\`.`, { run: run('greenfield new exploration') });
  if (secs.length || !caps.length) return step(P_, 'finish-exploration', 'Finish the exploration note and the capability files.', { problems: [...(secs.length ? ['openspec/greenfield/exploration.md lacks sections: Capability map, Integration inventory'] : []), ...(!caps.length ? ['no capability file in openspec/greenfield/capabilities/'] : [])], run: run('greenfield new capability <name> [--integration]') });
  const qs = questions(root); const missing = Object.keys(TOPICS).filter((t) => !qs.some((q) => q.topic === t));
  if (missing.length) return step(P_, 'create-questions', `Create the fixed question files (one per topic). This writes only the files that do not exist yet.`, { run: run('greenfield new questions'), problems: missing.map((t) => `topic ${t}`) });
  const open = qs.filter((q) => q.status === 'open'); const asked = qs.filter((q) => q.blocking && q.status === 'asked');
  if (open.length) return step(P_, 'answer-questions', 'Work through the open questions one by one. If openspec/inputs/ answers it: write the answer and cite the file (status: answered). If not: ask the client; set status: asked while you wait. If the client cannot answer yet and work can continue: status: assumed plus an assumption file. Not applicable: status: n/a with a reason.', { problems: open.map((q) => `${q.id} (${q.topic}) is open`), run: run('greenfield new assumption <slug> --from Q-<topic>'), blocked: [] });
  const noA = qs.filter((q) => q.status === 'assumed' && !assumptions(root).some((a) => a.from === q.id)); const badA = assumptions(root).filter((a) => a.bad.length);
  if (noA.length || badA.length) return step(P_, 'write-assumptions', 'Every assumed question needs an assumption with an owner, a verification point and a re-plan trigger.', { run: run('greenfield new assumption <slug> --from Q-<topic>'), problems: [...noA.map((q) => `${q.id} is assumed but has no assumption file`), ...badA.map((a) => `${a.id}: fill in ${a.bad.join(', ')}`)] });
  if (asked.length) return step(P_, 'wait-for-client', 'Send the questions below to the client (a short list, one line each, with the owner). When the answers arrive, write them into the question files (status: answered) and run /spec-green-start again.', { agent: false, human: 'client', problems: asked.map((q) => `${q.id} (${q.topic}): ${q.answer ? q.answer.slice(0, 60) : TOPICS[q.topic].slice(0, 60)}`), blocked: asked.map((q) => ({ kind: 'client-answer', who: q.owner, id: q.id, text: `${q.id} (${q.topic})` })) });
  if (!environments(root).some((e) => !PLACEHOLDER.test(String(e.data.access || '')) && list(e.data.roles).length)) return step(P_, 'write-environments', `Write down where it will run: \`${run('greenfield new environment <name>')}\` (staging, production, ...), then fill in who provides access, which secrets are needed (names only, never values) and which roles or test accounts exist. Use what the client said under Q-environments.`, { run: run('greenfield new environment <name>') });
  const us = understoodState(root);
  if (!us.exists || us.problems.length) return step(P_, 'write-understood', `Write the one-page summary the client will approve: \`${run('greenfield new understood')}\` creates the template. Plain words, at most 80 lines, no jargon; it must mention every capability, assumption and open question by id.`, { run: us.exists ? null : run('greenfield new understood'), problems: us.problems });
  if (!us.approved) return step(P_, 'approve-understood', `Give openspec/greenfield/understood.md to the client. When they agree, record it with \`${run('greenfield approve understood --by "<client name>"')}\`. Changing the page or the capabilities afterwards makes the approval stale.`, { agent: false, human: 'client', run: run('greenfield approve understood --by "<client name>"'), problems: us.stale ? ['the approval is stale: the page changed after it'] : [], blocked: [{ kind: 'approval', who: 'client', text: 'approval of "what we understood"' }] });
  return null;
}
function phaseFoundation(root) {
  const ready = !activeExists(root, 'foundation') && livingSpec(root, NFR_CAP) && T.livingRequirements(root).size && glossaryTerms(root).length >= 3 && adrFiles(root).length;
  if (ready) return null;
  const cs = changeState(root, 'foundation');
  const arch = archivedChanges(root).some((n) => /-foundation$/.test(n));
  if (arch && !activeExists(root, 'foundation')) return step('Foundation', 'repair-foundation', 'The foundation was archived but is incomplete. Amend it with a new spec-only change (/spec-propose foundation-fix).', { problems: [!livingSpec(root, NFR_CAP) && `openspec/specs/${NFR_CAP}/spec.md missing`, !T.livingRequirements(root).size && 'no requirements', glossaryTerms(root).length < 3 && 'glossary has fewer than 3 terms', !adrFiles(root).length && 'no ADR'].filter(Boolean) });
  if (cs.exists && livingSpec(root, NFR_CAP)) return step('Foundation', 'archive-foundation', `The foundation is synced. Archive it: ${VT} archive foundation.`, { run: run('archive foundation') });
  if (!cs.exists) return step('Foundation', 'propose-foundation', `Create the spec-only change "foundation" (/spec-propose foundation, proposal line "Kind: spec-only"): the ${NFR_CAP} capability with measurable targets, the fixed ADRs (technology, hosting, auth, integration style), and openspec/glossary.md. No code tasks: tasks.md is one ticked line.`, { run: `openspec new change foundation --schema wingman-spec` });
  if (!cs.complete) return step('Foundation', 'finish-foundation', 'Finish the foundation change.', { problems: [...cs.missing.map((m) => `missing ${m}`), ...cs.problems] });
  return step('Foundation', 'sync-foundation', `Sync and archive the foundation: /spec-sync foundation (verify-task.cjs sync foundation), then ${VT} archive foundation.`, { run: run('sync foundation') });
}
function phaseCapabilities(root) {
  const caps = capabilities(root); const doneN = caps.filter((c) => livingSpec(root, c.cap) && !activeExists(root, c.cap)).length;
  const c = caps.find((x) => !(livingSpec(root, x.cap) && !activeExists(root, x.cap)));
  if (!c) return null; const idx = doneN + 1; const where = `capability ${idx} of ${caps.length}: ${c.cap}`;
  const tpl = c.kind === 'integration' ? ` It is an integration: write the contract (use schemas/wingman-spec/templates/integration-contract.md), a sandbox in ${path.posix.join('openspec/greenfield/capabilities', c.cap + '.md')}, and at least 2 "Failure:" scenarios.` : '';
  if (activeExists(root, c.cap) && livingSpec(root, c.cap)) return step('Capabilities', 'archive-capability', `The ${c.cap} spec is synced. Archive the change: ${VT} archive ${c.cap}.`, { run: run(`archive ${c.cap}`), problems: [where] });
  const cs = changeState(root, c.cap, c.cap);
  if (c.kind === 'integration' && (!c.sandbox || PLACEHOLDER.test(c.sandbox))) return step('Capabilities', 'describe-sandbox', `Integration ${c.cap} needs a sandbox first: write it in openspec/greenfield/capabilities/${c.cap}.md (test endpoint, sample data, who provides access). If there is none yet, ask the client.`, { problems: [where], human: null });
  if (!cs.exists) return step('Capabilities', 'propose-capability', `Create the spec-only change "${c.cap}" (/spec-propose ${c.cap}, proposal line "Kind: spec-only"): requirements with WHEN/THEN scenarios and a "Why:" line on each (who wants it, and why). No code tasks.${tpl}`, { run: `openspec new change ${c.cap} --schema wingman-spec`, problems: [where] });
  if (!cs.complete) return step('Capabilities', 'finish-capability', `Finish the ${c.cap} change.`, { problems: [where, ...cs.missing.map((m) => `missing ${m}`), ...cs.problems] });
  return step('Capabilities', 'sync-capability', `Sync the ${c.cap} change: ${VT} sync ${c.cap}, then ${VT} archive ${c.cap}.`, { run: run(`sync ${c.cap}`), problems: [where] });
}
function phaseReview(root) {
  const rv = reviewOf(root, 'spec'); const so = signoffOf(root);
  if (!rv || !rv.current) return step('Review', 'review-spec', `Get an independent review of the whole spec. Build the packet with \`${run('greenfield review spec --packet')}\`, give it to the spec-reviewer subagent (a different agent from the one that wrote the specs), save its reply to a file and record it with \`${run('greenfield review spec --reply <file>')}\`. The writer never reviews its own spec.`, { run: run('greenfield review spec --packet'), problems: rv && !rv.current ? ['the specs changed after the last review'] : [] });
  if (rv.verdict === 'fail') return step('Review', 'fix-review-findings', `Fix the findings of the review with spec-only change(s) (/spec-propose <capability>), sync them, then review again. Findings are in openspec/greenfield/reviews/spec.md.`, { problems: String(rv.body).split('\n').filter((l) => /^-\s+(blocker|major)\b/i.test(l)).slice(0, 12) });
  if (!so || !so.current) return step('Review', 'signoff-spec', `Give the reviewed spec to the client (openspec/specs, openspec/glossary.md, adr/). When they sign off: \`${run('greenfield approve spec --by "<client name>"')}\`.`, { agent: false, human: 'client', run: run('greenfield approve spec --by "<client name>"'), problems: so && !so.current ? ['the specs changed after the sign-off'] : [], blocked: [{ kind: 'approval', who: 'client', text: 'sign-off of the reviewed spec' }] });
  return null;
}
function phaseRoadmap(root) {
  const rm = roadmap(root);
  if (!rm.slices.length) return step('Roadmap', 'plan', 'Run /spec-green-plan: split the finished spec into ordered slices (a thin end-to-end walking skeleton first, risky integrations early, one file per slice in openspec/roadmap/). Then run the roadmap check.', { run: run('roadmap'), problems: [] });
  if (!rm.ok) return step('Roadmap', 'fix-roadmap', 'Fix the roadmap errors (edit the slice files in openspec/roadmap/).', { problems: rm.errors.map((e) => e.text), run: run('roadmap') });
  const pr = reviewOf(root, 'plan'); const dr = reviewOf(root, 'dryrun');
  if (!pr || !pr.current) return step('Roadmap', 'review-plan', `Get an independent review of the plan: \`${run('greenfield review plan --packet')}\`, spec-reviewer subagent, then \`${run('greenfield review plan --reply <file>')}\`.`, { run: run('greenfield review plan --packet') });
  if (pr.verdict === 'fail') return step('Roadmap', 'fix-plan-findings', 'Fix the plan review findings (openspec/greenfield/reviews/plan.md), then review again.', { problems: String(pr.body).split('\n').filter((l) => /^-\s+(blocker|major)\b/i.test(l)).slice(0, 12) });
  if (!dr || !dr.current) return step('Roadmap', 'dry-run', `Implementability dry-run: a reviewer who sees only the openspec/ files lists what a developer could not decide for the first 2 slices. \`${run('greenfield review dryrun --packet')}\`, spec-reviewer subagent, then \`${run('greenfield review dryrun --reply <file>')}\`.`, { run: run('greenfield review dryrun --packet') });
  if (dr.verdict === 'blocked') { const u = String(dr.body).split('\n').filter((l) => /^-\s+blocker\b/i.test(l)); return step('Roadmap', 'resolve-unknowns', 'The dry-run found blocking unknowns. Ask the client (or write an owned assumption), amend the specs or slices, then run the dry-run again.', { human: 'client', problems: u.slice(0, 12), blocked: u.slice(0, 12).map((x) => ({ kind: 'client-answer', who: 'client', text: x.replace(/^-\s+blocker\s*\|?\s*/i, '') })) }); }
  return null;
}
function handoverState(root) {
  const h = fm(read(G(root, 'handover.md'))); if (!h.has) return null;
  return { rev: Number(h.data.rev || 1), current: h.data.spec_hash === specHash(root) && h.data.plan_hash === planHash(root) };
}
function phaseHandover(root) {
  const g = gate(root);
  if (!g.ready) { const f = g.missing[0]; return step('Handover', 'fix-gate', `The handover gate has ${g.missing.length} open item(s). First: ${f.fix}`, { problems: g.missing.flatMap((m) => [`${m.text}:`, ...m.detail.slice(0, 6).map((d) => `  ${d}`)]) }); }
  const h = handoverState(root);
  if (!h || !h.current) return step('Handover', 'write-handover', `Everything is in place. Write the manifest: \`${run('handover --write')}\`.`, { run: run('handover --write'), problems: h && !h.current ? ['the manifest is stale (specs or plan changed)'] : [] });
  return null;
}
const EVALS = [phaseInputs, phaseQuestions, phaseFoundation, phaseCapabilities, phaseReview, phaseRoadmap, phaseHandover];
function derive(root) {
  const m = modeOf(root); const out = { mode: m.mode, marker: m.marker, phases: [], ready: false, phase: null, step: null, next: null, blocked_by: [], done: [] };
  if (m.mode === 'implementation') {
    const rm = roadmap(root); out.phase = 'Implementation'; out.step = 'build'; out.counts = rm.counts; out.next_up = rm.next_up;
    out.done.push(`handover accepted; slices: ${rm.counts.done} done, ${rm.counts.applying + rm.counts.proposed} in progress, ${rm.counts.planned} planned`);
    out.next = { action: rm.next_up.length ? 'next-slice' : 'finish', do: rm.next_up.length ? `Run /spec-green-next (next slice: ${rm.next_up[0]}). Greenfield commands are read-only now; amend specs with /spec-propose.` : 'All slices are done. Check the remaining drift with /spec-garden.', run: null, agent: true, human: null, problems: [] };
    return out;
  }
  if (m.mode === 'brownfield' || m.mode === 'greenfield') { out.phase = null; out.step = m.mode === 'greenfield' ? 'confirm-start' : 'refused'; out.mode_info = m; return out; }
  let cur = null;
  PHASES.forEach((name, i) => { const s = cur ? null : EVALS[i](root); if (s) { cur = s; out.phases.push({ name, state: 'current' }); } else out.phases.push({ name, state: cur ? 'todo' : 'done' }); });
  if (!cur) { out.ready = true; out.phase = 'Handover'; out.step = 'ready'; const h = handoverState(root); out.next = { action: 'send', do: 'Send the repository (openspec/, adr/, handover.md) to the development team. They run /spec-green-next.', run: null, agent: false, human: 'analyst', problems: [] }; out.done = [`handover manifest rev ${h.rev}`]; out.manifest = 'openspec/greenfield/handover.md'; return out; }
  out.phase = cur.phase; out.step = cur.step; out.next = { action: cur.step, do: cur.do, run: cur.run, agent: cur.agent, human: cur.human, problems: cur.problems };
  out.blocked_by = cur.blocked_by;
  const caps = capabilities(root); const doneC = caps.filter((c) => livingSpec(root, c.cap) && !activeExists(root, c.cap)).length;
  out.done = out.phases.filter((p) => p.state === 'done').map((p) => p.name);
  if (cur.phase === 'Capabilities' || out.phases[3].state === 'done') out.progress = `capabilities ${doneC} of ${caps.length}`;
  out.counts = { questions_open: questions(root).filter((q) => q.status === 'open' || q.status === 'asked').length, capabilities: caps.length, slices: readSlices(root).length };
  return out;
}
function statusText(st, m) {
  const L = [];
  if (st.ready) L.push('READY FOR HANDOVER');
  if (st.step === 'refused' || st.step === 'confirm-start') return null;
  if (st.phase) L.push(`Phase: ${st.phase}${st.phases.length ? ` (${Math.max(1, st.phases.findIndex((p) => p.state === 'current') + 1 || 7)} of 7)` : ''}   Step: ${st.step}${st.progress ? `   [${st.progress}]` : ''}`);
  if (st.phases.length) L.push(`Phases: ${st.phases.map((p) => `${p.state === 'done' ? '[x]' : p.state === 'current' ? '[>]' : '[ ]'} ${p.name}`).join('  ')}`);
  L.push('');
  if (st.next && st.next.problems && st.next.problems.length) { L.push('Details:'); for (const p of st.next.problems.slice(0, 14)) L.push(`  - ${p}`); if (st.next.problems.length > 14) L.push(`  - ... ${st.next.problems.length - 14} more`); L.push(''); }
  L.push(`Done: ${st.done.length ? st.done.join('; ') : 'nothing yet'}`);
  L.push(`Next: ${st.next ? st.next.do : '-'}${st.next && st.next.run ? `\n      run: ${st.next.run}` : ''}${st.next && st.next.human ? `\n      needs a person: ${st.next.human}` : ''}`);
  L.push(`Blocked by: ${st.blocked_by.length ? st.blocked_by.map((b) => `${b.text}${b.who ? ` (${b.who})` : ''}`).join('; ') : 'nothing'}`);
  return L.join('\n');
}

// ---------- review packets and replies ----------
const RUBRIC = {
  spec: ['Every requirement has a Why that names who wants it and why, and WHEN/THEN scenarios a tester can run.', 'No vague words in requirements or scenarios ("fast", "user-friendly", "appropriate", "etc."): each has a number or an observable result.', 'Every integration has a contract (fields, auth, limits) and failure scenarios (timeout, rejection, duplicate); sandbox data is named.', 'NFRs are measurable; terms match openspec/glossary.md; no two capabilities contradict each other.', 'Nothing is left for the developer to guess: no missing roles, states, error texts, limits, or data rules. No implementation instructions in the specs.', 'Every decision the client has not made is an owned assumption, not a silent default.', 'Every UI-facing requirement (screen, form, control, visual scenario) has its proposal\'s UX checklist answered: loading, empty, error, disabled, validation, recovery, keyboard, narrow and long-text each name an existing scenario or give a `Not applicable:` reason specific to that screen.'],
  plan: ['The first slice is a thin end-to-end walking skeleton that proves the architecture and the riskiest integration path.', 'Risky integrations and unknowns come early; nothing risky is left for the last slices.', 'Each slice is small enough for one agent session (S/M), independently demonstrable, with acceptance criteria that name an observable result.', 'Dependencies are real (not just a list order); slices that can run in parallel are not chained.', 'Every requirement is covered exactly once; later slices do not secretly redo earlier ones.', 'Assumptions with a re-plan trigger map to the slices they would affect.'],
  dryrun: ['Pretend you are a developer who has only the openspec/ files and the first two slices in order (the walking skeleton and the next).', 'List everything you could not decide or build without asking: missing data, unclear rules, undefined errors, unknown credentials or accounts, ambiguous terms.', 'Mark UNKNOWN: blocker when you could not start or finish the slice; minor when you could proceed with a reasonable default (say which).'],
};
function packet(root, kind) {
  const s = derive(root); const g = gate(root); const rm = g.roadmap;
  const rel = (p) => path.relative(root, p);
  const L = [`# ${kind === 'spec' ? 'Independent spec review' : kind === 'plan' ? 'Independent plan review' : 'Implementability dry-run'}`, '', 'You are the spec-reviewer subagent. You did not write these files. Read only; change nothing. Judge only what is written; do not assume the intent of the author.', '', '## Read these', '- openspec/greenfield/understood.md (what the client approved)', '- openspec/specs/*/spec.md', '- openspec/glossary.md and adr/*.md'];
  if (kind !== 'spec') L.push('- openspec/roadmap/*.md (the slices)');
  L.push('- openspec/greenfield/capabilities/*.md, records/*.md (questions Q-, assumptions A-, environments ENV-)', '', '## The project', `Capabilities: ${capabilities(root).map(capLine).join('; ')}`);
  if (kind !== 'spec') L.push(`Slices in order: ${rm.order.join(' -> ') || 'none'}`);
  if (kind === 'dryrun') L.push(`The first two slices: ${rm.order.slice(0, 2).join(', ')}`);
  L.push('', '## Check', ...RUBRIC[kind].map((r) => `- ${r}`), '', '## Deterministic checks already run (do not repeat them; look for what they cannot see)', ...g.items.slice(0, kind === 'spec' ? 12 : 99).map((i) => `- [${i.ok ? 'ok' : 'open'}] ${i.text}`), '');
  L.push('## Reply in exactly this format, nothing else', '```');
  if (kind === 'dryrun') L.push('VERDICT: pass|blocked', 'UNKNOWN: blocker|minor | <slice id> | <what you could not decide or build> | <what is needed, from whom>');
  else L.push('VERDICT: pass|fail', 'SCORE: <0-100; 80 or more only if you would hand this to a developer team>', 'FINDING: blocker|major|minor | <file or capability/requirement> | <what is wrong and what it should say>');
  L.push('```', 'One line per finding. Quote the file. Fewer than 3 findings means you did not look hard enough: look again for vague words, missing failure cases, undefined roles.');
  return L.join('\n') + '\n';
}
function parseReply(text, kind) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());
  const v = lines.map((l) => l.match(/^VERDICT:\s*(pass|fail|blocked)\b/i)).find(Boolean);
  if (!v) return { error: 'the reply has no "VERDICT: pass|fail" line (dry-run: pass|blocked)' };
  const sc = lines.map((l) => l.match(/^SCORE:\s*(\d{1,3})\b/i)).find(Boolean);
  if (kind !== 'dryrun' && !sc) return { error: 'the reply has no "SCORE: <0-100>" line' };
  const items = []; const tag = kind === 'dryrun' ? 'UNKNOWN' : 'FINDING';
  for (const l of lines) { const m = l.match(new RegExp(`^${tag}:\\s*(blocker|major|minor)\\s*\\|\\s*(.*?)\\s*\\|\\s*(.+)$`, 'i')); if (m) items.push({ sev: m[1].toLowerCase(), where: m[2], what: m[3] }); }
  const blockers = items.filter((i) => i.sev === 'blocker').length; const majors = items.filter((i) => i.sev === 'major').length;
  const score = sc ? Number(sc[1]) : null; let verdict = v[1].toLowerCase();
  if (kind === 'dryrun') verdict = verdict === 'pass' && !blockers ? 'pass' : 'blocked';
  else verdict = verdict === 'pass' && !blockers && score >= 80 ? 'pass' : 'fail';
  return { verdict, score, blockers, majors, items };
}
function writeReview(root, kind, rec) {
  const dir = G(root, 'reviews'); fs.mkdirSync(dir, { recursive: true });
  const old = fm(read(path.join(dir, `${kind}.md`))); const rounds = Number(old.data.rounds || 0) + 1;
  const hash = kind === 'spec' ? specHash(root) : planHash(root);
  const head = ['---', `kind: ${kind}`, `verdict: ${rec.verdict}`, ...(rec.score !== null && rec.score !== undefined ? [`score: ${rec.score}`] : []), `blockers: ${rec.blockers || 0}`, `majors: ${rec.majors || 0}`, `reviewer: ${rec.reviewer}`, ...(rec.reason ? [`reason: ${String(rec.reason).replace(/\n/g, ' ')}`] : []), `rounds: ${rounds}`, `hash: ${hash}`, `date: ${today()}`, '---', ''];
  const body = rec.items && rec.items.length ? rec.items.map((i) => `- ${i.sev} | ${i.where} | ${i.what}`).join('\n') + '\n' : rec.reason ? `Waived: ${rec.reason}\n` : 'No findings.\n';
  fs.writeFileSync(path.join(dir, `${kind}.md`), head.join('\n') + body);
  return { rounds, hash };
}

// ---------- the manifest ----------
function writeHandover(root, g, by) {
  const so = signoffOf(root) || {}; const rm = g.roadmap; const old = fm(read(G(root, 'handover.md')));
  const rev = Number(old.data.rev || 0) + 1; const caps = capabilities(root); const reqs = T.livingRequirements(root);
  const rv = reviewOf(root, 'spec'); const pr = reviewOf(root, 'plan'); const dr = reviewOf(root, 'dryrun');
  const L = ['---', `rev: ${rev}`, `date: ${today()}`, `spec_hash: ${specHash(root)}`, `plan_hash: ${planHash(root)}`, '---', '# Handover', '',
    'Everything the development team needs is in this repository. Start with /spec-green-next.', '',
    '## What is delivered', `- Capabilities: ${caps.length} (${caps.filter((c) => c.kind === 'integration').length} integrations); requirements: ${reqs.size}; slices: ${rm.order.length}; ADRs: ${adrFiles(root).length}; glossary terms: ${glossaryTerms(root).length}`,
    '- openspec/specs/ (the end-state spec), adr/, openspec/glossary.md, openspec/roadmap/ (ordered slices), openspec/greenfield/ (records: questions, assumptions, environments; reviews)', '',
    '## Records', `- Client approval of the summary: ${(fm(read(G(root, 'understood.md'))).data.approved_by) || '-'}, ${(fm(read(G(root, 'understood.md'))).data.approved_on) || '-'}`,
    `- Spec review: ${rv ? `${rv.verdict}${rv.score ? `, score ${rv.score}` : ''}, ${rv.rounds || 1} round(s), ${rv.date}` : '-'}`, `- Spec sign-off: ${so.approved_by || '-'}, ${so.approved_on || '-'}`,
    `- Plan review: ${pr ? `${pr.verdict}${pr.score ? `, score ${pr.score}` : ''}, ${pr.date}` : '-'}`, `- Implementability dry-run: ${dr ? `${dr.verdict}, ${dr.date}` : '-'}`, ...g.warnings.map((w) => `- Note: ${w}`), '',
    '## Roadmap', '| # | slice | size | milestone | depends on | requirements |', '|---|---|---|---|---|---|', ...rm.slices.map((s, i) => `| ${i + 1} | ${s.id}${s.skeleton ? ' (skeleton)' : ''} | ${s.size} | ${s.milestone} | ${s.depends_on.join(', ') || '-'} | ${s.requirements} |`), '',
    '## Traceability (slice -> requirement -> code)', 'Code is linked to requirements by the anchors the dev team writes; `verify-task.cjs drift` shows what is not built yet.', '| slice | requirement | why |', '|---|---|---|', ...Object.entries(rm.trace).flatMap(([id, rs]) => (rs.length ? rs : [{ key: '-', why: '' }]).map((r) => `| ${id} | ${r.key} | ${r.why || '-'} |`)), '',
    '## Open assumptions', ...(assumptions(root).filter((a) => a.status === 'open').map((a) => `- ${a.id}: owner ${a.owner}; verify ${a.verify_by}; if false: ${a.replan_trigger}`)), ...(assumptions(root).some((a) => a.status === 'open') ? [] : ['- none']), '',
    '## Open questions (not blocking)', ...(questions(root).filter((q) => !q.blocking && (q.status === 'open' || q.status === 'asked')).map((q) => `- ${q.id}: owner ${q.owner}; ${String(q.body.match(/## Question\n([\s\S]*?)\n\n/) ? q.body.match(/## Question\n([\s\S]*?)\n\n/)[1] : '').replace(/\s+/g, ' ').slice(0, 160)}`)), ...(questions(root).some((q) => !q.blocking && (q.status === 'open' || q.status === 'asked')) ? [] : ['- none']), '',
    '## Change control', '- Later changes go through /spec-propose (amend); a change that rewrites the Why of a requirement or removes a requirement needs the owner\'s approval.', '- If an assumption turns out false, follow its re-plan trigger, then re-run `verify-task.cjs handover --write`.', ''];
  fs.writeFileSync(G(root, 'handover.md'), L.join('\n')); return rev;
}

// ---------- commands ----------
function parseOpts(args) {
  const o = { _: [], flags: new Set() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (['--by', '--root', '--reply', '--reviewer', '--reason', '--out', '--from', '--for', '--text'].includes(a)) { o[a.slice(2)] = args[++i]; if (o[a.slice(2)] === undefined) usage(`${a} needs a value`); }
    else if (a.startsWith('--')) o.flags.add(a.slice(2)); else o._.push(a);
  }
  return o;
}
function usage(msg) { process.stderr.write(`${msg}\nusage: verify-task.cjs mode [--for CMD] | greenfield status|start|new|approve|review|readme ... | roadmap [--next] | handover [--write]  (add --json for machine output)\n`); process.exit(2); }
process.stdout.on('error', (e) => { if (e.code === 'EPIPE') process.exit(0); throw e; });
const out = (s) => process.stdout.write(`${s}\n`);
function refuse(m, cmd, json) {
  const r = refusal(m, cmd);
  if (json) out(JSON.stringify(r, null, 2));
  else { out(`REFUSED: ${{ start: '/spec-green-start', status: '/spec-green-start', plan: '/spec-green-plan', next: '/spec-green-next', adopt: '/spec-adopt' }[cmd] || cmd} (project mode: ${m.mode}). Nothing was written.`); for (const w of r.why) out(`  ${w}`); if (m.mode === 'greenfield') out('  This repository has not been started as a new product yet. Run /spec-green-start: it asks you to confirm once (a new product has no code yet).'); else out(`  ${r.alternative}`); }
  process.exit(EXIT_REFUSED);
}
const guard = (root, cmd, o) => { const m = modeOf(root); if (!allowed(m.mode, cmd)) refuse(m, cmd, o.flags.has('json')); return m; };
const GUARD_FOR = { read: ['greenfield-in-progress', 'implementation'], write: ['greenfield-in-progress'] };
function guardKind(root, kind, o) { const m = modeOf(root); if (!GUARD_FOR[kind].includes(m.mode)) refuse(m, kind === 'write' ? 'plan' : 'next', o.flags.has('json')); return m; }

function cmdMode(root, o) {
  const m = modeOf(root); const lay = layoutOf(root, {});
  if (lay.workspace) { const r = { mode: 'unsupported-layout', refused: true, alternative: ALTERNATIVE.unsupported, wrote: 'nothing' }; out(o.flags.has('json') ? JSON.stringify(r, null, 2) : `mode: unsupported-layout\n${ALTERNATIVE.unsupported}`); process.exit(o.for ? EXIT_REFUSED : 0); }
  if (o.for) { const cmd = String(o.for).replace(/^\/?spec-/, ''); if (!FOR[cmd]) usage(`unknown command '${o.for}' (one of ${Object.keys(FOR).join(', ')})`); if (!allowed(m.mode, cmd)) refuse(m, cmd, o.flags.has('json')); }
  if (o.flags.has('json')) out(JSON.stringify({ ...m, allowed: o.for ? true : undefined }, null, 2));
  else { out(`mode: ${m.mode}${m.marker_missing ? ' (openspec/greenfield.yaml is missing; /spec-green-start will restore it)' : ''}`); for (const s of m.signals) out(`  ${s.kind}: ${s.detail}`); if (o.for) out(`allowed: /${o.for}`); }
}
function cmdStart(root, o) {
  const m = guard(root, 'start', o);
  if (m.marker) { out(`already started (${m.mode}); nothing changed. Run: verify-task.cjs greenfield status`); return; }
  const by = (o.by || '').trim();
  if (!o.flags.has('yes')) { out(`dry run. This would mark ${root} as a NEW product (no existing code, specs written from requirements): it writes openspec/greenfield.yaml and openspec/inputs/README.md and nothing else.\nConfirm with the analyst that this is a new product, then re-run with: greenfield start --by "<analyst name>" --yes`); return; }
  if (by.length < 2) usage('start needs --by "<analyst name>"');
  fs.mkdirSync(P(root, 'openspec/inputs'), { recursive: true }); fs.mkdirSync(G(root), { recursive: true });
  fs.writeFileSync(MARKER(root), `# Marks this repository as a new product (greenfield). Written once, after the analyst confirmed it. Do not delete.\nschema: wingman-spec\nmode: greenfield\nstarted: ${today()}\nconfirmed_by: ${by}\n`);
  if (!fs.existsSync(P(root, 'openspec/inputs/README.md'))) fs.writeFileSync(P(root, 'openspec/inputs/README.md'), INPUTS_README);
  out('started: wrote openspec/greenfield.yaml and openspec/inputs/README.md. Next: put the client material into openspec/inputs/, then run /spec-green-start.');
}
function cmdReadme(root, o) {
  const m = modeOf(root); if (!['greenfield', 'greenfield-in-progress'].includes(m.mode)) { out(`not a greenfield project (${m.mode}); nothing written`); return; }
  const f = P(root, 'openspec/inputs/README.md'); if (fs.existsSync(f)) { out('openspec/inputs/README.md exists; unchanged'); return; }
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, INPUTS_README); out('wrote openspec/inputs/README.md');
}
function cmdStatus(root, o) {
  const m = guard(root, 'status', o); const st = derive(root); st.mode_signals = m.signals;
  if (o.flags.has('json')) { out(JSON.stringify(st, null, 2)); return; }
  if (st.step === 'confirm-start') {
    out('Phase: not started   Step: confirm-start\n');
    out('Done: nothing yet\nNext: Ask the analyst: "Is this a NEW product with no existing code, and are we writing its specification from requirements?" If yes, run:\n      run: node openspec/scripts/verify-task.cjs greenfield start --by "<analyst name>" --yes\n      needs a person: analyst\nBlocked by: the analyst\'s confirmation'); return;
  }
  out(statusText(st));
}
function slugOk(n, what) { if (!/^[a-z0-9][a-z0-9-]*$/.test(n || '')) usage(`${what} must be kebab-case (a-z, 0-9, -): got '${n || ''}'`); return n; }
function writeNew(file, text) { if (fs.existsSync(file)) { out(`exists, not overwritten: ${file}`); return false; } fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); out(`created ${file}`); return true; }
function cmdNew(root, o) {
  guardKind(root, 'write', o); const [kind, name] = o._;
  const rel = (p) => path.relative(root, p);
  const w = (p, t) => { const f = path.join(root, p); const had = fs.existsSync(f); writeNew(f, t); return !had; };
  switch (kind) {
    case 'exploration': w('openspec/greenfield/exploration.md', TEMPLATES.exploration()); break;
    case 'understood': w('openspec/greenfield/understood.md', TEMPLATES.understood()); break;
    case 'questions': for (const t of Object.keys(TOPICS)) w(`openspec/greenfield/${RECORDS}/Q-${t}.md`, TEMPLATES.question(t)); break;
    case 'question': slugOk(name, 'question topic'); w(`openspec/greenfield/${RECORDS}/Q-${name}.md`, TEMPLATES.question(name, o.text)); break;
    case 'assumption': slugOk(name, 'assumption slug'); w(`openspec/greenfield/${RECORDS}/A-${name}.md`, TEMPLATES.assumption(name, o.from)); break;
    case 'capability': slugOk(name, 'capability name'); w(`openspec/greenfield/capabilities/${name}.md`, TEMPLATES.capability(name, o.flags.has('integration') ? 'integration' : 'capability')); break;
    case 'environment': slugOk(name, 'environment name'); w(`openspec/greenfield/${RECORDS}/ENV-${name}.md`, TEMPLATES.environment(name)); break;
    case 'slice': slugOk(name, 'slice id'); w(`openspec/roadmap/${name}.md`, TEMPLATES.slice(name)); break;
    default: usage('new <exploration|understood|questions|question <topic> [--text "..."]|assumption <slug> [--from Q-x]|capability <name> [--integration]|environment <name>|slice <id>>');
  }
}
function cmdApprove(root, o) {
  guardKind(root, 'write', o); const what = o._[0]; const by = (o.by || '').trim(); if (by.length < 2) usage('approve needs --by "<name of the person who approved>"');
  if (what === 'understood') {
    const us = understoodState(root); if (!us.exists || us.problems.length) { out('not approved: fix the page first'); for (const p of us.problems) out(`  - ${p}`); process.exit(1); }
    const open = questions(root).filter((q) => q.blocking && (q.status === 'open' || q.status === 'asked')); if (open.length) { out(`not approved: blocking question(s) still open: ${open.map((q) => q.id).join(', ')}`); process.exit(1); }
    const f = G(root, 'understood.md'); fs.writeFileSync(f, setFm(read(f), { approved_by: by, approved_on: today(), approved_hash: us.hash })); out(`recorded: "what we understood" approved by ${by}`); return;
  }
  if (what === 'spec') {
    const rv = reviewOf(root, 'spec'); if (!rv || !rv.current || !['pass', 'waived'].includes(rv.verdict)) { out('not signed off: the spec needs a current passing review first (run /spec-green-start)'); process.exit(1); }
    const g = gate(root); const blocking = g.missing.filter((i) => ['understood', 'questions', 'requirements', 'capabilities', 'integrations', 'nfr', 'glossary', 'adrs', 'no-secrets', 'assumptions'].includes(i.id));
    if (blocking.length) { out('not signed off: the spec has open gate items'); for (const b of blocking) out(`  - ${b.text}: ${b.detail[0] || ''}`); process.exit(1); }
    fs.mkdirSync(G(root), { recursive: true }); fs.writeFileSync(G(root, 'signoff.md'), `---\nspec_hash: ${specHash(root)}\napproved_by: ${by}\napproved_on: ${today()}\nreview: ${rv.verdict}${rv.score ? ` (score ${rv.score})` : ''}\n---\nThe client signed off the reviewed specification (openspec/specs, glossary, ADRs, capability files). A later change to any of them makes this sign-off stale.\n`);
    out(`recorded: spec signed off by ${by}`); return;
  }
  usage('approve <understood|spec> --by "<name>"');
}
function cmdReview(root, o) {
  const kind = o._[0]; if (!['spec', 'plan', 'dryrun'].includes(kind)) usage('review <spec|plan|dryrun> --packet [--out FILE] | --reply FILE | --reviewer none --reason TEXT');
  if (o.flags.has('packet')) {
    guardKind(root, 'read', o); const t = packet(root, kind);
    if (o.out) { const f = path.isAbsolute(o.out) ? o.out : path.join(root, o.out); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t);
      const runs = P(root, 'openspec/.apply-runs'); if (f.startsWith(runs + path.sep) && !fs.existsSync(path.join(runs, '.gitignore'))) fs.writeFileSync(path.join(runs, '.gitignore'), '*\n'); // run logs and packets are never committed
      out(`wrote ${path.relative(root, f)} (give this file to the spec-reviewer subagent; it is not committed)`); } else process.stdout.write(t);
    return;
  }
  guardKind(root, 'write', o);
  if (o.reviewer === 'self') { out('refused: the agent that wrote the spec cannot review it; use the spec-reviewer subagent, or --reviewer none --reason "<why>" to record a waiver'); process.exit(1); }
  if (o.reviewer === 'none') { if (!o.reason || o.reason.trim().length < 10) usage('--reviewer none needs --reason "<why, at least 10 characters>"'); const r = writeReview(root, kind, { verdict: 'waived', reviewer: 'none', reason: o.reason }); out(`recorded: ${kind} review waived (${o.reason}); it is listed in the handover manifest`); return; }
  if (!o.reply) usage('review needs --reply FILE (or - for stdin)');
  const text = o.reply === '-' ? fs.readFileSync(0, 'utf8') : read(path.isAbsolute(o.reply) ? o.reply : path.join(process.cwd(), o.reply));
  if (text === null) usage(`cannot read ${o.reply}`);
  const r = parseReply(text, kind); if (r.error) { out(`reply rejected: ${r.error}. Nothing was recorded.`); process.exit(2); }
  const w = writeReview(root, kind, { ...r, reviewer: 'subagent' });
  out(`recorded: ${kind} review ${r.verdict}${r.score !== null ? `, score ${r.score}` : ''}, ${r.blockers} blocker(s), ${r.majors} major (round ${w.rounds})`);
  process.exit(r.verdict === 'pass' ? 0 : 1);
}
function cmdRoadmap(root, o) {
  guardKind(root, 'read', o); const rm = roadmap(root);
  if (o.flags.has('json')) { out(JSON.stringify(rm, null, 2)); process.exit(rm.ok ? 0 : 1); }
  if (o.flags.has('next')) { out(rm.next_up.length ? rm.next_up.join('\n') : rm.slices.length ? '(no slice is ready: all done, or every open slice waits for a dependency)' : '(no slices)'); process.exit(rm.ok ? 0 : 1); }
  out(`roadmap: ${rm.slices.length} slice(s); ${rm.counts.done} done, ${rm.counts.applying + rm.counts.proposed} in progress, ${rm.counts.planned} planned`);
  for (const s of rm.slices) out(`  ${String(rm.order.indexOf(s.id) + 1).padStart(2)}. ${s.id}  [${s.size}${s.required_size && s.required_size !== s.size ? `, needs ${s.required_size}` : ''}] ${s.milestone} ${s.status}${s.skeleton ? ' skeleton' : ''}${s.depends_on.length ? `  after ${s.depends_on.join(', ')}` : ''}`);
  if (rm.next_up.length) out(`next up: ${rm.next_up.join(', ')}`);
  for (const e of rm.errors) out(`ERROR ${e.code}: ${e.text}`); for (const w of rm.warnings) out(`warning ${w.code}: ${w.text}`);
  out(rm.ok ? 'roadmap OK' : `roadmap has ${rm.errors.length} error(s)`); process.exit(rm.ok ? 0 : 1);
}
function cmdHandover(root, o) {
  if (o.flags.has('write')) guardKind(root, 'write', o); else guardKind(root, 'read', o);
  const g = gate(root); const h = handoverState(root);
  if (o.flags.has('write') && g.ready) { const rev = writeHandover(root, g, o.by); const text = 'READY FOR HANDOVER'; if (o.flags.has('json')) out(JSON.stringify({ ready: true, manifest: 'openspec/greenfield/handover.md', rev }, null, 2)); else out(`${text}\nmanifest: openspec/greenfield/handover.md (rev ${rev}). Send the repository to the development team; they run /spec-green-next.`); return; }
  if (o.flags.has('json')) { out(JSON.stringify({ ready: g.ready && !!h && h.current, gate: g.ready, manifest: h, items: g.items, missing: g.missing, warnings: g.warnings }, null, 2)); process.exit(g.ready ? 0 : 1); }
  if (g.ready) { out(h && h.current ? `READY FOR HANDOVER\nmanifest: openspec/greenfield/handover.md (rev ${h.rev})` : `The gate passes. Write the manifest: ${run('handover --write')}`); return; }
  out(`NOT READY: ${g.missing.length} item(s) missing`); for (const i of g.items) { out(`  [${i.ok ? 'x' : ' '}] ${i.text}`); for (const d of i.detail.slice(0, 8)) out(`        - ${d}`); if (!i.ok) out(`        fix: ${i.fix}`); }
  for (const w of g.warnings) out(`warning: ${w}`); process.exit(1);
}

function main(argv) {
  const cmd = argv[0]; const o = parseOpts(argv.slice(1)); const root = fs.realpathSync(path.resolve(o.root || process.env.OPENSPEC_ROOT || process.env.OPENSPEC_PROJECT_ROOT || process.cwd()));
  if (cmd !== 'mode' && layoutOf(root, { root: o.root }).workspace) { out(`REFUSED: ${ALTERNATIVE.unsupported}`); process.exit(EXIT_REFUSED); }
  switch (cmd) {
    case 'mode': return cmdMode(root, o);
    case 'roadmap': return cmdRoadmap(root, o);
    case 'handover': return cmdHandover(root, o);
    case 'greenfield': {
      const sub = o._.shift();
      const f = { status: cmdStatus, start: cmdStart, new: cmdNew, approve: cmdApprove, review: cmdReview, readme: cmdReadme }[sub];
      if (!f) usage('greenfield <status|start|new|approve|review|readme>');
      return f(root, o);
    }
    default: return usage(`unknown greenfield command '${cmd}'`);
  }
}
module.exports = { main };
if (require.main === module) main(process.argv.slice(2));
