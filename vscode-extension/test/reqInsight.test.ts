import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { HOVER_COMMANDS, commandLink, hoverInsight, hoverUnresolved } from '../src/model/hoverText.ts';
import { adrsMentioning, filteredTestCommand, insightOf, lensText, planTest, readTestCommand, scenarioMenu, testCandidates, testStub, unresolvedInfo, unresolvedLensText } from '../src/model/reqInsight.ts';
import type { ReqInsight } from '../src/model/reqInsight.ts';
import { revealRoute } from '../src/model/reveal.ts';
import { buildTrace } from '../src/model/traceability.ts';
import type { RootAdr } from '../src/model/types.ts';
import { traceProject } from './trace-fixture.ts';

const dir = traceProject();
const put = (f: string, text: string): void => {
  mkdirSync(dirname(join(dir, f)), { recursive: true });
  writeFileSync(join(dir, f), text);
};
// a pending change that amends one requirement, one that removes another, one that renames a third
put('changes/tweak/proposal.md', '## Why\nx\n\n## What Changes\n- x\n');
put('changes/tweak/specs/billing.md', '## MODIFIED Requirements\n\n### Requirement: Remove an item\nThe system SHALL remove an item, with an undo.\nWhy: Users can remove a mistake before they pay.\n\n#### Scenario: Remove it\n- **WHEN** a\n- **THEN** b\n\n## REMOVED Requirements\n\n### Requirement: Legacy thing\n\n## RENAMED Requirements\n\n- Rounding -> Round to cents\n');
const adr = (number: string, title: string, body: string): RootAdr => ({ number, slug: title, path: join(dir, 'adr', `${number}-x.md`), title, status: 'accepted', date: '', change: '', source: '', supersedes: '', body, fields: {} });

const model = buildTrace(dir, dir);
const adrs = [adr('0003', 'Cents only', 'We store money as cents.\nSee billing/add-an-item for the rule.\n'), adr('0004', 'Unrelated', 'Nothing here.')];

test('insight: 1/2 scenarios tested, its Why, one code anchor, ADR by key', () => {
  const i = insightOf(model, 'billing/add-an-item', adrs);
  assert.ok(i);
  assert.equal(i.scenarios.length, 2);
  assert.equal(i.testedCount, 1);
  assert.deepEqual(i.scenarios.map((s) => [s.slug, s.tested]), [['add-and-see-it', false], ['reject-empty', true]]);
  assert.equal(i.scenarios[1]?.tests[0]?.file, 'tests/add.test.ts');
  assert.equal(i.why, 'Users see what they owe, so they trust the app.');
  assert.equal(i.code.length, 1);
  assert.deepEqual(i.adrs.map((a) => [a.number, a.line]), [['0003', 1]]);
  assert.equal(lensText(i), '1/2 scenarios tested · Why: Users see what they owe, so they trust… · 1 code anchor');
});

test('lens text: the exact shape from the brief, a warning sign only when something needs attention', () => {
  const base = insightOf(model, 'billing/add-an-item');
  assert.ok(base);
  const three: ReqInsight = { ...base, scenarios: [1, 2, 3, 4].map((n) => ({ name: `s${n}`, slug: `s${n}`, line: n, steps: [], tested: n < 4, tests: [] })), testedCount: 3, why: 'Staff want it.', code: [base.code[0]!, base.code[0]!], warnings: [] };
  assert.equal(lensText(three), '3/4 scenarios tested · Why: Staff want it. · 2 code anchors');
  assert.equal(lensText({ ...three, warnings: [{ code: 'amended-pending', text: 'x' }] }), '$(warning) 3/4 scenarios tested · Why: Staff want it. · 2 code anchors');
  const none = insightOf(model, 'billing/legacy-thing');
  assert.match(lensText(none!), /no Why/);
});

