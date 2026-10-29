'use strict';
/**
 * Who owns an apply run and what a verification record was made from (used by verify-task.cjs).
 *
 *  - Each run records its owner (`run.json`: session, pid, host, code worktree, branch, HEAD, tree hash, start, last activity).
 *  - A lock (`lock.json`: pid, host, session, command, heartbeat) refuses a second verify-task command on the same change while one
 *    is running; `--takeover` replaces it.
 *  - A passing check records the HEAD and the hash of the task's `Files:`; a record whose commit is not in this checkout's history and
 *    whose files differ is foreign: it never counts as verified here.
 * The session is `--session <id>` or `SPEC_SESSION`; without one the owner is "unknown" and only the status line says who started the run.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const IDLE_MIN = 30; // a run whose last command is older than this is taken over without --takeover
const HEARTBEAT_MS = 15000;
const LOCK_STALE_MS = 120000;

function git(cwd, args, env) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...(env || {}) }, maxBuffer: 256 * 1024 * 1024 });
  return r.status === 0 ? r.stdout.trim() : null;
}
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } };
const writeJson = (f, x) => fs.writeFileSync(f, JSON.stringify(x, null, 2) + '\n');

/** The hash of the whole working tree (tracked and untracked, not ignored: equals HEAD's tree right after a commit); `drop` removes the paths it matches first. */
// ---------- timing: every external command and scan is timed; `--timing` / SPEC_PROFILE=1 prints the summary and records it in metrics.jsonl ----------
const STEPS = [];
function timed(step, fn) {
  const t0 = Date.now(); const end = (v) => { STEPS.push([step, (Date.now() - t0) / 1000]); return v; };
  let r; try { r = fn(); } catch (e) { end(); throw e; }
  return r && typeof r.then === 'function' ? r.then(end, (e) => { end(); throw e; }) : end(r);
}
/** [{ step, seconds, n }] per step name, most expensive first. */
function profile() {
  const m = new Map();
  for (const [s, t] of STEPS) { const e = m.get(s) || { step: s, seconds: 0, n: 0 }; e.seconds += t; e.n += 1; m.set(s, e); }
  return [...m.values()].map((e) => ({ ...e, seconds: Math.round(e.seconds * 100) / 100 })).sort((a, b) => b.seconds - a.seconds);
}

// One hash per tree, scope and process: `next`, `check` and `finish` ask several times; forgetTrees() after a command may have edited files.
const TREES = new Map();
const forgetTrees = () => TREES.clear();
const workTree = (cwd, drop) => {
  const k = `${cwd}\0${drop ? drop.source : ''}`;
  if (!TREES.has(k)) TREES.set(k, timed('git: working-tree hash', () => workTreeUntimed(cwd, drop)));
  return TREES.get(k);
};
/** Prints "hashing the working tree… N files" on stderr once the hash has taken 2 s, then every 2 s. */
function progress(t0) {
  let last = t0;
  return (n, what) => { const now = Date.now(); if (now - t0 >= 2000 && now - last >= 2000) { last = now; process.stderr.write(`verify-task: hashing the working tree… ${n >= 1000 ? `${Math.round(n / 1000)}k` : n} ${what}\n`); } };
}
/**
 * Tracked files: a copy of the real index (its stat cache: only changed files are read), `git add -u`, `write-tree`; the real index,
 * HEAD and the object store's blobs of untracked files stay untouched. Untracked, not ignored files: name, size and mtime (never their
 * contents, so a large data directory costs a stat per file). Equals HEAD's tree right after a commit when nothing is untracked.
 */
