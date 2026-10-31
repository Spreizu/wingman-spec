/**
 * What the editor knows about one requirement, in a form the CodeLens, hover, quick-pick and webview all share.
 * Pure (no VS Code, no file access except what the caller passes in), so every sentence is unit-tested.
 */
import { plain } from './markdown.ts';
import { nearest, slug } from './anchors.ts';
import type { AnchorRef, TraceModel, TraceRequirement, Touch } from './traceability.ts';
import type { RootAdr } from './types.ts';

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

export interface ScenarioInsight {
  name: string;
  slug: string;
  /** Zero-based line in the spec file. */
  line: number;
  steps: { keyword: string; text: string }[];
  /** At least one test carries the `[capability/scenario-slug]` tag. */
  tested: boolean;
  tests: AnchorRef[];
}

export interface PendingTouch {
  change: string;
  op: Touch['op'];
  to?: string;
  file: string;
  line: number;
}

export interface AdrHit {
  number: string;
  title: string;
  path: string;
  /** Zero-based line of the first mention. */
  line: number;
}

export type InsightWarningCode = 'amended-pending' | 'removed-pending' | 'renamed-pending' | 'no-why' | 'none-tested' | 'sprawl';

export interface InsightWarning {
  code: InsightWarningCode;
  text: string;
}

export interface ReqInsight {
  key: string;
  cap: string;
  name: string;
  statement: string;
  /** Spec file (absolute) and zero-based line of the requirement. */
  file: string;
  line: number;
  /** The requirement's `Why:` line, or null. */
  why: string | null;
  scenarios: ScenarioInsight[];
  testedCount: number;
  code: AnchorRef[];
  tests: AnchorRef[];
  pending: PendingTouch[];
  adrs: AdrHit[];
  warnings: InsightWarning[];
}

/** First line (zero-based) of `text` that mentions the requirement by key or by its exact name, or -1. */
function mentionLine(text: string, key: string, name: string): number {
  const lines = text.split('\n');
  const nameLc = name.trim().toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (l.includes(key)) return i;
    if (nameLc.length >= 8 && l.toLowerCase().includes(nameLc)) return i;
  }
  return -1;
}

/** Promoted ADRs that mention the requirement (by `capability/slug` or by its name). Deterministic text search, nothing inferred. */
export function adrsMentioning(adrs: RootAdr[], key: string, name: string): AdrHit[] {
  const out: AdrHit[] = [];
  for (const a of adrs) {
    const line = mentionLine(a.body, key, name);
    if (line >= 0) out.push({ number: a.number, title: a.title, path: a.path, line });
  }
  return out;
}

function pendingOf(model: TraceModel, key: string): PendingTouch[] {
  const out: PendingTouch[] = [];
  for (const c of model.changes) {
    const t = c.touches.get(key);
    if (t) out.push({ change: c.name, op: t.op, ...(t.to ? { to: t.to } : {}), file: t.file, line: t.line });
  }
  return out;
}

export function warningsOf(i: Pick<ReqInsight, 'pending' | 'why' | 'scenarios' | 'testedCount' | 'code'>, spread = false): InsightWarning[] {
  const out: InsightWarning[] = [];
  for (const p of i.pending) {
    if (p.op === 'REMOVED') out.push({ code: 'removed-pending', text: `removed by pending change ${p.change}` });
    else if (p.op === 'RENAMED') out.push({ code: 'renamed-pending', text: `renamed to "${p.to ?? '?'}" by pending change ${p.change}` });
    else if (p.op === 'MODIFIED') out.push({ code: 'amended-pending', text: `amended by pending change ${p.change}` });
  }
  if (i.why === null) out.push({ code: 'no-why', text: 'no Why line: who wants this, and why?' });
  if (i.scenarios.length > 0 && i.testedCount === 0) out.push({ code: 'none-tested', text: 'none of its scenarios has a tagged test' });
  const files = new Set(i.code.map((a) => a.file)).size;
  if (!spread && i.code.length > SPRAWL_ANCHORS && files > SPRAWL_FILES) out.push({ code: 'sprawl', text: `${i.code.length} code anchors in ${files} files: markers belong only where the requirement is implemented` });
  return out;
}

