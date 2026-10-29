import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STATUS_BAR_TEXT, summarize } from '../src/model/summary.ts';
import { countTasks, parseTasks } from '../src/model/tasksParser.ts';
import type { Change, ChangeState } from '../src/model/types.ts';

function change(name: string, state: ChangeState, tasks: string): Change {
  const groups = parseTasks(tasks);
  const { total, done } = countTasks(groups);
  return {
    name,
    dir: `/c/${name}`,
    schema: 'wingman-spec',
    isWingmanSpec: true,
    skipSpecs: false,
    state,
    artifacts: [],
    capabilities: [],
    adrs: [],
    noDecisions: [],
    adrsSynced: true,
    tasksPath: `/c/${name}/tasks.md`,
    groups,
    taskTotal: total,
    taskDone: done,
  };
}

test('status bar text is exactly Wingman Spec', () => {
  assert.equal(STATUS_BAR_TEXT, 'Wingman Spec');
});

test('zero changes', () => {
  const s = summarize([]);
  assert.equal(s.active, 0);
  assert.equal(s.next, undefined);
  assert.match(s.markdown, /No active changes/);
});

test('counts active and blocked changes and names the next task', () => {
  const s = summarize([
    change('a', 'blocked', '## 1. G\n- [ ] 1.1 stuck\n'),
    change('b', 'in-progress', '## 1. G\n- [x] 1.1 done\n- [ ] 1.2 write tests\n'),
  ]);
  assert.equal(s.active, 2);
  assert.equal(s.blocked, 1);
  assert.deepEqual(s.next, { change: 'b', taskId: '1.2', title: 'write tests' });
  assert.match(s.markdown, /2 active changes, 1 blocked/);
  assert.match(s.markdown, /Next task in `b`/);
});

test('singular wording and no next task when nothing is in progress', () => {
  const s = summarize([change('a', 'planning', '')]);
  assert.match(s.markdown, /1 active change, 0 blocked/);
  assert.equal(s.next, undefined);
});
