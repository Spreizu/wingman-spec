// The CLI action buttons: when each may run, how its JSON answer reads, how the answer shows, and how the panel runs it.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import './support/installStub.mjs';
import { makeData, makeFixture } from './fixture.ts';

const stub = await import('./support/vscodeStub.mjs');
const { host } = stub;
const { changeActions, projectActions, readAction, problemLine, actionArgs } = await import('../src/model/cliActions.ts');
const { buildDashboard } = await import('../src/model/changeDashboard.ts');
const { renderPage } = await import('../src/webview/render.ts');
const { SpecPanel } = await import('../src/webview/panel.ts');
const { actionKey } = await import('../src/webview/types.ts');
type Change = import('../src/model/types.ts').Change;
type ActionResult = import('../src/model/cliActions.ts').ActionResult;

const root = makeFixture();
after(() => rmSync(root, { recursive: true, force: true }));

const change = (done: number, total: number, extra: Partial<Change> = {}): Change =>
  ({ name: 'c', dir: '/p/changes/c', isWingmanSpec: true, state: done === total && total > 0 ? 'complete' : 'in-progress', artifacts: [{ id: 'proposal', label: 'Proposal', path: '/p/changes/c/proposal.md', state: 'done' }], capabilities: [], adrs: [], adrsSynced: true, groups: [], taskTotal: total, taskDone: done, ...extra }) as unknown as Change;
const by = (bs: { action: string; enabled: boolean; reason?: string; primary?: boolean }[], a: string) => bs.find((b) => b.action === a)!;
const SYNC_CONFLICT = {
  change: 'mod-y',
  capabilities: [],
  adrs: [],
  problems: ['.wingman-spec/changes/mod-y/specs/x.md:12: not merged: requirement "Alpha" differs from the living spec', '.wingman-spec/changes/mod-y/specs/x.md:3: not merged: requirement "Beta" is missing from the living spec'],
};

test('visibility: open or no tasks hide sync and archive; validate needs a proposal; status always shows; none is primary', () => {
  const bs = changeActions({ change: change(1, 3), inputs: { sync: { ok: false, problems: [], warnings: [] } }, trusted: true });
  assert.deepEqual(bs.map((b) => [b.action, b.enabled]), [['validate', true], ['status', true]]);
  assert.deepEqual(changeActions({ change: change(0, 0, { artifacts: [] }), trusted: true }).map((b) => b.action), ['status']);
  assert.deepEqual(changeActions({ change: change(0, 0), trusted: true }).map((b) => b.action), ['validate', 'status']);
  assert.ok(bs.every((b) => !b.primary));
});

test('preconditions: all tasks ticked, not synced: Sync runs and Archive asks for the sync first', () => {
  const c = change(2, 2);
  const inputs = { sync: { ok: false, problems: ['x'], warnings: [] } };
  const bs = changeActions({ change: c, inputs, dashboard: buildDashboard({ change: c, inputs, cmd: (a) => a }), trusted: true });
  assert.equal(by(bs, 'sync').enabled, true);
  assert.equal(by(bs, 'sync').primary, true, 'complete, not synced: Sync is the next step');
  assert.equal(by(bs, 'archive').reason, 'Sync first: the specs or ADRs are not merged.');
  const blockedFile = changeActions({ change: { ...c, state: 'blocked' }, inputs, trusted: true });
  assert.ok(blockedFile.every((b) => !b.primary), 'a blocked change: the header explores the blocker');
});

test('preconditions: synced and nothing else blocks: Archive runs as the primary, Sync is hidden; another blocker keeps Archive off with its reason', () => {
  const c = change(2, 2);
  const inputs = { sync: { ok: true, problems: [], warnings: [] } };
  const bs = changeActions({ change: c, inputs, dashboard: { blocking: [] } as never, trusted: true });
  assert.equal(by(bs, 'archive').enabled, true);
  assert.equal(by(bs, 'archive').primary, true);
  assert.ok(!bs.some((b) => b.action === 'sync'), 'already synced: no Sync button');
  const blocked = changeActions({ change: c, inputs, dashboard: { blocking: [{ id: 'drift-gaps' }] } as never, trusted: true });
  assert.equal(by(blocked, 'archive').reason, '1 item blocks the archive (listed below).');
  assert.ok(blocked.every((b) => !b.primary), 'done but blocked: no primary, the blockers are listed');
  assert.equal(by(changeActions({ change: c, trusted: true }), 'archive').reason, 'Checking the sync state...');
  assert.match(by(changeActions({ change: c, inputs: { unavailable: 'the CLI is missing' }, trusted: true }), 'sync').reason ?? '', /Sync state unknown: the CLI is missing/);
});

