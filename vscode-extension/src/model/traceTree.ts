/** Pure tree for the "Wingman Spec: Requirements & traceability" view: no VS Code types, so it is unit-testable. */
import { join } from 'node:path';
import type { Route } from '../webview/types.ts';
import { plain } from './markdown.ts';
import { revealRoute } from './reveal.ts';
import type { AnchorRef, GapType, RequirementFlag, TraceModel, TraceRequirement } from './traceability.ts';

export interface TraceNode {
  id: string;
  label: string;
  description?: string;
  tooltip?: string;
  /** A codicon id, e.g. `warning`. */
  icon: string;
  /** Absolute file to open on click, with an optional zero-based line. */
  file?: string;
  line?: number;
  /** Where a click goes: the Wingman Spec UI revealed on this item. Nodes without one open `file`. `file` is then the secondary "Open spec.md" action. */
  route?: Route;
  children: TraceNode[];
}

export const REQUIREMENT_FLAG_TEXT: Record<RequirementFlag, string> = {
  'no-why': 'no Why line (who wants it, and why)',
  'no-code-anchor': 'no code anchor',
  'no-test-anchor': 'no test anchor',
};

export const GAP_TITLE: Record<GapType, string> = {
  'unanchored-requirement': 'Requirements without a code anchor',
  'untested-requirement': 'Requirements without a test anchor',
  'orphan-anchor': 'Markers pointing at no requirement',
  'stale-test-tag': 'Stale test tags',
  'unsynced-archive': 'Archived but not synced',
  'over-anchored': 'Markers that say too little (too many, or on boilerplate)',
};

const clip = (s: string, n = 90): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const plural = (n: number, w: string): string => `${n} ${w}${n === 1 ? '' : 's'}`;

function anchorNode(codeRoot: string, kind: 'code' | 'test', a: AnchorRef, id: string): TraceNode {
  return {
    id,
    label: `${a.file}:${a.line + 1}`,
    description: kind === 'code' ? 'code' : a.kind === 'tag' ? 'test tag' : 'test',
    icon: kind === 'code' ? 'symbol-method' : 'beaker',
    file: join(codeRoot, a.file),
    line: a.line,
    children: [],
  };
}

export function requirementNode(model: TraceModel, r: TraceRequirement, prefix: string): TraceNode {
  // A requirement that only exists in a pending change's delta has no anchors yet.
  const pending = model.requirements.get(r.key) !== r;
  const bits = pending ? [r.cap, 'in this change'] : [r.cap, plural(r.code.length, 'code anchor'), plural(r.tests.length, 'test')];
  const flags = r.flags.filter((f) => !pending || f === 'no-why').map((f) => REQUIREMENT_FLAG_TEXT[f]);
  const children: TraceNode[] = [
    ...(pending ? [] : r.code).map((a, i) => anchorNode(model.codeRoot, 'code', a, `${prefix}/c${i}`)),
    ...(pending ? [] : r.tests).map((a, i) => anchorNode(model.codeRoot, 'test', a, `${prefix}/t${i}`)),
  ];
  return {
    id: prefix,
    label: plain(r.name),
    description: [r.why ? clip(plain(r.why), 60) : '', ...bits].filter(Boolean).join(' · '),
    tooltip: plain([r.why ? `Why: ${r.why}` : '', r.statement, ...flags.map((f) => `Warning: ${f}`)].filter(Boolean).join('\n')),
    icon: r.flags.includes('no-why') ? 'warning' : !pending && r.flags.length ? 'circle-outline' : 'pass',
    file: r.file,
    line: r.line,
    route: revealRoute(model, { type: 'requirement', key: r.key }),
    children,
  };
}

