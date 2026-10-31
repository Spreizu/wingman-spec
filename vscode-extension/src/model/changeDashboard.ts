/**
 * The change dashboard: tasks and their verification status, checks passed/failed, review state, size, the requirements whose Why is rewritten or that are removed, and the
 * list of what still blocks the archive, each with what to do. Pure: the run files and the verifier answers come in as inputs.
 */
import chrono from '../core/chronology.ts';
import quality from '../core/plan.ts';
import type { TraceChange, TraceGap } from './traceability.ts';
import type { Change, Task } from './types.ts';
import type { SyncCheckReport, VerifierFinding } from './verifier.ts';

/** What `wingman-spec` wrote under `runs/<change>/` of the specs root: the current run's state and metrics, and the ledger of verified tasks. */
export interface RunFiles {
  runId?: string;
  state?: string;
  metrics?: string;
  ledger?: string;
}

export interface RunEvent {
  /** When it happened (ISO 8601, to the second); empty when the record has no time. */
  at: string;
  task: string;
  event: string;
  ok: boolean;
  attempt: number;
  failures: string[];
}

export interface RunSummary {
  runId: string;
  /** The task label the verifier handed out last and has not closed yet. */
  task?: string;
  attempts: number;
  lastFailure?: string;
  reviewPending: boolean;
  checksPassed: number;
  checksFailed: number;
  exhausted: boolean;
  recent: RunEvent[];
  /** Task descriptions (`1.1 Title`) the verifier passed (or that were ticked before it first ran). */
  verified: string[];
}

const parse = (text: string | undefined): Record<string, unknown> | undefined => {
  if (!text) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

export function summarizeRun(files: RunFiles): RunSummary | undefined {
  const state = parse(files.state);
  const ledger = parse(files.ledger);
  const parsed: (Record<string, unknown> & { at: string })[] = [];
  for (const l of (files.metrics ?? '').split('\n')) {
    const e = parse(l);
    if (e) parsed.push({ ...e, at: typeof e['at'] === 'string' ? e['at'] : '' });
  }
  const events = chrono.sortRecords(parsed); // by time, to the second; equal times keep the order they were written
  if (!state && !ledger && events.length === 0) return undefined;

  const task = state?.['task'] as { label?: unknown } | null | undefined;
  const review = state?.['review'];
  let passed = 0;
  let failed = 0;
  let exhausted = false;
  const recent: RunEvent[] = [];
  for (const e of events) {
    const kind = String(e['event'] ?? '');
    if (kind !== 'check' && kind !== 'finish' && kind !== 'review') continue;
    const ok = e['ok'] === true;
    if (kind !== 'review') {
      if (ok) passed++;
      else failed++;
    }
    if (e['exhausted'] === true) exhausted = true;
    recent.push({ at: e.at, task: typeof e['task'] === 'string' ? e['task'] : '', event: kind, ok, attempt: typeof e['attempt'] === 'number' ? e['attempt'] : 0, failures: strs(e['failures']) });
  }
  const passedMap = (ledger?.['passed'] ?? {}) as Record<string, unknown>;
  return {
    runId: files.runId ?? '',
    ...(typeof task?.label === 'string' ? { task: task.label } : {}),
    attempts: typeof state?.['attempts'] === 'number' ? state['attempts'] : 0,
    ...(typeof state?.['last_failure'] === 'string' && state['last_failure'] ? { lastFailure: state['last_failure'] } : {}),
    reviewPending: typeof review === 'object' && review !== null,
    checksPassed: passed,
    checksFailed: failed,
    exhausted,
    recent: recent.slice(-8),
    verified: [...strs(ledger?.['baseline']), ...chrono.sortRecords(Object.entries(passedMap).map(([k, v]) => ({ at: String((v as { at?: unknown } | null)?.at ?? ''), k }))).map((x) => x.k)],
  };
}

/** `Size: S|M|L` and `Risk: ...` of proposal.md (`plan.proposalSize`, the CLI's reading). */
export function proposalSize(text: string | undefined): { size?: 'S' | 'M' | 'L'; risk?: string } {
  const p = quality.proposalSize(text ?? '');
  return { ...(p.size ? { size: p.size } : {}), ...(p.risk ? { risk: p.risk.length ? p.risk.join(', ') : 'none' } : {}) };
}

export const SIZE_CAP = quality.CAPS;

export type TaskStatus = 'verified' | 'ticked-unverified' | 'in-progress' | 'review-pending' | 'open';

export interface TaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  isReview: boolean;
  line: number;
}

export interface TodoStep {
  kind: 'terminal' | 'agent' | 'open';
  /** The command to copy or run; for `open`, a label. */
  text: string;
  path?: string;
  line?: number;
}

