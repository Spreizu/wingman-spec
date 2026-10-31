#!/usr/bin/env node
'use strict';
/*
 * wingman-visual.cjs - the browser side of the wingman-spec CLI. Plain Node >= 18; Playwright and axe-core come from the project.
 *
 * Protocol: the CLI runs `node wingman-visual.cjs`, writes ONE JSON job on stdin and reads ONE JSON answer on stdout:
 *   job    { op, ...arguments }                 (config = the CLI's resolved `visual:` section)
 *   answer { ok: true, result } | { ok: false, error }
 * Progress lines go to stderr. Ops:
 *   design-lint {scenarios, change_dir, root, code_root}    design-map and token findings of a change's scenarios
 *   capture {code_root, out_dir, config, items}             the "before" capture of a task (pre-task tree)
 *   run {code_root, change_dir, root, out_dir, config, items, before, label, run_dir}   capture, compare with before, write report.json
 *   token-lint {code_root, change_dir, files}, design-system {code_root}, doctor {code_root, config}
 * The CLI parses and lints the ```visual blocks and writes the review prompt itself; this helper drives the browser.
 */
for (const s of [process.stdout, process.stderr]) if (s._handle && typeof s._handle.setBlocking === 'function') s._handle.setBlocking(true);
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const VC = require('./lib/visual-check.cjs');
const DC = require('./lib/design-contract.cjs');
const RL = require('./lib/roles.cjs');

/** The CLI's `visual:` section in the shape visual-check.cjs reads. */
function cfgOf(c) {
  const x = { ...(c || {}) };
  for (const k of ['ignore', 'ignore_http']) x[k] = x[k] || [];
  x.roles = x.roles || {};
  x.ui_files = x.ui_files && x.ui_files.length ? x.ui_files : null;
  x.command = x.command || null; x.url = x.url || null; x.port = x.port || null; x.browsers_path = x.browsers_path || null;
  if (x.url && !x.port) { try { const u = new URL(x.url); x.port = +(u.port || (u.protocol === 'https:' ? 443 : 80)); } catch (e) { /* the CLI reports it */ } }
  if (!x.url && x.port) x.url = `http://127.0.0.1:${x.port}/`;
  return x;
}

function loadReport(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }

/** The "before" from a temporary git worktree of HEAD, when the task's own pre-task capture is missing. */
async function captureAtHead(codeRoot, items, cfg, outDir, shared) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wingman-visual-before-'));
  const wt = path.join(tmp, 'tree');
  const add = spawnSync('git', ['worktree', 'add', '--detach', '--quiet', wt, 'HEAD'], { cwd: codeRoot, encoding: 'utf8' });
  if (add.status !== 0) { fs.rmSync(tmp, { recursive: true, force: true }); return { rep: null, note: `no git worktree of HEAD (${(add.stderr || '').trim().split('\n')[0] || 'not a git repository'})` }; }
  try {
    for (const d of ['node_modules']) if (fs.existsSync(path.join(codeRoot, d)) && !fs.existsSync(path.join(wt, d))) fs.symlinkSync(fs.realpathSync(path.join(codeRoot, d)), path.join(wt, d));
    const rep = await VC.run({ codeRoot: wt, outDir, config: cfg, items, before: true, shared });
    return { rep, note: 'temporary git worktree of HEAD (uncommitted work of earlier tasks counts as changed)' };
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', wt], { cwd: codeRoot });
    spawnSync('git', ['worktree', 'prune'], { cwd: codeRoot });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

async function capture(j) {
  const rep = await VC.run({ codeRoot: j.code_root, outDir: j.out_dir, config: cfgOf(j.config), items: j.items, before: true });
  return { dir: j.out_dir, report: path.join(j.out_dir, 'report.json'), source: 'pre-task tree (next)', seconds: rep.seconds, ok: rep.ran, skipped: rep.skipped, server: rep.defects.filter((d) => d.code.startsWith('server:')).map((d) => d.code) };
}

/** After capture + comparison with the before capture (taking one from HEAD when there is none). `before` is the task's visual_before. */
async function runNow(j) {
  const shared = {};  // one browser for the before at HEAD and the after
  try { return await runWith(j, shared); } finally { if (shared.browser) await shared.browser.close().catch(() => {}); }
}
async function runWith(j, shared) {
  const cfg = cfgOf(j.config); const items = j.items;
  let before = j.before && j.before.ok ? loadReport(j.before.report) : null;
  let beforeNote = before ? j.before.source : null; let beforeSeconds = 0; let visualBefore = null;
  if (!before && (cfg.baseline || items.some((x) => x.role !== 'task' || x.shots))) {
    const t = Date.now(); const r = await captureAtHead(j.code_root, items, cfg, path.join(j.run_dir, 'visual', j.label || 'self', 'before-head'), shared);
    beforeSeconds = (Date.now() - t) / 1000;
    if (r.rep && r.rep.ran) { before = r.rep; beforeNote = r.note; visualBefore = { dir: r.rep.out_dir, report: path.join(r.rep.out_dir, 'report.json'), source: r.note, seconds: r.rep.seconds, ok: true }; } else beforeNote = `none: ${r.note || (r.rep && (r.rep.skipped || 'the app did not start at HEAD'))}`;
  }
  for (const it of items) it.refs = VC.resolveReferences(it.scenario, j.change_dir, j.root);
  const after = await VC.run({ codeRoot: j.code_root, outDir: j.out_dir, config: cfg, items, shared });
  const cmp = after.ran ? VC.compare(after, before, { baseline: !!cfg.baseline }) : { defects: after.defects, preexisting: 0, aria_changes: [], pairs: [], baseline: [] };
  if (cmp.baseline && cmp.baseline.length) after.warnings.push(VC.baselineReport(cmp.baseline));
  else if (cfg.baseline && after.ran && !before) after.warnings.push('visual.baseline is on, but there is no capture from before the task: every defect counts');
  if (after.ran && !before) {
    const keep = []; for (const d of cmp.defects) { if (d.role && d.role !== 'task') after.warnings.push(`no before capture, so this may predate the task: ${d.message}`); else keep.push(d); }
    cmp.defects = keep;
    if (items.some((x) => x.role !== 'task')) after.warnings.push(`no before capture (${beforeNote || 'none'}): other declared scenarios were checked for defects only, not for ARIA changes`);
  }
  if (after.ignored && after.ignored.length) after.warnings.push(VC.ignoredReport(after.ignored));
  if (after.notes && after.notes.length) after.warnings.push(VC.skippedStepsReport(after.notes));
  const out = { ...after, defects: cmp.defects, all_defects: after.defects.length, preexisting: cmp.preexisting, baseline_defects: (cmp.baseline || []).length, aria_changes: cmp.aria_changes, pairs: cmp.pairs, before: beforeNote, before_seconds: beforeSeconds };
  fs.writeFileSync(path.join(j.out_dir, 'report.json'), JSON.stringify(out, null, 2) + '\n');
  out.summary = VC.summarize(out.defects);
  if (out.ignored && out.ignored.length) out.ignored_report = VC.ignoredReport(out.ignored).split('\n').slice(1).map((x) => x.trim());
  if (out.notes && out.notes.length) out.skipped_steps = VC.skippedStepsReport(out.notes).split('\n').slice(1).map((x) => x.trim());
  delete out.captures;
  return { report: out, visual_before: visualBefore };
}

function tokenLint(j) {
  const ui = (j.files || []).filter((f) => fs.existsSync(path.join(j.code_root, f)));
  if (!ui.length) return null;
  const map = DC.readDesignMap(j.change_dir); const ds = DC.discover(j.code_root);
  if (!map && !ds.tokens.length) return null;
  return { files: ui.length, ...DC.tokenLint(j.code_root, ui, ds, map) };
}

async function doctor(j) {
  const cfg = cfgOf(j.config); const problems = []; const warnings = [];
  const env = { playwright: null, chromium: null, browsers: null, axe: null, axe_tags: null };
  const pw = VC.loadPlaywright(j.code_root);
  if (!pw) (cfg.require_playwright ? problems : warnings).push('Playwright is not installed in the code repository: the visual check will be SKIPPED (npm i -D playwright && npx playwright install chromium)');
  else {
    env.playwright = pw.from;
    try {
      const l = await VC.launchChromium(pw, j.code_root, cfg); await l.browser.close(); env.chromium = 'ok';
      env.browsers = { dir: l.found.dir, source: l.found.source };
      if (l.found.executablePath) warnings.push(`Chromium found in ${l.found.dir} (${l.found.source}), not where Playwright looks by default; the visual check uses it automatically. To make that explicit, set visual.browsers_path: ${l.found.dir} or export PLAYWRIGHT_BROWSERS_PATH=${l.found.dir}`);
    } catch (e) {
      env.chromium = String(e.message).split('\n')[0]; env.browsers = { dir: null, searched: ((e.found && e.found.searched) || []).slice(0, 12) };
      (cfg.require_playwright ? problems : warnings).push(`Chromium cannot be launched (${env.chromium}): run npx playwright install chromium, or set visual.browsers_path (or PLAYWRIGHT_BROWSERS_PATH) to the directory that holds it`);
    }
    env.axe_tags = VC.AXE_TAGS;
    env.axe = VC.axeSource(j.code_root, pw.from) ? 'ok' : null; if (!env.axe) warnings.push('axe-core is not installed: accessibility checks will be skipped (npm i -D axe-core)');
  }
  return { env, problems, warnings, roles: RL.describe(cfg.roles, j.code_root) };
}

const OPS = {
  'design-lint': (j) => ({ problems: DC.lintDesign(j.scenarios, j.change_dir, j.root, j.code_root) }),
  capture,
  run: runNow,
  'token-lint': tokenLint,
  'design-system': (j) => { const ds = DC.discover(j.code_root); return { system: ds, text: DC.formatDesignSystem(ds) }; },
  doctor,
};

async function main() {
  let job;
  try { job = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: `wingman-visual: the job on stdin is not JSON (${e.message})` }) + '\n'); process.exit(2); }
  const op = OPS[job.op];
  if (!op) { process.stdout.write(JSON.stringify({ ok: false, error: `wingman-visual: unknown op ${job.op}` }) + '\n'); process.exit(2); }
  if (job.code_root) process.env.WINGMAN_CODE_ROOT = job.code_root;
  try {
    const result = await op(job);
    process.stdout.write(JSON.stringify({ ok: true, result: result === undefined ? null : result }) + '\n');
    process.exit(0);
  } catch (e) {
    process.stdout.write(JSON.stringify({ ok: false, error: `wingman-visual ${job.op}: ${String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')}` }) + '\n');
    process.exit(1);
  }
}
main();
