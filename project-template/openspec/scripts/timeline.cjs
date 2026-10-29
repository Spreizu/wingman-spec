'use strict';
/**
 * timeline.cjs - what happened while a change was built, one JSON line per event, in `openspec/.apply-runs/<change>/timeline.jsonl`.
 * Append-only: each event is one `appendFileSync` of one line, so parallel commands never rewrite each other's lines and need no
 * shared index. `archive` copies the file next to `archived.json`. The editor extension reads it (Timeline section).
 *
 * An event: { at: ISO time with offset (chronology.cjs), event, summary, ok?, seconds?, task?, session?, run?, details? }.
 *   event: run-start | takeover | next | check-start | check | tick | fix-round | review-packet | review | visual | finish-start |
 *          finish | sync | archive | decision
 *   details: { failures?, output_tail?, files?, changes?, reason?, owner_approval? } (shown collapsed).
 *
 * Decisions: the change's plan (spec deltas, tasks, design.md, ADRs) is hashed at `next`, `check` and `finish`. When it differs from
 * the last snapshot (`plan-snapshot.json`), one `decision` event lists what changed, the reason (`--reason`, else the last
 * `Decision:` line of the change, else the title of an added ADR) and the owner approval when a Why changed or a requirement went.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CH = require('./chronology.cjs');

const FILE = 'timeline.jsonl';
const SNAP = 'plan-snapshot.json';
const MAX = 4000; // characters of one detail text: the timeline stays small
const cut = (s) => (typeof s === 'string' && s.length > MAX ? `…${s.slice(-MAX)}` : s);
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const read = (f) => { try { return fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); } catch (e) { return null; } };

/** Appends one event (best effort: a timeline that cannot be written never fails a check). */
function append(dir, ev) {
  try {
    const d = ev.details ? Object.fromEntries(Object.entries(ev.details).filter(([, v]) => v != null && !(Array.isArray(v) && !v.length)).map(([k, v]) => [k, Array.isArray(v) ? v.slice(0, 40).map(cut) : cut(v)])) : null;
    const line = { at: CH.isoLocal(), ...ev, ...(d && Object.keys(d).length ? { details: d } : { details: undefined }) };
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, FILE), JSON.stringify(line) + '\n');
  } catch (e) { /* the timeline is a record, not a gate */ }
}
/** The events of a timeline file, oldest first (a torn last line is skipped). */
function readEvents(file) {
  return (read(file) || '').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch (e) { return []; } });
}

