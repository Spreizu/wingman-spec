import { basename } from 'node:path';
import type { ChangeState, ProjectModel } from '../model/types.ts';
import { esc, icon, routeAttr } from './components.ts';
import type { Tone } from './components.ts';
import { SCRIPT } from './script.ts';
import { STYLES } from './styles.ts';
import { routeKey } from './types.ts';
import type { Route, ViewData } from './types.ts';

export const STATE_TONE: Record<ChangeState, Tone> = {
  planning: 'muted',
  'in-progress': 'info',
  blocked: 'bad',
  complete: 'ok',
};

export const STATE_LABEL: Record<ChangeState, string> = {
  planning: 'Planning',
  'in-progress': 'In progress',
  blocked: 'Blocked',
  complete: 'Complete',
};

function navItem(route: Route, active: boolean, iconHtml: string, label: string, count?: string): string {
  return `<button class="nav-item${active ? ' active' : ''}" ${routeAttr(route)}>${iconHtml}<span class="grow">${esc(label)}</span>${count ? `<span class="count">${esc(count)}</span>` : ''}</button>`;
}

function nav(d: ViewData, specCount: number, logo: string | undefined): string {
  const archiveCount = d.projects.reduce((n, p) => n + p.archive.length, 0);
  const key = routeKey(d.route);
  const is = (r: Route): boolean => routeKey(r) === key;
  const multi = d.projects.length > 1;
  const adrTotal = d.projects.reduce((n, p) => n + p.adrs.length, 0);

  const sections = d.projects
    .map((p: ProjectModel) => {
      const items = p.changes
        .map((c) => {
          const route: Route = { page: 'change', root: p.root, name: c.name };
          const done = c.taskTotal > 0 ? `${c.taskDone}/${c.taskTotal}` : '';
          return navItem(
            route,
            d.route.page === 'change' && d.route.root === p.root && d.route.name === c.name,
            `<span class="dot tone-${STATE_TONE[c.state]}"></span>`,
            c.name,
            done,
          );
        })
        .join('');
      return `${multi ? `<div class="nav-label">${esc(basename(p.workspaceFolder))}</div>` : ''}${items}`;
    })
    .join('');

  return `<nav class="nav">
<div class="brand">${logo ? `<img class="brand-mark" src="${esc(logo)}" alt="">` : ''}Wingman Spec</div>
${navItem({ page: 'overview' }, is({ page: 'overview' }), icon('home'), 'Overview')}
${navItem({ page: 'adrs' }, d.route.page === 'adrs' || d.route.page === 'adr', icon('adr'), 'ADRs', String(adrTotal))}
${navItem({ page: 'specs' }, d.route.page === 'specs' || d.route.page === 'spec', icon('file'), 'Specs', String(specCount))}
${d.greenfield ? navItem({ page: 'roadmap' }, d.route.page === 'roadmap', icon('graph'), 'Roadmap') : ''}
${navItem({ page: 'branch' }, d.route.page === 'branch', icon('branch'), 'Branch review')}
${navItem({ page: 'history' }, d.route.page === 'history' || d.route.page === 'archived', icon('archive'), 'History', String(archiveCount))}
<div class="nav-label">${multi ? 'Changes' : 'Active changes'}</div>
${sections || '<div class="muted" style="padding:6px 8px">No active changes</div>'}
</nav>`;
}

/** `logo`: the webview URI of images/icon.png (the extension icon); without it the header shows the name only. */
export function layout(d: ViewData, content: string, nonce: string, cspSource: string, logo?: string): string {
  const specCount = d.projects.reduce((n, p) => n + (d.baseSpecs[p.root]?.length ?? 0), 0);
  const defaultTab = d.route.page === 'change' && d.route.tab ? d.route.tab : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource}; style-src 'nonce-${nonce}' ${cspSource}; style-src-attr 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Wingman Spec</title>
<style nonce="${nonce}">${STYLES}</style></head>
<body data-key="${esc(JSON.stringify(d.route))}" data-default-tab="${esc(defaultTab)}" data-reveal="${d.revealTick ?? 0}">
<div class="shell">${nav(d, specCount, logo)}<main class="main">${content}</main></div>
<script nonce="${nonce}">${SCRIPT}</script>
</body></html>`;
}
