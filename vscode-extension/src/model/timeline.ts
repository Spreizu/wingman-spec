/**
 * The timeline of a change: what `wingman-spec` recorded while it was built (`runs/<change>/timeline.jsonl` in the specs root, kept
 * next to `archived.json` when the change is archived; written by the CLI). Pure: the file text comes in.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { runsDir } from '../core/paths.ts';
import chrono from '../core/chronology.ts';

/** Where the timeline of an open change is (archived: `<archived dir>/timeline.jsonl`). */
export const timelinePath = (root: string, change: string): string => join(runsDir(root, change), 'timeline.jsonl');

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
  /** The parallel wave (1, 2, ...) and the task's lane in it; absent outside a wave. */
  wave?: number;
  lane?: number;
  decision: boolean;
  /** The phase the event belongs to (events like validate join the phase they happen in). */
  phase: Phase;
  details: TimelineDetail[];
}

export type Phase = 'propose' | 'build' | 'verify' | 'sync' | 'archive';
export const PHASE_LABEL: Record<Phase, string> = { propose: 'Propose', build: 'Build', verify: 'Verify', sync: 'Sync', archive: 'Archive' };
const PHASE_OF: Record<string, Phase> = {
  start: 'propose',
  explore: 'propose',
  grill: 'propose',
  new: 'propose',
  'run-start': 'build',
  takeover: 'build',
  next: 'build',
  'check-start': 'build',
  check: 'build',
  tick: 'build',
  'fix-round': 'build',
  'review-packet': 'build',
  review: 'build',
  visual: 'build',
  'finish-start': 'verify',
  finish: 'verify',
  sync: 'sync',
  archive: 'archive',
};

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
  start: 'Propose started',
  explore: 'Explored',
  grill: 'Question',
  approval: 'Owner approval',
  note: 'Note',
  new: 'Change created',
  instructions: 'Instructions',
  artifact: 'Artifact',
  validate: 'Validate',
  lint: 'Planning lint',
  size: 'Size check',
  'app-map': 'App map',
  status: 'Status',
};
/** Events whose `ok` is a verdict worth a word. */
const VERDICT = new Set(['check', 'review', 'visual', 'finish', 'sync', 'archive', 'validate', 'lint', 'size']);

const DETAIL_LABELS: [string, string, boolean?][] = [
  ['changes', 'What changed'],
  ['reason', 'Reason'],
  ['owner_approval', 'Owner approval'],
  ['failures', 'Failures'],
  ['files', 'Files'],
  ['output_tail', 'Output', true],
  ['source', 'Run from'],
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
  let phase: Phase = 'propose';
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
    phase = PHASE_OF[event] ?? phase;
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
      ...(typeof r['wave'] === 'number' && r['wave'] > 0 ? { wave: r['wave'] } : {}),
      ...(typeof r['lane'] === 'number' && r['lane'] > 0 ? { lane: r['lane'] } : {}),
      decision: event === 'decision',
      phase,
      details,
    });
  }
  return out;
}

/** Consecutive events of one phase, in timeline blocks. */
export interface PhaseSection {
  phase: Phase;
  label: string;
  blocks: TimelineBlock[];
}

export function phaseSections(entries: TimelineEntry[]): PhaseSection[] {
  const runs: { phase: Phase; entries: TimelineEntry[] }[] = [];
  for (const e of entries) {
    const last = runs[runs.length - 1];
    if (last && last.phase === e.phase) last.entries.push(e);
    else runs.push({ phase: e.phase, entries: [e] });
  }
  return runs.map((r) => ({ phase: r.phase, label: PHASE_LABEL[r.phase], blocks: timelineBlocks(r.entries) }));
}

/** The first entry where the hash chain does not hold (`prev` is the SHA-256 of the line before; see docs/timeline.md). */
export interface ChainBreak {
  line: number;
  event?: string;
  at?: string;
  reason: string;
}

const GENESIS = '0'.repeat(64);
const lineHash = (l: string): string => createHash('sha256').update(l, 'utf8').digest('hex');

/**
 * The same check as `wingman-spec validate`: an edited, deleted, inserted or reordered entry breaks the chain at the entry
 * after it. Lines from before the chain (no prev) are accepted. With archived.json's anchor, a changed or dropped last
 * entry shows too.
 */
