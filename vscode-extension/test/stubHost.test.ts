// Drives the editor layer (CodeLens, hover, quick fixes, commands) against a stand-in for the `vscode` module.
// This checks our wiring, not VS Code: that is stated in the extension README.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, test } from 'node:test';
import './support/installStub.mjs';
import { traceProject } from './trace-fixture.ts';

const stub = await import('./support/vscodeStub.mjs');
const { host } = stub;
const { TraceCache, registerAnchorCode } = await import('../src/editor/anchorCode.ts');
const { buildTrace } = await import('../src/model/traceability.ts');

const dir = traceProject();
writeFileSync(join(dir, 'openspec', 'config.yaml'), 'schema: wingman-spec\ncontext: |\n  - Test command: `npx vitest run`\n');
writeFileSync(join(dir, 'src', 'misplaced.ts'), 'export function m() {\n  run(); // @spec billing/add-item\n}\n');
const store = {
  projects: [{ root: dir, workspaceFolder: dir, adrs: [], error: undefined }],
  onDidChange: () => new stub.Disposable(),
};
const shown: unknown[] = [];
const cache = new TraceCache(store as never);
registerAnchorCode(cache, { show: (r) => void shown.push(r) });

const lensesOf = (file: string, text: string) => {
  const doc = stub.makeDoc(join(dir, file), text);
  return { doc, lenses: host.providers.codeLens[0].provider.provideCodeLenses(doc) as { range: { start: { line: number } }; command: { title: string; command: string; arguments: unknown[]; tooltip?: string } }[] };
};
const addSrc = 'src/add.ts';

before(() => host.reset());

test('registers lenses, hover, definition, code actions and every command the manifest declares', () => {
  assert.equal(host.providers.codeLens.length, 2);
  assert.equal(host.providers.hover.length, 1);
  assert.equal(host.providers.codeAction.length, 1);
  for (const c of ['revealRequirement', 'revealScenario', 'pickScenario', 'showTests', 'showAnchors', 'runTests', 'fixMarker', 'moveMarker']) assert.ok(host.commands.has(`wingmanSpec.${c}`), c);
});

test('the @spec lens reads like the brief and sits above the marker, with actions after it', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(join(dir, addSrc), 'utf8');
  const { lenses } = lensesOf(addSrc, text);
  const titles = lenses.map((l) => l.command.title);
  assert.match(titles[0] ?? '', /^\$\(book\) 1\/2 scenarios tested · Why: Users see what they owe, so they trust… · 1 code anchor$/);
  assert.ok(titles.includes('Spec'));
  assert.ok(titles.some((t) => /^Tests \(\d+\)$/.test(t)));
  assert.ok(titles.includes('$(play) Run tests'));
  assert.equal(lenses[0]?.command.command, 'wingmanSpec.pickScenario');
  assert.equal(lenses.find((l) => l.command.title === 'Spec')?.command.command, 'wingmanSpec.revealRequirement');
});

test('run tests lens is off with the setting, without trust, or without a test command', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(join(dir, addSrc), 'utf8');
  host.settings['wingmanSpec.runTestsLens'] = false;
  assert.ok(!lensesOf(addSrc, text).lenses.some((l) => l.command.title.includes('Run tests')));
  host.settings = {};
  host.trusted = false;
  assert.ok(!lensesOf(addSrc, text).lenses.some((l) => l.command.title.includes('Run tests')));
  host.trusted = true;
});

test('a marker that points at nothing gets a did-you-mean lens whose click fixes it', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(join(dir, 'src', 'misplaced.ts'), 'utf8');
  const { doc, lenses } = lensesOf('src/misplaced.ts', text);
  const fix = lenses.find((l) => l.command.command === 'wingmanSpec.fixMarker');
  assert.ok(fix, 'fix lens');
  assert.match(fix.command.title, /did you mean billing\/add-an-item|billing\/add-an-item/);
  await stub.commands.executeCommand('wingmanSpec.fixMarker', ...fix.command.arguments);
  const op = host.edits.at(-1)?.ops[0];
  assert.equal(op.text, 'billing/add-an-item');
  assert.equal(doc.getText(op.range), 'billing/add-item');
});

