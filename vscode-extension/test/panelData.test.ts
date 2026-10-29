// The pull request view and change dashboard data against a real git repository (git is run for real) and a fake verifier.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import './support/installStub.mjs';
import { git, put, repo } from './support/gitRepo.ts';
import { traceProject } from './trace-fixture.ts';

const stub = await import('./support/vscodeStub.mjs');
const { host } = stub;
const { TraceCache } = await import('../src/editor/anchorCode.ts');
const { PanelData, readRunFiles } = await import('../src/editor/panelData.ts');
const { VerifierClient } = await import('../src/editor/verifier.ts');

const fakeVerifier = (findings: unknown[]) =>
  new VerifierClient(async (_c: string, args: string[]) => ({ code: 0, stdout: args.includes('guard') ? JSON.stringify({ level: 'warn', findings: [] }) : args.includes('sync-check') ? JSON.stringify({ synced: false, problems: ['specs: not merged'], warnings: [] }) : JSON.stringify({ ok: false, findings }), stderr: '', timedOut: false }));

const wait = (data: { onReady: () => void }): Promise<void> => new Promise((r) => (data.onReady = r));

test('branch review of a real repo: committed, uncommitted and new files; base and merge base found; loads in the background', async () => {
  host.reset();
  const dir = repo();
  const store = { projects: [{ root: dir, workspaceFolder: dir, adrs: [], changes: [], error: undefined }], onDidChange: () => new stub.Disposable() };
  const findings = [{ source: 'drift', code: 'untested-requirement', severity: 'error', message: 'rounding has no test', file: join(dir, 'src/round.py'), line: 1, col: 1, length: 1 }, { source: 'drift', code: 'orphan-anchor', severity: 'error', message: 'elsewhere', file: join(dir, 'src/other.ts'), line: 1, col: 1, length: 1 }];
  const data = new PanelData(store as never, new TraceCache(store as never), fakeVerifier(findings));
  const ready = wait(data);
  assert.deepEqual(data.branch(dir), { status: 'loading' });
  await ready;
  const st = data.branch(dir);
  assert.equal(st.status, 'ready');
  if (st.status !== 'ready') return;
  const r = st.review;
  assert.deepEqual([r.branch, r.base], ['feature/x', 'main']);
  assert.equal(r.mergeBase, git(dir, 'rev-parse', 'main').trim());
  assert.deepEqual(r.anchors.map((a) => [a.change, a.key, a.file]), [['changed', 'billing/rounding', 'src/round.py'], ['added', 'billing/remove-an-item', 'src/fresh.ts']]);
  assert.deepEqual(r.requirements.map((q) => [q.key, q.via]), [['billing/remove-an-item', ['code', 'test']], ['billing/rounding', ['code']]]);
  assert.deepEqual(r.findings.map((f) => f.message), ['rounding has no test']);
  assert.equal(r.files, 3);
});

test('not a git repository, no base branch and untrusted workspace are explained, never thrown', async () => {
  host.reset();
  const plain = traceProject();
  const mk = (dir: string) => ({ projects: [{ root: dir, workspaceFolder: dir, adrs: [], changes: [], error: undefined }], onDidChange: () => new stub.Disposable() });
  const s1 = mk(plain);
  const d1 = new PanelData(s1 as never, new TraceCache(s1 as never), fakeVerifier([]));
  let ready = wait(d1);
  d1.branch(plain);
  await ready;
  assert.match((d1.branch(plain) as { reason: string }).reason, /not a git repository/);

  const nobase = mkdtempSync(join(tmpdir(), 'wsx-nobase-'));
  put(nobase, 'openspec/config.yaml', 'schema: wingman-spec\n');
  git(nobase, 'init', '-q', '-b', 'topic');
  put(nobase, 'a.txt', 'x');
  git(nobase, 'add', '-A');
  git(nobase, 'commit', '-q', '-m', 'one');
  const s2 = mk(nobase);
  const d2 = new PanelData(s2 as never, new TraceCache(s2 as never), fakeVerifier([]));
  ready = wait(d2);
  d2.branch(nobase);
  await ready;
  assert.match((d2.branch(nobase) as { reason: string }).reason, /No base branch found/);

  host.trusted = false;
  const d3 = new PanelData(s2 as never, new TraceCache(s2 as never), fakeVerifier([]));
  ready = wait(d3);
  d3.branch(nobase);
  await ready;
  assert.match((d3.branch(nobase) as { reason: string }).reason, /not trusted/);
  host.reset();
});

test('the base can be set; a setting that names no ref falls back to the usual ones', async () => {
  host.reset();
  const dir = repo();
  git(dir, 'branch', 'release', 'main');
  const store = { projects: [{ root: dir, workspaceFolder: dir, adrs: [], changes: [], error: undefined }], onDidChange: () => new stub.Disposable() };
  for (const [setting, expected] of [['release', 'release'], ['nope', 'main']] as const) {
    host.settings['wingmanSpec.branchReviewBase'] = setting;
    const d = new PanelData(store as never, new TraceCache(store as never), fakeVerifier([]));
    const ready = wait(d);
    d.branch(dir);
    await ready;
    const st = d.branch(dir);
    assert.equal(st.status === 'ready' && st.review.base, expected);
  }
  host.reset();
});

test('dashboard data: run files, problems and sync-check are read once and kept; the switch turns the verifier off', async () => {
  host.reset();
  const dir = repo();
  put(dir, 'openspec/.apply-runs/refunds/current', '20261025T1-1\n');
  put(dir, 'openspec/.apply-runs/refunds/20261025T1-1/state.json', JSON.stringify({ task: { label: '1.1' }, attempts: 1, last_failure: 'boom', review: null }));
  put(dir, 'openspec/.apply-runs/refunds/20261025T1-1/metrics.jsonl', '{"event":"check","task":"1.1","attempt":1,"ok":false,"failures":["boom"]}\n');
  assert.equal(readRunFiles(dir, 'refunds').runId, '20261025T1-1');
  assert.deepEqual(readRunFiles(dir, 'missing'), {});
  const store = { projects: [{ root: dir, workspaceFolder: dir, adrs: [], changes: [], error: undefined }], onDidChange: () => new stub.Disposable() };
  const d = new PanelData(store as never, new TraceCache(store as never), fakeVerifier([{ source: 'lint', code: 'x', severity: 'error', message: 'm', file: join(dir, 'a'), line: 1, col: 1, length: 1, change: 'refunds' }]));
  const ready = wait(d);
  assert.equal(d.dashboard(dir, 'refunds'), undefined);
  await ready;
  const got = d.dashboard(dir, 'refunds');
  assert.deepEqual([got?.run?.checksFailed, got?.findings?.length, got?.sync?.ok, got?.unavailable], [1, 1, false, undefined]);

  host.settings['wingmanSpec.dashboardChecks'] = false;
  d.invalidate();
  const ready2 = wait(d);
  d.dashboard(dir, 'refunds');
  await ready2;
  assert.match(d.dashboard(dir, 'refunds')?.unavailable ?? '', /switched off/);
  assert.equal(d.dashboard(dir, 'refunds')?.findings, undefined);
  host.reset();
});
