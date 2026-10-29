import type { Change } from '../model/types.ts';
import { esc, icon } from './components.ts';

export function pipeline(change: Change, mini = false): string {
  const steps = change.artifacts
    .map((a) => {
      const cls = a.state === 'done' ? 'done' : a.state === 'skipped' ? 'skipped' : '';
      const glyph = a.state === 'done' ? icon('check', 12) : a.state === 'skipped' ? icon('dash', 12) : '';
      const title = `${a.label}: ${a.state === 'missing' ? 'not created yet' : a.state}`;
      return `<div class="step ${cls}" title="${esc(title)}"><span class="node">${glyph}</span><span class="name">${esc(a.label)}</span></div>`;
    })
    .join('');
  return `<div class="pipeline${mini ? ' mini' : ''}">${steps}</div>`;
}
