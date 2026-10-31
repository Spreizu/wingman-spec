'use strict';
/*
 * visual-check.cjs - the deterministic visual check used by the wingman-spec CLI (`check`, `visual`, `doctor`) through wingman-visual.
 * Plain Node >= 18; Playwright (Chromium) and axe-core are resolved from the code repository at run time.
 * The CLI parses the ```visual blocks and the `visual:` config (internal/visual, internal/config; grammar in docs/reference.md) and
 * passes them in as items and config; this file drives the browser.
 *
 * Scope: block-level `key:` lines hold in every state. Block-level `expect:` lines describe the LOADED PAGE (the route
 * right after it opens, before any `do:` step): they are checked in every state without steps, or, when every state has
 * steps, once on the loaded page before the first state's steps. A block-level expect whose elements are not on the
 * loaded page (e.g. a drawer that opens on click) is checked instead in each state where all its elements exist, and
 * fails only if no state shows them. An `expect:` indented under a state is checked in that state only (strictly).
 * So a state that filters, empties or replaces content never inherits facts about elements it removes.
 *
 * The check is screenshot-free: DOM geometry and computed-style visibility, overflow, overlap, axe, console, network
 * and image loads, plus a text ARIA snapshot (`locator.ariaSnapshot()`) of every key element. Nothing is stored in the
 * repository: the "before" of a task is captured from the pre-task tree when the task is handed out (or from a
 * temporary git worktree of HEAD), the "after" when it is checked, both under .wingman-spec/runs/ (gitignored).
 * Pixels appear only as clip screenshots of the task's own affected areas, for the reviewer (`visual.screenshots:
 * affected`, used only with `visual.review: subagent`; the default `review: off` takes none).
 */
const fs = require('fs');
const path = require('path');
const DC = require('./design-contract.cjs');
const RL = require('./roles.cjs');
const http = require('http');
const https = require('https');
const { spawn } = require('child_process');

// Defects an `ignore-http:` text can skip.
const IGNORE_HTTP_CODES = ['runtime:http-error', 'runtime:request-failed', 'runtime:console-error', 'content:broken-image'];
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'scenario';

/** Every reference of a scenario with its resolved path (`abs`, null when missing): for the side-by-side images. */
function resolveReferences(s, changeDir, root) {
  return (s.references || []).filter((r) => !r.error).map((r) => ({ ...r, abs: resolveReference({ ...s, reference: r.path }, changeDir, root) }));
}
function resolveReference(s, changeDir, root) {
  if (!s.reference) return null;
  for (const base of [changeDir, root, process.env.WINGMAN_CODE_ROOT, path.dirname(s.file)].filter(Boolean)) {
    const p = path.resolve(base, s.reference); if (fs.existsSync(p)) return p;
  }
  return null;
}

// ---------- environment ----------
function resolveFrom(name, codeRoot) {
  for (const p of [codeRoot, __dirname]) { try { return require.resolve(name, { paths: [p] }); } catch (e) { /* next */ } }
  return null;
}
/** Playwright from the code repo (playwright, @playwright/test or playwright-core). WINGMAN_SPEC_VISUAL_PLAYWRIGHT=<module path>
 *  uses that install instead; WINGMAN_SPEC_VISUAL_PLAYWRIGHT=none behaves as if none were installed (tests, or to force a skip). */
function loadPlaywright(codeRoot) {
  const env = process.env.WINGMAN_SPEC_VISUAL_PLAYWRIGHT;
  if (env === 'none') return null;
  if (env) { const m = require(env); return m.chromium ? { chromium: m.chromium, from: require.resolve(env), name: env } : null; }
  for (const n of ['playwright', '@playwright/test', 'playwright-core']) {
    const p = resolveFrom(n, codeRoot);
    if (p) { const m = require(p); if (m.chromium) return { chromium: m.chromium, from: p, name: n }; }
  }
  return null;
}
/** WCAG 2.0 + 2.1, levels A and AA: the rule set most audits (and axe's own WCAG presets) use. 2.1 adds e.g.
 *  label-content-name-mismatch (2.5.3: a control's accessible name must contain its visible label). */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/** Where Playwright's Chromium is. Playwright only looks in PLAYWRIGHT_BROWSERS_PATH or its default cache, and
 *  fixes that directory when it is loaded; browsers installed elsewhere (a shared tools dir, a CI cache, another
 *  checkout) are found here and passed to launch() as executablePath, so nobody has to export the variable.
 *  Returns { executablePath|null, dir, source, searched[] }. */
function findChromium(pw, codeRoot, cfg) {
  let want = null; try { want = pw.chromium.executablePath(); } catch (e) { /* unknown registry */ }
  if (want && fs.existsSync(want)) return { executablePath: null, dir: path.dirname(want), source: process.env.PLAYWRIGHT_BROWSERS_PATH ? 'PLAYWRIGHT_BROWSERS_PATH' : 'default', searched: [] };
  const seg = want && want.split(/[\\/]/).findIndex((x) => /^chromium[a-z_-]*-\d+$/.test(x));
  const rel = want && seg >= 0 ? want.split(/[\\/]/).slice(seg).join(path.sep) : null;
  const home = require('os').homedir(); const dirs = [];
  const add = (d, src) => { if (d && !dirs.some((x) => x.d === d)) dirs.push({ d, src }); };
  if (cfg && cfg.browsers_path) add(path.resolve(codeRoot, cfg.browsers_path), 'visual.browsers_path');
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') add(process.env.PLAYWRIGHT_BROWSERS_PATH, 'PLAYWRIGHT_BROWSERS_PATH');
  add(path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'ms-playwright'), 'default cache');
  add(path.join(home, 'Library/Caches/ms-playwright'), 'default cache');
  if (process.env.LOCALAPPDATA) add(path.join(process.env.LOCALAPPDATA, 'ms-playwright'), 'default cache');
  for (const start of [codeRoot, pw.from && path.dirname(pw.from)].filter(Boolean)) {
    let d = path.resolve(start);
    for (let k = 0; k < 8; k++) { add(path.join(d, 'ms-playwright'), 'found'); add(path.join(d, '.cache/ms-playwright'), 'found'); add(path.join(d, 'node_modules/playwright-core/.local-browsers'), 'found'); const up = path.dirname(d); if (up === d) break; d = up; }
  }
  for (const { d, src } of dirs) {
    if (!fs.existsSync(d)) continue;
    if (rel) { const exe = path.join(d, rel); if (fs.existsSync(exe)) return { executablePath: exe, dir: d, source: src, searched: dirs.map((x) => x.d) }; }
  }
  const other = dirs.find(({ d }) => { try { return fs.readdirSync(d).some((x) => /^chromium/.test(x)); } catch (e) { return false; } });
  return { executablePath: null, dir: null, source: null, searched: dirs.map((x) => x.d), mismatch: other ? other.d : null, expected: want };
}
async function launchChromium(pw, codeRoot, cfg) {
  const f = findChromium(pw, codeRoot, cfg);
  try { return { browser: await pw.chromium.launch(f.executablePath ? { executablePath: f.executablePath } : {}), found: f }; }
  catch (e) { const why = String(e.message).split('\n')[0]; const err = new Error(f.mismatch ? `${why} (a different Chromium build is in ${f.mismatch}; this Playwright needs ${f.expected})` : why); err.found = f; throw err; }
}
function axeSource(codeRoot, pwFrom) {
  const p = resolveFrom('axe-core/axe.min.js', codeRoot) || (pwFrom && resolveFrom('axe-core/axe.min.js', path.dirname(pwFrom)));
  return p ? fs.readFileSync(p, 'utf8') : null;
}

