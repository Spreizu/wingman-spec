/**
 * The run summary of a finished change: what the run took, what it checked and fixed, what it changed and what is still
 * open. Derived from the timeline only (the finish event carries the check verdicts and the diff since the run's base,
 * the progress events the review fixes). Pure. Each line points at the timeline entry it comes from.
 */
import { duration, type TimelineEntry } from './timeline.ts';

export interface SummaryLine {
  text: string;
  /** The index of the timeline entry the line comes from. */
  target: number;
}

export interface ChangedFile {
  file: string;
  added: number;
  removed: number;
}

export interface RunSummary {
  lines: SummaryLine[];
  open: SummaryLine[];
  /** Absent when the finish event has no diff (an older CLI, or no base commit). */
  diff?: { files: number; added: number; removed: number; list: ChangedFile[]; target: number };
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const names = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
/** The checks an owner reads by name; the others (validate, trace, anchors, ...) count as spec checks. */
const NAMED = ['tests', 'typecheck', 'lint', 'visual'];

interface FinishCheck {
  name: string;
  ok: boolean;
  skipped: string;
  untested: string[];
}

function finishChecks(v: unknown): FinishCheck[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((c: unknown) => {
    if (!c || typeof c !== 'object') return [];
    const r = c as Record<string, unknown>;
    const name = str(r['name']);
    return name ? [{ name, ok: r['ok'] === true, skipped: str(r['skipped']), untested: Array.isArray(r['untested']) ? r['untested'].map(String) : [] }] : [];
  });
}

/** The summary once the latest run has finished (its last finish passed and no run started after it); otherwise undefined. */
export function runSummary(entries: TimelineEntry[], taskTotal?: number): RunSummary | undefined {
  let fin = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as TimelineEntry;
    if (e.event === 'finish') {
      fin = i;
      break;
    }
    if (e.event === 'run-start' || e.event === 'takeover' || e.event === 'next') return undefined;
  }
  const finish = entries[fin];
  if (!finish || finish.result !== 'passed') return undefined;
  const startIdx = entries.findIndex((e) => e.event === 'run-start');
  const run = entries.slice(startIdx < 0 ? 0 : startIdx, fin + 1);
  const start = run[0] as TimelineEntry;
  const lines: SummaryLine[] = [];
  const open: SummaryLine[] = [];

  // duration and tasks
  if (!Number.isNaN(start.ms) && !Number.isNaN(finish.ms) && finish.ms >= start.ms) {
    const idle = run.slice(1).reduce((s, e) => s + (e.idle ? (e.gap ?? 0) : 0), 0);
    lines.push({ text: `Took ${duration((finish.ms - start.ms) / 1000)}${idle ? `, ${duration(idle)} of it idle` : ''}`, target: start.index });
  }
  const ticks = run.filter((e) => e.event === 'tick');
  const ticked = new Set(ticks.map((e) => e.task ?? e.summary));
  if (ticks.length) {
    const n = ticked.size;
    lines.push({ text: taskTotal ? `${n} of ${plural(taskTotal, 'task')} completed` : `${plural(n, 'task')} completed`, target: (ticks[ticks.length - 1] as TimelineEntry).index });
  }

