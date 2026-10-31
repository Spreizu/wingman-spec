// The file watcher: which paths refresh the views. Driven against the stand-in for the `vscode` module (wiring only).
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import './support/installStub.mjs';

const stub = await import('./support/vscodeStub.mjs');
const { host } = stub;
const { watchRoots, STORE_PATTERN, CODE_PATTERN, LAYOUT_PATTERN } = await import('../src/watcher.ts');

const root = join('/tmp', 'watched-project');
const specs = join(root, '.wingman-spec');
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

function setup(): { fired: () => number; fire: (rel: string) => void; patterns: string[]; dispose: () => void } {
  host.reset();
  let n = 0;
  const d = watchRoots([root], [specs], () => void n++);
  const patterns = host.watchers.map((w: { pattern: { pattern: string } }) => w.pattern.pattern);
  // an event from every watcher whose pattern could match: the code watcher gets every file, so the filter is what is tested
  const fire = (rel: string) => host.watchers.forEach((w: { fire: (p: string) => void; pattern: { pattern: string } }) => w.fire(join(root, rel)));
  return { fired: () => n, fire, patterns, dispose: () => d.dispose() };
}

test('the store pattern covers the config, changes, specs, archive, ADRs, observed, roadmap, greenfield and run timelines', () => {
  for (const part of ['wingman-spec.yaml', 'changes/**', 'specs/**', 'archive/**', 'adrs/**', 'observed/**', 'roadmap/**', 'greenfield/**', 'runs/*/timeline.jsonl']) {
    assert.ok(STORE_PATTERN.includes(part), part);
  }
  assert.ok(!STORE_PATTERN.includes('drift-decisions'), 'the drift-decisions folder no longer exists');
});

test('it watches the code folder (layout config, code files) and the specs root (store), each with its own base', () => {
  const w = setup();
  assert.deepEqual(w.patterns, [LAYOUT_PATTERN, CODE_PATTERN, STORE_PATTERN]);
  assert.deepEqual(host.watchers.map((x: { pattern: { base: { fsPath: string } } }) => x.pattern.base.fsPath), [root, root, specs]);
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

test('files that cannot carry an anchor do not refresh (build output, dependencies, images, markdown, the specs folder)', async () => {
  const w = setup();
  // only the code watcher can see these (they do not match the layout or store patterns), so isolate it
  const code = host.watchers[1];
  for (const rel of ['node_modules/x/index.js', 'dist/app.js', '.git/HEAD', 'logo.png', 'README.md', 'package-lock.json', '.wingman-spec/runs/x/state.json']) code.fire(join(root, rel));
  await tick(450);
  assert.equal(w.fired(), 0);
  code.fire(join(root, 'src/app.ts'));
  await tick(450);
  assert.equal(w.fired(), 1);
  w.dispose();
});

test('the layout and store watchers refresh on every event (no path filter)', async () => {
  const w = setup();
  host.watchers[2].fire(join(specs, 'specs/billing.md'));
  await tick(450);
  assert.equal(w.fired(), 1);
  host.watchers[0].fire(join(root, '.wingman-spec/wingman-spec.yaml'));
  await tick(450);
  assert.equal(w.fired(), 2);
  w.dispose();
});