/** HTTP status of url, or null. Fresh connection each time (no keep-alive reuse) and a hard deadline, so a
 *  half-open socket can never stall the readiness loop past ready_timeout. */
function probe(url, timeoutMs = 1500, ignoreHttps = true) {
  return new Promise((resolve) => {
    let u; try { u = new URL(url); } catch (e) { resolve(null); return; }
    let settled = false; const finish = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } };
    const req = (u.protocol === 'https:' ? https : http).get(u, { timeout: timeoutMs, agent: false, rejectUnauthorized: !ignoreHttps, headers: { connection: 'close' } }, (res) => { res.resume(); finish(res.statusCode); });
    const timer = setTimeout(() => { req.destroy(); finish(null); }, timeoutMs + 250);
    req.on('error', () => finish(null)); req.on('timeout', () => { req.destroy(); finish(null); });
  });
}

function startServer(c, codeRoot, logFile) {
  const env = { ...process.env, PORT: String(c.port || ''), BROWSER: 'none', CI: '1', FORCE_COLOR: '0' };
  const child = spawn('sh', ['-c', c.command], { cwd: codeRoot, detached: process.platform !== 'win32', env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; const add = (b) => { log += b; if (log.length > 40000) log = log.slice(-20000); };
  child.stdout.on('data', add); child.stderr.on('data', add);
  let exited = null; child.on('exit', (code, sig) => { exited = { code, sig }; });
  return {
    child, get exited() { return exited; }, tail: () => log.slice(-3000),
    /** SIGTERM the whole process group, wait for it (SIGKILL after 3 s) so the port is free for the next run. */
    stop: async () => {
      try { fs.writeFileSync(logFile, log); } catch (e) { /* best effort */ }
      const kill = (sig) => { try { process.kill(-child.pid, sig); } catch (e) { try { child.kill(sig); } catch (e2) { /* gone */ } } };
      if (!exited) kill('SIGTERM');
      for (let i = 0; i < 30 && !exited; i++) await sleep(100);
      kill('SIGKILL'); // stragglers in the group (e.g. a preview server forked by npm) even after the shell exited
      for (let i = 0; i < 20 && !exited; i++) await sleep(100);
      for (let i = 0; i < 20 && (await probe(c.url, 300, c.ignore_https_errors)) !== null; i++) await sleep(100);
    },
  };
}

// ---------- in-page checks (run in the browser) ----------
/* eslint-disable no-undef */
function pageChecks(arg) {
  const vw = window.innerWidth; const vh = window.innerHeight;
  const desc = (e) => {
    let d = e.tagName.toLowerCase();
    if (e.id) d += '#' + e.id;
    const tid = e.getAttribute('data-testid'); if (tid) d += `[data-testid="${tid}"]`;
    else if (e.classList.length) d += '.' + [...e.classList].slice(0, 2).join('.');
    return d;
  };
  const visible = (e) => {
    const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false;
    if (e.checkVisibility && !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0;
  };
  const res = { scroll_width: document.documentElement.scrollWidth, viewport: vw, overflow: [], keys: [], overlaps: [], broken_images: [] };
  if (res.scroll_width > vw + 1) {
    const all = [...document.body.querySelectorAll('*')].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.right > vw + 1; });
    const inner = all.filter((e) => !all.some((o) => o !== e && e.contains(o)));
    res.overflow = inner.slice(0, 4).map((e) => ({ el: desc(e), right: Math.round(e.getBoundingClientRect().right), width: Math.round(e.getBoundingClientRect().width) }));
  }
  const overlayEls = arg.overlays.flatMap((s) => { try { return [...document.querySelectorAll(s)]; } catch (e) { return []; } });
  const inOverlay = (e) => overlayEls.some((o) => o === e || o.contains(e));
  const pool = [];
  for (const sel of arg.keys) {
    let els; try { els = [...document.querySelectorAll(sel)]; } catch (e) { res.keys.push({ sel, problem: 'invalid-selector', detail: String(e.message) }); continue; }
    if (!els.length) { res.keys.push({ sel, problem: 'missing' }); continue; }
    const vis = els.filter(visible);
    if (!vis.length) { res.keys.push({ sel, problem: 'hidden', detail: `${els.length} match, none visible` }); continue; }
    for (const e of vis.slice(0, 20)) {
      const r = e.getBoundingClientRect();
      if (r.left < -1 || r.right > vw + 1) res.keys.push({ sel, problem: 'offscreen', detail: `${desc(e)} spans x=${Math.round(r.left)}..${Math.round(r.right)} in a ${vw}px viewport` });
      else if (r.bottom < 0) res.keys.push({ sel, problem: 'offscreen', detail: `${desc(e)} is above the page top` });
      pool.push({ sel, e, r });
    }
  }
  for (let i = 0; i < pool.length && res.overlaps.length < 10; i++) {
    for (let j = i + 1; j < pool.length && res.overlaps.length < 10; j++) {
      const a = pool[i]; const b = pool[j];
      if (a.e === b.e || a.e.contains(b.e) || b.e.contains(a.e) || inOverlay(a.e) !== inOverlay(b.e)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left); const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w > 2 && h > 2) res.overlaps.push({ a: a.sel, b: b.sel, detail: `${desc(a.e)} and ${desc(b.e)} overlap by ${Math.round(w)}x${Math.round(h)}px` });
    }
  }
  for (const img of document.images) if (img.complete && img.naturalWidth === 0 && (img.currentSrc || img.src)) res.broken_images.push({ el: desc(img), src: img.currentSrc || img.src });
  // The affected area: union box of the visible key elements in page coordinates (padded, clamped, max 4000px tall).
  if (pool.length) {
    const sx = window.scrollX; const sy = window.scrollY; const pad = 8;
    const W = Math.max(document.documentElement.scrollWidth, vw); const H = Math.max(document.documentElement.scrollHeight, vh);
    let x0 = Math.max(0, Math.min(...pool.map((p) => p.r.left + sx)) - pad); let y0 = Math.max(0, Math.min(...pool.map((p) => p.r.top + sy)) - pad);
    const x1 = Math.min(W, Math.max(...pool.map((p) => p.r.right + sx)) + pad); const y1 = Math.min(H, Math.max(...pool.map((p) => p.r.bottom + sy)) + pad, y0 + 4000);
    x0 = Math.floor(x0); y0 = Math.floor(y0);
    if (x1 - x0 >= 2 && y1 - y0 >= 2) res.area = { x: x0, y: y0, width: Math.ceil(x1 - x0), height: Math.ceil(y1 - y0) };
  }
  return res;
}

