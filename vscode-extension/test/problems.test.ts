import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { applyEdits } from '../src/model/markerFix.ts';
import { addWhyEdit, coveredByLive, diagnosticOf, findingId, fixesFor, groupByFile, tagTitleEdit, testCases } from '../src/model/problems.ts';
import { findingOf, parseGuard, parseProblems, parseSyncCheck } from '../src/model/verifier.ts';
import type { VerifierFinding } from '../src/model/verifier.ts';

const real = parseProblems(readFileSync(new URL('./fixtures/problems.json', import.meta.url), 'utf8'));
const of = (code: string): VerifierFinding => {
  const f = real?.findings.find((x) => x.code === code);
  assert.ok(f, `fixture has ${code}`);
  return f;
};

test('parse: the real verifier output keeps every finding with its position and fix', () => {
  assert.ok(real);
  assert.equal(real.findings.length, 8);
  assert.deepEqual(real.findings.map((f) => f.severity).sort(), ['error', 'error', 'error', 'error', 'error', 'error', 'warning', 'warning']);
  assert.deepEqual(of('misplaced-marker').fix, { kind: 'move-marker' });
  assert.deepEqual(of('untested-requirement').fix?.scenarios, [{ name: 'Removed', id: 'todo/removed' }]);
});

test('parse: malformed JSON, wrong shape and broken entries never throw', () => {
  assert.equal(parseProblems('not json'), undefined);
  assert.equal(parseProblems('{"ok":true}'), undefined);
  const r = parseProblems(JSON.stringify({ ok: false, findings: [null, 3, { source: 'lint' }, { source: 'lint', code: 'x', severity: 'fatal', message: 'm', file: '/a', line: 1 }, { source: 'lint', code: 'x', severity: 'error', message: 'm', file: '/a', line: 0 }, { source: 'lint', code: 'ok', severity: 'info', message: 'm', file: '/a', line: 2, fix: { kind: 'nope' } }], notes: ['n', 4] }));
  assert.deepEqual(r?.findings.map((f) => [f.code, f.line, f.col, f.length, f.fix]), [['ok', 2, 1, 1, undefined]]);
  assert.deepEqual(r?.notes, ['n']);
  assert.deepEqual(parseGuard('x', '/r', 'c'), []);
  assert.deepEqual(parseGuard(JSON.stringify({ level: 'warn', findings: [{ kind: 'changed-anchor', key: 'a/b', file: 'src/x.ts', line: 4, text: 't' }, { kind: 1 }] }), '/r', 'c').map((f) => [f.source, f.code, f.severity, f.file, f.line, f.change]), [['guard', 'changed-anchor', 'warning', '/r/src/x.ts', 4, 'c']]);
  assert.equal(parseSyncCheck(JSON.stringify({ synced: false, problems: ['p'], warnings: [] }))?.ok, false);
  assert.equal(parseSyncCheck('nope'), undefined);
});

test('diagnostic: 1-based finding -> zero-based range, severity kept, hint shown', () => {
  const d = diagnosticOf({ ...of('missing-why'), hint: 'add a Why' });
  assert.deepEqual([d.line, d.col, d.endCol, d.severity, d.code], [2, 0, 28, 'error', 'missing-why']);
  assert.match(d.message, /\nHint: add a Why$/);
  assert.equal(diagnosticOf(of('misplaced-marker')).severity, 'warning');
  const grouped = groupByFile(real!.findings);
  assert.equal(grouped.get('/proj/changes/edit/proposal.md')?.length, 1);
  assert.equal(findingId(of('stale-test-tag')), '/proj/tests/todo.test.js:3:12:stale-test-tag');
});

test('live diagnostics already show orphan anchors, misplaced markers and stale tags: only those are skipped, and only when the code view is on', () => {
  assert.deepEqual(real!.findings.filter((f) => coveredByLive(f, true)).map((f) => f.code).sort(), ['misplaced-marker', 'orphan-anchor', 'stale-test-tag']);
  assert.equal(real!.findings.filter((f) => coveredByLive(f, false)).length, 0);
});

const SPEC = '## ADDED Requirements\n\n### Requirement: Edit a todo\nThe system SHALL let a user edit a todo\nand save it.\n\n#### Scenario: Edited\n- **WHEN** a\n- **THEN** b\n';

