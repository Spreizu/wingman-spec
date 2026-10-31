import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { scanProject } from '../src/model/changeScanner.ts';
import { lintAdr } from '../src/model/lint.ts';
import { renderPage } from '../src/webview/render.ts';
import type { Route } from '../src/webview/types.ts';
import { makeData } from './fixture.ts';

// A `status: none` record (adrs/none.md) says the change has no architectural decision. It is not an ADR: no pill, no count,
// no card, no promotion. These tests build one project with the three cases and look at the model and the rendered pages.
const root = mkdtempSync(join(tmpdir(), 'wingman-none-'));
after(() => rmSync(root, { recursive: true, force: true }));
const put = (rel: string, text: string): void => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
};
const NONE = '---\ntitle: No architectural decision\nstatus: none\ndate: 2026-10-20\nchange: x\n---\n\nSearch reuses the existing index.\n';
const REAL = (t: string): string => `---\ntitle: ${t}\nstatus: Accepted\ndate: 2026-10-20\nchange: x\n---\n\n# ${t}\n\n## Context\n\nc\n\n## Decision\n\nd\n\n## Consequences\n\n- e\n`;
const TASKS = '## 1. Core\n\n- [x] 1.1 Done\n';

put('wingman-spec.yaml', '');
for (const n of ['only-none', 'mixed']) {
  put(`changes/${n}/tasks.md`, TASKS);
}
put('changes/only-none/adrs/none.md', NONE);
put('changes/mixed/adrs/none.md', NONE);
put('changes/mixed/adrs/use-a-table.md', REAL('Use a table'));
// archived: a none-only change and a none + real change
for (const n of ['2026-10-01-add-search', '2026-10-02-mixed-done']) {
  put(`archive/${n}/tasks.md`, TASKS);
}
put('archive/2026-10-01-add-search/adrs/none.md', NONE);
put('archive/2026-10-02-mixed-done/adrs/none.md', NONE);
put('archive/2026-10-02-mixed-done/adrs/use-a-table.md', REAL('Use a table'));
// a record that says `status: None` in a file with another name is the same thing
put('changes/mixed/adrs/skip-it.md', NONE.replace('status: none', 'status: None'));

const body = (html: string): string => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
async function page(route: Route): Promise<string> {
  return body(await renderPage(await makeData(root, route), 'NONCE', 'vscode-resource:'));
}
const adrTab = (html: string): string => html.match(/<button class="tab" data-tab="adrs">.*?<\/button>/)?.[0] ?? '';

test('a change with only none.md has no ADRs, but the record stays visible', async () => {
  const c = (await scanProject(root)).changes.find((x) => x.name === 'only-none');
  assert.ok(c);
  assert.equal(c.adrs.length, 0);
  assert.deepEqual(c.noDecisions.map((n) => n.slug), ['none']);
  assert.equal(c.noDecisions[0]?.reason, 'Search reuses the existing index.');
  assert.equal(c.artifacts.find((a) => a.id === 'adrs')?.state, 'done');
  assert.equal(c.adrsSynced, true);
});

test('the ADR tab of a none-only change has no count and one muted line', async () => {
  const html = await page({ page: 'change', root, name: 'only-none' });
  assert.ok(!/<span class="badge[^>]*>\d+<\/span>/.test(adrTab(html)), adrTab(html));
  assert.match(html, /<p class="muted no-decision">No architectural decision: Search reuses the existing index\./);
  assert.ok(!html.includes('No ADRs yet'));
  assert.ok(!html.includes('Promote'));
});

test('a change with none.md plus one real ADR shows 1 ADR and still the muted line', async () => {
  const c = (await scanProject(root)).changes.find((x) => x.name === 'mixed');
  assert.ok(c);
  assert.deepEqual(c.adrs.map((a) => a.slug), ['use-a-table']);
  assert.deepEqual(c.noDecisions.map((n) => n.slug), ['none', 'skip-it']);
  const html = await page({ page: 'change', root, name: 'mixed' });
  assert.match(adrTab(html), /<span class="badge tone-muted">1<\/span>/);
  assert.ok(html.includes('Use a table'));
  assert.equal((html.match(/class="muted no-decision"/g) ?? []).length, 2);
});

test('history: a none-only change has no ADR pill and says so; none + one real ADR shows 1 ADR', async () => {
  const list = await page({ page: 'history' });
  const card = (name: string): string => list.split('<div class="tl-item').find((c) => c.includes(name)) ?? '';
  assert.ok(card('add-search'));
  assert.ok(!/\d+ ADRs?/.test(card('add-search')), card('add-search'));
  assert.match(card('mixed-done'), /1 ADR\b/);
  assert.ok(!/2 ADRs/.test(card('mixed-done')));
  const detail = await page({ page: 'archived', root, name: '2026-10-01-add-search' });
  assert.match(detail, /No architectural decision: Search reuses the existing index/);
  assert.ok(!detail.includes('This change recorded no decisions'));
  assert.ok(!detail.includes('No ADRs'));
});

test('the archived model counts only real ADRs', async () => {
  const arch = (await scanProject(root)).archive;
  const one = arch.find((a) => a.name === 'add-search');
  const two = arch.find((a) => a.name === 'mixed-done');
  assert.deepEqual([one?.adrs.length, one?.noDecisions.length], [0, 1]);
  assert.deepEqual([two?.adrs.length, two?.noDecisions.length], [1, 1]);
});

test('the sidebar ADR total never includes a none record', async () => {
  const html = await page({ page: 'overview' });
  assert.match(html, /<span class="grow">ADRs<\/span>(<span class="count">0<\/span>)?/);
});

test('a none record needs no Context, Decision or Consequences', () => {
  assert.deepEqual(lintAdr(NONE, { kind: 'source' }).filter((i) => i.message.startsWith('Missing')), []);
  assert.deepEqual(lintAdr('---\ntitle: x\nstatus: Accepted\ndate: 2026-10-20\n---\n\nbody\n', { kind: 'source', none: true }).filter((i) => i.message.startsWith('Missing')), []);
});