test('warnings: amended, removed and renamed by pending changes; no Why; nothing tested; sprawl', () => {
  assert.ok(insightOf(model, 'billing/remove-an-item')?.warnings.some((w) => w.code === 'amended-pending' && /tweak/.test(w.text)));
  assert.ok(insightOf(model, 'billing/legacy-thing')?.warnings.some((w) => w.code === 'removed-pending'));
  assert.ok(insightOf(model, 'billing/legacy-thing')?.warnings.some((w) => w.code === 'no-why'));
  assert.match(insightOf(model, 'billing/rounding')?.warnings.find((w) => w.code === 'renamed-pending')?.text ?? '', /renamed to "Round to cents" by pending change tweak/);
  assert.ok(insightOf(model, 'billing/remove-an-item')?.warnings.some((w) => w.code === 'none-tested'));
  const spread = { ...model.requirements.get('billing/rounding')!, code: Array.from({ length: 7 }, (_, n) => ({ file: `src/f${n % 4}.ts`, line: n, kind: 'marker' as const })) };
  const m2 = { ...model, requirements: new Map(model.requirements).set('billing/rounding', spread) };
  assert.ok(insightOf(m2, 'billing/rounding')?.warnings.some((w) => w.code === 'sprawl'));
  const few = { ...spread, code: spread.code.slice(0, 4) };
  assert.ok(!insightOf({ ...model, requirements: new Map(model.requirements).set('billing/rounding', few) }, 'billing/rounding')?.warnings.some((w) => w.code === 'sprawl'));
  assert.ok(!insightOf({ ...m2, requirements: new Map(m2.requirements).set('billing/rounding', { ...spread, block: `${spread.block}\nAnchors: many` }) }, 'billing/rounding')?.warnings.some((w) => w.code === 'sprawl'), '`Anchors: many` silences the sprawl warning');
  assert.ok(!insightOf({ ...m2, many: new Set(['billing/rounding']) }, 'billing/rounding')?.warnings.some((w) => w.code === 'sprawl'), '`anchor_many` silences it too');
  assert.equal(insightOf(model, 'billing/nope'), undefined);
});

test('unresolved markers: did-you-mean, renamed by a pending change, added by a pending change', () => {
  assert.match(unresolvedInfo(model, 'billing/add-item').text, /did you mean billing\/add-an-item/);
  assert.equal(unresolvedInfo(model, 'billing/add-item').hint, 'billing/add-an-item');
  const renamed = unresolvedInfo(model, 'billing/round-to-cents');
  assert.equal(renamed.renamedBy?.change, 'tweak');
  assert.match(renamed.text, /renamed from billing\/rounding by pending change tweak/);
  const early = unresolvedInfo(model, 'billing/refund-an-item');
  assert.equal(early.addedBy, 'refunds');
  assert.match(unresolvedLensText('billing/refund-an-item', early), /^\$\(warning\) @spec billing\/refund-an-item: added by pending change refunds/);
  assert.equal(unresolvedInfo(model, 'billing/zzz-qq').hint, undefined);
});

test('adrsMentioning: by key or by a name of 8+ characters, nothing else', () => {
  assert.equal(adrsMentioning(adrs, 'billing/x', 'X').length, 0);
  assert.deepEqual(adrsMentioning([adr('0005', 't', 'the Add an item rule\n')], 'billing/add-an-item', 'Add an item').map((a) => a.number), ['0005']);
  assert.equal(adrsMentioning([adr('0006', 't', 'a rule')], 'billing/a', 'A rule').length, 0, 'short names are not matched');
});

test('test planning: an existing test of the requirement wins, then a conventional file next to the code, else a path to create', () => {
  const i = insightOf(model, 'billing/add-an-item')!;
  assert.deepEqual(planTest(i, () => false), { file: 'tests/add.test.ts', exists: true, reason: 'a test of this requirement already lives there' });
  const none = insightOf(model, 'billing/rounding')!;
  assert.deepEqual(planTest(none, () => false), { file: 'src/test_round.py', exists: false, reason: 'the conventional test file for src/round.py' });
  assert.equal(planTest(none, (f) => f === 'tests/test_round.py')?.file, 'tests/test_round.py');
  assert.equal(planTest({ ...none, code: [] }, () => false), undefined);
});

test('test candidates by language', () => {
  assert.deepEqual(testCandidates('src/billing/add.ts').slice(0, 3), ['src/billing/add.test.ts', 'src/billing/add.spec.ts', 'src/billing/__tests__/add.test.ts']);
  assert.ok(testCandidates('src/billing/add.ts').includes('tests/billing/add.test.ts'));
  assert.ok(testCandidates('app/pay.py').includes('tests/test_pay.py'));
  assert.deepEqual(testCandidates('pkg/pay.go'), ['pkg/pay_test.go']);
  assert.ok(testCandidates('lib/pay.rb').includes('spec/pay_spec.rb'));
  assert.ok(testCandidates('src/Pay.java').includes('src/PayTest.java'));
});