/* eslint-enable no-undef */

// ---------- the run (screenshot-free by default) ----------
/**
 * run({ codeRoot, outDir, config, items: [{ scenario, role: 'task'|'change'|'guard', inScope, shots }], label })
 * Opens every state of every item at each viewport and records, per state@viewport, a "capture":
 *   - the deterministic DOM/runtime defects (geometry and computed-style visibility of the key elements, overflow,
 *     overlap, axe, console/page errors, failed and >=400 requests, image loads); no pixels are involved;
 *   - the ARIA snapshot (Playwright `locator.ariaSnapshot()`) of every key element: the text structure of the area;
 *   - only for items with `shots: true` (the task's own scenarios when screenshots are on): ONE clip screenshot of
 *     the area the key elements cover (their union box, padded), never a full page.
 * Returns { ran, skipped, warnings[], defects[], captures{}, shots[], seconds, timings }. Never throws for page
 * problems: they become defects. Environment problems (no Playwright/browser) set skipped + a warning.
 */
async function run(o) {
  const t0 = Date.now(); const c = o.config;
  const rep = { ran: false, skipped: null, warnings: [], defects: [], ignored: [], notes: [], captures: {}, shots: [], scenarios: o.items.map((x) => ({ id: x.scenario.id, role: x.role, ...(x.scenario.role ? { auth: x.scenario.role } : {}), in_scope: !!x.inScope, states: x.scenario.states.map((s) => s.name), viewports: x.scenario.viewports })), out_dir: o.outDir, axe_tags: AXE_TAGS, browsers: null, seconds: 0, timings: {} };
  const done = () => { rep.seconds = (Date.now() - t0) / 1000; fs.mkdirSync(o.outDir, { recursive: true }); fs.writeFileSync(path.join(o.outDir, 'report.json'), JSON.stringify(rep, null, 2) + '\n'); return rep; };
  const pw = loadPlaywright(o.codeRoot);
  if (!pw) { rep.skipped = 'playwright-missing'; rep.warnings.push('VISUAL CHECK SKIPPED: Playwright is not installed in this project (npm i -D playwright && npx playwright install chromium). Nothing visual was verified.'); return done(); }
  const axe = axeSource(o.codeRoot, pw.from);
  if (!axe) rep.warnings.push('accessibility checks skipped: axe-core is not installed (npm i -D axe-core)');
  fs.mkdirSync(o.outDir, { recursive: true });
  let server = null; let browser = null;
  const tBoot = Date.now();
  try {
    const pre = await probe(c.url, 1500, c.ignore_https_errors);
    if (pre !== null && !c.reuse_server) {
      rep.defects.push(defect('server:port-in-use', null, null, null, `something already answers at ${c.url} (HTTP ${pre}) before the check started its own server. Stop it (the check starts and stops the app itself), or set visual.reuse_server: true if that server always serves the current code.`));
      return done();
    }
    if (pre === null) {
      server = startServer(c, o.codeRoot, path.join(o.outDir, 'server.log'));
      const until = Date.now() + c.ready_timeout * 1000; let up = null;
      while (Date.now() < until && !server.exited) { up = await probe(c.url, 1000, c.ignore_https_errors); if (up !== null) break; await sleep(250); }
      if (up === null) {
        const why = server.exited ? `the command exited (code ${server.exited.code})` : `nothing answered within ${c.ready_timeout}s`;
        rep.defects.push(defect('server:not-ready', null, null, null, `the app did not start: \`${c.command}\` -> ${c.url}: ${why}. Last output:\n${server.tail()}`));
        return done();
      }
    }
    rep.timings.server_s = (Date.now() - tBoot) / 1000;
    // o.shared: one browser for every run of one job (the before at HEAD and the after of a check); its owner closes it
    if (o.shared && o.shared.browser) { browser = o.shared.browser; rep.browsers = o.shared.dir || null; } else try { const l = await launchChromium(pw, o.codeRoot, c); browser = l.browser; if (l.found.executablePath) rep.browsers = l.found.dir; if (o.shared) { o.shared.browser = browser; o.shared.dir = rep.browsers; } } catch (e) {
      rep.skipped = 'browser-missing';
      rep.warnings.push(`VISUAL CHECK SKIPPED: Chromium could not be launched (${String(e.message).split('\n')[0]}). Run \`npx playwright install chromium\`, or set visual.browsers_path / PLAYWRIGHT_BROWSERS_PATH to where it is installed. Nothing visual was verified.`);
      return done();
    }
    rep.ran = true;
    const tPages = Date.now();
    const sessions = {}; rep.roles = {};
    for (const name of new Set(o.items.map((x) => x.scenario.role).filter((r) => r && r !== 'anonymous'))) {
      const role = (c.roles || {})[name];
      const r = role ? await RL.login(browser, name, role, { base: new URL(c.url), codeRoot: o.codeRoot, ignoreHttps: c.ignore_https_errors !== false, timeoutMs: o.roleTimeoutMs })
        : { ok: false, code: 'role:undefined', error: `role ${name} is not defined under visual.roles in wingman-spec.yaml` };
      sessions[name] = r; rep.roles[name] = r.ok ? { ok: true, via: r.via } : { ok: false, error: r.error };   // never the session itself
    }
    const known = { hung: new Set(), seen: new Map(), aborted: 0, timeouts: 0 };  // shared by the scenarios of this run (see runScenario)
    // Scenarios run in a pool of browser contexts (visual.contexts, default 4); the states of one scenario stay in order.
    // Each scenario fills its own part of the report; the parts are merged in item order, so the report is deterministic.
    const parts = o.items.map(() => ({ defects: [], ignored: [], notes: [], captures: {}, shots: [], warnings: [] }));
    const width = Math.max(1, Math.min(o.items.length, Number(process.env.WINGMAN_SPEC_VISUAL_CONTEXTS) || c.contexts || 4));
    let next = 0;
    await Promise.all(Array.from({ length: width }, async () => {
      while (next < o.items.length) { const i = next++; await runScenario(o.items[i], { ...o, sessions, known, ignoreHttps: c.ignore_https_errors !== false }, browser, axe, parts[i]); }
    }));
    for (const p of parts) {
      for (const k of ['defects', 'ignored', 'notes', 'shots', 'warnings']) rep[k].push(...p[k]);
      Object.assign(rep.captures, p.captures);
    }
    rep.timings.contexts = width;
    if (known.timeouts || known.aborted || known.repeats) rep.perf = { load_timeouts: known.timeouts, aborted_known_hung: known.aborted, repeated_runtime_defects: known.repeats || 0 };
    rep.timings.pages_s = (Date.now() - tPages) / 1000;
  } finally {
    if (browser && !(o.shared && o.shared.browser === browser)) await browser.close().catch(() => {});
    if (server) await server.stop();
  }
  return done();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** The skip rules in force for a scenario: its own `ignore:` / `ignore-http:` lines, then visual.ignore / visual.ignore_http from the config. */
function ignoreRules(s, cfg) {
  const out = [];
  for (const v of s.ignores || []) out.push({ kind: 'code', value: v, by: `scenario ignore: ${v}` });
  for (const v of s.ignore_http || []) out.push({ kind: 'http', value: v, by: `scenario ignore-http: ${v}` });
  for (const v of (cfg && cfg.ignore) || []) out.push({ kind: 'code', value: v, by: `config visual.ignore: ${v}` });
  for (const v of (cfg && cfg.ignore_http) || []) out.push({ kind: 'http', value: v, by: `config visual.ignore_http: ${v}` });
  return out;
}
/** Which rule skips this defect (its description), or null. Codes: equal, or a prefix ending in ":"; http: message contains the text. */
function ignoredBy(rules, code, msg) {
  for (const r of rules) {
    if (r.kind === 'code') { if (code === r.value || (r.value.endsWith(':') && code.startsWith(r.value))) return r.by; }
    else if (IGNORE_HTTP_CODES.includes(code) && String(msg).includes(r.value)) return r.by;
  }
  return null;
}
/** Chromium words a failed subresource as a console error without the URL in the text: "Failed to load resource: the server responded with a status of 404 (Not Found)" (the reason in brackets may be empty) or "... net::ERR_NAME_NOT_RESOLVED". */
const FAILED_LOAD = /^Failed to load resource/;
/**
 * Whether ignore-http skips a console error {text, url} (url: the browser's location of the message, which for a failed load is the
 * resource), and why: the description of the rule, or null. 1. the URL contains an ignore-http text. 2. No URL known and the text is a
 * failed load: the page already skipped a failed request with the same status or net:: error (`skipped`: [{ key, by, what }], key "404"
 * or "net::ERR_..."). A failed load whose URL is known and matches nothing is never skipped for another URL's sake. 3. Any other console
 * error: skipped when its text contains an ignore-http text, like before.
 */
function consoleErrorSkipped(rules, c, skipped) {
  const http = (rules || []).filter((r) => r.kind === 'http');
  if (c.url) { const r = http.find((x) => c.url.includes(x.value)); if (r) return `${r.by}, matched the URL of the console error`; }
  if (FAILED_LOAD.test(c.text)) {
    if (c.url) return null;
    const key = (c.text.match(/status of (\d{3})\b/) || c.text.match(/(net::\w+)/) || [])[1];
    const hit = (skipped || []).find((p) => !key || p.key === key);
    return hit ? `${hit.by}, the same failure (${hit.what}) was skipped for its request` : null;
  }
  return ignoredBy(rules, 'runtime:console-error', c.text);
}
/** The report text for skipped steps (a click on a control hidden at that viewport): "step skipped (n)" and one line per message / scenario / state. Empty when none. */
function skippedStepsReport(notes) {
  if (!notes || !notes.length) return '';
  const g = new Map();
  for (const d of notes) { const k = `${d.message} - ${d.scenario} (state ${d.state})`; g.set(k, (g.get(k) || 0) + 1); }
  return `visual: steps skipped (${notes.length}), info only, not failures (use \`click!\` to require the control at every viewport):\n${[...g].map(([k, n]) => `  ${k}${n > 1 ? ` x${n}` : ''}`).join('\n')}`;
}
/** The report text for skipped defects: "ignored (n)" and one line per code / scenario / rule. Empty when nothing was skipped. */
function ignoredReport(ignored) {
  if (!ignored || !ignored.length) return '';
  const g = new Map();
  for (const d of ignored) { const k = `${d.code} - ${d.scenario} (${d.by})`; g.set(k, (g.get(k) || 0) + 1); }
  return `visual: ignored (${ignored.length}), not counted as failures:\n${[...g].map(([k, n]) => `  ${k}${n > 1 ? ` x${n}` : ''}`).join('\n')}`;
}
function defect(code, scen, state, vp, message, extra) { return { code, scenario: scen, state, viewport: vp, message, ...(extra || {}) }; }
const capKey = (id, st, vw) => `${id}|${st}|${vw}`;
/** Identity of a defect across two runs (before/after): numbers in the message do not matter. */
const defectKey = (d) => [d.code, d.scenario, d.state, d.viewport, d.selector || d.rule || String(d.message).replace(/^.*?\]: /, '').replace(/[0-9]+/g, '#')].join('|');

