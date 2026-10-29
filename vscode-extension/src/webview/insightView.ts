import { join } from 'node:path';
import { lensText } from '../model/reqInsight.ts';
import type { ReqInsight } from '../model/reqInsight.ts';
import { badge, esc, icon, openAttr, pillRow, rich, routeAttr } from './components.ts';
import type { Tone } from './components.ts';

/** A pill that is also a link: same markup as `badge`, plus the data attribute the webview script routes on. */
export function linkBadge(text: string, tone: Tone, attr: string, title?: string): string {
  return `<span class="badge tone-${tone} link" ${attr} role="link" tabindex="0"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The Why, anchors, pending changes and ADRs of one requirement, as a line, pills and link rows. */
export function insightBlock(i: ReqInsight, root: string, codeRoot: string): string {
  const pills: string[] = [];
  pills.push(badge(i.scenarios.length ? `${i.testedCount}/${i.scenarios.length} scenarios tested` : 'no scenarios', i.scenarios.length && i.testedCount === i.scenarios.length ? 'ok' : 'warn'));
  pills.push(badge(plural(i.code.length, 'code anchor'), i.code.length ? 'info' : 'warn'));
  for (const p of i.pending) pills.push(linkBadge(`${p.op.toLowerCase()} by ${p.change}`, 'warn', routeAttr({ page: 'change', root, name: p.change, tab: 'specs' })));
  for (const a of i.adrs) pills.push(linkBadge(`ADR ${a.number}`, 'info', routeAttr({ page: 'adr', root, number: a.number }), a.title));
  for (const w of i.warnings.filter((x) => x.code === 'no-why')) pills.push(badge(w.text, 'warn'));

  return `<div class="insight">${i.why ? `<p class="why-line"><span class="muted">Why</span> ${rich(i.why)}</p>` : ''}${pillRow(pills.join(''))}
${anchorRows(i.code, i.scenarios.some((s) => s.tested) ? [] : i.tests, codeRoot)}</div>`;
}

type Where = { file: string; line: number };

/**
 * The `Code` and `Tests` link rows: one `file:line` button per anchor (tests listed once per place), each opens the file at that line.
 * `insightBlock` passes no tests when a scenario row already carries its test link: the aggregate list would repeat them (dozens, per requirement).
 */
export function anchorRows(code: Where[], testRefs: Where[], codeRoot: string): string {
  const link = (a: Where): string => `<button class="link" ${openAttr(join(codeRoot, a.file), a.line)}>${esc(a.file)}:${a.line + 1}</button>`;
  const row = (label: string, items: string[]): string => (items.length ? `<div class="anchor-row"><span class="muted">${label}</span>${items.join('')}</div>` : '');
  const seen = new Set<string>();
  const tests = testRefs.filter((t) => !seen.has(`${t.file}:${t.line}`) && seen.add(`${t.file}:${t.line}`));
  return `${row('Code', code.map(link))}${row('Tests', tests.map(link))}`;
}

/** The scenario's name: a real link (button, shared `link` class) to its test when it has one, plain text when it has none. */
export function scenarioLabel(i: ReqInsight, slug: string, nameHtml: string, codeRoot: string): string {
  const t = i.scenarios.find((x) => x.slug === slug)?.tests[0];
  return t ? `<button class="link scn-link" ${openAttr(join(codeRoot, t.file), t.line)} title="Open the test">${nameHtml}</button>` : `<span>${nameHtml}</span>`;
}

/** Test status of one scenario, as pills (shown in the scenario's header row). */
export function scenarioStatus(i: ReqInsight, slug: string, codeRoot: string): string {
  const s = i.scenarios.find((x) => x.slug === slug);
  if (!s) return '';
  if (!s.tested) return `<span class="scn-status">${badge('no test yet', 'warn')}</span>`;
  const t = s.tests[0];
  return `<span class="scn-status">${t ? `<button class="link" ${openAttr(join(codeRoot, t.file), t.line)}>${esc(t.file)}:${t.line + 1}</button>` : ''}</span>`;
}
