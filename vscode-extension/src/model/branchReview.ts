/**
 * Pull request view of the current branch: from the changed files (old and new text) to the anchors that moved, the requirements they
 * touch (with their Why), which of those are untested, and the verifier findings that are about the diff. Pure: git and the verifier are
 * run by the editor layer, which hands the texts and findings in.
 */
import guard from '../core/anchorDiff.ts';
import { isScannable, isTestFile, isTestPath, slug, tagsIn } from './anchors.ts';
import type { DiffFile } from './gitDiff.ts';
import { insightOf } from './reqInsight.ts';
import { parseSpec } from './specParser.ts';
import type { TraceModel } from './traceability.ts';
import type { VerifierFinding } from './verifier.ts';

export interface ChangedFile extends DiffFile {
  oldText?: string;
  newText?: string;
}

export type AnchorChange = 'added' | 'removed' | 'moved' | 'changed' | 'renamed';

export interface AnchorMove {
  change: AnchorChange;
  key: string;
  /** Relative path and 1-based line (for `moved`: where it is now; `from` says where it was). */
  file: string;
  line: number;
  from?: { file: string; line: number };
  header: string;
  test: boolean;
  /** The key names a requirement of the current specs. */
  resolves: boolean;
}

export interface TouchedRequirement {
  key: string;
  name: string;
  cap: string;
  /** The requirement's `Why:` line (who wants it, and why), or null. */
  why: string | null;
  /** Why it is touched: code anchors changed, test anchors/tags changed, its spec text changed in the branch, a pending delta changed. */
  via: ('code' | 'test' | 'spec' | 'delta' | 'removed')[];
  scenarios: number;
  tested: number;
  /** No test at all among its scenarios, or fewer tested than declared. */
  untested: boolean;
}

export interface BranchReview {
  root: string;
  /** The git work tree: anchor and file paths of the review are relative to it. */
  codeRoot: string;
  branch: string;
  base: string;
  mergeBase: string;
  files: number;
  added: number;
  removed: number;
  anchors: AnchorMove[];
  requirements: TouchedRequirement[];
  /** Touched requirements that have untested scenarios (a subset of `requirements`). */
  untested: TouchedRequirement[];
  /** Findings of the verifier that are about a file of the diff (or a spec the diff touches). */
  findings: VerifierFinding[];
  notes: string[];
}

export interface BranchInput {
  root: string;
  codeRoot: string;
  branch: string;
  base: string;
  mergeBase: string;
  files: ChangedFile[];
  model: TraceModel;
  findings: VerifierFinding[];
  notes?: string[];
}

const posix = (p: string): string => p.split('\\').join('/');

/** The requirement keys of a spec text whose block differs from `before` (all of them when `before` is empty). */
export function changedRequirements(cap: string, before: string | undefined, after: string | undefined): { key: string; name: string; kind: 'added' | 'changed' | 'removed' }[] {
  const old = new Map(parseSpec(before ?? '').requirements.map((r) => [slug(r.name), r]));
  const cur = new Map(parseSpec(after ?? '').requirements.map((r) => [slug(r.name), r]));
  const out: { key: string; name: string; kind: 'added' | 'changed' | 'removed' }[] = [];
  for (const [s, r] of cur) {
    const o = old.get(s);
    if (!o) out.push({ key: `${cap}/${s}`, name: r.name, kind: 'added' });
    else if (o.raw !== r.raw || o.section !== r.section) out.push({ key: `${cap}/${s}`, name: r.name, kind: 'changed' });
  }
  for (const [s, r] of old) if (!cur.has(s)) out.push({ key: `${cap}/${s}`, name: r.name, kind: 'removed' });
  return out;
}

/** A living or delta spec in the diff: under `.wingman-spec/` of the code repo, or at the top of a specs repository. */
const SPEC_RE = /^(?:\.wingman-spec\/)?(?:specs|changes\/[^/]+\/specs)\/([^/]+)\.md$/;