/** The verifier's `anchor-sprawl` thresholds (`wingman-spec guard`): more than this many anchors in more than this many files. */
export const SPRAWL_ANCHORS = 6;
export const SPRAWL_FILES = 3;

/** The insight for a living requirement, or undefined when the key matches none. */
export function insightOf(model: TraceModel, key: string, adrs: RootAdr[] = []): ReqInsight | undefined {
  const r = model.requirements.get(key);
  if (!r) return undefined;
  const scenarios: ScenarioInsight[] = r.scenarios.map((s) => {
    const tests = r.tests.filter((t) => t.kind === 'tag' && t.scenario === s.slug);
    return { name: s.name, slug: s.slug, line: s.line, steps: s.steps, tested: tests.length > 0, tests };
  });
  const pending = pendingOf(model, key);
  const testedCount = scenarios.filter((s) => s.tested).length;
  const base = { pending, why: r.why, scenarios, testedCount, code: r.code };
  return {
    key: r.key,
    cap: r.cap,
    name: r.name,
    statement: r.statement,
    file: r.file,
    line: r.line,
    why: r.why,
    scenarios,
    testedCount,
    code: r.code,
    tests: r.tests,
    pending,
    adrs: adrsMentioning(adrs, r.key, r.name),
    warnings: warningsOf(base, /^\s*Anchors:\s*many\b/mi.test(r.block) || model.many.has(r.key)),
  };
}

/** The text above a marker: "3/4 scenarios tested · Why: ... · 2 code anchors", with a warning sign when something needs attention. */
export function lensText(i: ReqInsight): string {
  const sc = i.scenarios.length === 0 ? 'no scenarios' : `${i.testedCount}/${i.scenarios.length} scenarios tested`;
  const who = i.why ? `Why: ${clipWords(i.why, 40)}` : 'no Why';
  return `${i.warnings.length ? '$(warning) ' : ''}${sc} · ${who} · ${plural(i.code.length, 'code anchor')}`;
}