  // checks: the verdicts at finish, then the task checks with their fix rounds
  const checks = finishChecks(finish.data['checks']);
  if (checks.length) {
    const ran = checks.filter((c) => !c.skipped);
    const passed = NAMED.filter((n) => ran.some((c) => c.name === n && c.ok));
    const failed = NAMED.filter((n) => ran.some((c) => c.name === n && !c.ok));
    const spec = ran.filter((c) => !NAMED.includes(c.name));
    const parts = [
      ...(passed.length ? [`${names(passed)} passed`] : []),
      ...(failed.length ? [`${names(failed)} failed`] : []),
      ...(spec.length ? [`${spec.filter((c) => c.ok).length} of ${plural(spec.length, 'spec check')} passed`] : []),
    ];
    if (parts.length) lines.push({ text: `At finish: ${parts.join('; ')}`, target: finish.index });
    for (const c of checks) {
      if (c.skipped) open.push({ text: `${c.name} not run at finish: ${c.skipped}`, target: finish.index });
      else if (!c.ok) open.push({ text: `${c.name} failed at finish`, target: finish.index });
      for (const u of c.untested) open.push({ text: `Untested scenario: ${u}`, target: finish.index });
    }
  } else {
    lines.push({ text: 'Finish passed', target: finish.index });
  }
  const taskChecks = run.filter((e) => e.event === 'check' && e.result);
  if (taskChecks.length) {
    const bad = taskChecks.filter((e) => e.result === 'failed');
    const rounds = run.filter((e) => e.event === 'fix-round').length;
    const text = `Task checks: ${taskChecks.length - bad.length} passed${bad.length ? `, ${bad.length} failed` : ''}${rounds ? ` (${plural(rounds, 'fix round')})` : ''}`;
    lines.push({ text, target: (bad[0] ?? (taskChecks[taskChecks.length - 1] as TimelineEntry)).index });
  }

  // visual: scenarios and defects of the checks that ran; a skipped check is open
  const visual = run.filter((e) => e.event === 'visual');
  const ran = visual.filter((e) => !/^visual check skipped/i.test(e.summary));
  if (ran.length) {
    const scen = ran.reduce((s, e) => s + Number(/(\d+) visual scenario/.exec(e.summary)?.[1] ?? 0), 0);
    const defects = ran.reduce((s, e) => s + Number(/(\d+) defect/.exec(e.summary)?.[1] ?? 0), 0);
    lines.push({ text: `Visual: ${plural(scen, 'scenario')} checked, ${defects ? plural(defects, 'defect') : 'no defects'}`, target: (ran[ran.length - 1] as TimelineEntry).index });
  }
  for (const e of visual.filter((v) => !ran.includes(v))) {
    open.push({ text: `${e.task ? `Task ${e.task}: ` : ''}${e.summary.replace(/^visual check skipped:?\s*/i, 'visual check skipped: ')}`, target: e.index });
  }

  // review findings fixed: the Review fix progress entries; the proof says how many a test shows
  const fixes = new Map<string, TimelineEntry>();
  for (const e of run) {
    const m = e.event === 'progress' ? /^Review fix ([a-z0-9-]+):/.exec(e.summary) : null;
    if (m) fixes.set(m[1] as string, e);
  }
  const proofs = new Map<string, TimelineEntry>();
  for (const e of run) if (e.event === 'review-proof') proofs.set(e.task ?? '', e);
  const proven = [...proofs.values()].reduce((s, e) => s + (Array.isArray(e.data['proven']) ? e.data['proven'].length : 0), 0);
  const count = Math.max(fixes.size, proven);
  if (count) {
    const last = [...fixes.values(), ...proofs.values()].sort((a, b) => a.index - b.index).pop() as TimelineEntry;
    lines.push({ text: `${plural(count, 'review finding')} fixed${proven ? `, ${proven} shown by a fail-before/pass-after test` : ''}`, target: last.index });
  }
  for (const [slug, e] of fixes) {
    const u = /\(untestable: (.*)\)\s*$/.exec(e.summary);
    if (u) open.push({ text: `Review fix ${slug} has no test: ${u[1]}`, target: e.index });
  }

  // after finish: a failed check or sync is open
  for (const e of entries.slice(fin + 1)) if (e.result === 'failed') open.push({ text: `${e.step} failed${e.summary ? `: ${e.summary}` : ''}`, target: e.index });

  const d = finish.data['diff'];
  let diff: RunSummary['diff'];
  if (d && typeof d === 'object') {
    const r = d as Record<string, unknown>;
    const list = (Array.isArray(r['list']) ? r['list'] : []).flatMap((f: unknown) => {
      const x = (f && typeof f === 'object' ? f : {}) as Record<string, unknown>;
      return str(x['file']) ? [{ file: str(x['file']), added: num(x['added']), removed: num(x['removed']) }] : [];
    });
    diff = { files: num(r['files']), added: num(r['added']), removed: num(r['removed']), list, target: finish.index };
  }
  return { lines, open, ...(diff ? { diff } : {}) };
}