function workTreeUntimed(cwd, drop) {
  const t0 = Date.now(); const tick = progress(t0);
  const tree = indexTree(cwd, drop, ['add', '-u']); if (!tree) return null;
  tick(0, 'files');
  const r = spawnSync('git', ['ls-files', '-o', '--exclude-standard', '-z'], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) return null;
  const extra = r.stdout.split('\0').filter((f) => f && !(drop && drop.test(f))).sort();
  if (!extra.length) return tree;
  const h = crypto.createHash('sha1');
  extra.forEach((f, i) => { let st = null; try { st = fs.statSync(path.join(cwd, f)); } catch (e) { /* removed meanwhile */ } h.update(`${f}\0${st ? `${st.size}:${st.mtimeMs}` : '-'}\0`); if (i % 1000 === 0) tick(i, 'untracked files'); });
  return `${tree}+${h.digest('hex')}`;
}
/** The tree object of a temporary copy of the index after `stage` (`add -u` or `add -A`), `drop` paths removed. */
function indexTree(cwd, drop, stage) {
  const real = git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'index']);
  const tmp = path.join(os.tmpdir(), `spec-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    if (real && fs.existsSync(real)) fs.copyFileSync(real, tmp);
    const env = { GIT_INDEX_FILE: tmp };
    if (git(cwd, stage, env) === null) return null;
    if (drop) {
      const gone = (git(cwd, ['ls-files', '-z'], env) || '').split('\0').filter((f) => f && drop.test(f));
      if (gone.length) spawnSync('git', ['update-index', '--force-remove', '-z', '--stdin'], { cwd, env: { ...process.env, ...env }, input: gone.join('\0') + '\0' });
    }
    return git(cwd, ['write-tree'], env);
  } finally { try { fs.unlinkSync(tmp); } catch (e) { /* none */ } }
}

/** HEAD, branch and the hash of the whole working tree. */
function fingerprint(cwd, withTree = true) {
  const head = git(cwd, ['rev-parse', 'HEAD']);
  if (!head) return { head: null, branch: null, tree: null };
  return { head, branch: git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']), ...(withTree ? { tree: workTree(cwd) } : {}) };
}

// ---------- result cache: a passing project command is not run again on the same tree ----------
// The key is the working-tree hash plus the working directory and the command. Run state and the plan's ticks
// (`openspec/.apply-runs/`, `tasks.md`, `progress.md`) are not part of the tree: they change between `check` and `finish` without touching code.
const NOT_CODE = /(^|\/)openspec\/\.apply-runs\/|(^|\/)openspec\/changes\/.*(tasks|progress)\.md$/;
/** The cache file of this tree and command (null outside git). The key is computed before the command runs, so an edit made while it ran never matches. */
const cacheFile = (dir, cwd, cmd, treeKey) => {
  const tree = treeKey === undefined ? workTree(cwd, NOT_CODE) : treeKey;
  return tree ? path.join(dir, 'cache', crypto.createHash('sha1').update([tree, cwd, cmd].join('\0')).digest('hex') + '.json') : null;
};
/** Stores a passing result. */
const cachePut = (f, result) => { if (!f) return; fs.mkdirSync(path.dirname(f), { recursive: true }); writeJson(f, result); };

/** Content hash of the files a task lists (`Files:`): null when it lists none. */
function filesHash(cwd, entries) {
  if (!entries.length) return null;
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard', '-z', '--', ...entries], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  const h = crypto.createHash('sha1');
  for (const n of r.stdout.split('\0').filter(Boolean).sort()) { let c = 'deleted'; try { c = fs.readFileSync(path.join(cwd, n)); } catch (e) { /* removed */ } h.update(n + '\0'); h.update(c); h.update('\0'); }
  return h.digest('hex');
}

const isAncestor = (cwd, a, b) => !!a && !!b && spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd }).status === 0;

/** The identity of this process's session: who it says it is, where it runs. */
function identity(o, codeRoot) {
  return { session: o.session || process.env.SPEC_SESSION || null, pid: process.pid, host: os.hostname(), worktree: codeRoot };
}

const minutes = (iso, now) => Math.max(0, Math.round(((now || Date.now()) - Date.parse(iso)) / 60000));
const short = (h) => (h ? h.slice(0, 8) : 'no commit');

/** Is the run another session's or another worktree's? idle = minutes since its last command. */
function ownership(rec, me, now) {
  const idle = minutes(rec.last_activity || rec.started, now);
  const otherSession = !!(rec.session && me.session && rec.session !== me.session);
  const otherTree = !!(rec.worktree && rec.worktree !== me.worktree);
  return { foreign: otherSession || otherTree, otherSession, otherTree, unknown: !rec.session || !me.session, idle };
}

/** A run in one line; `fresh` (the run this command just started) leaves out the start time and the idle minutes. */
function describeRun(rec, now, fresh) {
  const where = `${rec.branch || 'no branch'} at ${short(rec.head)} in ${rec.worktree}`;
  if (fresh) return `run ${rec.id} (session ${rec.session || 'unknown'}) on ${where}`;
  return `run ${rec.id} (session ${rec.session || 'unknown'}) started ${rec.started}, ${where}; last command ${minutes(rec.last_activity || rec.started, now)} min ago`;
}

function holderLive(h, now) {
  if (now - Date.parse(h.heartbeat) > LOCK_STALE_MS) return false;
  if (h.host !== os.hostname()) return true;
  try { process.kill(h.pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

/** Take the change's lock for this command; { ok:false, holder } when another live command holds it. Released on exit. */
function acquireLock(dir, me, command, takeover) {
  const f = path.join(dir, 'lock.json');
  const mine = () => ({ pid: process.pid, host: me.host, session: me.session, command, started: new Date().toISOString(), heartbeat: new Date().toISOString() });
  for (let tries = 0; tries < 3; tries++) {
    try { fs.writeFileSync(f, JSON.stringify(mine(), null, 2) + '\n', { flag: 'wx' }); break; } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const h = readJson(f);
      if (h && h.pid !== process.pid && holderLive(h, Date.now()) && !takeover) return { ok: false, holder: h };
      try { fs.unlinkSync(f); } catch (e2) { /* raced */ }
      if (tries === 2) return { ok: false, holder: h || {} };
    }
  }
  const beat = setInterval(() => { const h = readJson(f); if (h && h.pid === process.pid) { h.heartbeat = new Date().toISOString(); try { writeJson(f, h); } catch (e) { /* gone */ } } }, HEARTBEAT_MS);
  beat.unref();
  process.on('exit', () => { const h = readJson(f); if (h && h.pid === process.pid) { try { fs.unlinkSync(f); } catch (e) { /* gone */ } } });
  return { ok: true };
}

/**
 * Is a verification record still good in this checkout? 'valid' (its commit is in this history, or the files it covered are the same),
 * or 'foreign' (made on another branch or checkout: not part of this history and its files differ).
 */
function judgeRecord(cwd, rec, now) {
  if (!rec || !rec.head) return { state: 'valid', note: 'no commit recorded (git not used)' };
  if (now.head && isAncestor(cwd, rec.head, now.head)) return { state: 'valid', note: `recorded at ${short(rec.head)}, in this history` };
  if (rec.files_hash && now.files_hash === rec.files_hash) return { state: 'valid', note: `recorded at ${short(rec.head)} on ${rec.branch || '?'}; the task's files are identical here` };
  if (!rec.files_hash && now.tree && now.tree === rec.tree) return { state: 'valid', note: `recorded at ${short(rec.head)} on ${rec.branch || '?'}; the tree is identical here` };
  return { state: 'foreign', note: `recorded at ${short(rec.head)} on ${rec.branch || '?'} in ${rec.worktree || '?'} by run ${rec.run}: that commit is not part of this checkout's history and the ${rec.files_hash ? "task's files differ" : 'tree differs'}` };
}