/** The exact identity of a defect for visual.baseline: state, viewport, code and the whole message (an axe rule that fails on another element is another defect). */
const defectSig = (d) => [d.code, d.scenario, d.state, d.viewport, String(d.message).replace(/^.*?\]: /, '')].join('|');

/** Per selector group: every selector matches at least one visible element (invalid selectors count as present). */
function pagePresent(groups) {
  const vis = (e) => { const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
  return groups.map((sels) => sels.every((sel) => { try { return [...document.querySelectorAll(sel)].some(vis); } catch (e) { return true; } }));
}
/** `absent:` selectors that match a visible element (or are invalid selectors). */
function pageVisible(sels) {
  const vis = (e) => { const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const cs = getComputedStyle(e); return cs.visibility !== 'hidden' && cs.display !== 'none'; };
  const out = [];
  for (const sel of sels) { try { if ([...document.querySelectorAll(sel)].some(vis)) out.push({ sel }); } catch (e) { out.push({ sel, invalid: true }); } }
  return out;
}
/**
 * Where the block-level expects of a scenario are checked (see "Scope" above): the state that stands for the loaded
 * page (the first state without steps, else the first state, probed before its steps) goes first.
 */
function expectScope(s) {
  const block = (s.expects || []).filter((x) => !x.state && !x.error);
  const stepFree = s.states.filter((x) => !x.steps.length).map((x) => x.name);
  const probe = stepFree.length ? stepFree[0] : s.states[0].name;
  const order = [s.states.find((x) => x.name === probe), ...s.states.filter((x) => x.name !== probe)];
  return { block, stepFree: new Set(stepFree), probe, probeBeforeSteps: !stepFree.length, order };
}

async function runScenario(it, o, browser, axe, rep) {
  const s = it.scenario; const base = new URL(o.config.url);
  const auth = s.role && s.role !== 'anonymous' ? s.role : null; const sess = auth ? (o.sessions || {})[auth] : null;
  if (auth && !(sess && sess.ok)) { rep.defects.push(defect((sess && sess.code) || 'role:login-failed', s.id, null, null, `${s.id}: ${(sess && sess.error) || `no session for role ${auth}`}`, { role: it.role, auth })); return; }
  const keys = (st) => [...s.keys, ...st.keys];
  const scope = expectScope(s);
  const deferred = new Map(); // viewport -> Map(expect raw -> { x, matched }): block expects absent on the loaded page
  const runExpects = async (page, list, add, note) => {
    if (!list.length) return;
    for (const e of await page.evaluate(DC.pageExpect, { expects: list })) if (!e.ok) add('design:expect', `expect "${e.raw}" failed${note || ''}: ${e.message}`, { selector: e.raw });
  };
  /** The loaded page (before steps): check the block expects present there, defer the rest to the states. */
  const loadedPage = async (page, vw, add, note) => {
    const vex = scope.block.filter((x) => DC.vpMatch(x.vps, vw)); if (!vex.length) return;
    const pres = await page.evaluate(pagePresent, vex.map((x) => DC.expectSelectors(x)));
    await runExpects(page, vex.filter((x, i) => pres[i]), add, note);
    if (!deferred.has(vw)) deferred.set(vw, new Map(vex.filter((x, i) => !pres[i]).map((x) => [x.raw, { x, matched: false }])));
  };
  const ignores = ignoreRules(s, o.config);
  const K = o.known || { hung: new Set(), seen: new Map(), aborted: 0, timeouts: 0 };
  const pageMs = o.stepTimeoutMs || (o.before ? 1500 : Math.round(((o.config && o.config.page_timeout) || 5) * 1000));
  const reqMs = Math.round(((o.config && o.config.request_timeout) || 0) * 1000);
  for (const st of scope.order) {
    let unreachable = false;  // pre-task capture: a state the task has not built yet fails its steps at every width
    for (const vw of s.viewports) {
      const where = `${s.id} [${st.name} @ ${vw}px]`;
      const cap = { scenario: s.id, role: it.role, state: st.name, viewport: vw, reached: false, aria: null, shot: null, defects: [], sigs: [] };
      rep.captures[capKey(s.id, st.name, vw)] = cap;
      if (o.before && unreachable && it.role === 'task') { cap.skipped = 'state not reachable before the task'; continue; }
      const ctx = await browser.newContext({ viewport: { width: vw, height: 900 }, reducedMotion: 'reduce', deviceScaleFactor: 1, ignoreHTTPSErrors: o.ignoreHttps !== false, ...(sess && sess.state ? { storageState: sess.state } : {}), ...(sess && sess.headers && Object.keys(sess.headers).length ? { extraHTTPHeaders: sess.headers } : {}) });
      ctx.setDefaultTimeout(pageMs);
      if (axe) await ctx.addInitScript({ content: axe });  // axe once per context, in every document it opens (no per-state injection)
      // visual.request_timeout (default 3 s, 0 = none): a subresource that has not answered in time is aborted and reported as a failed request
      if (reqMs) await ctx.route((u) => /^https?:$/.test(u.protocol), async (route) => {
        if (['document', 'websocket', 'eventsource'].includes(route.request().resourceType())) return route.fallback();
        try { await route.fulfill({ response: await route.fetch({ timeout: reqMs }) }); } catch (e) { const t = /imeout/.test(String(e && e.message)); if (t) K.hung.add(route.request().url()); await route.abort(t ? 'timedout' : 'failed').catch(() => {}); }
      });
      // a URL that kept an earlier state from loading is not waited for again (it was reported where it first hung)
      const hungAtStart = new Set(K.hung);
      if (hungAtStart.size) await ctx.route((u) => hungAtStart.has(u.href), (route) => { K.aborted++; return route.abort('failed'); });
      const page = await ctx.newPage(); const runtime = []; const skippedLoads = []; const pending = new Map(); let slowLoad = false;
      page.on('request', (r) => pending.set(r, r.url()));
      page.on('requestfinished', (r) => pending.delete(r));
      page.on('console', (m) => { if (m.type() === 'error') { const u = m.location && m.location() && m.location().url; runtime.push(['runtime:console-error', `console error: ${m.text().slice(0, 300)}${u ? ` (at ${u})` : ''}`, { text: m.text(), url: u || '' }]); } });
      page.on('pageerror', (e) => runtime.push(['runtime:page-error', `uncaught exception: ${String(e.message).slice(0, 300)}`]));
      page.on('requestfailed', (r) => { pending.delete(r); if (hungAtStart.has(r.url())) return; const f = r.failure(); if (!/ERR_ABORTED/.test(f ? f.errorText : '')) runtime.push(['runtime:request-failed', `request failed: ${r.method()} ${r.url()} (${f ? f.errorText : '?'})`, { key: f ? f.errorText : '?' }]); });
      page.on('response', (r) => { if (r.status() >= 400) runtime.push(['runtime:http-error', `HTTP ${r.status()} for ${r.request().method()} ${r.url()}`, { key: String(r.status()) }]); });
      const add = (code, msg, extra, skipBy) => { // returns the rule that skipped the defect, or null
        const d = defect(code, s.id, st.name, vw, `${where}: ${msg}`, { role: it.role, ...(auth ? { auth } : {}), ...(extra || {}) });
        const by = skipBy || ignoredBy(ignores, code, msg);
        if (by) { rep.ignored.push({ code, scenario: s.id, state: st.name, viewport: vw, message: d.message, by }); return by; }
        rep.defects.push(d); cap.defects.push(defectKey(d)); cap.sigs.push(defectSig(d));
        return null;
      };
      try {
        try { await page.goto(new URL(s.route, base).href, { waitUntil: 'load' }); } catch (e) {
          // load never fired (a subresource hangs): the page is there, so say what it waits for and run every check on it, instead of none
          if (!/Timeout/.test(String(e.message)) || !/^https?:/.test(page.url())) throw e;
          K.timeouts++; slowLoad = true;
          const wait = [...pending.entries()].filter(([r]) => ['image', 'script', 'stylesheet', 'font', 'media'].includes(r.resourceType())).map(([, u]) => u);
          wait.forEach((u) => K.hung.add(u));
          add('state:load-failed', `${s.route} did not finish loading within ${Math.round(pageMs / 1000)}s: still waiting for ${wait.length ? wait.slice(0, 3).map((u) => `GET ${u}`).join(', ') + (wait.length > 3 ? ` and ${wait.length - 3} more` : '') : 'a response'}. The checks below ran on the page as it stood`);
        }
        if (st.name === scope.probe && scope.probeBeforeSteps && scope.block.length) { await settle(page, slowLoad ? 300 : pageMs, pending); await loadedPage(page, vw, add, ' on the loaded page (before the steps of this state)'); }
        let ok = true;
        for (const step of st.steps) {
          try { await doStep(page, step, base, (msg) => rep.notes.push({ level: 'info', scenario: s.id, state: st.name, viewport: vw, step: `${step.op} ${step.target}`, message: msg }), vw); } catch (e) { unreachable = true; add('state:step-failed', `step \`${step.op}${step.strict ? "!" : ""}${step.target ? ' ' + step.target : ''}${step.value !== undefined ? ' = ' + step.value : ''}\` failed: ${String(e.message).split('\n')[0]}`); ok = false; break; }
        }
        await settle(page, slowLoad ? 300 : pageMs, pending);
        if (ok) {
          cap.reached = true;
          if (s.redirects_to) { const norm = (p) => (p.length > 1 ? p.replace(/\/+$/, '') : p); const got = new URL(page.url()).pathname; if (norm(got) !== norm(s.redirects_to)) add('role:no-redirect', `the route ended on ${got}, expected ${s.redirects_to}${auth ? ` for role ${auth}` : ' for an anonymous visitor'}`); }
          const gone = [...s.absents, ...(st.absents || [])];
          if (gone.length) for (const g of await page.evaluate(pageVisible, gone)) add(g.invalid ? 'role:bad-selector' : 'role:forbidden-visible', g.invalid ? `absent: ${g.sel} is not a valid selector` : `${g.sel} is visible${auth ? ` for role ${auth}` : ' to an anonymous visitor'}, but the scenario says it must be absent`, { selector: g.sel });
          const r = await page.evaluate(pageChecks, { keys: keys(st), overlays: s.overlays });
          if (r.overflow.length || r.scroll_width > vw + 1) add('layout:horizontal-overflow', `the page scrolls sideways: document is ${r.scroll_width}px wide in a ${vw}px viewport${r.overflow.length ? `; widest offenders: ${r.overflow.map((x) => `${x.el} (right edge ${x.right}px, width ${x.width}px)`).join(', ')}` : ''}`);
          for (const k of r.keys) add(`layout:key-${k.problem}`, k.problem === 'missing' ? `key element ${k.sel} is not in the page` : `key element ${k.sel} is ${k.problem}${k.detail ? ` (${k.detail})` : ''}`, { selector: k.sel });
          for (const v of r.overlaps) add('layout:overlap', `key elements ${v.a} and ${v.b} overlap: ${v.detail}`, { selector: `${v.a} | ${v.b}` });
          for (const b of r.broken_images) add('content:broken-image', `image did not load: ${b.el} src=${b.src}`, { selector: b.el });
          // design expectations (expect: lines from the design map): computed styles and geometry, no screenshots
          // block-level expects: on the loaded page (states without steps); in a state with steps only those absent
          // from the loaded page, and only where all their elements exist. State expects: always, in their state.
          if (scope.stepFree.has(st.name)) await loadedPage(page, vw, add);
          else if (deferred.has(vw) && deferred.get(vw).size) {
            const dl = [...deferred.get(vw).values()];
            const pres = await page.evaluate(pagePresent, dl.map((d) => DC.expectSelectors(d.x)));
            const here = dl.filter((d, i) => pres[i]); here.forEach((d) => { d.matched = true; });
            await runExpects(page, here.map((d) => d.x), add);
          }
          await runExpects(page, (st.expects || []).filter((x) => !x.error && DC.vpMatch(x.vps, vw)), add);
          cap.aria = await ariaOf(page, keys(st));
          if (it.shots && r.area) {
            const file = path.join(o.outDir, 'areas', s.capability, slug(s.scenario || s.id), `${st.name}@${vw}.png`);
            fs.mkdirSync(path.dirname(file), { recursive: true });
            await page.screenshot({ path: file, fullPage: true, clip: r.area, animations: 'disabled', caret: 'hide' }).then(() => { cap.shot = file; rep.shots.push({ scenario: s.id, role: it.role, state: st.name, viewport: vw, file, area: r.area }); }).catch((e) => rep.warnings.push(`${where}: area screenshot failed: ${String(e.message).split('\n')[0]}`));
            // after the task, next to the design: the rendered area beside the reference picked for this width (temporary)
            const ref = cap.shot && !o.before && it.role === 'task' && it.refs ? DC.pickReference(it.refs, vw) : null;
            if (ref && ref.abs) {
              const out = file.replace(/\.png$/, '.vs-design.png');
              await DC.sideBySide(browser, { rendered: file, reference: ref.abs, crop: ref.crop, out, label: `${s.id} [${st.name} @ ${vw}px]` })
                .then(() => { cap.side = out; rep.shots[rep.shots.length - 1].side_by_side = out; rep.shots[rep.shots.length - 1].reference = ref.abs; })
                .catch((e) => rep.warnings.push(`${where}: side-by-side with ${ref.path} failed: ${String(e.message).split('\n')[0]}`));
            }
          }
          if (axe) {
            if (!(await page.evaluate(() => !!(window.axe && window.axe.run)).catch(() => false))) await page.addScriptTag({ content: axe });
            const ax = await page.evaluate(({ tags, keys: ks }) => window.axe.run(document, { runOnly: { type: 'tag', values: tags }, resultTypes: ['violations'] }).then((x) => {
              const roots = ks.flatMap((k) => { try { return [...document.querySelectorAll(k)]; } catch (e) { return []; } });
              // in_region: every reported node is a key element or inside one (a defect there belongs to the scenario)
              return x.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n) => n.target.join(' ')), in_region: v.nodes.some((n) => { try { const el = document.querySelector(n.target[n.target.length - 1]); return !el || roots.some((r) => r.contains(el)); } catch (e) { return true; } }) }));
            }), { tags: AXE_TAGS, keys: keys(st) });
            for (const v of ax) add(`a11y:${v.id}`, `accessibility (axe ${v.id}, ${v.impact}): ${v.help} -> ${v.nodes.join(', ')}`, { rule: v.id, in_region: v.in_region });
          }
        }
      } catch (e) {
        add('state:load-failed', `could not open ${s.route}: ${String(e.message).split('\n')[0]}`);
      }
      const seen = new Set();
      // Requests first: the console errors a failed load leaves behind are skipped with them (by their own URL, else by the same failure).
      for (const pass of [0, 1]) for (const [code, msg, meta] of runtime) {
        if ((code === 'runtime:console-error') !== (pass === 1) || seen.has(msg)) continue;
        seen.add(msg);
        // the same request or console error in a later state of the same viewport is the same defect: reported once, counted
        const sk = `${s.id}|${vw}|${code}|${msg}`;
        if (K.seen.has(sk) && K.seen.get(sk) !== st.name) { K.repeats = (K.repeats || 0) + 1; continue; }
        K.seen.set(sk, st.name);
        if (pass === 1) { add(code, msg, undefined, meta ? consoleErrorSkipped(ignores, meta, skippedLoads) : null); continue; }
        const by = add(code, msg);
        if (by && meta && meta.key) skippedLoads.push({ key: meta.key, by, what: code === 'runtime:http-error' ? `HTTP ${meta.key}` : meta.key });
      }
      await ctx.close();
    }
  }
  // A block-level expect whose elements neither the loaded page nor any state shows checked nothing: that is a defect.
  for (const [vw, m] of deferred) for (const d of m.values()) {
    if (d.matched) continue;
    const cap = rep.captures[capKey(s.id, scope.probe, vw)];
    if (cap && cap.skipped) continue;
    const dd = defect('design:expect-unmatched', s.id, scope.probe, vw, `${s.id} [${scope.probe} @ ${vw}px]: expect "${d.x.raw}" checked nothing: its elements (${DC.expectSelectors(d.x).join(', ')}) are on neither the loaded page nor any state of the scenario. Fix the selector, or put the expect under the \`state:\` that shows them`, { role: it.role, selector: d.x.raw });
    rep.defects.push(dd); if (cap) cap.defects.push(defectKey(dd));
  }
}

