/**
 * The deterministic CLI actions the panel runs directly (`wingman-spec <action> --json`): when each is allowed, and what its JSON
 * answer says. Judgment work (propose, apply, resolving a sync conflict) stays an agent hand-off; these never need one.
 */
import { isAbsolute, join } from 'node:path';
import type { Dashboard, DashboardInputs } from './changeDashboard.ts';
import type { Change } from './types.ts';

export type CliAction = 'validate' | 'status' | 'sync' | 'archive' | 'doctor';
export const CLI_ACTIONS: ReadonlySet<string> = new Set<CliAction>(['validate', 'status', 'sync', 'archive', 'doctor']);

export interface ActionButton {
  action: CliAction;
  label: string;
  enabled: boolean;
  /** Why it is disabled: one line. */
  reason?: string;
  /** The page's one next step (a complete change: Sync, else Archive). */
  primary?: boolean;
}

/** One line of an answer; `file`/`line` make it a link, `requirement` groups it. */
export interface ActionLine {
  text: string;
  level: 'error' | 'warning' | 'info';
  file?: string;
  line?: number;
  requirement?: string;
}

export interface ActionResult {
  action: CliAction;
  change?: string;
  ok: boolean;
  summary: string;
  lines: ActionLine[];
}

const LABEL: Record<CliAction, string> = { validate: 'Validate', status: 'Status', sync: 'Sync', archive: 'Archive', doctor: 'Doctor' };

/** The CLI arguments of an action (the client adds `--root`). */
export function actionArgs(action: CliAction, change?: string): string[] {
  return [action, ...(change && action !== 'doctor' ? [change] : []), '--json'];
}

const btn = (action: CliAction, reason?: string): ActionButton => ({ action, label: LABEL[action], enabled: !reason, ...(reason ? { reason } : {}) });

/** The change page's buttons. Shown only when they make sense: Validate once there is a proposal, Sync and Archive once
 * every task is done (Sync not after it is synced). A shown button is disabled, with its reason, while a blocker holds;
 * on a complete change the first enabled of Sync and Archive is the primary action. */
export function changeActions(a: { change: Change; dashboard?: Dashboard; inputs?: DashboardInputs; trusted: boolean; running?: boolean }): ActionButton[] {
  const { change, dashboard, inputs } = a;
  const off = !a.trusted ? 'The workspace is not trusted, so the CLI is not run.' : a.running ? 'Another action is running.' : undefined;
  const hasProposal = change.artifacts.some((x) => x.id === 'proposal' && x.state === 'done');
  const open = change.taskTotal - change.taskDone;
  const tasksReason = change.taskTotal === 0 ? 'There are no tasks yet.' : open > 0 ? `${open} task${open === 1 ? ' is' : 's are'} still open.` : undefined;
  const sync = inputs?.sync;
  const syncReason = tasksReason ?? (inputs?.unavailable ? `Sync state unknown: ${inputs.unavailable}.` : !sync ? 'Checking the sync state...' : sync.ok ? 'Already synced.' : undefined);
  const others = (dashboard?.blocking ?? []).filter((b) => b.id !== 'unsynced-specs');
  const archiveReason =
    tasksReason ??
    (inputs?.unavailable ? `Sync state unknown: ${inputs.unavailable}.` : !sync ? 'Checking the sync state...' : !sync.ok ? 'Sync first: the specs or ADRs are not merged.' : others.length ? `${others.length} item${others.length === 1 ? ' blocks' : 's block'} the archive (listed below).` : undefined);
  const shown = [
    ...(hasProposal ? [btn('validate', off)] : []),
    btn('status', off),
    ...(tasksReason || sync?.ok ? [] : [btn('sync', off ?? syncReason)]),
    ...(tasksReason ? [] : [btn('archive', off ?? archiveReason)]),
  ];
  const next = change.state === 'complete' ? shown.find((b) => (b.action === 'sync' || b.action === 'archive') && b.enabled) : undefined;
  return shown.map((b) => (b === next ? { ...b, primary: true } : b));
}

export function projectActions(a: { trusted: boolean; running?: boolean }): ActionButton[] {
  return [btn('doctor', !a.trusted ? 'The workspace is not trusted, so the CLI is not run.' : a.running ? 'Another action is running.' : undefined)];
}

type J = Record<string, unknown>;
const obj = (v: unknown): J => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as J) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** `specs: path/to/x.md:12: not merged: requirement "Alpha" differs ...` as a located line. */
export function problemLine(s: string, codeRoot: string, level: ActionLine['level'] = 'error'): ActionLine {
  const m = /^(?:[a-z]+: )?([^\s:][^:]*\.md):(\d+): (.*)$/s.exec(s);
  const requirement = /[Rr]equirement "([^"]+)"/.exec(s)?.[1];
  const base: ActionLine = { text: m ? (m[3] ?? s) : s, level, ...(requirement ? { requirement } : {}) };
  if (!m || !m[1]) return base;
  return { ...base, file: isAbsolute(m[1]) ? m[1] : join(codeRoot, m[1]), line: Number(m[2]) };
}