function finishLine(f, fp) {
  if (!f) return 'finish has not passed yet: run finish';
  return `finish passed ${f.at} at ${short(f.head)} on ${f.branch || '?'} by run ${f.run}: ${f.tree && f.tree === fp.tree ? 'the working tree is unchanged since, so that result still holds' : 'the working tree has changed since (STALE): run finish again'}`;
}

/** One unambiguous line for "everything is ticked": what was verified, by which run, at which commit, and whether it is still valid. */
function summary(ledger, finished, fp, total) {
  const last = require('./chronology.cjs').sortRecords(Object.entries(ledger.passed).map(([k, v]) => ({ at: v.at, k, v }))).reverse().map((x) => [x.k, x.v])[0];
  const parts = [`${total} of ${total} tasks are ticked and verified`];
  parts.push(last
    ? `last task check: "${last[0]}" passed ${last[1].at} at ${short(last[1].head)} on ${last[1].branch || '?'} by run ${last[1].run}${last[1].session ? ` (session ${last[1].session})` : ''}; the working tree is ${last[1].tree && last[1].tree === fp.tree ? 'unchanged since' : 'different from'} that check`
    : 'no task check is recorded (the ticks were there before the verifier first ran)');
  parts.push(finishLine(finished, fp));
  return parts.join('. ');
}

/**
 * The range a code review diffs: BASE_SHA is the commit the change's first run started from, HEAD_SHA an unreferenced commit of the
 * working tree as it is now (tracked, untracked, not ignored; run logs left out; only the review task builds it). Built from a temporary index and `commit-tree`: the
 * user's index, branch, HEAD, stash and `git log` are untouched; the object is garbage collected later. null without git.
 */
function reviewRange(cwd, base) {
  const head = git(cwd, ['rev-parse', 'HEAD']); if (!head) return null;
  const from = base && git(cwd, ['cat-file', '-e', `${base}^{commit}`]) !== null ? base : head;
  const tree = timed('git: review snapshot', () => indexTree(cwd, /(^|\/)openspec\/\.apply-runs\//, ['add', '-A'])); if (!tree) return null;
  const when = '1970-01-01T00:00:00Z'; // fixed, so the same tree yields the same HEAD_SHA on every call
  const who = { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when, ...(git(cwd, ['config', 'user.email']) ? {} : { GIT_AUTHOR_NAME: 'wingman-spec', GIT_AUTHOR_EMAIL: 'wingman-spec@localhost', GIT_COMMITTER_NAME: 'wingman-spec', GIT_COMMITTER_EMAIL: 'wingman-spec@localhost' }) };
  const snap = git(cwd, ['-c', 'commit.gpgsign=false', 'commit-tree', tree, '-p', from, '-m', 'working tree snapshot for review'], who);
  return snap ? { base: from, head: snap } : null;
}

/** The hash that keys the result cache for this working tree (run state and plan ticks left out). */
const cacheTree = (cwd) => workTree(cwd, NOT_CODE);
/** Like cacheTree, without tests and Markdown: what the pages are built from (the visual cache key). */
const NOT_APP = new RegExp(`${NOT_CODE.source}|(^|/)(tests?|__tests__|e2e|spec)/|\\.(test|spec)\\.[^/]+$|\\.mdx?$`);
const appTree = (cwd) => workTree(cwd, NOT_APP);

module.exports = { IDLE_MIN, timed, profile, forgetTrees, cacheTree, appTree, reviewRange, fingerprint, filesHash, identity, ownership, describeRun, acquireLock, judgeRecord, summary, finishLine, minutes, readJson, writeJson, cacheFile, cachePut };
