import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { hasSpecsRoot, scanProject } from '../src/model/changeScanner.ts';

const tmp = mkdtempSync(join(tmpdir(), 'wingman-spec-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function put(root: string, rel: string, text: string): void {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function project(name: string): string {
  const root = join(tmp, name);
  put(root, 'wingman-spec.yaml', '');
  return root;
}

const ADR = (change: string, title = 'Use PostgreSQL') =>
  `---\ntitle: ${title}\nstatus: Proposed\ndate: 2026-10-19\nchange: ${change}\n---\n\n# ${title}\n`;

test('detects a specs root by wingman-spec.yaml', async () => {
  assert.equal(await hasSpecsRoot(project('detect')), true);
  assert.equal(await hasSpecsRoot(join(tmp, 'nothing-here')), false);
});

test('lists active changes and ignores archived changes and dot folders', async () => {
  const root = project('list');
  put(root, 'changes/alpha/proposal.md', 'x');
  put(root, 'archive/2026-10-01-1200-old/proposal.md', 'x');
  put(root, 'changes/.hidden/proposal.md', 'x');
  const model = await scanProject(root);
  assert.deepEqual(model.changes.map((c) => c.name), ['alpha']);
});

test('artifact states follow the files on disk', async () => {
  const root = project('artifacts');
  const c = 'changes/demo';
  put(root, `${c}/app-map.md`, 'x');
  put(root, `${c}/proposal.md`, 'x');
  put(root, `${c}/specs/cart.md`, 'x');
  put(root, 'specs/auth.md', 'x');
  put(root, `${c}/specs/auth.md`, 'x');
  const change = (await scanProject(root)).changes[0];
  assert.ok(change);
  const states = Object.fromEntries(change.artifacts.map((a) => [a.id, a.state]));
  assert.deepEqual(states, {
    'app-map': 'done',
    proposal: 'done',
    specs: 'done',
    design: 'missing',
    adrs: 'missing',
    tasks: 'missing',
  });
  assert.deepEqual(
    change.capabilities.map((k) => `${k.name}:${k.kind}`),
    ['auth:delta', 'cart:new'],
  );
  assert.equal(change.state, 'planning');
});

test('`Specs: none` in proposal.md marks the specs artifact as skipped', async () => {
  const root = project('skipspecs');
  put(root, 'changes/demo/proposal.md', 'Size: S\nSpecs: none\n\n## Why\nx\n');
  const change = (await scanProject(root)).changes[0];
  assert.equal(change?.artifacts.find((a) => a.id === 'specs')?.state, 'skipped');
});

test('a fast change (Size S, Risk none) shows its missing app-map, design and adrs as skipped; a bigger one as missing', async () => {
  const root = project('fast');
  put(root, 'changes/small/proposal.md', 'Size: S\nRisk: none\n\n## Why\nx\n');
  put(root, 'changes/big/proposal.md', 'Size: M\nRisk: none\n\n## Why\nx\n');
  const byName = Object.fromEntries((await scanProject(root)).changes.map((c) => [c.name, c]));
  const states = (n: string) => Object.fromEntries((byName[n]?.artifacts ?? []).map((a) => [a.id, a.state]));
  assert.deepEqual([states('small')['app-map'], states('small')['design'], states('small')['adrs']], ['skipped', 'skipped', 'skipped']);
  assert.equal(states('small')['tasks'], 'missing');
  assert.deepEqual([states('big')['app-map'], states('big')['design'], states('big')['adrs']], ['missing', 'missing', 'missing']);
});

test('task progress and state: in-progress, complete, blocked', async () => {
  const root = project('state');
  put(root, 'changes/a/tasks.md', '## 1. G\n- [x] 1.1 a\n- [ ] 1.2 b\n');
  put(root, 'changes/b/tasks.md', '## 1. G\n- [x] 1.1 a\n');
  put(root, 'changes/c/tasks.md', '## 1. G\n- [ ] 1.1 a\n');
  put(root, 'changes/c/BLOCKED.md', 'spec is ambiguous');
  put(root, 'changes/c/progress.md', 'notes');
  const byName = Object.fromEntries((await scanProject(root)).changes.map((c) => [c.name, c]));
  assert.equal(byName['a']?.state, 'in-progress');
  assert.deepEqual([byName['a']?.taskDone, byName['a']?.taskTotal], [1, 2]);
  assert.equal(byName['b']?.state, 'complete');
  assert.equal(byName['c']?.state, 'blocked');
  assert.ok(byName['c']?.blockedPath?.endsWith('BLOCKED.md'));
  assert.ok(byName['c']?.progressPath?.endsWith('progress.md'));
});

test('ADR sync is computed against adrs/ of the specs root', async () => {
  const root = project('adrs');
  put(root, 'changes/demo/adrs/use-postgres.md', ADR('demo'));
  let change = (await scanProject(root)).changes[0];
  assert.equal(change?.adrs[0]?.sync.state, 'not-promoted');
  assert.equal(change?.adrsSynced, false);

  put(
    root,
    'adrs/0001-use-postgres.md',
    '---\ntitle: Use PostgreSQL\nstatus: Accepted\ndate: 2026-10-19\nchange: demo\nsource: demo/use-postgres\n---\n\n# Use PostgreSQL\n',
  );
  const model = await scanProject(root);
  change = model.changes[0];
  assert.equal(change?.adrs[0]?.sync.state, 'up-to-date');
  assert.equal(change?.adrsSynced, true);
  assert.equal(model.adrs.length, 1);
});

test('every change is a wingman-spec change', async () => {
  const root = project('every');
  put(root, 'changes/demo/proposal.md', 'x');
  const change = (await scanProject(root)).changes[0];
  assert.equal(change?.isWingmanSpec, true);
  assert.equal(change?.schema, 'wingman-spec');
});