/** The whole tree for one project. */
export function buildTraceNodes(model: TraceModel): TraceNode[] {
  const out: TraceNode[] = [];
  if (model.mode === 'off' && !model.hasLayer) {
    return [{ id: 'off', label: 'Traceability is off', description: 'set `traceability: on` in openspec/config.yaml', icon: 'info', children: [] }];
  }

  const reqs = [...model.requirements.values()];
  const noWhy = reqs.filter((r) => r.why === null);
  const byCap = new Map<string, TraceRequirement[]>();
  for (const r of reqs) byCap.set(r.cap, [...(byCap.get(r.cap) ?? []), r]);
  out.push({
    id: 'requirements',
    label: 'Requirements',
    description: `${reqs.length}${noWhy.length ? ` · ${noWhy.length} without a Why` : ''}`,
    tooltip: 'openspec/specs/: each requirement with the one-line Why (who wants it, and why).',
    icon: noWhy.length ? 'warning' : 'target',
    children: [...byCap].map(([cap, rs]) => ({
      id: `cap/${cap}`,
      label: cap,
      description: plural(rs.length, 'requirement'),
      icon: 'symbol-ruler',
      children: rs.map((r) => requirementNode(model, r, `req/${r.key}`)),
    })),
  });

  const changes = model.changes.filter((c) => c.missingWhy.length || c.approvals.length);
  if (changes.length) {
    out.push({
      id: 'changes',
      label: 'Changes',
      description: plural(changes.length, 'change'),
      icon: 'git-pull-request',
      children: changes.map((c) => {
        const needsOwner = c.approvals.length > 0 && !c.approval;
        const children: TraceNode[] = [
          ...c.missingWhy.map((k) => ({ id: `change/${c.name}/nowhy/${k}`, label: k, description: 'no Why line', icon: 'warning', children: [] as TraceNode[] })),
          ...c.approvals.map((a) => ({
            id: `change/${c.name}/approval/${a.key}`,
            label: a.key,
            description: a.status === 'removed' ? 'removed: owner approval' : 'Why rewritten: owner approval',
            tooltip: [a.was ? `Was: ${a.was}` : '', a.now ? `Now: ${a.now}` : ''].filter(Boolean).join('\n'),
            icon: c.approval ? 'check' : 'warning',
            file: a.file,
            line: a.line,
            children: [] as TraceNode[],
          })),
        ];
        return {
          id: `change/${c.name}`,
          label: c.name,
          description: [c.missingWhy.length ? `${c.missingWhy.length} without a Why` : '', c.approvals.length ? (c.approval ? `approved: ${clip(c.approval, 40)}` : 'needs owner approval') : ''].filter(Boolean).join(' · '),
          icon: c.missingWhy.length || needsOwner ? 'warning' : 'git-pull-request',
          file: c.proposal,
          children,
        };
      }),
    });
  }

  const open = model.gaps.filter((g) => !g.accepted);
  const byType = new Map<GapType, typeof model.gaps>();
  for (const g of model.gaps) byType.set(g.type, [...(byType.get(g.type) ?? []), g]);
  out.push({
    id: 'drift',
    label: 'Drift',
    description: open.length ? `${open.length} open${model.gaps.length > open.length ? ` · ${model.gaps.length - open.length} accepted` : ''}` : 'no open gaps',
    tooltip: 'Same gaps as `node openspec/scripts/verify-task.cjs drift` (read from the files, nothing is run).',
    icon: open.length ? 'warning' : 'pass',
    children: [...byType].map(([type, gs]) => ({
      id: `drift/${type}`,
      label: GAP_TITLE[type],
      description: String(gs.length),
      icon: 'warning',
      children: gs.map((g) => ({
        id: `drift/${g.key}`,
        label: plain(g.subject),
        description: g.accepted ? `accepted: ${g.accepted}` : undefined,
        tooltip: plain(g.text),
        icon: g.accepted ? 'check' : 'circle-outline',
        ...(g.file ? { file: g.file, line: g.line ?? 0 } : {}),
        ...(g.type === 'unanchored-requirement' || g.type === 'untested-requirement' ? { route: revealRoute(model, { type: 'requirement', key: g.subject }) } : {}),
        children: [],
      })),
    })),
  });
  out.push({
    id: 'branch-review',
    label: 'Branch review',
    description: 'this branch against its base',
    tooltip: 'Requirements and anchors touched by the current git branch, what is untested, and the verifier findings in the diff.',
    icon: 'git-compare',
    route: { page: 'branch', root: model.root },
    children: [],
  });

  return out;
}
