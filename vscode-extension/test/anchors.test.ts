import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { isScannable, isTestPath, itemAt, markersIn, nearest, scanCode, slug, tagsIn } from '../src/model/anchors.ts';

test('slug matches the verifier rule', () => {
  assert.equal(slug('Add an Item!'), 'add-an-item');
  assert.equal(slug('  --Two  words-- '), 'two-words');
  assert.equal(slug('!!!'), 'scenario');
});

test('markers are found behind every comment leader the verifier knows', () => {
  const leaders = ['// ', '# ', '/* ', ' * ', '-- ', '; ', '<!-- ', '% ', '{# ', '""" ', "''' "];
  for (const l of leaders) {
    const m = markersIn(`code\n${l}@spec billing/add-item`);
    assert.equal(m.length, 1, `leader ${JSON.stringify(l)}`);
    assert.equal(m[0]?.key, 'billing/add-item');
    assert.equal(m[0]?.line, 1);
  }
});

test('a marker reports the column range of its key, and a comment may list several keys', () => {
  const [a, b, c] = markersIn('  // @spec billing/add-item, billing/remove-item; ui/list');
  assert.deepEqual([a?.key, b?.key, c?.key], ['billing/add-item', 'billing/remove-item', 'ui/list']);
  assert.equal('  // @spec billing/add-item, billing/remove-item; ui/list'.slice(a?.col, (a?.col ?? 0) + (a?.length ?? 0)), 'billing/add-item');
  assert.equal('  // @spec billing/add-item, billing/remove-item; ui/list'.slice(c?.col, (c?.col ?? 0) + (c?.length ?? 0)), 'ui/list');
});

test('text that only mentions @spec without a comment leader or a key is ignored', () => {
  assert.deepEqual(markersIn('const s = "@spec billing/x"'), []);
  assert.deepEqual(markersIn('// @spec'), []);
  assert.deepEqual(markersIn('// @spec Billing/Add'), []);
});

test('test tags are found inside titles', () => {
  const [t] = tagsIn("it('adds [billing/add-an-item] to the list', () => {})");
  assert.equal(t?.tag, 'billing/add-an-item');
  assert.equal("it('adds [billing/add-an-item] to".slice(t?.col, (t?.col ?? 0) + (t?.length ?? 0)), 'billing/add-an-item');
  assert.deepEqual(tagsIn('arr[i]; x[a b/c]'), []);
});

test('test paths and scannable paths follow the verifier', () => {
  for (const f of ['tests/a.js', 'src/__tests__/a.ts', 'a.test.ts', 'a.spec.mjs', 'test_a.py', 'a_test.go', 'x/spec/y.rb']) assert.ok(isTestPath(f), f);
  for (const f of ['src/a.ts', 'src/contest.ts', 'a.ts']) assert.ok(!isTestPath(f), f);
  for (const f of ['src/a.ts', 'lib/x.py']) assert.ok(isScannable(f), f);
  for (const f of ['README.md', 'node_modules/x/a.js', 'openspec/specs/a/spec.md', 'dist/a.js', 'logo.png', 'a.min.js', '.claude/commands/x.sh']) assert.ok(!isScannable(f), f);
});

test('nearest suggests a requirement of the same capability by word overlap', () => {
  const keys = ['billing/add-an-item', 'billing/remove-item', 'ui/add-an-item'];
  assert.equal(nearest('billing/add-item', keys), 'billing/add-an-item');
  assert.equal(nearest('billing/zzz', keys), undefined);
  assert.equal(nearest('shipping/add-an-item', keys), undefined);
});

test('itemAt finds the marker or tag under the cursor', () => {
  const text = 'a\n  // @spec billing/add-item\nb';
  assert.equal(itemAt(text, 1, 12, false)?.key, 'billing/add-item');
  assert.equal(itemAt(text, 1, 2, false), undefined);
  assert.equal(itemAt(text, 0, 0, false), undefined);
  const t = "it('x [billing/add] y')";
  assert.equal(itemAt(t, 0, 8, true)?.kind, 'tag');
  assert.equal(itemAt(t, 0, 8, false), undefined);
});

test('scanCode walks the tree with the verifier skip rules', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wsx-scan-'));
  const put = (f: string, text: string): void => {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  };
  put('src/a.ts', '// @spec billing/add-item\n');
  put('src/b.py', '# @spec billing/add-item, ui/list\n');
  put('tests/a.test.ts', "// @spec billing/add-item\nit('x [billing/add-item]', () => {})\n");
  put('node_modules/x/i.js', '// @spec billing/add-item\n');
  put('docs/a.md', '<!-- @spec billing/add-item -->\n');
  put('openspec/specs/billing/spec.md', '// @spec billing/add-item\n');
  put('src/bin.dat', '// @spec billing/add-item\0');
  put('src/plain.ts', 'nothing here\n');
  const files = scanCode(dir).sort((a, b) => a.file.localeCompare(b.file));
  assert.deepEqual(files.map((f) => f.file), ['src/a.ts', 'src/b.py', 'tests/a.test.ts']);
  assert.equal(files[1]?.markers.length, 2);
  assert.ok(files[2]?.test);
  assert.equal(files[2]?.tags[0]?.tag, 'billing/add-item');
});