test('an untrusted workspace or a running action disables every button with the reason', () => {
  for (const bs of [changeActions({ change: change(2, 2), trusted: false }), projectActions({ trusted: false })]) for (const b of bs) assert.match(b.reason ?? '', /not trusted/);
  for (const b of changeActions({ change: change(2, 2), trusted: true, running: true })) assert.equal(b.reason, 'Another action is running.');
  assert.deepEqual(actionArgs('doctor', 'c'), ['doctor', '--json']);
  assert.deepEqual(actionArgs('sync', 'c'), ['sync', 'c', '--json']);
});

test('answers: a sync conflict is a result listed per requirement with file and line; a clean sync is one quiet line', () => {
  const r = readAction('sync', 'mod-y', { code: 1, stdout: JSON.stringify(SYNC_CONFLICT), stderr: 'not synced: 2 problem(s), nothing was written' }, '/code');
  assert.equal(r.ok, false);
  assert.equal(r.summary, 'Not synced: 2 conflicts, nothing was written.');
  assert.deepEqual(r.lines.map((l) => [l.requirement, l.file, l.line]), [['Alpha', '/code/.wingman-spec/changes/mod-y/specs/x.md', 12], ['Beta', '/code/.wingman-spec/changes/mod-y/specs/x.md', 3]]);
  const ok = readAction('sync', 'c', { code: 0, stdout: '{"change":"c","capabilities":["auth"],"adrs":[],"problems":[]}', stderr: '' }, '/code');
  assert.deepEqual([ok.ok, ok.summary, ok.lines], [true, 'Synced: 1 capability merged.', []]);
  assert.deepEqual(problemLine('specs: a/b.md:4: not merged: requirement "Q" differs', '/r'), { text: 'not merged: requirement "Q" differs', level: 'error', requirement: 'Q', file: '/r/a/b.md', line: 4 });
});

test('answers: archive, refusal, validate, status, doctor, and an answer that is not JSON', () => {
  const archived = readAction('archive', 'c', { code: 0, stdout: '{"result":"archived","dir":"/r/archive/2026-10-30-1200-c","warnings":[]}', stderr: '' }, '/r');
  assert.equal(archived.summary, 'Archived to 2026-10-30-1200-c. The move is left uncommitted for you to review.');
  const refused = readAction('archive', 'mod-y', { code: 1, stdout: JSON.stringify({ result: 'refused', synced: false, problems: SYNC_CONFLICT.problems.map((p) => `specs: ${p}`) }), stderr: 'REFUSED' }, '/r');
  assert.deepEqual([refused.ok, refused.summary, refused.lines.length], [false, 'Not archived: 2 sync conflicts.', 2]);
  const invalid = readAction('validate', 'c', { code: 1, stdout: '{"items":[{"target":"c","valid":false,"issues":[{"level":"error","file":"changes/c/specs/a.md","line":7,"message":"requirement \\"Login\\" has no scenario"}]}],"valid":false}', stderr: '' }, '/r');
  assert.deepEqual([invalid.summary, invalid.lines[0]?.file, invalid.lines[0]?.line, invalid.lines[0]?.requirement], ['Not valid: 1 error.', '/r/changes/c/specs/a.md', 7, 'Login']);
  assert.equal(readAction('validate', 'c', { code: 0, stdout: '{"items":[],"valid":true}', stderr: '' }, '/r').summary, 'Valid.');
  const status = readAction('status', 'c', { code: 0, stdout: '{"changeName":"c","artifacts":[{"id":"design","status":"blocked","missingDeps":["specs"]},{"id":"proposal","status":"done"}],"apply":{"progress":{"total":3,"complete":1},"next":"1.2 Second","run_status":"no open run"}}', stderr: '' }, '/r');
  assert.deepEqual([status.summary, status.lines.map((l) => l.text)], ['Tasks 1/3 done; next: 1.2 Second; run: no open run.', ['design: blocked (needs specs)']]);
  const doctor = readAction('doctor', undefined, { code: 1, stdout: '{"ok":false,"problems":["no test command"],"warnings":["visual: no browser"]}', stderr: '' }, '/r');
  assert.deepEqual([doctor.ok, doctor.summary, doctor.lines.map((l) => l.level)], [false, 'Setup incomplete: 1 problem.', ['error', 'warning']]);
  assert.equal(readAction('status', 'c', { code: 2, stdout: '', stderr: 'unknown change c\nmore' }, '/r').summary, 'Status failed: unknown change c');
});

