// The file watcher: which paths refresh the views. Driven against the stand-in for the `vscode` module (wiring only).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import './support/installStub.mjs';

const stub = await import('./support/vscodeStub.mjs');
const { host } = stub;
const { watchRoots, STORE_PATTERN, CODE_PATTERN } = await import('../src/watcher.ts');

const root = join('/tmp', 'watched-project');
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(): { fired: () => number; fire: (rel: string) => void; patterns: string[]; dispose: () => void } {
  host.reset();
  let n = 0;
  const d = watchRoots([root], () => void n++);
  const patterns = host.watchers.map((w: { pattern: { pattern: string } }) => w.pattern.pattern);
  // an event from every watcher whose pattern could match: the code watcher gets every file, so the filter is what is tested
  const fire = (rel: string) => host.watchers.forEach((w: { fire: (p: string) => void; pattern: { pattern: string } }) => w.fire(join(root, rel)));
  return { fired: () => n, fire, patterns, dispose: () => d.dispose() };
}

test('the store pattern covers config, workspace, changes, specs, observed, roadmap and greenfield', () => {
  for (const part of ['config.yaml', 'workspace.yaml', 'changes/**', 'specs/**', 'observed/**', 'roadmap/**', 'greenfield/**']) {
    assert.ok(STORE_PATTERN.includes(part), part);
  }
  assert.ok(!STORE_PATTERN.includes('drift-decisions'), 'the drift-decisions folder no longer exists');
});

test('it watches the store, the ADR folder and code files, each with the root as the base', () => {
  const w = setup();
  assert.deepEqual(w.patterns, [STORE_PATTERN, 'adr/**', CODE_PATTERN]);
  assert.ok(host.watchers.every((x: { pattern: { base: { fsPath: string } } }) => x.pattern.base.fsPath === root));
  w.dispose();
});

test('an edit of a code file that can carry an anchor triggers one debounced refresh; a burst is one refresh', async () => {
  const w = setup();
  w.fire('src/billing/add.ts');
  w.fire('tests/billing.test.ts');
  w.fire('src/billing/round.py');
  await tick(450);
  assert.equal(w.fired(), 1);
  w.dispose();
});

test('files that cannot carry an anchor do not refresh (build output, dependencies, images, markdown outside openspec)', async () => {
  const w = setup();
  // only the code watcher can see these (they do not match the store or ADR patterns), so isolate it
  const code = host.watchers[2];
  for (const rel of ['node_modules/x/index.js', 'dist/app.js', '.git/HEAD', 'logo.png', 'README.md', 'package-lock.json']) code.fire(join(root, rel));
  await tick(450);
  assert.equal(w.fired(), 0);
  code.fire(join(root, 'src/app.ts'));
  await tick(450);
  assert.equal(w.fired(), 1);
  w.dispose();
});

test('the store and ADR watchers refresh on every event (no path filter)', async () => {
  const w = setup();
  host.watchers[0].fire(join(root, 'openspec/specs/billing/spec.md'));
  await tick(450);
  assert.equal(w.fired(), 1);
  host.watchers[1].fire(join(root, 'adr/0001-x.md'));
  await tick(450);
  assert.equal(w.fired(), 2);
  w.dispose();
});
