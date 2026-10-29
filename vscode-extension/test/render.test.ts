import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
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
  assert.ok(html.includes('data-agent="/spec-fix blocked"'));
});

test('change page has tasks with toggles, pipeline and the ADR diff section', async () => {
  const html = await page({ page: 'change', root, name: 'demo' });
  assert.ok(html.includes('data-toggle'));
  assert.ok(html.includes('class="pipeline"'));
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
  assert.ok(demo.includes('data-agent="/spec-fix demo"'));
  assert.ok(demo.includes('data-cmd="promoteAdr"'));
  assert.ok(demo.includes('data-agent="/spec-sync demo --check"'));
  const blocked = await page({ page: 'change', root, name: 'blocked' });
  assert.ok(blocked.includes('data-agent="/spec-explore blocked"'));
  const shipped = await page({ page: 'change', root, name: 'shipped' });
  assert.ok(shipped.includes('data-agent="/spec-archive shipped"'));
});

test('ADR page offers to supersede, overview offers a new change', async () => {
  assert.ok((await page({ page: 'adr', root, number: '0002' })).includes('data-cmd="supersedeAdr"'));
  assert.ok((await page({ page: 'overview' })).includes('data-cmd="newChange"'));
});

test('overview warns when the agent commands are not installed', async () => {
  const data = await makeData(root, { page: 'overview' });
  const html = renderPage({ ...data, setup: { commands: false, hook: false, missing: ['spec-apply'] } }, 'N', 'x');
  assert.ok(html.includes('Agent commands are not installed'));
});
