'use strict';
/*
 * quality.cjs - plan and test-quality rules used by verify-task.cjs (lint, check, finish). Plain Node >= 18.
 *
 *   planLint(tasksText, opts)      task-plan size rules: `Size: S|M|L` caps (3/5/8 implementation tasks; the size is
 *                                  read from proposal.md, opts.size), review tasks only where they pay off, no agent
 *                                  close-out tasks, merge candidates
 *   proposalSize(text)             the `Size:` and `Risk:` lines of proposal.md
 *   sizeFacts(changeDir)           what the specs, ADRs and tasks of a change actually contain (capabilities,
 *                                  requirements, BREAKING, visual blocks, risk markers, ADRs, design/app-map sections)
 *   sizeCheck(facts)               the size those facts require (S/M/L rules) vs the declared one; problems
 *   invariantLint(specsDir)        data-transforming requirements without an `Invariant:` scenario (warnings)
 *   specScenarios(specsDir)        every scenario of a change's (or the main) specs, with its id and visual flag
 *   traceTags(files, root)         `[capability/scenario-slug]` tags found in test files
 *   trace(scenarios, tags, opts)   scenarios with no tagged test (visual scenarios count as covered by the visual check)
 *   specRefs(specLine, scenarios)  which scenarios a task's `Spec:` line names explicitly / by requirement only
 *   sourceTextFindings(file)       tests that read source files as text (`?raw`, readFileSync of src/.vue/.css, ...)
 *   isTestPath(path), isTestFile(path) (testpaths.cjs), listTestFiles(root)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { isTestPath, isTestFile, isUiFile } = require('./testpaths.cjs'); // which files are tests: see testpaths.cjs

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scenario';

// ---------- plan size ----------
const CAPS = { S: 3, M: 5, L: 8 };
/** Size rules (one source of truth; the schema instructions and config rules quote these numbers, tests/drift.sh checks). */
const SIZE_RULES = { S_MAX_REQUIREMENTS: 3, S_MAX_CAPABILITIES: 1, M_MAX_CAPABILITIES: 2 };
const RISKS = ['security', 'money', 'data-migration', 'concurrency', 'public-api'];
const TASK_RE = /^[-*+]\s+\[([ xX])\]\s+(?:(\d+\.(?:\d+|[A-Za-z]+))\s+)?(.*?)\s*$/;
const REVIEW_RE = /\bcode review\b|\breview\b.*\b(group|change)\b/i;
const CLOSEOUT_RE = /full (test )?suite|openspec validate|validation passes|every (spec )?scenario is covered|every visual scenario passes|visual check and review/i;

const isQaGroup = (title) => /^qa[ -]?fix/i.test(title);
const isCloseoutGroup = (title) => /^close-?out\b/i.test(title);

/** Parse tasks.md into { size, groups: [{ n, title, risky, line, tasks: [{ label, title, line, details, review, closeout, files }] }] }. */
function parsePlan(text) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const out = { size: null, sizeLine: null, groups: [] }; let g = null; let t = null; let fence = false;
  lines.forEach((l, i) => {
    if (/^\s*(`{3,}|~{3,})/.test(l)) { fence = !fence; return; }
    if (fence) return;
    let m;
    if (!out.size && (m = l.match(/^\s*(?:[-*]\s+)?\**Size\**:\s*\**\s*([SML])\b/i))) { out.size = m[1].toUpperCase(); out.sizeLine = i + 1; return; }
    if ((m = l.match(/^##\s+(?:(\d+)\.\s*)?(.*?)\s*$/))) {
      const title = m[2].replace(/<!--.*?-->/g, '').trim();
      g = { n: m[1] || String(out.groups.length + 1), title, qa: isQaGroup(title), risky: /\(risky\)|\brisky\b/i.test(title), closeout: isCloseoutGroup(title), line: i + 1, tasks: [] };
      out.groups.push(g); t = null; return;
    }
    if ((m = l.match(TASK_RE))) {
      if (!g) { g = { n: '1', title: 'Tasks', risky: false, closeout: false, line: i + 1, tasks: [] }; out.groups.push(g); }
      const title = m[3].replace(/<!--.*?-->/g, '').trim(); const label = m[2] || '';
      t = { label, title, line: i + 1, done: m[1] !== ' ', details: {}, review: /\.R$/i.test(label) || REVIEW_RE.test(title), closeout: false };
      t.closeout = !t.review && (g.closeout || CLOSEOUT_RE.test(title));
      g.tasks.push(t); return;
    }
    if (t && (m = l.match(/^\s+[-*+]\s+([A-Za-z ]+):\s*(.*)$/))) { t.details[m[1].trim().toLowerCase()] = m[2].trim(); return; }
    if (/^\S/.test(l)) t = null;
  });
  for (const gr of out.groups) for (const x of gr.tasks) {
    x.files = (x.details.files || '').split(/[\s,;]+/).map((f) => f.replace(/[`()]/g, '')).filter((f) => /[./]/.test(f));
    x.final = x.review && /final|whole change|entire change/i.test(x.title);
  }
  return out;
}

/** A review task (label N.R, or a title asking for a code review). */
const isReviewTask = (label, title) => /\.R$/i.test(label || '') || REVIEW_RE.test(title || '');
/** Counts against the Size cap: not a review, not a close-out task, not in a `QA fix` group. */
const isImplementationTask = (groupTitle, label, title) => !isQaGroup(groupTitle) && !isReviewTask(label, title) && !isCloseoutGroup(groupTitle) && !CLOSEOUT_RE.test(title || '');


/**
 * Plan rules. Returns [{ line, severity: error|warning|info, kind, text }].
 *   error   more implementation tasks than the Size cap allows (S 3, M 5, L 8; `QA fix` groups added by /spec-fix not counted)
 *   warning no Size line; a group review on an S/M change that is not marked (risky); an L change without the early
 *           review after group 1; no final review; agent close-out tasks that `finish` now does; consecutive
 *           implementation tasks on the same source file (merge them unless the test-first step differs in kind)
 */
