import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { renderPage } from '../src/webview/render.ts';
import type { Route } from '../src/webview/types.ts';
import { makeData, makeFixture } from './fixture.ts';

const root = makeFixture();
after(() => rmSync(root, { recursive: true, force: true }));

const markup = (html: string): string => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');

async function page(route: Route): Promise<string> {
  return renderPage(await makeData(root, route), 'NONCE', 'vscode-resource:');
}

const ROUTES = (r: string): Route[] => [
  { page: 'overview' },
  { page: 'change', root: r, name: 'demo' },
  { page: 'change', root: r, name: 'blocked' },
  { page: 'change', root: r, name: 'missing' },
  { page: 'adrs' },
  { page: 'adr', root: r, number: '0002' },
  { page: 'specs' },
  { page: 'spec', root: r, name: 'auth' },
  { page: 'history' },
  { page: 'archived', root: r, name: '2026-09-30-first-cut' },
  { page: 'archived', root: r, name: 'nope' },
];

test('every route renders with a strict CSP and no raw injected HTML', async () => {
  for (const route of ROUTES(root)) {
    const html = await page(route);
    assert.ok(html.includes("default-src 'none'"), route.page);
    assert.ok(!html.includes('<script>x'), `${route.page}: raw script tag`);
    assert.ok(!html.includes('<img src=x'), `${route.page}: raw img tag`);
    assert.ok(!html.includes('<b>reasons'), `${route.page}: raw b tag`);
    assert.equal((html.match(/<script/g) ?? []).length, 1, `${route.page}: only the nonce script`);
  }
});

test('overview shows the stats (ADRs before shipped), the proposal excerpt, and keeps New change', async () => {
  const html = await page({ page: 'overview' });
  assert.ok(html.includes('<h1>Overview</h1>'));
  assert.ok(html.includes('data-cmd="newChange"'));
  assert.ok(html.indexOf('ADRs (') !== -1 && html.indexOf('ADRs (') < html.indexOf('Shipped this month'));
  assert.ok(html.includes('Because users cannot sign in yet.'));
  assert.ok(!html.includes('Time</h2>') && !html.includes('session'));
});

test('overview shows the delivery board and the blocked change needing a decision', async () => {
  const html = await page({ page: 'overview' });
  assert.ok(html.includes('demo'));
  assert.ok(html.includes('Needs a product decision'));
  assert.ok(html.includes('data-agent="/spec-explore blocked"') && !html.includes('/spec-fix blocked'), 'the same action as the change page; no Fix findings without findings');
});

test('change page has tasks with toggles, the artifact line and the ADR diff section', async () => {
  const html = await page({ page: 'change', root, name: 'demo' });
  assert.ok(html.includes('data-toggle'));
  assert.ok(html.includes('class="artifacts"'));
  assert.ok(html.includes('Not promoted'));
  assert.ok(html.includes('data-tab="specs"'));
});

test('spec page diffs a modified requirement against the promoted spec', async () => {
  const html = await page({ page: 'spec', root, name: 'auth' });
  assert.ok(html.includes('Pending in'));
  assert.ok(html.includes('class="diff"'));
  assert.ok(html.includes('class="del"'));
});

test('adr page shows the supersedes lineage and decision card', async () => {
  const html = await page({ page: 'adr', root, number: '0002' });
  assert.ok(html.includes('class="lineage"'));
  assert.ok(html.includes('sect decision'));
});

test('blocked banner renders BLOCKED.md', async () => {
  const html = await page({ page: 'change', root, name: 'blocked' });
  assert.ok(html.includes('Waiting on &lt;i&gt;infra'));
});

test('CSP allows inline style attributes only (progress bars) and no inline scripts', async () => {
  const html = await page({ page: 'overview' });
  assert.ok(html.includes("style-src-attr 'unsafe-inline'"));
  assert.ok(html.includes("script-src 'nonce-NONCE'"));
  assert.ok(!/<[a-z][^>]*\son[a-z]+=/i.test(markup(html)));
});

