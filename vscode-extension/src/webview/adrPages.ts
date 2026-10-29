import { adrCategory, buildAdrLinks, lineageOf, statusCounts, supersedesNumber } from '../model/adrGraph.ts';
import type { AdrCategory } from '../model/adrGraph.ts';
import { layoutAdrGraph, NODE_H, NODE_W } from '../model/adrLayout.ts';
import { renderMarkdown, splitSections } from '../model/markdown.ts';
import type { ProjectModel, RootAdr } from '../model/types.ts';
import { ADR_SYNC_LABEL } from '../views/adrLabels.ts';
import { attMain, plain, rich, badge, cmdAttr, emptyState, esc, findProject, icon, openAttr, pageHeader, routeAttr } from './components.ts';
import type { Tone } from './components.ts';
import { linkBadge } from './insightView.ts';
import type { ViewData } from './types.ts';

const CATEGORY_TONE: Record<AdrCategory, Tone> = {
  accepted: 'ok',
  proposed: 'info',
  superseded: 'muted',
  deprecated: 'warn',
  other: 'muted',
};

const CATEGORY_LABEL: Record<AdrCategory, string> = {
  accepted: 'Accepted',
  proposed: 'Proposed',
  superseded: 'Superseded',
  deprecated: 'Deprecated',
  other: 'Other',
};

function adrRoute(project: ProjectModel, adr: RootAdr): string {
  return routeAttr({ page: 'adr', root: project.root, number: adr.number });
}

