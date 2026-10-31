import { parseSpec, countScenarios, findRequirement } from '../model/specParser.ts';
import type { ParsedSpec } from '../model/specParser.ts';
import { badge, baseSpecPath, emptyState, esc, findProject, icon, openAttr, pageHeader, pillRow, plain, routeAttr } from './components.ts';
import { slug } from '../model/anchors.ts';
import { insightOf } from '../model/reqInsight.ts';
import { requirementCard } from './requirementView.ts';
import { focusOf } from './types.ts';
import type { ViewData } from './types.ts';

interface Pending {
  change: string;
  path: string;
  spec: ParsedSpec;
}

function pendingFor(d: ViewData, root: string, name: string): Pending[] {
  const project = findProject(d.projects, root);
  if (!project) return [];
  return project.changes.flatMap((c) =>
    c.capabilities
      .filter((cap) => cap.name === name)
      .map((cap) => ({ change: c.name, path: cap.path, spec: parseSpec(d.texts[cap.path] ?? '') })),
  );
}

export function specsPage(d: ViewData): string {
  const project = findProject(d.projects, d.route.page === 'specs' ? d.route.root : undefined);
  if (!project) return `${pageHeader('Specs', '', '', false)}${emptyState('No Wingman Spec project found', '')}`;

  const names = d.baseSpecs[project.root] ?? [];
  const newOnly = new Set<string>();
  for (const c of project.changes) for (const cap of c.capabilities) if (!names.includes(cap.name)) newOnly.add(cap.name);

  const cards = [...names, ...newOnly].sort().map((name) => {
    const isNew = newOnly.has(name);
    const text = d.texts[baseSpecPath(project.root, name)];
    const spec = text === undefined ? undefined : parseSpec(text);
    const pending = pendingFor(d, project.root, name);
    const searchText = `${name} ${spec?.purpose ?? ''}`;
    return `<article class="card click" data-item data-text="${esc(plain(searchText))}" ${routeAttr({ page: 'spec', root: project.root, name })}>
<div class="spread"><h3>${esc(name)}</h3>${isNew ? badge('proposed', 'ok') : ''}</div>
<p class="snippet">${esc(spec?.purpose ?? 'New capability, not yet in the promoted specs.')}</p>
${pillRow(`${spec ? badge(`${spec.requirements.length} requirement${spec.requirements.length === 1 ? '' : 's'}`, 'info') : ''}${spec ? badge(`${countScenarios(spec)} scenarios`, 'muted') : ''}${pending.length > 0 ? badge(`${pending.length} pending`, 'warn', pending.map((p) => p.change).join(', ')) : ''}`)}</article>`;
  });

  const body =
    cards.length === 0
      ? emptyState('No capabilities yet', 'Living specs are <code>specs/&lt;capability&gt;.md</code> files in the specs root.')
      : `<div class="toolbar"><label class="search">${icon('search', 15)}<input data-filter-input placeholder="Filter capabilities" aria-label="Filter capabilities"></label></div>
<div class="grid">${cards.join('')}</div>`;
  return `${pageHeader('Specs', `${names.length} promoted capabilit${names.length === 1 ? 'y' : 'ies'}`, '', false)}${body}`;
}

export function specPage(d: ViewData): string {
  const route = d.route;
  if (route.page !== 'spec') return '';
  const project = findProject(d.projects, route.root);
  if (!project) return `${pageHeader('Spec', '')}${emptyState('No Wingman Spec project found', '')}`;

  const path = baseSpecPath(project.root, route.name);
  const text = d.texts[path];
  const base = text === undefined ? undefined : parseSpec(text);
  const pending = pendingFor(d, project.root, route.name);

  const focus = focusOf(route);
  const model = d.trace?.find((m) => m.root === project.root);
  const adrs = project.adrs;
  let focusUsed = false;
  const take = (name: string): boolean => {
    if (focusUsed || !focus || slug(name) !== focus.req) return false;
    focusUsed = true;
    return true;
  };
  const baseHtml = base
    ? `${base.purpose ? `<p class="md">${esc(base.purpose)}</p>` : ''}
${
  base.requirements
    .map((r) => {
      const insight = model ? insightOf(model, `${route.name}/${slug(r.name)}`, adrs) : undefined;
      return requirementCard(r, { path, root: project.root, ...(model ? { codeRoot: model.codeRoot } : {}), ...(insight ? { insight } : {}), focused: take(r.name), ...(focus?.scenario ? { focusScenario: focus.scenario } : {}) });
    })
    .join('') || '<p class="muted">No requirements found.</p>'
}`
    : emptyState('Not promoted yet', 'This capability only exists as a proposal in an active change.');

  const pendingHtml = pending
    .map((p) => {
      const cards = p.spec.requirements
        .map((r) => requirementCard(r, { path: p.path, base: base ? findRequirement(base, r.name) : undefined, focused: take(r.name), ...(focus?.scenario ? { focusScenario: focus.scenario } : {}) }))
        .join('');
      const renames = p.spec.renames.map((r) => `<li><code>${esc(r.from)}</code> renamed to <code>${esc(r.to)}</code></li>`).join('');
      return `<h2 class="section-title">${icon('layers')} Pending in <button class="link" ${routeAttr({ page: 'change', root: project.root, name: p.change, tab: 'specs' })}>${esc(p.change)}</button></h2>
${renames ? `<ul>${renames}</ul>` : ''}${cards}`;
    })
    .join('');

  const aside = text === undefined ? '' : `<button class="btn" ${openAttr(path)}>${icon('external', 14)} Open file</button>`;
  const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;
  const sub = base ? `${plural(base.requirements.length, 'requirement')}, ${plural(countScenarios(base), 'scenario')}` : 'new capability';
  return `${pageHeader(route.name, sub, aside)}${baseHtml}${pendingHtml}`;
}
