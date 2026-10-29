import { blankComments } from './markdown.ts';

export type RequirementSection = 'BASE' | 'ADDED' | 'MODIFIED' | 'REMOVED' | 'RENAMED';

/** `Why:`, `Accepted:` and `Confirmed:` lines under the SHALL sentence are about the requirement, not part of its statement. */
const META_LINE_RE = /^\s*(?:[-*]\s*)?\**(?:Why|Accepted|Confirmed)\**:/i;

export interface ScenarioStep {
  keyword: string;
  text: string;
}

export interface Scenario {
  name: string;
  steps: ScenarioStep[];
  /** Zero-based line of the `#### Scenario:` heading. */
  line: number;
}

export interface Requirement {
  name: string;
  /** Normative text between the requirement heading and its first scenario. */
  statement: string;
  scenarios: Scenario[];
  section: RequirementSection;
  /** Zero-based line of the `### Requirement:` heading. */
  line: number;
  /** Comment-free source of the whole requirement block, used for diffs. */
  raw: string;
}

export interface Rename {
  from: string;
  to: string;
}

export interface ParsedSpec {
  purpose: string;
  /** Zero-based line of the `## Purpose` heading, or -1. */
  purposeLine: number;
  requirements: Requirement[];
  renames: Rename[];
}

const STEP_RE = /^\s*[-*]\s+\*\*(WHEN|THEN|AND|GIVEN|BUT)\*\*\s*(.*?)\s*$/;

/** Same reading as `traceability.cjs parseSpec`: ADDED/MODIFIED/REMOVED/RENAMED by their first word, any other heading is the living spec. */
function sectionOf(title: string): RequirementSection {
  const m = /^(ADDED|MODIFIED|REMOVED|RENAMED)\b/i.exec(title);
  return m?.[1] ? (m[1].toUpperCase() as RequirementSection) : 'BASE';
}

/** Lines inside (and on) a fenced code block: headings and steps there are example text, not structure (as in `traceability.cjs parseSpec`). */
function fencedLines(lines: string[]): boolean[] {
  const out: boolean[] = []; let fence: string | null = null;
  for (const l of lines) {
    const fm = /^\s*(`{3,}|~{3,})\s*(\S*)/.exec(l);
    if (fm) {
      const ch = (fm[1] ?? '')[0] ?? '';
      if (!fence) fence = ch; else if (ch === fence && !fm[2]) fence = null;
      out.push(true); continue;
    }
    out.push(fence !== null);
  }
  return out;
}

/** Parses a capability spec: either `openspec/specs/<name>/spec.md` or a change delta spec. */
export function parseSpec(text: string): ParsedSpec {
  const lines = blankComments(text.replace(/\r\n/g, '\n')).split('\n');
  const spec: ParsedSpec = { purpose: '', purposeLine: -1, requirements: [], renames: [] };

  let section: RequirementSection | 'PURPOSE' = 'BASE';
  let req: Requirement | undefined;
  let scenario: Scenario | undefined;
  let rawLines: string[] = [];
  const purpose: string[] = [];
  let pendingFrom: string | undefined;

  const closeRequirement = (): void => {
    if (req) req.raw = rawLines.join('\n').trim();
    req = undefined;
    scenario = undefined;
    rawLines = [];
  };

  const fenced = fencedLines(lines);
  lines.forEach((line, idx) => {
    if (fenced[idx]) { if (req) rawLines.push(line); return; }
    const h2 = /^##\s+(.*?)\s*$/.exec(line);
    if (h2 && !line.startsWith('###')) {
      closeRequirement();
      const title = h2[1] ?? '';
      if (/^purpose\b/i.test(title)) {
        section = 'PURPOSE';
        spec.purposeLine = idx;
      } else {
        section = sectionOf(title);
      }
      return;
    }

    if (section === 'PURPOSE') {
      purpose.push(line);
      return;
    }

    if (section === 'RENAMED') {
      const from = /FROM:\s*`?###\s*Requirement:\s*(.*?)`?\s*$/i.exec(line);
      const to = /TO:\s*`?###\s*Requirement:\s*(.*?)`?\s*$/i.exec(line);
      if (from) pendingFrom = from[1] ?? '';
      else if (to && pendingFrom !== undefined) {
        spec.renames.push({ from: pendingFrom, to: to[1] ?? '' });
        pendingFrom = undefined;
      }
      return;
    }

    const r = /^###\s+Requirement:\s*(.*?)\s*$/.exec(line);
    if (r) {
      closeRequirement();
      req = { name: r[1] ?? '', statement: '', scenarios: [], section, line: idx, raw: '' };
      spec.requirements.push(req);
      rawLines.push(line);
      return;
    }
    if (!req) return;
    rawLines.push(line);

    const s = /^####\s+Scenario:\s*(.*?)\s*$/.exec(line);
    if (s) {
      scenario = { name: s[1] ?? '', steps: [], line: idx };
      req.scenarios.push(scenario);
      return;
    }
    if (scenario) {
      const step = STEP_RE.exec(line);
      if (step) scenario.steps.push({ keyword: step[1] ?? '', text: step[2] ?? '' });
      return;
    }
    if (META_LINE_RE.test(line)) return;
    if (line.trim() !== '') req.statement = req.statement ? `${req.statement} ${line.trim()}` : line.trim();
  });

  closeRequirement();
  spec.purpose = purpose.join(' ').replace(/\s+/g, ' ').trim();
  return spec;
}

export function countScenarios(spec: ParsedSpec): number {
  return spec.requirements.reduce((n, r) => n + r.scenarios.length, 0);
}

export function findRequirement(spec: ParsedSpec, name: string): Requirement | undefined {
  const wanted = name.trim().toLowerCase();
  return spec.requirements.find((r) => r.name.trim().toLowerCase() === wanted);
}
