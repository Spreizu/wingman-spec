import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { buildDashboard, summarizeRun } from '../src/model/changeDashboard.ts';
import type { Change, Task } from '../src/model/types.ts';
import { dashboardCard } from '../src/webview/dashboardView.ts';
import { rich } from '../src/webview/components.ts';
import { renderPage } from '../src/webview/render.ts';
import type { Route } from '../src/webview/types.ts';
import { makeData } from './fixture.ts';

// An empty change (no tasks, no run) must read as calm: no literal backticks, no "0/0", no zero-only sub-lines, no coloured border
// on a card that has nothing to say. The same noise is checked on every other change-page state and on the list cards.
const visible = (html: string): string => html.replace(/<(style|script)[\s\S]*?<\/\1>/g, '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/g, ' ');
const ZERO_NOISE = /\b0\/0\b|\b0 (?:verified|lint errors?|implementation tasks?|passed|failed|anchor findings?|of 0)\b|(?:^|\s)0 tasks/;

const task = (id: string, title: string, checked: boolean): Task => ({ id, title, checked, line: 1, isReview: false, details: {} as Task['details'] });
const changeOf = (tasks: Task[], extra: Partial<Change> = {}): Change => ({
  name: 'add-search', dir: '/proj/openspec/changes/add-search', schema: 'wingman-spec', isWingmanSpec: true, skipSpecs: false, state: 'in-progress', artifacts: [], capabilities: [], adrs: [], noDecisions: [], adrsSynced: true,
  groups: tasks.length ? [{ number: '1', title: 'Core', tasks, isCloseOut: false }] : [], taskTotal: tasks.length, taskDone: tasks.filter((t) => t.checked).length, ...extra,
} as unknown as Change);
const card = (c: Change, inputs = {}, proposalText?: string): string =>
  dashboardCard(buildDashboard({ change: c, inputs, cmd: (a) => `node openspec/scripts/verify-task.cjs ${a}`, ...(proposalText ? { proposalText } : {}) }), false);

test('rich text: backtick spans become <code>, HTML is escaped, a stray backtick is dropped', () => {
  assert.equal(rich('it starts with `next` <now>'), 'it starts with <code>next</code> &lt;now&gt;');
  assert.ok(!rich('a ` b').includes('`'));
});

test('empty change: one muted "No tasks yet", no bar, no zero-only sub-lines, no coloured border', () => {
  const html = card(changeOf([]));
  const text = visible(html);
  assert.ok(!text.includes('`'), text);
  assert.match(text, /No tasks yet/);
  assert.ok(!ZERO_NOISE.test(text), text);
  assert.ok(!html.includes('class="bar'), 'no progress bar without tasks');
  assert.equal((html.match(/class="tile tone-muted empty"/g) ?? []).length, 4, 'all four cards are muted and empty');
  assert.ok(!/tone-(info|ok|bad|warn|accent)/.test(html.replace(/<h3[\s\S]*$/, '')), 'no accent tone on an empty card');
  assert.match(text, /not started/);
  assert.match(text, /not set/);
  assert.ok(!/no verify-task run/i.test(text), 'the Checks card already says "no run yet"');
});

test('tasks but no run: the note about the missing run renders `next` as code, not with backticks', () => {
  const html = card(changeOf([task('1.1', 'A', false)]));
  assert.match(html, /<code>next<\/code>/);
  assert.ok(!visible(html).includes('`'));
  assert.ok(!ZERO_NOISE.test(visible(html)), visible(html));
});

test('some tasks, all verified, blocked: a sub-line stays only when it says something', () => {
  const some = visible(card(changeOf([task('1.1', 'A', true), task('1.2', 'B', false)])));
  assert.match(some, /1\/2/);
  assert.ok(!ZERO_NOISE.test(some), some);
  const run = { runId: 'r', state: JSON.stringify({ task: null }), metrics: '{"event":"check","task":"1.1","ok":true,"attempt":1}\n', ledger: JSON.stringify({ passed: { '1.1 A': 1, '1.2 B': 1 } }) };
  const done = card(changeOf([task('1.1', 'A', true), task('1.2', 'B', true)]), { run: summarizeRun(run) });
  assert.match(visible(done), /2\/2/);
  assert.match(visible(done), /all verified/);
  assert.ok(!ZERO_NOISE.test(visible(done)), visible(done));
  assert.match(visible(done), /1 passed/);
  assert.ok(!/0 failed/.test(visible(done)));
  const withSize = visible(card(changeOf([task('1.1', 'A', false)]), {}, 'Size: S\nRisk: money\n'));
  assert.match(withSize, /1 implementation task/);
  assert.match(withSize, /risk: money/);
});

const root = mkdtempSync(join(tmpdir(), 'wingman-empty-'));
after(() => rmSync(root, { recursive: true, force: true }));
const put = (rel: string, text: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
put('openspec/config.yaml', 'schema: wingman-spec\n');
put('openspec/changes/brand-new/.openspec.yaml', 'schema: wingman-spec\n');
put('openspec/changes/brand-new/app-map.md', '# App map\n\nA todo list with a search box.\n');
put('openspec/changes/half-done/.openspec.yaml', 'schema: wingman-spec\n');
put('openspec/changes/half-done/tasks.md', '## 1. Core\n\n- [x] 1.1 Done\n- [ ] 1.2 Open\n');
put('openspec/changes/blocked-one/.openspec.yaml', 'schema: wingman-spec\n');
put('openspec/changes/blocked-one/tasks.md', '## 1. Core\n\n- [ ] 1.1 Open\n');
put('openspec/changes/blocked-one/BLOCKED.md', 'Blocked: task 1.1 needs a decision about `sort order`.\n');
put('openspec/changes/archive/2026-10-01-empty-archive/.openspec.yaml', 'schema: wingman-spec\n');
put('openspec/changes/archive/2026-10-01-empty-archive/proposal.md', '## Why\nx\n');

async function html(route: Route): Promise<string> {
  const d = await makeData(root, route);
  return renderPage(d, 'NONCE', 'vscode-resource:');
}

test('rendered pages for a brand-new change, a half-done, a blocked and an archived change show no literal backticks and no zero rings', async () => {
  for (const name of ['brand-new', 'half-done', 'blocked-one']) {
    const h = await html({ page: 'change', root, name });
    assert.ok(!visible(h).includes('`'), `${name}: ${visible(h).match(/.{20}`.{20}/)?.[0]}`);
    assert.ok(!ZERO_NOISE.test(visible(h)), `${name}: ${visible(h).match(ZERO_NOISE)?.[0]}`);
  }
  const fresh = await html({ page: 'change', root, name: 'brand-new' });
  assert.ok(!fresh.includes('class="ring'), 'no empty progress ring on a change without tasks');
  const half = await html({ page: 'change', root, name: 'half-done' });
  assert.ok(half.includes('class="ring'), 'a change with tasks has its ring');
  for (const route of [{ page: 'overview' }, { page: 'history', root }, { page: 'archived', root, name: '2026-10-01-empty-archive' }] as Route[]) {
    const h = await html(route);
    assert.ok(!visible(h).includes('`'), `${route.page}: ${visible(h).match(/.{20}`.{20}/)?.[0]}`);
    assert.ok(!ZERO_NOISE.test(visible(h)), `${route.page}: ${visible(h).match(ZERO_NOISE)?.[0]}`);
  }
});
