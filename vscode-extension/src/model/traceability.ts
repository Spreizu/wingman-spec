/**
 * Read-only traceability model: requirements (with their `Why:`) -> scenarios and code/test anchors, plus the flags and
 * drift gaps `wingman-spec lint|drift` would report. It parses files only (specs, proposals and a scan for markers:
 * the markers are the anchor index, nothing is stored); it never runs the verifier and never writes. Gap types and
 * keys match the verifier's.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import chrono from '../core/chronology.ts';
import { archiveDir, changesDir as changesOf, configFiles, livingSpecsDir } from '../core/paths.ts';
import { nearest, scanCode, slug } from './anchors.ts';
import type { ScannedFile } from './anchors.ts';
import { acceptedOf, proposalApproval, whyOf } from './requirementLines.ts';
import { parseSpec } from './specParser.ts';
import { parseTasks } from './tasksParser.ts';

export type TraceMode = 'on' | 'warn' | 'off';

export interface AnchorRef {
  file: string;
  /** Zero-based line. */
  line: number;
  kind: 'marker' | 'tag';
  /** For a tag: the slug of the scenario it names. */
  scenario?: string;
}

export interface TraceScenario {
  name: string;
  slug: string;
  /** Zero-based line in the spec file. */
  line: number;
  /** GIVEN / WHEN / THEN / AND steps. */
  steps: { keyword: string; text: string }[];
}

export type RequirementFlag = 'no-why' | 'no-code-anchor' | 'no-test-anchor';

export interface TraceRequirement {
  /** `capability/requirement-slug`. */
  key: string;
  cap: string;
  name: string;
  statement: string;
  /** The `Why:` line (who wants it, and why), or null when the requirement has none. */
  why: string | null;
  /** The reason of its `Accepted:` line, or null. */
  accepted: string | null;
  scenarios: TraceScenario[];
  /** Comment-free source of the whole requirement block (the words `anchor_fit` compares a unit with). */
  block: string;
  /** Absolute spec file and zero-based line of the heading. */
  file: string;
  line: number;
  code: AnchorRef[];
  tests: AnchorRef[];
  flags: RequirementFlag[];
}

/** What a pending change does to a living requirement. */
export interface Touch {
  op: 'ADDED' | 'MODIFIED' | 'REMOVED' | 'RENAMED';
  /** The change's delta spec and the zero-based line of the requirement in it. */
  file: string;
  line: number;
  /** For RENAMED: the new name. */
  to?: string;
}

/** A change that rewrites a living requirement's Why or removes a requirement: the owner has to agree. */
export interface WhyApproval {
  key: string;
  status: 'changed' | 'removed';
  was: string | null;
  now: string | null;
  file: string;
  /** Zero-based line of the requirement in the delta. */
  line: number;
}

export interface TraceChange {
  name: string;
  dir: string;
  /** Living requirement key -> what this change does to it. */
  touches: Map<string, Touch>;
  proposal: string;
  /** The requirements as they will be once the change is archived (the living ones, with the delta applied). */
  requirements: Map<string, TraceRequirement>;
  /** The proposal's `Owner approval:` text, or null. */
  approval: string | null;
  /** Requirements of the delta (added or modified) without a `Why:` line. */
  missingWhy: string[];
  /** Rewritten Whys and removed requirements: they need `approval`. */
  approvals: WhyApproval[];
}

export type GapType =
  | 'unanchored-requirement'
  | 'untested-requirement'
  | 'orphan-anchor'
  | 'stale-test-tag'
  | 'unsynced-archive'
  | 'over-anchored';

export interface TraceGap {
  /** `<type>:<subject>`, the key `drift decide` takes. */
  key: string;
  type: GapType;
  subject: string;
  text: string;
  file?: string;
  line?: number;
  /** The reason of the `Accepted:` line on the requirement, for the gaps that line covers (unanchored, untested). */
  accepted?: string;
}

export interface UnresolvedMarker {
  key: string;
  file: string;
  line: number;
  hint?: string;
}

