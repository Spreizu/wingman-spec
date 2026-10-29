import { join } from 'node:path';
import chrono from '../../../project-template/openspec/scripts/chronology.cjs';
import { escapeHtml as esc, plain } from '../model/markdown.ts';
import type { ProjectModel, TimeStamp } from '../model/types.ts';
import type { Route } from './types.ts';

export { esc, plain };

/** Free text from the verifier or the model, shown as HTML: escaped, with `backtick` spans drawn as <code> (a literal backtick never reaches the page). */
export const rich = (s: string): string => esc(s).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/`/g, '');

/** The same text for an attribute or a plain-text slot: no backtick marks. */

const ICONS = {
  check: '<path d="M3 8.5l3.2 3L13 4.5"/>',
  circle: '<circle cx="8" cy="8" r="5.5"/>',
  dash: '<path d="M4 8h8"/>',
  alert: '<path d="M8 2l6.5 11.5h-13z"/><path d="M8 6.5v3M8 11.5v.01"/>',
  block: '<circle cx="8" cy="8" r="5.5"/><path d="M4 12L12 4"/>',
  file: '<path d="M4 1.8h5l3 3v9.4H4z"/><path d="M9 1.8v3h3"/>',
  list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8"/><path d="M2.5 4h.01M2.5 8h.01M2.5 12h.01"/>',
  adr: '<circle cx="4" cy="4" r="1.8"/><circle cx="4" cy="12" r="1.8"/><circle cx="12" cy="8" r="1.8"/><path d="M4 5.8v4.4M5.7 4.6C9 5 10 6 10.3 7"/>',
  home: '<path d="M2 7.5L8 2.5l6 5M3.5 6.5v7h9v-7"/>',
  arrow: '<path d="M3 8h10M9 4l4 4-4 4"/>',
  back: '<path d="M13 8H3M7 4L3 8l4 4"/>',
  play: '<path d="M5 3l8 5-8 5z"/>',
  copy: '<rect x="5" y="5" width="8" height="8.5" rx="1"/><path d="M3 10.5V3h7.5"/>',
  external: '<path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M12 9v4.5H2.5V4H7"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2L14 14"/>',
  layers: '<path d="M8 2l6 3.2-6 3.2-6-3.2z"/><path d="M2 8.2l6 3.2 6-3.2M2 11l6 3 6-3"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 4.8V8l2.2 1.4"/>',
  chevron: '<path d="M6 3.5L10.5 8 6 12.5"/>',
  plus: '<path d="M8 3v10M3 8h10"/>',
  archive: '<path d="M2.5 3.5h11v3h-11zM3.5 6.5v6.5h9V6.5M6.5 9h3"/>',
  branch: '<circle cx="4" cy="3.5" r="1.6"/><circle cx="4" cy="12.5" r="1.6"/><circle cx="12" cy="6" r="1.6"/><path d="M4 5.1v5.8M12 7.6c0 2.6-3.6 2.2-8 3.6"/>',
  graph: '<circle cx="3.5" cy="8" r="1.8"/><circle cx="12.5" cy="4" r="1.8"/><circle cx="12.5" cy="12" r="1.8"/><path d="M5.3 7.4l5.4-2.8M5.3 8.6l5.4 2.8"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 16): string {
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'accent' | 'muted';

/** The pill/badge row at the foot of a card or list item: one shared container so every card has the same gap, wrapping and top spacing. */
export function pillRow(inner: string): string {
  return `<div class="pills">${inner}</div>`;
}

/** The text column of an attention row: a title line and a muted line under it. Each truncates in its own box, so neither can overlap the other. */
export const attMain = (title: string, text: string): string =>
  `<span class="att-main"><span class="att-title" title="${esc(plain(title))}">${rich(title)}</span><span class="att-text muted" title="${esc(plain(text))}">${rich(text)}</span></span>`;

/** A pill carries information: an empty value, "none", "n/a" or "0" says nothing, so no pill is drawn. */
export const isEmptyPill = (text: string): boolean => /^(|none|n\/a|0)$/i.test(text.trim());

/** `2026-10-28 14:03:22` (local zone): the date, and the time of day when the stamp has one; empty when nothing is known. */
export function whenText(date: string, stamp: TimeStamp | undefined): string {
  const t = stamp && stamp.source !== 'name' && stamp.source !== 'none' ? chrono.clock(stamp.ms) : '';
  const day = date || (stamp && stamp.source !== 'none' ? chrono.when(stamp).slice(0, 10) : '');
  return day ? (t ? `${day} ${t}` : day) : 'undated';
}
/** Tooltip for a time: where it came from (recorded at archive time, or a fallback for older folders). */
export function whenTitle(stamp: TimeStamp | undefined, what: string): string {
  return stamp && stamp.source !== 'none' ? `${what}: ${chrono.when(stamp)} (${chrono.SOURCE_TEXT[stamp.source] ?? ''})` : what;
}

export function badge(text: string, tone: Tone = 'muted', title?: string): string {
  if (isEmptyPill(text)) return '';
  return `<span class="badge tone-${tone}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;
}

