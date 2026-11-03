// The run summary: one calm card above the timeline once the run has finished, derived from the timeline alone; each line
// scrolls to the entry it comes from; nothing while the run is still going or after a failed finish.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import './support/installStub.mjs';

const { parseTimeline } = await import('../src/model/timeline.ts');
const { runSummary } = await import('../src/model/runSummary.ts');
const { timelineTab } = await import('../src/webview/timelineView.ts');
const { SCRIPT } = await import('../src/webview/script.ts');

const pad = (n: number) => String(n).padStart(2, '0');
const at = (m: number, s = 0) => {
  const o = -new Date(2026, 9, 29, 10, m, s).getTimezoneOffset();
  return `2026-10-29T10:${pad(m)}:${pad(s)}${o < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(o) / 60))}:${pad(Math.abs(o) % 60)}`;
};
const ev = (o: Record<string, unknown>) => JSON.stringify(o);
const RUN = [
  ev({ at: at(0), event: 'run-start', summary: 'run started (next)' }),
  ev({ at: at(0, 1), event: 'next', task: '1.1', ok: true, summary: 'picked 1.1' }),
  ev({ at: at(0, 30), event: 'check', task: '1.1', ok: false, summary: 'failed: Done when exited 1' }),
  ev({ at: at(0, 31), event: 'fix-round', task: '1.1', summary: 'fix round 2 of 3' }),
  ev({ at: at(1), event: 'check', task: '1.1', ok: true, summary: 'all checks passed' }),
  ev({ at: at(1, 1), event: 'tick', task: '1.1', ok: true, summary: 'ticked 1.1' }),
  ev({ at: at(2), event: 'visual', task: '1.2', ok: true, summary: '3 visual scenario(s), 0 defect(s), 1 area image(s)' }),
  ev({ at: at(2, 5), event: 'visual', task: '1.3', ok: false, summary: 'visual check skipped: no browser' }),
  ev({ at: at(3), event: 'tick', task: '1.2', ok: true, summary: 'ticked 1.2' }),
  ev({ at: at(30), event: 'progress', task: '2.1', summary: 'Review fix empty-cart: guard the empty cart' }),
  ev({ at: at(31), event: 'progress', task: '2.1', summary: 'Review fix slow-totals: cache totals (untestable: timing only)' }),
  ev({ at: at(32), event: 'review-proof', task: '2.1', ok: true, summary: '1 review fix(es) with a fail-before/pass-after test, 1 untestable', details: { proven: ['empty-cart'], untestable: ['slow-totals'] } }),
  ev({ at: at(33), event: 'tick', task: '2.1', ok: true, summary: 'ticked 2.1' }),
  ev({ at: at(34), event: 'finish-start', summary: 'finish started' }),
  ev({
    at: at(35),
    event: 'finish',
    ok: true,
    seconds: 40,
    summary: 'change verified',
    details: {
      checks: [
        { name: 'validate', ok: true },
        { name: 'trace', ok: true, untested: ['demo/greet-by-name'] },
        { name: 'tests', ok: true },
        { name: 'typecheck', ok: true },
        { name: 'lint', ok: true },
        { name: 'visual', ok: true, skipped: 'visual: off' },
      ],
      diff: { files: 3, added: 42, removed: 7, list: [{ file: 'src/cart.js', added: 30, removed: 7 }, { file: 'src/user.js', added: 10, removed: 0 }, { file: 'test/cart.test.js', added: 2, removed: 0 }] },
    },
  }),
].join('\n');

test('the summary of a finished run: duration, tasks, checks, visual, review fixes, the diff and what is open', () => {
  const s = runSummary(parseTimeline(RUN), 3);
  assert.ok(s);
  assert.deepEqual(s.lines.map((l) => [l.text, l.target]), [
    ['Took 35 min, 27 min of it idle', 0],
    ['3 of 3 tasks completed', 12],
    ['At finish: tests, typecheck and lint passed; 2 of 2 spec checks passed', 14],
    ['Task checks: 1 passed, 1 failed (1 fix round)', 2],
    ['Visual: 3 scenarios checked, no defects', 6],
    ['2 review findings fixed, 1 shown by a fail-before/pass-after test', 11],
  ]);
  assert.deepEqual(s.open.map((l) => [l.text, l.target]), [
    ['Untested scenario: demo/greet-by-name', 14],
    ['visual not run at finish: visual: off', 14],
    ['Task 1.3: visual check skipped: no browser', 7],
    ['Review fix slow-totals has no test: timing only', 10],
  ]);
  assert.deepEqual(s.diff, { files: 3, added: 42, removed: 7, target: 14, list: [{ file: 'src/cart.js', added: 30, removed: 7 }, { file: 'src/user.js', added: 10, removed: 0 }, { file: 'test/cart.test.js', added: 2, removed: 0 }] });
});

test('no summary before finish, after a failed finish, or once a new run has started', () => {
  const lines = RUN.split('\n');
  assert.equal(runSummary(parseTimeline(lines.slice(0, -1).join('\n'))), undefined);
  assert.equal(runSummary(parseTimeline(RUN.replace('"ok":true,"seconds":40', '"ok":false,"seconds":40'))), undefined);
  assert.equal(runSummary(parseTimeline([...lines, ev({ at: at(50), event: 'next', task: '3.1', ok: true, summary: 'picked 3.1' })].join('\n'))), undefined);
});

test('a failed check after finish is open; an older finish without checks or diff still gives a short summary', () => {
  const later = [RUN, ev({ at: at(40), event: 'sync', ok: false, summary: 'specs drifted' })].join('\n');
  assert.deepEqual(runSummary(parseTimeline(later))?.open.at(-1), { text: 'Sync check failed: specs drifted', target: 15 });
  const old = [ev({ at: at(0), event: 'run-start', summary: 'run started' }), ev({ at: at(5), event: 'finish', ok: true, summary: 'change verified' })].join('\n');
  const s = runSummary(parseTimeline(old));
  assert.deepEqual(s?.lines.map((l) => l.text), ['Took 5 min', 'Finish passed']);
  assert.equal(s?.diff, undefined);
  assert.deepEqual(s?.open, []);
});

test('the card: on top, calm (no pills), each line jumps to its entry, the files collapsed', () => {
  const html = timelineTab(RUN, undefined, 3);
  const card = html.indexOf('class="card tl-run"');
  assert.ok(card >= 0 && card < html.indexOf('class="timeline"'), 'the card sits above the timeline');
  assert.match(html, /<button class="link tl-jump" data-jump="tl-14"[^>]*>3 files changed, \+42 −7<\/button><details class="tl-files" data-keep><summary>Files<\/summary>/);
  assert.match(html, /data-jump="tl-7"[^>]*>Task 1\.3: visual check skipped: no browser</);
  for (const m of html.matchAll(/data-jump="(tl-\d+)"/g)) assert.match(html, new RegExp(`<li class="tl-entry[^"]*" id="${m[1]}"`), `${m[1]} is an entry`);
  const cardHtml = html.slice(card, html.indexOf('class="timeline"'));
  assert.doesNotMatch(cardHtml, /badge|pill|tl-result/);
  assert.doesNotMatch(timelineTab(RUN.split('\n').slice(0, -1).join('\n')), /tl-run/);
  assert.match(timelineTab([ev({ at: at(0), event: 'run-start' }), ev({ at: at(1), event: 'finish', ok: true })].join('\n')), /Open items<\/h4><p class="muted">None\.<\/p>/);
  assert.match(SCRIPT, /closest\('\[data-jump\]'\)[\s\S]*scrollIntoView/, 'the webview scrolls to the entry');
});