export interface TraceModel {
  root: string;
  codeRoot: string;
  mode: TraceMode;
  placement: PlacementLevel;
  /** `anchor_many` of the config: requirements that are truly spread over many files (the CLI reports `over-anchored` markers). */
  many: ReadonlySet<string>;
  /** The mode is not `off`, or a requirement carries a `Why:` line. */
  hasLayer: boolean;
  requirements: Map<string, TraceRequirement>;
  changes: TraceChange[];
  gaps: TraceGap[];
  unresolved: UnresolvedMarker[];
}

const readIf = (f: string): string | undefined => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return undefined;
  }
};

/** Capabilities of a specs folder: `<cap>.md` files. */
const specFiles = (d: string): string[] => {
  try {
    return readdirSync(d, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name.slice(0, -3)).sort();
  } catch {
    return [];
  }
};

const dirs = (d: string): string[] => {
  try {
    return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  } catch {
    return [];
  }
};

/** `traceability: on|warn|off` from the first config file that has it (default off). */
/** `anchor_placement: warn|error|off` (default warn): how marker placement findings are shown. */
export type PlacementLevel = 'warn' | 'error' | 'off';
export function readPlacement(configFiles: string[]): PlacementLevel {
  for (const f of configFiles) {
    const m = /^anchor_placement:\s*['"]?(warn|error|off)\b/im.exec(readIf(f) ?? '');
    if (m) return (m[1] ?? 'warn').toLowerCase() as PlacementLevel;
  }
  return 'warn';
}

/** `anchor_many: [a/b, c/d]` (or a block list) from the first config file that has it. */
export function anchorMany(configFiles: string[]): Set<string> {
  for (const f of configFiles) {
    const t = readIf(f) ?? '';
    const m = /^anchor_many:[ \t]*(.*)$/m.exec(t);
    if (!m) continue;
    const inline = (m[1] ?? '').trim();
    if (inline.startsWith('[')) return new Set(inline.replace(/[[\]'"]/g, '').split(',').map((x) => x.trim()).filter(Boolean));
    const after = t.slice((m.index ?? 0) + m[0].length).split('\n');
    const keys: string[] = [];
    for (const l of after.slice(1)) {
      const k = /^\s+-\s*['"]?([^'"\s#]+)/.exec(l);
      if (!k) break;
      keys.push(k[1] ?? '');
    }
    return new Set(keys);
  }
  return new Set();
}

export function readMode(configFiles: string[]): TraceMode {
  for (const f of configFiles) {
    const m = /^traceability:\s*['"]?(on|warn|off)\b/im.exec(readIf(f) ?? '');
    if (m) return (m[1] ?? 'off').toLowerCase() as TraceMode;
  }
  return 'off';
}

function reqsOfSpec(cap: string, file: string, text: string, sections: string[]): TraceRequirement[] {
  return parseSpec(text)
    .requirements.filter((r) => sections.includes(r.section))
    .map((r) => ({
      key: `${cap}/${slug(r.name)}`,
      cap,
      name: r.name,
      statement: r.statement.trim(),
      why: whyOf(r.raw),
      accepted: acceptedOf(r.raw),
      block: r.raw,
      scenarios: r.scenarios.map((s) => ({ name: s.name, slug: slug(s.name), line: s.line, steps: s.steps.map((st) => ({ keyword: st.keyword, text: st.text })) })),
      file,
      line: r.line,
      code: [],
      tests: [],
      flags: [],
    }));
}

function livingRequirements(root: string): Map<string, TraceRequirement> {
  const out = new Map<string, TraceRequirement>();
  const base = livingSpecsDir(root);
  for (const cap of specFiles(base)) {
    const file = join(base, `${cap}.md`);
    const text = readIf(file);
    if (text === undefined) continue;
    for (const r of reqsOfSpec(cap, file, text, ['BASE'])) out.set(r.key, r);
  }
  return out;
}

interface DeltaReq extends TraceRequirement {
  op: string;
}

function deltasOf(changeDir: string): { cap: string; file: string; reqs: DeltaReq[]; renames: { from: string; to: string }[] }[] {
  const base = join(changeDir, 'specs');
  const out = [];
  for (const cap of specFiles(base)) {
    const file = join(base, `${cap}.md`);
    const text = readIf(file);
    if (text === undefined) continue;
    const parsed = parseSpec(text);
    const reqs = reqsOfSpec(cap, file, text, ['ADDED', 'MODIFIED', 'REMOVED']);
    const ops = parsed.requirements.filter((r) => ['ADDED', 'MODIFIED', 'REMOVED'].includes(r.section)).map((r) => r.section);
    out.push({ cap, file, reqs: reqs.map((r, i) => ({ ...r, op: ops[i] ?? 'ADDED' })), renames: parsed.renames });
  }
  return out;
}

/** Requirement keys the archived changes say should be in the living specs. */
function archivedExpectation(root: string): Map<string, string> {
  const dir = archiveDir(root);
  const exp = new Map<string, string>();
  for (const { name: a } of chrono.archiveOrder(dir)) { // in the order they were archived (to the second), not by folder name
    for (const d of deltasOf(join(dir, a))) {
      for (const rn of d.renames) {
        if (exp.delete(`${d.cap}/${slug(rn.from)}`)) exp.set(`${d.cap}/${slug(rn.to)}`, a);
      }
      for (const r of d.reqs) {
        if (r.op === 'ADDED') exp.set(r.key, a);
        else if (r.op === 'REMOVED') exp.delete(r.key);
      }
    }
  }
  return exp;
}

/** Capabilities that an archived change specified but that have no living spec now: their test tags are stale. */
function retiredCapabilities(root: string, living: Set<string>): Set<string> {
  const dir = archiveDir(root);
  const gone = new Set<string>();
  for (const a of dirs(dir)) for (const cap of specFiles(join(dir, a, 'specs'))) if (!living.has(cap)) gone.add(cap);
  return gone;
}

/**
 * Builds the model. `root` is the specs root (specs, changes, archive); `codeRoot` is scanned for markers.
 */
export function buildTrace(root: string, codeRoot: string, opts: { scan?: ScannedFile[] } = {}): TraceModel {
  const configs = configFiles(codeRoot, root);
  const mode = readMode(configs);
  const placement = readPlacement(configs);
  const reqs = livingRequirements(root);
  const scan = opts.scan ?? scanCode(codeRoot);

  // anchors
  const scenarioOwner = new Map<string, string>();
  for (const r of reqs.values()) for (const s of r.scenarios) scenarioOwner.set(`${r.cap}/${s.slug}`, r.key);
  const caps = new Set([...reqs.values()].map((r) => r.cap));
  const goneCaps = retiredCapabilities(root, caps);
  const unresolved: UnresolvedMarker[] = [];
  const stale: { tag: string; file: string; line: number; why: string }[] = [];
  for (const f of scan) {
    for (const m of f.markers) {
      const r = reqs.get(m.key);
      if (!r) {
        const hint = nearest(m.key, reqs.keys());
        unresolved.push({ key: m.key, file: f.file, line: m.line, ...(hint ? { hint } : {}) });
      } else (f.test ? r.tests : r.code).push({ file: f.file, line: m.line, kind: 'marker' });
    }
    for (const t of f.tags) {
      const owner = scenarioOwner.get(t.tag);
      if (owner) reqs.get(owner)?.tests.push({ file: f.file, line: t.line, kind: 'tag', scenario: t.tag.split('/')[1] ?? '' });
      else {
        const cap = t.tag.split('/')[0] ?? '';
        if (caps.has(cap)) stale.push({ tag: t.tag, file: f.file, line: t.line, why: 'no such scenario in the specs' });
        else if (goneCaps.has(cap)) stale.push({ tag: t.tag, file: f.file, line: t.line, why: 'capability no longer in the specs' });
      }
    }
  }
  for (const r of reqs.values()) {
    if (r.why === null) r.flags.push('no-why');
    if (!r.code.length) r.flags.push('no-code-anchor');
    if (!r.tests.length) r.flags.push('no-test-anchor');
  }

  // pending changes
  const changes: TraceChange[] = [];
  const changesDir = changesOf(root);
  for (const name of dirs(changesDir)) {
    const dir = join(changesDir, name);
    const proposal = join(dir, 'proposal.md');
    const text = readIf(proposal);
    if (text === undefined) continue;
    const eff = new Map(reqs);
    const missingWhy: string[] = [];
    const approvals: WhyApproval[] = [];
    const touches = new Map<string, Touch>();
    for (const d of deltasOf(dir)) {
      for (const rn of d.renames) {
        touches.set(`${d.cap}/${slug(rn.from)}`, { op: 'RENAMED', file: d.file, line: 0, to: rn.to });
        const old = eff.get(`${d.cap}/${slug(rn.from)}`);
        if (old) {
          eff.delete(old.key);
          eff.set(`${d.cap}/${slug(rn.to)}`, { ...old, name: rn.to, key: `${d.cap}/${slug(rn.to)}` });
        }
      }
      for (const r of d.reqs) {
        if (reqs.has(r.key) && !touches.has(r.key)) touches.set(r.key, { op: r.op as Touch['op'], file: d.file, line: r.line });
        const was = reqs.get(r.key);
        if (r.op === 'REMOVED') {
          eff.delete(r.key);
          if (was) approvals.push({ key: r.key, status: 'removed', was: was.why, now: null, file: d.file, line: r.line });
        } else {
          eff.set(r.key, r);
          if (r.why === null) missingWhy.push(r.key);
          if (r.op === 'MODIFIED' && was?.why && was.why !== r.why) approvals.push({ key: r.key, status: 'changed', was: was.why, now: r.why, file: d.file, line: r.line });
        }
      }
    }
    changes.push({ name, dir, touches, proposal, requirements: eff, approval: proposalApproval(text), missingWhy, approvals });
  }

  // drift over the living specs (same gap types and keys as `wingman-spec drift`)
  const gaps: TraceGap[] = [];
  const add = (type: GapType, subject: string, text: string, extra: Partial<TraceGap> = {}): void => {
    const key = `${type}:${subject}`;
    gaps.push({ key, type, subject, text, ...extra });
  };
  for (const r of reqs.values()) {
    const acc = r.accepted === null ? {} : { accepted: r.accepted };
    if (!r.code.length) add('unanchored-requirement', r.key, `requirement "${r.name}" has no code anchor`, { file: r.file, line: r.line, ...acc });
    else if (!r.tests.length) add('untested-requirement', r.key, `requirement "${r.name}" has code anchors but no test anchor`, { file: r.file, line: r.line, ...acc });
  }
  const seen = new Set<string>();
  for (const u of unresolved) {
    const subject = `${u.key}@${u.file}`;
    if (seen.has(subject)) continue;
    seen.add(subject);
    add('orphan-anchor', subject, `\`@spec ${u.key}\` in ${u.file}:${u.line + 1} points at a requirement that does not exist${u.hint ? ` (perhaps ${u.hint})` : ''}`, { file: join(codeRoot, u.file), line: u.line });
  }
  for (const s of stale) add('stale-test-tag', s.tag, `test tag [${s.tag}] in ${s.file}: ${s.why}`, { file: join(codeRoot, s.file), line: s.line });
  for (const [k, a] of archivedExpectation(root)) {
    if (!reqs.has(k)) add('unsynced-archive', k, `change ${a} was archived with requirement ${k} that is not in the living specs`);
  }

  const hasLayer = mode !== 'off' || [...reqs.values()].some((r) => r.why !== null);
  return { root, codeRoot, mode, placement, many: anchorMany(configs), hasLayer, requirements: reqs, changes, gaps, unresolved };
}