function planLint(text, opts = {}) {
  const p = parsePlan(text); const out = [];
  if (opts.size) {
    // One source of truth: proposal.md. A Size line repeated in tasks.md must agree with it.
    if (p.size && p.size !== opts.size) out.push({ line: p.sizeLine, severity: 'error', kind: 'size-drift', text: `tasks.md says Size: ${p.size} but proposal.md says Size: ${opts.size}; the size lives in proposal.md: delete the Size line from tasks.md (or make them agree)` });
    p.size = opts.size; p.sizeLine = p.sizeLine || 1; p.sizeFrom = 'proposal.md';
  }
  const impl = p.groups.filter((g) => !g.qa).flatMap((g) => g.tasks.filter((t) => !t.review && !t.closeout));
  const reviews = p.groups.flatMap((g) => g.tasks.filter((t) => t.review).map((t) => ({ ...t, group: g })));
  if (!p.size) out.push({ line: 1, severity: 'warning', kind: 'size', text: `no "Size: S|M|L" line at the top of proposal.md; caps are S <= ${CAPS.S}, M <= ${CAPS.M}, L <= ${CAPS.L} implementation tasks (this plan has ${impl.length})` });
  else if (impl.length > CAPS[p.size]) out.push({ line: p.sizeLine, severity: 'error', kind: 'size-cap', text: `Size ${p.size} allows at most ${CAPS[p.size]} implementation tasks; this plan has ${impl.length}. Merge tasks that touch the same files or form one red/green/refactor cycle${p.size !== 'L' ? `, or set Size: ${p.size === 'S' ? 'M' : 'L'} in proposal.md and write the full artifacts.` : ', or split the change.'}` });
  const size = p.size || (impl.length <= CAPS.S ? 'S' : impl.length <= CAPS.M ? 'M' : 'L');
  const last = p.groups.length ? p.groups[p.groups.length - 1] : null;
  for (const r of reviews) {
    const isFinal = r.final || (last && r.group === last && r === reviews[reviews.length - 1]);
    if (isFinal) continue;
    const early = size === 'L' && r.group === p.groups.find((g) => g.tasks.some((t) => !t.review && !t.closeout));
    if (!r.group.risky && !early) out.push({ line: r.line, severity: 'warning', kind: 'review', text: `${r.label || r.title}: group review on a${size === 'L' ? 'n L' : 'n ' + size} change. Keep one final review of the whole change${size === 'L' ? ', the early review after group 1' : ''} and reviews after groups marked "(risky)" in their heading; delete this one` });
  }
  const hasFinal = reviews.some((r) => r.final || r === reviews[reviews.length - 1] && last && r.group === last);
  const needReview = opts.review === undefined ? size !== 'S' : opts.review;
  if (impl.length && opts.review === false && hasFinal) { const r = reviews[reviews.length - 1]; out.push({ line: r.line, severity: 'warning', kind: 'review', text: `${r.label || r.title}: no final review on this change (Size S, Risk none, no UI); a review task is for Size M/L, a Risk kind or a UI change. Delete it` }); }
  if (impl.length && needReview && !hasFinal) out.push({ line: last ? last.line : 1, severity: 'warning', kind: 'review', text: 'no final "Request code review of the whole change" task at the end (required for Size M/L, a Risk kind or a UI change)' });
  if (size === 'L') {
    const g1 = p.groups.find((g) => g.tasks.some((t) => !t.review && !t.closeout));
    if (g1 && !g1.tasks.some((t) => t.review) && p.groups.length > 1) out.push({ line: g1.line, severity: 'warning', kind: 'review', text: `Size L: end group ${g1.n} (the walking skeleton) with an early "Request code review for group ${g1.n}" task; it is the review that found real problems in the pilot` });
  }
  for (const g of p.groups) for (const t of g.tasks) if (t.closeout) out.push({ line: t.line, severity: 'warning', kind: 'closeout', text: `${t.label || t.title}: close-out task done by \`verify-task.cjs finish\` (full tests, typecheck, lint, validate, visual, trace, source-text rule) without an agent; delete it` });
  for (let i = 1; i < impl.length; i++) {
    const a = impl[i - 1]; const b = impl[i];
    const shared = a.files.filter((f) => !isTestPath(f) && b.files.includes(f));
    if (shared.length) out.push({ line: b.line, severity: 'warning', kind: 'merge', text: `${a.label} and ${b.label} both change ${shared.join(', ')}: merge them into one task unless the test-first step differs in kind (e.g. a unit test vs a DOM/visual check)` });
  }
  for (const t of impl) if (/\?raw\b|\bas text\b|readFileSync|\bregex(es)?\b[^.]*\.(vue|css|scss|svelte)\b/i.test(t.details['test first'] || '')) out.push({ line: t.line, severity: 'warning', kind: 'source-text', text: `${t.label}: Test first reads source code as text; test the rendered behaviour instead and put layout in a \`\`\`visual scenario (the verifier rejects source-text tests)` });
  return { size: p.size, implementation_tasks: impl.length, review_tasks: reviews.length, closeout_tasks: p.groups.flatMap((g) => g.tasks).filter((t) => t.closeout).length, problems: out };
}