/** The progress ring of a change. With no tasks there is nothing to show, so no ring is drawn. */
export function ring(done: number, total: number, size = 56, tone?: Tone): string {
  if (total === 0) return '';
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const t: Tone = tone ?? (total > 0 && done === total ? 'ok' : 'info');
  return `<span class="ring tone-${t}" style="width:${size}px;height:${size}px" title="${done} of ${total} tasks">
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}"><circle class="ring-bg" cx="${size / 2}" cy="${size / 2}" r="${r}"/><circle class="ring-fg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-dasharray="${((pct / 100) * c).toFixed(2)} ${c.toFixed(2)}" transform="rotate(-90 ${size / 2} ${size / 2})"/></svg>
<span class="ring-label" style="font-size:${size < 50 ? 10 : 12}px">${pct}%</span></span>`;
}

export function bar(done: number, total: number, tone?: Tone): string {
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  const t: Tone = tone ?? (total > 0 && done === total ? 'ok' : 'info');
  return `<span class="bar tone-${t}"><span style="width:${pct}%"></span></span>`;
}

export function routeAttr(route: Route): string {
  return `data-route="${esc(JSON.stringify(route))}"`;
}

export function openAttr(path: string, line?: number): string {
  return `data-open="${esc(path)}"${line === undefined ? '' : ` data-line="${line}"`}`;
}

export function copyAttr(text: string): string {
  return `data-copy="${esc(text)}"`;
}

/** Types a verify-task command into a new terminal without running it (the person presses Enter). */
export function termAttr(command: string): string {
  return `data-term="${esc(command)}"`;
}

/** Sends a /spec-* prompt to the agent chat (validated by the spec-guard rules in the extension host). */
export function agentAttr(prompt: string): string {
  return `data-agent="${esc(prompt)}"`;
}

/** Runs one of the whitelisted scaffold commands with string arguments. */
export function cmdAttr(id: string, ...args: string[]): string {
  return `data-cmd="${esc(id)}" data-args="${esc(JSON.stringify(args))}"`;
}

export function agentButton(prompt: string, label: string, primary = false): string {
  return `<button class="btn${primary ? ' primary' : ''}" ${agentAttr(prompt)} title="Send ${esc(prompt)} to the agent chat">${icon('play', 13)} ${esc(label)}</button>`;
}

export function findProject(projects: ProjectModel[], root: string | undefined): ProjectModel | undefined {
  return projects.find((p) => p.root === root) ?? projects[0];
}

export function baseSpecPath(root: string, name: string): string {
  return join(root, 'openspec', 'specs', name, 'spec.md');
}

/** The none record of a change: one muted line, never a card, pill or count. */
export function noDecisionLine(items: { path: string; reason: string }[]): string {
  return items
    .map((n) => `<p class="muted no-decision">No architectural decision${n.reason ? `: ${esc(n.reason)}` : ''} <button class="link" ${openAttr(n.path)}>Open</button></p>`)
    .join('');
}

export function emptyState(title: string, hint: string): string {
  return `<div class="empty">${icon('layers', 28)}<h3>${esc(title)}</h3><p>${hint}</p></div>`;
}

export function pageHeader(title: string, subtitle: string, aside = '', back = true): string {
  return `<header class="page-head">
${back ? `<button class="icon-btn" data-action="back" title="Back">${icon('back')}</button>` : ''}
<div class="titles"><h1>${rich(title)}</h1>${subtitle ? `<div class="sub">${subtitle}</div>` : ''}</div>
<div class="aside">${aside}</div></header>`;
}
