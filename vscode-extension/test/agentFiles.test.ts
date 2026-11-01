// The Update button in the panel header: shown only for folders whose generated agent files are older than the bundled
// CLI, disabled while `update` runs through the project shim, hidden afterwards, kept with the error when update fails.
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { AgentFiles, updateBin } from '../src/editor/agentFiles.ts';
import type { Runner } from '../src/editor/verifier.ts';
import { renderPage } from '../src/webview/render.ts';
import { makeData, makeFixture } from './fixture.ts';

const root = makeFixture();
after(() => rmSync(root, { recursive: true, force: true }));
const nav = (html: string): string => /<nav[\s\S]*?<\/nav>/.exec(html)?.[0] ?? '';

test('the button shows only while files are stale, says so while update runs, and hides after', async () => {
  let stale = ['AGENTS.md'];
  let release: () => void = () => {};
  const run: Runner = async (_cmd, args) => {
    if (args.includes('--check')) return { code: 0, stdout: JSON.stringify({ stale }), stderr: '', timedOut: false };
    await new Promise<void>((r) => (release = r));
    stale = [];
    return { code: 0, stdout: 'ok\n', stderr: '', timedOut: false };
  };
  const files = new AgentFiles(run);
  const page = async (): Promise<string> => nav(renderPage({ ...(await makeData(root, { page: 'overview' })), agentUpdates: files.list() }, 'N', 'vscode-resource:'));
  assert.doesNotMatch(await page(), /update-btn/, 'nothing before the check');
  await files.check('/w/app');
  assert.match(await page(), /<button class="btn update-btn" data-update="\/w\/app" title="1 generated agent file\(s\) in app are older[^"]*">Update<\/button>/);
  const done = files.update('/w/app');
  await new Promise((r) => setTimeout(r, 5));
  assert.match(await page(), /<button class="btn update-btn" disabled aria-busy="true"[^>]*>Updating\.\.\.<\/button>/);
  release();
  assert.equal(await done, true);
  assert.doesNotMatch(await page(), /update-btn/, 'hidden once current');
});

test('a failed update keeps the button with the error as its tooltip; a current folder never shows one', async () => {
  const run: Runner = async (_cmd, args, opts) =>
    args.includes('--check')
      ? { code: 0, stdout: JSON.stringify({ stale: opts.cwd === '/w/a' ? ['x.md'] : [] }), stderr: '', timedOut: false }
      : { code: 1, stdout: '', stderr: 'AGENTS.md: the markers are unbalanced\nmore', timedOut: false };
  const files = new AgentFiles(run);
  await files.check('/w/a');
  await files.check('/w/b');
  assert.deepEqual(files.list().map((u) => u.name), ['a']);
  assert.equal(await files.update('/w/b'), false);
  assert.equal(await files.update('/w/a'), false);
  const html = nav(renderPage({ ...(await makeData(root, { page: 'overview' })), agentUpdates: files.list() }, 'N', 'vscode-resource:'));
  assert.match(html, /data-update="\/w\/a" title="wingman-spec update failed: AGENTS.md: the markers are unbalanced">Update</);
});

test('an unreadable check or a failing CLI shows no button', async () => {
  const files = new AgentFiles(async () => ({ code: 2, stdout: '{"stale":["x"]}', stderr: 'unknown flag', timedOut: false }));
  await files.check('/w/a');
  assert.deepEqual(files.list(), []);
});

test('two folders name theirs; update runs through the project shim (the bundled CLI on Windows)', async () => {
  const files = new AgentFiles(async () => ({ code: 0, stdout: '{"stale":["x"]}', stderr: '', timedOut: false }));
  await files.check('/w/a');
  await files.check('/w/b');
  const html = nav(renderPage({ ...(await makeData(root, { page: 'overview' })), agentUpdates: files.list() }, 'N', 'vscode-resource:'));
  assert.match(html, />Update a</);
  assert.match(html, />Update b</);
  assert.equal(updateBin('/w/a', '/ext/bin/wingman-spec', 'darwin'), join('/w/a', '.wingman-spec', 'bin', 'wingman-spec'));
  assert.equal(updateBin('C:\\w\\a', 'C:\\ext\\bin\\wingman-spec.exe', 'win32'), 'C:\\ext\\bin\\wingman-spec.exe');
});
