/**
 * The timeline of a change: what `verify-task.cjs` recorded while it was built (`openspec/.apply-runs/<change>/timeline.jsonl`, kept
 * next to `archived.json` when the change is archived; written by `timeline.cjs`). Pure: the file text comes in.
 */
import { join } from 'node:path';
import chrono from '../../../project-template/openspec/scripts/chronology.cjs';

/** Where the timeline of an open change is (archived: `<archived dir>/timeline.jsonl`). */
export const timelinePath = (root: string, change: string): string => join(root, 'openspec', '.apply-runs', change, 'timeline.jsonl');

/** A gap this long between two events is marked as idle time. */
export const IDLE_GAP_SECONDS = 15 * 60;

export interface TimelineDetail {
  label: string;
  /** One line each. */
  lines: string[];
  /** Command output: shown as preformatted text. */
  pre?: boolean;
}

export interface TimelineEntry {
  at: string;
  ms: number;
  /** HH:MM:SS, local time. */
  time: string;
  event: string;
  step: string;
  /** passed, failed, or '' when the event has no verdict. */
  result: '' | 'passed' | 'failed';
  summary: string;
  seconds?: number;
  /** Seconds since the previous event. */
  gap?: number;
  idle: boolean;
  task?: string;
  decision: boolean;
  details: TimelineDetail[];
}

export interface TimelineGroup {
  /** The task label, or '' for events of the whole change. */
  task: string;
  entries: TimelineEntry[];
}

const STEPS: Record<string, string> = {
  'run-start': 'Run started',
  takeover: 'Run taken over',
  next: 'Next task',
  'check-start': 'Check started',
  check: 'Check',
  tick: 'Ticked',
  'fix-round': 'Fix round',
  'review-packet': 'Review requested',
  review: 'Review',
  visual: 'Visual check',
  'finish-start': 'Finish started',
  finish: 'Finish',
  sync: 'Sync check',
  archive: 'Archive',
  decision: 'Decision',
};
/** Events whose `ok` is a verdict worth a word. */
const VERDICT = new Set(['check', 'review', 'visual', 'finish', 'sync', 'archive']);

const DETAIL_LABELS: [string, string, boolean?][] = [
  ['changes', 'What changed'],
  ['reason', 'Reason'],
  ['owner_approval', 'Owner approval'],
  ['failures', 'Failures'],
  ['files', 'Files'],
  ['output_tail', 'Output', true],
];

const lines = (v: unknown): string[] =>
  (Array.isArray(v) ? v : [v]).filter((x) => typeof x === 'string' || typeof x === 'number').flatMap((x) => String(x).split('\n')).filter((l) => l.trim() !== '');

/** The events of a timeline file, oldest first, with the gap since the previous event. */
export function parseTimeline(text: string | undefined): TimelineEntry[] {
  const raw: (Record<string, unknown> & { at: string })[] = [];
  for (const l of (text ?? '').split('\n')) {
    if (!l.trim()) continue;
    try {
      const v: unknown = JSON.parse(l);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const r = v as Record<string, unknown>;
        if (typeof r['event'] === 'string' && typeof r['at'] === 'string') raw.push({ ...r, at: r['at'] });
      }
    } catch {
      /* a torn line */
    }
  }
  const out: TimelineEntry[] = [];
  let prev: number | undefined;
  for (const r of chrono.sortRecords(raw)) {
    const event = String(r['event']);
    const ms = chrono.parseTime(r.at);
    const gap = prev !== undefined && !Number.isNaN(ms) ? Math.max(0, Math.round((ms - prev) / 1000)) : undefined;
    if (!Number.isNaN(ms)) prev = ms;
    const d = (r['details'] && typeof r['details'] === 'object' ? r['details'] : {}) as Record<string, unknown>;
    const details = DETAIL_LABELS.flatMap(([k, label, pre]) => {
      const ls = lines(d[k]);
      return ls.length ? [{ label, lines: ls, ...(pre ? { pre: true } : {}) }] : [];
    });
    const ok = r['ok'];
    out.push({
      at: r.at,
      ms,
      time: chrono.clock(r.at),
      event,
      step: STEPS[event] ?? event,
      result: VERDICT.has(event) && typeof ok === 'boolean' ? (ok ? 'passed' : 'failed') : '',
      summary: typeof r['summary'] === 'string' ? r['summary'] : '',
      ...(typeof r['seconds'] === 'number' ? { seconds: r['seconds'] } : {}),
      ...(gap !== undefined ? { gap } : {}),
      idle: gap !== undefined && gap >= IDLE_GAP_SECONDS,
      ...(typeof r['task'] === 'string' && r['task'] ? { task: r['task'] } : {}),
      decision: event === 'decision',
      details,
    });
  }
  return out;
}

/** Consecutive events of one task form a group; events without a task join the group they follow (or start the change's own). */
export function groupTimeline(entries: TimelineEntry[]): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  for (const e of entries) {
    const last = groups[groups.length - 1];
    const key = e.task ?? (e.event === 'run-start' || e.event.startsWith('finish') || e.event === 'sync' || e.event === 'archive' ? '' : last?.task ?? '');
    if (last && last.task === key) last.entries.push(e);
    else groups.push({ task: key, entries: [e] });
  }
  return groups;
}

/** 0.4 s, 12 s, 3 min 5 s, 2 h 4 min. */
export function duration(seconds: number): string {
  if (seconds < 10) return `${Math.round(seconds * 10) / 10} s`;
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  return `${Math.floor(s / 3600)} h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} min` : ''}`;
}