/** ARIA snapshot (YAML text) of every match of every key selector (first 10 per selector), in declared order. */
async function ariaOf(page, keys) {
  const out = [];
  for (const sel of keys) {
    const loc = page.locator(sel); let n = 0;
    try { n = await loc.count(); } catch (e) { out.push(`# ${sel}: invalid selector`); continue; }
    out.push(`# ${sel} (${n} match${n === 1 ? '' : 'es'})`);
    for (let i = 0; i < Math.min(n, 10); i++) {
      let t; try { t = await loc.nth(i).ariaSnapshot({ timeout: 2000 }); } catch (e) { t = '(not in the accessibility tree)'; }
      out.push(String(t || '(empty)').trimEnd());
    }
  }
  return out.join('\n');
}

/**
 * click / hover. A control that exists in the page but is hidden at this viewport (a menu toggle at desktop widths) is skipped with a note
 * instead of failing the state for that width; a target that matches nothing, a visible one that could not be clicked (covered, disabled,
 * timed out) and a strict step (`click!`) fail as before.
 */
async function pointerStep(page, step, note, vw) {
  try { await (step.op === 'click' ? page.click(step.target) : page.hover(step.target)); } catch (e) {
    if (step.strict) throw e;
    const loc = page.locator(step.target);
    const exists = await loc.count().catch(() => 0);
    if (!exists || await loc.first().isVisible().catch(() => true)) throw e;
    note(`step skipped: ${step.target} exists but is hidden at ${vw}px`);
  }
}
async function doStep(page, step, base, note, vw) {
  switch (step.op) {
    case 'click': await pointerStep(page, step, note, vw); break;
    case 'fill': await page.fill(step.target, step.value); break;
    case 'press': await page.keyboard.press(step.target); break;
    case 'hover': await pointerStep(page, step, note, vw); break;
    case 'wait': await page.waitForTimeout(+step.target); break;
    case 'goto': await page.goto(new URL(step.target, base).href, { waitUntil: 'load' }); break;
    case 'storage': await page.evaluate(([k, v]) => localStorage.setItem(k, v), [step.target, step.value]); await page.reload({ waitUntil: 'load' }); break;
    case 'reload': await page.reload({ waitUntil: 'load' }); break;
    default: throw new Error(`unknown step ${step.op}`);
  }
}
/** Quiet window of the settle: no request in flight for this long (Playwright's networkidle waits a fixed 500 ms). */
const QUIET_MS = Math.max(20, Number(process.env.WINGMAN_SPEC_VISUAL_QUIET_MS) || 100);
/**
 * Wait until the page is settled: no request in flight for QUIET_MS (the same condition as networkidle with a shorter window,
 * read from the page's own in-flight map; capped at ms), fonts ready, motion off, two animation frames.
 */
