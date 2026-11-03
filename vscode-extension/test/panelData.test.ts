// The change dashboard data against real run files and a fake verifier.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import './support/installStub.mjs';
import { fakeBundle } from './support/bundle.ts';
import { traceProject } from './trace-fixture.ts';

const stub = await import('./support/vscodeStub.mjs');
const { host } = stub;
const { PanelData, readRunFiles } = await import('../src/editor/panelData.ts');
const { VerifierClient } = await import('../src/editor/verifier.ts');

const fakeVerifier = (findings: unknown[]) =>
  new VerifierClient(async (_c: string, args: string[]) => ({ code: 0, stdout: args.includes('sync-check') ? JSON.stringify({ synced: false, problems: ['specs: not merged'], warnings: [] }) : JSON.stringify({ ok: false, findings }), stderr: '', timedOut: false }), fakeBundle());

const put = (dir: string, f: string, text: string): void => {
  mkdirSync(dirname(join(dir, f)), { recursive: true });
  writeFileSync(join(dir, f), text);
};
const wait = (data: { onReady: () => void }): Promise<void> => new Promise((r) => (data.onReady = r));

test('dashboard data: run files, problems and sync-check are read once and kept; the switch turns the verifier off', async () => {
  host.reset();
  const dir = traceProject();
  put(dir, 'runs/refunds/current', '20261025T1-1\n');
  put(dir, 'runs/refunds/20261025T1-1/state.json', JSON.stringify({ task: { label: '1.1' }, attempts: 1, last_failure: 'boom', review: null }));
  put(dir, 'runs/refunds/20261025T1-1/metrics.jsonl', '{"event":"check","task":"1.1","attempt":1,"ok":false,"failures":["boom"]}\n');
  assert.equal(readRunFiles(dir, 'refunds').runId, '20261025T1-1');
  assert.deepEqual(readRunFiles(dir, 'missing'), {});
  const store = { projects: [{ root: dir, workspaceFolder: dir, adrs: [], changes: [], error: undefined }], onDidChange: () => new stub.Disposable() };
  const d = new PanelData(store as never, fakeVerifier([{ source: 'lint', code: 'x', severity: 'error', message: 'm', file: join(dir, 'a'), line: 1, col: 1, length: 1, change: 'refunds' }]));
  const ready = wait(d);
  assert.equal(d.dashboard(dir, 'refunds'), undefined);
  await ready;
  const got = d.dashboard(dir, 'refunds');
  assert.deepEqual([got?.run?.checksFailed, got?.findings?.length, got?.sync?.ok, got?.unavailable], [1, 1, false, undefined]);
  d.invalidate();
  assert.equal(d.dashboard(dir, 'refunds'), undefined);
  await d.settled(5000);
  assert.equal(d.dashboard(dir, 'refunds')?.sync?.ok, false, 'settled: the first render of a change page has the sync state');
  const t0 = Date.now();
  await d.settled(5000);
  assert.ok(Date.now() - t0 < 1000, 'nothing in flight: no wait');

  host.settings['wingmanSpec.dashboardChecks'] = false;
  d.invalidate();
  const ready2 = wait(d);
  d.dashboard(dir, 'refunds');
  await ready2;
  assert.match(d.dashboard(dir, 'refunds')?.unavailable ?? '', /switched off/);
  assert.equal(d.dashboard(dir, 'refunds')?.findings, undefined);
  host.reset();
});
