/** The pure part of the code view: what a marker or tag resolves to, its CodeLens title, hover text and diagnostics. */
import { isScannable, isTestFile, isTestPath, markersIn, tagsIn } from './anchors.ts';
import placement from '../core/placement.ts';
import { unresolvedInfo } from './reqInsight.ts';
import type { TraceModel, TraceRequirement } from './traceability.ts';

export type Resolved =
  | { kind: 'marker'; requirement: TraceRequirement }
  | { kind: 'tag'; requirement: TraceRequirement; scenario: { name: string; line: number } };

/** What `@spec cap/slug` (marker) or `[cap/scenario-slug]` (tag) points at, if anything. */
export function resolve(model: TraceModel, kind: 'marker' | 'tag', key: string): Resolved | undefined {
  if (kind === 'marker') {
    const requirement = model.requirements.get(key);
    return requirement ? { kind, requirement } : undefined;
  }
  const [cap, scen] = key.split('/');
  for (const r of model.requirements.values()) {
    if (r.cap !== cap) continue;
    const s = r.scenarios.find((x) => x.slug === scen);
    if (s) return { kind, requirement: r, scenario: { name: s.name, line: s.line } };
  }
  return undefined;
}

const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

/** CodeLens title on the requirement heading in the spec (reverse lookup). */
export function reverseTitle(r: TraceRequirement): string {
  return r.code.length || r.tests.length ? `${plural(r.code.length, 'code anchor')} · ${plural(r.tests.length, 'test anchor')}` : 'no anchors yet';
}

export interface AnchorProblem {
  line: number;
  col: number;
  length: number;
  message: string;
  /** `unresolved-marker`, `unresolved-tag` or `marker-placement` (`over-anchored` comes from `wingman-spec problems`). */
  code: string;
  /** `anchor_placement: error` raises placement findings to errors. */
  severity?: 'error';
}

/**
 * Warnings for one document: `@spec` markers that match no requirement and `[cap/scenario]` test tags that match no
 * scenario of a capability that exists. `rel` is the path relative to the code root.
 */
export function anchorProblems(model: TraceModel, rel: string, text: string): AnchorProblem[] {
  if (!model.requirements.size || !isScannable(rel)) return [];
  const out: AnchorProblem[] = [];
  if (text.includes('@spec')) {
    for (const m of markersIn(text)) {
      if (model.requirements.has(m.key)) continue;
      const info = unresolvedInfo(model, m.key);
      out.push({ line: m.line, col: m.col, length: m.length, code: 'unresolved-marker', message: `\`@spec ${m.key}\` does not match a requirement in the living specs: ${info.text}` });
    }
  }
  if (model.placement !== 'off' && text.includes('@spec')) {
    const lines = text.split('\n');
    for (const f of placement.placementFindings(text, isTestPath(rel))) {
      const l = lines[f.line - 1] ?? '';
      const col = l.length - l.trimStart().length;
      out.push({ line: f.line - 1, col, length: Math.max(1, l.trim().length), code: 'marker-placement', message: `${f.kind}: ${f.text}`, ...(model.placement === 'error' ? { severity: 'error' as const } : {}) });
    }
  }
  if (isTestFile(rel)) {
    const caps = new Set([...model.requirements.values()].map((r) => r.cap));
    for (const t of tagsIn(text)) {
      if (resolve(model, 'tag', t.tag) || !caps.has(t.tag.split('/')[0] ?? '')) continue;
      out.push({ line: t.line, col: t.col, length: t.length, code: 'unresolved-tag', message: `Test tag [${t.tag}] does not match a scenario of capability ${t.tag.split('/')[0]}` });
    }
  }
  return out;
}
