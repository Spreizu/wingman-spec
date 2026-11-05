#!/usr/bin/env node
'use strict';
/*
 * wingman-visual.cjs - the browser side of the wingman-spec CLI. Plain Node >= 18; Playwright and axe-core come from the project.
 *
 * Protocol: the CLI runs `node wingman-visual.cjs`, writes ONE JSON job on stdin and reads ONE JSON answer on stdout:
 *   job    { op, ...arguments }                 (config = the CLI's resolved `visual:` section)
 *   answer { ok: true, result } | { ok: false, error }
 * capture and run go to a warm helper (below) when one is up. Progress lines go to stderr. Ops:
 *   design-scan {scenarios, change_dir, root, code_root, files}  design-map findings and the token lint, one walk
 *   design-lint, token-lint                                   the same lists, one each (wrappers)
 *   capture {code_root, out_dir, config, items, app_tree}     the "before" capture of a task (pre-task tree)
 *   run {code_root, change_dir, root, out_dir, config, items, before, label, run_dir, app_tree}   capture, compare, write report.json
 *   design-system {code_root}, doctor {code_root, config}
 * The CLI parses and lints the ```visual blocks and writes the review prompt itself; this helper drives the browser.
 *
 * Warm helper: after a capture or run, this helper starts `node wingman-visual.cjs --warm` for the code root, detached. It keeps
 * Playwright loaded, one headless Chromium, and the app server when the next job has the same command, url, port and app tree.
 * It listens on a socket in a private temp folder and takes the next capture or run (with the caller's environment and directory),
 * one at a time, each state still in a fresh browser context. A one-shot run still starts and stops its own server. It exits
 * after WINGMAN_SPEC_VISUAL_WARM seconds idle (default 300; `off`: none is started), within 10 s of its code root being deleted
 * (a job running there then fails, and its app server and Chromium stop with the helper), when this file or
 * Playwright changed, or a third code root needs the room. Busy, missing, stale or stopped mid-job: the job runs here as
 * before. Not on Windows.
 */
for (const s of [process.stdout, process.stderr]) if (s._handle && typeof s._handle.setBlocking === 'function') s._handle.setBlocking(true);
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const net = require('net');
const VC = require('./lib/visual-check.cjs');
const DC = require('./lib/design-contract.cjs');
const RL = require('./lib/roles.cjs');

/** The CLI's `visual:` section. Zeros stay zeros: Go already applied the defaults (internal/config/visual.go). */
function cfgOf(c) { return { ...(c || {}) }; }

function loadReport(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }

/** The "before" from a temporary git worktree of HEAD, when the task's own pre-task capture is missing. Its folder (named after
 * this process) goes on any exit, a signal included; one a killed process left behind goes at the next capture at HEAD. */
