import quality from '../core/plan.ts';
import testPaths from '../core/testpaths.ts';
import { isPlaceholder, parseFrontMatter } from './frontMatter.ts';
import { blankComments, splitSections } from './markdown.ts';
import { parseSpec } from './specParser.ts';
import { parseTasks } from './tasksParser.ts';
import type { Task, TaskGroup } from './types.ts';

const { isTestPath, isUiFile } = testPaths;

export type Severity = 'error' | 'warning' | 'info';

export interface Issue {
  /** Zero-based line. */
  line: number;
  message: string;
  severity: Severity;
}

const NORMATIVE_RE = /\b(SHALL|MUST)\b/;
const KNOWN_ADR_STATUS = /^(proposed|accepted|superseded|deprecated|none)\b/i;

/**
 * Checks where ```visual blocks sit (inside a scenario) and asks for `component:`. The block grammar itself (fields, steps,
 * viewports, roles) is checked by the CLI (`wingman-spec problems --json`, shown in the Problems panel), so the rules live in one place.
 */
export function lintVisualBlocks(text: string): Issue[] {
  const issues: Issue[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let inScenario = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (/^####\s+Scenario:/.test(l)) { inScenario = true; continue; }
    if (/^#{1,3}\s/.test(l)) { inScenario = false; continue; }
    const f = /^\s*(`{3,}|~{3,})\s*visual\s*$/.exec(l);
    if (!f) continue;
    const open = i; const mark = f[1] ?? '```';
    const close = new RegExp(`^\\s*${mark[0] === '`' ? '`' : '~'}{${mark.length},}\\s*$`);
    let j = i + 1;
    const body: string[] = [];
    for (; j < lines.length && !close.test(lines[j] ?? ''); j++) body.push(lines[j] ?? '');
    const field = (k: string): boolean => body.some((b) => new RegExp(`^${k}:\\s*\\S`).test(b));
    if (!inScenario) issues.push({ line: open, severity: 'error', message: 'A visual block must sit inside a "#### Scenario:" block.' });
    if (!field('component') && field('route')) issues.push({ line: open, severity: 'info', message: 'Visual block has no "component:". Every declared scenario guards later tasks (its ARIA structure is compared with a pre-task capture); without component: no task can change it on purpose without failing that guard.' });
    i = j;
  }
  return issues;
}

export function lintSpec(text: string): Issue[] {
  const spec = parseSpec(text);
  const issues: Issue[] = [...lintVisualBlocks(text)];

  if (spec.purposeLine >= 0 && spec.purpose.length > 0 && spec.purpose.length < 50) {
    issues.push({ line: spec.purposeLine, severity: 'warning', message: 'Purpose should be at least 50 characters.' });
  }

  for (const r of spec.requirements) {
    if (r.section === 'REMOVED') continue;
    if (r.name === '') {
      issues.push({ line: r.line, severity: 'warning', message: 'Requirement name is empty or still a template placeholder.' });
    }
    if (!NORMATIVE_RE.test(r.statement)) {
      issues.push({ line: r.line, severity: 'error', message: 'Requirement text must contain SHALL or MUST.' });
    }
    if (r.scenarios.length === 0) {
      issues.push({ line: r.line, severity: 'error', message: 'Requirement has no scenarios.' });
    }
    for (const s of r.scenarios) {
      const keywords = new Set(s.steps.map((st) => st.keyword));
      if (!keywords.has('WHEN') || !keywords.has('THEN')) {
        issues.push({ line: s.line, severity: 'warning', message: 'Scenario needs at least one WHEN and one THEN step.' });
      } else if (s.steps.some((st) => st.text === '')) {
        issues.push({ line: s.line, severity: 'warning', message: 'Scenario has an empty step.' });
      }
      if (s.name === '') {
        issues.push({ line: s.line, severity: 'warning', message: 'Scenario name is empty or still a template placeholder.' });
      }
    }
  }
  return issues;
}

/** The four detail lines the schema's tasks instruction requires (B14: `Files` was missing). */
const REQUIRED_DETAILS: { key: 'spec' | 'testFirst' | 'files' | 'doneWhen'; label: string }[] = [
  { key: 'spec', label: 'Spec' },
  { key: 'testFirst', label: 'Test first' },
  { key: 'files', label: 'Files' },
  { key: 'doneWhen', label: 'Done when' },
];

const filesOf = (s: string | undefined): string[] => (s ?? '').split(/[\s,;]+/).map((f) => f.replace(/[`()]/g, '')).filter((f) => /[./]/.test(f));

/**
 * The live part of the plan-size rules: implementation tasks over the cap of the declared size. Every other plan rule (reviews,
 * close-out tasks, merges, source-text tests) comes from `wingman-spec problems --json` in the Problems panel.
 */
export function lintTaskPlan(text: string, proposalSize = ''): Issue[] {
  const size = (proposalSize || quality.proposalSize(text).size || '') as keyof typeof quality.CAPS | '';
  if (!size) return [];
  const cap = quality.CAPS[size];
  const groups = parseTasks(text);
  const impl = groups.flatMap((g) => g.tasks.filter((t) => quality.isImplementationTask(g.title, t.id, t.title)));
  const first = groups[0];
  if (impl.length <= cap || !first) return [];
  const next = size === 'S' ? 'M' : size === 'M' ? 'L' : '';
  return [{ line: first.line, severity: 'error', message: `Size ${size} allows at most ${cap} implementation tasks; this plan has ${impl.length}. Merge tasks that touch the same files${next ? `, or set Size: ${next} in proposal.md` : ', or split the change'}.` }];
}

/** The `Size: S|M|L` line of a proposal.md (HTML comments ignored), or ''. */
export function proposalSize(text: string): string {
  return quality.proposalSize(text).size ?? '';
}

export function lintTasks(text: string, proposalSizeValue = ''): Issue[] {
  const issues: Issue[] = [...lintTaskPlan(text, proposalSizeValue)];
  for (const group of parseTasks(text)) {
    if (group.title === '') {
      issues.push({ line: group.line, severity: 'warning', message: 'Group name is empty or still a template placeholder.' });
    }
    for (const t of group.tasks) {
      if (t.title === '') {
        issues.push({ line: t.line, severity: 'warning', message: 'Task description is empty or still a template placeholder.' });
        continue;
      }
      if (t.isReview || group.isCloseOut) continue;
      const missing = REQUIRED_DETAILS.filter((d) => !t.details[d.key]).map((d) => d.label);
      if (missing.length > 0) {
        issues.push({ line: t.line, severity: 'warning', message: `Task is missing: ${missing.join(', ')}.` });
      }
      if (!t.details.visual && filesOf(t.details.files).some((f) => isUiFile(f) && !isTestPath(f))) {
        issues.push({ line: t.line, severity: 'info', message: 'This task changes UI files but has no Visual: line. Add "Visual: <scenario id>" for each scenario the task makes true.' });
      }
    }
  }
  return issues;
}

function fieldLine(text: string, key: string): number {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const idx = lines.findIndex((l) => new RegExp(`^${key}\\s*:`).test(l));
  return idx >= 0 ? idx : 0;
}

export interface AdrLintOptions {
  /** `source` is a change-local ADR, `root` a promoted one. */
  kind: 'source' | 'root';
  /** Numbers of promoted ADRs, used to validate `supersedes`. */
  knownNumbers?: string[];
  /** The file is a change's none record (it needs no Context/Decision/Consequences). */
  none?: boolean;
}

export function lintAdr(text: string, options: AdrLintOptions): Issue[] {
  const issues: Issue[] = [];
  const fm = parseFrontMatter(text);
  if (!fm.hasFrontMatter) {
    return [{ line: 0, severity: 'warning', message: 'ADR has no front matter (title, status, date, change).' }];
  }

  const status = fm.fields['status'] ?? '';
  const isNone = options.none === true || quality.isNoneAdr('', text);
  if (isPlaceholder(fm.fields['title'])) {
    issues.push({ line: fieldLine(text, 'title'), severity: 'warning', message: 'ADR title is empty or still a template placeholder.' });
  }
  if (isPlaceholder(fm.fields['date'])) {
    issues.push({ line: fieldLine(text, 'date'), severity: 'warning', message: 'ADR date is empty or still a template placeholder.' });
  }
  if (status === '' || !KNOWN_ADR_STATUS.test(status)) {
    issues.push({
      line: fieldLine(text, 'status'),
      severity: status === '' ? 'warning' : 'info',
      message: 'Status should be Proposed, Accepted, Superseded, Deprecated or none.',
    });
  }

  const supersedes = fm.fields['supersedes'];
  if (!isPlaceholder(supersedes) && options.knownNumbers && !options.knownNumbers.includes((supersedes ?? '').trim())) {
    issues.push({
      line: fieldLine(text, 'supersedes'),
      severity: 'error',
      message: `Supersedes ${(supersedes ?? '').trim()}, but no such promoted ADR exists.`,
    });
  }

  if (!isNone) {
    const { sections } = splitSections(blankComments(fm.body));
    for (const wanted of ['Context', 'Decision', 'Consequences']) {
      const found = sections.find((s) => s.title.toLowerCase() === wanted.toLowerCase());
      if (!found) {
        issues.push({ line: 0, severity: 'warning', message: `Missing "## ${wanted}" section.` });
      } else if (found.body === '') {
        issues.push({ line: 0, severity: 'info', message: `"## ${wanted}" section is empty.` });
      }
    }
  }
  return issues;
}
