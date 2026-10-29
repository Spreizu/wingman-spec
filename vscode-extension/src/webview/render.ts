import { adrPage, adrsPage } from './adrPages.ts';
import { branchPage } from './branchPage.ts';
import { changePage } from './changePage.ts';
import { layout } from './layout.ts';
import { roadmapPage } from './roadmapPage.ts';
import { overviewPage } from './overviewPage.ts';
import { archivedPage, historyPage } from './historyPages.ts';
import { specPage, specsPage } from './specPages.ts';
import type { ViewData } from './types.ts';

/** A change that has started opens on its tasks; one still being planned opens on the proposal. */
function withDefaultTab(data: ViewData): ViewData {
  const route = data.route;
  if (route.page !== 'change' || route.tab) return data;
  const change = data.projects.find((p) => p.root === route.root)?.changes.find((c) => c.name === route.name);
  if (!change || change.state === 'planning') return data;
  return { ...data, route: { ...route, tab: 'tasks' } };
}

function content(d: ViewData): string {
  switch (d.route.page) {
    case 'overview':
      return overviewPage(d);
    case 'change':
      return changePage(d);
    case 'adrs':
      return adrsPage(d);
    case 'adr':
      return adrPage(d);
    case 'specs':
      return specsPage(d);
    case 'spec':
      return specPage(d);
    case 'branch':
      return branchPage(d);
    case 'roadmap':
      return roadmapPage(d);
    case 'history':
      return historyPage(d);
    case 'archived':
      return archivedPage(d);
  }
}

/** Renders the whole webview document for a route. Pure: all file contents come in through `data.texts`. */
export function renderPage(input: ViewData, nonce: string, cspSource: string): string {
  const data = withDefaultTab(input);
  return layout(data, content(data), nonce, cspSource);
}
