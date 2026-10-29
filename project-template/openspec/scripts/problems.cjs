'use strict';
/*
 * problems.cjs - the verifier's findings as one flat, located list (`verify-task.cjs problems [<change>] [--json]`), for editors.
 * Pure mapping over what the other scripts already compute: lint problems of the active changes, drift gaps (with the file and line
 * each gap is about), anchor-guard findings. It decides nothing itself; severities are the verifier's own levels
 * (error | warning | info). Paths are absolute, lines and columns 1-based. A finding may carry `fix`, a mechanical repair
 * the editor can offer: { kind: 'replace-key', to } | 'move-marker' | 'remove-duplicate' | 'remove-marker' | 'add-derives' | 'accept' | 'add-test-tag'.
 */
const fs = require('fs');
const path = require('path');

const readIf = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch (e) { return null; } };
const sevOf = (s) => (s === 'error' ? 'error' : s === 'warn' || s === 'warning' ? 'warning' : 'info');

/** Every occurrence of `needle`: [{ line, col, length }]. */
function locateAll(file, needle) {
  const t = readIf(file); if (t === null) return [];
  const out = [];
  t.split(/\r?\n/).forEach((l, i) => { let c = l.indexOf(needle); while (c >= 0) { out.push({ line: i + 1, col: c + 1, length: needle.length }); c = l.indexOf(needle, c + needle.length); } });
  return out;
}

/** Drift gaps -> findings. `gaps` as T.drift returns them (the open ones), `reqs` the living requirements (with file/line/scenarios). */
function driftFindings(gaps, ctx) {
  const abs = (f) => (path.isAbsolute(f) ? f : path.join(ctx.codeRoot, f));
  const out = [];
  for (const g of gaps) {
    const base = { source: 'drift', code: g.type, severity: ['misplaced-marker', 'over-anchored', 'stale-anchor', 'unconfirmed-requirement', 'observed-incomplete'].includes(g.type) ? sevOf(g.severity) : 'error', key: g.key, ...(g.hint ? { hint: g.hint } : {}) };
    const push = (f) => out.push({ ...base, ...f, message: f.message || g.text });
    if (g.type === 'observed-incomplete') {
      push({ file: path.join(ctx.root, g.files[0]), line: g.line || 1, col: 1, length: 1 });
    } else if (g.type === 'unconfirmed-requirement') {
      const r = ctx.reqs.get(g.subject); if (!r) continue;
      push({ file: r.file, line: r.line, col: 1, length: `### Requirement: ${r.name}`.length, requirement: g.subject });
    } else if (g.type === 'unanchored-requirement' || g.type === 'untested-requirement') {
      const r = ctx.reqs.get(g.subject); if (!r) continue;
      push({ file: r.file, line: r.line, col: 1, length: `### Requirement: ${r.name}`.length, fix: { kind: g.type === 'untested-requirement' ? 'add-test-tag' : 'accept', ...(g.type === 'untested-requirement' ? { scenarios: r.scenarios.map((s) => ({ name: s.name, id: `${r.cap}/${s.slug}` })) } : {}) }, requirement: g.subject });
    } else if (g.type === 'orphan-anchor') {
      const [k, f] = [g.subject.slice(0, g.subject.indexOf('@')), g.subject.slice(g.subject.indexOf('@') + 1)];
      const hits = locateAll(abs(f), k);
      const near = /perhaps renamed to (\S+)/.exec(g.hint || '');
      for (const h of hits.length ? hits : [{ line: 1, col: 1, length: 1 }]) push({ file: abs(f), ...h, ...(near ? { fix: { kind: 'replace-key', to: near[1] } } : {}) });
    } else if (g.type === 'stale-test-tag') {
      const near = /perhaps renamed to \[(\S+)\]/.exec(g.hint || '');
      for (const f of g.files || []) for (const h of locateAll(abs(f), `[${g.subject}]`)) push({ file: abs(f), line: h.line, col: h.col + 1, length: g.subject.length, ...(near ? { fix: { kind: 'replace-key', to: near[1] } } : {}) });
    } else if (g.type === 'misplaced-marker') {
      const m = /^(.+?):(\d+): ([a-z-]+):/.exec(g.text);
      if (!m) continue;
      const line = Number(m[2]); const f = abs(m[1]); const t = (readIf(f) || '').split(/\r?\n/)[line - 1] || '';
      const c = t.indexOf('@spec');
      push({ file: f, line, col: c >= 0 ? c + 1 : 1, length: c >= 0 ? Math.max(5, t.length - c) : Math.max(1, t.length), fix: { kind: m[3] === 'duplicate-marker' ? 'remove-duplicate' : 'move-marker' }, reason: m[3] });
    } else if (g.type === 'over-anchored') {
      const line = g.line || 1; const f = abs(g.files[0]); const t = (readIf(f) || '').split(/\r?\n/)[line - 1] || '';
      const c = t.indexOf('@spec');
      push({ file: f, line, col: c >= 0 ? c + 1 : 1, length: c >= 0 ? Math.max(5, t.length - c) : Math.max(1, t.length), reason: g.fit, ...(g.removable ? { fix: { kind: 'remove-marker', key: g.subject.split('@')[0] } } : {}) });
    } else if (g.type === 'stale-anchor') {
      const m = /^(.+?):(\d+): /.exec(g.text);
      if (!m) continue;
      const line = Number(m[2]); const f = abs(m[1]); const t = (readIf(f) || '').split(/\r?\n/)[line - 1] || '';
      push({ file: f, line, col: 1, length: Math.max(1, t.length), fix: { kind: 'accept' } });
    } else if (g.type === 'unsynced-archive') {
      push({ file: path.join(ctx.root, 'openspec', 'changes', 'archive'), line: 1, col: 1, length: 1 });
    }
  }
  return out;
}

