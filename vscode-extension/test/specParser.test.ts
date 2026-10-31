import assert from 'node:assert/strict';
import { test } from 'node:test';
import { diffLines, hasChanges } from '../src/model/lineDiff.ts';
import { lintAdr, lintSpec, lintTasks, proposalSize } from '../src/model/lint.ts';
import { countScenarios, findRequirement, parseSpec } from '../src/model/specParser.ts';
import { toggleTaskLine } from '../src/model/taskEdit.ts';

const SPEC = `## Purpose
Short purpose.

## ADDED Requirements

### Requirement: Login
The system SHALL authenticate users.

#### Scenario: valid
- **WHEN** user sends valid credentials
- **THEN** a session is created
- **AND** no error is shown

#### Scenario: invalid
- **WHEN** user sends a wrong password

## MODIFIED Requirements

### Requirement: Logout
Users can log out.

## RENAMED Requirements
- Old -> New
`;

test('parses purpose, sections, requirements, scenarios and renames', () => {
  const s = parseSpec(SPEC);
  assert.equal(s.purpose, 'Short purpose.');
  assert.deepEqual(s.requirements.map((r) => [r.name, r.section]), [['Login', 'ADDED'], ['Logout', 'MODIFIED']]);
  assert.equal(countScenarios(s), 2);
  assert.equal(s.requirements[0]?.scenarios[0]?.steps.length, 3);
  assert.equal(s.requirements[0]?.line, 5);
  assert.deepEqual(s.renames, [{ from: 'Old', to: 'New' }]);
  assert.equal(findRequirement(s, 'login')?.name, 'Login');
});

test('base specs use a Requirements section', () => {
  const s = parseSpec('## Requirements\n\n### Requirement: A\nThe system MUST do A.\n');
  assert.equal(s.requirements[0]?.section, 'BASE');
});

test('lintSpec reports missing normative text, scenarios, steps and short purpose', () => {
  const msgs = lintSpec(SPEC).map((i) => i.message);
  assert.ok(msgs.some((m) => m.includes('Purpose')));
  assert.ok(msgs.some((m) => m.includes('SHALL or MUST')));
  assert.ok(msgs.some((m) => m.includes('no scenarios')));
  assert.ok(msgs.some((m) => m.includes('WHEN and one THEN')));
});

test('lintSpec treats template placeholders as unfilled', () => {
  const issues = lintSpec('## ADDED Requirements\n\n### Requirement: <!-- name -->\n<!-- The system SHALL -->\n');
  assert.ok(issues.some((i) => i.message.includes('name is empty')));
});

test('lintTasks flags tasks without Spec, Test first, Files or Done when', () => {
  const issues = lintTasks('Size: S\n\n## 1. G\n\n- [ ] 1.1 Do it\n  - Spec: a > b\n- [ ] 1.R Review\n');
  assert.equal(issues.length, 1);
  assert.equal(issues[0]?.line, 4);
  assert.ok(issues[0]?.message.includes('Test first, Files, Done when'));
});

test('lintTasks requires the Files line (B14)', () => {
  const full = 'Size: S\n\n## 1. G\n\n- [ ] 1.1 Do it\n  - Spec: a > b\n  - Test first: t\n  - Files: src/a.ts\n  - Done when: `npm test` exits 0\n- [ ] 1.R Request code review of the whole change\n';
  assert.deepEqual(lintTasks(full), []);
  const noFiles = lintTasks(full.replace('  - Files: src/a.ts\n', ''));
  assert.equal(noFiles.length, 1);
  assert.ok(noFiles[0]?.message.endsWith('missing: Files.'));
});

test('the size comes from proposal.md; a different Size in tasks.md is an error', () => {
  assert.equal(proposalSize('Size: S <!-- S, M or L -->\nRisk: none\n\n## Why\n'), 'S');
  assert.equal(proposalSize('<!-- Size: L -->\n## Why\n'), '');
  const task = (n: number): string => `- [ ] 1.${n} T${n}\n  - Spec: a > b\n  - Test first: t\n  - Files: src/f${n}.ts\n  - Done when: \`npm test\` exits 0\n`;
  const plan = `## 1. G\n\n${[1, 2, 3, 4].map(task).join('')}- [ ] 1.R Request code review of the whole change\n`;
  assert.ok(lintTasks(plan, 'S').some((i) => i.severity === 'error' && i.message.includes('at most 3')));
  assert.deepEqual(lintTasks(plan, 'M'), []);
});