test('ADR hub has a timeline and a graph tab with nodes, edges and unlinked ADRs', async () => {
  const html = await page({ page: 'adrs' });
  assert.ok(html.includes('data-tab="graph"'));
  assert.ok(html.includes('class="gnode'));
  assert.ok(html.includes('class="gedge"'));
  assert.ok(html.includes('Not linked'));
  assert.ok(html.includes('data-cmd="newAdr"'));
});

test('history lists archived changes by month and the archived page is read only', async () => {
  const list = await page({ page: 'history' });
  assert.ok(list.includes('September 2026'));
  assert.ok(list.includes('first-cut'));
  const detail = await page({ page: 'archived', root, name: '2026-09-30-first-cut' });
  assert.ok(detail.includes('data-tab="tasks"'));
  assert.ok(!markup(detail).includes('data-toggle'));
  assert.ok(detail.includes('Ship it.'));
});

test('change page offers agent and promote actions that match the change state', async () => {
  const demo = await page({ page: 'change', root, name: 'demo' });
  assert.ok(demo.includes('data-agent="/spec-apply demo"'));
  assert.ok(!demo.includes('data-agent="/spec-fix demo"'), 'no findings, no Fix findings');
  assert.ok(demo.includes('data-cmd="promoteAdr"'));
  assert.ok(!demo.includes('data-agent="/spec-sync'), 'the sync prompt buttons are gone: Sync runs the CLI');
  const blocked = await page({ page: 'change', root, name: 'blocked' });
  assert.ok(blocked.includes('data-agent="/spec-explore blocked"'));
  const shipped = await page({ page: 'change', root, name: 'shipped' });
  assert.ok(!shipped.includes('data-agent="/spec-archive'), 'a complete change has no agent archive: Archive runs the CLI');
});

test('ADR page offers to supersede, overview offers a new change', async () => {
  assert.ok((await page({ page: 'adr', root, number: '0002' })).includes('data-cmd="supersedeAdr"'));
  assert.ok((await page({ page: 'overview' })).includes('data-cmd="newChange"'));
});

test('overview warns when the agent commands are not installed', async () => {
  const data = await makeData(root, { page: 'overview' });
  const html = renderPage({ ...data, setup: { commands: false, missing: ['spec-apply'] } }, 'N', 'x');
  assert.ok(html.includes('Agent commands are not installed'));
});

const finding = (change: string) => ({ source: 'lint' as const, code: 'x', severity: 'error' as const, message: 'm', file: join(root, 'x'), line: 1, col: 1, length: 1, change });

test('Fix findings shows only when the change has findings; a complete change with none has no agent button', async () => {
  const data = await makeData(root, { page: 'change', root, name: 'demo' });
  assert.ok(renderPage({ ...data, dashboard: { findings: [finding('demo')] } }, 'N', 'x').includes('data-agent="/spec-fix demo"'));
  assert.ok(!renderPage({ ...data, dashboard: { findings: [finding('other')] } }, 'N', 'x').includes('/spec-fix demo'));
  const shipped = markup(await page({ page: 'change', root, name: 'shipped' }));
  assert.ok(!shipped.includes('data-agent='), 'Complete at 100% with nothing blocking: no Fix findings');
});

test('the artifact line: one quiet line in the header, done with a check, missing and skipped muted, no stepper', async () => {
  const html = markup(await page({ page: 'change', root, name: 'demo' }));
  const line = /<ul class="artifacts" aria-label="Artifacts">([\s\S]*?)<\/ul>/.exec(html)?.[1] ?? '';
  assert.match(line, /<li class="missing" title="app-map: not created yet">app-map<\/li>/);
  assert.match(line, /<li class="done" title="proposal: done"><svg class="ico"[^>]*>[\s\S]*?<\/svg>proposal<\/li>/);
  assert.ok(html.indexOf('class="artifacts"') < html.indexOf('</header>'), 'inside the page header, no card of its own');
  assert.ok(!html.includes('class="pipeline"') && !html.includes('class="step '));
});