function parse(stdout: string): J | undefined {
  try {
    return obj(JSON.parse(stdout));
  } catch {
    return undefined;
  }
}

/** Reads the answer of `wingman-spec <action> --json`. A refusal (exit 1 with JSON) is a result, not an error. */
export function readAction(action: CliAction, change: string | undefined, r: { code: number | null; stdout: string; stderr: string }, codeRoot: string): ActionResult {
  const j = parse(r.stdout);
  const base = { action, ...(change ? { change } : {}) };
  if (!j) {
    const why = (r.stderr || r.stdout).trim().split('\n')[0] || `exit code ${r.code}`;
    return { ...base, ok: false, summary: `${LABEL[action]} failed: ${why}`, lines: [] };
  }
  const lines = (v: unknown, level: ActionLine['level']): ActionLine[] => arr(v).flatMap((x) => (typeof x === 'string' ? [problemLine(x, codeRoot, level)] : []));
  switch (action) {
    case 'validate': {
      const issues = arr(j['items']).flatMap((it) => arr(obj(it)['issues'])).map(obj);
      const out = issues.map((i): ActionLine => {
        const file = str(i['file']);
        const requirement = /[Rr]equirement "([^"]+)"/.exec(str(i['message']) ?? '')?.[1];
        return { text: str(i['message']) ?? '', level: i['level'] === 'warning' ? 'warning' : i['level'] === 'info' ? 'info' : 'error', ...(file ? { file: isAbsolute(file) ? file : join(codeRoot, file) } : {}), ...(typeof i['line'] === 'number' ? { line: i['line'] } : {}), ...(requirement ? { requirement } : {}) };
      });
      const errors = out.filter((l) => l.level === 'error').length;
      return { ...base, ok: j['valid'] === true, summary: j['valid'] === true ? 'Valid.' : `Not valid: ${plural(errors, 'error')}.`, lines: out };
    }
    case 'status': {
      const apply = obj(j['apply']);
      const prog = obj(apply['progress']);
      const todo = arr(j['artifacts']).map(obj).filter((x) => x['status'] !== 'done');
      const parts = [
        typeof prog['total'] === 'number' ? `Tasks ${String(prog['complete'] ?? 0)}/${String(prog['total'])} done` : 'No tasks yet',
        str(apply['next']) ? `next: ${str(apply['next'])}` : '',
        str(apply['run_status']) ? `run: ${str(apply['run_status'])}` : '',
      ].filter(Boolean);
      const out = todo.map((x): ActionLine => ({ text: `${str(x['id']) ?? '?'}: ${str(x['status']) ?? '?'}${arr(x['missingDeps']).length ? ` (needs ${arr(x['missingDeps']).filter((d) => typeof d === 'string').join(', ')})` : ''}`, level: 'info' }));
      return { ...base, ok: true, summary: `${parts.join('; ')}.`, lines: out };
    }
    case 'sync': {
      const problems = lines(j['problems'], 'error');
      if (problems.length) return { ...base, ok: false, summary: `Not synced: ${plural(problems.length, 'conflict')}, nothing was written.`, lines: problems };
      const caps = arr(j['capabilities']).length;
      const adrs = arr(j['adrs']).length;
      const did = [caps ? `${plural(caps, 'capability')} merged` : '', adrs ? `${plural(adrs, 'ADR')} promoted` : ''].filter(Boolean);
      return { ...base, ok: true, summary: did.length ? `Synced: ${did.join(', ')}.` : 'Synced: nothing to merge.', lines: [] };
    }
    case 'archive': {
      if (j['result'] === 'archived') {
        const dir = str(j['dir']) ?? '';
        return { ...base, ok: true, summary: `Archived to ${dir.split(/[\\/]/).pop() ?? dir}. The move is left uncommitted for you to review.`, lines: lines(j['warnings'], 'warning') };
      }
      const problems = lines(j['problems'], 'error');
      return { ...base, ok: false, summary: `Not archived: ${problems.length ? plural(problems.length, 'sync conflict') : str(j['result']) ?? 'refused'}.`, lines: problems };
    }
    case 'doctor': {
      const problems = lines(j['problems'], 'error');
      const warnings = lines(j['warnings'], 'warning');
      return { ...base, ok: j['ok'] === true, summary: j['ok'] === true ? (warnings.length ? `Setup works, with ${plural(warnings.length, 'warning')}.` : 'Setup works.') : `Setup incomplete: ${plural(problems.length, 'problem')}.`, lines: [...problems, ...warnings] };
    }
  }
}