/** At most `n` characters, cut at a word boundary, with an ellipsis when something was left out. */
function clipWords(t: string, n: number): string {
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 1))}…`;
}

/** Tooltip of that lens: the requirement in words, then every warning. */
export function lensTooltip(i: ReqInsight): string {
  return [`${i.name} (${i.key})`, i.why ? `Why: ${i.why}` : '', i.statement, ...i.warnings.map((w) => `Warning: ${w.text}`)].filter(Boolean).join('\n');
}

export interface UnresolvedInfo {
  /** The most similar existing requirement key, if any. */
  hint?: string;
  /** A pending change that adds a requirement with this key (so the marker is early, not wrong). */
  addedBy?: string;
  /** A pending change that renames the old requirement to this key's slug. */
  renamedBy?: { change: string; from: string };
  text: string;
}

/** Why a marker matches nothing: renamed, removed, early (added by a pending change) or just wrong; with a did-you-mean. */
export function unresolvedInfo(model: TraceModel, key: string): UnresolvedInfo {
  const [cap = ''] = key.split('/');
  for (const c of model.changes) {
    for (const [from, t] of c.touches) {
      if (t.op === 'RENAMED' && t.to && `${cap}/${slug(t.to)}` === key) return { renamedBy: { change: c.name, from }, text: `renamed from ${from} by pending change ${c.name}` };
    }
  }
  for (const c of model.changes) {
    if (c.requirements.has(key) && !model.requirements.has(key)) return { addedBy: c.name, hint: key, text: `added by pending change ${c.name}, not archived yet` };
  }
  const renamedAway = model.changes.flatMap((c) => [...c.touches].filter(([k, t]) => k === key && t.op === 'RENAMED').map(() => c.name))[0];
  const hint = nearest(key, model.requirements.keys());
  return { ...(hint ? { hint } : {}), text: `no such requirement${renamedAway ? ` (being renamed by ${renamedAway})` : ''}${hint ? `; did you mean ${hint}?` : ''}` };
}

export function unresolvedLensText(key: string, info: UnresolvedInfo): string {
  return `$(warning) @spec ${key}: ${info.text}`;
}

/** Where a requirement shows in the Wingman Spec UI. */
export type RevealTarget = { type: 'requirement'; key: string } | { type: 'scenario'; key: string; scenario: string };

export interface MenuItem {
  id: string;
  label: string;
  description?: string;
  detail?: string;
  /** Absolute file and zero-based line to open. */
  file?: string;
  line?: number;
  reveal?: RevealTarget;
  /** Create a test for this scenario in `createIn` (relative to the code root). */
  create?: { scenario: string; file: string };
}

const loc = (a: AnchorRef): string => `${a.file}:${a.line + 1}`;

/** Quick-pick rows for the scenarios: tested ones jump to their test, untested ones offer to create or open the likely test file. */
export function scenarioMenu(i: ReqInsight, codeRoot: string, plan: TestPlan | undefined, join: (root: string, rel: string) => string): MenuItem[] {
  const rows: MenuItem[] = [{ id: 'req', label: `$(book) ${plain(i.name)}`, description: 'open in Wingman Spec', detail: plain(i.statement), reveal: { type: 'requirement', key: i.key } }];
  for (const s of i.scenarios) {
    if (s.tested) {
      const first = s.tests[0];
      rows.push({
        id: `scn:${s.slug}`,
        label: `$(pass) ${plain(s.name)}`,
        description: `tested in ${s.tests.map(loc).join(', ')}`,
        ...(first ? { file: join(codeRoot, first.file), line: first.line } : {}),
      });
    } else if (plan) {
      rows.push({
        id: `scn:${s.slug}`,
        label: `$(circle-outline) ${plain(s.name)}`,
        description: plan.exists ? `no test yet: open ${plan.file}` : `no test yet: create ${plan.file}`,
        detail: plan.reason,
        ...(plan.exists ? { file: join(codeRoot, plan.file) } : {}),
        create: { scenario: s.slug, file: plan.file },
      });
    } else {
      rows.push({ id: `scn:${s.slug}`, label: `$(circle-outline) ${plain(s.name)}`, description: 'no test yet', reveal: { type: 'scenario', key: i.key, scenario: s.slug } });
    }
  }
  return rows;
}

export interface TestPlan {
  file: string;
  exists: boolean;
  reason: string;
}

const EXT = /\.([A-Za-z0-9]+)$/;

/** Conventional test-file paths for a source file, most likely first. */
export function testCandidates(sourceRel: string): string[] {
  const dir = sourceRel.includes('/') ? sourceRel.slice(0, sourceRel.lastIndexOf('/')) : '';
  const file = sourceRel.slice(sourceRel.lastIndexOf('/') + 1);
  const ext = EXT.exec(file)?.[1] ?? '';
  const base = file.replace(EXT, '');
  const at = (d: string, f: string): string => (d ? `${d}/${f}` : f);
  const top = dir.split('/')[0] ?? '';
  const rest = dir.includes('/') ? dir.slice(dir.indexOf('/') + 1) : '';
  const out: string[] = [];
  if (ext === 'py') {
    out.push(at(dir, `test_${base}.py`), `tests/test_${base}.py`, `test/test_${base}.py`, at(dir, `${base}_test.py`));
  } else if (ext === 'go') {
    out.push(at(dir, `${base}_test.go`));
  } else if (ext === 'rb') {
    out.push(`spec/${at(rest, `${base}_spec.rb`)}`, at(dir, `${base}_spec.rb`), `test/${at(rest, `${base}_test.rb`)}`);
  } else if (ext === 'java' || ext === 'kt' || ext === 'cs') {
    out.push(at(dir, `${base}Test.${ext}`), at(dir, `${base}Tests.${ext}`));
  } else if (ext) {
    out.push(at(dir, `${base}.test.${ext}`), at(dir, `${base}.spec.${ext}`), at(dir, `__tests__/${base}.test.${ext}`));
    const under = (root: string): string => `${root}/${at(rest, `${base}.test.${ext}`)}`;
    if (top === 'src' || top === 'lib' || top === 'app') out.push(under('tests'), under('test'));
    out.push(`tests/${base}.test.${ext}`, `test/${base}.test.${ext}`);
  }
  return [...new Set(out)];
}

/**
 * The test file to jump to or create for an untested scenario. Prefers a test file that already carries a test of this
 * requirement, then an existing conventional test file next to the code, else the conventional path to create.
 */
export function planTest(i: ReqInsight, exists: (rel: string) => boolean): TestPlan | undefined {
  const known = i.tests[0];
  if (known) return { file: known.file, exists: true, reason: 'a test of this requirement already lives there' };
  const sources = [...new Set(i.code.map((c) => c.file))];
  for (const s of sources) {
    for (const c of testCandidates(s)) if (exists(c)) return { file: c, exists: true, reason: `the test file next to ${s}` };
  }
  const first = sources[0];
  const cand = first ? testCandidates(first)[0] : undefined;
  return first && cand ? { file: cand, exists: false, reason: `the conventional test file for ${first}` } : undefined;
}

/** A starter test for one scenario, tagged so `wingman-spec` and the CodeLens find it. */
export function testStub(i: ReqInsight, scenarioSlug: string, file: string): string {
  const s = i.scenarios.find((x) => x.slug === scenarioSlug);
  const tag = `[${i.cap}/${scenarioSlug}]`;
  const title = `${s?.name ?? scenarioSlug} ${tag}`.replace(/'/g, "\\'");
  const given = (s?.steps ?? []).map((st) => `${st.keyword} ${st.text}`);
  const ext = EXT.exec(file)?.[1] ?? '';
  if (ext === 'py') {
    const fn = `test_${scenarioSlug.replace(/-/g, '_')}`;
    return `def ${fn}():\n    # @spec ${i.key}\n    # ${tag}\n${given.map((g) => `    # ${g}`).join('\n')}${given.length ? '\n' : ''}    raise NotImplementedError\n`;
  }
  if (ext === 'go') {
    const fn = `Test${scenarioSlug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')}`;
    return `// @spec ${i.key}\n// ${tag}\nfunc ${fn}(t *testing.T) {\n${given.map((g) => `\t// ${g}`).join('\n')}${given.length ? '\n' : ''}\tt.Fatal("not written yet")\n}\n`;
  }
  return `// @spec ${i.key}\nit('${title}', () => {\n${given.map((g) => `  // ${g}`).join('\n')}${given.length ? '\n' : ''}  throw new Error('not written yet');\n});\n`;
}

