// The Problems panel against the vscode stand-in with a fake verifier process: the diagnostics, the quick fixes and the commands.
// This checks our wiring (what we publish, which edits we offer, what we run), not VS Code itself.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { before, test } from 'node:test';
import './support/installStub.mjs';
import { traceProject } from './trace-fixture.ts';

const stub = await import('./support/vscodeStub.mjs');
const { host } = stub;
const { TraceCache } = await import('../src/editor/anchorCode.ts');
const { registerProblems } = await import('../src/editor/problems.ts');
const { VerifierClient } = await import('../src/editor/verifier.ts');

const dir = traceProject();
const put = (f: string, text: string): void => {
  mkdirSync(dirname(join(dir, f)), { recursive: true });
  writeFileSync(join(dir, f), text);
};
put('openspec/scripts/verify-task.cjs', '// stand-in: the real script is never run in this test\n');
put('openspec/changes/edit/proposal.md', '## Why\nEdit a todo.\n');
const SPEC = '## ADDED Requirements\n\n### Requirement: Edit a todo\nThe system SHALL let a user edit a todo.\n\n#### Scenario: Edited\n- **WHEN** a\n- **THEN** b\n';
put('openspec/changes/edit/specs/todo/spec.md', SPEC);

const fixture = readFileSync(new URL('./fixtures/problems.json', import.meta.url), 'utf8').split('/proj').join(dir);
const calls: { cmd: string; args: string[]; cwd: string; timeoutMs: number }[] = [];
let reply: { code: number | null; stdout: string; stderr: string; timedOut: boolean; spawnError?: string } = { code: 0, stdout: fixture, stderr: '', timedOut: false };
const runner = async (cmd: string, args: string[], o: { cwd: string; timeoutMs: number }) => {
  calls.push({ cmd, args, ...o });
  return reply;
};
const store = { projects: [{ root: dir, workspaceFolder: dir, adrs: [], error: undefined }], onDidChange: () => new stub.Disposable() };
const cache = new TraceCache(store as never);
const { service } = registerProblems(store as never, cache, new VerifierClient(runner));
const diag = () => host.collections.get('wingman-spec-problems');
const entries = () => [...diag().map.values()].flat() as { range: { start: { line: number; character: number }; end: { character: number } }; message: string; severity: number; source: string; code: string }[];

before(() => {
  host.reset();
  calls.length = 0;
});

test('refresh asks the verifier once per project with a timeout and the project root, and publishes by file', async () => {
  await service.refresh();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args, [join(dir, 'openspec/scripts/verify-task.cjs'), 'problems', '--json', '--root', dir]);
  assert.equal(calls[0]?.cwd, dir);
  assert.equal(calls[0]?.timeoutMs, 30000);
  // 8 findings; orphan anchor, misplaced marker and stale tag are the live anchor diagnostics' job while the code view is on
  assert.equal(entries().length, 5);
  assert.deepEqual([service.summary.error, service.summary.warning], [4, 1]);
  const orphan = entries().find((d) => d.code === 'missing-why');
  assert.deepEqual([orphan?.range.start.line, orphan?.range.start.character, orphan?.range.end.character, orphan?.severity, orphan?.source], [2, 0, 28, 0, 'Wingman Spec (verifier)']);
  assert.ok(diag().get(stub.Uri.file(join(dir, 'openspec/specs/todo/spec.md'))).length === 2);
});

test('with the code view off the verifier shows every finding', async () => {
  host.settings['wingmanSpec.codeView'] = false;
  await service.refresh();
  assert.equal(entries().length, 8);
  assert.equal(entries().filter((d) => d.severity === 1).length, 2);
  host.reset();
});

test('quick fix: an empty Why line, as an exact edit at the requirement', async () => {
  await service.refresh();
  const file = join(dir, 'openspec/changes/edit/specs/todo/spec.md');
  const doc = stub.makeDoc(file, SPEC);
  const d = diag().get(stub.Uri.file(file))[0];
  const actions = host.providers.codeAction.at(-1).provider.provideCodeActions(doc, d.range, { diagnostics: [d] }) as { title: string; isPreferred?: boolean; edit: { ops: { op: string; range: { start: { line: number; character: number } }; text: string }[] } }[];
  assert.deepEqual(actions.map((a) => a.title), ['Add a "Why:" line (who wants it, and why)']);
  assert.equal(actions[0]?.isPreferred, true);
  const op = actions[0]?.edit.ops[0];
  assert.deepEqual([op?.range.start.line, op?.text], [3, '\nWhy: ']);
  assert.deepEqual(host.providers.codeAction.at(-1).provider.provideCodeActions(doc, d.range, { diagnostics: [{ ...d, source: 'other' }] }), []);
});

