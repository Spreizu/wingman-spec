import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const src = (f: string): string => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

test('manifest declares the code-view setting (default on), the Explorer view and the anchors command', () => {
  assert.equal(pkg.name, 'wingman-spec');
  assert.equal(pkg.displayName, 'Wingman Spec');
  assert.equal(pkg.contributes.configuration.properties['wingmanSpec.codeView'].default, true);
  assert.deepEqual(pkg.contributes.views.explorer.map((v: { id: string }) => v.id), ['wingmanSpec.traceability']);
  assert.ok(pkg.contributes.commands.some((c: { command: string }) => c.command === 'wingmanSpec.showAnchors'));
});

test('the ids the manifest declares are the ones the code registers and reads', () => {
  assert.match(src('views/traceView.ts'), /registerTreeDataProvider\('wingmanSpec\.traceability'/);
  assert.match(src('editor/anchorCommands.ts'), /registerCommand\('wingmanSpec\.showAnchors'/);
  assert.match(src('editor/anchorCode.ts'), /const SETTING = 'codeView'/);
  assert.match(src('extension.ts'), /registerAnchorCode\(traceCache, panel\)/);
});

test('every command the manifest declares is registered in the code, and every registered one is declared', () => {
  const declared = new Set<string>(pkg.contributes.commands.map((c: { command: string }) => c.command));
  const files = ['extension.ts', 'commands/scaffold.ts', 'editor/anchorCommands.ts', 'editor/anchorCode.ts', 'editor/problems.ts', 'views/traceView.ts'];
  const registered = new Set<string>();
  for (const f of files) for (const m of src(f).matchAll(/registerCommand\(\s*'(wingmanSpec\.[A-Za-z]+)'/g)) registered.add(m[1] ?? '');
  for (const d of declared) assert.ok(registered.has(d), `${d} is declared but not registered`);
  for (const r of registered) assert.ok(declared.has(r), `${r} is registered but not declared`);
});

test('the run-tests setting is declared and defaults to on', () => {
  assert.equal(pkg.contributes.configuration.properties['wingmanSpec.runTestsLens'].default, true);
  assert.match(src('editor/anchorCode.ts'), /const SETTING_RUN = 'runTestsLens'/);
});

test('the tree gets the secondary "Open spec.md" action only on items that open the Wingman Spec UI', () => {
  const ctx = pkg.contributes.menus['view/item/context'];
  assert.equal(ctx.length, 1);
  assert.match(ctx[0].when, /viewItem == wingmanSpec\.revealable/);
  assert.match(src('views/traceView.ts'), /contextValue = 'wingmanSpec\.revealable'/);
});

test('every provider of the code view is switched off by the setting', () => {
  const s = src('editor/anchorCode.ts');
  for (const name of ['provideCodeLenses', 'provideHover', 'provideDefinition']) {
    const body = s.slice(s.indexOf(name));
    assert.ok(/if \(!enabled\(\)/.test(body.slice(0, 200)), name);
  }
  assert.match(s, /const hit = enabled\(\) \? cache\.forFile/);
});
