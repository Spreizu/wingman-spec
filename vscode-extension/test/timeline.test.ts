// The Timeline tab: events of timeline.jsonl in time order, grouped by task, one line each, details collapsed, a decision distinct
// but calm, an idle marker for long gaps, a calm empty state; the watcher refreshes the page when the file changes.
import assert from 'node:assert/strict';
import { matchesGlob } from 'node:path';
import { test } from 'node:test';
import './support/installStub.mjs';

const { parseTimeline, groupTimeline, timelineBlocks, duration, IDLE_GAP_SECONDS, timelinePath } = await import('../src/model/timeline.ts');
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
  assert.match(html, /<h4 class="tl-task">Task 1\.1<\/h4>/);
  assert.match(html, /<span class="tl-dur">2\.4 s<\/span><span class="tl-gap"[^>]*>\+10 s<\/span>/);
  assert.doesNotMatch(html, /class="badge/, 'no pills');
});

// A parallel wave: three tasks picked at once, checked as each subagent returns; the full tests then reopen 1.1.
const WAVE = [
  ev({ at: at(0), event: 'run-start', summary: 'run started (next)' }),
  ev({ at: at(0, 1), event: 'next', task: '1.1', ok: true, summary: 'picked 1.1 Cart', wave: 1, lane: 1 }),
  ev({ at: at(0, 1), event: 'next', task: '1.2', ok: true, summary: 'picked 1.2 User', wave: 1, lane: 2 }),
  ev({ at: at(0, 1), event: 'next', task: '1.3', ok: true, summary: 'picked 1.3 Mail', wave: 1, lane: 3 }),
  ev({ at: at(2), event: 'check', task: '1.2', ok: true, summary: 'all checks passed', wave: 1, lane: 2 }),
  ev({ at: at(3), event: 'check', task: '1.1', ok: true, summary: 'all checks passed', wave: 1, lane: 1 }),
  ev({ at: at(4), event: 'check', task: '1.3', ok: true, summary: 'all checks passed', wave: 1, lane: 3 }),
  ev({ at: at(5), event: 'next', task: '1.1', ok: true, summary: 'picked 1.1 Cart', wave: 1, lane: 1 }),
  ev({ at: at(9), event: 'next', task: '2.1', ok: true, summary: 'picked 2.1 Report' }),
].join('\n');

test('a parallel wave is one block with a lane per task, in lane order, beside each other', () => {
  const b = timelineBlocks(parseTimeline(WAVE));
  assert.deepEqual(b.map((x) => x.kind), ['group', 'wave', 'group']);
  const w = b[1];
  if (w?.kind !== 'wave') throw new Error('block 2 is not a wave');
  assert.equal(w.wave, 1);
  assert.deepEqual(w.lanes.map((l) => [l.task, l.entries.length]), [['1.1', 3], ['1.2', 2], ['1.3', 2]]);
  const html = timelineTab(WAVE);
  assert.match(html, /<h4 class="tl-task">Parallel wave 1: 3 tasks at once<\/h4><div class="tl-lanes">/);
  assert.equal((html.match(/class="tl-lane"/g) ?? []).length, 3);
  assert.match(html, /<h4 class="tl-task">Task 2\.1<\/h4>/);
});

test('no events: a calm empty state', () => {
  for (const t of [undefined, '', '\n{"bad'] as const) assert.match(timelineTab(t), /No activity yet/);
});

test('durations read naturally', () => {
  assert.deepEqual([0.42, 12, 185, 7440].map(duration), ['0.4 s', '12 s', '3 min 5 s', '2 h 4 min']);
});

test('live refresh: the watcher covers the timeline of every change', () => {
  const rel = timelinePath('/p', 'demo').slice('/p/'.length);
  assert.equal(rel, 'runs/demo/timeline.jsonl');
  assert.ok(matchesGlob(rel, STORE_PATTERN), STORE_PATTERN);
  assert.ok(!matchesGlob('runs/demo/run1/metrics.jsonl', STORE_PATTERN), 'other run files do not refresh the views');
});