test('change page: CLI buttons look distinct from agent hand-offs, disabled ones say why, conflicts link to their file and hand off to the agent', async () => {
  const data = await makeData(root, { page: 'change', root, name: 'demo' });
  const r: ActionResult = readAction('sync', 'demo', { code: 1, stdout: JSON.stringify(SYNC_CONFLICT), stderr: '' }, root);
  const html = renderPage({ ...data, dashboard: { sync: { ok: false, problems: [], warnings: [] } }, actions: { trusted: true, results: { [actionKey(root, 'demo')]: r } } }, 'N', 'x');
  assert.match(html, /<button class="btn cli" data-cli="validate" data-root="[^"]+" data-change="demo"/);
  assert.ok(!html.includes('data-cli="sync"') && !html.includes('2 tasks are still open'), 'open tasks: no Sync or Archive, no reasons');
  assert.match(html, /class="btn agent primary" data-agent="\/spec-apply demo"/);
  assert.ok(html.includes('Requirement: Alpha') && html.includes('Requirement: Beta'));
  assert.match(html, /x\.md:12<\/button>/);
  assert.match(html, /data-agent="\/spec-sync demo"[^>]*>.*Resolve with agent/);
  const quiet = renderPage({ ...data, actions: { trusted: true, results: { [actionKey(root, 'demo')]: { action: 'validate', change: 'demo', ok: true, summary: 'Valid.', lines: [] } } } }, 'N', 'x');
  assert.match(quiet, /<div class="result tone-ok" role="status"><span class="muted">Valid\.<\/span><\/div>/);
  assert.ok(!quiet.includes('Resolve with agent'));
});

test('overview: Doctor per project; no agent sync or archive prompt buttons remain', async () => {
  const data = await makeData(root, { page: 'overview' });
  const html = renderPage(data, 'N', 'x');
  assert.match(html, /data-cli="doctor" data-root="[^"]+"/);
  assert.ok(!/data-agent="\/spec-(sync|archive)/.test(html));
  const untrusted = renderPage({ ...data, actions: { trusted: false, results: {} } }, 'N', 'x');
  assert.ok(!untrusted.includes('data-cli=') && untrusted.includes('Doctor: The workspace is not trusted'));
});

test('panel: runs a known action of a known change once, asks before archiving, ignores anything else', async () => {
  host.reset();
  const data = await makeData(root, { page: 'overview' });
  const calls: string[] = [];
  const store = { projects: data.projects, baseSpecNames: new Map(), onDidChange: () => new stub.Disposable(), refresh: async () => void calls.push('refresh') };
  const extras = {
    branch: () => ({ status: 'loading' as const }),
    roadmap: () => ({ status: 'loading' as const }),
    dashboard: () => undefined,
    runAction: async (r: string, action: string, c?: string): Promise<ActionResult> => {
      calls.push(`${action} ${c ?? ''}`.trim());
      return { action: action as never, ...(c ? { change: c } : {}), ok: true, summary: `${action} done.`, lines: [] };
    },
  };
  const panel = new SpecPanel(store as never, () => [], extras);
  panel.show({ page: 'change', root, name: 'demo' });
  const post = async (m: unknown) => { host.panels[0].webview.post(m); await new Promise((r) => setTimeout(r, 20)); };
  await post({ type: 'cli', action: 'validate', root, change: 'demo' });
  assert.deepEqual(calls, ['validate demo']);
  assert.match(host.panels[0].webview.html, /validate done\./);
  await post({ type: 'cli', action: 'rm', root, change: 'demo' });
  await post({ type: 'cli', action: 'sync', root, change: 'nope' });
  await post({ type: 'cli', action: 'sync', root: '/elsewhere', change: 'demo' });
  await post({ type: 'cli', action: 'archive', root, change: 'demo' });
  assert.deepEqual(calls, ['validate demo'], 'unknown action, change or root, and a declined archive, run nothing');
  assert.ok(host.messages.includes('Archive demo?'));
  host.warningAnswer = 'Archive';
  await post({ type: 'cli', action: 'archive', root, change: 'demo' });
  assert.deepEqual(calls, ['validate demo', 'archive demo', 'refresh']);
  assert.match(host.panels[0].webview.html, /archive done\./, 'after an archive the overview shows the answer');
  await post({ type: 'cli', action: 'doctor', root });
  assert.equal(calls.at(-1), 'doctor');
  host.trusted = false;
  await post({ type: 'cli', action: 'doctor', root });
  assert.equal(calls.filter((c) => c === 'doctor').length, 1, 'an untrusted workspace runs nothing');
  panel.dispose();
});