async function captureAtHead(codeRoot, items, cfg, outDir, shared) {
  for (const f of fs.readdirSync(os.tmpdir())) {
    const m = /^wingman-visual-before-(\d+)-/.exec(f);
    if (m) try { process.kill(+m[1], 0); } catch (e) { if (e.code === 'ESRCH') dropBefore(path.join(os.tmpdir(), f), codeRoot); }  // its process is gone
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `wingman-visual-before-${process.pid}-`)); BEFORES.set(tmp, codeRoot);
  const wt = path.join(tmp, 'tree');
  try {
    const add = spawnSync('git', ['worktree', 'add', '--detach', '--quiet', wt, 'HEAD'], { cwd: codeRoot, encoding: 'utf8' });
    if (add.status !== 0) return { rep: null, note: `no git worktree of HEAD (${(add.stderr || '').trim().split('\n')[0] || 'not a git repository'})` };
    const nm = path.join(codeRoot, 'node_modules'); if (fs.existsSync(nm) && !fs.existsSync(path.join(wt, 'node_modules'))) fs.symlinkSync(fs.realpathSync(nm), path.join(wt, 'node_modules'));
    const rep = await VC.run({ codeRoot: wt, outDir, config: cfg, items, before: true, shared, appTree: 'head' });
    return { rep, note: 'temporary git worktree of HEAD (uncommitted work of earlier tasks counts as changed)' };
  } finally { dropBefore(tmp, codeRoot); }
}
const BEFORES = new Map();  // this process's before folders -> code root
/** Removes a before folder and, with `git worktree prune`, its worktree's record in the code root. */
function dropBefore(tmp, codeRoot) {
  BEFORES.delete(tmp); fs.rmSync(tmp, { recursive: true, force: true });
  spawnSync('git', ['worktree', 'prune'], { cwd: codeRoot, stdio: 'ignore' });
}
let warmSock = null;  // the warm helper's socket, removed on a signal
for (const s of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(s, () => { try { if (warmSock) fs.unlinkSync(warmSock); } catch (e) { /* gone */ } process.exit(1); });
process.on('exit', () => { for (const [tmp, root] of BEFORES) dropBefore(tmp, root); });  // (visual-check's 'exit' stops a running app server)

async function capture(j, warm) {
  const rep = await VC.run({ codeRoot: j.code_root, outDir: j.out_dir, config: cfgOf(j.config), items: j.items, before: true, shared: warm, appTree: j.app_tree });
  return { dir: j.out_dir, report: path.join(j.out_dir, 'report.json'), source: 'pre-task tree (next)', seconds: rep.seconds, ok: rep.ran, skipped: rep.skipped, server: rep.defects.filter((d) => d.code.startsWith('server:')).map((d) => d.code) };
}

/** After capture + comparison with the before capture (taking one from HEAD when there is none). `before` is the task's visual_before. */
async function runNow(j, warm) {
  const shared = warm || {};  // one browser for the before at HEAD and the after (the warm helper's, which it keeps)
  try { return await runWith(j, shared); } finally { if (!warm && shared.browser) await shared.browser.close().catch(() => {}); }
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
  // refs are visual.ResolveReference in Go (internal/visual/lint.go), already on each item.
  const after = await VC.run({ codeRoot: j.code_root, outDir: j.out_dir, config: cfg, items, shared, appTree: j.app_tree });
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
  const out = { ...after, defects: cmp.defects, preexisting: cmp.preexisting, baseline_defects: (cmp.baseline || []).length, aria_changes: cmp.aria_changes, pairs: cmp.pairs, before: beforeNote, before_seconds: beforeSeconds };
  out.summary = VC.summarize(out.defects);
  if (out.ignored && out.ignored.length) out.ignored_report = VC.ignoredReport(out.ignored).split('\n').slice(1).map((x) => x.trim());
  if (out.notes && out.notes.length) out.skipped_steps = VC.skippedStepsReport(out.notes).split('\n').slice(1).map((x) => x.trim());
  fs.writeFileSync(path.join(j.out_dir, 'report.json'), JSON.stringify(out, null, 2) + '\n');
  const aria = (out.aria_changes || []).map(({ in_scope, ...rest }) => rest);
  const report = {
    ran: out.ran, skipped: out.skipped, warnings: out.warnings, defect_count: out.defects.length, shots: out.shots,
    seconds: out.seconds, ignored: out.ignored, preexisting: out.preexisting, aria_changes: aria, pairs: out.pairs,
    before: out.before, before_seconds: out.before_seconds, summary: out.summary, ignored_report: out.ignored_report, skipped_steps: out.skipped_steps,
  };
  return { report, visual_before: visualBefore };
}

function designScan(j) {
  const ds = DC.discover(j.code_root);
  const problems = (j.scenarios && j.scenarios.length) ? DC.lintDesign(j.scenarios, j.change_dir, j.root, j.code_root, ds) : [];
  const ui = (j.files || []).filter((f) => fs.existsSync(path.join(j.code_root, f)));
  let tokens = null;
  if (ui.length) {
    const map = DC.readDesignMap(j.change_dir);
    if (map || ds.tokens.length) tokens = { files: ui.length, ...DC.tokenLint(j.code_root, ui, ds, map) };
  }
  return { problems, tokens };
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
  'design-scan': designScan,
  'design-lint': (j) => ({ problems: designScan(j).problems }),
  capture,
  run: runNow,
  'token-lint': (j) => designScan(j).tokens,
  'design-system': (j) => { const ds = DC.discover(j.code_root); return { system: ds, text: DC.formatDesignSystem(ds) }; },
  doctor,
};

/** One job's answer: { ok, result } or { ok: false, error }. */
async function answer(job, warm) {
  const op = OPS[job.op];
  if (!op) return { ok: false, error: `wingman-visual: unknown op ${job.op}` };
  if (job.code_root) process.env.WINGMAN_CODE_ROOT = job.code_root;
  try { const result = await op(job, warm); return { ok: true, result: result === undefined ? null : result }; } catch (e) {
    return { ok: false, error: `wingman-visual ${job.op}: ${String((e && e.stack) || e).split('\n').slice(0, 3).join(' | ')}` };
  }
}

// ---------- warm helper ----------
const WARM = new Set(['capture', 'run']);
/** The warm helper's socket for this job: one per code root, helper files, node and Playwright settings; null when off. */
function warmSocket(job) {
  const idle = process.env.WINGMAN_SPEC_VISUAL_WARM;
  if (!WARM.has(job.op) || !job.code_root || process.platform === 'win32' || idle === 'off' || idle === '0') return null;
  try {
    const dir = path.join(os.tmpdir(), `wingman-visual-${process.getuid()}`);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = fs.lstatSync(dir); if (!st.isDirectory() || st.uid !== process.getuid() || (st.mode & 0o077)) return null;  // private, or none
    const own = [__filename, ...Object.keys(require.cache).filter((f) => f.startsWith(__dirname + path.sep))].map((f) => { const s = fs.statSync(f); return [f, s.size, s.mtimeMs]; });
    const env = Object.keys(process.env).filter((k) => /^(PLAYWRIGHT_|WINGMAN_SPEC_VISUAL_|NODE_OPTIONS$|NODE_PATH$)/.test(k)).sort().map((k) => `${k}=${process.env[k]}`);
    const key = crypto.createHash('sha1').update(JSON.stringify([process.execPath, own, path.resolve(job.code_root), cfgOf(job.config).browsers_path, env])).digest('hex');
    const sock = path.join(dir, `${key.slice(0, 16)}.sock`);
    return sock.length < 100 ? sock : null;  // a socket path has a length limit (104 on macOS)
  } catch (e) { return null; }
}
/** The job through the warm helper: { answer }, { busy } (or it stopped mid-job), or {} when there is none (or it was stale). */
function viaWarm(sock, job) {
  return new Promise((resolve) => {
    const c = net.connect(sock); let buf = '';
    c.setEncoding('utf8');
    c.on('connect', () => c.write(JSON.stringify({ job, env: process.env, cwd: process.cwd() }) + '\n'));
    c.on('data', (d) => { buf += d; });
    c.on('error', () => {});
    c.on('close', () => {
      const [head, line] = buf.split('\n'); let h = {}; try { h = JSON.parse(head); } catch (e) { /* none there */ }
      if (!h.taken) { resolve({ busy: !!h.busy }); return; }
      try { resolve({ answer: JSON.parse(line) }); } catch (e) { resolve({ busy: true }); }  // it stopped mid-job: run here, start no new one
    });
  });
}
/** Starts a warm helper; with two running already (one per code root), the one used longest ago stops first if idle. */
async function startWarm(sock, job) {
  const dir = path.dirname(sock); const live = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.sock'))) {
    const p = path.join(dir, f);
    if (await new Promise((r) => { const c = net.connect(p, () => { c.destroy(); r(true); }); c.on('error', () => r(false)); })) live.push([fs.statSync(p).mtimeMs, p]);
    else try { fs.unlinkSync(p); } catch (e) { /* gone */ }  // a helper that was killed
  }
  if (live.length >= 2) {
    const oldest = live.sort((a, b) => a[0] - b[0])[0][1];
    if ((await viaWarm(oldest, { quit: true })).busy) return;
  }
  try { spawn(process.execPath, [__filename, '--warm', sock, job.code_root, cfgOf(job.config).browsers_path || ''], { cwd: job.code_root, detached: true, stdio: 'ignore' }).unref(); } catch (e) { /* none then */ }
}
/** The warm helper: Playwright loaded, one Chromium running, one job at a time. */
async function serveWarm(sock, codeRoot, browsersPath) {
  process.title = `wingman-visual-warm ${codeRoot}`;  // ps names the project
  warmSock = sock;
  const srv = net.createServer();
  const listen = () => new Promise((resolve, reject) => { srv.once('error', reject); srv.listen(sock, () => { srv.removeListener('error', reject); resolve(); }); });
  try { await listen(); } catch (e) {  // listen first, so a second caller finds this helper while it warms up
    if (e.code !== 'EADDRINUSE' || (await new Promise((r) => { const c = net.connect(sock, () => { c.destroy(); r(true); }); c.on('error', () => r(false)); }))) return;
    try { fs.unlinkSync(sock); await listen(); } catch (e2) { return; }
  }
  const warm = { warm: true, codeRoot }; let busy = false; let idle = null; let pwStamp = null; let caller = null;
  const stamp = (f) => { try { return fs.statSync(f).mtimeMs; } catch (e) { return null; } };
  const unlink = () => { srv.close(); try { fs.unlinkSync(sock); } catch (e) { /* gone */ } };
  const stop = () => {  // a browser that does not close in 5 s is killed by Playwright's exit hook
    unlink(); setTimeout(() => process.exit(0), 5000);
    const app = warm.server ? warm.server.handle.stop() : Promise.resolve();
    app.catch(() => {}).then(() => warm.browser && warm.browser.close()).catch(() => {}).finally(() => process.exit(0));
  };
  const idleMs = (Number(process.env.WINGMAN_SPEC_VISUAL_WARM) || 300) * 1000;
  const arm = () => { clearTimeout(idle); idle = setTimeout(stop, idleMs); };
  const ready = (async () => {
    const pw = VC.loadPlaywright(codeRoot); if (!pw) return null;
    pwStamp = stamp(pw.from);
    const l = await VC.launchChromium(pw, codeRoot, { browsers_path: browsersPath || null });
    warm.browser = l.browser; warm.dir = l.found.executablePath ? l.found.dir : null;
    warm.browser.on('disconnected', () => { warm.gone = true; if (!busy) stop(); });
    return pw;
  })().catch(() => null);
  arm();
  const self = stamp(__filename);
  setInterval(() => {  // code root gone (mid-job too: that job cannot finish there), or wingman-spec updated (between jobs)
    if (!fs.existsSync(codeRoot)) {
      if (busy && caller) { busy = false; caller.end(JSON.stringify({ ok: false, error: `wingman-visual: the code root ${codeRoot} is gone` }) + '\n'); }
      stop();
    } else if (!busy && stamp(__filename) !== self) stop();
  }, 10000).unref();
  srv.on('connection', (c) => {
    let buf = '';
    c.setEncoding('utf8'); c.on('error', () => {});
    c.on('data', async (d) => {
      buf += d; const i = buf.indexOf('\n'); if (i < 0) return;
      c.removeAllListeners('data');
      let m; try { m = JSON.parse(buf.slice(0, i)); } catch (e) { c.end('{}\n'); return; }
      if (busy) { c.end('{"busy":true}\n'); return; }
      if (m.job && m.job.quit) { c.end('{}\n'); stop(); return; }  // room for another code root's helper
      busy = true; caller = c; clearTimeout(idle);
      c.on('close', () => { if (busy) { unlink(); process.exit(1); } });  // the caller was stopped mid-job, as a helper of its own would be
      const pw = await ready;
      if (!pw || warm.gone || stamp(pw.from) !== pwStamp) { busy = false; c.end('{}\n'); stop(); return; }  // no browser, or Playwright was reinstalled: a new helper
      c.write('{"taken":true}\n');
      if (m.job && (m.job.op === 'capture' || m.job.op === 'run')) m.job.config = { ...(m.job.config || {}), reuse_server: true };
      for (const k of Object.keys(process.env)) if (!(k in m.env)) delete process.env[k];
      Object.assign(process.env, m.env);
      try { process.chdir(m.cwd); } catch (e) { /* stays */ }
      const a = await answer(m.job, warm);
      if (!busy) return;  // given up: the code root is gone
      busy = false; c.end(JSON.stringify(a) + '\n');
      try { const now = new Date(); fs.utimesSync(sock, now, now); } catch (e) { /* the order of use only */ }
      if (warm.gone) stop(); else arm();
    });
  });
}

async function main() {
  if (process.argv[2] === '--warm') { await serveWarm(process.argv[3], process.argv[4], process.argv[5]); return; }
  let job;
  try { job = JSON.parse(fs.readFileSync(0, 'utf8')); } catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: `wingman-visual: the job on stdin is not JSON (${e.message})` }) + '\n'); process.exit(2); }
  const sock = warmSocket(job);
  const w = sock && fs.existsSync(sock) ? await viaWarm(sock, job) : {};
  const a = w.answer || await answer(job);
  const ran = a.ok && a.result && (job.op === 'capture' ? a.result.ok : a.result.report && a.result.report.ran);  // Playwright and Chromium were there
  if (sock && !w.answer && !w.busy && ran) await startWarm(sock, job).catch(() => {});
  process.stdout.write(JSON.stringify(a) + '\n');
  process.exit(a.ok ? 0 : (OPS[job.op] ? 1 : 2));
}
main();