export function verifyChain(text: string | undefined, archivedJson?: string): ChainBreak | undefined {
  let prev: string | undefined;
  let chained = false;
  let n = 0;
  for (const raw of (text ?? '').split('\n')) {
    const l = raw.replace(/\r+$/, '');
    if (!l.trim()) continue;
    n++;
    let r: Record<string, unknown>;
    try {
      r = JSON.parse(l) as Record<string, unknown>;
    } catch {
      if (chained) return { line: n, reason: 'is not a valid entry' };
      prev = l;
      continue;
    }
    const who = { line: n, ...(typeof r['event'] === 'string' ? { event: r['event'] } : {}), ...(typeof r['at'] === 'string' ? { at: r['at'] } : {}) };
    const p = typeof r['prev'] === 'string' ? r['prev'] : '';
    const want = prev === undefined ? GENESIS : lineHash(prev);
    if (!p && chained) return { ...who, reason: 'has no link to the entry before it (an entry was inserted)' };
    if (p && p !== want)
      return { ...who, reason: n === 1 ? 'does not start the chain (entries before it were deleted)' : `does not follow entry ${n - 1} (entry ${n - 1} was edited, or entries were deleted or moved there)` };
    if (p) chained = true;
    prev = l;
  }
  if (archivedJson && prev !== undefined) {
    try {
      const a = JSON.parse(archivedJson) as Record<string, unknown>;
      const head = a['timeline_head'];
      const count = a['timeline_entries'];
      if (typeof head === 'string' && head && (head !== lineHash(prev) || count !== n))
        return { line: Math.max(1, Math.min(n, typeof count === 'number' ? count : n)), reason: `does not match archived.json: it recorded ${String(count)} entries, the file has ${n} (the last entries were edited or removed)` };
    } catch {
      /* no anchor */
    }
  }
  return undefined;
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

/** A run of the timeline: one task's (or the change's) events, or a parallel wave with one lane per task. */
export type TimelineBlock = { kind: 'group'; group: TimelineGroup } | { kind: 'wave'; wave: number; lanes: TimelineGroup[] };

/**
 * Like groupTimeline, but the events of one parallel wave form one block with a lane per task (in lane order), so the
 * tasks that ran at the same time can be shown side by side. An event of a lane's task without a wave number (a retry
 * of that task) stays in its lane while the wave is open.
 */
export function timelineBlocks(entries: TimelineEntry[]): TimelineBlock[] {
  const out: TimelineBlock[] = [];
  let rest: TimelineEntry[] = [];
  const flush = (): void => {
    for (const group of groupTimeline(rest)) out.push({ kind: 'group', group });
    rest = [];
  };
  let wave: Extract<TimelineBlock, { kind: 'wave' }> | undefined;
  const order = new Map<string, number>();
  for (const e of entries) {
    const inWave = wave !== undefined && (e.wave === wave.wave || (e.wave === undefined && e.task !== undefined && wave.lanes.some((l) => l.task === e.task)));
    if (e.wave !== undefined && !inWave) {
      flush();
      wave = { kind: 'wave', wave: e.wave, lanes: [] };
      order.clear();
      out.push(wave);
    } else if (!inWave) {
      wave = undefined;
      rest.push(e);
      continue;
    }
    const w = wave as Extract<TimelineBlock, { kind: 'wave' }>;
    const task = e.task ?? '';
    let lane = w.lanes.find((l) => l.task === task);
    if (!lane) {
      lane = { task, entries: [] };
      order.set(task, e.lane ?? Number.MAX_SAFE_INTEGER);
      w.lanes.push(lane);
      w.lanes.sort((a, b) => (order.get(a.task) ?? 0) - (order.get(b.task) ?? 0));
    }
    lane.entries.push(e);
  }
  flush();
  return out;
}

/** 0.4 s, 12 s, 3 min 5 s, 2 h 4 min. */
export function duration(seconds: number): string {
  if (seconds < 10) return `${Math.round(seconds * 10) / 10} s`;
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  return `${Math.floor(s / 3600)} h${Math.floor((s % 3600) / 60) ? ` ${Math.floor((s % 3600) / 60)} min` : ''}`;
}
