import { join } from 'node:path';
import { cli } from '../core/paths.ts';
import { parseFrontMatter } from '../model/frontMatter.ts';
import { renderMarkdown } from '../model/markdown.ts';
import { countScenarios, parseSpec } from '../model/specParser.ts';
import { firstUnchecked } from '../model/tasksParser.ts';
import type { Change, ChangeAdr, ProjectModel, Task, TaskGroup } from '../model/types.ts';
import { ADR_SYNC_LABEL } from '../views/adrLabels.ts';
import { agentButton, badge, noDecisionLine, baseSpecPath, bar, cmdAttr, emptyState, esc, findProject, icon, openAttr, pageHeader, rich, ring, routeAttr, tabbed } from './components.ts';
import type { Tone } from './components.ts';
import { STATE_LABEL, STATE_TONE } from './layout.ts';
import type { TraceChange } from '../model/traceability.ts';
import { buildDashboard } from '../model/changeDashboard.ts';
import { dashboardCard, TASK_STATUS } from './dashboardView.ts';
import { artifactLine } from './artifactLine.ts';
import { diffBlock, requirementCard } from './requirementView.ts';
import { timelineTab } from './timelineView.ts';
import { timelinePath } from '../model/timeline.ts';
import { actionKey } from './types.ts';
import type { ViewData } from './types.ts';
import { actionBar } from './actionsView.ts';
import { changeActions } from '../model/cliActions.ts';

const SYNC_TONE: Record<string, Tone> = {
  'up-to-date': 'ok',
  'not-promoted': 'warn',
  'out-of-date': 'warn',
  unfilled: 'muted',
  none: 'muted',
  error: 'bad',
};

function specLink(project: ProjectModel, change: Change, value: string, d: ViewData): string {
  const cap = value.split('>')[0]?.trim() ?? '';
  const known = change.capabilities.some((c) => c.name === cap) || (d.baseSpecs[project.root] ?? []).includes(cap);
  return known
    ? `<button class="link" ${routeAttr({ page: 'spec', root: project.root, name: cap })}>${rich(value)}</button>`
    : rich(value);
}

function taskRow(project: ProjectModel, change: Change, task: Task, isNext: boolean, d: ViewData, status?: string): string {
  const cls = ['task', task.checked ? 'done' : '', isNext ? 'next-task' : '', task.isReview ? 'review' : ''].filter(Boolean).join(' ');
  const checkbox = `<button class="chk" data-toggle data-path="${esc(change.tasksPath)}" data-line="${task.line}" title="${task.checked ? 'Mark as not done' : 'Mark as done'}" aria-label="Toggle task">${icon('check', 13)}</button>`;
  const head = `${checkbox}<span class="tid">${esc(task.id)}</span><span class="ttitle">${rich(task.title)}</span>
${isNext ? badge('next', 'warn') : ''}${status ?? ''}${task.isReview ? badge('review', 'accent') : ''}
<button class="link" ${openAttr(change.tasksPath, task.line)} title="Open in editor">${icon('file', 13)}</button>`;

  const det = task.details;
  const rows: [string, string | undefined][] = [
    ['Spec', det.spec ? specLink(project, change, det.spec, d) : undefined],
    ['Test first', det.testFirst ? rich(det.testFirst) : undefined],
    ['Files', det.files ? rich(det.files) : undefined],
    ['Done when', det.doneWhen ? rich(det.doneWhen) : undefined],
  ];
  const present = rows.filter((r): r is [string, string] => r[1] !== undefined);
  if (present.length === 0) return `<li class="${cls}"><div class="trow">${head}</div></li>`;
  const dl = present.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');
  return `<li class="${cls}"><details${isNext ? ' open' : ''}><summary>${head}</summary><dl class="tdetails">${dl}</dl></details></li>`;
}

function taskGroup(project: ProjectModel, change: Change, group: TaskGroup, nextTask: Task | undefined, d: ViewData, marks: Map<string, string>): string {
  const done = group.tasks.filter((t) => t.checked).length;
  const title = `${group.number ? `${group.number}. ` : ''}${group.title}`;
  const complete = done === group.tasks.length && group.tasks.length > 0;
  return `<section class="card tgroup"><details${complete ? '' : ' open'}>
<summary><span class="chev">${icon('chevron', 14)}</span>${rich(title)}${group.isCloseOut ? badge('close-out', 'muted') : ''}
${group.tasks.length ? `<span class="gcount">${bar(done, group.tasks.length)}<span>${done}/${group.tasks.length}</span></span>` : ''}</summary>
<ul class="tasks">${group.tasks.map((t) => taskRow(project, change, t, t === nextTask, d, marks.get(t.id))).join('')}</ul></details></section>`;
}

function tasksTab(project: ProjectModel, change: Change, d: ViewData, marks: Map<string, string>): string {
  if (change.groups.length === 0) {
    return emptyState('No tasks yet', 'Run <code>/spec-propose</code> to generate <code>tasks.md</code>.');
  }
  const next = firstUnchecked(change.groups);
  return change.groups.map((g) => taskGroup(project, change, g, next, d, marks)).join('');
}

