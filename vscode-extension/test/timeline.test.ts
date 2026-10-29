// The Timeline tab: events of timeline.jsonl in time order, grouped by task, one line each, details collapsed, a decision distinct
// but calm, an idle marker for long gaps, a calm empty state; the watcher refreshes the page when the file changes.
import assert from 'node:assert/strict';
import { matchesGlob } from 'node:path';
import { test } from 'node:test';
import './support/installStub.mjs';

const { parseTimeline, groupTimeline, duration, IDLE_GAP_SECONDS, timelinePath } = await import('../src/model/timeline.ts');
const { timelineTab } = await import('../src/webview/timelineView.ts');
const { STORE_PATTERN } = await import('../src/watcher.ts');

// Times carry the machine's own offset, so the clock shown is 10:mm:ss in any time zone.
const pad = (n: number) => String(n).padStart(2, '0');
const at = (m: number, s = 0) => {
  const o = -new Date(2026, 9, 29, 10, m, s).getTimezoneOffset();
  return `2026-10-29T10:${pad(m)}:${pad(s)}${o < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`;
};
const ev = (o: Record<string, unknown>) => JSON.stringify(o);
// written out of order on purpose (two parallel commands): the tab orders by time
const FILE = [
  ev({ at: at(0), event: 'run-start', summary: 'run started (next)' }),
  ev({ at: at(0, 1), event: 'next', task: '1.1', ok: true, summary: 'picked 1.1 Cart total', details: { files: ['src/cart.js'] } }),
  ev({ at: at(0, 30), event: 'check', task: '1.1', ok: false, seconds: 2.4, summary: 'failed: Done when exited 1', details: { failures: ['Done when `test -f ok` exited 1'], output_tail: 'line a\nline b' } }),
  ev({ at: at(0, 20), event: 'check-start', task: '1.1', summary: 'checking 1.1' }),
  ev({ at: at(0, 31), event: 'fix-round', task: '1.1', summary: 'fix round 2 of 3' }),
  ev({ at: at(1), event: 'check', task: '1.1', ok: true, seconds: 1.2, summary: 'all checks passed' }),
  ev({ at: at(1, 1), event: 'tick', task: '1.1', ok: true, summary: 'ticked 1.1' }),
  ev({ at: at(40), event: 'decision', ok: true, summary: 'plan changed: 2 changes (greet by name)', details: { changes: ['scenario added: demo/Demo/greet by name', 'task added: 1.3 Greet by name'], reason: 'greet by name' } }),
  ev({ at: at(40, 1), event: 'next', task: '1.2', ok: true, summary: 'picked 1.2 Greeting' }),
  '{"torn',
].join('\n');

test('events are read in time order with the gap since the previous one', () => {
  const es = parseTimeline(FILE);
  assert.deepEqual(es.map((e) => e.event), ['run-start', 'next', 'check-start', 'check', 'fix-round', 'check', 'tick', 'decision', 'next']);
  assert.equal(es[0]?.time, '10:00:00');
  assert.equal(es[3]?.gap, 10);
  assert.equal(es[3]?.result, 'failed');
  assert.equal(es[5]?.result, 'passed');
  assert.equal(es[7]?.idle, true, `a ${IDLE_GAP_SECONDS} s gap or more is idle`);
  assert.equal(es[8]?.idle, false);
});

test('consecutive events of one task form a group; the decision joins the task it follows', () => {
  const g = groupTimeline(parseTimeline(FILE));
  assert.deepEqual(g.map((x) => [x.task, x.entries.length]), [['', 1], ['1.1', 7], ['1.2', 1]]);
});

test('the tab: one line per event, details collapsed, decision distinct, idle marker, no literal backticks', () => {
  const html = timelineTab(FILE);
  assert.equal((html.match(/class="tl-entry/g) ?? []).length, 9);
  assert.doesNotMatch(html, /<details open/);
  assert.equal((html.match(/<details>/g) ?? []).length, 3, 'only events with details expand');
  assert.match(html, /class="tl-entry tl-decision"/);
  assert.match(html, /What changed<\/div><ul><li>scenario added: demo\/Demo\/greet by name<\/li>/);
  assert.match(html, /class="tl-idle"[^>]*>Idle for 38 min 59 s</);
  assert.match(html, /<code>test -f ok<\/code>/);
  assert.doesNotMatch(html.replace(/<pre>[\s\S]*?<\/pre>/g, ''), /`/);
  assert.match(html, /<h3 class="tl-task">Task 1\.1<\/h3>/);
  assert.match(html, /<span class="tl-dur">2\.4 s<\/span><span class="tl-gap"[^>]*>\+10 s<\/span>/);
  assert.doesNotMatch(html, /class="badge/, 'no pills');
});

test('no events: a calm empty state', () => {
  for (const t of [undefined, '', '\n{"bad'] as const) assert.match(timelineTab(t), /No activity yet/);
});

test('durations read naturally', () => {
  assert.deepEqual([0.42, 12, 185, 7440].map(duration), ['0.4 s', '12 s', '3 min 5 s', '2 h 4 min']);
});

test('live refresh: the watcher covers the timeline of every change', () => {
  const rel = timelinePath('/p', 'demo').slice('/p/'.length);
  assert.equal(rel, 'openspec/.apply-runs/demo/timeline.jsonl');
  assert.ok(matchesGlob(rel, STORE_PATTERN), STORE_PATTERN);
  assert.ok(!matchesGlob('openspec/.apply-runs/demo/run1/metrics.jsonl', STORE_PATTERN), 'other run files do not refresh the views');
});
