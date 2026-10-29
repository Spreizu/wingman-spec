import assert from 'node:assert/strict';
import { test } from 'node:test';
import { countTasks, firstUnchecked, parseTasks } from '../src/model/tasksParser.ts';

const SAMPLE = `## 1. Walking skeleton

- [ ] 1.1 Create the thing
  - Spec: items > create item
  - Test first: tests/items.test.ts asserts TITLE_REQUIRED
  - Files: src/items.ts
  - Done when: npm test passes
- [x] 1.2 Second
  - Spec: items > list
- [ ] 1.R Request code review for group 1
  - Done when: findings fixed

## 2. Close-out

- [ ] 2.1 Full test suite passes
`;

test('parses groups, tasks and review tasks', () => {
  const groups = parseTasks(SAMPLE);
  assert.equal(groups.length, 2);
  assert.equal(groups[0]?.number, '1');
  assert.equal(groups[0]?.title, 'Walking skeleton');
  assert.deepEqual(groups[0]?.tasks.map((t) => t.id), ['1.1', '1.2', '1.R']);
  assert.equal(groups[0]?.tasks[2]?.isReview, true);
  assert.equal(groups[0]?.tasks[0]?.isReview, false);
});

test('marks Close-out group', () => {
  const groups = parseTasks(SAMPLE);
  assert.equal(groups[0]?.isCloseOut, false);
  assert.equal(groups[1]?.isCloseOut, true);
});

test('detail lines are attached to their task and never counted as tasks', () => {
  const groups = parseTasks(SAMPLE);
  const t = groups[0]?.tasks[0];
  assert.equal(t?.details.spec, 'items > create item');
  assert.equal(t?.details.testFirst, 'tests/items.test.ts asserts TITLE_REQUIRED');
  assert.equal(t?.details.files, 'src/items.ts');
  assert.equal(t?.details.doneWhen, 'npm test passes');
  assert.equal(countTasks(groups).total, 4);
});

test('records checked state and zero-based line numbers', () => {
  const groups = parseTasks(SAMPLE);
  assert.equal(groups[0]?.tasks[1]?.checked, true);
  assert.equal(groups[0]?.tasks[0]?.line, 2);
  assert.deepEqual(countTasks(groups), { total: 4, done: 1 });
});

test('firstUnchecked returns the first open task in order', () => {
  assert.equal(firstUnchecked(parseTasks(SAMPLE))?.id, '1.1');
  assert.equal(firstUnchecked(parseTasks('## 1. G\n- [x] 1.1 a\n')), undefined);
});

test('template placeholders are stripped from titles and details', () => {
  const groups = parseTasks('## 1. <!-- Walking skeleton: group name -->\n- [ ] 1.1 <!-- Task -->\n  - Spec: <!-- x -->\n');
  assert.equal(groups[0]?.title, '');
  assert.equal(groups[0]?.tasks[0]?.title, '');
  assert.equal(groups[0]?.tasks[0]?.details.spec, undefined);
});

test('tasks before any heading land in an implicit group', () => {
  const groups = parseTasks('- [ ] 9.1 stuck\n');
  assert.equal(groups.length, 1);
  assert.equal(groups[0]?.title, 'Tasks');
  assert.equal(groups[0]?.tasks[0]?.id, '9.1');
});

test('handles CRLF line endings', () => {
  const groups = parseTasks('## 1. G\r\n- [ ] 1.1 a\r\n  - Done when: ok\r\n');
  assert.equal(groups[0]?.tasks[0]?.details.doneWhen, 'ok');
});

test('star bullets count as tasks and checkboxes inside code fences do not', () => {
  const groups = parseTasks(['## 1. G', '', '* [ ] 1.1 Star task', '  * Done when: `npm test` exits 0', '```md', '- [ ] 9.9 example only', '```', '- [x] 1.2 Dash task'].join('\n'));
  assert.deepEqual(groups[0]?.tasks.map((t) => [t.id, t.checked]), [['1.1', false], ['1.2', true]]);
  assert.equal(groups[0]?.tasks[0]?.details.doneWhen, '`npm test` exits 0');
});