function decisionSnippet(adr: RootAdr): string {
  const decision = splitSections(adr.body).sections.find((s) => s.title.toLowerCase() === 'decision');
  const text = (decision?.body ?? '').replace(/[`*_>#-]/g, '').replace(/\s+/g, ' ').trim();
  return text.length > 220 ? `${text.slice(0, 217)}...` : text;
}

function adrCard(project: ProjectModel, adr: RootAdr, links: ReturnType<typeof buildAdrLinks>): string {
  const cat = adrCategory(adr.status);
  const link = links.get(adr.number);
  const chips: string[] = [];
  if (link?.supersedes) chips.push(badge(`supersedes ${link.supersedes.number}`, 'info'));
  for (const s of link?.supersededBy ?? []) chips.push(badge(`superseded by ${s.number}`, 'warn'));
  const text = `${adr.number} ${adr.title} ${adr.status} ${adr.change} ${adr.slug}`;
  return `<div class="tl-item tone-${CATEGORY_TONE[cat]}" data-item data-cat="${cat}" data-text="${esc(plain(text))}">
<article class="card click adr-card${cat === 'superseded' ? ' superseded' : ''}" ${adrRoute(project, adr)}>
<div class="row"><span class="adr-num">${esc(adr.number)}</span>${badge(adr.status || 'no status', CATEGORY_TONE[cat])}${chips.join('')}
<span class="muted" style="margin-left:auto">${esc(adr.date)}</span></div>
<h3>${rich(adr.title || adr.slug)}</h3>
${adr.change ? `<div class="muted">from change <code>${esc(adr.change)}</code></div>` : ''}
${decisionSnippet(adr) ? `<p class="snippet">${esc(decisionSnippet(adr))}</p>` : ''}
</article></div>`;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}...` : text;
}

/** Supersede chains as an SVG: older decisions on the left, the ADRs that replaced them to the right. */
function graphView(project: ProjectModel): string {
  const g = layoutAdrGraph(project.adrs);
  if (g.nodes.length === 0) {
    return emptyState('No supersede chains yet', 'When an ADR sets <code>supersedes: NNNN</code>, the chain shows up here.');
  }
  const at = new Map(g.nodes.map((n) => [n.adr.number, n]));
  const edges = g.edges
    .map((e) => {
      const a = at.get(e.from);
      const b = at.get(e.to);
      if (!a || !b) return '';
      const x1 = a.x + NODE_W;
      const y1 = a.y + NODE_H / 2;
      const x2 = b.x - 4;
      const y2 = b.y + NODE_H / 2;
      const mid = (x1 + x2) / 2;
      return `<path class="gedge" d="M${x1} ${y1} C${mid} ${y1} ${mid} ${y2} ${x2} ${y2}" marker-end="url(#arrow)"/>`;
    })
    .join('');
  const nodes = g.nodes
    .map(({ adr, x, y }) => {
      const cat = adrCategory(adr.status);
      return `<g class="gnode tone-${CATEGORY_TONE[cat]}" transform="translate(${x} ${y})" ${adrRoute(project, adr)}>
<title>${esc(plain(`${adr.number} ${adr.title} (${adr.status || 'no status'})`))}</title>
<rect width="${NODE_W}" height="${NODE_H}" rx="10"/>
<text class="gnum" x="12" y="21">${esc(adr.number)}</text>
<text class="gstatus" x="${NODE_W - 12}" y="21" text-anchor="end">${esc(truncate(adr.status || 'no status', 18))}</text>
<text class="gtitle" x="12" y="40">${esc(plain(truncate(adr.title || adr.slug, 28)))}</text></g>`;
    })
    .join('');
  const standalone =
    g.standalone.length === 0
      ? ''
      : `<h2 class="section-title">Not linked <span class="count">${g.standalone.length}</span></h2>
<div class="row">${g.standalone.map((a) => linkBadge(`${a.number} ${plain(truncate(a.title, 32))}`, CATEGORY_TONE[adrCategory(a.status)], adrRoute(project, a))).join('')}</div>`;
  return `<div class="graph-wrap card"><svg class="graph" width="${g.width}" height="${g.height}" viewBox="0 0 ${g.width} ${g.height}" role="img" aria-label="ADR supersede chains">
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path class="garrow" d="M0 0L10 5L0 10z"/></marker></defs>
${edges}${nodes}</svg></div>
<p class="muted" style="margin-top:8px">An arrow points from an ADR to the ADR that superseded it. Click a node to open it.</p>${standalone}`;
}

export function adrsPage(d: ViewData): string {
  const project = findProject(d.projects, d.route.page === 'adrs' ? d.route.root : undefined);
  if (!project) return `${pageHeader('ADRs', '', '', false)}${emptyState('No OpenSpec project found', '')}`;

  const counts = statusCounts(project.adrs);
  const links = buildAdrLinks(project.adrs);
  const chips = [
    `<button class="chip" data-chip="all">All ${project.adrs.length}</button>`,
    ...(Object.keys(counts) as AdrCategory[])
      .filter((c) => counts[c] > 0)
      .map((c) => `<button class="chip tone-${CATEGORY_TONE[c]}" data-chip="${c}">${CATEGORY_LABEL[c]} ${counts[c]}</button>`),
  ].join('');

  const pending = project.changes.flatMap((c) =>
    c.adrs
      .filter((a) => a.sync.state === 'not-promoted' || a.sync.state === 'out-of-date' || a.sync.state === 'error')
      .map((a) => ({ c, a })),
  );

  const pendingHtml =
    pending.length === 0
      ? ''
      : `<h2 class="section-title">Waiting in changes <span class="count">${pending.length}</span></h2>
<div class="attention">${pending
          .map(
            ({ c, a }) =>
              `<div class="att tone-warn" ${routeAttr({ page: 'change', root: project.root, name: c.name, tab: 'adrs' })}>${icon('adr')}${attMain(a.title, c.name)}${badge(ADR_SYNC_LABEL[a.sync.state], 'warn')}</div>`,
          )
          .join('')}</div>`;

  const ordered = [...project.adrs].reverse();
  const timeline = `<div class="toolbar"><label class="search">${icon('search', 15)}<input data-filter-input placeholder="Filter by number, title, status or change" aria-label="Filter ADRs"></label>${chips}</div>
<div class="timeline">${ordered.map((a) => adrCard(project, a, links)).join('')}</div>`;
  const body =
    project.adrs.length === 0
      ? emptyState('No promoted ADRs yet', '<code>/spec-sync &lt;change&gt;</code> or the Promote button on a change ADR moves it to the adr directory.')
      : `<div class="tabs" role="tablist"><button class="tab" data-tab="timeline">${icon('clock', 14)} Timeline</button><button class="tab" data-tab="graph">${icon('graph', 14)} Graph</button></div>
<div class="pane" data-pane="timeline">${timeline}</div><div class="pane" data-pane="graph">${graphView(project)}</div>`;

  const aside = `<button class="btn" ${cmdAttr('newAdr', project.root)}>${icon('plus', 13)} New ADR</button>`;
  return `${pageHeader('Architecture decisions', `${project.adrs.length} promoted in <code>${esc(project.adrDir.split(/[\\/]/).pop() ?? 'adr')}</code>`, aside, false)}${body}${pendingHtml}`;
}

function lineage(project: ProjectModel, adr: RootAdr, links: ReturnType<typeof buildAdrLinks>): string {
  const chain = lineageOf(adr.number, links);
  if (chain.length < 2) return '';
  return `<div class="lineage">${chain
    .map((a) => {
      const cat = adrCategory(a.status);
      const current = a.number === adr.number;
      return `<div class="node tone-${CATEGORY_TONE[cat]}${current ? ' current' : ''}" ${current ? '' : adrRoute(project, a)} title="${esc(a.status)}"><span class="adr-num">${esc(a.number)}</span><span>${rich(a.title)}</span></div>`;
    })
    .join('<span class="sep"></span>')}</div>`;
}

export function adrPage(d: ViewData): string {
  const route = d.route;
  if (route.page !== 'adr') return '';
  const project = findProject(d.projects, route.root);
  const adr = project?.adrs.find((a) => a.number === route.number);
  if (!project || !adr) return `${pageHeader('ADR not found', '')}${emptyState('This ADR no longer exists', '')}`;

  const links = buildAdrLinks(project.adrs);
  const cat = adrCategory(adr.status);
  const { preamble, sections } = splitSections(adr.body);
  const preBody = preamble.replace(/^#\s+.*$/m, '').trim();

  const cards = sections
    .map((s) => {
      const cls = s.title.toLowerCase() === 'decision' ? ' decision' : '';
      return `<section class="card sect${cls}"><h3>${rich(s.title)}</h3><div class="md">${s.body ? renderMarkdown(s.body) : '<p class="muted">Empty.</p>'}</div></section>`;
    })
    .join('');

  const sup = supersedesNumber(adr);
  const link = links.get(adr.number);
  const meta: [string, string][] = [
    ['Status', badge(adr.status || 'no status', CATEGORY_TONE[cat])],
    ['Date', esc(adr.date || '-')],
  ];
  if (adr.change) meta.push(['Change', `<code>${esc(adr.change)}</code>`]);
  if (adr.source) meta.push(['Source', `<code>${esc(adr.source)}</code>`]);
  if (sup) {
    const old = project.adrs.find((a) => a.number === sup);
    meta.push(['Supersedes', old ? `<button class="link" ${adrRoute(project, old)}>${esc(old.number)} ${rich(old.title)}</button>` : esc(sup)]);
  }
  for (const s of link?.supersededBy ?? []) {
    meta.push(['Superseded by', `<button class="link" ${adrRoute(project, s)}>${esc(s.number)} ${rich(s.title)}</button>`]);
  }

  const aside = `<button class="btn" ${cmdAttr('supersedeAdr', project.root, adr.number)} title="Draft a new ADR in an active change that supersedes this one">${icon('plus', 13)} Supersede</button><button class="btn" ${openAttr(adr.path)}>${icon('external', 14)} Open file</button>`;
  return `${pageHeader(`${adr.number} ${adr.title || adr.slug}`, '', aside)}
${lineage(project, adr, links)}
<section class="card sect"><dl class="meta">${meta.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl></section>
${preBody ? `<div class="md" style="margin-bottom:14px">${renderMarkdown(preBody)}</div>` : ''}
${cards}`;
}
