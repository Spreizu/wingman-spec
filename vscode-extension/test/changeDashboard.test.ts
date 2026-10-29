import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { buildDashboard, proposalSize, summarizeRun, taskRows } from '../src/model/changeDashboard.ts';
import type { RunFiles } from '../src/model/changeDashboard.ts';
import type { TraceChange } from '../src/model/traceability.ts';
import type { Change, Task } from '../src/model/types.ts';

const fx = (d: string, f: string): string => readFileSync(new URL(`./fixtures/${d}/${f}`, import.meta.url), 'utf8');
const files = (d: string): RunFiles => ({ runId: d, state: fx(d, 'state.json'), metrics: fx(d, 'metrics.jsonl'), ledger: fx(d, 'verified.json') });

const task = (id: string, title: string, checked: boolean, isReview = false): Task => ({ id, title, checked, line: 1, isReview, details: {} as Task['details'] });
const changeOf = (tasks: Task[], extra: Partial<Change> = {}): Change =>
  ({ name: 'add-discount-codes', dir: '/proj/openspec/changes/add-discount-codes', schema: 'wingman-spec', isWingmanSpec: true, skipSpecs: false, state: 'in-progress', artifacts: [], capabilities: [], adrs: [], adrsSynced: true, tasksPath: '/p/tasks.md', groups: [{ number: '1', title: 'Do', line: 0, isCloseOut: false, tasks }], taskTotal: tasks.length, taskDone: tasks.filter((t) => t.checked).length, ...extra }) as Change;
const cmd = (a: string): string => `node openspec/scripts/verify-task.cjs ${a}`;

test('run summary of a real finished run: three tasks verified, four checks passed, nothing pending', () => {
  const r = summarizeRun(files('run-complete'));
  assert.ok(r);
  assert.deepEqual([r.checksPassed, r.checksFailed, r.exhausted, r.reviewPending, r.task, r.attempts], [4, 0, false, false, undefined, 0]);
  assert.equal(r.verified.length, 3);
  assert.equal(r.recent.at(-1)?.event, 'finish');
});

test('run summary of a real run with two rejected attempts: failed checks, the last rejection and the open task', () => {
  const r = summarizeRun(files('run-failing'));
  assert.deepEqual([r?.checksPassed, r?.checksFailed, r?.task, r?.attempts], [0, 2, '1.1', 2]);
  assert.match(r?.lastFailure ?? '', /task 1\.1 is not ticked/);
  assert.deepEqual(r?.recent.map((e) => [e.attempt, e.ok]), [[1, false], [2, false]]);
  assert.match(r?.recent[1]?.failures[0] ?? '', /not ticked/);
});

test('run summary tolerates missing and broken files', () => {
  assert.equal(summarizeRun({}), undefined);
  assert.equal(summarizeRun({ state: '{', metrics: 'x\n{', ledger: '[' }), undefined);
  assert.equal(summarizeRun({ metrics: '{"event":"check","task":"1.1","ok":true,"attempt":1}\nnot json\n' })?.checksPassed, 1);
});

test('task rows: verified, ticked but unverified, in progress, review pending, open', () => {
  const tasks = [task('1.1', 'Apply a discount code and reject unknown or second codes', true), task('1.2', 'Show it', true), task('1.3', 'Third', false), task('1.4', 'Fourth', false), task('1.R', 'Request code review of the whole change', false, true)];
  const run = { ...summarizeRun(files('run-complete'))!, task: '1.3', reviewPending: false };
  assert.deepEqual(taskRows(changeOf(tasks), run).map((r) => r.status), ['verified', 'ticked-unverified', 'in-progress', 'open', 'open']);
  assert.equal(taskRows(changeOf(tasks), { ...run, reviewPending: true })[2]?.status, 'review-pending');
  assert.deepEqual(taskRows(changeOf(tasks), undefined).map((r) => r.status), ['verified', 'verified', 'open', 'open', 'open']);
});

test('size and risk come from the top of proposal.md; the cap counts implementation tasks only', () => {
  assert.deepEqual(proposalSize('Size: M\nRisk: money, security\n\n## Why\nSize: L\n'), { size: 'M', risk: 'money, security' });
  assert.deepEqual(proposalSize('# x'), {});
  const tasks = [1, 2, 3, 4].map((n) => task(`1.${n}`, `T${n}`, false)).concat(task('1.R', 'Review', false, true));
  const d = buildDashboard({ change: changeOf(tasks), proposalText: 'Size: S\n', inputs: {}, cmd });
  assert.deepEqual([d.size.size, d.size.cap, d.size.planned, d.size.over], ['S', 3, 4, true]);
  assert.equal(buildDashboard({ change: changeOf(tasks), proposalText: 'Size: M\n', inputs: {}, cmd }).size.over, false);
});

