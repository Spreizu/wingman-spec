import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTrace, readMode } from '../src/model/traceability.ts';
import { traceProject } from './trace-fixture.ts';

const model = buildTrace(...(((d) => [d, d] as const)(traceProject())));

test('living requirements: key, why (not in the statement), scenarios', () => {
  const r = model.requirements.get('billing/add-an-item');
  assert.equal(r?.name, 'Add an item');
  assert.equal(r?.statement, 'The system SHALL add an item to the bill.');
  assert.equal(r?.why, 'Users see what they owe, so they trust the app.');
  assert.deepEqual(r?.scenarios.map((s) => s.slug), ['add-and-see-it', 'reject-empty']);
  assert.equal(model.requirements.get('billing/rounding')?.why, 'Finance needs totals that match the bank statement.');
  assert.equal(model.requirements.get('billing/legacy-thing')?.why, null);
});

test('anchors: code markers, test markers and test tags are attached; broken ones are not', () => {
  const r = model.requirements.get('billing/add-an-item');
  assert.deepEqual(r?.code.map((a) => `${a.file}:${a.line}`), ['src/add.ts:0']);
  assert.deepEqual(r?.tests.map((a) => `${a.file}:${a.line}:${a.kind}`), ['tests/add.test.ts:0:marker', 'tests/add.test.ts:1:tag']);
  assert.deepEqual(model.requirements.get('billing/rounding')?.code.map((a) => a.file), ['src/round.py']);
  assert.deepEqual(model.requirements.get('billing/remove-an-item')?.code, []);
});

test('requirement flags', () => {
  assert.deepEqual(model.requirements.get('billing/add-an-item')?.flags, []);
  assert.deepEqual(model.requirements.get('billing/remove-an-item')?.flags, ['no-code-anchor', 'no-test-anchor']);
  assert.deepEqual(model.requirements.get('billing/legacy-thing')?.flags, ['no-why', 'no-code-anchor', 'no-test-anchor']);
});

test('pending change: the requirements without a Why, rewritten Whys and removals need the owner', () => {
  const c = model.changes.find((x) => x.name === 'refunds');
  assert.deepEqual(c?.missingWhy, ['billing/fee']);
  assert.deepEqual(c?.approvals.map((x) => [x.key, x.status]), [['billing/remove-an-item', 'changed'], ['billing/legacy-thing', 'removed']]);
  const changed = c?.approvals.find((x) => x.key === 'billing/remove-an-item');
  assert.equal(changed?.was, 'Users can remove a mistake before they pay.');
  assert.equal(changed?.now, 'Users can remove a mistake until the order is paid.');
  assert.equal(c?.approval, null);
  assert.ok(!model.changes.some((x) => x.name === 'archive'));
});

test('an Owner approval line in the proposal is read', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = traceProject();
  const p = join(dir, 'openspec/changes/refunds/proposal.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace('## What Changes', 'Owner approval: Maria, 2026-10-02\n\n## What Changes'));
  const c = buildTrace(dir, dir).changes.find((x) => x.name === 'refunds');
  assert.equal(c?.approval, 'Maria, 2026-10-02');
});

test('a MODIFIED requirement with the same Why needs no approval', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = traceProject();
  const p = join(dir, 'openspec/changes/refunds/specs/billing/spec.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace('Why: Users can remove a mistake until the order is paid.', 'Why: Users can remove a mistake before they pay.'));
  const c = buildTrace(dir, dir).changes.find((x) => x.name === 'refunds');
  assert.deepEqual(c?.approvals.map((x) => x.key), ['billing/legacy-thing']);
});

test('drift gaps use the verifier types and keys; an Accepted line is attached', () => {
  const keys = model.gaps.map((g) => g.key).sort();
  assert.deepEqual(keys, [
    'orphan-anchor:billing/add-item@src/add.ts',
    'stale-test-tag:billing/gone',
    'stale-test-tag:legacy/x',
    'unanchored-requirement:billing/legacy-thing',
    'unanchored-requirement:billing/remove-an-item',
    'unsynced-archive:billing/lost-one',
    'untested-requirement:billing/rounding',
  ]);
  assert.equal(model.gaps.find((g) => g.key === 'untested-requirement:billing/rounding')?.accepted, 'covered elsewhere');
  const r = model.requirements.get('billing/rounding');
  assert.equal(r?.accepted, 'covered elsewhere');
  assert.ok(!r?.statement.includes('Accepted'), 'the Accepted line is not part of the statement');
  assert.equal(model.gaps.find((g) => g.type === 'unsynced-archive')?.text.includes('2026-01-01-first'), true);
  assert.ok(model.gaps.find((g) => g.type === 'orphan-anchor')?.text.includes('perhaps billing/add-an-item'));
});

test('unresolved markers carry a did-you-mean hint', () => {
  assert.deepEqual(model.unresolved.map((u) => [u.key, u.file, u.line, u.hint]), [['billing/add-item', 'src/add.ts', 1, 'billing/add-an-item']]);
});

test('mode is read from config; a project without the layer is reported', () => {
  assert.equal(model.mode, 'on');
  assert.equal(readMode(['/nonexistent']), 'off');
  const dir = traceProject({ mode: 'warn' });
  assert.equal(buildTrace(dir, dir).mode, 'warn');
});

test('an empty project does not throw', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const d = mkdtempSync(join(tmpdir(), 'wsx-empty-'));
  const m = buildTrace(d, d);
  assert.equal(m.requirements.size, 0);
  assert.ok(!m.hasLayer);
  assert.deepEqual(m.gaps, []);
});