test('lintAdr checks fields, supersedes and sections', () => {
  const ok = '---\ntitle: T\nstatus: Proposed\ndate: 2026-01-01\n---\n## Context\nc\n## Decision\nd\n## Consequences\nx\n';
  assert.deepEqual(lintAdr(ok, { kind: 'source' }), []);
  const bad = '---\ntitle: <!-- t -->\nstatus: Weird\ndate: 2026-01-01\nsupersedes: 0009\n---\n## Context\nc\n';
  const msgs = lintAdr(bad, { kind: 'root', knownNumbers: ['0001'] }).map((i) => i.message);
  assert.ok(msgs.some((m) => m.includes('title')));
  assert.ok(msgs.some((m) => m.includes('Status should')));
  assert.ok(msgs.some((m) => m.includes('0009')));
  assert.ok(msgs.some((m) => m.includes('Decision')));
});

test('lintAdr skips section checks for status none', () => {
  assert.deepEqual(lintAdr('---\ntitle: T\nstatus: none\ndate: 2026-01-01\n---\nNo decision.\n', { kind: 'source' }), []);
});

test('diffLines marks additions and deletions', () => {
  const d = diffLines('a\nb\nc', 'a\nx\nc');
  assert.deepEqual(d.map((l) => l.kind), ['same', 'del', 'add', 'same']);
  assert.ok(!hasChanges(diffLines('a', 'a')));
});

test('toggleTaskLine flips only top-level task checkboxes', () => {
  assert.equal(toggleTaskLine('- [ ] 1.1 x'), '- [x] 1.1 x');
  assert.equal(toggleTaskLine('- [X] 1.1 x'), '- [ ] 1.1 x');
  assert.equal(toggleTaskLine('  - Spec: y'), undefined);
});

test('lintSpec checks where a visual block sits; its fields are checked by `wingman-spec problems`', () => {
  const ok = '## ADDED Requirements\n\n### Requirement: Grid\nThe system SHALL show a grid.\n\n#### Scenario: Grid\n- **WHEN** opened\n- **THEN** shown\n\n```visual\nroute: /\ncomponent: ResultGrid\nviewports: 375, 768, 1280\nkey: [data-testid="grid"]\nstate: empty\n  do: fill [data-testid="search"] = zzz\n  key: [data-testid="empty"]\n```\n';
  assert.deepEqual(lintSpec(ok).filter((i) => i.message.startsWith('Visual')), []);
  assert.ok(lintSpec('## ADDED Requirements\n\n```visual\nroute: /\nkey: a\n```\n').some((i) => i.message.includes('inside a "#### Scenario:"')));
});

test('lintSpec notes a visual block without component: (it would guard every later task)', () => {
  const t = '## ADDED Requirements\n\n### Requirement: Grid\nThe system SHALL show a grid.\n\n#### Scenario: Grid\n- **WHEN** opened\n- **THEN** shown\n\n```visual\nroute: /\nkey: [data-testid="grid"]\n```\n';
  const i = lintSpec(t).filter((x) => x.message.includes('no "component:"'));
  assert.equal(i.length, 1); assert.equal(i[0]?.severity, 'info');
  assert.equal(lintSpec(t.replace('route: /', 'route: /\ncomponent: Grid')).filter((x) => x.message.includes('no "component:"')).length, 0);
});

test('lintTasks suggests a Visual: line for tasks that touch UI files', () => {
  const t = '## 1. UI\n\n- [ ] 1.1 Grid\n  - Spec: gallery > Grid\n  - Test first: test/grid.test.ts\n  - Files: src/components/Grid.vue\n  - Done when: `npm test`\n';
  assert.ok(lintTasks(t).some((i) => i.message.includes('no Visual: line')));
  assert.deepEqual(lintTasks(t.replace('  - Done when', '  - Visual: gallery/grid\n  - Done when')).filter((i) => i.message.includes('Visual')), []);
});

test('lintTasks enforces the Size cap live; the plan shape comes from `wingman-spec problems`', () => {
  const task = (n: string, file: string, extra = ''): string => `- [ ] ${n} Task ${n}\n  - Spec: a > b (c)\n  - Test first: test/x.test.ts${extra}\n  - Files: ${file}, test/x.test.ts\n  - Done when: \`npm test\`\n`;
  const plan = (size: string): string => `Size: ${size}\n\n## 1. G\n\n${task('1.1', 'src/a.ts')}${task('1.2', 'src/b.ts')}- [ ] 1.R Request code review for group 1\n\n## 2. H\n\n${task('2.1', 'src/c.ts')}${task('2.2', 'src/c.ts')}- [ ] 2.R Request code review of the whole change\n\n## 3. Close-out\n\n- [ ] 3.1 Full test suite passes\n`;
  const s = lintTasks(plan('S'));
  assert.ok(s.some((i) => i.severity === 'error' && i.message.includes('at most 3')));
  assert.ok(!lintTasks(plan('M')).some((i) => i.severity === 'error'));
  assert.ok(!lintTasks(plan('L')).some((i) => i.severity === 'error'));
});