// ---------- size tiers (proposal.md declares, the specs decide) ----------
const stripComments = (t) => String(t).replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
/** `Size: S|M|L` and `Risk: none|<kinds>` lines of proposal.md (first occurrence, comments ignored). */
function proposalSize(text) {
  const lines = stripComments(text).replace(/\r\n/g, '\n').split('\n');
  const out = { size: null, line: null, risk: null, riskLine: null };
  lines.forEach((l, i) => {
    let m;
    if (!out.size && (m = l.match(/^\s*(?:[-*]\s+)?\**Size\**:\s*\**\s*([SML])\b/i))) { out.size = m[1].toUpperCase(); out.line = i + 1; }
    if (out.risk === null && (m = l.match(/^\s*(?:[-*]\s+)?\**Risk\**:\s*\**\s*(.*?)\s*$/i))) {
      const v = m[1].replace(/[`*]/g, '').trim().toLowerCase();
      out.risk = /^(none|no|-|n\/a)?$/.test(v) ? [] : v.split(/\s*[,;/]\s*|\s+and\s+/).map((x) => x.trim().replace(/\s+/g, '-')).filter(Boolean);
      out.riskLine = i + 1;
    }
  });
  return out;
}
/** Section of a markdown text under `## <name>` (until the next ## heading). */
function section(text, re) {
  const lines = String(text).split('\n'); const out = []; let on = false;
  for (const l of lines) { if (/^##\s/.test(l)) { on = re.test(l.replace(/^##\s+/, '')); continue; } if (on) out.push(l); }
  return out.join('\n');
}
const RISK_WORDS = /\b(payments?|refunds?|invoices?|billing|discounts?|currenc(?:y|ies)|money|passwords?|authenticat\w*|authori[sz]\w*|encrypt\w*|secrets?|credentials?|migrat\w*|concurren\w*|race conditions?|public api)\b/i;
const readIf = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
/**
 * The "no architectural decision" record of a change (`adrs/none.md`, `status: none`): it is not an ADR. It counts as
 * none when the file is named none.md, when its front matter says `status: none` (any case), or both. Every ADR count and
 * list in the scripts and in the extension goes through this one function.
 */
function isNoneAdr(fileName, text) {
  if (String(fileName || '').toLowerCase() === 'none.md') return true;
  const fm = String(text || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const st = fm ? (fm[1].match(/^status:[ \t]*(.*)$/mi) || [])[1] : '';
  return String(st || '').trim().replace(/^["']|["']$/g, '').toLowerCase() === 'none';
}

/** What the change's artifacts contain. */
function sizeFacts(changeDir, opts = {}) {
  const proposal = readIf(path.join(changeDir, 'proposal.md'));
  const ps = proposal ? proposalSize(proposal) : { size: null, risk: null };
  const specsDir = path.join(changeDir, 'specs');
  const caps = fs.existsSync(specsDir) ? fs.readdirSync(specsDir).filter((c) => fs.existsSync(path.join(specsDir, c, 'spec.md'))).sort() : [];
  let requirements = 0; let visual = 0; let breakingSpecs = false;
  for (const c of caps) {
    const t = fs.readFileSync(path.join(specsDir, c, 'spec.md'), 'utf8').replace(/\r\n/g, '\n');
    let sec = ''; let fence = false;
    for (const l of t.split('\n')) {
      const fm = l.match(/^\s*(`{3,}|~{3,})\s*(\S*)/);
      if (fm) { if (!fence && /^visual$/i.test(fm[2])) visual++; fence = !fence; continue; }
      if (fence) continue;
      let m;
      if ((m = l.match(/^##\s+(.*?)\s*$/))) { sec = m[1]; continue; }
      if (/^###\s+Requirement:/.test(l) && /^(ADDED|MODIFIED)\b/i.test(sec)) requirements++;
      if (/^(REMOVED)\b/i.test(sec) && /^###\s+Requirement:/.test(l)) breakingSpecs = true;
    }
  }
  const what = proposal ? stripComments(section(proposal, /^what changes/i)) : '';
  const breaking = /\*\*BREAKING\*\*|\bBREAKING\b/.test(what) || breakingSpecs;
  const adrDir = path.join(changeDir, 'adrs');
  const adrs = fs.existsSync(adrDir) ? fs.readdirSync(adrDir).filter((f) => f.endsWith('.md') && !isNoneAdr(f, readIf(path.join(adrDir, f)) || '')) : [];
  const tasks = readIf(path.join(changeDir, 'tasks.md'));
  const plan = tasks ? parsePlan(tasks) : null;
  const riskyGroups = plan ? plan.groups.filter((g) => g.risky && !g.qa).map((g) => g.title) : [];
  const words = proposal ? [...new Set((stripComments(section(proposal, /^(why|what changes|impact)/i)).match(new RegExp(RISK_WORDS.source, 'gi')) || []).map((w) => w.toLowerCase()))] : [];
  const design = readIf(path.join(changeDir, 'design.md')); const appMap = readIf(path.join(changeDir, 'app-map.md'));
  const files = plan ? [...new Set(plan.groups.flatMap((g) => g.tasks.flatMap((t) => t.files)))] : [];
  return {
    files, has_design: design !== null, has_app_map: appMap !== null, has_adr_file: fs.existsSync(adrDir) && fs.readdirSync(adrDir).some((x) => x.endsWith('.md')),
    spec_only: /^\s*(?:[-*]\s+)?\**Kind\**:\s*\**spec-only\b/mi.test(proposal || ''), upgrade: opts.upgrade || null,
    declared: ps.size, declared_line: ps.line, risk: ps.risk, tasks_size: plan ? plan.size : null,
    capabilities: caps, requirements, visual_blocks: visual, breaking, adrs, risky_groups: riskyGroups, risk_words: words,
    design_sections: design ? [...design.matchAll(/^##\s+(.*?)\s*$/gm)].map((m) => m[1].toLowerCase()) : null,
    app_map_sections: appMap ? [...appMap.matchAll(/^##\s+(.*?)\s*$/gm)].map((m) => m[1].toLowerCase()) : null,
    has_proposal: !!proposal,
    is_slice: /^Slice:\s*\S/m.test(proposal || ''),
  };
}
const ORDER = { S: 0, M: 1, L: 2 };
/** Paths where a small change is no longer small: auth, sessions, permissions, money, schema/migrations, secrets, tokens, API specs, dependency manifests. */
const SENSITIVE_RE = /(^|[/_.-])(auth\w*|session\w*|passw\w*|permission\w*|rbac|acl|payment\w*|billing|money|migrat\w*|schema\w*|secret\w*|credential\w*|token\w*|openapi|swagger)([/_.-]|$)|(^|\/)(\.env\S*|package(-lock)?\.json|requirements\.txt|pyproject\.toml|go\.(mod|sum)|Cargo\.(toml|lock)|composer\.(json|lock)|Gemfile(\.lock)?|pom\.xml|build\.gradle\S*|yarn\.lock|pnpm-lock\.yaml)$/i;
const isSensitivePath = (f) => !isTestPath(f) && SENSITIVE_RE.test(f);
/**
 * The planning path of a change. `fast`: Size S, Risk none, no sensitive path, no UI, no dependency manifest: it needs no
 * design.md, no `adrs/none.md`, no app-map.md. Everything else is `full`. `review`: a final code-review task is required
 * (Size M/L, a Risk kind, or UI). `upgrade` (recorded by `check` when an edit left the fast path) forces `full`.
 */
function planPath(f) {
  const req = requiredSize(f).size; const size = f.declared && ORDER[f.declared] >= ORDER[req] ? f.declared : req;
  const ui = f.visual_blocks > 0 || f.files.some((x) => isUiFile(x) && !isTestPath(x));
  const risk = !!(f.risk && f.risk.length);
  const reasons = [];
  if (!f.declared) reasons.push('no Size line');
  if (size !== 'S') reasons.push(`Size: ${size}`);
  if (f.has_proposal && f.risk === null) reasons.push('no Risk line');
  if (risk) reasons.push(`Risk: ${f.risk.join(', ')}`);
  if (ui) reasons.push('UI change');
  const sens = f.files.filter(isSensitivePath);
  if (sens.length) reasons.push(`sensitive path: ${sens.join(', ')}`);
  if (f.upgrade) reasons.push(...f.upgrade.reasons);
  return { path: reasons.length ? 'full' : 'fast', reasons, review: size !== 'S' || risk || ui };
}
/** Full path: design.md, an ADR record (`adrs/none.md` counts) and app-map.md exist. */
function pathArtifactProblems(f, p) {
  if (p.path === 'fast' || !f.has_proposal || !f.declared || f.is_slice || f.spec_only) return [];
  const miss = [!f.has_app_map && 'app-map.md', !f.has_design && 'design.md', !f.has_adr_file && 'adrs/none.md (or the ADRs)'].filter(Boolean);
  return miss.length ? [{ line: 1, severity: 'error', kind: 'path-artifacts', file: 'proposal.md', text: `full planning path (${p.reasons.join('; ')}): missing ${miss.join(', ')}. Write them (a Size S change keeps them to a few lines); only Size S + Risk none + no sensitive path + no UI skips them` }] : [];
}
/** The size the facts require: { size, reasons: { S|M|L: [why] } } */
function requiredSize(f) {
  const L = []; const M = [];
  if (f.capabilities.length > SIZE_RULES.M_MAX_CAPABILITIES) L.push(`${f.capabilities.length} capabilities (${f.capabilities.join(', ')}; 3+ is L)`);
  if (f.breaking) L.push('a BREAKING change (proposal What Changes, or a REMOVED requirement)');
  if (f.risk && f.risk.length) L.push(`Risk: ${f.risk.join(', ')} (any risk is L)`);
  if (f.risky_groups.length) L.push(`tasks.md group(s) marked (risky): ${f.risky_groups.join('; ')}`);
  if (f.capabilities.length > SIZE_RULES.S_MAX_CAPABILITIES) M.push(`${f.capabilities.length} capabilities (S is 1)`);
  if (f.requirements > SIZE_RULES.S_MAX_REQUIREMENTS) M.push(`${f.requirements} requirements (S is at most ${SIZE_RULES.S_MAX_REQUIREMENTS})`);
  if (f.visual_blocks) M.push(`${f.visual_blocks} visual scenario block(s) (any UI change with visual scenarios is at least M)`);
  if (f.adrs.length) M.push(`ADR(s) ${f.adrs.join(', ')} (S has none)`);
  return { size: L.length ? 'L' : M.length ? 'M' : 'S', reasons: { L, M } };
}
/** Problems: declared size below what the specs need (error), no Size line (warning), risk words with Risk: none
 *  (warning), an M/L change still carrying the light S artifacts (error). */
function sizeCheck(f) {
  const out = []; const req = requiredSize(f);
  const declared = f.declared || f.tasks_size;
  if (!f.declared && f.has_proposal) out.push({ line: 1, severity: 'warning', kind: 'size', file: 'proposal.md', text: `proposal.md has no "Size: S|M|L" line; by the specs this change is Size: ${req.size}${req.size !== 'S' ? ` (${[...req.reasons.L, ...req.reasons.M].join('; ')})` : ''}` });
  if (declared && ORDER[declared] < ORDER[req.size]) {
    const why = [...req.reasons.L, ...(req.size === 'M' ? req.reasons.M : [])].join('; ');
    out.push({ line: f.declared_line || 1, severity: 'error', kind: 'size-under', file: 'proposal.md', text: `proposal.md declares Size: ${declared} but the change needs Size: ${req.size}: ${why}. Change the line to "Size: ${req.size}" in proposal.md and write the full artifacts for ${req.size}: app-map (every section), design (every section), one ADR per significant decision (or adrs/none.md); task cap ${CAPS[req.size]}. Then run lint again.` });
  }
  if (f.has_proposal && f.risk === null && f.declared) out.push({ line: f.declared_line || 1, severity: 'warning', kind: 'risk', file: 'proposal.md', text: `proposal.md has no "Risk:" line under Size: write "Risk: none" or the kinds that apply (${RISKS.join(', ')}); any risk makes the change Size: L` });
  if (f.risk && !f.risk.length && f.risk_words.length) out.push({ line: f.declared_line || 1, severity: 'warning', kind: 'risk', file: 'proposal.md', text: `proposal.md says Risk: none but mentions ${f.risk_words.join(', ')}. If the change handles security, money, a data migration, concurrency or a public API, declare it on the Risk: line (that makes it Size: L); otherwise ignore this warning` });
  const eff = declared && ORDER[declared] >= ORDER[req.size] ? declared : req.size;
  if (eff !== 'S' && !f.is_slice) { // a slice builds specs and ADRs that already exist: the light documents are enough
    if (f.design_sections && !f.design_sections.some((s) => /^decisions\b/.test(s))) out.push({ line: 1, severity: 'error', kind: 'size-artifacts', file: 'design.md', text: `Size: ${eff} needs the full design.md: it has no "## Decisions" section (only Size: S may cut design.md to Implementation guide and Pitfalls)` });
    if (f.app_map_sections && !f.app_map_sections.some((s) => /^capability inventory\b/.test(s))) out.push({ line: 1, severity: 'error', kind: 'size-artifacts', file: 'app-map.md', text: `Size: ${eff} needs the full app-map.md: it has no "## Capability inventory" section (only Size: S may cut the app map to two lines)` });
  }
  const pp = planPath(f); out.push(...pathArtifactProblems(f, pp));
  return { declared, required: req.size, reasons: req.reasons, path: pp, problems: out };
}

/** The two-line app map of a Size S change, built from its specs and proposal (no agent writes it). */
function appMapText(changeDir, mainSpecsDir) {
  const f = sizeFacts(changeDir); const proposal = readIf(path.join(changeDir, 'proposal.md')) || '';
  const why = stripComments(section(proposal, /^why/i)).replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0].replace(/[.!?]$/, '').slice(0, 140) || 'see proposal.md';
  const have = fs.existsSync(mainSpecsDir) ? fs.readdirSync(mainSpecsDir).filter((c) => fs.existsSync(path.join(mainSpecsDir, c, 'spec.md'))).sort() : [];
  return `This change: ${f.capabilities[0] || '<capability>'} - ${why}\nFits: ${have.length ? have.slice(0, 8).join(', ') + (have.length > 8 ? ', ...' : '') : 'a new app, no capability exists yet'}; deferred: nothing\n`;
}

// ---------- invariant scenarios ----------
// Whole words only: an identifier, test id or quoted UI text (`discountCode`, DISCOUNT_UNKNOWN, `total-row`,
// "Total: €5", localStorage) is not a keyword. Strong verbs always count; the weak nouns (total, sum, filter,
// discount) count only when the requirement is not display-only UI (it shows, renders or labels something
// and does no strong data work itself).
const W = (alts) => new RegExp(`(?<![\\w$.\\-/])(${alts})(?![\\w$\\-/])`, 'i');
const TRANSFORM_RE = W('calculat(?:e|es|ed|ing|ion|ions)|comput(?:e|es|ed|ing|ation)|appl(?:y|ies|ied|ying)|transform(?:s|ed|ing)?|convert(?:s|ed|ing)?|sort(?:s|ed|ing)?|merg(?:e|es|ed|ing)|round(?:s|ed|ing)|normali[sz](?:e|es|ed|ing)|pars(?:e|es|ed|ing)|seriali[sz](?:e|es|ed|ing)|stor(?:e|es|ed|ing)|sav(?:e|es|ed|ing)|persist(?:s|ed|ing)?|deduplicat(?:e|es|ed|ing)|aggregat(?:e|es|ed|ing)');
const WEAK_RE = W('totals?|sums?|filter(?:s|ed|ing)?|discount(?:s|ed|ing)?');
const DISPLAY_RE = W('show(?:s|n|ing)?|print(?:s|ed|ing)?|display(?:s|ed|ing)?|render(?:s|ed|ing)?|label(?:s|led|ed)?|visible|reads?|announce(?:s|d)?|heading|button|badge|link|icon|dialog|panel|banner|message|tooltip|focus(?:es|ed)?');
/** Statement text with code spans, quoted UI text and links removed, so only prose words are matched. */
function prose(stmt) { return stmt.replace(/`[^`]*`/g, ' ').replace(/"[^"]*"|“[^”]*”/g, ' ').replace(/\[[^\]]*\]\([^)]*\)/g, ' '); }
/** The keyword that makes a requirement data-transforming, or null (display-only UI or no keyword). */
function transformWord(stmt) {
  const t = prose(stmt);
  const strong = t.match(TRANSFORM_RE); if (strong) return strong[1];
  const weak = t.match(WEAK_RE); if (weak && !DISPLAY_RE.test(t)) return weak[1];
  return null;
}
const INVARIANT_NAME = /^invariant\b|\b(unchanged|not (?:be )?(?:mutated|modified|changed)|unmodified|immutab\w*|idempot\w*|determinis\w*|same result|shares? no)\b/i;
/** Requirements (ADDED/MODIFIED) whose statement transforms or stores data but that have no invariant scenario. */
function invariantLint(dir) {
  const out = [];
  if (!dir || !fs.existsSync(dir)) return out;
  for (const cap of fs.readdirSync(dir).sort()) {
    const f = path.join(dir, cap, 'spec.md'); if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').split('\n');
    let sec = ''; let req = null; let fence = false;
    const flush = () => { if (req && /^(ADDED|MODIFIED)\b/i.test(req.sec) && (req.word = transformWord(req.stmt)) && !req.scen.some((n) => INVARIANT_NAME.test(n))) out.push({ file: f, line: req.line, severity: 'warning', kind: 'invariant', text: `${cap}/spec.md:${req.line}: requirement "${req.name}" says "${req.word}" (it computes, transforms or stores data) but has no invariant scenario: add "#### Scenario: Invariant: <what always holds>" (input not modified and sharing no mutable objects with the result, same input -> same result, order, rounding), or ignore this if it only displays data` }); req = null; };
    lines.forEach((l, i) => {
      if (/^\s*(`{3,}|~{3,})/.test(l)) { fence = !fence; return; }
      if (fence) return;
      let m;
      if ((m = l.match(/^##\s+(.*?)\s*$/))) { flush(); sec = m[1]; return; }
      if ((m = l.match(/^###\s+Requirement:\s*(.*?)\s*$/))) { flush(); req = { name: m[1], line: i + 1, sec, stmt: '', scen: [], inScen: false }; return; }
      if (!req) return;
      if ((m = l.match(/^####\s+Scenario:\s*(.*?)\s*$/))) { req.scen.push(m[1]); req.inScen = true; return; }
      if (!req.inScen) req.stmt += ' ' + l;
    });
    flush();
  }
  return out;
}

// ---------- edge cases named by the user (proposal.md ## Edge cases) ----------
const EDGE_WORDS = W('long(?:est|er)?|empty|blank|errors?|invalid|many|lots|overflow(?:s|ing)?|wrap(?:s|ping)?|truncat(?:e|es|ed|ing|ion)?|zero|maximum|minimum|max|min|limits?|boundar(?:y|ies)|duplicates?|missing|offline|slow|unicode|emoji|negative');
const UI_EDGE = W('long(?:est|er)?|overflow(?:s|ing)?|wrap(?:s|ping)?|truncat(?:e|es|ed|ing|ion)?|many|lots|narrow|phones?|mobile|375(?:px)?|empty|errors?');
const ARROW_ID = /(?:->|→|=>)\s*((?:`?[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*`?(?:\s*[,;]\s*|\s+and\s+|\s*))+)\s*$/i;
const EDGE_STOP = new Set(['with', 'that', 'this', 'when', 'than', 'from', 'into', 'shows', 'show', 'state', 'data', 'testid', 'fill', 'click', 'wait', 'type', 'press', 'item', 'items', 'text',
  'the', 'and', 'for', 'not', 'any', 'all', 'new', 'add', 'set', 'get', 'via', 'per', 'out', 'use', 'its', 'are', 'was', 'has', 'can', 'may', 'but', 'off', 'too', 'see', 'one', 'two', 'yes', 'own', 'who', 'how', 'why', 'you', 'our', 'own']);
const NUMBER_WORD = { 0: 'zero', 1: 'single' };
/**
 * Content words of an edge case or a state (name + do: steps), singular, 3+ letters (common short words dropped), for
 * matching one to the other. "1"/"one"/"single" all become "single" and "0"/"no"/"none" become "zero", so the edge case
 * "1 item in the list" matches `state: one-item` and "no results" matches `state: zero-results`.
 */
function edgeTokens(t) {
  return new Set(String(t).toLowerCase().split(/[^a-z0-9]+/)
    .map((w) => (NUMBER_WORD[w] !== undefined ? NUMBER_WORD[w] : w === 'one' ? 'single' : w === 'no' || w === 'none' ? 'zero' : w))
    .map((w) => w.replace(/(ies)$/, 'y').replace(/([^s])s$/, '$1'))
    .filter((w) => (w.length >= 3 || w === 'no') && !EDGE_STOP.has(w) && !/^\d{1,2}$/.test(w)));
}
/** One stem per edge word family (longer -> long, maximum -> max, limits -> limit), to compare whole words. */
function edgeStem(w) {
  w = String(w).toLowerCase();
  for (const [re, st] of [[/^long(?:est|er)?$/, 'long'], [/^overflow/, 'overflow'], [/^wrap/, 'wrap'], [/^truncat/, 'truncat'], [/^boundar/, 'boundary'], [/^max(?:imum)?$/, 'max'], [/^min(?:imum)?$/, 'min'], [/^error/, 'error'], [/^limit/, 'limit'], [/^duplicate/, 'duplicate']]) if (re.test(w)) return st;
  return w.replace(/([^s])s$/, '$1');
}
const stemsOf = (t) => new Set(String(t).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map(edgeStem));
/** Sections that are not this change's behaviour: current state, non-goals, deferred work, glossary, risks, migration. */
const EDGE_SKIP_HEAD = /^(?:context|background|current state|non-?goals?|out of scope|deferred(?: work)?|later|future(?: work)?|not in (?:this change|scope)|glossary|migration(?: plan)?|risks?(?:\s*[/&]\s*trade-?offs)?|trade-?offs|open questions|alternatives(?: considered)?)\b/i;
/** Inline labels with the same meaning ("**Non-Goals:** sorting, stock limits."): the rest of the line is skipped. */
const EDGE_SKIP_LABEL = /(^|[\s*_(-])(?:\*\*|__)?(?:non-?goals?|out of scope|deferred|later|future(?: work)?|not in (?:this change|scope))(?:\*\*|__)?\s*:.*$/gim;
/**
 * The prose of a plan document where an edge word means a case the change must handle: skips the sections above and
 * inline Non-Goals/Deferred labels, sentences whose outcome is an error code a scenario asserts (`missing ->
 * DISCOUNT_UNKNOWN`), CSS values (`max 1200px`, `min(500, s)`), code spans, quoted UI text and links.
 */
function edgeProse(t, codes) {
  const out = []; let skip = false;
  for (const raw of stripComments(t).replace(/\r\n/g, '\n').split('\n')) {
    const h = raw.match(/^#{1,6}\s+(.*?)\s*$/);
    if (h) { skip = EDGE_SKIP_HEAD.test(h[1].replace(/[*_`]/g, '')); continue; }
    if (skip) continue;
    const line = raw.replace(EDGE_SKIP_LABEL, '$1');
    for (const sent of line.split(/(?<=[.;!?])\s+/)) {
      const cs = [...sent.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map((m) => m[1]);
      if (cs.some((c) => codes.has(c))) continue;
      out.push(prose(sent
        .replace(/\b(?:max|min)(?:imum)?(?:[- ](?:width|height|size))?\s*[:=]?\s*-?\d+(?:\.\d+)?\s*(?:px|rem|em|%|vw|vh|ch|pt)\b/gi, ' ')
        .replace(/\b(?:max|min|minmax|clamp)\s*\(/gi, ' (')));
    }
  }
  return out.join('\n');
}
/** What the change's scenarios already say (titles, WHEN/THEN/AND lines, visual state names) and the codes they assert. */
function scenarioWords(specsDir) {
  let txt = ''; const codes = new Set();
  if (!specsDir || !fs.existsSync(specsDir)) return { stems: new Set(), codes };
  for (const cap of fs.readdirSync(specsDir).sort()) {
    const f = path.join(specsDir, cap, 'spec.md'); if (!fs.existsSync(f)) continue;
    for (const l of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      let m;
      if ((m = l.match(/^####\s+Scenario:\s*(.*)$/)) || (m = l.match(/^\s*[-*]\s+\*\*(?:WHEN|THEN|AND|GIVEN|BUT)\*\*\s*(.*)$/)) || (m = l.match(/^state:\s*(\S+)/))) {
        txt += ' ' + m[1].replace(/-/g, ' ');
        for (const c of m[1].matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)) codes.add(c[1]);
      }
    }
  }
  return { stems: stemsOf(txt), codes };
}

/** Lines of `lines` without the section whose `## ` heading matches `re` (its items name edge words by design). */
function withoutSection(lines, re) {
  const out = []; let skip = false;
  for (const l of lines) { if (/^##\s/.test(l)) skip = re.test(l); if (!skip) out.push(l); }
  return out;
}
/**
 * proposal.md `## Edge cases`: one bullet per edge case or boundary the request or the user's answers name, each ending
 * with `-> <capability>/<scenario-slug>[, ...]`. Returns { items, problems }. opts.visual: Map id -> { states } of the
 * change's visual scenarios (UI edge cases must point at a visual scenario with a state that holds that content).
 */
function edgeLint(changeDir, opts = {}) {
  const out = []; const items = [];
  const prop = readIf(path.join(changeDir, 'proposal.md'));
  if (prop === null) return { items, problems: out };
  const text = stripComments(prop).replace(/\r\n/g, '\n'); const lines = text.split('\n');
  const start = lines.findIndex((l) => /^##\s+Edge cases\b/i.test(l));
  // A slice change (proposal line "Slice: <id>") has no specs of its own: its edge cases are scenarios of the living specs.
  const isSlice = /^Slice:\s*\S/m.test(text);
  const scen = new Map(specScenarios(isSlice ? path.join(changeDir, '..', '..', 'specs') : path.join(changeDir, 'specs')).map((x) => [x.id, x]));
  const hasVisual = opts.visual && opts.visual.size > 0;
  if (start < 0 && isSlice) return { items, problems: out };
  if (start < 0) {
    out.push({ file: 'proposal.md', line: 1, severity: 'error', kind: 'edge-cases', text: 'proposal.md has no "## Edge cases" section: list every edge case or boundary the request or the user\'s answers name (long text, empty, error, many items, limits, invalid input), one bullet each ending with "-> <capability>/<scenario-slug>" (the scenario that proves it), or "- none named"' });
    return { items, problems: out };
  }
  let none = false;
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    const b = lines[i].match(/^\s*[-*]\s+(.*\S)\s*$/); if (!b) continue;
    if (/^none\b/i.test(b[1].replace(/[`*_]/g, ''))) { none = true; continue; }
    const m = b[1].match(ARROW_ID);
    const ids = m ? m[1].split(/\s*[,;]\s*|\s+and\s+|\s+/).map((x) => x.replace(/`/g, '').trim()).filter(Boolean) : [];
    const desc = m ? b[1].slice(0, m.index).trim() : b[1];
    const item = { line: i + 1, text: desc, ids, ui: UI_EDGE.test(desc) };
    items.push(item);
    if (!ids.length) { out.push({ file: 'proposal.md', line: i + 1, severity: 'error', kind: 'edge-cases', text: `proposal.md:${i + 1}: edge case "${desc.slice(0, 80)}" names no scenario: end the bullet with "-> <capability>/<scenario-slug>" and give that case its own scenario in the specs (Size never removes one)` }); continue; }
    const unknown = ids.filter((id) => !scen.has(id));
    if (unknown.length) out.push({ file: 'proposal.md', line: i + 1, severity: 'error', kind: 'edge-cases', text: `proposal.md:${i + 1}: edge case "${desc.slice(0, 80)}" points at ${unknown.join(', ')}, which is not a scenario of this change (scenario ids are <capability>/<slug of the scenario name>)` });
    if (item.ui && hasVisual && !unknown.length) {
      const want = edgeTokens(desc);
      const ok = ids.some((id) => { const v = opts.visual.get(id); return v && v.states.some((st) => st.name !== 'default' && (st.steps.length || st.keys.length) && [...edgeTokens(`${st.name} ${JSON.stringify(st.steps)}`)].some((w) => want.has(w))); });
      if (!ok) out.push({ file: 'proposal.md', line: i + 1, severity: 'error', kind: 'edge-cases', text: `proposal.md:${i + 1}: UI edge case "${desc.slice(0, 80)}" needs a visual scenario with a state that shows it (e.g. \`state: long-name\` with \`do:\` steps that add an item with the long text, checked at 375; the state name or its steps should name the case): none of ${ids.join(', ')} has one` });
    }
  }
  // Edge words elsewhere in the plan that neither the Edge cases list nor a scenario mentions (a hint, not proof):
  // whole words, only where they describe this change (not Context, Non-Goals, deferred work, risks), not CSS values.
  const sw = scenarioWords(path.join(changeDir, 'specs'));
  const covered = new Set([...stemsOf(items.map((x) => x.text).join(' ')), ...sw.stems]);
  let end = start + 1; while (end < lines.length && !/^##\s/.test(lines[end])) end++;
  const elsewhere = [['proposal.md', withoutSection(lines.slice(0, start).concat(lines.slice(end)), /^##\s+UX checklist\b/i).join('\n')], ['design.md', readIf(path.join(changeDir, 'design.md')) || ''], ['design-map.md', readIf(path.join(changeDir, 'design-map.md')) || '']];
  const missed = new Set();
  for (const [, t] of elsewhere) for (const m of edgeProse(t, sw.codes).matchAll(new RegExp(EDGE_WORDS.source, 'gi'))) { const w = m[1].toLowerCase(); if (!covered.has(edgeStem(w))) missed.add(w); }
  if (missed.size && (none || items.length)) out.push({ file: 'proposal.md', line: start + 1, severity: 'warning', kind: 'edge-cases', text: `proposal.md:${start + 1}: the plan mentions ${[...missed].slice(0, 6).map((w) => `"${w}"`).join(', ')} but neither the Edge cases list nor a scenario does; if the request or the user's answers name such a case, list it with its scenario` });
  return { items, problems: out };
}

// ---------- UX checklist (proposal.md ## UX checklist, UI-facing changes only) ----------
const UX_ITEMS = ['loading', 'empty', 'error', 'disabled', 'validation', 'recovery', 'keyboard', 'narrow', 'long-text'];
/** UI files named by the `Files:` lines of tasks.md (test files do not count). */
function taskUiFiles(changeDir) {
  const t = readIf(path.join(changeDir, 'tasks.md')); if (t === null) return [];
  const out = new Set();
  for (const l of stripComments(t).split(/\r?\n/)) { const m = l.match(/^\s*[-*]\s+Files:\s*(.*)$/i); if (m) for (const f of m[1].matchAll(/[\w@./$()[\]-]+\.\w+/g)) if (isUiFile(f[0]) && !isTestPath(f[0])) out.add(f[0]); }
  return [...out];
}
/**
 * UX checklist of a UI-facing change (it has visual scenarios or its tasks name UI files), as warnings only. proposal.md has
 * `## UX checklist` with one line per item (UX_ITEMS): `- <item>: scenario <capability>/<slug>[, ...]` (a scenario of this
 * change) or `- <item>: Not applicable: <reason>` (a reason of 3+ words). A change without UI is never checked; a slice change
 * is not either (its capability answered it). opts.visual: Map of the change's visual scenarios.
 */
function uxLint(changeDir, opts = {}) {
  const out = []; const prop = readIf(path.join(changeDir, 'proposal.md'));
  if (prop === null) return out;
  const text = stripComments(prop).replace(/\r\n/g, '\n');
  if (/^Slice:\s*\S/m.test(text)) return out;
  const vis = opts.visual ? [...opts.visual.keys()] : []; const ui = taskUiFiles(changeDir);
  if (!vis.length && !ui.length) return out;
  const why = vis.length ? `visual scenarios ${vis.slice(0, 2).join(', ')}${vis.length > 2 ? ', ...' : ''}` : `UI files ${ui.slice(0, 2).join(', ')}${ui.length > 2 ? ', ...' : ''}`;
  const form = 'one line per item: `- <item>: scenario <capability>/<slug>` or `- <item>: Not applicable: <reason>`';
  const lines = text.split('\n'); const start = lines.findIndex((l) => /^##\s+UX checklist\b/i.test(l));
  if (start < 0) { out.push({ file: 'proposal.md', line: 1, severity: 'warning', kind: 'ux-checklist', text: `proposal.md: this change is UI-facing (${why}) but has no "## UX checklist" section: answer ${UX_ITEMS.join(', ')}, ${form}` }); return out; }
  const scen = new Set(specScenarios(path.join(changeDir, 'specs')).map((x) => x.id)); const seen = new Set();
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i++) {
    const m = lines[i].match(/^\s*[-*]\s+`?([a-z][a-z -]*?)`?\s*:\s*(.*\S)\s*$/i); if (!m) continue;
    const item = m[1].toLowerCase().replace(/[ _]+/g, '-'); if (!UX_ITEMS.includes(item)) continue;
    seen.add(item); const ans = m[2].replace(/[*_]/g, '');
    const na = ans.match(/^`?not applicable`?\s*[:\-–]\s*(.*)$/i); const sc = ans.match(/^scenarios?\s+(.*)$/i);
    if (na) { if (na[1].trim().split(/\s+/).filter((w) => /\w/.test(w)).length < 3) out.push({ file: 'proposal.md', line: i + 1, severity: 'warning', kind: 'ux-checklist', text: `proposal.md:${i + 1}: UX checklist "${item}": "Not applicable" needs the reason this screen has none (3+ words, e.g. "static list, no network call")` }); }
    else if (sc) { const ids = sc[1].replace(/`/g, '').split(/\s*[,;]\s*|\s+and\s+|\s+/).filter(Boolean); const bad = ids.filter((id) => !scen.has(id)); if (!ids.length || bad.length) out.push({ file: 'proposal.md', line: i + 1, severity: 'warning', kind: 'ux-checklist', text: `proposal.md:${i + 1}: UX checklist "${item}" names ${bad.length ? bad.join(', ') : 'no scenario'}, which is not a scenario of this change (ids are <capability>/<slug of the scenario name>)` }); }
    else out.push({ file: 'proposal.md', line: i + 1, severity: 'warning', kind: 'ux-checklist', text: `proposal.md:${i + 1}: UX checklist "${item}": write \`scenario <capability>/<slug>\` or \`Not applicable: <reason>\`` });
  }
  const miss = UX_ITEMS.filter((x) => !seen.has(x));
  if (miss.length) out.push({ file: 'proposal.md', line: start + 1, severity: 'warning', kind: 'ux-checklist', text: `proposal.md:${start + 1}: UX checklist has no answer for ${miss.join(', ')}: ${form}` });
  return out;
}

// ---------- accessible names (a hint at check time) ----------
const NAMED_TAG = /<(button|a|summary|label|h[1-6]|[A-Z][A-Za-z]*(?:Button|Link))\b([^>]*?)\s(?::|v-bind:)?aria-label\s*=\s*("[^"]*"|'[^']*'|\{[^}]*\})([^>]*)>([\s\S]*?)<\/\1\s*>/g;
/**
 * Controls with an aria-label AND visible text in a markup file: the aria-label replaces the visible text as the
 * accessible name, which then often fails WCAG 2.5.3 (axe label-content-name-mismatch: the name must contain the
 * visible text; voice control users say what they see). Visually hidden and aria-hidden children do not count as
 * visible. Returns [{ line, tag, label, visible, text }].
 */
function ariaLabelFindings(abs, rel) {
  let src; try { src = fs.readFileSync(abs, 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const m of src.matchAll(NAMED_TAG)) {
    if (/\/\s*$/.test(m[4])) continue;
    let inner = m[5];
    for (let i = 0; i < 3; i++) inner = inner.replace(/<(\w[\w-]*)\b[^>]*(?:aria-hidden\s*=\s*["']?true|class\s*=\s*["'][^"']*\b(?:sr-only|visually-hidden|screen-reader-text)\b)[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
    const visible = inner.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\{\{\s*(['"])\s*\1\s*\}\}/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim();
    if (!/[\p{L}\p{N}]|\{\{/u.test(visible)) continue;
    const line = src.slice(0, m.index).split('\n').length;
    out.push({ line, tag: m[1], label: m[3], visible: visible.slice(0, 60), text: `${rel}:${line}: <${m[1]}> has aria-label=${m[3].slice(0, 60)} and visible text "${visible.slice(0, 60)}": the aria-label replaces the visible text as its accessible name, which must contain that text (axe label-content-name-mismatch). Drop the aria-label and extend the visible text with visually hidden text that starts with an explicit space ({{ ' ' }} or &nbsp;, e.g. Cart<span class="sr-only">{{ ' ' }}{{ n }} items</span>), mark a decorative badge aria-hidden="true", or use aria-describedby` });
  }
  return out;
}

/** New capabilities (no folder in <root>/openspec/specs) need `## Purpose` of 50+ characters, or `openspec validate --strict` fails on the main spec after sync/archive. */
function purposeLint(changeDir, mainSpecsDir) {
  const out = []; const dir = path.join(changeDir, 'specs');
  if (!fs.existsSync(dir)) return out;
  for (const cap of fs.readdirSync(dir).sort()) {
    const f = path.join(dir, cap, 'spec.md'); if (!fs.existsSync(f)) continue;
    if (mainSpecsDir && fs.existsSync(path.join(mainSpecsDir, cap, 'spec.md'))) continue;
    const t = stripComments(fs.readFileSync(f, 'utf8')).replace(/\r\n/g, '\n');
    const m = t.match(/^##\s+Purpose\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/m);
    const body = m ? m[1].replace(/\s+/g, ' ').trim() : null;
    const line = m ? t.slice(0, m.index).split('\n').length : 1;
    if (body === null) out.push({ file: f, line: 1, severity: 'warning', kind: 'purpose', text: `specs/${cap}/spec.md: new capability without "## Purpose": archive then writes a "TBD" placeholder into openspec/specs/${cap}/spec.md; add one or two sentences (50+ characters)` });
    else if (body.length < 50) out.push({ file: f, line, severity: 'error', kind: 'purpose', text: `specs/${cap}/spec.md:${line}: "## Purpose" has ${body.length} characters; \`openspec validate --strict\` on the synced main spec needs 50+ (archive fails late otherwise): write one or two full sentences` });
  }
  return out;
}

/**
 * THEN/AND lines that promise a result without naming it ("handled gracefully", "works as expected"): info only.
 * A line with a quoted value, a number or a code span is concrete enough and never flagged.
 */
const VAGUE_THEN = /\b(gracefully|properly|correctly|appropriately|appropriate|as expected|successfully|works|handled|handles)\b/i;
function thenLint(changeDir) {
  const out = []; const dir = path.join(changeDir, 'specs');
  if (!fs.existsSync(dir)) return out;
  for (const cap of fs.readdirSync(dir).sort()) {
    const f = path.join(dir, cap, 'spec.md'); if (!fs.existsSync(f)) continue;
    stripComments(fs.readFileSync(f, 'utf8')).replace(/\r\n/g, '\n').split('\n').forEach((l, i) => {
      const m = /^\s*[-*]\s+\*\*(THEN|AND)\*\*\s+(.*)$/.exec(l); if (!m || /"[^"]+"|“[^”]+”|`[^`]+`|\d/.test(m[2])) return;
      const w = VAGUE_THEN.exec(m[2]); if (!w) return;
      out.push({ file: f, line: i + 1, severity: 'info', kind: 'vague-then', text: `specs/${cap}/spec.md:${i + 1}: ${m[1]} "${m[2].slice(0, 60)}" says "${w[0]}" but names no value a test can check. Name the result: a quoted text, a number or a state, e.g. THEN the row shows "Overdue".` });
    });
  }
  return out;
}

// ---------- scenarios and trace tags ----------
/** All scenarios in <dir>/<capability>/spec.md (REMOVED/RENAMED sections skipped): { id, capability, requirement, name, file, line, visual }. */
function specScenarios(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const cap of fs.readdirSync(dir).sort()) {
    const f = path.join(dir, cap, 'spec.md'); if (!fs.existsSync(f)) continue;
    const lines = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').split('\n');
    let section = ''; let req = null; let cur = null; let fence = null;
    lines.forEach((l, i) => {
      const fm = l.match(/^\s*(`{3,}|~{3,})\s*(\S*)/);
      if (fm) { if (!fence) { fence = fm[1][0]; if (cur && /^visual$/i.test(fm[2])) cur.visual = true; } else if (fm[1][0] === fence && !fm[2]) fence = null; return; }
      if (fence) return;
      let m;
      if ((m = l.match(/^##\s+(.*?)\s*$/))) { section = m[1]; req = null; cur = null; return; }
      if ((m = l.match(/^###\s+Requirement:\s*(.*?)\s*$/))) { req = m[1]; cur = null; return; }
      if ((m = l.match(/^####\s+Scenario:\s*(.*?)\s*$/))) {
        if (/^(REMOVED|RENAMED)\b/i.test(section)) { cur = null; return; }
        cur = { id: `${cap}/${slug(m[1])}`, capability: cap, requirement: req, name: m[1], file: f, line: i + 1, visual: false };
        out.push(cur);
      }
    });
  }
  return out;
}

function gitFiles(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.split('\n').filter(Boolean) : null;
}
/** Test files of the code repo (tracked and untracked, git-ignored files skipped; without git: a directory walk). */
function listTestFiles(root) {
  let files = gitFiles(root, ['ls-files', '-co', '--exclude-standard']);
  if (!files) {
    files = [];
    (function walk(d, rel) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (/^(node_modules|\.git|dist|build|openspec)$/.test(e.name)) continue; const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r); else files.push(r); } })(root, '');
  }
  return files.filter((f) => !/^(node_modules|openspec)\//.test(f) && !/(^|\/)node_modules\//.test(f) && isTestFile(f) && fs.existsSync(path.join(root, f)));
}
const TAG_RE = /\[([a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)\]/g;
/** Map tag id -> [files] over the given test files (relative to root). */
function traceTags(files, root) {
  const tags = new Map();
  for (const f of files) {
    let s; try { s = fs.readFileSync(path.join(root, f), 'utf8'); } catch (e) { continue; }
    for (const m of s.matchAll(TAG_RE)) { const k = m[1]; if (!tags.has(k)) tags.set(k, []); if (!tags.get(k).includes(f)) tags.get(k).push(f); }
  }
  return tags;
}
/** { covered: [{id, by}], visual: [ids], missing: [scenario] }. opts.visualCovers: visual scenarios count as covered. */
function trace(scenarios, tags, opts = {}) {
  const res = { total: scenarios.length, covered: [], visual: [], missing: [] };
  for (const s of scenarios) {
    if (tags.has(s.id)) res.covered.push({ id: s.id, by: tags.get(s.id) });
    else if (s.visual && opts.visualCovers !== false) res.visual.push(s.id);
    else res.missing.push(s);
  }
  return res;
}
/**
 * Scenarios a task's `Spec:` line names. Parts are separated by `;`. A part is `cap/slug` (or `[cap/slug]`),
 * `capability > Requirement > Scenario`, or `capability > Requirement (Scenario A, Scenario B | all scenarios)`.
 * explicit: the scenarios named one by one or with "all"; implicit: a bare `capability > Requirement`.
 */
function specRefs(line, scenarios) {
  const res = { explicit: [], implicit: [], unknown: [] };
  if (!line) return res;
  const add = (arr, xs) => { for (const x of xs) if (!res.explicit.includes(x) && !arr.includes(x)) arr.push(x); };
  for (const part0 of String(line).split(/\s*;\s*/)) {
    const part = part0.replace(/`/g, '').trim(); if (!part) continue;
    const ids = [...part.matchAll(/\[?([a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*)\]?/g)].map((m) => m[1]).filter((id) => scenarios.some((s) => s.id === id));
    if (ids.length && !part.includes('>')) { add(res.explicit, ids.map((id) => scenarios.find((s) => s.id === id))); continue; }
    const segs = part.split(/\s*>\s*/);
    if (segs.length < 2) { res.unknown.push(part); continue; }
    const cap = slug(segs[0]); const pm = segs[1].match(/^(.*?)\s*\((.*)\)\s*$/);
    const reqName = slug(pm ? pm[1] : segs[1]);
    const inReq = scenarios.filter((s) => s.capability === cap && slug(s.requirement || '') === reqName);
    if (!inReq.length) { res.unknown.push(part); continue; }
    const named = segs[2] ? [segs[2]] : pm ? pm[2].replace(/^\s*scenarios?\s*:\s*/i, '').split(/\s*,\s*/) : null;
    if (!named) { add(res.implicit, inReq); continue; }
    if (named.some((n) => /^all( scenarios)?$/i.test(n.trim()))) { add(res.explicit, inReq); continue; }
    const hits = []; for (const n of named) { const k = slug(n); const h = inReq.find((s) => slug(s.name) === k) || inReq.find((s) => k && slug(s.name).startsWith(k)); if (h) hits.push(h); }
    if (hits.length) add(res.explicit, hits); else add(res.implicit, inReq);
  }
  res.implicit = res.implicit.filter((s) => !res.explicit.includes(s));
  return res;
}

// ---------- tests that read source text ----------
const SRC_LITERAL = /(['"`])([^'"`\n]*?(?:(?:^|(?<=['"`])|[./\\])(?:src|app|lib|components|pages|views|composables|stores|styles)(?:[/\\][^'"`\n]*)?|\.(?:vue|svelte|css|scss|sass|less|styl|astro|html?|[cm]?[jt]sx?)(?![A-Za-z0-9]))[^'"`\n]*)\1/;
const SRC_DIR_ONLY = /^(?:\.{0,2}[/\\])*(?:src|app|lib|components|pages|views|composables|stores|styles)[/\\]?$/;
const IMPORT_LINE = /^\s*(?:import\b|export\b[^=]*\bfrom\b|(?:const|let|var)\s+[^=]+=\s*(?:await\s+)?(?:require|import)\s*\()|\bvi\.mock\s*\(|\bjest\.mock\s*\(/;
const READ_CALL = /\b(readFileSync|readFile|read_text|read_bytes|readText|createReadStream)\s*\(|\bopen\s*\([^)]*\)\s*\.\s*read\b|\bwith\s+open\s*\(|\bfs\.promises\.readFile\b|\bfs\/promises\b|\bBun\.file\s*\(/;
const OPT_OUT = /source-text-ok\b\s*[:\-–]?\s*(\S.{5,})/;
/**
 * Findings for one test file: [{ line, kind, text }], plus { optOut } when the file carries the documented opt-out
 * comment `source-text-ok: <reason>` (findings are then reported but allowed).
 */
function sourceTextFindings(file, rel) {
  let s; try { s = fs.readFileSync(file, 'utf8'); } catch (e) { return { findings: [], optOut: null }; }
  const lines = s.replace(/\r\n/g, '\n').split('\n'); const findings = [];
  // Source-path literals anywhere in the file outside import/mock lines (a path built in one place and read in another
  // still counts): 'src/cart.ts', '../src/App.vue', path.join(root, 'src', 'App.vue'), new URL('../src/x.css', ...).
  const srcLits = [];
  lines.forEach((l, i) => { if (IMPORT_LINE.test(l)) return; for (const m of l.matchAll(new RegExp(SRC_LITERAL.source, 'g'))) if (!/\.(json|txt|csv|md|ya?ml|png|jpe?g|svg)$/i.test(m[2])) srcLits.push({ line: i + 1, lit: m[2] }); });
  const near = (i) => srcLits.filter((x) => x.line >= i - 6 && x.line <= i + 1);
  lines.forEach((l, i) => {
    const raw = l.match(/(?:from\s+|import\s*\(\s*)(['"])([^'"]+)\?raw\1/);
    if (raw && /\.(vue|svelte|css|scss|sass|less|styl|astro|[cm]?[jt]sx?|html?|py)$|(^|\/)(src|app|lib|components)\//.test(raw[2])) findings.push({ line: i + 1, kind: 'raw-import', text: `${rel}:${i + 1}: imports ${raw[2]}?raw, i.e. reads source code as text` });
    else if (READ_CALL.test(l) && !/^\s*(\/\/|#|\*)/.test(l)) {
      const cand = near(i + 1).length ? near(i + 1) : srcLits; const lit = cand.find((x) => /\.[a-z]+$/i.test(x.lit)) || cand[0] || null;
      if (lit && !(SRC_DIR_ONLY.test(lit.lit) && !srcLits.some((x) => /\.[a-z]+$/i.test(x.lit)))) findings.push({ line: i + 1, kind: 'read-source', text: `${rel}:${i + 1}: reads ${lit.lit}${lit.line !== i + 1 ? ` (path on line ${lit.line})` : ''} as text` });
    }
  });
  const o = s.match(OPT_OUT);
  return { findings, optOut: o ? o[1].trim().slice(0, 160) : null };
}
const SOURCE_TEXT_FIX = 'Tests must assert behaviour, not source text: matching CSS or markup in a .vue/.css file breaks on an equivalent refactor and passes on a broken page. Assert rendered output instead (mount the component and query the DOM: roles, text, attributes, classes on elements), and put layout/look in a ```visual scenario (the visual check measures columns, overflow and visibility in a real browser). If reading the source really is the behaviour under test (e.g. a code generator or a linter), add the comment `source-text-ok: <reason>` to the test file.';

/**
 * Where the tasks of `openspec instructions apply --json` sit in the task files. OpenSpec 1.7.x gives only `id` (a running number),
 * `description` (the whole checkbox text, label included) and `done`: no `line`, no `sourcePath`; newer versions add both. One helper for
 * every site that needs the checkbox line: use `line` when given; else the checkbox whose text equals the description (whitespace
 * normalised, then without a leading "1.1" label), duplicates taking the first match no earlier task used (one with the same ticked
 * state first); else the checkbox that starts with the task's label ("1.1 "). Returns [{ file, line }] (1-based) parallel to `tasks`,
 * or throws an Error naming every task it cannot place: a caller never goes on with line 0.
 */
function resolveTaskLines(tasks, files, readText) {
  const read = readText || ((f) => require('fs').readFileSync(f, 'utf8'));
  const norm = (x) => String(x).replace(/\s+/g, ' ').trim();
  const bare = (x) => norm(x).replace(/^\d+(?:\.\d+)*\.?\s+/, '');
  const boxes = [];
  for (const file of files) {
    let text; try { text = read(file); } catch { continue; }
    text.split('\n').forEach((l, i) => { const m = l.match(/^\s*[-*+]\s+\[([ xX])\]\s*(.+?)\s*$/); if (m) boxes.push({ file, line: i + 1, text: norm(m[2]), done: m[1] !== ' ' }); });
  }
  const used = new Set(); const missing = [];
  const out = tasks.map((t) => {
    const mine = t.sourcePath ? boxes.filter((b) => b.file === t.sourcePath) : boxes;
    if (t.line > 0) {
      const file = t.sourcePath || (files.length === 1 ? files[0] : (boxes.find((b) => b.line === t.line && (b.text === norm(t.description) || bare(b.text) === bare(t.description))) || {}).file);
      if (file) { used.add(`${file}:${t.line}`); return { file, line: t.line }; }
    }
    const free = (b) => !used.has(`${b.file}:${b.line}`);
    const pick = (list) => list.find((b) => free(b) && b.done === !!t.done) || list.find(free);
    const d = norm(t.description);
    const label = (d.match(/^(\d+(?:\.\d+)*\.?)\s/) || [])[1];
    const hit = pick(mine.filter((b) => b.text === d)) || pick(mine.filter((b) => bare(b.text) === bare(d))) || (label ? pick(mine.filter((b) => b.text.startsWith(`${label} `))) : undefined);
    if (!hit) { missing.push(d); return { file: '', line: 0 }; }
    used.add(`${hit.file}:${hit.line}`);
    return { file: hit.file, line: hit.line };
  });
  if (missing.length) throw new Error(`cannot find the checkbox of ${missing.length === 1 ? 'task' : 'tasks'} ${missing.map((m) => `"${m}"`).join('; ')} in ${files.join(', ') || 'the task files'}: OpenSpec reported ${missing.length === 1 ? 'it' : 'them'} without a line number and the text matches no checkbox (was tasks.md edited while the run was open?)`);
  return out;
}

module.exports = { parsePlan, ariaLabelFindings, edgeLint, uxLint, purposeLint, thenLint, CAPS, SIZE_RULES, RISKS, planLint, isCloseoutGroup, isImplementationTask, proposalSize, isNoneAdr, resolveTaskLines, sizeFacts, requiredSize, sizeCheck, planPath, isSensitivePath, appMapText, invariantLint, isReviewTask, specScenarios, listTestFiles, isTestPath, isTestFile, isUiFile, TAG_RE, traceTags, trace, specRefs, sourceTextFindings, SOURCE_TEXT_FIX, slug };