// A timeline the Go CLI wrote (new, log start/grill, an artifact, validate, lint from the editor).
const { verifyChain, phaseSections } = await import('../src/model/timeline.ts');
const { readFileSync } = await import('node:fs');
const { createHash } = await import('node:crypto');
const verifyHead = (lines: string[]) => createHash('sha256').update(lines[lines.length - 1] ?? '').digest('hex');
const CHAINED = readFileSync(new URL('./fixtures/timeline/chained.jsonl', import.meta.url), 'utf8');

test('the hash chain the CLI writes verifies; an edit, a deletion or a move names the first bad entry', () => {
  assert.equal(verifyChain(CHAINED), undefined);
  assert.equal(verifyChain(CHAINED.replace(/\n/g, '\r\n')), undefined, 'CRLF (git autocrlf) keeps the chain');
  assert.equal(verifyChain(FILE), undefined, 'a timeline from before the chain is accepted');
  const ls = CHAINED.trimEnd().split('\n');
  const edited = verifyChain(CHAINED.replace('Who unblocks? -> sales', 'Who unblocks? -> nobody'));
  assert.deepEqual([edited?.line, edited?.event], [4, 'artifact']);
  assert.match(edited?.reason ?? '', /entry 3 was edited/);
  assert.equal(verifyChain([ls[0], ls[2], ls[3]].join('\n'))?.line, 2, 'deleted entry');
  assert.equal(verifyChain([ls[1], ls[2]].join('\n'))?.line, 1, 'deleted first entry');
  assert.equal(verifyChain([ls[0], ls[2], ls[1]].join('\n'))?.line, 2, 'moved entry');
  const html = timelineTab(CHAINED.replace('Block purchases', 'Allow purchases'));
  assert.match(html, /<p class="tl-chain" role="note">This timeline was changed after it was written: entry 3 \(grill at [^)]+\) does not follow entry 2/);
  assert.doesNotMatch(timelineTab(CHAINED), /tl-chain/);
});

test('archived.json anchors the head: a dropped last entry shows', () => {
  const ls = CHAINED.trimEnd().split('\n');
  const anchor = (n: number) => JSON.stringify({ archived_at: 'x', timeline_head: verifyHead(ls.slice(0, n)), timeline_entries: n });
  assert.equal(verifyChain(CHAINED, anchor(ls.length)), undefined);
  assert.match(verifyChain(ls.slice(0, -1).join('\n'), anchor(ls.length))?.reason ?? '', /does not match archived\.json/);
});


test('the tab groups by phase: Propose (start, questions, artifacts, validate, lint), then Build, then Verify', () => {
  const extra = [
    ev({ at: '2026-10-30T23:00:00+02:00', event: 'run-start', summary: 'run started (next)' }),
    ev({ at: '2026-10-30T23:00:01+02:00', event: 'validate', ok: true, summary: 'valid' }),
    ev({ at: '2026-10-30T23:10:00+02:00', event: 'finish', ok: true, summary: 'change verified' }),
  ];
  const ps = phaseSections(parseTimeline([CHAINED.trimEnd(), ...extra].join('\n')));
  assert.deepEqual(ps.map((p) => [p.label, p.blocks.flatMap((b) => (b.kind === 'group' ? b.group.entries.map((e) => e.event) : []))]), [
    ['Propose', ['new', 'start', 'grill', 'artifact', 'validate', 'lint']],
    ['Build', ['run-start', 'validate']],
    ['Verify', ['finish']],
  ]);
  const html = timelineTab(CHAINED);
  assert.match(html, /<h3 class="tl-phase-title">Propose<\/h3>/);
  assert.match(html, /Run from<\/div><ul><li>editor<\/li>/);
  assert.match(html, /<span class="tl-step">Question<\/span>/);
});