/** Anchor events of every code and test file of the diff, with moves (the same unit removed in one place and added in another) folded together. */
export function anchorMoves(files: ChangedFile[], resolves: (key: string) => boolean): AnchorMove[] {
  const events: AnchorMove[] = [];
  const removed: AnchorMove[] = [];
  const added: AnchorMove[] = [];
  const bodies = new Map<AnchorMove, string>();
  for (const f of files) {
    if (!isScannable(f.path) && !isScannable(f.from)) continue;
    const test = isTestPath(f.path);
    const before = f.status === 'A' ? '' : (f.oldText ?? '');
    const after = f.status === 'D' ? '' : (f.newText ?? '');
    if (before === after) continue;
    for (const e of guard.compareAnchors(before, after)) {
      const m: AnchorMove = { change: e.kind === 'modified' ? (e.renamed ? 'renamed' : 'changed') : e.kind, key: e.key, file: e.kind === 'removed' ? f.from : f.path, line: e.line, header: e.header, test, resolves: resolves(e.key) };
      if (e.kind === 'removed') {
        removed.push(m);
        bodies.set(m, e.body ?? '');
      } else if (e.kind === 'added') {
        added.push(m);
        bodies.set(m, e.body ?? '');
      } else events.push(m);
    }
  }
  const lost = [...removed];
  for (const a of added) {
    const i = lost.findIndex((r) => r.key === a.key && (r.header === a.header || (bodies.get(r) !== '' && bodies.get(r) === bodies.get(a))));
    if (i >= 0) {
      const r = lost.splice(i, 1)[0];
      if (r) events.push({ ...a, change: 'moved', from: { file: r.file, line: r.line } });
    } else events.push(a);
  }
  events.push(...lost);
  const rank: Record<AnchorChange, number> = { removed: 0, moved: 1, changed: 2, renamed: 3, added: 4 };
  return events.sort((a, b) => rank[a.change] - rank[b.change] || a.file.localeCompare(b.file) || a.line - b.line);
}

export function reviewBranch(input: BranchInput): BranchReview {
  const { model, files } = input;
  const notes = [...(input.notes ?? [])];
  const resolves = (k: string): boolean => model.requirements.has(k);
  const anchors = anchorMoves(files, resolves);

  const via = new Map<string, Set<TouchedRequirement['via'][number]>>();
  const names = new Map<string, string>();
  const touch = (key: string, why: TouchedRequirement['via'][number], name?: string): void => {
    if (!via.has(key)) via.set(key, new Set());
    via.get(key)?.add(why);
    if (name) names.set(key, name);
  };
  for (const a of anchors) touch(a.key, a.test ? 'test' : a.change === 'removed' ? 'removed' : 'code');

  const diffPaths = new Set<string>();
  for (const f of files) {
    const path = posix(f.path);
    diffPaths.add(path);
    diffPaths.add(posix(f.from));
    if (isTestFile(path) && f.status !== 'D') {
      const before = new Set(tagsIn(f.oldText ?? '').map((t) => t.tag));
      const after = new Set(tagsIn(f.newText ?? '').map((t) => t.tag));
      for (const t of new Set([...before, ...after])) if (before.has(t) !== after.has(t)) touch(`${t.split('/')[0]}/${scenarioOwner(model, t)}`, 'test');
    }
    const spec = SPEC_RE.exec(path);
    if (spec?.[1]) {
      const delta = path.includes('/changes/');
      for (const c of changedRequirements(spec[1], f.status === 'A' ? '' : f.oldText, f.status === 'D' ? '' : f.newText)) touch(c.key, c.kind === 'removed' ? 'removed' : delta ? 'delta' : 'spec', c.name);
    }
  }

  const requirements: TouchedRequirement[] = [];
  for (const [key, why] of via) {
    const ins = insightOf(model, key);
    const [cap = ''] = key.split('/');
    const name = ins?.name ?? names.get(key) ?? key.split('/')[1] ?? key;
    requirements.push({ key, name, cap, why: ins?.why ?? null, via: [...why], scenarios: ins?.scenarios.length ?? 0, tested: ins?.testedCount ?? 0, untested: !!ins && ins.scenarios.length > 0 && ins.testedCount < ins.scenarios.length });
  }
  requirements.sort((a, b) => a.key.localeCompare(b.key));

  const relevant = input.findings.filter((f) => {
    const rel = posix(f.file.startsWith(input.codeRoot) ? f.file.slice(input.codeRoot.length + 1) : f.file);
    return diffPaths.has(rel) || (f.requirement !== undefined && via.has(f.requirement)) || (f.change !== undefined && files.some((x) => [`changes/${f.change}/`, `.wingman-spec/changes/${f.change}/`].some((pre) => posix(x.path).startsWith(pre))));
  });

  return {
    root: input.root,
    codeRoot: input.codeRoot,
    branch: input.branch,
    base: input.base,
    mergeBase: input.mergeBase,
    files: files.length,
    added: files.reduce((n, f) => n + f.added, 0),
    removed: files.reduce((n, f) => n + f.removed, 0),
    anchors,
    requirements,
    untested: requirements.filter((r) => r.untested),
    findings: relevant,
    notes,
  };
}

/** The requirement slug that owns a scenario tag `cap/scenario`; falls back to the scenario slug. */
function scenarioOwner(model: TraceModel, tag: string): string {
  const [cap = '', scn = ''] = tag.split('/');
  for (const r of model.requirements.values()) if (r.cap === cap && r.scenarios.some((s) => s.slug === scn)) return r.key.split('/')[1] ?? scn;
  return scn;
}