/** Lint problems of one change (as `lint` prints them in `plan`/`problems`) -> findings. */
function lintFindings(problems, ctx) {
  const out = [];
  for (const p of problems) {
    if (!p || !p.text || p.severity === 'ok') continue;
    let file = p.file || '';
    if (file && !path.isAbsolute(file)) { const a = path.join(ctx.changeDir, file); file = fs.existsSync(a) ? a : path.join(ctx.codeRoot, file); }
    if (!file) file = path.join(ctx.changeDir, 'proposal.md');
    const text = String(p.text).replace(/^[^\s:]+\.md:\d+: /, '');
    const f = { source: 'lint', code: p.kind || 'lint', severity: sevOf(p.severity), message: text, file, line: p.line || 1, col: 1, length: 1, change: ctx.change };
    const t = (readIf(file) || '').split(/\r?\n/)[f.line - 1];
    if (t !== undefined) f.length = Math.max(1, t.length);
    if (p.kind === 'missing-why') f.fix = { kind: 'add-why' };
    out.push(f);
  }
  return out;
}

/** Anchor-guard findings -> findings. */
function guardFindings(findings, ctx) {
  return findings.map((x) => ({ source: 'guard', code: x.kind, severity: ctx.level === 'error' ? 'error' : 'warning', message: x.text, file: path.isAbsolute(x.file || '') ? x.file : path.join(ctx.codeRoot, x.file || ''), line: x.line || 1, col: 1, length: 1, key: x.key, change: ctx.change }));
}

/** Identical findings (same source, code, file, line, message) once; stable order: errors first, then by file and line. */
function finish(list) {
  const seen = new Set(); const out = [];
  for (const f of list) { const k = [f.source, f.code, f.file, f.line, f.message].join('\u0000'); if (!seen.has(k)) { seen.add(k); out.push(f); } }
  const rank = { error: 0, warning: 1, info: 2 };
  return out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
}

module.exports = { driftFindings, lintFindings, guardFindings, finish };
