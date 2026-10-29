import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchorProblems, resolve, reverseTitle } from '../src/model/anchorView.ts';
import { buildTrace } from '../src/model/traceability.ts';
import { traceProject } from './trace-fixture.ts';

const dir = traceProject();
const model = buildTrace(dir, dir);

test('resolve: markers go to requirements, tags to scenarios', () => {
  assert.equal(resolve(model, 'marker', 'billing/rounding')?.requirement.name, 'Rounding');
  assert.equal(resolve(model, 'marker', 'billing/nope'), undefined);
  const t = resolve(model, 'tag', 'billing/reject-empty');
  assert.equal(t?.requirement.key, 'billing/add-an-item');
  assert.equal(t?.kind === 'tag' && t.scenario.name, 'Reject empty');
  assert.equal(resolve(model, 'tag', 'billing/missing'), undefined);
});

test('the reverse title counts code and test anchors', () => {
  const r = model.requirements.get('billing/add-an-item');
  assert.ok(r);
  assert.equal(reverseTitle(r), '1 code anchor · 2 test anchors');
  const none = model.requirements.get('billing/remove-an-item');
  assert.ok(none);
  assert.equal(reverseTitle(none), 'no anchors yet');
});

test('diagnostics: unresolved markers (with a hint) and unresolved tags of known capabilities only', () => {
  const add = anchorProblems({ ...model, placement: 'off' }, 'src/add.ts', '// @spec billing/add-an-item\n// @spec billing/add-item\n');
  assert.equal(add.length, 1);
  assert.equal(add[0]?.line, 1);
  assert.equal(add[0]?.code, 'unresolved-marker');
  assert.match(add[0]?.message ?? '', /did you mean billing\/add-an-item/);
  const line = '// @spec billing/add-item';
  assert.equal(line.slice(add[0]?.col, (add[0]?.col ?? 0) + (add[0]?.length ?? 0)), 'billing/add-item');

  const tests = anchorProblems(model, 'tests/a.test.ts', "it('a [billing/reject-empty] [billing/gone] [shipping/x]')\n");
  assert.deepEqual(tests.map((p) => p.code), ['unresolved-tag']);
  assert.match(tests[0]?.message ?? '', /billing\/gone/);
});

test('diagnostics: tags are only judged in test files; markdown, openspec and vendored files are skipped; no specs, no noise', () => {
  assert.deepEqual(anchorProblems(model, 'src/a.ts', "x = '[billing/gone]'"), []);
  assert.deepEqual(anchorProblems(model, 'docs/a.md', '<!-- @spec billing/zzz -->'), []);
  assert.deepEqual(anchorProblems(model, 'node_modules/p/a.js', '// @spec billing/zzz'), []);
  assert.deepEqual(anchorProblems({ ...model, requirements: new Map() }, 'src/a.ts', '// @spec billing/zzz'), []);
});

test('placement: a marker at the end of a code line is flagged; one above its lines is not; the level comes from the config', () => {
  const bad = 'function a() {\n  run(); // @spec billing/rounding\n}\nfunction b() {}\n';
  const good = 'function a() {\n  // @spec billing/rounding\n  run();\n}\nfunction b() {}\n';
  const found = anchorProblems(model, 'src/a.ts', bad).filter((p) => p.code === 'marker-placement');
  assert.equal(found.length, 1);
  assert.equal(found[0]?.line, 1);
  assert.match(found[0]?.message ?? '', /^trailing-marker/);
  assert.equal(found[0]?.severity, undefined);
  assert.equal(anchorProblems(model, 'src/a.ts', good).filter((p) => p.code === 'marker-placement').length, 0);
  assert.equal(anchorProblems({ ...model, placement: 'error' }, 'src/a.ts', bad).find((p) => p.code === 'marker-placement')?.severity, 'error');
  assert.equal(anchorProblems({ ...model, placement: 'off' }, 'src/a.ts', bad).filter((p) => p.code === 'marker-placement').length, 0);
});
