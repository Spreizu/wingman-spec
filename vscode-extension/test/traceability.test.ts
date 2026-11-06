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
  const p = join(dir, 'changes/refunds/proposal.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace('## What Changes', 'Owner approval: Maria, 2026-10-02\n\n## What Changes'));
  const c = buildTrace(dir, dir).changes.find((x) => x.name === 'refunds');
  assert.equal(c?.approval, 'Maria, 2026-10-02');
});

test('a MODIFIED requirement with the same Why needs no approval', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = traceProject();
  const p = join(dir, 'changes/refunds/specs/billing.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace('Why: Users can remove a mistake until the order is paid.', 'Why: Users can remove a mistake before they pay.'));
  const c = buildTrace(dir, dir).changes.find((x) => x.name === 'refunds');
  assert.deepEqual(c?.approvals.map((x) => x.key), ['billing/legacy-thing']);
});

test('drift gaps are left empty: the trace view reads them from problems JSON', () => {
  assert.deepEqual(model.gaps, []);
  const r = model.requirements.get('billing/rounding');
  assert.equal(r?.accepted, 'covered elsewhere');
  assert.ok(!r?.statement.includes('Accepted'), 'the Accepted line is not part of the statement');
});

test('gapsFromFindings keeps drift rows and drops the rest; the line becomes 0-based', async () => {
  const { gapsFromFindings } = await import('../src/model/traceability.ts');
  const gaps = gapsFromFindings([
    { source: 'drift', code: 'orphan-anchor', severity: 'error', message: 'missing', file: '/src/add.ts', line: 2, col: 1, length: 1, key: 'orphan-anchor:billing/add-item@src/add.ts' },
    { source: 'lint', code: 'no-why', severity: 'warning', message: 'x', file: '/s.md', line: 1, col: 1, length: 1 },
  ]);
  assert.deepEqual(gaps, [{ key: 'orphan-anchor:billing/add-item@src/add.ts', type: 'orphan-anchor', subject: 'billing/add-item@src/add.ts', text: 'missing', file: '/src/add.ts', line: 1 }]);
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

test('a Verify: line verifies a requirement without a test: no test flag, no untested gap', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const dir = traceProject();
  const p = join(dir, 'specs/billing.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace('### Requirement: Remove an item\n', '### Requirement: Remove an item\nVerify: inspection of the receipt\n'));
  const m = buildTrace(dir, dir);
  const r = m.requirements.get('billing/remove-an-item');
  assert.equal(r?.verify, 'inspection');
  assert.deepEqual(r?.flags, ['no-code-anchor']);
  assert.ok(!r?.statement.includes('Verify'));
});

test('an ID: line names a requirement: a marker may use it (any case), and the go-to-ID list has it', async () => {
  const { readFileSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { requirementIds } = await import('../src/model/traceability.ts');
  const dir = traceProject();
  const p = join(dir, 'specs/billing.md');
  writeFileSync(p, readFileSync(p, 'utf8').replace('### Requirement: Remove an item\n', '### Requirement: Remove an item\nID: billing-7kq3\n'));
  writeFileSync(join(dir, 'src/remove.ts'), '// @spec billing-7KQ3\nexport function remove() {}\n');
  const m = buildTrace(dir, dir);
  const r = m.requirements.get('billing/remove-an-item');
  assert.equal(r?.id, 'BILLING-7KQ3');
  assert.deepEqual(r?.code.map((a) => a.file), ['src/remove.ts']);
  assert.ok(!r?.statement.includes('ID'));
  assert.deepEqual(requirementIds(m).map((x) => [x.id, x.req.key]), [['BILLING-7KQ3', 'billing/remove-an-item']]);
});
