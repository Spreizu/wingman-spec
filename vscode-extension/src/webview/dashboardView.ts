import type { ApprovalRow, BlockingItem, Dashboard, TaskStatus, TodoStep } from '../model/changeDashboard.ts';
import chrono from '../../../project-template/openspec/scripts/chronology.cjs';
import { agentAttr, badge, bar, cmdAttr, copyAttr, esc, icon, openAttr, pillRow, rich, termAttr } from './components.ts';
import type { Tone } from './components.ts';

export const TASK_STATUS: Record<TaskStatus, { label: string; tone: Tone } | undefined> = {
  verified: undefined,
  'ticked-unverified': { label: 'ticked, not verified', tone: 'warn' },
  'in-progress': { label: 'in progress', tone: 'info' },
  'review-pending': { label: 'review pending', tone: 'accent' },
  open: undefined,
};

/** One summary card. `dim`: nothing to report yet, so the value is muted and the border is not coloured. A sub-line is drawn only when it has content. */
function tile(label: string, value: string, extra: string, tone: Tone = 'muted', dim = false): string {
  return `<div class="tile tone-${dim ? 'muted' : tone}${dim ? ' empty' : ''}"><div class="k">${esc(label)}</div><div class="v">${esc(value)}</div>${extra ? `<div class="x">${extra}</div>` : ''}</div>`;
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

function step(s: TodoStep): string {
  if (s.kind === 'open') return `<div class="todo"><button class="btn" ${openAttr(s.path ?? '')}>${icon('external', 13)} ${esc(s.text)}</button></div>`;
  if (s.kind === 'agent') return `<div class="todo"><button class="btn" ${agentAttr(s.text)} title="Send ${esc(s.text)} to the agent chat">${icon('play', 13)} ${esc(s.text)}</button><button class="icon-btn" ${copyAttr(s.text)} title="Copy">${icon('copy', 13)}</button></div>`;
  return `<div class="todo"><code class="cmd">${esc(s.text)}</code><button class="icon-btn" ${copyAttr(s.text)} title="Copy the command">${icon('copy', 13)}</button><button class="btn" ${termAttr(s.text)} title="Types the command into a new terminal; you press Enter">${icon('play', 13)} Terminal</button></div>`;
}

/** The verifier's last records, oldest first, each with its time (HH:MM:SS, local zone). */
function activityBlock(d: Dashboard): string {
  const rows = (d.activity ?? []).map((e) => {
    const t = chrono.clock(e.at);
    return `<li>${t ? `<span class="muted" title="${esc(e.at)}">${esc(t)}</span> ` : ''}${esc(e.event)}${e.task ? ` ${esc(e.task)}` : ''} ${badge(e.ok ? 'passed' : 'failed', e.ok ? 'ok' : 'bad')}</li>`;
  });
  return rows.length ? `<h3 class="dash-h">Recent verifier activity</h3><ul class="bd activity">${rows.join('')}</ul>` : '';
}

function blocking(b: BlockingItem, skip: ReadonlySet<string>): string {
  const steps = b.todo.filter((s) => !(s.kind === 'agent' && skip.has(s.text)));
  return `<div class="block-item"><div class="bt">${icon('block', 15)} <strong>${rich(b.title)}</strong></div>
${b.detail.length ? `<ul class="bd">${b.detail.map((x) => `<li>${rich(x)}</li>`).join('')}</ul>` : ''}
${steps.length ? `<div class="steps"><span class="muted">What to do</span>${steps.map(step).join('')}</div>` : ''}</div>`;
}

/**
 * The archive blockers are news only once the implementation is done: every task ticked and a verifier run recorded. Before that, open
 * or unverified tasks are the expected state and the page header holds the next step, so the list is one collapsed, muted line.
 */
export function archiveFocus(d: Dashboard): boolean {
  return d.tasks.total > 0 && d.tasks.done === d.tasks.total && d.checks.known;
}

function archiveSection(d: Dashboard, loading: boolean, headerCmds: readonly string[]): string {
  if (!archiveFocus(d)) {
    if (!d.blocking.length) return '';
    const items = d.blocking.map((b) => `<li>${rich(b.title)}</li>`).join('');
    return `<details class="pre-archive"><summary>Before archive: ${plural(d.blocking.length, 'item')}</summary><ul class="bd">${items}</ul></details>`;
  }
  const refresh = `<button class="link" style="margin-left:auto" ${cmdAttr('refreshView')} title="Ask the verifier again">Refresh</button>`;
  if (loading) return `<h3 class="dash-h">Before archive${refresh}</h3><p class="muted">Checking with the verifier...</p>`;
  if (!d.blocking.length) return `<h3 class="dash-h">Before archive${refresh}</h3><p class="muted">Nothing blocks the archive.</p>`;
  const skip = new Set(headerCmds);
  return `<h3 class="dash-h">Blocking archive ${badge(String(d.blocking.length), 'warn')}${refresh}</h3>${d.blocking.map((b) => blocking(b, skip)).join('')}`;
}

function approvalRow(i: ApprovalRow): string {
  const what = i.status === 'removed' ? 'removed' : 'Why rewritten';
  const text = i.status === 'removed' ? i.was : `${i.was ?? ''} → ${i.now ?? ''}`;
  return `<div class="item"><div class="grow"><code>${esc(i.key)}</code> <span class="muted">${esc(text ?? '')}</span></div>${pillRow(`${badge(what, 'muted')}${i.approval === 'needed' ? badge('owner approval missing', 'bad') : badge('owner approved', 'ok')}`)}</div>`;
}

/**
 * The overview card at the top of a change page: tasks, checks, review, size, the requirements that need the owner, and what blocks the
 * archive. `headerCmds`: the agent commands the page header already offers; the blocker steps do not repeat them.
 */
export function dashboardCard(d: Dashboard, loading: boolean, headerCmds: readonly string[] = []): string {
  const t = d.tasks;
  const c = d.checks;
  const unverified = t.rows.filter((r) => r.status !== 'verified' && r.status !== 'open').length;
  const taskParts = [t.verified > 0 ? (t.verified === t.total ? 'all verified' : `${t.verified} verified`) : '', unverified ? `${unverified} to finish` : ''].filter(Boolean);
  const checkValue = !c.known ? 'no run yet' : c.passed || c.failed ? [c.passed ? `${c.passed} passed` : '', c.failed ? `${c.failed} failed` : ''].filter(Boolean).join(', ') : 'no checks yet';
  const checkParts = [c.lintErrors ? plural(c.lintErrors, 'lint error') : '', c.guardFindings ? plural(c.guardFindings, 'anchor finding') : ''].filter(Boolean);
  const reviewValue = d.review.visual === 'pending' ? 'visual review pending' : d.review.reviewTasksTotal ? `${d.review.reviewTasksDone}/${d.review.reviewTasksTotal} review tasks` : 'not started';
  const sizeParts = [d.size.planned > 0 ? plural(d.size.planned, 'implementation task') : '', d.size.risk ? `risk: ${esc(d.size.risk)}` : ''].filter(Boolean);
  const tiles = [
    t.total === 0
      ? tile('Tasks', 'No tasks yet', '', 'muted', true)
      : tile('Tasks', `${t.done}/${t.total}`, `${bar(t.done, t.total)}${taskParts.length ? `<span class="muted">${taskParts.join(', ')}</span>` : ''}`, t.done === t.total ? 'ok' : 'info'),
    tile('Checks', checkValue, c.exhausted ? badge('attempts exhausted', 'bad') : checkParts.length ? `<span class="muted">${checkParts.join(', ')}</span>` : '', c.failed || c.exhausted || c.lintErrors ? 'bad' : c.known ? 'ok' : 'muted', !c.known && !c.lintErrors && !c.exhausted),
    tile('Review', reviewValue, '', d.review.visual === 'pending' ? 'accent' : 'muted', d.review.visual !== 'pending' && !d.review.reviewTasksTotal),
    tile('Size', d.size.size ? `${d.size.size}${d.size.cap ? ` (up to ${d.size.cap} tasks)` : ''}` : 'not set', sizeParts.length ? `<span class="muted">${sizeParts.join('; ')}</span>` : '', d.size.over ? 'warn' : 'muted', !d.size.size && !d.size.over),
  ].join('');
  const notes = d.notes.length ? `<div class="muted dash-notes">${d.notes.map(rich).join('<br>')}</div>` : '';
  return `<section class="card dash"><div class="tiles">${tiles}</div>${notes}
${archiveSection(d, loading, headerCmds)}
${d.approvals.length ? `<h3 class="dash-h">Needs the owner</h3>${d.approvals.map(approvalRow).join('')}` : ''}${activityBlock(d)}</section>`;
}
