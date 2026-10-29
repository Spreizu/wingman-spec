import quality from '../../../project-template/openspec/scripts/quality.cjs';
import type { Task, TaskDetails, TaskGroup } from './types.ts';

const GROUP_RE = /^##\s+(?:(\d+)\.\s*)?(.*?)\s*$/;
const TASK_RE = /^[-*] \[( |x|X)\]\s+(?:(\d+\.(?:\d+|R))\s+)?(.*?)\s*$/;
const DETAIL_RE = /^\s+[-*] (Spec|Test first|Files|Done when|Visual):\s*(.*?)\s*$/;

const FENCE_RE = /^\s*(`{3,}|~{3,})/;

const DETAIL_KEYS: Record<string, keyof TaskDetails> = {
  Spec: 'spec',
  'Test first': 'testFirst',
  Files: 'files',
  'Done when': 'doneWhen',
  Visual: 'visual',
};

function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').trim();
}

/**
 * Parses tasks.md as written by the wingman-spec schema: `## N. Group` headings, top-level
 * `- [ ] X.Y title` (or `* [ ]`) checkboxes, and indented non-checkbox detail lines. Only top-level
 * checkbox lines outside code fences count as tasks; verify-task.cjs refuses fenced or nested
 * checkboxes, so for a valid tasks.md this matches OpenSpec's count.
 */
export function parseTasks(text: string): TaskGroup[] {
  const groups: TaskGroup[] = [];
  let group: TaskGroup | undefined;
  let task: Task | undefined;

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let fence: string | undefined;
  lines.forEach((raw, line) => {
    const f = FENCE_RE.exec(raw);
    if (f) {
      const mark = (f[1] ?? '')[0];
      fence = fence === undefined ? mark : fence === mark ? undefined : fence;
      return;
    }
    if (fence !== undefined) return;

    const g = GROUP_RE.exec(raw);
    if (g && raw.startsWith('## ')) {
      const title = stripComments(g[2] ?? '');
      group = {
        number: g[1] ?? '',
        title,
        line,
        isCloseOut: quality.isCloseoutGroup(title),
        tasks: [],
      };
      groups.push(group);
      task = undefined;
      return;
    }

    const t = TASK_RE.exec(raw);
    if (t) {
      if (!group) {
        group = { number: '', title: 'Tasks', line, isCloseOut: false, tasks: [] };
        groups.push(group);
      }
      const id = t[2] ?? '';
      const title = stripComments(t[3] ?? '');
      task = {
        id,
        title,
        checked: t[1] !== ' ',
        line,
        isReview: quality.isReviewTask(id, title),
        details: {},
      };
      group.tasks.push(task);
      return;
    }

    const d = DETAIL_RE.exec(raw);
    if (d && task) {
      const key = DETAIL_KEYS[d[1] ?? ''];
      const value = stripComments(d[2] ?? '');
      if (key && value) task.details[key] = value;
    }
  });

  return groups;
}

export function countTasks(groups: TaskGroup[]): { total: number; done: number } {
  let total = 0;
  let done = 0;
  for (const g of groups) {
    for (const t of g.tasks) {
      total += 1;
      if (t.checked) done += 1;
    }
  }
  return { total, done };
}

export function firstUnchecked(groups: TaskGroup[]): Task | undefined {
  for (const g of groups) {
    for (const t of g.tasks) if (!t.checked) return t;
  }
  return undefined;
}
