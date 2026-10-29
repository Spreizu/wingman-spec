import { join } from 'node:path';
import { slug } from '../model/anchors.ts';
import type { AnchorMove, BranchReview, TouchedRequirement } from '../model/branchReview.ts';
import type { VerifierFinding } from '../model/verifier.ts';
import { badge, cmdAttr, emptyState, esc, icon, openAttr, pageHeader, pillRow, rich, routeAttr } from './components.ts';
import type { Tone } from './components.ts';
import type { Route, ViewData } from './types.ts';

const VIA_LABEL: Record<TouchedRequirement['via'][number], string> = {
  code: 'code changed',
  test: 'tests changed',
  spec: 'spec changed',
  delta: 'delta spec changed',
  removed: 'anchor removed',
};

const MOVE_TONE: Record<AnchorMove['change'], Tone> = { added: 'ok', removed: 'bad', moved: 'info', changed: 'warn', renamed: 'accent' };
const MOVE_LABEL: Record<AnchorMove['change'], string> = { added: 'added', removed: 'removed', moved: 'moved', changed: 'unit changed', renamed: 'function renamed' };
const SEV_TONE: Record<VerifierFinding['severity'], Tone> = { error: 'bad', warning: 'warn', info: 'info' };

export const reqRoute = (root: string, key: string): Route => ({ page: 'spec', root, name: key.split('/')[0] ?? '', focus: `req:${slug(key.split('/')[1] ?? '')}` });

function section(title: string, count: number, body: string, hint = ''): string {
  return `<h2 class="section-title">${esc(title)} <span class="count">${count}</span></h2>${hint ? `<p class="muted" style="margin-top:-6px">${esc(hint)}</p>` : ''}${count ? body : '<p class="muted">Nothing.</p>'}`;
}

function reqRow(r: TouchedRequirement, root: string): string {
  const tested = r.scenarios ? (r.untested ? badge(`${r.tested}/${r.scenarios} scenarios tested`, 'warn') : '') : badge('not in the specs', 'bad', 'No requirement with this key exists in the current specs');
  return `<div class="item click" role="link" tabindex="0" ${routeAttr(reqRoute(root, r.key))}>
<div class="grow"><strong>${rich(r.name)}</strong> <span class="muted"><code>${esc(r.key)}</code></span>${r.why ? `<div class="muted">${rich(r.why)}</div>` : ''}</div>
${pillRow(`${r.via.map((v) => badge(VIA_LABEL[v], v === 'removed' ? 'bad' : 'muted')).join('')}${tested}`)}</div>`;
}

function anchorRow(a: AnchorMove, review: BranchReview): string {
  const where = `${a.file}:${a.line}`;
  const from = a.from ? ` <span class="muted">from ${esc(`${a.from.file}:${a.from.line}`)}</span>` : '';
  return `<div class="item">
<div class="grow"><button class="link" ${openAttr(join(review.codeRoot, a.file), Math.max(0, a.line - 1))} title="Open the code">${icon('file', 13)} ${esc(where)}</button>${from}
<div class="muted"><code>${esc(a.key)}</code> ${a.header ? `<span>${esc(a.header.trim().slice(0, 80))}</span>` : ''}</div></div>
${pillRow(`${badge(MOVE_LABEL[a.change], MOVE_TONE[a.change])}${a.test ? badge('test', 'muted') : ''}${a.resolves ? `<button class="badge link tone-muted" ${routeAttr(reqRoute(review.root, a.key))}>requirement</button>` : badge('no such requirement', 'bad')}`)}</div>`;
}

function findingRow(f: VerifierFinding, review: BranchReview): string {
  const rel = f.file.startsWith(review.codeRoot) ? f.file.slice(review.codeRoot.length + 1) : f.file;
  return `<div class="item click" role="link" tabindex="0" ${openAttr(f.file, f.line - 1)}>
<div class="grow">${rich(f.message.split('\n')[0] ?? '')}<div class="muted">${esc(`${rel}:${f.line}`)}</div></div>
${pillRow(`${badge(f.severity, SEV_TONE[f.severity])}${badge(f.code, 'muted')}`)}</div>`;
}

export function branchPage(d: ViewData): string {
  const route = d.route;
  if (route.page !== 'branch') return '';
  const root = route.root ?? d.projects[0]?.root ?? '';
  const head = (sub: string): string => pageHeader('Branch review', sub, `<button class="btn" ${cmdAttr('refreshView')} title="Read git and the verifier again">Refresh</button>`);
  const st = d.branch;
  if (!st || st.status === 'loading') return `${head('Reading the branch...')}${emptyState('Reading git and the verifier', 'This takes a moment on a large repository.')}`;
  if (st.status === 'unavailable') return `${head('')}${emptyState('No branch to review', rich(st.reason))}`;
  const r = st.review;
  const errors = r.findings.filter((f) => f.severity === 'error').length;
  const sub = `<code>${esc(r.branch)}</code> against <code>${esc(r.base)}</code> <span class="muted">(merge base ${esc(r.mergeBase.slice(0, 8))})</span>`;
  const summary = pillRow(
    `${badge(`${r.files} file${r.files === 1 ? '' : 's'}`, 'muted')}${badge(`+${r.added} -${r.removed}`, 'muted')}${r.untested.length ? badge(`${r.untested.length} not fully tested`, 'warn') : ''}${errors ? badge(`${errors} verifier error${errors === 1 ? '' : 's'}`, 'bad') : ''}`,
  );
  const notes = r.notes.length ? `<div class="banner tone-warn">${icon('alert', 20)}<div class="body">${r.notes.map((n) => `<div>${rich(n)}</div>`).join('')}</div></div>` : '';
  if (!r.files) return `${head(sub)}${notes}${emptyState('This branch has no changes against its base', 'Nothing to review yet.')}`;
  return `${head(sub)}${notes}<div class="card sum">${summary}</div>
${section('Requirements touched', r.requirements.length, r.requirements.map((q) => reqRow(q, root)).join(''), 'Found from the @spec markers in changed units, changed test tags, and spec text changed in this branch.')}
${section('Not fully tested', r.untested.length, r.untested.map((q) => reqRow(q, root)).join(''), 'Touched requirements with scenarios that no test is tagged for.')}
${section('Anchors', r.anchors.length, r.anchors.map((a) => anchorRow(a, r)).join(''), 'Unit-level: a marker that was added, removed, moved to another place, or whose function body changed.')}
${section('Verifier findings in this diff', r.findings.length, r.findings.map((f) => findingRow(f, r)).join(''), 'Lint, drift gaps, placement, stale and changed anchors, filtered to the files and requirements of this diff.')}`;
}