/** `commands.test` of wingman-spec.yaml, or undefined when unset, `none` or the `<fill in>` placeholder. */
export function readTestCommand(configText: string): string | undefined {
  const block = /^commands:[ \t]*\n((?:[ \t]+.*\n?|[ \t]*\n)*)/m.exec(configText);
  const m = block ? /^[ \t]+test:[ \t]*(.*)$/m.exec(block[1] ?? '') : null;
  if (!m) return undefined;
  let c = (m[1] ?? '').trim();
  const q = /^(['"])(.*)\1/.exec(c);
  c = (q ? q[2] : c.replace(/\s+#.*$/, '')) ?? '';
  c = c.trim();
  if (!c || /^(none|off|n\/a)$/i.test(c) || /^<.*>$/.test(c) || /fill in/i.test(c)) return undefined;
  return c;
}

const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;
const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, (c) => (c === '/' ? '/' : `\\${c}`));

/**
 * The test command narrowed to a requirement's scenario tags. `{tags}` in the configured command is replaced by a
 * regex of the tags; otherwise a known runner's name filter is appended (`scriptText` is the `scripts.test` of
 * package.json when the command is `npm test` and friends). An unknown runner gets the full command: `filtered: false`.
 */
export function filteredTestCommand(cmd: string, tags: string[], scriptText?: string): { command: string; filtered: boolean } {
  const pattern = tags.map((t) => `\\[${reEscape(t)}\\]`).join('|');
  if (!tags.length) return { command: cmd, filtered: false };
  if (cmd.includes('{tags}')) return { command: cmd.split('{tags}').join(shq(pattern)), filtered: true };
  const wrapper = /^(npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/.exec(cmd);
  const runner = wrapper ? (scriptText ?? '') : cmd;
  const via = wrapper ? (wrapper[1] === 'npm' ? ' --' : '') : '';
  const flag =
    /\bnode\b.*--test\b/.test(runner) ? `--test-name-pattern=${shq(pattern)}`
    : /\b(vitest|jest)\b/.test(runner) ? `-t ${shq(pattern)}`
    : /\bmocha\b/.test(runner) ? `--grep ${shq(pattern)}`
    : /\bpytest\b/.test(runner) ? `-k ${shq(tags.join(' or '))}`
    : '';
  return flag ? { command: `${cmd}${via} ${flag}`, filtered: true } : { command: cmd, filtered: false };
}
