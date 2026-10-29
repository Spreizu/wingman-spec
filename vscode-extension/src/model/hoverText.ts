/** Markdown of the marker/tag hover: the requirement in plain words, scenarios with tested status, ADRs, pending changes, all with links. */
import { join } from 'node:path';
import { plain } from './markdown.ts';
import type { Route } from '../webview/types.ts';
import type { ReqInsight, UnresolvedInfo } from './reqInsight.ts';

/** The commands a hover link may call: the hover's trust list names exactly these. */
export const HOVER_COMMANDS = ['wingmanSpec.revealRequirement', 'wingmanSpec.revealScenario', 'wingmanSpec.openFile', 'wingmanSpec.openRoute', 'wingmanSpec.runTests', 'wingmanSpec.fixMarker'];

const md = (s: string): string => plain(s).replace(/([\\`*_{}[\]<>#|()])/g, '\\$1');

/** `[label](command:id?args)`: a hover link that runs an extension command. */
export function commandLink(label: string, command: string, args: unknown[], title?: string): string {
  return `[${md(label)}](command:${command}?${encodeURIComponent(JSON.stringify(args))}${title ? ` "${title.replace(/"/g, "'")}"` : ''})`;
}

export interface HoverContext {
  root: string;
  codeRoot: string;
  /** The test command is configured and the run-tests setting is on. */
  canRun: boolean;
  /** For a hover on a test tag: the scenario slug to emphasise. */
  scenario?: string;
}

const where = (codeRoot: string, a: { file: string; line: number }): string => commandLink(`${a.file}:${a.line + 1}`, 'wingmanSpec.openFile', [join(codeRoot, a.file), a.line]);

export function hoverInsight(i: ReqInsight, c: HoverContext): string {
  const out: string[] = [`**${md(i.name)}** · \`${i.key}\``, '', md(i.statement)];
  out.push('', i.why ? `**Why**: ${md(i.why)}` : 'Warning: No `Why:` line: who wants this, and why?');

  if (i.scenarios.length) {
    out.push('', `**Scenarios** (${i.testedCount}/${i.scenarios.length} tested)`);
    for (const s of i.scenarios) {
      const name = s.slug === c.scenario ? `**${md(s.name)}**` : md(s.name);
      const given = s.steps.map((st) => `${st.keyword} ${st.text}`).join(' / ');
      const status = s.tested ? `tested in ${s.tests.map((t) => where(c.codeRoot, t)).join(', ')}` : 'no test yet';
      out.push(`- ${commandLink(s.name, 'wingmanSpec.revealScenario', [c.root, i.key, s.slug]).replace(`[${md(s.name)}]`, `[${name}]`)}: ${status}`);
      if (given) out.push(`  - ${md(given)}`);
    }
  }
  if (i.adrs.length) out.push('', `**Related ADRs**: ${i.adrs.map((a) => commandLink(`${a.number} ${a.title}`, 'wingmanSpec.openRoute', [{ page: 'adr', root: c.root, number: a.number } satisfies Route])).join(', ')}`);
  if (i.pending.length) {
    out.push('', ...i.pending.map((p) => `**Pending**: ${commandLink(p.change, 'wingmanSpec.openRoute', [{ page: 'change', root: c.root, name: p.change, tab: 'specs' } satisfies Route])} ${p.op === 'RENAMED' ? `renames it to "${md(p.to ?? '')}"` : p.op === 'REMOVED' ? 'removes it' : p.op === 'MODIFIED' ? 'amends it' : 'adds it'}`));
  }
  for (const w of i.warnings.filter((x) => x.code === 'sprawl' || x.code === 'none-tested')) out.push('', `Warning: ${md(w.text)}`);
  const links = [commandLink('Open in Wingman Spec', 'wingmanSpec.revealRequirement', [c.root, i.key]), commandLink('Open spec.md', 'wingmanSpec.openFile', [i.file, i.line])];
  if (c.canRun) links.push(commandLink('Run tests', 'wingmanSpec.runTests', [c.root, i.key]));
  out.push('', links.join(' · '), '', `${i.code.length} code anchor${i.code.length === 1 ? '' : 's'}, ${i.tests.length} test anchor${i.tests.length === 1 ? '' : 's'}`);
  return out.join('\n');
}

/** Hover on a marker that matches no requirement. */
export function hoverUnresolved(key: string, info: UnresolvedInfo, c: { root: string; uri: string; line: number; col: number; length: number }): string {
  const out = [`**\`@spec ${key}\`** matches no requirement`, '', md(info.text)];
  if (info.hint && !info.addedBy) {
    out.push('', commandLink(`Fix marker to ${info.hint}`, 'wingmanSpec.fixMarker', [c.uri, c.line, c.col, c.length, info.hint]));
  }
  return out.join('\n');
}
