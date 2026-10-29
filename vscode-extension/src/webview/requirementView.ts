import { diffLines, hasChanges } from '../model/lineDiff.ts';
import type { Requirement, RequirementSection } from '../model/specParser.ts';
import { slug } from '../model/anchors.ts';
import type { ReqInsight } from '../model/reqInsight.ts';
import { badge, esc, icon, openAttr, rich } from './components.ts';
import type { Tone } from './components.ts';
import { insightBlock, scenarioLabel, scenarioStatus } from './insightView.ts';

const SECTION_TONE: Record<RequirementSection, Tone> = {
  BASE: 'muted',
  ADDED: 'ok',
  MODIFIED: 'warn',
  REMOVED: 'bad',
  RENAMED: 'info',
};

const KEYWORD_TONE: Record<string, Tone> = {
  WHEN: 'info',
  GIVEN: 'accent',
  THEN: 'ok',
  AND: 'muted',
  BUT: 'warn',
};

export function sectionBadge(section: RequirementSection): string {
  return section === 'BASE' ? '' : badge(section.toLowerCase(), SECTION_TONE[section]);
}

export function diffBlock(before: string, after: string): string {
  const diff = diffLines(before, after);
  if (!hasChanges(diff)) return '<p class="muted">No differences.</p>';
  return `<div class="diff">${diff.map((l) => `<div class="${l.kind}">${esc(l.text)}</div>`).join('')}</div>`;
}

export interface RequirementOptions {
  path: string;
  /** Promoted requirement to diff a MODIFIED requirement against. */
  base?: Requirement;
  /** What the traceability model knows about it: anchors, tested scenarios, the Why, pending changes, ADRs. */
  insight?: ReqInsight;
  root?: string;
  codeRoot?: string;
  /** This card is the one the page was opened on: it is highlighted, scrolled to and focused. */
  focused?: boolean;
  /** The scenario (slug) to highlight inside it. */
  focusScenario?: string;
}

export function requirementCard(req: Requirement, opts: RequirementOptions): string {
  const problems: string[] = [];
  if (req.section !== 'REMOVED') {
    if (!/\b(SHALL|MUST)\b/.test(req.statement)) problems.push('no SHALL or MUST');
    if (req.scenarios.length === 0) problems.push('no scenarios');
  }

  const scenarios = req.scenarios
    .map((s) => {
      const steps = s.steps
        .map(
          (st) =>
            `<div class="step-row"><span class="kw tone-${KEYWORD_TONE[st.keyword] ?? 'muted'}">${esc(st.keyword)}</span><span>${rich(st.text)}</span></div>`,
        )
        .join('');
      const sl = slug(s.name);
      const hit = opts.focused && opts.focusScenario === sl;
      return `<div class="scn${hit ? ' focused' : ''}" id="scn-${slug(req.name)}-${sl}"${hit ? ' tabindex="-1"' : ''}><div class="scn-name">${icon('check', 13)}${opts.insight ? scenarioLabel(opts.insight, sl, rich(s.name || 'Unnamed scenario'), opts.codeRoot ?? '') : `<span>${rich(s.name || 'Unnamed scenario')}</span>`}${opts.insight ? scenarioStatus(opts.insight, sl, opts.codeRoot ?? '') : ''}</div>${steps}</div>`;
    })
    .join('');

  const diff =
    req.section === 'MODIFIED' && opts.base
      ? `<details><summary class="muted" style="cursor:pointer;margin-top:10px">Changes against the current spec</summary>${diffBlock(opts.base.raw, req.raw)}</details>`
      : '';

  const own = opts.focused && !opts.focusScenario;
  return `<div class="card req${own ? ' focused' : ''}" id="req-${slug(req.name)}"${own ? ' tabindex="-1"' : ''}>
<div class="req-head"><h4>${rich(req.name || 'Unnamed requirement')}</h4>${sectionBadge(req.section)}
${problems.map((p) => badge(p, 'warn')).join('')}
<span style="margin-left:auto"><button class="link" ${openAttr(opts.path, req.line)}>${icon('external', 13)} Open</button></span></div>
${req.statement ? `<p class="req-statement">${rich(req.statement)}</p>` : ''}
${opts.insight ? insightBlock(opts.insight, opts.root ?? '', opts.codeRoot ?? '') : ''}${scenarios}${diff}</div>`;
}
