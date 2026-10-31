import type { ActionButton, ActionLine, ActionResult } from '../model/cliActions.ts';
import { agentButton, esc, icon, openAttr, rich } from './components.ts';

/** A button that runs the CLI here. Disabled, it says why in its tooltip; the reasons are also listed under the row. */
function cliButton(b: ActionButton, root: string, change: string | undefined, running: string | undefined): string {
  const busy = running === b.action;
  const label = busy ? `${b.label}...` : b.label;
  if (!b.enabled || running) return `<button class="btn cli" disabled title="${esc(b.reason ?? 'Another action is running.')}">${icon('run', 13)} ${esc(label)}</button>`;
  return `<button class="btn cli${b.primary ? ' primary' : ''}" data-cli="${esc(b.action)}" data-root="${esc(root)}"${change ? ` data-change="${esc(change)}"` : ''} title="Runs wingman-spec ${esc(b.action)}${change ? ` ${esc(change)}` : ''} here">${icon('run', 13)} ${esc(label)}</button>`;
}

function line(l: ActionLine): string {
  const where = l.file ? `<button class="link" ${openAttr(l.file, l.line)}>${esc(l.file.split(/[\\/]/).pop() ?? l.file)}${l.line ? `:${l.line}` : ''}</button> ` : '';
  return `<li>${where}${rich(l.text)}</li>`;
}

/** The last answer: one quiet line on success; problems are listed per requirement, each linking to its file and line. */
export function actionResult(r: ActionResult): string {
  const groups = new Map<string, ActionLine[]>();
  for (const l of r.lines) groups.set(l.requirement ?? '', [...(groups.get(l.requirement ?? '') ?? []), l]);
  const lists = [...groups].map(([req, ls]) => `${req ? `<div class="req">Requirement: ${esc(req)}</div>` : ''}<ul>${ls.map(line).join('')}</ul>`).join('');
  const resolve = !r.ok && (r.action === 'sync' || r.action === 'archive') && r.change && r.lines.length ? `<div class="row" style="margin-top:8px">${agentButton(`/spec-sync ${r.change}`, 'Resolve with agent')}</div>` : '';
  return `<div class="result tone-${r.ok ? 'ok' : 'bad'}" role="status"><span class="${r.ok ? 'muted' : ''}">${esc(r.summary)}</span>${lists}${resolve}</div>`;
}

/** The row of CLI actions with the reasons the disabled ones cannot run, and the last answer. */
export function actionBar(buttons: readonly ActionButton[], root: string, change: string | undefined, running: string | undefined, result: ActionResult | undefined): string {
  const why = buttons.filter((b) => !b.enabled && b.reason && !running);
  return `<section class="card actions"><div class="row"><span class="muted">Run here</span>${buttons.map((b) => cliButton(b, root, change, running)).join('')}</div>
${why.length ? `<ul class="why muted">${why.map((b) => `<li>${esc(b.label)}: ${esc(b.reason ?? '')}</li>`).join('')}</ul>` : ''}${result ? actionResult(result) : ''}</section>`;
}