function docTab(d: ViewData, path: string, missingTitle: string, missingHint: string): string {
  const text = d.texts[path];
  if (text === undefined || !text.trim()) return emptyState(missingTitle, missingHint);
  return `<div class="md">${renderMarkdown(text)}</div>
<p><button class="link" ${openAttr(path)}>${icon('external', 13)} Open file</button></p>`;
}

function specsTab(project: ProjectModel, change: Change, d: ViewData): string {
  if (change.capabilities.length === 0) {
    return emptyState(change.skipSpecs ? 'Specs skipped' : 'No specs yet', change.skipSpecs ? 'proposal.md says <code>Specs: none</code>.' : 'Spec deltas live in <code>specs/&lt;capability&gt;.md</code> of the change.');
  }
  return change.capabilities
    .map((cap) => {
      const text = d.texts[cap.path] ?? '';
      const spec = parseSpec(text);
      const baseText = cap.kind === 'delta' ? d.texts[baseSpecPath(project.root, cap.name)] : undefined;
      const base = baseText === undefined ? undefined : parseSpec(baseText);
      const cards = spec.requirements
        .map((r) => requirementCard(r, { path: cap.path, base: base?.requirements.find((b) => b.name.trim().toLowerCase() === r.name.trim().toLowerCase()) }))
        .join('');
      return `<h2 class="section-title">${icon('file')} ${esc(cap.name)} ${badge(cap.kind, cap.kind === 'new' ? 'ok' : 'warn')}
<span class="count">${spec.requirements.length} requirement${spec.requirements.length === 1 ? '' : 's'}, ${countScenarios(spec)} scenarios</span>
<span style="margin-left:auto"><button class="link" ${routeAttr({ page: 'spec', root: project.root, name: cap.name })}>View capability ${icon('arrow', 13)}</button></span></h2>
${spec.purpose ? `<p class="muted">${esc(spec.purpose)}</p>` : ''}${cards || '<p class="muted">No requirements found.</p>'}`;
    })
    .join('');
}

function adrCard(project: ProjectModel, change: Change, adr: ChangeAdr, d: ViewData): string {
  const sync = adr.sync;
  const tone = SYNC_TONE[sync.state] ?? 'muted';
  const actions: string[] = [];
  if (sync.state === 'not-promoted' || sync.state === 'out-of-date') {
    actions.push(`<button class="btn" ${cmdAttr('promoteAdr', project.root, change.name, adr.slug)} title="Write this ADR to the root adr directory, as /spec-sync would">${icon('arrow', 13)} Promote</button>`);
  }
  if (sync.target) {
    actions.push(`<button class="btn" ${routeAttr({ page: 'adr', root: project.root, number: sync.target.number })}>Promoted ${esc(sync.target.number)}</button>`);
  }
  actions.push(`<button class="btn" ${openAttr(adr.path)}>${icon('external', 13)} Open</button>`);

  let diff = '';
  const sourceText = d.texts[adr.path];
  if (sync.state === 'out-of-date' && sync.target && sourceText !== undefined) {
    const body = parseFrontMatter(sourceText).body;
    diff = `<details open><summary class="muted" style="cursor:pointer;margin-top:12px">Promoted file vs this change</summary>${diffBlock(sync.target.body.trim(), body.trim())}</details>`;
  }

  return `<div class="card req">
<div class="req-head"><h4>${rich(adr.title)}</h4>${badge(adr.status, 'accent')}${sync.state === 'none' || sync.state === 'up-to-date' ? '' : badge(ADR_SYNC_LABEL[sync.state], tone, sync.detail)}</div>
<p class="muted" style="margin:6px 0 10px">${rich(sync.detail)}</p>
<div class="row">${actions.join('')}</div>${diff}</div>`;
}

function adrsTab(project: ProjectModel, change: Change, d: ViewData): string {
  const pending = change.adrs.filter((a) => a.sync.state === 'not-promoted' || a.sync.state === 'out-of-date').length;
  const toolbar = `<div class="toolbar">
<button class="btn" ${cmdAttr('newAdr', project.root, change.name)}>${icon('plus', 13)} New ADR</button>
${pending > 1 ? `<button class="btn" ${cmdAttr('promoteChange', project.root, change.name)}>Promote all (${pending})</button>` : ''}
</div>`;
  const none = noDecisionLine(change.noDecisions);
  if (change.adrs.length === 0) return `${toolbar}${none || emptyState('No ADRs yet', 'Decisions are recorded in <code>adrs/&lt;slug&gt;.md</code>.')}`;
  return `${toolbar}${change.adrs.map((a) => adrCard(project, change, a, d)).join('')}${none}`;
}

