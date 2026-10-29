import { blockers, orderedSlices } from '../model/roadmap.ts';
import type { RoadmapNote, RoadmapReport, RoadmapSlice, SliceStatus } from '../model/roadmap.ts';
import { badge, cmdAttr, copyAttr, emptyState, esc, icon, pageHeader, pillRow, rich, routeAttr } from './components.ts';
import type { Tone } from './components.ts';
import type { ViewData } from './types.ts';

const STATUS_TONE: Record<SliceStatus, Tone> = { planned: 'muted', proposed: 'info', applying: 'accent', done: 'ok' };
const NEXT = 'node openspec/scripts/verify-task.cjs roadmap --next';

function note(n: RoadmapNote, tone: 'bad' | 'warn'): string {
  return `<div class="banner tone-${tone}">${icon('alert', 18)}<div class="body">${rich(n.text)}</div></div>`;
}

function sliceRow(s: RoadmapSlice, r: RoadmapReport): string {
  const waits = blockers(r, s);
  const next = r.nextUp.includes(s.id);
  const sizeBadge = s.size === s.requiredSize ? badge(`size ${s.size}`, 'muted') : badge(`size ${s.size}, needs ${s.requiredSize}`, 'bad', 'The declared size is smaller than the verifier computes from the requirements and risks.');
  const caps = s.capabilities.map((c) => `<code>${esc(c)}</code>`).join(' ');
  const state = next ? badge('next up', 'ok', 'All dependencies are done: /spec-green-next builds this one.') : waits.length && s.status === 'planned' ? badge(`waits for ${waits.join(', ')}`, 'warn') : '';
  return `<div class="item"><div class="grow"><strong>${esc(s.id)}</strong> ${rich(s.title)}
<div class="muted">${caps}</div></div>
${pillRow(`${s.skeleton ? badge('walking skeleton', 'accent') : ''}${badge(s.status, STATUS_TONE[s.status])}${state}${sizeBadge}${badge(s.milestone, 'muted')}${s.contractTests.length ? badge(`contract test: ${s.contractTests.join(', ')}`, 'info') : ''}`)}</div>`;
}

/** The roadmap of a new product, read-only: slices in build order, what is next, and coverage. */
export function roadmapPage(d: ViewData): string {
  const route = d.route;
  if (route.page !== 'roadmap') return '';
  const root = route.root ?? d.projects[0]?.root ?? '';
  const head = (sub: string): string => pageHeader('Roadmap', sub, `<button class="btn" ${cmdAttr('refreshView')} title="Run the verifier again">Refresh</button>`);
  const st = d.roadmap;
  if (!st || st.status === 'loading') return `${head('Reading the roadmap...')}${emptyState('Asking the verifier', 'This takes a moment.')}`;
  if (st.status === 'unavailable') return `${head('')}${emptyState('No roadmap to show', rich(st.reason))}`;
  const r = st.roadmap;
  if (!r.slices.length) return `${head('')}${emptyState('The roadmap has no slices yet', 'It is written by /spec-green-start once the specs are signed off (openspec/roadmap/).')}`;
  const total = r.slices.length;
  const sub = `${r.counts.done} of ${total} slices done${r.nextUp.length ? `, next up: ${r.nextUp.map((i) => `<code>${esc(i)}</code>`).join(', ')}` : ''}`;
  const summary = pillRow(
    `${(['planned', 'proposed', 'applying', 'done'] as const).map((k) => r.counts[k] ? badge(`${r.counts[k]} ${k}`, STATUS_TONE[k]) : '').join('')}${r.errors.length ? badge(`${r.errors.length} plan error${r.errors.length === 1 ? '' : 's'}`, 'bad')   : ''}${r.warnings.length ? badge(`${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}`, 'warn') : ''}${r.coverage.uncovered.length ? badge(`${r.coverage.uncovered.length} requirement(s) in no slice`, 'bad') : ''}`,
  );
  const missing = [...r.coverage.uncovered.map((k) => `<div class="item"><div class="grow"><code>${esc(k)}</code></div>${pillRow(badge('in no slice', 'bad'))}</div>`)].join('');
  return `${head(sub)}<div class="card sum">${summary}</div>
${r.errors.map((n) => note(n, 'bad')).join('')}${r.warnings.map((n) => note(n, 'warn')).join('')}
<h2 class="section-title">Slices in build order <span class="count">${total}</span></h2>
${orderedSlices(r).map((s) => sliceRow(s, r)).join('')}
${missing ? `<h2 class="section-title">Not covered</h2>${missing}` : ''}
<p class="muted">Read-only. The development team builds the next slice with <code>/spec-green-next</code>; <button class="link" ${copyAttr(NEXT)} title="Copy the command">${icon('copy', 12)} copy</button> <code>${esc(NEXT)}</code> to list what is ready.</p>`;
}
