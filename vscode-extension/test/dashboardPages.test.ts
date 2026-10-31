// Renders the branch review page and the change dashboard from real inputs (a real git repo, real verifier run files).
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import './support/installStub.mjs';
import { fakeBundle } from './support/bundle.ts';
import { makeData, makeFixture } from './fixture.ts';
import { git, repo } from './support/gitRepo.ts';

const stub = await import('./support/vscodeStub.mjs');
const { TraceCache } = await import('../src/editor/anchorCode.ts');
const { PanelData } = await import('../src/editor/panelData.ts');
const { VerifierClient } = await import('../src/editor/verifier.ts');
const { renderPage } = await import('../src/webview/render.ts');
const { TERMINAL_COMMAND } = await import('../src/webview/panel.ts');
const { summarizeRun } = await import('../src/model/changeDashboard.ts');

const fx = makeFixture();
after(() => rmSync(fx, { recursive: true, force: true }));
const dump = process.env['WSX_DUMP'];
const out = (name: string, html: string): void => {
  if (!dump) return;
  mkdirSync(dump, { recursive: true });
  writeFileSync(join(dump, `${name}.html`), html);
};
const fixture = (n: string, f: string): string => readFileSync(join(import.meta.dirname, 'fixtures', n, f), 'utf8');
const attrs = (html: string, name: string): string[] => [...html.matchAll(new RegExp(`data-${name}="([^"]*)"`, 'g'))].map((m) => (m[1] ?? '').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));

test('branch review page: summary, requirement rows route to the extension page, anchors open code, no raw HTML', async () => {
  const dir = repo();
  const store = { projects: [{ root: dir, workspaceFolder: dir, adrs: [], changes: [], error: undefined }], onDidChange: () => new stub.Disposable() };
  const verifier = new VerifierClient(async () => ({ code: 0, stdout: JSON.stringify({ ok: false, findings: [{ source: 'drift', code: 'untested-requirement', severity: 'error', message: 'billing/rounding has no test <b>x</b>', file: join(dir, 'src/round.py'), line: 1, col: 1, length: 1 }] }), stderr: '', timedOut: false }), fakeBundle());
  const data = new PanelData(store as never, new TraceCache(store as never), verifier);
  const ready = new Promise<void>((r) => (data.onReady = r));
  data.branch(dir);
  await ready;
  const view = { ...(await makeData(fx, { page: 'branch', root: dir })), branch: data.branch(dir) };
  const html = renderPage(view, 'NONCE', 'vscode-resource:');
  out('branch', html);
  assert.match(html, /Branch review/);
  assert.match(html, /feature\/x/);
  assert.match(html, /billing\/rounding/);
  assert.match(html, /billing\/remove-an-item/);
  assert.ok(!html.includes('<b>x</b>'), 'verifier text is escaped');
  assert.ok(attrs(html, 'open').some((p) => p.endsWith('src/round.py')) || /data-open=/.test(html), 'code rows open the file');
  assert.ok(/data-route=/.test(html), 'requirement rows route inside the extension');
  git(dir, 'status');
});

test('branch review page: loading and unavailable states are plain text', async () => {
  const base = await makeData(fx, { page: 'branch' });
  assert.match(renderPage({ ...base, branch: { status: 'loading' } }, 'N', 'c:'), /Reading git/i);
  assert.match(renderPage({ ...base, branch: { status: 'unavailable', reason: 'This folder is not a git repository' } }, 'N', 'c:'), /not a git repository/);
  assert.match(renderPage(base, 'N', 'c:'), /Branch review/);
});

test('change dashboard with open tasks: the archive list is collapsed; terminal commands pass the whitelist', async () => {
  const run = summarizeRun({ runId: 'r1', state: fixture('run-failing', 'state.json'), metrics: fixture('run-failing', 'metrics.jsonl'), ledger: fixture('run-failing', 'verified.json') });
  const view = await makeData(fx, { page: 'change', root: fx, name: 'demo' });
  const html = renderPage({ ...view, dashboard: { ...(run ? { run } : {}), sync: { ok: false, problems: ['specs: not merged into openspec/specs'], warnings: [] }, findings: [{ source: 'drift', code: 'untested-requirement', severity: 'error', message: 'auth/login has no test', file: join(fx, 'x'), line: 1, col: 1, length: 1, change: 'demo' }] } }, 'N', 'c:');
  out('change', html);
  // tasks are still open: the archive list is one collapsed, muted line without buttons
  assert.match(html, /<details class="pre-archive"><summary>Before archive: \d+ items<\/summary>/);
  assert.match(html, /not synced/);
  assert.match(html, /tasks not verified/);
  assert.doesNotMatch(html, /Blocking archive/);
  assert.doesNotMatch(html, /<details class="pre-archive" open/);
  for (const t of attrs(html, 'term')) assert.match(t, TERMINAL_COMMAND, t);
  assert.ok(!/<img src=x/.test(html), 'task text stays escaped');
});

test('the terminal whitelist accepts verifier calls only', () => {
  for (const ok of ['.wingman-spec/bin/wingman-spec sync-check demo', '.wingman-spec/bin/wingman-spec drift decide a/b:c --accept --note x']) assert.match(ok, TERMINAL_COMMAND);
  for (const bad of ['rm -rf /', '.wingman-spec/bin/wingman-spec x; rm -rf /', '.wingman-spec/bin/wingman-spec x && curl evil', 'node other.js', '.wingman-spec/bin/wingman-spec `id`', '.wingman-spec/bin/wingman-spec $(id)', '.wingman-spec/bin/wingman-spec x\nls']) assert.doesNotMatch(bad, TERMINAL_COMMAND, bad);
});
