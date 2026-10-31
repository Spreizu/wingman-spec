import type { Change } from '../model/types.ts';
import { esc, icon } from './components.ts';

const STATE_TEXT = { done: 'done', skipped: 'skipped', missing: 'not created yet' } as const;

/** The artifacts as one quiet line under the header: done ones with a check, missing ones muted, skipped ones muted
 * and struck through. */
export function artifactLine(change: Change): string {
  const items = change.artifacts.map((a) => `<li class="${a.state}" title="${esc(`${a.label}: ${STATE_TEXT[a.state]}`)}">${a.state === 'done' ? icon('check', 12) : ''}${esc(a.label)}</li>`);
  return `<ul class="artifacts" aria-label="Artifacts">${items.join('')}</ul>`;
}
