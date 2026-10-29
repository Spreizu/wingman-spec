/**
 * The Problems panel: how a verifier finding becomes a diagnostic and which mechanical quick fixes it offers. Pure: the editor
 * layer runs `problems --json`, shows what this returns and applies the edits it describes.
 */
import { moveMarkerPlan, removeMarkerEdit } from './markerFix.ts';
import type { TextEdit } from './markerFix.ts';
import type { VerifierFinding } from './verifier.ts';

export const PROBLEMS_SOURCE = 'Wingman Spec (verifier)';

export interface DiagnosticSpec {
  /** Zero-based range. */
  line: number;
  col: number;
  endCol: number;
  severity: 'error' | 'warning' | 'info';
  message: string;
  code: string;
}

/** Codes the live anchor diagnostics (code view) already report, with the same quick fixes, so they are not shown twice. */
const LIVE_CODES = new Set(['orphan-anchor', 'misplaced-marker', 'over-anchored', 'stale-test-tag']);
export const coveredByLive = (f: VerifierFinding, codeViewOn: boolean): boolean => codeViewOn && f.source === 'drift' && LIVE_CODES.has(f.code);

export function diagnosticOf(f: VerifierFinding): DiagnosticSpec {
  const hint = f.hint ? `\nHint: ${f.hint}` : '';
  return { line: f.line - 1, col: f.col - 1, endCol: f.col - 1 + Math.max(1, f.length), severity: f.severity, message: `${f.message}${hint}`, code: f.code };
}

/** A diagnostic's identity, to find the finding again from a code-action request. */
export const findingId = (f: Pick<VerifierFinding, 'file' | 'line' | 'col' | 'code'>): string => `${f.file}:${f.line}:${f.col}:${f.code}`;

export function groupByFile(findings: VerifierFinding[]): Map<string, VerifierFinding[]> {
  const out = new Map<string, VerifierFinding[]>();
  for (const f of findings) out.set(f.file, [...(out.get(f.file) ?? []), f]);
  return out;
}

export interface FixAction {
  title: string;
  preferred?: boolean;
  edits?: TextEdit[];
  /** Run a command of the extension instead of (or after) the edits. */
  command?: { id: string; args: unknown[] };
}

/** The edit that adds an empty `Why: ` line under the SHALL statement of the requirement whose heading is on `headingLine` (zero-based). */
export function addWhyEdit(text: string, headingLine: number): TextEdit | undefined {
  const lines = text.split(/\r?\n/);
  if (!/^###\s+Requirement:/.test(lines[headingLine] ?? '')) return undefined;
  let end = headingLine;
  for (let i = headingLine + 1; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (/^#{1,4}\s/.test(l)) break;
    if (l.trim() === '') {
      if (end > headingLine) break;
      continue;
    }
    end = i;
  }
  if (end === headingLine) return undefined;
  if (lines.slice(headingLine, end + 1).some((l) => /^\s*(?:[-*]\s*)?\**Why\**:/i.test(l))) return undefined;
  return { line: end, col: (lines[end] ?? '').length, endLine: end, endCol: (lines[end] ?? '').length, text: '\nWhy: ' };
}

export interface TestCase {
  /** Zero-based line of the title. */
  line: number;
  title: string;
  /** Zero-based column of the closing quote. */
  endCol: number;
}

const TEST_TITLE = /\b(?:it|test|specify)(?:\.(?:only|skip|each|concurrent|todo))*\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;

/** Test cases of a JS/TS-style test file (`it('title'`, `test("title"`); Python and Go name tests by function, not by a title string. */
export function testCases(text: string): TestCase[] {
  const out: TestCase[] = [];
  text.split(/\r?\n/).forEach((l, i) => {
    for (const m of l.matchAll(TEST_TITLE)) out.push({ line: i, title: m[2] ?? '', endCol: (m.index ?? 0) + m[0].length - 1 });
  });
  return out;
}

/** The edit that appends ` [cap/scenario]` to the title of the test case on `line`. */
export function tagTitleEdit(text: string, line: number, id: string): TextEdit | undefined {
  const c = testCases(text).find((t) => t.line === line);
  if (!c || c.title.includes(`[${id}]`)) return undefined;
  return { line: c.line, col: c.endCol, endLine: c.line, endCol: c.endCol, text: ` [${id}]` };
}

export interface FixContext {
  /** The text of the file the finding is in. */
  text: string;
  /** Path relative to the code root (for the comment style of a moved marker). */
  rel: string;
}

/** Mechanical quick fixes for a finding. Nothing is offered when the finding has no `fix`. */
export function fixesFor(f: VerifierFinding, ctx: FixContext): FixAction[] {
  const fix = f.fix;
  if (!fix) return [];
  const line0 = f.line - 1;
  switch (fix.kind) {
    case 'replace-key': {
      if (!fix.to) return [];
      return [{ title: `Fix marker to ${fix.to}`, preferred: true, edits: [{ line: line0, col: f.col - 1, endLine: line0, endCol: f.col - 1 + f.length, text: fix.to }] }];
    }
    case 'move-marker': {
      const plan = moveMarkerPlan(ctx.text, ctx.rel, line0);
      return plan ? [{ title: plan.title, preferred: true, edits: plan.edits }] : [];
    }
    case 'remove-duplicate': {
      const e = removeMarkerEdit(ctx.text, line0);
      return e ? [{ title: 'Remove the duplicate marker', preferred: true, edits: [e] }] : [];
    }
    case 'remove-marker': {
      const e = removeMarkerEdit(ctx.text, line0);
      return e ? [{ title: 'Remove this marker (it says too little about the code)', preferred: true, edits: [e] }] : [];
    }
    case 'add-why': {
      const e = addWhyEdit(ctx.text, line0);
      return e ? [{ title: 'Add a "Why:" line (who wants it, and why)', preferred: true, edits: [e] }] : [];
    }
    case 'accept': {
      if (!f.key) return [];
      return [{ title: 'Accept this gap with a note (adds an "Accepted:" line to the requirement)...', command: { id: 'wingmanSpec.acceptGap', args: [f.file, f.key] } }];
    }
    case 'add-test-tag': {
      if (!fix.scenarios?.length) return [];
      return [{ title: 'Add a scenario tag to a test title...', command: { id: 'wingmanSpec.tagTest', args: [f.file, f.requirement ?? '', fix.scenarios] } }];
    }
  }
}