test('a finished, synced change has nothing blocking the archive', () => {
  const tasks = [task('1.1', 'Apply a discount code and reject unknown or second codes', true), task('1.2', 'Show the discount on the summary', true), task('1.R', 'Request code review of the whole change', true, true)];
  const d = buildDashboard({ change: changeOf(tasks), inputs: { run: summarizeRun(files('run-complete')), findings: [], sync: { ok: true, problems: [], warnings: [] } }, cmd });
  assert.deepEqual(d.blocking, []);
  assert.deepEqual([d.tasks.done, d.tasks.total, d.tasks.verified, d.checks.passed, d.checks.failed, d.review.reviewTasksDone, d.review.reviewTasksTotal], [3, 3, 3, 4, 0, 1, 1]);
  assert.deepEqual(d.notes, []);
});

test('everything that blocks the archive is listed, each with what to do', () => {
  const tasks = [task('1.1', 'Replace SAVE10 by SAVE15 with the 20 euro cap', false), task('1.R', 'Review', false, true)];
  const run = { ...summarizeRun(files('run-failing'))!, reviewPending: true };
  const traceChange = { name: 'add-discount-codes', approval: null, approvals: [{ key: 'a/b', status: 'changed', was: 'Users want a.', now: 'Users want b.', file: '', line: 0 }] } as unknown as TraceChange;
  const findings = [
    { source: 'lint', code: 'edge-cases', severity: 'error' as const, message: 'proposal has no edge cases', file: '/p', line: 1, col: 1, length: 1, change: 'add-discount-codes' },
    { source: 'lint', code: 'review', severity: 'warning' as const, message: 'w', file: '/p', line: 1, col: 1, length: 1, change: 'add-discount-codes' },
    { source: 'drift', code: 'untested-requirement', severity: 'error' as const, message: 'req X has no test', file: '/p', line: 1, col: 1, length: 1 },
  ];
  const d = buildDashboard({ change: changeOf(tasks), traceChange, inputs: { run, findings, sync: { ok: false, problems: ['specs: todo: requirement "X" is not in the living spec'], warnings: [] } }, cmd });
  assert.deepEqual(d.blocking.map((b) => b.id), ['open-tasks', 'failing-checks', 'owner-approval', 'unsynced-specs', 'drift-gaps', 'visual-review']);
  const by = (id: string) => d.blocking.find((b) => b.id === id)!;
  assert.deepEqual(by('open-tasks').todo, [{ kind: 'agent', text: '/spec-apply add-discount-codes' }, { kind: 'terminal', text: 'node openspec/scripts/verify-task.cjs next add-discount-codes' }]);
  assert.ok(by('failing-checks').detail.some((x) => /not ticked/.test(x)) && by('failing-checks').detail.some((x) => /edge-cases/.test(x)));
  assert.equal(by('owner-approval').todo[0]?.kind, 'open');
  assert.match(by('unsynced-specs').detail[0] ?? '', /not in the living spec/);
  assert.equal(by('drift-gaps').title, '1 drift gap open');
  assert.match(by('visual-review').detail[0] ?? '', /task 1\.1 passed its checks/);
  assert.deepEqual(d.approvals.map((i) => [i.key, i.status, i.approval]), [['a/b', 'changed', 'needed']]);
  assert.match(by('owner-approval').detail[0] ?? '', /a\/b gets a new Why/);
  assert.equal(buildDashboard({ change: changeOf(tasks), traceChange: { ...traceChange, approval: 'Ann, 2026-10-01' } as TraceChange, inputs: {}, cmd }).approvals[0]?.approval, 'given');
});

test('not synced yet: when it is the only blocker the action is /spec-archive (it syncs first); /spec-sync is never offered as a step before it', () => {
  const tasks = [task('1.1', 'A', true)];
  const sync = { ok: false, problems: ['specs: todo: requirement "X" is not in the living spec'], warnings: [] };
  const only = buildDashboard({ change: changeOf(tasks), inputs: { sync }, cmd });
  assert.deepEqual(only.blocking.map((b) => b.id), ['unsynced-specs']);
  assert.equal(only.blocking[0]!.todo[0]!.text, '/spec-archive add-discount-codes');
  assert.match(only.blocking[0]!.detail.join(' '), /syncs first/);
  const adrOnly = buildDashboard({ change: changeOf(tasks, { adrsSynced: false }), inputs: {}, cmd });
  assert.equal(adrOnly.blocking[0]!.todo[0]!.text, '/spec-archive add-discount-codes');
  const more = buildDashboard({ change: changeOf([task('1.1', 'A', false)]), inputs: { sync }, cmd });
  for (const b of [only, adrOnly, more].flatMap((d) => d.blocking)) assert.ok(!b.todo.some((t) => t.kind === 'agent' && t.text.startsWith('/spec-sync')), `${b.id} offers /spec-sync`);
});

test('without the verifier the page says what it could not check and falls back to the extension model', () => {
  const tasks = [task('1.1', 'A', true)];
  const d = buildDashboard({ change: changeOf(tasks, { adrsSynced: false }), gaps: [{ key: 'k', type: 'untested-requirement', subject: 'a/b', text: 'no test' }], inputs: { unavailable: 'the workspace is not trusted' }, cmd });
  assert.match(d.notes[0] ?? '', /Not checked: the workspace is not trusted/);
  assert.deepEqual(d.blocking.map((b) => b.id), ['unsynced-specs', 'drift-gaps']);
  assert.equal(d.checks.known, false);
});