test('change header: no schema text, one primary button per page', async () => {
  for (const name of ['demo', 'blocked', 'shipped']) {
    const html = markup(await page({ page: 'change', root, name }));
    assert.ok(!/<span>wingman-spec<\/span>/.test(html), name);
    assert.ok((html.match(/class="btn[^"]*\bprimary\b/g) ?? []).length <= 1, name);
  }
  assert.equal((markup(await page({ page: 'change', root, name: 'demo' })).match(/class="btn agent primary"/g) ?? []).length, 1);
  assert.equal((markup(await page({ page: 'overview' })).match(/class="btn[^"]*\bprimary\b/g) ?? []).length, 1);
});

test('the default tab is active before the script runs; an empty tab shows a calm empty state, a present file its content', async () => {
  const shipped = markup(await page({ page: 'change', root, name: 'shipped', tab: 'proposal' }));
  assert.match(shipped, /<button class="tab active" data-tab="proposal">/);
  assert.match(shipped, /<div class="pane active" data-pane="proposal"><div class="empty">[\s\S]*?<h3>No proposal<\/h3><\/div>/, 'complete: a neutral line, no /spec-propose hint');
  const draft = markup(await page({ page: 'change', root, name: 'blocked', tab: 'proposal' }));
  assert.ok(draft.includes('No proposal yet') || draft.includes('data-pane="proposal"><div class="md">'));
  const demo = markup(await page({ page: 'change', root, name: 'demo', tab: 'proposal' }));
  assert.match(demo, /<div class="pane active" data-pane="proposal">(?!<div class="empty">)/);
  assert.ok(demo.includes('Because users cannot sign in yet.'));
  assert.equal((markup(await page({ page: 'change', root, name: 'demo' })).match(/class="pane active"/g) ?? []).length, 1);
});

test('the header shows the extension icon when the panel passes it, and the CSP allows only webview images', async () => {
  const data = await makeData(root, { page: 'overview' });
  const html = renderPage(data, 'N', 'vscode-resource:', 'vscode-resource:/ext/images/icon.png');
  assert.ok(html.includes('<img class="brand-mark" src="vscode-resource:/ext/images/icon.png" alt="">'));
  assert.ok(html.includes("img-src vscode-resource:;"));
  assert.ok(!renderPage(data, 'N', 'x').includes('<img'));
});

test('button audit: each view shows its actions only when they apply, with at most one primary', async () => {
  const primaries = (html: string): number => (markup(html).match(/class="btn[^"]*\bprimary\b/g) ?? []).length;
  const data = await makeData(root, { page: 'change', root, name: 'shipped' });
  const ready = renderPage({ ...data, dashboard: { sync: { ok: true, problems: [], warnings: [] } } }, 'N', 'x');
  assert.match(markup(ready), /class="btn cli primary" data-cli="archive"/, 'ready to archive: Archive is the next step');
  assert.ok(!ready.includes('data-cli="sync"'), 'synced: no Sync');
  assert.equal(primaries(ready), 1);
  const unsynced = renderPage({ ...data, dashboard: { sync: { ok: false, problems: ['x'], warnings: [] } } }, 'N', 'x');
  assert.match(markup(unsynced), /class="btn cli primary" data-cli="sync"/);
  assert.match(markup(unsynced), /class="btn cli" disabled title="Sync first/);
  assert.equal(primaries(unsynced), 1);
  const demo = markup(await page({ page: 'change', root, name: 'demo' }));
  assert.ok(!demo.includes('data-cli="sync"') && !demo.includes('data-cli="archive"'), 'open tasks: no Sync or Archive yet');
  assert.ok(!markup(await page({ page: 'adr', root, number: '0001' })).includes('supersedeAdr'), 'already superseded: no Supersede');
  assert.ok(markup(await page({ page: 'adr', root, number: '0002' })).includes('supersedeAdr'));
  for (const r of ROUTES(root)) assert.ok(primaries(await page(r)) <= 1, JSON.stringify(r));
  const archived = markup(await page({ page: 'archived', root, name: '2026-09-30-first-cut' }));
  assert.ok(!archived.includes('data-agent=') && !archived.includes('data-cli=') && primaries(archived) === 0, 'archived: read-only');
});