test('scenario menu: tested ones jump to their test, untested offer to create or open the likely file', () => {
  const i = insightOf(model, 'billing/add-an-item')!;
  const rows = scenarioMenu(i, '/code', planTest(i, () => true), (r, f) => `${r}/${f}`);
  assert.equal(rows[0]?.reveal?.type, 'requirement');
  const tested = rows.find((r) => r.id === 'scn:reject-empty');
  assert.equal(tested?.file, '/code/tests/add.test.ts');
  assert.match(tested?.description ?? '', /tested in tests\/add\.test\.ts:2/);
  const untested = rows.find((r) => r.id === 'scn:add-and-see-it');
  assert.equal(untested?.create?.file, 'tests/add.test.ts');
  assert.match(untested?.description ?? '', /no test yet: open/);
  const fresh = scenarioMenu({ ...i, tests: [] }, '/code', planTest({ ...i, tests: [] }, () => false), (r, f) => `${r}/${f}`);
  assert.match(fresh.find((r) => r.create)?.description ?? '', /no test yet: create src\/add\.test\.ts/);
  assert.equal(fresh.find((r) => r.create)?.file, undefined);
  const noplan = scenarioMenu(i, '/code', undefined, (r, f) => `${r}/${f}`);
  assert.equal(noplan.find((r) => r.id === 'scn:add-and-see-it')?.reveal?.type, 'scenario');
});

