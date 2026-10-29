import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markersIn } from '../src/model/anchors.ts';
import { applyEdits, moveMarkerPlan, replaceKeyEdit } from '../src/model/markerFix.ts';

function moved(text: string, rel: string, line: number): string {
  const plan = moveMarkerPlan(text, rel, line);
  assert.ok(plan, 'a plan');
  return applyEdits(text, plan.edits);
}
const lineOf = (text: string, needle: string): number => text.split('\n').findIndex((l) => l.includes(needle));

test('fix marker: replaces only the key, keeps the rest of the line', () => {
  const text = 'x = 1\n  // @spec billing/add-item, billing/rounding  (why)\n';
  const m = markersIn(text.split('\n')[1] ?? '').find((k) => k.key === 'billing/add-item');
  assert.ok(m);
  const edit = replaceKeyEdit({ line: 1, col: m.col, length: m.length }, 'billing/add-an-item');
  assert.equal(applyEdits(text, [edit]), 'x = 1\n  // @spec billing/add-an-item, billing/rounding  (why)\n');
});

test('move: a trailing marker goes into the doc comment above its function and leaves the code line clean', () => {
  const text = '/** Adds. */\nfunction add() {\n  run(); // @spec billing/add-an-item\n}\n';
  const out = moved(text, 'src/a.ts', 2);
  assert.equal(out, '/**\n * Adds.\n * @spec billing/add-an-item\n */\nfunction add() {\n  run();\n}\n');
});

test('move: a trailing marker with no doc comment gets a one-line doc comment', () => {
  const out = moved('function add() {\n  run(); // @spec billing/add-an-item\n}\n', 'src/a.ts', 1);
  assert.equal(out, '/** @spec billing/add-an-item */\nfunction add() {\n  run();\n}\n');
});

test('move: a marker floating above the code goes to the next function; annotations stay above the doc comment', () => {
  const text = '// @spec billing/rounding\n\n@Get("x")\nexport function round() {}\n';
  const out = moved(text, 'src/a.ts', 0);
  assert.equal(out, '\n/** @spec billing/rounding */\n@Get("x")\nexport function round() {}\n');
});

test('move: an existing JSDoc block gets the tag as a new line; a marker already there is not duplicated', () => {
  const text = '/**\n * Rounds.\n */\nfunction round() {\n  x(); // @spec billing/rounding\n}\n';
  assert.equal(moved(text, 'a.ts', 4), '/**\n * Rounds.\n * @spec billing/rounding\n */\nfunction round() {\n  x();\n}\n');
  const dup = '/**\n * @spec billing/rounding\n */\nfunction round() {\n  x(); // @spec billing/rounding\n}\n';
  assert.equal(moved(dup, 'a.ts', 4), '/**\n * @spec billing/rounding\n */\nfunction round() {\n  x();\n}\n');
});

test('move: several keys on one line move together, deduplicated', () => {
  const out = moved('function f() {\n  g(); // @spec a/b, a/c @spec a/b\n}\n', 'a.ts', 1);
  assert.match(out, /^\/\*\* @spec a\/b, a\/c \*\/\nfunction f\(\) \{\n {2}g\(\);\n\}\n$/);
});

test('move: Python marker goes into the docstring (new, one-line and multi-line)', () => {
  const none = moved('def add():\n    run()  # @spec billing/add-an-item\n', 'a.py', 1);
  assert.equal(none, 'def add():\n    """\n    @spec billing/add-an-item\n    """\n    run()\n');
  const multi = moved('def add():\n    """Adds.\n\n    More.\n    """\n    run()  # @spec billing/add-an-item\n', 'a.py', 5);
  assert.equal(multi, 'def add():\n    """Adds.\n\n    More.\n    @spec billing/add-an-item\n    """\n    run()\n');
  const one = moved('def add():\n    """Adds."""\n    run()  # @spec billing/add-an-item\n', 'a.py', 2);
  assert.equal(one, 'def add():\n    """Adds.\n    @spec billing/add-an-item\n    """\n    run()\n');
});

test('move: Go and Rust use line doc comments; an existing run of them gets one more line', () => {
  assert.equal(moved('// Add adds.\nfunc Add() {\n\trun() // @spec billing/add-an-item\n}\n', 'a.go', 2), '// Add adds.\n// @spec billing/add-an-item\nfunc Add() {\n\trun()\n}\n');
  assert.equal(moved('fn add() {\n    run(); // @spec billing/add-an-item\n}\n', 'a.rs', 1), '// @spec billing/add-an-item\nfn add() {\n    run();\n}\n');
});

test('move: ruby and shell use hash comments', () => {
  assert.equal(moved('def add\n  run # @spec billing/add-an-item\nend\n', 'a.rb', 1), '# @spec billing/add-an-item\ndef add\n  run\nend\n');
});

test('move: no plan when there is no marker or no unit to belong to', () => {
  assert.equal(moveMarkerPlan('x = 1\n', 'a.ts', 0), undefined);
  assert.equal(moveMarkerPlan('const a = 1; // @spec a/b\n', 'a.ts', 0), undefined);
  assert.equal(moveMarkerPlan('x\n', 'a.ts', 9), undefined);
});

test('move twice is a no-op the second time: the result has the marker in the doc comment and nothing trailing', () => {
  const out = moved('function f() {\n  g(); // @spec a/b\n}\n', 'a.ts', 1);
  assert.equal(lineOf(out, '@spec'), 0);
  assert.equal(out.split('\n').filter((l) => l.includes('@spec')).length, 1);
});

test('applyEdits keeps CRLF files CRLF, comments and spacing intact, and a missing final newline missing', () => {
  const text = 'x = 1\r\n\r\n  // @spec billing/add-item   (why)\r\n\ty = 2';
  const m = markersIn('  // @spec billing/add-item   (why)').find((k) => k.key === 'billing/add-item');
  assert.ok(m);
  assert.equal(applyEdits(text, [replaceKeyEdit({ line: 2, col: m.col, length: m.length }, 'billing/add-an-item')]), 'x = 1\r\n\r\n  // @spec billing/add-an-item   (why)\r\n\ty = 2');
  const moved = 'function add() {\r\n  run(); // @spec billing/add-an-item\r\n}\r\n';
  const plan = moveMarkerPlan(moved, 'src/a.ts', 1);
  assert.ok(plan);
  const out = applyEdits(moved, plan.edits);
  assert.ok(!/[^\r]\n/.test(out), 'every line ending is still CRLF');
  assert.ok(out.includes('@spec billing/add-an-item'));
});