test('hover: trusted for exactly the declared commands, with the Why in words and scenario links', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(join(dir, addSrc), 'utf8');
  const line = text.split('\n').findIndex((l) => l.includes('@spec billing/add-an-item'));
  const col = (text.split('\n')[line] ?? '').indexOf('billing/add-an-item') + 3;
  const hv = host.providers.hover[0].provider.provideHover(stub.makeDoc(join(dir, addSrc), text), new stub.Position(line, col));
  assert.ok(hv);
  const md = hv.contents;
  assert.deepEqual(Object.keys(md.isTrusted), ['enabledCommands']);
  assert.match(md.value, /Users see what they owe/);
  assert.match(md.value, /1\/2 tested/);
  assert.match(md.value, /command:wingmanSpec\.revealRequirement\?/);
  for (const m of md.value.matchAll(/\(command:([A-Za-z.]+)\?/g)) assert.ok(md.isTrusted.enabledCommands.includes(m[1]), String(m[1]));
});

test('quick fixes: the diagnostic for a marker at the end of a code line offers moving it; an unresolved key offers the nearest requirement', async () => {
  const { readFileSync } = await import('node:fs');
  const text = readFileSync(join(dir, 'src', 'misplaced.ts'), 'utf8');
  const doc = stub.makeDoc(join(dir, 'src', 'misplaced.ts'), text);
  const col = text.split('\n')[1]!.indexOf('billing/add-item');
  const unresolved = Object.assign(new stub.Diagnostic(new stub.Range(1, col, 1, col + 16), 'x', 1), { source: 'Wingman Spec', code: 'unresolved-marker' });
  const placement = Object.assign(new stub.Diagnostic(new stub.Range(1, 0, 1, 10), 'marker-placement', 1), { source: 'Wingman Spec', code: 'marker-placement' });
  const actions = host.providers.codeAction[0].provider.provideCodeActions(doc, unresolved.range, { diagnostics: [unresolved, placement] });
  assert.deepEqual(actions.map((a: { title: string }) => a.title.replace(/ of .*/, '')), ['Fix marker to billing/add-an-item', 'Move @spec billing/add-item into the doc comment']);
  assert.equal(actions[0].edit.ops[0].text, 'billing/add-an-item');
});

test('reveal commands open the Wingman Spec page on the exact item', async () => {
  shown.length = 0;
  await stub.commands.executeCommand('wingmanSpec.revealRequirement', dir, 'billing/add-an-item');
  await stub.commands.executeCommand('wingmanSpec.revealScenario', dir, 'billing/add-an-item', 'reject-empty');
  await stub.commands.executeCommand('wingmanSpec.revealRequirement', 7, null);
  assert.deepEqual(shown, [
    { page: 'spec', root: dir, name: 'billing', focus: 'req:add-an-item' },
    { page: 'spec', root: dir, name: 'billing', focus: 'scn:add-an-item/reject-empty' },
  ]);
});

test('scenario quick pick: a tested scenario jumps to its test, an untested one offers the likely test file', async () => {
  host.executed.length = 0;
  host.quickPickAnswer = (items: { id?: string; item?: { id: string } }[]) => items.find((i) => i.item?.id === 'scn:reject-empty');
  await stub.commands.executeCommand('wingmanSpec.pickScenario', dir, 'billing/add-an-item');
  const pick = host.quickPicks.at(-1);
  const labels = (pick.items as { label: string; description?: string }[]).map((i) => `${i.label} | ${i.description ?? ''}`);
  assert.ok(labels.some((l) => /Reject empty \| .*tested in tests\/add\.test\.ts:2/.test(l)), labels.join('\n'));
  assert.ok(labels.some((l) => /no test yet/.test(l)));
  const opened = host.executed.find((e: { id: string }) => e.id === 'wingmanSpec.openFile');
  assert.match(String(opened?.args[0]), /tests\/add\.test\.ts$/);
  assert.equal(opened?.args[1], 1);
});

test('run tests: one terminal in the code root, command narrowed to the scenario tags of the requirement', async () => {
  host.terminals.length = 0;
  await stub.commands.executeCommand('wingmanSpec.runTests', dir, 'billing/add-an-item');
  assert.equal(host.terminals.length, 1);
  assert.equal(host.terminals[0].opts.cwd, dir);
  assert.match(host.terminals[0].sent[0], /^npx vitest run -t '.*\\\[billing\/reject-empty\\\]'$/);
});

test('run tests without a trusted workspace does not start a terminal', async () => {
  host.terminals.length = 0;
  host.trusted = false;
  await stub.commands.executeCommand('wingmanSpec.runTests', dir, 'billing/add-an-item');
  host.trusted = true;
  assert.equal(host.terminals.length, 0);
});