/** The plan as a comparable snapshot: requirements (text and Why), scenarios, tasks (without ticks), ADR files, design.md. */
function snapshot(changeDir) {
  const reqs = {}; const scens = {};
  const specs = path.join(changeDir, 'specs');
  for (const cap of fs.existsSync(specs) ? fs.readdirSync(specs).sort() : []) {
    const text = read(path.join(specs, cap, 'spec.md')); if (text === null) continue;
    let section = ''; let req = null; let scen = null;
    for (const l of text.split('\n')) {
      let m;
      if ((m = l.match(/^##\s+(.*?)\s*$/))) { section = m[1].split(/\s/)[0].toUpperCase(); req = null; scen = null; continue; }
      if ((m = l.match(/^###\s+Requirement:\s*(.*?)\s*$/))) { req = `${cap}/${m[1]}`; scen = null; reqs[req] = { section, body: '', why: '' }; continue; }
      if ((m = l.match(/^####\s+Scenario:\s*(.*?)\s*$/)) && req) { scen = `${req}/${m[1]}`; scens[scen] = ''; continue; }
      if (!req) continue;
      if (scen) scens[scen] += l.trim() + '\n';
      else if (/^\s*Why:/i.test(l)) reqs[req].why = l.replace(/^\s*Why:\s*/i, '').trim();
      else reqs[req].body += l.trim() + '\n';
    }
  }
  const tasks = (read(path.join(changeDir, 'tasks.md')) || '').split('\n').map((l) => l.match(/^\s*- \[[ xX]\]\s+(.*\S)/)).filter(Boolean).map((m) => m[1]);
  const adrDir = path.join(changeDir, 'adrs');
  const adrs = fs.existsSync(adrDir) ? fs.readdirSync(adrDir).filter((f) => f.endsWith('.md')).sort() : [];
  const design = read(path.join(changeDir, 'design.md'));
  const snap = {
    reqs: Object.fromEntries(Object.entries(reqs).map(([k, v]) => [k, { section: v.section, body: sha(v.body.trim()), why: v.why }])),
    scens: Object.fromEntries(Object.entries(scens).map(([k, v]) => [k, sha(v.trim())])),
    tasks, adrs: Object.fromEntries(adrs.map((f) => [f, sha(read(path.join(adrDir, f)) || '')])), design: design === null ? null : sha(design),
  };
  return { ...snap, hash: sha(JSON.stringify(snap)) };
}
/** What changed between two snapshots, as short lines. */
function diff(a, b) {
  const out = [];
  const keys = (x, y) => [...new Set([...Object.keys(x), ...Object.keys(y)])].sort();
  for (const k of keys(a.reqs, b.reqs)) {
    const x = a.reqs[k]; const y = b.reqs[k];
    if (!x) out.push(`requirement added: ${k}`);
    else if (!y) out.push(`requirement removed: ${k}`);
    else {
      if (y.section === 'REMOVED' && x.section !== 'REMOVED') out.push(`requirement removed: ${k}`);
      else if (x.body !== y.body) out.push(`requirement changed: ${k}`);
      if (x.why !== y.why) out.push(`Why changed: ${k}: "${x.why}" -> "${y.why}"`);
    }
  }
  for (const k of keys(a.scens, b.scens)) {
    if (!(k in a.scens)) out.push(`scenario added: ${k}`);
    else if (!(k in b.scens)) out.push(`scenario removed: ${k}`);
    else if (a.scens[k] !== b.scens[k]) out.push(`scenario changed: ${k}`);
  }
  for (const t of b.tasks.filter((t) => !a.tasks.includes(t))) out.push(`task added: ${t}`);
  for (const t of a.tasks.filter((t) => !b.tasks.includes(t))) out.push(`task removed: ${t}`);
  for (const f of keys(a.adrs, b.adrs)) {
    if (!(f in a.adrs)) out.push(`ADR added: ${f}`); else if (!(f in b.adrs)) out.push(`ADR removed: ${f}`); else if (a.adrs[f] !== b.adrs[f]) out.push(`ADR changed: ${f}`);
  }
  if (a.design !== b.design) out.push(a.design === null ? 'design.md added' : b.design === null ? 'design.md removed' : 'design.md changed');
  return out;
}
/** The reason for a decision: --reason, else the last `Decision:` line of the change, else the title of an added ADR. */
function reasonFor(changeDir, given, changes) {
  if (given) return given;
  let last = null;
  for (const f of ['proposal.md', 'design.md', 'tasks.md']) for (const m of (read(path.join(changeDir, f)) || '').matchAll(/^\s*[-*]?\s*Decision:\s*(.+?)\s*$/gmi)) last = m[1];
  if (last) return last;
  const adr = changes.map((c) => c.match(/^ADR added: (.+)$/)).find(Boolean);
  if (adr) { const t = read(path.join(changeDir, 'adrs', adr[1])) || ''; const h = t.match(/^#\s+(.+)$/m); if (h) return h[1].trim(); }
  return null;
}
/**
 * Compares the plan with the last snapshot and appends a `decision` event when it changed. The first call only records the
 * snapshot. Returns the event, or null.
 */
function decide(dir, changeDir, ctx = {}) {
  try {
    const now = snapshot(changeDir); const f = path.join(dir, SNAP);
    let before = null; try { before = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { /* first */ }
    if (before && before.hash === now.hash) return null;
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${f}.${process.pid}`; fs.writeFileSync(tmp, JSON.stringify(now) + '\n'); fs.renameSync(tmp, f);
    if (!before) return null;
    const changes = diff(before, now); if (!changes.length) return null;
    const reason = reasonFor(changeDir, ctx.reason, changes);
    const needsOwner = changes.some((c) => /^(Why changed|requirement removed):/.test(c));
    const appr = needsOwner ? ((read(path.join(changeDir, 'proposal.md')) || '').match(/^\s*[-*]?\s*Owner approval:\s*(.+?)\s*$/mi) || [])[1] || 'missing' : null;
    const ev = { event: 'decision', ...(ctx.task ? { task: ctx.task } : {}), session: ctx.session || null, ok: true,
      summary: `plan changed: ${changes.length === 1 ? changes[0] : `${changes.length} changes`}${reason ? ` (${reason})` : ''}`,
      details: { changes, reason: reason || 'none recorded: pass --reason "<why>" or add a `Decision: <why>` line to design.md', owner_approval: appr, seen_at: ctx.cmd } };
    append(dir, ev);
    return ev;
  } catch (e) { return null; }
}
/** Copies the timeline into an archived change folder (next to archived.json). */
function keep(dir, archivedDir) {
  try { if (fs.existsSync(path.join(dir, FILE))) fs.copyFileSync(path.join(dir, FILE), path.join(archivedDir, FILE)); } catch (e) { /* best effort */ }
}

module.exports = { append, readEvents, decide, keep };