test('accept gap: asks for a note, runs `drift decide` with it, then refreshes; an empty note does nothing', async () => {
  await service.refresh();
  const file = join(dir, 'openspec/specs/todo/spec.md');
  const d = diag().get(stub.Uri.file(file)).find((x: { code: string }) => x.code === 'unanchored-requirement');
  const action = host.providers.codeAction.at(-1).provider.provideCodeActions(stub.makeDoc(file, ''), d.range, { diagnostics: [d] })[0];
  assert.equal(action.command.command, 'wingmanSpec.acceptGap');
  const before = calls.length;
  host.inputAnswer = '   ';
  await host.commands.get('wingmanSpec.acceptGap')(...action.command.arguments);
  assert.equal(calls.length, before);
  host.inputAnswer = 'covered by the e2e suite';
  await host.commands.get('wingmanSpec.acceptGap')(...action.command.arguments);
  const decide = calls.find((c) => c.args.includes('decide'));
  assert.deepEqual(decide?.args.slice(1), ['drift', 'decide', action.command.arguments[1], '--accept', '--note', 'covered by the e2e suite', '--root', dir]);
  assert.ok(calls.length >= before + 2, 'a refresh follows the acceptance');
  assert.match(host.messages.at(-1) ?? '', /accepted /);
});

test('a refused acceptance is reported, not swallowed', async () => {
  host.reset();
  reply = { code: 2, stdout: '', stderr: 'no such gap\n', timedOut: false };
  host.inputAnswer = 'x';
  await host.commands.get('wingmanSpec.acceptGap')(join(dir, 'openspec/specs/todo/spec.md'), 'untested-requirement:a/b');
  assert.match(host.messages.at(-1) ?? '', /was not accepted: no such gap/);
  reply = { code: 0, stdout: fixture, stderr: '', timedOut: false };
});

test('tag a test: pick the test case, the edit appends the scenario tag to its title', async () => {
  host.reset();
  const key = 'billing/add-an-item';
  const testFile = join(dir, 'tests/add.test.ts');
  host.quickPickAnswer = (items: { line?: number; label: string }[]) => items.find((i) => i.line === 1) ?? items[0];
  await host.commands.get('wingmanSpec.tagTest')(join(dir, 'openspec/specs/billing/spec.md'), key, [{ name: 'Add and see it', id: 'billing/add-and-see-it' }]);
  assert.equal(host.edits.length, 1);
  const op = host.edits[0].ops[0];
  assert.equal(op.uri.fsPath, testFile);
  assert.equal(op.text, ' [billing/add-and-see-it]');
  assert.equal(op.range.start.line, 1);
});

test('setting off clears everything and says so on a manual refresh; no trust means the script is never run', async () => {
  host.reset();
  host.settings['wingmanSpec.problemsPanel'] = false;
  await host.commands.get('wingmanSpec.refreshProblems')();
  assert.equal(entries().length, 0);
  assert.match(host.messages.at(-1) ?? '', /switched off/);
  host.reset();
  host.trusted = false;
  calls.length = 0;
  await host.commands.get('wingmanSpec.refreshProblems')();
  assert.equal(calls.length, 0);
  assert.match(host.messages.at(-1) ?? '', /not trusted/);
});

test('a verifier that cannot start or times out is a message, never a thrown error, and keeps the panel empty', async () => {
  host.reset();
  reply = { code: null, stdout: '', stderr: '', timedOut: false, spawnError: 'spawn node ENOENT' };
  await host.commands.get('wingmanSpec.refreshProblems')();
  assert.match(host.messages.at(-1) ?? '', /could not start `node`/);
  reply = { code: null, stdout: '', stderr: '', timedOut: true };
  await host.commands.get('wingmanSpec.refreshProblems')();
  assert.match(host.messages.at(-1) ?? '', /did not answer within 30s/);
  reply = { code: 0, stdout: 'garbage', stderr: '', timedOut: false };
  await host.commands.get('wingmanSpec.refreshProblems')();
  assert.match(host.messages.at(-1) ?? '', /not understood/);
  assert.equal(entries().length, 0);
  reply = { code: 0, stdout: fixture, stderr: '', timedOut: false };
});

test('saving a file of the project schedules a refresh; a file outside it does not', async () => {
  host.reset();
  calls.length = 0;
  const save = host.handlers.save.at(-1);
  save({ uri: stub.Uri.file('/elsewhere/x.ts') });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(calls.length, 0);
  service.schedule(1);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(calls.length, 1);
});
