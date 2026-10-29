import { basename, join } from 'node:path';
import { adrCategory } from '../model/adrGraph.ts';
import { excerptWhy } from '../model/proposalExcerpt.ts';
import type { ArchivedChange, Change, ProjectModel } from '../model/types.ts';
import { agentButton, attMain, badge, cmdAttr, emptyState, esc, icon, pageHeader, pillRow, ring, routeAttr, whenText, whenTitle } from './components.ts';
import type { Tone } from './components.ts';
import { STATE_LABEL, STATE_TONE } from './layout.ts';
import type { ViewData } from './types.ts';

const LANES: { id: Change['state']; title: string }[] = [
  { id: 'planning', title: 'Planning' },
  { id: 'in-progress', title: 'In progress' },
  { id: 'blocked', title: 'Blocked' },
  { id: 'complete', title: 'Ready' },
];

function utcMonthPrefix(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

function whyOf(d: ViewData, dir: string): string {
  return excerptWhy(d.texts[join(dir, 'proposal.md')]);
}

function blockedExcerpt(d: ViewData, path: string | undefined): string {
  if (!path) return '';
  const text = d.texts[path];
  if (text === undefined) return '';
  const plain = text.replace(/[#*_`]/g, '').replace(/\s+/g, ' ').trim();
  return plain.length > 160 ? `${plain.slice(0, 159).trimEnd()}...` : plain;
}

function changeCard(project: ProjectModel, c: Change, d: ViewData): string {
  const why = whyOf(d, c.dir);
  const blocked = c.state === 'blocked' ? blockedExcerpt(d, c.blockedPath) : '';
  return `<article class="card click po-card" ${routeAttr({ page: 'change', root: project.root, name: c.name })}>
<div class="cc-top">${ring(c.taskDone, c.taskTotal, 44, STATE_TONE[c.state])}
<div class="t"><h3 title="${esc(c.name)}">${esc(c.name)}</h3>
<div class="cc-meta" title="${esc(whenTitle(c.created, 'Created'))}">${c.taskTotal > 0 ? `${c.taskDone} of ${c.taskTotal} tasks` : 'No tasks yet'}${c.created && c.created.source !== 'none' ? ` &middot; ${esc(whenText('', c.created))}` : ''}</div></div>
${c.state === 'blocked' || c.state === 'complete' ? badge(STATE_LABEL[c.state], STATE_TONE[c.state]) : ''}</div>
${why ? `<p class="snippet">${esc(why)}</p>` : ''}
${blocked ? `<p class="muted">${esc(blocked)}</p>` : ''}
${pillRow(`${c.capabilities.map((cap) => badge(cap.name, 'info')).join('')}${c.state === 'blocked' ? agentButton(`/spec-fix ${c.name}`, 'Fix findings') : ''}`)}
</article>`;
}

function archiveCard(project: ProjectModel, c: ArchivedChange, d: ViewData): string {
  const why = whyOf(d, c.dir);
  return `<article class="card click po-card" ${routeAttr({ page: 'archived', root: project.root, name: c.dirName })}>
<div class="cc-top"><div class="t"><h3>${esc(c.name)}</h3>
<div class="cc-meta" title="${esc(whenTitle(c.archived, 'Archived'))}">${esc(whenText(c.date, c.archived))}</div></div></div>
${why ? `<p class="snippet">${esc(why)}</p>` : ''}
${pillRow(c.capabilities.map((cap) => badge(cap, 'info')).join(''))}
</article>`;
}

function stat(tone: Tone, glyph: string, value: string, label: string): string {
  return `<div class="card stat tone-${tone}"><span class="glyph">${glyph}</span><div><div class="num">${esc(value)}</div><div class="lbl">${esc(label)}</div></div></div>`;
}

export function overviewPage(d: ViewData): string {
  if (d.projects.length === 0) {
    return `${pageHeader('Overview', '', '', false)}${emptyState('No OpenSpec project found', 'Open a folder that contains <code>openspec/config.yaml</code>.')}`;
  }

  const changes = d.projects.flatMap((p) => p.changes.map((c) => ({ p, c })));
  const archive = d.projects.flatMap((p) => p.archive.map((c) => ({ p, c })));
  const month = utcMonthPrefix();
  const shippedMonth = archive.filter(({ c }) => c.date.startsWith(month)).length;
  const inFlight = changes.filter(({ c }) => c.state === 'planning' || c.state === 'in-progress').length;
  const blocked = changes.filter(({ c }) => c.state === 'blocked').length;
  const ready = changes.filter(({ c }) => c.state === 'complete').length;
  const adrs = d.projects.flatMap((p) => p.adrs);
  const accepted = adrs.filter((a) => adrCategory(a.status) === 'accepted').length;
  const recent = archive.slice(0, 8);
  const multi = d.projects.length > 1;
  const first = d.projects[0];

  const setupBanner = d.setup.commands
    ? ''
    : `<div class="banner tone-warn">${icon('alert', 20)}<div class="body"><strong>Agent commands are not installed in this workspace</strong>
<div class="muted">Missing: ${d.setup.missing.map((m) => `<code>${esc(m)}</code>`).join(', ')}. Run the package's <code>install.sh</code> so the agent buttons work.</div></div></div>`;
  const newChange = `<button class="btn primary" ${cmdAttr('newChange', first?.root ?? '')}>${icon('plus', 13)} New change</button>`;

  const board = LANES.map((lane) => {
    const cards = d.projects
      .map((p) => {
        const items = p.changes.filter((c) => c.state === lane.id).map((c) => changeCard(p, c, d)).join('');
        const title = multi && items ? `<div class="nav-label">${esc(basename(p.workspaceFolder))}</div>` : '';
        return `${title}${items}`;
      })
      .join('');
    return `<div class="lane"><h3>${esc(lane.title)}</h3>${cards || `<p class="muted">None</p>`}</div>`;
  }).join('');

  const decisionItems = changes
    .filter(({ c }) => c.state === 'blocked')
    .map(({ p, c }) => {
      const hint = blockedExcerpt(d, c.blockedPath) || 'See BLOCKED.md';
      return `<div class="att tone-bad" ${routeAttr({ page: 'change', root: p.root, name: c.name })}>${icon('block')}
${attMain(c.name, hint)}${icon('chevron', 14)}</div>`;
    });

  const syncItems = changes
    .filter(({ c }) => !c.adrsSynced)
    .map(({ p, c }) => {
      const n = c.adrs.filter((a) => a.sync.state === 'not-promoted' || a.sync.state === 'out-of-date').length;
      return `<div class="att tone-warn" ${routeAttr({ page: 'change', root: p.root, name: c.name })}>${icon('alert')}
${attMain(c.name, `${n} ADR${n === 1 ? '' : 's'} need syncing`)}
${c.state === 'complete' ? agentButton(`/spec-archive ${c.name}`, 'Archive with agent') : agentButton(`/spec-sync ${c.name}`, 'Sync ADRs')}${icon('chevron', 14)}</div>`;
    });

  const shipped =
    recent.length === 0
      ? emptyState('Nothing archived yet', 'Shipped changes appear here after <code>/opsx:archive</code>.')
      : `<div class="grid">${recent.map(({ p, c }) => archiveCard(p, c, d)).join('')}</div>`;

  return `${pageHeader('Overview', `${changes.length} active change${changes.length === 1 ? '' : 's'}`, newChange, false)}
${setupBanner}<div class="stats">
${stat('info', icon('play', 18), String(inFlight), 'In flight')}
${stat(blocked > 0 ? 'bad' : 'muted', icon('block', 18), String(blocked), 'Blocked')}
${stat('ok', icon('check', 18), String(ready), 'Ready to sync')}
${stat('accent', icon('adr', 18), String(adrs.length), `ADRs (${accepted} accepted)`)}
${stat('muted', icon('archive', 18), String(shippedMonth), 'Shipped this month')}
</div>
<h2 class="section-title">Delivery</h2>
<div class="board">${board}</div>
${
  decisionItems.length > 0
    ? `<h2 class="section-title">Needs a product decision <span class="count">${decisionItems.length}</span></h2>
<div class="attention">${decisionItems.join('')}</div>`
    : ''
}
${
  syncItems.length > 0
    ? `<h2 class="section-title">ADRs need syncing <span class="count">${syncItems.length}</span></h2>
<div class="attention">${syncItems.join('')}</div>`
    : ''
}
<h2 class="section-title">Recently shipped <span class="count">${recent.length}</span></h2>
${shipped}`;
}
