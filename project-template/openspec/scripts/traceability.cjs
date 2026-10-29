'use strict';
/*
 * traceability.cjs - the requirement's Why, code anchors and the drift check, used by verify-task.cjs. Plain Node >= 18,
 * language-agnostic (regex scans, no parsers), no network.
 *
 * Three small ideas, all optional per project (`traceability: on | warn | off` in openspec/config.yaml, default off):
 *
 *   Why                 Every ADDED or MODIFIED requirement says `Why: <who wants it, and why>` (one line) under its SHALL sentence.
 *                       Rewriting the Why of a living requirement, or removing a requirement, needs the owner's approval
 *                       (`Owner approval: <name>, <date>` in proposal.md).
 *   Code anchors        a comment `@spec <capability>/<requirement-slug>` in source and tests. The script scans for them,
 *                       checks they resolve, requires >= 1 code and >= 1 test anchor per requirement of the change (a test
 *                       tagged `[capability/scenario-slug]` for one of its scenarios counts as a test anchor). The markers ARE the
 *                       index: nothing is written or committed (a committed index conflicts between parallel PRs); `anchors --json`
 *                       prints the derived index. The agent only writes the comments.
 *   Drift               `drift` compares the living specs, the code anchors and the test tags and reports gaps;
 *                       `drift decide <gap-key> --accept --note TEXT` writes an `Accepted: <reason>` line on the requirement in its living spec.
 *
 * Exports are pure functions over files; verify-task.cjs owns the CLI, exit codes and printing.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Q = require('./quality.cjs');
const AG = require('./anchorguard.cjs');

const slug = Q.slug;
const CH = require('./chronology.cjs'); // when changes were created and archived: the one ordering
const FIT = require('./anchorfit.cjs'); // are there too many anchors, or on code that does not implement the requirement: see anchorfit.cjs
const { MARKER_LEADER, KEY, placementFindings } = require('./placement.cjs'); // where a marker is allowed to sit: see placement.cjs
const SKIP_EXT = /\.(md|markdown|mdx|txt|json|jsonc|lock|lockb|svg|png|jpe?g|gif|webp|ico|pdf|woff2?|ttf|eot|map|min\.js|snap|csv|tsv|zip|gz|wasm)$/i;
const SKIP_DIR = /^(node_modules|\.git|dist|build|out|coverage|vendor|\.venv|venv|target|__pycache__|\.next|\.nuxt|\.svelte-kit|\.turbo|\.cache|openspec|adr|\.cursor|\.claude|\.agents|\.codex)$/;
const readIf = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
const norm = (t) => String(t).replace(/\r\n/g, '\n').split('\n').map((l) => l.replace(/\s+$/, '')).join('\n').replace(/\n{2,}/g, '\n').trim();

// ---------- config ----------
/** `traceability: on|warn|off` from the first config file that has it (default off). */
function mode(configFiles) {
  const env = (process.env.SPEC_TRACEABILITY || '').toLowerCase(); if (env === 'on' || env === 'warn' || env === 'off') return env; // env var beats the config files (like SPEC_TEST_CMD)
  for (const f of configFiles) {
    const s = readIf(f); if (!s) continue;
    const m = s.match(/^traceability:\s*['"]?(on|warn|off)\b/mi);
    if (m) return m[1].toLowerCase();
  }
  return 'off';
}
/** Downgrade errors to warnings in `warn` mode; drop everything in `off`. */
function bySeverity(problems, md) {
  if (md === 'off') return [];
  return problems.map((p) => (md === 'warn' && p.severity === 'error' ? { ...p, severity: 'warning' } : p));
}

// ---------- spec parsing ----------
/**
 * Requirements of one spec file (living spec or delta): [{ name, slug, op, line, why, scenarios: [{name, slug, line}], block }]
 * and renames [{from, to}]. op is ADDED | MODIFIED | REMOVED | LIVING.
 */
const ACCEPTED_RE = /^\s*(?:[-*]\s*)?\**Accepted\**:\s*(.+?)\s*$/i;
function parseSpec(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = { purpose: '', reqs: [], renames: [], baseline: false };
  let op = 'LIVING'; let req = null; let fence = null; let inPurpose = false; let rn = null;
  const closeReq = (end) => { if (req) { req.block = norm(lines.slice(req.line - 1, end).filter((_, j) => req.line - 1 + j !== req.acceptedAt).join('\n')); req = null; } }; // an `Accepted:` line is not part of the requirement text (sync compares the text)
  lines.forEach((l, i) => {
    const fm = l.match(/^\s*(`{3,}|~{3,})\s*(\S*)/);
    if (fm) { if (!fence) fence = fm[1][0]; else if (fm[1][0] === fence && !fm[2]) fence = null; return; }
    if (fence) return;
    let m;
    if ((m = l.match(/^##\s+(.*?)\s*$/))) {
      closeReq(i); inPurpose = /^purpose\b/i.test(m[1]); rn = null;
      const o = m[1].match(/^(ADDED|MODIFIED|REMOVED|RENAMED)\b/i);
      op = o ? o[1].toUpperCase() : 'LIVING'; if (op === 'RENAMED') rn = {};
      return;
    }
    if ((m = l.match(/^###\s+Requirement:\s*(.*?)\s*$/))) {
      closeReq(i);
      req = { name: m[1], slug: slug(m[1]), op, line: i + 1, why: null, confirmed: null, accepted: null, acceptedAt: -1, scenarios: [], block: '' };
      out.reqs.push(req); inPurpose = false; return;
    }
    if (op === 'RENAMED') {
      if ((m = l.match(/FROM:\s*`?###\s*Requirement:\s*(.*?)`?\s*$/i))) { rn = { from: m[1] }; return; }
      if ((m = l.match(/TO:\s*`?###\s*Requirement:\s*(.*?)`?\s*$/i)) && rn && rn.from) { out.renames.push({ from: rn.from, to: m[1], fromSlug: slug(rn.from), toSlug: slug(m[1]) }); rn = null; return; }
    }
    if (inPurpose) { out.purpose += `${l}\n`; return; }
    if (!req) return;
    if ((m = l.match(/^####\s+Scenario:\s*(.*?)\s*$/))) { req.scenarios.push({ name: m[1], slug: slug(m[1]), line: i + 1 }); return; }
    if (!req.scenarios.length && req.confirmed === null && (m = l.match(/^\s*(?:[-*]\s*)?\**Confirmed\**:\s*(.+?)\s*$/i))) { req.confirmed = m[1].replace(/\*/g, ''); return; }
    if (!req.scenarios.length && req.accepted === null && (m = l.match(ACCEPTED_RE))) { req.accepted = m[1].replace(/\*/g, ''); req.acceptedAt = i; return; }
    if (!req.scenarios.length && req.why === null && (m = l.match(/^\s*(?:[-*]\s*)?\**Why\**:\s*(.*?)\s*$/i))) req.why = m[1].replace(/\*/g, '').trim();
  });
  closeReq(lines.length);
  out.purpose = out.purpose.replace(/<!--[\s\S]*?-->/g, '').trim();
  out.baseline = /^\s*Baseline:\s*adopted\b/im.test(out.purpose);
  for (const r of out.reqs) r.baseline = out.baseline;
  return out;
}
function specFilesOf(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().map((cap) => ({ cap, file: path.join(dir, cap, 'spec.md') })).filter((x) => fs.existsSync(x.file));
}
/** Living requirements: Map `cap/slug` -> { cap, key, name, why, scenarios, file, line, block }. */
function livingRequirements(root) {
  const m = new Map();
  for (const { cap, file } of specFilesOf(path.join(root, 'openspec', 'specs'))) {
    for (const r of parseSpec(fs.readFileSync(file, 'utf8')).reqs) m.set(`${cap}/${r.slug}`, { ...r, cap, key: `${cap}/${r.slug}`, file });
  }
  return m;
}
/** The change's delta, per capability: [{ cap, file, reqs, renames }]. */
function changeDeltas(changeDir) {
  return specFilesOf(path.join(changeDir, 'specs')).map(({ cap, file }) => ({ cap, file, ...parseSpec(fs.readFileSync(file, 'utf8')) }));
}
/** Living requirements with the change's delta applied (what the specs will say after sync). */
function effectiveRequirements(root, changeDir) {
  const m = livingRequirements(root);
  if (!changeDir) return m;
  for (const d of changeDeltas(changeDir)) {
    for (const rn of d.renames) { const old = m.get(`${d.cap}/${rn.fromSlug}`); if (old) { m.delete(old.key); m.set(`${d.cap}/${rn.toSlug}`, { ...old, name: rn.to, slug: rn.toSlug, key: `${d.cap}/${rn.toSlug}` }); } }
    for (const r of d.reqs) {
      const key = `${d.cap}/${r.slug}`;
      if (r.op === 'REMOVED') m.delete(key);
      else if (r.op === 'ADDED' || r.op === 'MODIFIED') m.set(key, { ...r, cap: d.cap, key, file: d.file });
    }
  }
  return m;
}
const scenarioIndex = (reqs) => { const s = new Map(); for (const r of reqs.values()) for (const sc of r.scenarios) s.set(`${r.cap}/${sc.slug}`, r.key); return s; };

// ---------- why ----------
/** The owner's approval line of a proposal (`Owner approval: <name>, <date>`, anywhere outside code fences), or null. */
function proposalApproval(text) {
  let fence = false; let out = null;
  for (const l0 of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    if (/^\s*(`{3,}|~{3,})/.test(l0)) { fence = !fence; continue; }
    if (fence) continue;
    const m = l0.replace(/<!--.*?-->/g, '').trim().match(/^(?:[-*]\s*)?\**Owner approval\**:\s*(.*)$/i);
    if (m && m[1].replace(/\*/g, '').trim()) out = m[1].replace(/\*/g, '').trim();
  }
  return out;
}
const WHY_MIN_WORDS = 5;
const whyWords = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;

/**
 * Why findings for one change: { problems, approvals }.
 * problem: { severity: error|warning, kind, text, file, line }; approvals: [{ key, status: 'changed'|'removed', was, now }] needing the owner.
 * Every ADDED or MODIFIED requirement says `Why: <who wants what, and why>` under its SHALL sentence. A change that rewrites the Why of a
 * living requirement, or removes a requirement, needs `Owner approval: <name>, <date>` in proposal.md.
 */
function whyLint(root, changeDir) {
  const problems = []; const P = (severity, kind, text, file, line) => problems.push({ severity, kind, text, file: file || 'proposal.md', line: line || 0 });
  const out = { problems, approvals: [] };
  const meta = readIf(path.join(changeDir, '.openspec.yaml')) || '';
  if (/^\s*skip_specs:\s*true/m.test(meta)) return out;
  const deltas = changeDeltas(changeDir);
  if (!deltas.length) return out;
  const living = livingRequirements(root);
  for (const d of deltas) {
    const rel = path.relative(changeDir, d.file); const seen = new Set();
    for (const r of d.reqs) {
      const key = `${d.cap}/${r.slug}`; const loc = `${rel}:${r.line}`;
      if (seen.has(r.slug)) P('error', 'duplicate-requirement-slug', `${loc}: requirement "${r.name}" gives the same anchor slug \`${key}\` as another one in this spec; rename one`, rel, r.line);
      seen.add(r.slug);
      const renamed = d.renames.find((x) => x.toSlug === r.slug);
      const was = living.get(key) || (renamed ? living.get(`${d.cap}/${renamed.fromSlug}`) : undefined);
      if (r.op === 'REMOVED') { if (was) out.approvals.push({ key, status: 'removed', was: was.why, now: null, file: rel, line: r.line }); continue; }
      if (r.why === null) { P('error', 'missing-why', `${loc}: requirement "${r.name}" has no \`Why:\` line. Add one line right under its SHALL statement: who wants this and why, e.g. \`Why: The account owner wants to reset a forgotten password, so that they are not locked out.\``, rel, r.line); continue; }
      if (whyWords(r.why) < WHY_MIN_WORDS) P('error', 'why-too-short', `${loc}: the Why of "${r.name}" is too short to say who wants it and why (${WHY_MIN_WORDS} words at least): ${r.why || 'empty'}`, rel, r.line);
      if (r.op === 'MODIFIED' && was && was.why && was.why.replace(/\s+/g, ' ') !== r.why.replace(/\s+/g, ' ')) out.approvals.push({ key, status: 'changed', was: was.why, now: r.why, file: rel, line: r.line });
    }
  }
  if (out.approvals.length && !proposalApproval(readIf(path.join(changeDir, 'proposal.md')))) {
    P('error', 'why-owner-approval', `OWNER APPROVAL: this change ${out.approvals.map((a) => `${a.status === 'removed' ? 'removes' : 'rewrites the Why of'} ${a.key}`).join(', ')}. Show the owner the old and the new text, and only after they agree add \`Owner approval: <name>, <date>\` to proposal.md.`, 'proposal.md', 1);
  }
  return out;
}

// ---------- code anchors ----------
/** A file the anchor scan reads (relative, `/`-separated): not under a vendor/build/spec directory, not a binary or data file. The editor uses it too. */
const isScannable = (f) => !f.split('/').slice(0, -1).some((seg) => SKIP_DIR.test(seg)) && !SKIP_EXT.test(f);
function codeFiles(codeRoot) {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: codeRoot, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  let files = r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null;
  if (!files) { files = []; (function walk(d, rel) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (SKIP_DIR.test(e.name)) continue; const p = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), p); else files.push(p); } })(codeRoot, ''); }
  return files.filter((f) => isScannable(f) && fs.existsSync(path.join(codeRoot, f)));
}
/** Markers in one text: [{ key, line }]. */
function markersIn(text) {
  const out = [];
  String(text).split('\n').forEach((l, i) => {
    const m = MARKER_LEADER.exec(l); if (!m) return;
    let rest = l.slice(m.index + m[0].length), k;
    while ((k = rest.match(KEY))) { out.push({ key: `${k[1]}/${k[2]}`, line: i + 1 }); rest = rest.slice(k[0].length); }
  });
  return out;
}
/** Every marker of the code repo: [{ key, file, line, test }]. */
function scanAnchors(codeRoot, only) {
  const out = [];
  for (const f of only || codeFiles(codeRoot)) {
    let st; try { st = fs.statSync(path.join(codeRoot, f)); } catch (e) { continue; }
    if (!st.isFile() || st.size > 1024 * 1024) continue;
    const s = readIf(path.join(codeRoot, f)); if (!s || s.includes('\0') || !s.includes('@spec')) continue;
    for (const m of markersIn(s)) out.push({ ...m, file: f, test: Q.isTestPath(f) });
  }
  return out;
}
/** Capabilities that once had a spec (an archived change carries a delta for them) but have none now: their test tags are stale. */
function retiredCapabilities(root) {
  const dir = path.join(root, 'openspec', 'changes', 'archive'); const gone = new Set();
  if (fs.existsSync(dir)) for (const a of fs.readdirSync(dir)) for (const { cap } of specFilesOf(path.join(dir, a, 'specs'))) gone.add(cap);
  for (const cap of [...gone]) if (fs.existsSync(path.join(root, 'openspec', 'specs', cap, 'spec.md'))) gone.delete(cap);
  return gone;
}

/**
 * Anchor facts for a requirement set. reqs: Map key -> requirement. Returns
 * { requirements: Map key -> { code, tests, why }, unresolved: [{key,file,line}], stale_tags: [{tag, files, why}], tags }.
 */
function anchorFacts(reqs, codeRoot, root) {
  const markers = scanAnchors(codeRoot);
  const tags = Q.traceTags(Q.listTestFiles(codeRoot), codeRoot);
  const sc = scenarioIndex(reqs);
  const info = new Map();
  for (const [k, r] of reqs) info.set(k, { code: new Set(), tests: new Set(), why: r.why || '' });
  const unresolved = [];
  for (const m of markers) { const x = info.get(m.key); if (!x) { unresolved.push(m); continue; } (m.test ? x.tests : x.code).add(m.file); }
  const caps = new Set([...reqs.values()].map((r) => r.cap));
  const gone = root ? retiredCapabilities(root) : new Set();
  const stale = [];
  for (const [tag, files] of tags) {
    const owner = sc.get(tag);
    if (owner) { for (const f of files) info.get(owner).tests.add(f); continue; }
    const cap = tag.split('/')[0];
    if (caps.has(cap)) stale.push({ tag, files, why: 'no such scenario in the specs' });
    else if (gone.has(cap)) stale.push({ tag, files, why: 'capability no longer in the specs' });
  }
  return { requirements: info, unresolved, stale_tags: stale, tags, markers };
}
/** The derived anchor index (printed by `anchors --json`; never stored): capability list and, per requirement, its code and test files. */
function anchorIndex(reqs, facts) {
  const o = { version: 1, capabilities: [...new Set([...reqs.values()].map((r) => r.cap))].sort(), requirements: {} };
  for (const k of [...reqs.keys()].sort()) { const x = facts.requirements.get(k); o.requirements[k] = { why: x.why, code: [...x.code].sort(), tests: [...x.tests].sort() }; }
  return o;
}

/**
 * Anchor findings for a change: every requirement the change adds or modifies needs a code anchor and a test anchor;
 * every marker must resolve. Returns { problems, summary }.
 */
function anchorLint(root, changeDir, codeRoot) {
  const eff = effectiveRequirements(root, changeDir);
  const facts = anchorFacts(eff, codeRoot, root);
  const problems = []; const P = (severity, kind, text) => problems.push({ severity, kind, text, file: '', line: 0 });
  const mine = [];
  for (const d of changeDeltas(changeDir)) for (const r of d.reqs) if (r.op === 'ADDED' || r.op === 'MODIFIED') mine.push(`${d.cap}/${r.slug}`);
  const noCode = []; const noTest = [];
  for (const k of mine) { const x = facts.requirements.get(k); if (!x) continue; if (!x.code.size) noCode.push(k); if (!x.tests.size) noTest.push(k); }
  if (noCode.length) P('error', 'no-code-anchor', `requirement(s) without a code anchor: ${noCode.join(', ')}. Add a comment \`@spec <capability>/<requirement-slug>\` next to the code that implements each (any comment syntax).`);
  if (noTest.length) P('error', 'no-test-anchor', `requirement(s) without a test anchor: ${noTest.join(', ')}. Tag a test of one of its scenarios \`[capability/scenario-slug]\`, or put \`@spec <capability>/<requirement-slug>\` in a test file.`);
  for (const u of facts.unresolved) P('error', 'unresolved-marker', `${u.file}:${u.line}: \`@spec ${u.key}\` does not resolve to a requirement (the slug is the requirement name lower-cased with dashes; run \`verify-task.cjs anchors <change>\` to list the valid ones)`);
  for (const s of facts.stale_tags) P('error', 'stale-test-tag', `${s.files[0]}: test tag [${s.tag}]: ${s.why}`);
  const lvl = placementLevel([path.join(root, 'openspec', 'config.yaml'), path.join(codeRoot, 'openspec', 'config.yaml')]);
  if (lvl !== 'off') for (const x of placementProblems(codeRoot, mine.length ? new Set(mine) : null)) problems.push({ severity: lvl === 'error' ? 'error' : 'warning', kind: 'marker-placement', text: `${x.file}:${x.line}: ${x.kind}: ${x.text}`, file: x.file, line: x.line });
  const fit = fitProblems(root, codeRoot, mine.length ? new Set(mine) : null);
  for (const x of fit.findings) problems.push({ severity: fit.level === 'error' ? 'error' : 'warning', kind: x.kind, text: x.text, file: x.file, line: x.line });
  return { problems, facts, eff, mine, summary: { requirements: eff.size, change_requirements: mine.length, without_code: noCode, without_test: noTest, unresolved: facts.unresolved.length, stale_tags: facts.stale_tags.length } };
}
/** `anchor_placement: warn|error|off` (default warn): how hard marker placement findings bite. Env SPEC_ANCHOR_PLACEMENT beats the config files. */
function placementLevel(configFiles) {
  const env = (process.env.SPEC_ANCHOR_PLACEMENT || '').toLowerCase(); if (['warn', 'error', 'off'].includes(env)) return env;
  for (const f of configFiles) { const t = readIf(f); if (!t) continue; const m = t.match(/^anchor_placement:\s*['"]?(warn|error|off)\b/mi); if (m) return m[1].toLowerCase(); }
  return 'warn';
}
/** A `key: a|b|c` level from env (SPEC_<NAME>) or the config files; `def` when unset. */
function levelOf(name, allowed, def, configFiles) {
  const env = (process.env[`SPEC_${name.toUpperCase()}`] || '').toLowerCase(); if (allowed.includes(env)) return env;
  for (const f of configFiles) { const t = readIf(f); if (!t) continue; const m = t.match(new RegExp(`^${name}:\\s*['"]?([a-z]+)\\b`, 'mi')); if (m && allowed.includes(m[1].toLowerCase())) return m[1].toLowerCase(); }
  return def;
}
/** `anchor_guard: warn|error|off` (default warn): changed-anchor, sprawl and moved-anchor findings of a change. */
const guardLevel = (cf) => levelOf('anchor_guard', ['warn', 'error', 'off'], 'warn', cf);
/** `anchor_stale: info|warn|error|off` (default info): drift's stale-anchor gaps (code changed after the requirement text). */
const staleLevel = (cf) => levelOf('anchor_stale', ['info', 'warn', 'error', 'off'], 'info', cf);
/** `test_evidence: warn|strict|off` (default warn): finish needs the tagged tests of the change's requirements to show up passing in the runner output (strict: also when the runner does not print test names). */
const evidenceLevel = (cf) => levelOf('test_evidence', ['warn', 'strict', 'off'], 'warn', cf);
const REVIEWED_RE = /^[ \t]*(?:[-*][ \t]*)?(?:\[[ xX]\][ \t]*)?\**Reviewed anchors\**:[ \t]*(.+)$/gim;
/**
 * What a change mentions, for the anchor guard: { listed (keys of every delta requirement, any op, plus the requirements the tasks'
 * `Spec:` lines name), reviewed (keys on `Reviewed anchors:` lines of tasks.md / progress.md), modified (MODIFIED delta keys), removed (REMOVED keys) }.
 */
function changeMentions(root, changeDir) {
  const listed = new Set(), reviewed = new Set(), modified = new Set(), removed = new Set();
  for (const d of changeDeltas(changeDir)) {
    for (const r of d.reqs) { const k = `${d.cap}/${r.slug}`; listed.add(k); if (r.op === 'MODIFIED') modified.add(k); if (r.op === 'REMOVED') removed.add(k); }
    for (const rn of d.renames) { listed.add(`${d.cap}/${rn.fromSlug}`); listed.add(`${d.cap}/${rn.toSlug}`); }
  }
  const scens = [...Q.specScenarios(path.join(changeDir, 'specs')), ...Q.specScenarios(path.join(root, 'openspec', 'specs'))];
  const tasks = readIf(path.join(changeDir, 'tasks.md')) || '';
  for (const l of tasks.split('\n')) {
    const m = l.match(/^\s*[-*]?\s*(?:\[[ xX]\]\s*)?\**Spec\**:\s*(.+)$/i); if (!m) continue;
    const refs = Q.specRefs(m[1], scens);
    for (const sc of [...refs.explicit, ...refs.implicit]) if (sc.capability && sc.requirement) listed.add(`${sc.capability}/${Q.slug(sc.requirement)}`);
    for (const k of m[1].matchAll(/\b([a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)\b/g)) listed.add(k[1]);
  }
  for (const f of ['tasks.md', 'progress.md']) {
    const t = readIf(path.join(changeDir, f)); if (!t) continue;
    for (const m of t.matchAll(REVIEWED_RE)) for (const k of m[1].matchAll(/\b([a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)\b/g)) reviewed.add(k[1]);
  }
  return { listed, reviewed, modified, removed };
}
/** Placement findings (placement.cjs) of the markers in the given files (default: all marker files); `keys`: only markers of those requirement keys. [{ file, line, kind, keys, text }] */
function placementProblems(codeRoot, keys, files) {
  const out = [];
  for (const f of files || codeFiles(codeRoot)) {
    const s = readIf(path.join(codeRoot, f)); if (!s || s.length > 1024 * 1024 || s.includes('\0') || !s.includes('@spec')) continue;
    for (const x of placementFindings(s, Q.isTestPath(f))) if (!keys || x.keys.some((k) => keys.has(k))) out.push({ ...x, file: f });
  }
  return out;
}
/**
 * Anchor-fit findings (anchorfit.cjs): too many anchors for one requirement, anchors on boilerplate (imports, constants, types, string
 * tables, getters, logging), a crowded unit, a file of another capability, no word of the requirement in the unit.
 * `files`: only findings in these files (all anchors are still read, the count per requirement needs them); `keys`: only these requirements.
 * Returns { level, max, findings: [{ file, line, key, kind, text, remove }] }.
 */
function fitProblems(root, codeRoot, keys, files) {
  const cfg = [path.join(root, 'openspec', 'config.yaml'), path.join(codeRoot, 'openspec', 'config.yaml')];
  const { level, max, many } = FIT.fitConfig(cfg, readIf);
  if (level === 'off') return { level, max, findings: [] };
  const reqs = new Map(); const capNames = new Set(); const taskCaps = new Map();
  const add = (cap, list) => { capNames.add(cap); for (const r of list) reqs.set(`${cap}/${r.slug}`, { name: r.name, block: r.block, cap }); };
  for (const { cap, file } of specFilesOf(path.join(root, 'openspec', 'specs'))) add(cap, parseSpec(readIf(file) || '').reqs);
  const chRoot = path.join(root, 'openspec', 'changes');
  for (const c of fs.existsSync(chRoot) ? fs.readdirSync(chRoot) : []) {
    if (c === 'archive' || !fs.statSync(path.join(chRoot, c)).isDirectory()) continue;
    for (const d of changeDeltas(path.join(chRoot, c))) add(d.cap, d.reqs);
    const tasks = readIf(path.join(chRoot, c, 'tasks.md'));
    if (tasks) for (const g of Q.parsePlan(tasks).groups) for (const t of g.tasks) {
      const caps = new Set([...(t.details.spec || '').matchAll(/([a-z0-9][a-z0-9-]*)\/[a-z0-9][a-z0-9-]*/g)].map((m) => m[1]));
      if (caps.size === 1) for (const f of t.files) { if (!taskCaps.has(f)) taskCaps.set(f, new Set()); taskCaps.get(f).add([...caps][0]); }
    }
  }
  const texts = []; const seen = new Set();
  for (const m of scanAnchors(codeRoot)) { if (seen.has(m.file)) continue; seen.add(m.file); const t = readIf(path.join(codeRoot, m.file)); if (t && t.length < 1024 * 1024 && !t.includes('\0')) texts.push({ file: m.file, text: t, test: Q.isTestPath(m.file) }); }
  const found = FIT.fitFindings({ files: texts, reqs, capNames, taskCaps, max, many });
  return { level, max, findings: found.filter((x) => (!keys || keys.has(x.key)) && (!files || files.includes(x.file))) };
}
/** Marker findings in the given (changed) files only: unresolved keys. */
function markerProblems(root, changeDir, codeRoot, files) {
  const eff = effectiveRequirements(root, changeDir); const out = [];
  for (const m of scanAnchors(codeRoot, files)) if (!eff.has(m.key)) out.push({ ...m, hint: nearest(m.key, [...eff.keys()]) });
  return out;
}
const words = (s) => new Set(String(s).split(/[^a-z0-9]+/).filter(Boolean));
/** The most similar known key (word overlap), or null. */
function nearest(key, keys) {
  const cap = key.split('/')[0]; const w = words(key.split('/')[1] || ''); let best = null; let bs = 0;
  for (const k of keys) { if (k.split('/')[0] !== cap) continue; const kw = words(k.split('/')[1]); let n = 0; for (const x of w) if (kw.has(x)) n++; const s = n / Math.max(w.size, kw.size, 1); if (s > bs) { bs = s; best = k; } }
  return bs >= 0.34 ? best : null;
}

// ---------- drift ----------
// An accepted gap is a line in the living spec, on the requirement it excuses: `Accepted: <one-line reason>` (next to `Confirmed:`).
// Nothing else is stored: the line merges like any spec line, and it disappears with the requirement. Only gaps that belong to a
// requirement can be accepted (ACCEPTABLE); every other gap is fixed or removed (the marker, the test tag, the archive).

/** Archived changes replayed in date order: requirement keys that should exist in the living specs.
 *  `pendingDir`: a change being synced right now (not archived yet): its REMOVED/RENAMED ops are replayed last, so a
 *  requirement it retires is not reported as an unsynced archive while the archive is still to come. */
function archivedExpectation(root, pendingDir) {
  const dir = path.join(root, 'openspec', 'changes', 'archive'); const exp = new Map();
  const replay = (d, a) => {
    for (const rn of d.renames) { if (exp.has(`${d.cap}/${rn.fromSlug}`)) { exp.delete(`${d.cap}/${rn.fromSlug}`); exp.set(`${d.cap}/${rn.toSlug}`, a); } }
    for (const r of d.reqs) { const k = `${d.cap}/${r.slug}`; if (r.op === 'ADDED') exp.set(k, a); else if (r.op === 'REMOVED') exp.delete(k); }
  };
  if (fs.existsSync(dir)) for (const { name: a } of CH.archiveOrder(dir)) for (const d of changeDeltas(path.join(dir, a))) replay(d, a); // in the order they were archived (to the second), not by name
  if (pendingDir) for (const d of changeDeltas(pendingDir)) replay(d, path.basename(pendingDir));
  return exp;
}


// ---------- observed, unconfirmed (/spec-adopt) ----------
// Code is evidence of what happens today, not proof it is wanted. /spec-adopt writes only confirmed behavior as requirements (each with
// a `Confirmed:` line: test, doc or owner) and records the rest in openspec/observed/<capability>.md, one file per capability, no index.
const OBSERVED_DIR = 'observed';
const OBSERVED_KINDS = ['contradicts-doc', 'suspected-bug', 'debug-leftover', 'incidental', 'unclear', 'untested'];
const CONFIRM_KINDS = ['test', 'doc', 'owner'];
/** Entries of openspec/observed/<capability>.md: `## <slug>` plus `- Observed:`, `- Why unconfirmed:`, `- Owner:`, `- To confirm:` lines. */
function observedEntries(root) {
  const dir = path.join(root, 'openspec', OBSERVED_DIR); const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const f of fs.readdirSync(dir).sort().filter((x) => /\.md$/.test(x) && x !== 'README.md')) {
    const cap = f.replace(/\.md$/, ''); const lines = fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/); let e = null; let last = null;
    lines.forEach((l, i) => {
      let m;
      if ((m = l.match(/^##\s+(.+?)\s*$/))) { e = { cap, slug: slug(m[1]), file: path.join(dir, f), line: i + 1, observed: '', why: '', owner: '', confirm: '' }; out.push(e); last = null; return; }
      if (!e) return;
      if ((m = l.match(/^\s*[-*]\s*(Observed|Why unconfirmed|Owner|To confirm)\s*:\s*(.*?)\s*$/i))) { last = { observed: 'observed', 'why unconfirmed': 'why', owner: 'owner', 'to confirm': 'confirm' }[m[1].toLowerCase()]; e[last] = m[2]; return; }
      if (last && /^\s{2,}\S/.test(l)) e[last] += ` ${l.trim()}`; else if (/^\s*[-*]\s/.test(l) || !l.trim()) last = null;
    });
  }
  return out;
}
const observedProblem = (e) => {
  const missing = [['observed', 'Observed'], ['why', 'Why unconfirmed'], ['owner', 'Owner'], ['confirm', 'To confirm']].filter(([k]) => !e[k]).map(([, n]) => n);
  if (missing.length) return `missing ${missing.map((x) => `\`${x}:\``).join(', ')}`;
  if (!OBSERVED_KINDS.some((k) => e.why.toLowerCase().startsWith(k))) return `\`Why unconfirmed:\` starts with none of ${OBSERVED_KINDS.join(' | ')}`;
  return null;
};
const confirmedProblem = (r) => (r.confirmed === null ? 'has no `Confirmed:` line' : CONFIRM_KINDS.some((k) => new RegExp(`^${k}\\b\\s*\\S`, 'i').test(r.confirmed)) ? null : `\`Confirmed: ${r.confirmed.slice(0, 40)}\` must start with test, doc or owner and name the evidence`);

/**
 * The drift report over the LIVING specs (no change applied). Gap: { key, type, subject, text, hint, files, accepted }.
 * types: unconfirmed-requirement (adopted requirement without `Confirmed:`), observed-incomplete, unanchored-requirement, untested-requirement, orphan-anchor, stale-test-tag, unsynced-archive, misplaced-marker, stale-anchor.
 * gap.severity: error (default; fails `drift`), warn or info (advisory: listed, do not fail). misplaced-marker follows anchor_placement, stale-anchor follows anchor_stale; unconfirmed-requirement and observed-incomplete are warn.
 */
function drift(root, codeRoot, pendingDir, opts = {}) {
  const reqs = livingRequirements(root);
  const facts = anchorFacts(reqs, codeRoot, root);
  const gaps = []; const add = (type, subject, text, extra = {}) => gaps.push({ key: `${type}:${subject}`, type, subject, text, ...extra });
  for (const [k, x] of facts.requirements) {
    if (!x.code.size) add('unanchored-requirement', k, `requirement "${reqs.get(k).name}" has no code anchor`, { files: [], hint: `put \`@spec ${k}\` on the code that implements it (the code may have lost its marker when moved); if the code is gone, rebuild it test-first or retire the requirement in a change; if it is knowingly unanchored: \`drift decide ${`unanchored-requirement:${k}`} --accept --note "<why>"\`` });
    else if (!x.tests.size) add('untested-requirement', k, `requirement "${reqs.get(k).name}" has code anchors but no test anchor (no test tagged for its scenarios, no @spec marker in a test)`, { files: [...x.code], hint: `tag a test \`[${k.split('/')[0]}/<scenario-slug>]\` or put \`@spec ${k}\` in it; if it is knowingly untested: \`drift decide untested-requirement:${k} --accept --note "<why>"\`` });
  }
  const seenOrphan = new Set();
  for (const u of facts.unresolved) {
    if (seenOrphan.has(`${u.key}@${u.file}`)) continue; seenOrphan.add(`${u.key}@${u.file}`);
    add('orphan-anchor', `${u.key}@${u.file}`, `\`@spec ${u.key}\` in ${u.file}:${u.line} points at a requirement that does not exist (removed, renamed or mistyped)`, { files: [u.file], hint: `retarget or remove the marker${nearest(u.key, [...reqs.keys()]) ? `: perhaps renamed to ${nearest(u.key, [...reqs.keys()])}` : ''}` });
  }
  for (const s of facts.stale_tags) add('stale-test-tag', s.tag, `test tag [${s.tag}] in ${s.files.join(', ')}: ${s.why}`, { files: s.files, hint: (() => { const n = nearest(s.tag, [...scenarioIndex(reqs).keys()]); return `retarget or remove the tag${n ? `: perhaps renamed to [${n}]` : ''}`; })() });
  for (const r of reqs.values()) { // adopted baseline requirements need evidence (a requirement that carries a `Why:` needs no evidence)
    if (!r.baseline || r.why !== null) continue;
    const why = confirmedProblem(r);
    if (why) add('unconfirmed-requirement', r.key, `adopted requirement "${r.name}" ${why}`, { files: [path.relative(root, r.file)], severity: 'warn', hint: 'add `Confirmed: test <file>: <name>`, `Confirmed: doc <file>` or `Confirmed: owner <name>, <date>`; if nothing confirms it, move it to openspec/observed/<capability>.md and remove the requirement (/spec-fix)' });
  }
  const observed = observedEntries(root);
  for (const e of observed) { const why = observedProblem(e); if (why) add('observed-incomplete', `${e.cap}/${e.slug}`, `openspec/observed/${e.cap}.md:${e.line}: entry "${e.slug}" ${why}`, { files: [path.relative(root, e.file)], line: e.line, severity: 'warn', hint: 'every entry says what was observed, why it is unconfirmed, who can decide (Owner) and how to confirm it' }); }
  const exp = archivedExpectation(root, pendingDir);
  for (const [k, a] of exp) if (!reqs.has(k)) add('unsynced-archive', k, `change ${a} was archived with requirement ${k} that is not in openspec/specs (archived without /spec-sync, or removed later by hand)`, { hint: 're-add the requirement, or retire it with a REMOVED delta in a change (/spec-garden)' });
  // placement: markers that sit where they say nothing about the code (same levels as the change-time check: anchor_placement)
  const cfg = [path.join(root, 'openspec', 'config.yaml'), path.join(codeRoot, 'openspec', 'config.yaml')];
  const notes = [];
  // opts.light (sync): only the gap types sync reads; marker placement, anchor fit and stale anchors (git blame) are not computed
  const plLvl = opts.light ? 'off' : placementLevel(cfg);
  if (plLvl !== 'off') {
    const seenP = new Map();
    for (const x of placementProblems(codeRoot, null)) {
      const base = `${x.kind}@${x.file}#${x.keys[0]}`; const n = (seenP.get(base) || 0) + 1; seenP.set(base, n);
      add('misplaced-marker', n > 1 ? `${base}~${n}` : base, `${x.file}:${x.line}: ${x.kind}: ${x.text}`, { files: [x.file], severity: plLvl === 'error' ? 'error' : 'warn', hint: x.kind === 'duplicate-marker' ? 'remove the duplicate' : 'move the marker into the doc comment of the whole function, or on its own line directly above the lines that implement the requirement' });
    }
  }
  // fit: too many anchors, or anchors on code that does not implement the requirement (same levels as anchor_fit)
  const fit = opts.light ? { findings: [], level: 'off' } : fitProblems(root, codeRoot, null);
  for (const x of fit.findings) add('over-anchored', `${x.key}@${x.file}:${x.line}`, x.text, { files: [x.file], line: x.line, severity: x.info ? 'info' : fit.level === 'error' ? 'error' : 'warn', fit: x.kind, removable: x.remove, hint: x.remove ? 'remove the marker (`verify-task.cjs anchors prune`)' : 'move the marker to the code that decides the requirement' });
  // stale anchors: the unit changed in a commit later than the requirement text (git history only, nothing stored)
  const stLvl = opts.light ? 'off' : staleLevel(cfg);
  if (stLvl !== 'off') {
    const sr = AG.staleAnchors({ root, codeRoot, reqs, markers: facts.markers });
    notes.push(...sr.notes);
    for (const x of sr.stale) add('stale-anchor', `${x.key}@${x.file}`, `${x.file}:${x.line}: the code anchored to \`${x.key}\`${x.header ? ` (\`${x.header.slice(0, 70)}\`)` : ''} last changed in ${x.commit.slice(0, 8)} "${x.subject}", after the requirement text last changed in ${x.specCommit.slice(0, 8)} "${x.specSubject}"`, { files: [x.file], commit: x.commit.slice(0, 12), severity: stLvl === 'error' ? 'error' : stLvl === 'warn' ? 'warn' : 'info', hint: `read the diff (git show ${x.commit.slice(0, 8)} -- ${x.file}); if the requirement still holds, \`drift decide ${`stale-anchor:${x.key}@${x.file}`} --accept --note "..."\` (an \`Accepted:\` line on the requirement; commit it; a later code change reopens the gap); otherwise update the requirement or the code` });
  }
  // accepted: only gaps of a requirement, and only by the `Accepted:` line on that requirement
  const open = []; const accepted = [];
  for (const g of gaps) { const r = ACCEPTABLE.includes(g.type) ? reqs.get(gapRequirement(g)) : null; if (r && r.accepted !== null && g.type !== 'stale-anchor') { g.accepted = r.accepted; accepted.push(g); } else open.push(g); }
  const counts = {}; for (const g of gaps) counts[g.type] = (counts[g.type] || 0) + 1;
  return { gaps, open, accepted, counts, requirements: reqs.size, facts, notes, observed: { entries: observed.length, files: new Set(observed.map((e) => e.cap)).size } };
}
/** Gap types a person may accept: they belong to a requirement, so the acceptance is a line on it. Every other type is fixed or removed. stale-anchor: the line is a commit on the requirement text, which clears the gap until the code changes again. */
const ACCEPTABLE = ['unanchored-requirement', 'untested-requirement', 'stale-anchor'];
const gapRequirement = (g) => (g.type === 'stale-anchor' ? g.subject.split('@')[0] : g.subject);
/** `text` of a spec file with the requirement's `Accepted:` line set to `reason` (inserted after the requirement's last line before its first scenario; replaced when present). Nothing else changes, line endings included. */
function setAccepted(text, req, reason) {
  const lines = text.split('\n'); const start = req.line - 1; let stop = lines.length; let fence = null; let at = -1;
  for (let i = start + 1; i < lines.length; i++) {
    const fm = lines[i].match(/^\s*(`{3,}|~{3,})\s*(\S*)/);
    if (fm) { if (!fence) fence = fm[1][0]; else if (fm[1][0] === fence && !fm[2]) fence = null; continue; }
    if (fence) continue;
    if (/^####\s+Scenario:/.test(lines[i]) || /^#{2,3}\s/.test(lines[i])) { stop = i; break; }
    if (at < 0 && ACCEPTED_RE.test(lines[i].replace(/\r$/, ''))) at = i;
  }
  const cr = (i) => (lines[i].endsWith('\r') ? '\r' : '');
  if (at >= 0) { const next = `Accepted: ${reason}${cr(at)}`; if (lines[at] === next) return text; lines[at] = next; return lines.join('\n'); }
  let last = stop - 1; while (last > start && !/\S/.test(lines[last])) last--;
  lines.splice(last + 1, 0, `Accepted: ${reason}${cr(last)}`);
  return lines.join('\n');
}
/**
 * Accept gaps: write `Accepted: <reason>` on each gap's requirement in openspec/specs/<cap>/spec.md. `gaps`: drift gaps (ACCEPTABLE types).
 * One write per spec file; idempotent (the same reason again changes nothing). Returns [{ key, requirement, file, line, changed }].
 */
function accept(root, gaps, note) {
  const reason = String(note || '').replace(/\s+/g, ' ').trim();
  if (!reason) throw new Error('a note (--note) is required: say why, in one line');
  const reqs = livingRequirements(root); const byFile = new Map(); const out = [];
  for (const g of gaps) {
    if (!ACCEPTABLE.includes(g.type)) throw new Error(`${g.key}: a ${g.type} gap cannot be accepted: ${g.type === 'orphan-anchor' || g.type === 'stale-test-tag' || g.type === 'misplaced-marker' ? 'fix or remove the marker or tag in the code' : g.type === 'unsynced-archive' ? 're-add the requirement or retire it with a REMOVED delta in a change' : 'fix it (see its hint)'}`);
    const r = reqs.get(gapRequirement(g)); if (!r) throw new Error(`${g.key}: requirement ${gapRequirement(g)} not found in openspec/specs`);
    if (!byFile.has(r.file)) byFile.set(r.file, []); byFile.get(r.file).push({ g, r });
  }
  for (const [file, items] of byFile) {
    const orig = fs.readFileSync(file, 'utf8'); let text = orig; const seen = new Set();
    for (const { g, r } of items.sort((a, b) => b.r.line - a.r.line)) {
      if (seen.has(r.key)) { out.push({ key: g.key, requirement: r.key, file: path.relative(root, file), line: r.line, changed: false }); continue; } seen.add(r.key);
      const next = setAccepted(text, r, reason); out.push({ key: g.key, requirement: r.key, file: path.relative(root, file), line: r.line, changed: next !== text }); text = next;
    }
    if (text !== orig) fs.writeFileSync(file, text);
  }
  return out;
}

// ---------- ADR numbers ----------
/** Promoted ADRs: [{ file, number, slug, title, status, source }] sorted by file name. adr/README.md and other files are ignored. */
function adrList(root) {
  const dir = path.join(root, 'adr'); if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().map((f) => { const m = f.match(/^(\d{4})-(.+)\.md$/); if (!m) return null; const t = readIf(path.join(dir, f)) || ''; const fm = (t.match(/^---\n([\s\S]*?)\n---/) || [])[1] || ''; const g = (k) => ((fm.match(new RegExp(`^${k}:\\s*(.*)$`, 'm')) || [])[1] || '').trim(); return { file: f, number: m[1], slug: m[2], title: g('title'), status: g('status'), source: g('source') }; }).filter(Boolean);
}
/** Numbers used by more than one ADR (two parallel PRs each took "the next number"): [{ number, files }]. */
function adrDuplicates(root) {
  const by = new Map(); for (const a of adrList(root)) { if (!by.has(a.number)) by.set(a.number, []); by.get(a.number).push(a.file); }
  return [...by].filter(([, f]) => f.length > 1).map(([number, files]) => ({ number, files }));
}
/** Renumber duplicates: the first file (by name) keeps its number, the others get the next free numbers. Returns [{ from, to }]. */
function adrRenumber(root) {
  const dir = path.join(root, 'adr'); const out = []; let max = Math.max(0, ...adrList(root).map((a) => Number(a.number)));
  for (const d of adrDuplicates(root)) for (const f of d.files.slice(1)) { const to = `${String(++max).padStart(4, '0')}-${f.slice(5)}`; fs.renameSync(path.join(dir, f), path.join(dir, to)); out.push({ from: f, to }); }
  return out;
}

// ---------- sync check ----------
/** Is the change fully synced? { ok, problems: [string], warnings: [string], parts }. Read-only. */
/** `Kind: spec-only` in proposal.md: the change only writes specs (greenfield foundation, capability, integration); nothing is implemented yet. */
function isSpecOnly(changeDir) { return /^\s*(?:[-*]\s+)?\**Kind\**:\s*\**spec-only\b/mi.test(readIf(path.join(changeDir, 'proposal.md')) || ''); }
function syncCheck(root, changeDir, change, codeRoot, md) {
  const problems = []; const warnings = []; const parts = {};
  const living = livingRequirements(root);
  // 1. specs merged
  const specP = [];
  for (const d of changeDeltas(changeDir)) {
    const spec = readIf(path.join(root, 'openspec', 'specs', d.cap, 'spec.md'));
    for (const rn of d.renames) { if (living.has(`${d.cap}/${rn.fromSlug}`)) specP.push(`${d.cap}: renamed requirement "${rn.from}" still in the living spec`); if (!living.has(`${d.cap}/${rn.toSlug}`)) specP.push(`${d.cap}: renamed requirement "${rn.to}" missing from the living spec`); }
    for (const r of d.reqs) {
      const l = living.get(`${d.cap}/${r.slug}`);
      if (r.op === 'REMOVED') { if (l) specP.push(`${d.cap}: removed requirement "${r.name}" is still in the living spec`); }
      else if (!l) specP.push(`${d.cap}: requirement "${r.name}" (${r.op}) is not in ${spec === null ? 'openspec/specs (the capability has no living spec yet)' : 'the living spec'}`);
      else if (norm(l.block) !== norm(r.block)) specP.push(`${d.cap}: requirement "${r.name}" differs from the change's ${r.op} block`);
    }
  }
  parts.specs = specP.length ? 'not merged' : 'merged'; problems.push(...specP.map((x) => `specs: ${x}`));
  // 2. ADRs promoted
  const adrDir = path.join(root, 'adr'); const adrP = [];
  const src = path.join(changeDir, 'adrs');
  if (fs.existsSync(src)) for (const f of fs.readdirSync(src).filter((x) => x.endsWith('.md')).sort()) {
    const t = readIf(path.join(src, f)) || ''; const fmM = t.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
    if (Q.isNoneAdr(f, t)) continue;
    const slugName = f.replace(/\.md$/, ''); const promoted = fs.existsSync(adrDir) ? fs.readdirSync(adrDir).filter((x) => /^\d{4}-.*\.md$/.test(x)).find((x) => (readIf(path.join(adrDir, x)) || '').includes(`source: ${change}/${slugName}`)) : null;
    if (!promoted) { adrP.push(`${f}: NOT PROMOTED to adr/`); continue; }
    const pt = readIf(path.join(adrDir, promoted)) || ''; const pb = (pt.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/) || [])[1] || '';
    if (norm(pb) !== norm(fmM ? fmM[2] : t)) adrP.push(`${f}: promoted as ${promoted} but OUT OF DATE`);
  }
  for (const d of adrDuplicates(root)) adrP.push(`number ${d.number} is used by ${d.files.join(' and ')} (parallel branches each took the next number): run \`node openspec/scripts/verify-task.cjs adrs --fix\` and commit the renames`);
  parts.adrs = adrP.length ? 'not promoted' : 'promoted'; problems.push(...adrP.map((x) => `adrs: ${x}`));
  // 3. anchors and drift (only when traceability is on)
  if (md !== 'off' && isSpecOnly(changeDir)) { parts.anchors = parts.drift = 'skipped (spec-only change: requirements not built yet are the drift backlog)'; }
  else if (md !== 'off' && specP.length) { parts.anchors = parts.drift = 'skipped (specs not merged yet)'; }
  else if (md !== 'off') {
    const al = anchorLint(root, changeDir, codeRoot); const live = drift(root, codeRoot, changeDir, { light: true });
    parts.anchors = al.problems.length ? 'problems' : 'ok';
    const sev = md === 'warn' ? warnings : problems;
    sev.push(...al.problems.filter((p) => p.severity === 'error').map((p) => `anchors: ${p.text}`));
    const mineKeys = new Set(al.mine);
    const dr = live.open.filter((g) => g.type === 'orphan-anchor' || g.type === 'stale-test-tag' || g.type === 'unsynced-archive' || ((g.type === 'unanchored-requirement' || g.type === 'untested-requirement') && mineKeys.has(g.subject)));
    parts.drift = dr.length ? `${dr.length} open gap(s)` : 'clean';
    sev.push(...dr.map((g) => `drift: ${g.key}: ${g.text}`));
    sev.push(...whyLint(root, changeDir).problems.filter((p) => p.severity === 'error').map((p) => `why: ${p.text}`));
    const legacy = live.open.filter((g) => (g.type === 'unanchored-requirement' || g.type === 'untested-requirement') && !mineKeys.has(g.subject)).length;
    if (legacy) warnings.push(`drift: ${legacy} other requirement(s) have no code/test anchor (run \`verify-task.cjs drift\`; /spec-garden fixes or accepts each gap)`);
  }
  return { ok: !problems.length, problems, warnings, parts };
}

module.exports = { archivedExpectation, fitProblems, OBSERVED_KINDS, isSpecOnly, guardLevel, evidenceLevel, changeMentions, adrList, adrDuplicates, adrRenumber, mode, bySeverity, parseSpec, livingRequirements, changeDeltas, proposalApproval, whyLint, isScannable, scanAnchors, anchorIndex, anchorLint, markerProblems, placementLevel, placementProblems, drift, accept, ACCEPTABLE, syncCheck };
