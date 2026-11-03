/** The Timeline tab of a change and of an archived change: one calm line per event, grouped by phase and task, details
 * collapsed, newest on top (phases, blocks and the events in each are shown in reverse). */
import { runSummary, type RunSummary, type SummaryLine } from '../model/runSummary.ts';
import { duration, parseTimeline, phaseSections, verifyChain } from '../model/timeline.ts';
import type { TimelineBlock, TimelineEntry, TimelineGroup } from '../model/timeline.ts';
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
    ? `<li class="${cls}" id="tl-${e.index}"><details><summary class="tl-line">${cells}</summary><div class="tl-body">${detailsHtml(e)}</div></details></li>`
    : `<li class="${cls}" id="tl-${e.index}"><div class="tl-line">${cells}</div></li>`;
}

function list(g: TimelineGroup): string {
  // newest first: an idle gap sits below the event it led up to
  return `<ol class="tl-list">${[...g.entries]
    .reverse()
    .map((e) => `${line(e)}${e.idle && e.gap !== undefined ? `<li class="tl-idle" aria-label="idle">Idle for ${esc(duration(e.gap))}</li>` : ''}`)
    .join('')}</ol>`;
}

function block(b: TimelineBlock): string {
  return b.kind === 'group'
    ? `<section class="tl-group"><h4 class="tl-task">${b.group.task ? `Task ${esc(b.group.task)}` : 'Change'}</h4>${list(b.group)}</section>`
    : `<section class="tl-group tl-wave" aria-label="Parallel wave ${b.wave}"><h4 class="tl-task">Parallel wave ${b.wave}: ${b.lanes.filter((l) => l.task).length} tasks at once</h4><div class="tl-lanes">${b.lanes
        .map((l) => `<div class="tl-lane"><h5 class="tl-lane-task">${l.task ? `Task ${esc(l.task)}` : 'Wave'}</h5>${list(l)}</div>`)
        .join('')}</div></section>`;
}

const jump = (l: SummaryLine): string => `<button class="link tl-jump" data-jump="tl-${l.target}" title="Show in the timeline">${esc(l.text)}</button>`;

/** One calm card above the timeline once the run has finished; every line scrolls to the entry it comes from. */
function summaryCard(s: RunSummary): string {
  const items = s.lines.map((l) => `<li>${jump(l)}</li>`);
  if (s.diff) {
    const d = s.diff;
    const more = d.files - d.list.length;
    const files = d.list.length
      ? `<details class="tl-files" data-keep><summary>Files</summary><ul>${d.list.map((f) => `<li><code>${esc(f.file)}</code> <span class="muted">+${f.added} −${f.removed}</span></li>`).join('')}${more > 0 ? `<li class="muted">and ${more} more</li>` : ''}</ul></details>`
      : '';
    items.push(`<li>${jump({ text: `${d.files === 1 ? '1 file' : `${d.files} files`} changed, +${d.added} −${d.removed}`, target: d.target })}${files}</li>`);
  }
  const open = s.open.length ? `<ul class="tl-run-list">${s.open.map((l) => `<li>${jump(l)}</li>`).join('')}</ul>` : '<p class="muted">None.</p>';
  return `<section class="card tl-run" aria-label="Run summary"><h3 class="tl-run-title">Run summary</h3><ul class="tl-run-list">${items.join('')}</ul><h4 class="tl-task">Open items</h4>${open}</section>`;
}

/**
 * archivedJson: the archived change's archived.json, whose head hash anchors the chain. taskTotal: the change's task count,
 * for the run summary.
 */
export function timelineTab(text: string | undefined, archivedJson?: string, taskTotal?: number): string {
  const entries = parseTimeline(text);
  if (entries.length === 0) return emptyState('No activity yet', 'Steps appear here as the change is built.');
  const br = verifyChain(text, archivedJson);
  const note = br
    ? `<p class="tl-chain" role="note">This timeline was changed after it was written: entry ${br.line}${br.event ? ` (${esc(br.event)}${br.at ? ` at ${esc(br.at)}` : ''})` : ''} ${esc(br.reason)}. The entries are shown as they are.</p>`
    : '';
  const sum = runSummary(entries, taskTotal);
  return `${note}${sum ? summaryCard(sum) : ''}<div class="timeline">${phaseSections(entries)
    .reverse()
    .map((p) => `<section class="tl-phase" aria-label="${esc(p.label)}"><h3 class="tl-phase-title">${esc(p.label)}</h3>${[...p.blocks].reverse().map(block).join('')}</section>`)
    .join('')}</div>`;
}
