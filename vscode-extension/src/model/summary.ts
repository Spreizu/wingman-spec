import { firstUnchecked } from './tasksParser.ts';
import type { Change } from './types.ts';

export interface Summary {
  active: number;
  blocked: number;
  next?: { change: string; taskId: string; title: string };
  markdown: string;
}

export const STATUS_BAR_TEXT = 'Wingman Spec';

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function escapeMd(text: string): string {
  return text.replace(/([\\`*_{}[\]<>()#+!|~-])/g, '\\$1');
}

/** Builds the status bar tooltip from the scanned changes. Pure, so it is unit tested. */
export function summarize(changes: Change[]): Summary {
  const blocked = changes.filter((c) => c.state === 'blocked').length;
  const working = changes.find((c) => c.state === 'in-progress');
  const task = working ? firstUnchecked(working.groups) : undefined;
  const next =
    working && task
      ? { change: working.name, taskId: task.id, title: task.title || task.id }
      : undefined;

  const lines = [`**${STATUS_BAR_TEXT}**`, ''];
  if (changes.length === 0) {
    lines.push('No active changes.');
  } else {
    lines.push(`${plural(changes.length, 'active change')}, ${blocked} blocked.`);
    if (next) {
      const id = next.taskId ? `${next.taskId} ` : '';
      lines.push('', `Next task in \`${next.change}\`: ${escapeMd(id + next.title)}`);
    }
  }
  return { active: changes.length, blocked, next, markdown: lines.join('\n') };
}
