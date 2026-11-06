// The "Before archive" part of the change dashboard: quiet while tasks are open, a warning only when every task is ticked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import './support/installStub.mjs';
import type { BlockingItem, Dashboard } from '../src/model/changeDashboard.ts';

const { archiveFocus, dashboardCard } = await import('../src/webview/dashboardView.ts');

const drift: BlockingItem = { id: 'drift-gaps', title: '1 drift gap', detail: ['auth/login has no test'], todo: [{ kind: 'agent', text: '/spec-fix demo' }, { kind: 'terminal', text: '.wingman-spec/bin/wingman-spec drift demo' }] };
const sync: BlockingItem = { id: 'unsynced-specs', title: 'Specs not synced', detail: [], todo: [{ kind: 'agent', text: '/spec-sync demo' }] };
function dash(done: number, total: number, known: boolean, blocking: BlockingItem[], unavailable?: string): Dashboard {
  return {
    tasks: { total, done, verified: done, rows: [] },
    checks: { known, passed: done, failed: 0, exhausted: false, lintErrors: 0, guardFindings: 0, attempts: done },
    review: { reviewTasksDone: 0, reviewTasksTotal: 0, visual: 'none' },
    size: { planned: total, over: false },
    approvals: [],
    blocking,
    notes: unavailable ? [`Not checked: ${unavailable}. Sync, check and drift items below may be missing.`] : [],
    ...(unavailable ? { unavailable } : {}),
  };
}
const buttons = (html: string): number => (html.match(/data-(agent|term)=/g) ?? []).length;

test('open tasks: one collapsed muted line, no warning, no buttons', () => {
  const html = dashboardCard(dash(1, 3, true, [drift, sync]), false, ['/spec-apply demo', '/spec-fix demo']);
  assert.equal(archiveFocus(dash(1, 3, true, [])), false);
  assert.match(html, /<details class="pre-archive"><summary>Before archive: 2 items<\/summary>/);
  assert.doesNotMatch(html, /Blocking archive|tone-bad|tone-warn/);
  assert.equal(buttons(html.slice(html.indexOf('pre-archive'))), 0);
});

test('no tasks or no verifier run: no archive warning', () => {
  for (const d of [dash(0, 0, true, [sync]), dash(3, 3, false, [sync])]) {
    const html = dashboardCard(d, false);
    assert.doesNotMatch(html, /Blocking archive/);
    assert.match(html, /Before archive: 1 item</);
  }
  assert.doesNotMatch(dashboardCard(dash(1, 3, true, []), false), /archive/i);
});

test('every task ticked and something blocks: expanded warning; the header commands are not repeated', () => {
  const html = dashboardCard(dash(3, 3, true, [drift]), false, ['/spec-apply demo', '/spec-fix demo']);
  assert.match(html, /Blocking archive <span class="badge tone-warn/);
  assert.doesNotMatch(html, /pre-archive/);
  assert.match(html, /data-term="\.wingman-spec\/bin\/wingman-spec drift demo"/);
  assert.doesNotMatch(html, /data-agent="\/spec-fix demo"/);
});

test('every task ticked and nothing blocks: a calm line', () => {
  const html = dashboardCard(dash(3, 3, true, []), false);
  assert.match(html, /Nothing blocks the archive/);
  assert.doesNotMatch(html, /Blocking archive|Archive readiness was not fully checked/);
});

test('every task ticked but verifier unavailable: never claim nothing blocks', () => {
  const reason = 'the CLI did not answer within 120s (wingmanSpec.verifierTimeoutSeconds)';
  const html = dashboardCard(dash(3, 3, true, [], reason), false);
  assert.doesNotMatch(html, /Nothing blocks the archive/);
  assert.match(html, /Archive readiness was not fully checked/);
  assert.match(html, /did not answer within 120s/);
  assert.match(html, /Refresh/);
});

test('every task ticked, unavailable, and a known blocker: incomplete warning plus the blocker', () => {
  const html = dashboardCard(dash(3, 3, true, [drift], 'the workspace is not trusted'), false, ['/spec-apply demo', '/spec-fix demo']);
  assert.doesNotMatch(html, /Nothing blocks the archive/);
  assert.match(html, /Archive readiness was not fully checked/);
  assert.match(html, /incomplete/);
  assert.match(html, /1 drift gap/);
  assert.doesNotMatch(html, /data-agent="\/spec-fix demo"/);
});