async function settle(page, ms = 5000, pending) {
  if (!pending) await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => {});
  else {
    const t0 = Date.now(); let quietSince = pending.size ? 0 : Date.now();
    while (Date.now() - t0 < ms) {
      await sleep(20);
      if (pending.size) quietSince = 0; else if (!quietSince) quietSince = Date.now(); else if (Date.now() - quietSince >= QUIET_MS) break;
    }
  }
  await page.evaluate(() => (document.fonts ? document.fonts.ready : null)).catch(() => {});
  await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}' }).catch(() => {});
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
}

/** Line diff (LCS) of two texts: ['- old', '+ new', ...]; [] when equal. */
function lineDiff(a, b, max = 40) {
  if (a === b) return [];
  const A = String(a || '').split('\n'); const B = String(b || '').split('\n');
  if (A.length * B.length > 400000) return [`- (${A.length} lines)`, `+ (${B.length} lines, too large to diff)`];
  const L = Array.from({ length: A.length + 1 }, () => new Int32Array(B.length + 1));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = []; let i = 0; let j = 0;
  while (i < A.length || j < B.length) {
    if (i < A.length && j < B.length && A[i] === B[j]) { i++; j++; } else if (i < A.length && (j >= B.length || L[i + 1][j] >= L[i][j + 1])) out.push('- ' + A[i++]); else out.push('+ ' + B[j++]);
  }
  return out.length > max ? [...out.slice(0, max), `… ${out.length - max} more changed line(s)`] : out;
}