test('quick fix add-why: an empty Why line after the statement paragraph, none when it is there already', () => {
  const f = { ...of('missing-why'), line: 3 };
  const acts = fixesFor(f, { text: SPEC, rel: 'x' });
  assert.deepEqual(acts.map((a) => a.title), ['Add a "Why:" line (who wants it, and why)']);
  const out = applyEdits(SPEC, acts[0]!.edits!);
  assert.match(out, /and save it\.\nWhy: \n\n#### Scenario/);
  assert.equal(addWhyEdit(SPEC, 0), undefined);
});

test('quick fix replace-key, move-marker and remove-duplicate produce the exact edits', () => {
  const code = 'const a = 1;\n// @spec todo/eddit-a-todo\nexport function edit() {}\n';
  const replace = fixesFor({ source: 'drift', code: 'orphan-anchor', severity: 'error', message: 'm', file: '/p/a.ts', line: 2, col: 10, length: 17, fix: { kind: 'replace-key', to: 'todo/edit-a-todo' } }, { text: code, rel: 'a.ts' });
  assert.equal(applyEdits(code, replace[0]!.edits!), code.replace('eddit', 'edit'));

  const trailing = 'export function f() { return 1; } // @spec todo/a\n';
  const move = fixesFor({ source: 'drift', code: 'misplaced-marker', severity: 'warning', message: 'm', file: '/p/a.ts', line: 1, col: 38, length: 11, fix: { kind: 'move-marker' } }, { text: trailing, rel: 'a.ts' });
  const moved = applyEdits(trailing, move[0]!.edits!);
  assert.equal(moved, '/** @spec todo/a */\nexport function f() { return 1; }\n');

  const dup = '// @spec todo/a\n// @spec todo/a\nexport function f() {}\n';
  const rm = fixesFor({ source: 'drift', code: 'misplaced-marker', severity: 'warning', message: 'duplicate-marker', file: '/p/a.ts', line: 2, col: 1, length: 5, fix: { kind: 'remove-duplicate' } }, { text: dup, rel: 'a.ts' });
  assert.equal(applyEdits(dup, rm[0]!.edits!), '// @spec todo/a\nexport function f() {}\n');
});

test('quick fix accept and add-test-tag are commands (they need a prompt); a finding without a fix has none', () => {
  const d = fixesFor(of('unanchored-requirement'), { text: '', rel: '' });
  assert.deepEqual(d[0]?.command, { id: 'wingmanSpec.acceptGap', args: ['/proj/specs/todo.md', of('unanchored-requirement').key] });
  const t = fixesFor(of('untested-requirement'), { text: '', rel: '' });
  assert.equal(t[0]?.command?.id, 'wingmanSpec.tagTest');
  assert.deepEqual(fixesFor(of('edge-cases'), { text: '', rel: '' }), []);
});

test('test titles: found in it/test calls, tagged once, never twice', () => {
  const text = "describe('x', () => {\n  it('adds [todo/added]', () => {});\n  test.skip(\"removes it\", () => {});\n  it(`edits ${1}`, () => {});\n});\n";
  assert.deepEqual(testCases(text).map((c) => [c.line, c.title]), [[1, 'adds [todo/added]'], [2, 'removes it'], [3, 'edits ${1}']]);
  assert.equal(applyEdits(text, [tagTitleEdit(text, 2, 'todo/removed')!]).split('\n')[2], '  test.skip("removes it [todo/removed]", () => {});');
  assert.equal(tagTitleEdit(text, 1, 'todo/added'), undefined);
  assert.equal(tagTitleEdit(text, 0, 'a/b'), undefined);
});

// Over-anchored markers are found by the CLI (`wingman-spec problems`, covered by tests/anchorfit.sh); the editor shows the
// finding in the Problems panel and offers its remove-marker fix.
test('over-anchored: the CLI finding with fix remove-marker is accepted, shown once, and its quick fix removes the marker line only', () => {
  const EN = "export const messages = {\n  'cart.title': 'Your cart',\n  // @spec auth/user-login\n  'login.error': 'Wrong email or password',\n};\n";
  const f = findingOf({ source: 'drift', code: 'over-anchored', severity: 'warning', message: 'm', file: '/p/en.js', line: 3, col: 3, length: 20, fix: { kind: 'remove-marker', key: 'auth/user-login' } });
  assert.ok(f);
  assert.equal(f.fix?.kind, 'remove-marker');
  assert.equal(coveredByLive(f, true), false, 'the code view no longer computes it, so the panel lists it');
  const fx = fixesFor(f, { text: EN, rel: 'src/checkout/lang/en.js' });
  assert.equal(fx.length, 1);
  assert.equal(applyEdits(EN, fx[0]!.edits!), EN.replace('  // @spec auth/user-login\n', ''));
  const multi = '// @spec auth/user-login, checkout/order-summary\nconst a = 1;\n';
  assert.ok(fixesFor({ ...f, line: 1 }, { text: multi, rel: 'a.js' })[0]?.edits, 'a marker line with several keys still offers an edit');
});