export interface BlockingItem {
  id: 'unsynced-specs' | 'open-tasks' | 'failing-checks' | 'owner-approval' | 'drift-gaps' | 'visual-review';
  title: string;
  detail: string[];
  todo: TodoStep[];
}

/** A requirement of the change that needs the owner: its Why is rewritten, or it is removed. */
export interface ApprovalRow {
  key: string;
  status: 'changed' | 'removed';
  was: string | null;
  now: string | null;
  approval: 'needed' | 'given';
}

export interface Dashboard {
  tasks: { total: number; done: number; verified: number; rows: TaskRow[] };
  checks: { known: boolean; passed: number; failed: number; lastFailure?: string; exhausted: boolean; lintErrors: number; guardFindings: number; attempts: number };
  review: { reviewTasksDone: number; reviewTasksTotal: number; visual: 'pending' | 'none' };
  size: { size?: 'S' | 'M' | 'L'; cap?: number; planned: number; over: boolean; risk?: string };
  approvals: ApprovalRow[];
  /** The verifier's last records of this change's run (checks, finish, review), oldest first by time. */
  activity?: RunEvent[];
  blocking: BlockingItem[];
  /** What could not be checked (verifier not run, script missing): the blocking list is then incomplete. */
  notes: string[];
}

export interface DashboardInputs {
  run?: RunSummary;
  findings?: VerifierFinding[];
  sync?: SyncCheckReport;
  /** Why the verifier answers are missing. */
  unavailable?: string;
  loading?: boolean;
}

export interface DashboardArgs {
  change: Change;
  proposalText?: string;
  traceChange?: TraceChange;
  /** Open drift gaps of the project from the extension's own trace model (used when the verifier did not answer). */
  gaps?: TraceGap[];
  inputs: DashboardInputs;
  /** The command a person types for `wingman-spec <args>`. */
  cmd: (args: string) => string;
}

const description = (t: Task): string => `${t.id} ${t.title}`.trim();

export function taskRows(change: Change, run: RunSummary | undefined): TaskRow[] {
  const verified = new Set((run?.verified ?? []).map((d) => d.trim()));
  const rows: TaskRow[] = [];
  for (const g of change.groups) {
    for (const t of g.tasks) {
      let status: TaskStatus = 'open';
      if (run?.task && t.id === run.task && !t.checked) status = run.reviewPending ? 'review-pending' : 'in-progress';
      else if (t.checked) status = !run || verified.has(description(t)) ? 'verified' : 'ticked-unverified';
      rows.push({ id: t.id, title: t.title, status, isReview: t.isReview, line: t.line });
    }
  }
  return rows;
}

