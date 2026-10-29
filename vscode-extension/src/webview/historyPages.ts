import { join } from 'node:path';
import { parseFrontMatter } from '../model/frontMatter.ts';
import { renderMarkdown } from '../model/markdown.ts';
import { parseSpec } from '../model/specParser.ts';
import { parseTasks } from '../model/tasksParser.ts';
import type { ArchivedChange, ProjectModel } from '../model/types.ts';
import { badge, emptyState, plain, rich, noDecisionLine, esc, findProject, icon, openAttr, pageHeader, pillRow, ring, routeAttr, whenText, whenTitle } from './components.ts';
import { linkBadge } from './insightView.ts';
import { requirementCard } from './requirementView.ts';
import { timelineTab } from './timelineView.ts';
import type { ViewData } from './types.ts';

function monthLabel(date: string): string {
  const m = /^(\d{4})-(\d{2})/.exec(date);
  if (!m?.[1] || !m[2]) return 'Undated';
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${names[Number(m[2]) - 1] ?? m[2]} ${m[1]}`;
}

function producedAdrs(project: ProjectModel, c: ArchivedChange): string {
  const promoted = project.adrs.filter((a) => a.change === c.name);
  if (promoted.length > 0) {
    return promoted
      .map((a) => linkBadge(a.number, 'accent', routeAttr({ page: 'adr', root: project.root, number: a.number }), plain(a.title)))
      .join('');
  }
  return c.adrs.length > 0 ? badge(`${c.adrs.length} ADR${c.adrs.length === 1 ? '' : 's'}`, 'accent') : '';
}

function historyCard(project: ProjectModel, c: ArchivedChange): string {
  const text = `${c.name} ${c.date} ${c.capabilities.join(' ')} ${c.adrs.map((a) => a.title).join(' ')}`;
  return `<div class="tl-item tone-ok" data-item data-cat="all" data-text="${esc(plain(text))}">
<article class="card click" ${routeAttr({ page: 'archived', root: project.root, name: c.dirName })}>
<div class="cc-top">${ring(c.taskDone, c.taskTotal, 44)}
<div class="t"><h3>${esc(c.name)}</h3><div class="cc-meta" title="${esc(whenTitle(c.archived, 'Archived'))}">${esc(whenText(c.date, c.archived))} &middot; ${c.taskTotal > 0 ? `${c.taskDone} of ${c.taskTotal} tasks` : 'no tasks recorded'}</div></div></div>
${pillRow(`${c.capabilities.map((cap) => badge(cap, 'info')).join('')}${producedAdrs(project, c)}`)}</article></div>`;
}

export function historyPage(d: ViewData): string {
  const project = findProject(d.projects, d.route.page === 'history' ? d.route.root : undefined);
  if (!project) return `${pageHeader('History', '', '', false)}${emptyState('No OpenSpec project found', '')}`;
  const archive = project.archive;
  if (archive.length === 0) {
    return `${pageHeader('History', 'Archived changes', '', false)}${emptyState('Nothing archived yet', 'Archived changes appear here after <code>/spec-archive</code>, with the specs and ADRs they produced.')}`;
  }

  const months = new Map<string, ArchivedChange[]>();
  for (const c of archive) months.set(monthLabel(c.date), [...(months.get(monthLabel(c.date)) ?? []), c]);
  const body = [...months.entries()]
    .map(([month, items]) => `<h2 class="section-title">${esc(month)} <span class="count">${items.length}</span></h2><div class="timeline">${items.map((c) => historyCard(project, c)).join('')}</div>`)
    .join('');

  const totalTasks = archive.reduce((n, c) => n + c.taskDone, 0);
  return `${pageHeader('History', `${archive.length} archived change${archive.length === 1 ? '' : 's'}${totalTasks > 0 ? ` &middot; ${totalTasks} tasks completed` : ''}`, '', false)}
<div class="toolbar"><label class="search">${icon('search', 15)}<input data-filter-input placeholder="Filter by change, capability or ADR" aria-label="Filter history"></label></div>
${body}`;
}

function readOnlyTasks(text: string | undefined): string {
  if (text === undefined) return emptyState('No tasks recorded', '');
  const groups = parseTasks(text);
  if (groups.length === 0) return emptyState('No tasks recorded', '');
  return groups
    .map((g) => {
      const items = g.tasks
        .map((t) => `<li class="task${t.checked ? ' done' : ''}"><div class="trow"><span class="chk">${icon('check', 13)}</span><span class="tid">${esc(t.id)}</span><span class="ttitle">${rich(t.title)}</span></div></li>`)
        .join('');
      return `<section class="card tgroup"><details open><summary><span class="chev">${icon('chevron', 14)}</span>${rich(`${g.number ? `${g.number}. ` : ''}${g.title}`)}</summary><ul class="tasks">${items}</ul></details></section>`;
    })
    .join('');
}

export function archivedPage(d: ViewData): string {
  const route = d.route;
  if (route.page !== 'archived') return '';
  const project = findProject(d.projects, route.root);
  const c = project?.archive.find((a) => a.dirName === route.name);
  if (!project || !c) return `${pageHeader('Archived change not found', '')}${emptyState('It may have been removed from the archive folder.', '')}`;

  const doc = (file: string, hint: string): string => {
    const path = join(c.dir, file);
    const text = d.texts[path];
    return text === undefined ? emptyState('Not recorded', hint) : `<div class="md">${renderMarkdown(text)}</div><p><button class="link" ${openAttr(path)}>${icon('external', 13)} Open file</button></p>`;
  };

  const specs =
    c.capabilities.length === 0
      ? emptyState('No specs', 'This change did not carry delta specs.')
      : c.capabilities
          .map((cap) => {
            const path = join(c.dir, 'specs', cap, 'spec.md');
            const spec = parseSpec(d.texts[path] ?? '');
            return `<h2 class="section-title">${icon('file')} ${esc(cap)} ${d.baseSpecs[project.root]?.includes(cap) ? `<button class="link" ${routeAttr({ page: 'spec', root: project.root, name: cap })}>current spec ${icon('arrow', 13)}</button>` : ''}</h2>
${spec.requirements.map((r) => requirementCard(r, { path })).join('') || '<p class="muted">No requirements found.</p>'}`;
          })
          .join('');

  const adrCards =
    c.adrs.length === 0
      ? c.noDecisions.length > 0
        ? ''
        : emptyState('No ADRs', 'This change recorded no decisions.')
      : c.adrs
          .map((a) => {
            const text = d.texts[join(c.dir, 'adrs', `${a.slug}.md`)];
            const promoted = project.adrs.find((r) => r.source === `${c.name}/${a.slug}`);
            return `<section class="card sect"><div class="req-head"><h4>${rich(a.title)}</h4>${badge(a.status, 'accent')}
${promoted ? `<button class="link" style="margin-left:auto" ${routeAttr({ page: 'adr', root: project.root, number: promoted.number })}>Promoted as ${esc(promoted.number)} ${icon('arrow', 13)}</button>` : ''}</div>
${text ? `<div class="md" style="margin-top:10px">${renderMarkdown(parseFrontMatter(text).body)}</div>` : ''}</section>`;
          })
          .join('');
  const adrs = adrCards + noDecisionLine(c.noDecisions);

  const panes: [string, string, string][] = [
    ['proposal', 'Proposal', doc('proposal.md', 'No proposal was archived.')],
    ['specs', 'Specs', specs],
    ['design', 'Design', doc('design.md', 'No design was archived.')],
    ['adrs', 'ADRs', adrs],
    ['tasks', 'Tasks', readOnlyTasks(d.texts[join(c.dir, 'tasks.md')])],
    ['timeline', 'Timeline', timelineTab(d.texts[join(c.dir, 'timeline.jsonl')])],
  ];
  const tabs = panes.map(([id, label]) => `<button class="tab" data-tab="${id}">${esc(label)}</button>`).join('');
  const bodies = panes.map(([id, , html]) => `<div class="pane" data-pane="${id}">${html}</div>`).join('');
  const sub = `<span title="${esc(whenTitle(c.archived, 'Archived'))}">${esc(whenText(c.date, c.archived))}</span>`;
  const aside = `${ring(c.taskDone, c.taskTotal, 56)}<button class="icon-btn" ${openAttr(c.dir)} title="Reveal folder">${icon('file')}</button>`;
  return `${pageHeader(c.name, sub, aside)}<div class="tabs" role="tablist">${tabs}</div>${bodies}`;
}
