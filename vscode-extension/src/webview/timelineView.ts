/** The Timeline tab of a change and of an archived change: one calm line per event, grouped by task, details collapsed. */
import { duration, groupTimeline, parseTimeline } from '../model/timeline.ts';
import type { TimelineEntry } from '../model/timeline.ts';
import { emptyState, esc, rich } from './components.ts';

function detailsHtml(e: TimelineEntry): string {
  return e.details
    .map((d) => `<div class="tl-detail"><div class="tl-dlabel">${esc(d.label)}</div>${d.pre ? `<pre>${esc(d.lines.join('\n'))}</pre>` : `<ul>${d.lines.map((l) => `<li>${rich(l)}</li>`).join('')}</ul>`}</div>`)
    .join('');
}

function line(e: TimelineEntry): string {
  const cells = `<span class="tl-time">${esc(e.time)}</span><span class="tl-step">${esc(e.step)}</span><span class="tl-result${e.result ? ` tl-${e.result}` : ''}">${e.result}</span><span class="tl-sum">${rich(e.summary)}</span><span class="tl-dur">${e.seconds !== undefined ? esc(duration(e.seconds)) : ''}</span><span class="tl-gap" title="Time since the previous event">${e.gap ? `+${esc(duration(e.gap))}` : ''}</span>`;
  const cls = `tl-entry${e.decision ? ' tl-decision' : ''}`;
  return e.details.length
    ? `<li class="${cls}"><details><summary class="tl-line">${cells}</summary><div class="tl-body">${detailsHtml(e)}</div></details></li>`
    : `<li class="${cls}"><div class="tl-line">${cells}</div></li>`;
}

export function timelineTab(text: string | undefined): string {
  const entries = parseTimeline(text);
  if (entries.length === 0) return emptyState('No activity yet', 'Steps appear here as the change is built.');
  return `<div class="timeline">${groupTimeline(entries)
    .map(
      (g) => `<section class="tl-group"><h3 class="tl-task">${g.task ? `Task ${esc(g.task)}` : 'Change'}</h3><ol class="tl-list">${g.entries
        .map((e) => `${e.idle && e.gap !== undefined ? `<li class="tl-idle" aria-label="idle">Idle for ${esc(duration(e.gap))}</li>` : ''}${line(e)}`)
        .join('')}</ol></section>`,
    )
    .join('')}</div>`;
}