export function buildDashboard(a: DashboardArgs): Dashboard {
  const { change, inputs } = a;
  const run = inputs.run;
  const notes: string[] = [];
  if (inputs.unavailable) notes.push(`Not checked: ${inputs.unavailable}. Sync, check and drift items below may be missing.`);
  if (!run && change.taskTotal > 0) notes.push('No run recorded for this change yet (it starts with `next`).');

  const rows = taskRows(change, run);
  const impl = change.groups.reduce((n, g) => n + g.tasks.filter((t) => quality.isImplementationTask(g.title, t.id, t.title)).length, 0);
  const proposal = proposalSize(a.proposalText);
  const cap = proposal.size ? SIZE_CAP[proposal.size] : undefined;

  const findings = inputs.findings ?? [];
  const mine = findings.filter((f) => f.change === change.name);
  const lintErrors = mine.filter((f) => f.source === 'lint' && f.severity === 'error');
  const guardFindings = mine.filter((f) => f.source === 'guard');
  const driftErrors = findings.filter((f) => f.source === 'drift' && f.severity === 'error');

  const approvals: ApprovalRow[] = (a.traceChange?.approvals ?? []).map((x) => ({ key: x.key, status: x.status, was: x.was, now: x.now, approval: a.traceChange?.approval ? 'given' : 'needed' }));

  const blocking: BlockingItem[] = [];
  const open = rows.filter((r) => r.status !== 'verified');
  if (open.length) {
    blocking.push({
      id: 'open-tasks',
      title: `${open.length} task${open.length === 1 ? '' : 's'} not verified`,
      detail: open.slice(0, 6).map((r) => `${r.id} ${r.title} (${r.status.replace('-', ' ')})`).concat(open.length > 6 ? [`and ${open.length - 6} more`] : []),
      todo: [{ kind: 'agent', text: `/spec-apply ${change.name}` }, { kind: 'terminal', text: a.cmd(`next ${change.name}`) }],
    });
  }
  const failing: string[] = [];
  if (run?.exhausted) failing.push('attempts are exhausted for a task: the verifier stops until the plan or the task is changed');
  if (run?.lastFailure) failing.push(`last rejection: ${run.lastFailure.split('\n')[0]}`);
  for (const f of lintErrors.slice(0, 4)) failing.push(`${f.code}: ${f.message.split('\n')[0]?.slice(0, 160)}`);
  if (lintErrors.length > 4) failing.push(`and ${lintErrors.length - 4} more lint errors`);
  for (const f of guardFindings.filter((x) => x.severity === 'error').slice(0, 3)) failing.push(`${f.code}: ${f.message.split('\n')[0]?.slice(0, 160)}`);
  if (failing.length) {
    blocking.push({
      id: 'failing-checks',
      title: 'Checks failing',
      detail: failing,
      todo: [{ kind: 'terminal', text: a.cmd(`check ${change.name}`) }, { kind: 'terminal', text: a.cmd(`lint ${change.name}`) }, { kind: 'agent', text: `/spec-fix ${change.name}` }],
    });
  }
  const needsApproval = approvals.filter((i) => i.approval === 'needed');
  if (needsApproval.length) {
    blocking.push({
      id: 'owner-approval',
      title: 'Owner approval missing',
      detail: needsApproval.map((i) => `${i.key} ${i.status === 'removed' ? 'is removed' : 'gets a new Why'} by this change; the proposal needs an \`Owner approval: <name>, <date>\` line from the owner`),
      todo: [{ kind: 'open', text: 'Open proposal.md', path: `${change.dir}/proposal.md` }],
    });
  }
  if (inputs.sync && !inputs.sync.ok) {
    blocking.push({
      id: 'unsynced-specs',
      title: 'Specs or ADRs not synced',
      detail: inputs.sync.problems.slice(0, 6).concat(inputs.sync.problems.length > 6 ? [`and ${inputs.sync.problems.length - 6} more`] : []),
      todo: [],
    });
  } else if (!inputs.sync && !change.adrsSynced) {
    blocking.push({ id: 'unsynced-specs', title: 'ADRs not synced', detail: ['At least one ADR is not promoted or out of date.'], todo: [] });
  }
  const gaps = inputs.findings ? driftErrors.filter((f) => f.severity === 'error') : (a.gaps ?? []).filter((g) => !g.accepted);
  if (gaps.length) {
    blocking.push({
      id: 'drift-gaps',
      title: `${gaps.length} drift gap${gaps.length === 1 ? '' : 's'} open`,
      detail: gaps.slice(0, 6).map((g) => ('code' in g ? `${g.code}: ${g.message.split('\n')[0]?.slice(0, 140)}` : `${g.type}: ${g.text.slice(0, 140)}`)),
      todo: [{ kind: 'terminal', text: a.cmd('drift') }, { kind: 'agent', text: `/spec-fix ${change.name}` }],
    });
  }
  if (run?.reviewPending) {
    blocking.push({
      id: 'visual-review',
      title: 'Visual review pending',
      detail: [`task ${run.task ?? ''} passed its checks and waits for the visual review (screenshots are compared by the spec-visual-reviewer subagent)`],
      todo: [{ kind: 'agent', text: `/spec-apply ${change.name}` }],
    });
  }

  // Sync and Archive are buttons that run the CLI (model/cliActions.ts); a sync conflict is handed to the agent from their answer.
  const unsynced = blocking.find((b) => b.id === 'unsynced-specs');
  if (unsynced) unsynced.detail = [...unsynced.detail, blocking.length === 1 ? 'Sync merges them; then Archive.' : 'Sync merges them once the other items are done.'];

  const reviewTasks = rows.filter((r) => r.isReview);
  return {
    tasks: { total: rows.length, done: change.taskDone, verified: rows.filter((r) => r.status === 'verified').length, rows },
    checks: { known: !!run, passed: run?.checksPassed ?? 0, failed: run?.checksFailed ?? 0, ...(run?.lastFailure ? { lastFailure: run.lastFailure } : {}), exhausted: !!run?.exhausted, lintErrors: lintErrors.length, guardFindings: guardFindings.length, attempts: run?.attempts ?? 0 },
    review: { reviewTasksDone: reviewTasks.filter((r) => r.status === 'verified').length, reviewTasksTotal: reviewTasks.length, visual: run?.reviewPending ? 'pending' : 'none' },
    size: { ...(proposal.size ? { size: proposal.size } : {}), ...(cap ? { cap } : {}), planned: impl, over: cap !== undefined && impl > cap, ...(proposal.risk ? { risk: proposal.risk } : {}) },
    approvals,
    ...(run && run.recent.length > 0 ? { activity: run.recent } : {}),
    blocking,
    notes,
  };
}
