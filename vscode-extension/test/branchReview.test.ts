import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewBranch, anchorMoves, changedRequirements } from '../src/model/branchReview.ts';
import type { ChangedFile } from '../src/model/branchReview.ts';
import { applyNumstat, chooseBase, parseNameStatus } from '../src/model/gitDiff.ts';
import { buildTrace } from '../src/model/traceability.ts';
import type { VerifierFinding } from '../src/model/verifier.ts';
import { traceProject } from './trace-fixture.ts';

const dir = traceProject();
const model = buildTrace(dir, dir);
const fn = (key: string, name: string, body: string): string => `// @spec ${key}\nexport function ${name}(a) {\n  ${body}\n}\n`;
const file = (path: string, status: ChangedFile['status'], oldText: string | undefined, newText: string | undefined, from = path): ChangedFile => ({ path, from, status, added: 1, removed: 1, ...(oldText !== undefined ? { oldText } : {}), ...(newText !== undefined ? { newText } : {}) });
const base = { root: dir, codeRoot: dir, branch: 'feature/x', base: 'origin/main', mergeBase: 'abc123', model, findings: [] as VerifierFinding[] };

test('git: name-status with renames, numstat with braces, base choice', () => {
  const files = parseNameStatus('M\tsrc/a.ts\nA\tsrc/b.ts\nD\tsrc/c.ts\nR087\tsrc/old.ts\tsrc/new.ts\n\n');
  assert.deepEqual(files.map((f) => [f.status, f.path, f.from]), [['M', 'src/a.ts', 'src/a.ts'], ['A', 'src/b.ts', 'src/b.ts'], ['D', 'src/c.ts', 'src/c.ts'], ['R', 'src/new.ts', 'src/old.ts']]);
  applyNumstat(files, '3\t1\tsrc/a.ts\n10\t0\tsrc/b.ts\n-\t-\tsrc/c.ts\n1\t1\tsrc/{old.ts => new.ts}\n');
  assert.deepEqual(files.map((f) => [f.added, f.removed]), [[3, 1], [10, 0], [0, 0], [1, 1]]);
  assert.equal(chooseBase('', (r) => r === 'main'), 'main');
  assert.equal(chooseBase('release', (r) => r === 'origin/main' || r === 'main'), 'origin/main');
  assert.equal(chooseBase('release', (r) => r === 'release'), 'release');
  assert.equal(chooseBase('', () => false), undefined);
});

test('anchors: a changed body is "changed", a new marker "added", a deleted file "removed"', () => {
  const moves = anchorMoves(
    [
      file('src/add.ts', 'M', fn('billing/add-an-item', 'add', 'return a;'), fn('billing/add-an-item', 'add', 'return a + 1;')),
      file('src/new.ts', 'A', undefined, fn('billing/brand-new', 'fresh', 'return 1;')),
      file('src/gone.ts', 'D', fn('billing/rounding', 'round', 'return 2;'), undefined),
    ],
    (k) => model.requirements.has(k),
  );
  assert.deepEqual(moves.map((m) => [m.change, m.key, m.file, m.resolves]), [
    ['removed', 'billing/rounding', 'src/gone.ts', true],
    ['changed', 'billing/add-an-item', 'src/add.ts', true],
    ['added', 'billing/brand-new', 'src/new.ts', false],
  ]);
});

test('anchors: the same unit removed here and added there is one "moved"; a pure rename of the file is nothing', () => {
  const text = fn('billing/rounding', 'round', 'return Math.round(a);');
  const moved = anchorMoves([file('src/a.ts', 'M', text, 'export const x = 1;\n'), file('src/b.ts', 'M', 'export const y = 2;\n', text)], () => true);
  assert.equal(moved.length, 1);
  assert.deepEqual([moved[0]?.change, moved[0]?.file, moved[0]?.from?.file], ['moved', 'src/b.ts', 'src/a.ts']);
  assert.deepEqual(anchorMoves([file('src/new.ts', 'R', text, text, 'src/old.ts')], () => true), []);
});

test('anchors: a renamed function that keeps its marker is "renamed"; test files are flagged', () => {
  const moves = anchorMoves([file('tests/t.test.ts', 'M', fn('billing/add-an-item', 'one', 'return 1;'), fn('billing/add-an-item', 'two', 'return 1;'))], () => true);
  assert.deepEqual(moves.map((m) => [m.change, m.test]), [['renamed', true]]);
});

test('review: touched requirements by code, test tag, spec change and removal; untested ones are listed', () => {
  const specBefore = 'blah\n';
  const livingNow = '## Requirements\n\n### Requirement: Remove an item\nThe system SHALL remove an item, quietly.\nWhy: Users can remove a mistake before they pay.\n\n#### Scenario: Remove it\n- **WHEN** a\n- **THEN** b\n';
  const livingBefore = livingNow.replace(', quietly', '');
  const r = reviewBranch({
    ...base,
    files: [
      file('src/add.ts', 'M', fn('billing/add-an-item', 'add', 'return a;'), fn('billing/add-an-item', 'add', 'return a + 1;')),
      file('tests/add.test.ts', 'M', "it('refuses [billing/reject-empty]', () => {});\n", "it('refuses [billing/reject-empty]', () => {});\nit('x [billing/remove-it]', () => {});\n"),
      file('specs/billing.md', 'M', livingBefore, livingNow),
      file('README.md', 'M', specBefore, 'x\n'),
    ],
  });
  assert.deepEqual(r.requirements.map((q) => [q.key, q.via]), [
    ['billing/add-an-item', ['code']],
    ['billing/remove-an-item', ['test', 'spec']],
  ]);
  assert.deepEqual(r.untested.map((q) => q.key), ['billing/add-an-item', 'billing/remove-an-item']);
  assert.equal(r.files, 4);
  assert.deepEqual(r.requirements.map((q) => q.why), ['Users see what they owe, so they trust the app.', 'Users can remove a mistake before they pay.']);
});

test('review: findings are filtered to the diff', () => {
  const findings: VerifierFinding[] = [
    { source: 'drift', code: 'orphan-anchor', severity: 'error', message: 'in diff', file: `${dir}/src/add.ts`, line: 1, col: 1, length: 1 },
    { source: 'drift', code: 'orphan-anchor', severity: 'error', message: 'elsewhere', file: `${dir}/src/other.ts`, line: 1, col: 1, length: 1 },
    { source: 'lint', code: 'x', severity: 'warning', message: 'change in diff', file: `${dir}/changes/refunds/tasks.md`, line: 2, col: 1, length: 1, change: 'refunds' },
  ];
  const r = reviewBranch({
    ...base,
    findings,
    files: [
      file('src/add.ts', 'M', 'a\n', 'b\n'),
      file('changes/refunds/proposal.md', 'M', 'a\n', 'b\n'),
    ],
  });
  assert.deepEqual(r.findings.map((f) => f.message), ['in diff', 'change in diff']);
});

test('spec diff helpers: added / changed / removed requirements', () => {
  const a = '## Requirements\n\n### Requirement: One\nThe system SHALL one.\n\n### Requirement: Two\nThe system SHALL two.\n';
  const b = '## Requirements\n\n### Requirement: One\nThe system SHALL one more.\n\n### Requirement: Three\nThe system SHALL three.\n';
  assert.deepEqual(changedRequirements('cap', a, b).map((c) => [c.key, c.kind]), [['cap/one', 'changed'], ['cap/three', 'added'], ['cap/two', 'removed']]);
  assert.deepEqual(changedRequirements('cap', undefined, a).map((c) => c.kind), ['added', 'added']);
});