/**
 * Compare the run after the task with the capture taken before it (null = no before capture).
 *   task scenarios:      every defect counts; ARIA changes and before/after area screenshots go to the reviewer;
 *   other scenarios:     a defect counts only if it is new (absent before); an ARIA change is a
 *                        `regression:aria-changed` defect unless the scenario is in the task's scope.
 * Returns { defects[], preexisting, aria_changes[], pairs[] }.
 */
function compare(after, before, opts) {
  const roleOf = new Map(after.scenarios.map((s) => [s.id, s]));
  const res = { defects: [], preexisting: 0, aria_changes: [], pairs: [], baseline: [] };
  const beforeKeys = before ? new Set(Object.values(before.captures).flatMap((c) => c.defects)) : null;
  const beforeSigs = before ? new Set(Object.values(before.captures).flatMap((c) => c.sigs || [])) : null;
  for (const d of after.defects) {
    const sc = d.scenario && roleOf.get(d.scenario);
    // visual.baseline: on -- in a task scenario too, a request or console defect that the pre-task capture already had, and an axe
    // defect outside the key elements that it already had, is not the task's: listed once as info, never failing
    if (sc && sc.role === 'task' && beforeKeys && opts && opts.baseline && beforeSigs.has(defectSig(d)) && (d.code.startsWith('runtime:') || (d.code.startsWith('a11y:') && d.in_region === false))) { res.preexisting++; res.baseline.push(d); continue; }
    if (!sc || sc.role === 'task' || !beforeKeys) { res.defects.push(d); continue; }
    if (beforeKeys.has(defectKey(d))) { res.preexisting++; continue; }
    res.defects.push({ ...d, regression: true, message: `${d.message} (new since the task started: this scenario is not part of the task)` });
  }
  if (!before) return res;
  for (const [k, a] of Object.entries(after.captures)) {
    const b = before.captures[k]; const sc = roleOf.get(a.scenario);
    if (!b || !sc) continue;
    if (sc.role === 'task') { if (a.shot || b.shot) res.pairs.push({ scenario: a.scenario, state: a.state, viewport: a.viewport, before: b.shot, after: a.shot, side_by_side: a.side || null }); }
    if (!a.reached || !b.reached || a.aria === b.aria) continue;
    const diff = lineDiff(b.aria, a.aria);
    const ch = { scenario: a.scenario, role: sc.role, in_scope: sc.in_scope, state: a.state, viewport: a.viewport, diff };
    res.aria_changes.push(ch);
    if (sc.role !== 'task' && !sc.in_scope) {
      res.defects.push(defect('regression:aria-changed', a.scenario, a.state, a.viewport, `${a.scenario} [${a.state} @ ${a.viewport}px]: the accessibility structure of this scenario's key elements changed, but the scenario is outside the task's scope (its component is not in the task's Files:):\n${diff.map((x) => '      ' + x).join('\n')}\n    Undo the unintended change, or fix the plan with /spec-fix.`, { role: sc.role, regression: true }));
    }
  }
  return res;
}