test('test stubs carry the scenario tag in the language of the file', () => {
  const i = insightOf(model, 'billing/add-an-item')!;
  assert.match(testStub(i, 'reject-empty', 'tests/add.test.ts'), /@spec billing\/add-an-item\nit\('Reject empty \[billing\/reject-empty\]'.*\n {2}\/\/ WHEN the name is empty\n {2}\/\/ THEN it is refused/);
  assert.match(testStub(i, 'reject-empty', 'tests/test_add.py'), /def test_reject_empty\(\):\n {4}# @spec billing\/add-an-item\n {4}# \[billing\/reject-empty\]/);
  assert.match(testStub(i, 'reject-empty', 'x_test.go'), /func TestRejectEmpty\(t \*testing\.T\)/);
});

test('test command: commands.test of the config, placeholders and none mean off', () => {
  assert.equal(readTestCommand('commands:\n  test: npm test\n  lint: x\n'), 'npm test');
  assert.equal(readTestCommand('traceability: on\ncommands:\n  lint: x\n  test: pytest -q  # fast\n'), 'pytest -q');
  assert.equal(readTestCommand('commands:\n  test: "go test ./..."\n'), 'go test ./...');
  assert.equal(readTestCommand('commands:\n  test: <fill in>\n'), undefined);
  assert.equal(readTestCommand('commands:\n  test: none\n'), undefined);
  assert.equal(readTestCommand('test: npm test\n'), undefined, 'only commands.test counts');
  assert.equal(readTestCommand('schema: x'), undefined);
});

test('filtered test command: placeholder, known runners, npm wrapper, unknown runner runs everything', () => {
  const tags = ['billing/reject-empty', 'billing/half-up'];
  const p = "'\\[billing/reject-empty\\]|\\[billing/half-up\\]'";
  assert.deepEqual(filteredTestCommand('npx vitest run {tags}', tags), { command: `npx vitest run ${p}`, filtered: true });
  assert.deepEqual(filteredTestCommand('node --test', tags), { command: `node --test --test-name-pattern=${p}`, filtered: true });
  assert.deepEqual(filteredTestCommand('npx jest', tags), { command: `npx jest -t ${p}`, filtered: true });
  assert.deepEqual(filteredTestCommand('mocha', tags), { command: `mocha --grep ${p}`, filtered: true });
  assert.deepEqual(filteredTestCommand('pytest -q', tags), { command: "pytest -q -k 'billing/reject-empty or billing/half-up'", filtered: true });
  assert.deepEqual(filteredTestCommand('npm test', tags, 'vitest run'), { command: `npm test -- -t ${p}`, filtered: true });
  assert.deepEqual(filteredTestCommand('pnpm test', tags, 'node --test "test/*.test.ts"'), { command: `pnpm test --test-name-pattern=${p}`, filtered: true });
  assert.deepEqual(filteredTestCommand('npm test', tags), { command: 'npm test', filtered: false });
  assert.deepEqual(filteredTestCommand('make check', tags), { command: 'make check', filtered: false });
  assert.deepEqual(filteredTestCommand('npm test', []), { command: 'npm test', filtered: false });
});

test('reveal routes: requirement, and scenario variants', () => {
  assert.deepEqual(revealRoute({ root: '/r' }, { type: 'requirement', key: 'billing/add-an-item' }), { page: 'spec', root: '/r', name: 'billing', focus: 'req:add-an-item' });
  assert.deepEqual(revealRoute({ root: '/r' }, { type: 'scenario', key: 'billing/add-an-item', scenario: 'Reject empty' }), { page: 'spec', root: '/r', name: 'billing', focus: 'scn:add-an-item/reject-empty' });
});

test('hover: the Why in words, scenarios with tested status and links, ADRs, pending changes, actions', () => {
  const i = insightOf(model, 'billing/add-an-item', adrs)!;
  const md = hoverInsight(i, { root: dir, codeRoot: dir, canRun: true });
  assert.match(md, /\*\*Add an item\*\* · `billing\/add-an-item`/);
  assert.match(md, /SHALL add an item to the bill/);
  assert.match(md, /\*\*Why\*\*: Users see what they owe/);
  assert.match(md, /\*\*Scenarios\*\* \(1\/2 tested\)/);
  assert.match(md, /Reject empty[^\n]*: tested in \[tests\/add\.test\.ts:2\]\(command:wingmanSpec\.openFile\?/);
  assert.match(md, /Add and see it[^\n]*: no test yet/);
  assert.match(md, /WHEN a user adds an item/);
  assert.match(md, /\*\*Related ADRs\*\*: \[0003 Cents only\]\(command:wingmanSpec\.openRoute\?/);
  assert.match(md, /\[Open in Wingman Spec\]\(command:wingmanSpec\.revealRequirement\?/);
  assert.match(md, /\[Open spec\]\(command:wingmanSpec\.openFile\?/);
  assert.match(md, /\[Run tests\]\(command:wingmanSpec\.runTests\?/);
  assert.doesNotMatch(hoverInsight(i, { root: dir, codeRoot: dir, canRun: false }), /Run tests/);
  const amended = hoverInsight(insightOf(model, 'billing/remove-an-item')!, { root: dir, codeRoot: dir, canRun: false });
  assert.match(amended, /\*\*Pending\*\*: \[tweak\]\(command:wingmanSpec\.openRoute\?[^)]+\) amends it/);
  assert.match(hoverInsight(insightOf(model, 'billing/rounding')!, { root: dir, codeRoot: dir, canRun: false }), /renames it to "Round to cents"/);
  assert.match(hoverInsight(insightOf(model, 'billing/legacy-thing')!, { root: dir, codeRoot: dir, canRun: false }), /No `Why:` line/);
  assert.match(hoverInsight(i, { root: dir, codeRoot: dir, canRun: false, scenario: 'reject-empty' }), /\[\*\*Reject empty\*\*\]/);
});

test('hover links only use commands the hover trusts', () => {
  const md = [hoverInsight(insightOf(model, 'billing/add-an-item', adrs)!, { root: dir, codeRoot: dir, canRun: true }), hoverUnresolved('billing/add-item', unresolvedInfo(model, 'billing/add-item'), { root: dir, uri: 'file:///a.ts', line: 1, col: 9, length: 16 })].join('\n');
  const used = new Set([...md.matchAll(/\(command:([A-Za-z.]+)\?/g)].map((m) => m[1]));
  assert.ok(used.size >= 6);
  for (const c of used) assert.ok(HOVER_COMMANDS.includes(c ?? ''), `${c} is not in the trusted list`);
  assert.match(md, /Fix marker to billing\/add-an-item/);
  assert.equal(commandLink('a [b]', 'x.y', [1, 'two']), '[a \\[b\\]](command:x.y?%5B1%2C%22two%22%5D)');
});
