import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTrace } from '../src/model/traceability.ts';
import { buildTraceNodes } from '../src/model/traceTree.ts';
import type { TraceNode } from '../src/model/traceTree.ts';
import { traceProject } from './trace-fixture.ts';

const dir = traceProject();
const nodes = buildTraceNodes(buildTrace(dir, dir));
const find = (list: TraceNode[], id: string): TraceNode | undefined => {
  for (const n of list) {
    if (n.id === id) return n;
    const c = find(n.children, id);
    if (c) return c;
  }
  return undefined;
};

test('top level: requirements, changes, drift, branch review', () => {
  assert.deepEqual(nodes.map((n) => n.id), ['requirements', 'changes', 'drift', 'branch-review']);
  assert.equal(nodes[0]?.description, '4 · 1 without a Why');
});

test('a requirement shows its Why, the capability and its code and test anchors', () => {
  const r = find(nodes, 'req/billing/add-an-item');
  assert.equal(r?.label, 'Add an item');
  assert.equal(r?.description, 'Users see what they owe, so they trust the app. · billing · 1 code anchor · 2 tests');
  assert.deepEqual(r?.children.map((c) => c.description), ['code', 'test', 'test tag']);
  assert.ok(r?.children[0]?.file?.endsWith('src/add.ts'));
  assert.equal(r?.children[0]?.line, 0);
});

test('a requirement without a Why is flagged with the reason', () => {
  const r = find(nodes, 'req/billing/legacy-thing');
  assert.equal(r?.icon, 'warning');
  assert.match(r?.tooltip ?? '', /Warning: no Why line/);
  assert.equal(find(nodes, 'req/billing/add-an-item')?.icon, 'pass');
});

test('changes: a requirement without a Why, a rewritten Why and a removal need attention until the proposal has the owner approval', () => {
  const c = find(nodes, 'change/refunds');
  assert.equal(c?.icon, 'warning');
  assert.equal(c?.description, '1 without a Why · needs owner approval');
  assert.match(find(nodes, 'change/refunds/nowhy/billing/fee')?.description ?? '', /no Why line/);
  const changed = find(nodes, 'change/refunds/approval/billing/remove-an-item');
  assert.equal(changed?.description, 'Why rewritten: owner approval');
  assert.match(changed?.tooltip ?? '', /Was: Users can remove a mistake before they pay\.\nNow: Users can remove a mistake until the order is paid\./);
  assert.equal(find(nodes, 'change/refunds/approval/billing/legacy-thing')?.description, 'removed: owner approval');
});

test('drift groups every gap type; accepted gaps are marked', () => {
  const d = find(nodes, 'drift');
  assert.equal(d?.description, '6 open · 1 accepted');
  assert.deepEqual(d?.children.map((c) => c.id).sort(), [
    'drift/orphan-anchor', 'drift/stale-test-tag', 'drift/unanchored-requirement', 'drift/unsynced-archive', 'drift/untested-requirement',
  ]);
  const accepted = find(nodes, 'drift/untested-requirement:billing/rounding');
  assert.equal(accepted?.description, 'accepted: covered elsewhere');
  assert.equal(accepted?.icon, 'check');
  assert.ok(find(nodes, 'drift/orphan-anchor:billing/add-item@src/add.ts')?.file?.endsWith('src/add.ts'));
});

test('a project without the traceability layer shows one hint node', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const d = mkdtempSync(join(tmpdir(), 'wsx-off-'));
  const n = buildTraceNodes(buildTrace(d, d));
  assert.equal(n.length, 1);
  assert.equal(n[0]?.id, 'off');
});

test('node ids are unique so the tree can reveal and refresh them', () => {
  const ids: string[] = [];
  const walk = (list: TraceNode[]): void => list.forEach((n) => (ids.push(n.id), walk(n.children)));
  walk(nodes);
  assert.equal(new Set(ids).size, ids.length);
});

test('clicks: a requirement opens the Wingman Spec UI on it; code and test anchors still open the file', () => {
  const req = find(nodes, 'req/billing/add-an-item');
  assert.deepEqual(req?.route, { page: 'spec', root: dir, name: 'billing', focus: 'req:add-an-item' });
  assert.ok(req?.file, 'the spec.md location stays available as the secondary action');
  const [code, test] = req?.children ?? [];
  assert.equal(code?.route, undefined);
  assert.equal(test?.route, undefined);
});

test('drift gaps about a requirement reveal it; other gaps keep opening their file', () => {
  const walk = (list: TraceNode[]): TraceNode[] => list.flatMap((n) => [n, ...walk(n.children)]);
  const gaps = walk(find(nodes, 'drift')?.children ?? []);
  const withRoute = gaps.filter((g) => g.route);
  assert.ok(withRoute.length > 0);
  for (const g of withRoute) assert.equal((g.route as { focus: string }).focus.startsWith('req:'), true);
});