/** The baseline defects as lines, one per defect with the places it was seen. */
function baselineReport(list) {
  const m = new Map();
  for (const d of list) { const k = `${d.code}|${String(d.message).replace(/^.*?\]: /, '')}`; const e = m.get(k) || { d, n: 0 }; e.n++; m.set(k, e); }
  const rows = [...m.values()];
  return [`baseline: ${list.length} defect${list.length === 1 ? ' was' : 's were'} already on the page before the task (${rows.length} distinct) and do not count against it`, ...rows.slice(0, 8).map(({ d, n }) => `  ${d.code} x${n}: ${String(d.message).replace(/^.*?\]: /, '').slice(0, 140)}`), ...(rows.length > 8 ? [`  ... and ${rows.length - 8} more`] : [])].join('\n');
}

/** Collapse a defect list into the lines handed to the implementer (one line per defect, viewports merged). */
function summarize(defects) {
  const m = new Map();
  for (const d of defects) {
    const k = `${d.code}|${d.scenario}|${d.state}|${d.message.replace(/@ \d+px/, '@')}`;
    const e = m.get(k); if (e) { if (d.viewport && !e.vps.includes(d.viewport)) e.vps.push(d.viewport); } else m.set(k, { d, vps: d.viewport ? [d.viewport] : [] });
  }
  return [...m.values()].map(({ d, vps }) => `- [${d.code}] ${vps.length > 1 ? d.message.replace(/@ \d+px/, `@ ${vps.join('/')}px`) : d.message}`);
}

module.exports = {
  baselineReport, consoleErrorSkipped, ignoreRules, ignoredReport, skippedStepsReport, AXE_TAGS, launchChromium, resolveReferences, loadPlaywright, axeSource, run, compare, summarize };