/** The page header's agent hand-off for the change's state: [command, label]. A complete change has none: Sync and Archive run the CLI. */
function agentAction(change: Change): [string, string] | undefined {
  const n = change.name;
  switch (change.state) {
    case 'planning':
      return [`/spec-propose ${n}`, 'Plan with agent'];
    case 'blocked':
      return [`/spec-explore ${n}`, 'Explore the blocker'];
    case 'complete':
      return undefined;
    default:
      return [`/spec-apply ${n}`, 'Apply next task'];
  }
}

function traceChangeOf(d: ViewData, root: string, name: string): TraceChange | undefined {
  return d.trace?.find((t) => t.root === root)?.changes.find((c) => c.name === name);
}

export function changePage(d: ViewData): string {
  const route = d.route;
  if (route.page !== 'change') return '';
  const project = findProject(d.projects, route.root);
  const change = project?.changes.find((c) => c.name === route.name);
  if (!project || !change) {
    return `${pageHeader('Change not found', '')}${emptyState('This change no longer exists', 'It may have been archived or renamed.')}`;
  }

  const sub = [badge(STATE_LABEL[change.state], STATE_TONE[change.state])];
  if (change.isWingmanSpec) {
    if (!change.adrsSynced) sub.push(badge('ADRs need sync', 'warn'));
    sub.push(artifactLine(change));
  }
  const main = agentAction(change);
  // Fix findings only when the verifier reported findings for this change.
  const fix = (d.dashboard?.findings ?? []).some((f) => f.change === change.name) ? `/spec-fix ${change.name}` : undefined;
  const headerCmds = [...(main ? [main[0]] : []), ...(fix ? [fix] : [])];
  const aside = `${main ? agentButton(main[0], main[1], true) : ''}${fix ? agentButton(fix, 'Fix findings') : ''}${ring(change.taskDone, change.taskTotal, 56)}
<button class="icon-btn" ${openAttr(change.dir)} title="Reveal change folder">${icon('file')}</button>`;

  const blocked = change.blockedPath
    ? `<div class="banner tone-bad">${icon('block', 20)}<div class="body"><strong>Blocked</strong>
<div class="md">${d.texts[change.blockedPath] ? renderMarkdown(d.texts[change.blockedPath] ?? '') : ''}</div>
<button class="link" ${openAttr(change.blockedPath)}>${icon('external', 13)} Open BLOCKED.md</button></div></div>`
    : '';

  const dashboard = change.isWingmanSpec
    ? buildDashboard({
        change,
        ...(d.texts[join(change.dir, 'proposal.md')] !== undefined ? { proposalText: d.texts[join(change.dir, 'proposal.md')] } : {}),
        ...(traceChangeOf(d, project.root, change.name) ? { traceChange: traceChangeOf(d, project.root, change.name) } : {}),
        gaps: d.trace?.find((t) => t.root === project.root)?.gaps ?? [],
        inputs: d.dashboard ?? {},
        cmd: (a) => cli(a),
      })
    : undefined;
  const marks = new Map<string, string>();
  for (const r of dashboard?.tasks.rows ?? []) {
    const s = TASK_STATUS[r.status];
    if (s) marks.set(r.id, badge(s.label, s.tone));
  }
  const dir = (f: string): string => join(change.dir, f);
  const panes: [string, string, string, number?][] = [
    ['tasks', 'Tasks', tasksTab(project, change, d, marks), change.taskTotal],
  ];
  if (change.isWingmanSpec) {
    panes.unshift(['proposal', 'Proposal', change.state === 'complete' ? docTab(d, dir('proposal.md'), 'No proposal', '') : docTab(d, dir('proposal.md'), 'No proposal yet', 'Run <code>/spec-propose</code> to create it.')]);
    panes.push(
      ['specs', 'Specs', specsTab(project, change, d), change.capabilities.length],
      ['design', 'Design', docTab(d, dir('design.md'), 'No design yet', 'The design is written after the specs.')],
      ['adrs', 'ADRs', adrsTab(project, change, d), change.adrs.length],
      ['app-map', 'App map', docTab(d, dir('app-map.md'), 'No app map yet', 'The app map is the first artifact of a wingman-spec change.')],
    );
  }
  if (change.progressPath) {
    panes.push(['progress', 'Progress', docTab(d, change.progressPath, 'No progress notes yet', 'The implementer writes them while it works.')]);
  }
  if (change.isWingmanSpec) panes.push(['timeline', 'Timeline', timelineTab(d.texts[timelinePath(project.root, change.name)])]);


  return `${pageHeader(change.name, sub.join(' '), aside)}
${blocked}
${change.isWingmanSpec && d.actions ? actionBar(changeActions({ change, ...(dashboard ? { dashboard } : {}), ...(d.dashboard ? { inputs: d.dashboard } : {}), trusted: d.actions.trusted, running: !!d.actions.running }), project.root, change.name, d.actions.running, d.actions.results[actionKey(project.root, change.name)]) : ''}
${dashboard ? dashboardCard(dashboard, d.dashboard === undefined, headerCmds) : ''}
${tabbed(panes, route.tab)}`;
}
