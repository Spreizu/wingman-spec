import { buildAdrLinks } from './adrGraph.ts';
import type { RootAdr } from './types.ts';

export const NODE_W = 210;
export const NODE_H = 54;
const COL_GAP = 90;
const ROW_GAP = 22;
const COMPONENT_GAP = 40;
const PAD = 16;

export interface GraphNode {
  adr: RootAdr;
  x: number;
  y: number;
}

export interface GraphEdge {
  /** The superseded (older) ADR. */
  from: string;
  /** The superseding (newer) ADR. */
  to: string;
}

export interface AdrGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** ADRs with no supersede links at all. */
  standalone: RootAdr[];
  width: number;
  height: number;
}

/**
 * Lays out supersede chains left to right: an ADR sits one column right of the ADR it supersedes.
 * Each connected group of linked ADRs is a block; blocks are stacked. Cycles are tolerated.
 */
export function layoutAdrGraph(adrs: RootAdr[]): AdrGraph {
  const links = buildAdrLinks(adrs);
  const linked = adrs.filter((a) => {
    const l = links.get(a.number);
    return l !== undefined && (l.supersedes !== undefined || l.supersededBy.length > 0);
  });
  const standalone = adrs.filter((a) => !linked.includes(a));

  const parent = new Map<string, string>();
  const find = (n: string): string => {
    let cur = n;
    while ((parent.get(cur) ?? cur) !== cur) cur = parent.get(cur) ?? cur;
    return cur;
  };
  for (const a of linked) parent.set(a.number, a.number);
  const edges: GraphEdge[] = [];
  for (const a of linked) {
    const old = links.get(a.number)?.supersedes;
    if (old) {
      edges.push({ from: old.number, to: a.number });
      parent.set(find(old.number), find(a.number));
    }
  }

  const groups = new Map<string, RootAdr[]>();
  for (const a of linked) {
    const key = find(a.number);
    groups.set(key, [...(groups.get(key) ?? []), a]);
  }

  const nodes: GraphNode[] = [];
  let y = PAD;
  let maxCols = 1;
  for (const members of [...groups.values()].sort((a, b) => (a[0]?.number ?? '').localeCompare(b[0]?.number ?? ''))) {
    const depth = new Map<string, number>();
    const visit = (n: string, seen: Set<string>): number => {
      const cached = depth.get(n);
      if (cached !== undefined) return cached;
      if (seen.has(n)) return 0;
      seen.add(n);
      const old = links.get(n)?.supersedes;
      const d = old ? visit(old.number, seen) + 1 : 0;
      depth.set(n, d);
      return d;
    };
    for (const m of members) visit(m.number, new Set());

    const columns = new Map<number, RootAdr[]>();
    for (const m of [...members].sort((a, b) => a.number.localeCompare(b.number))) {
      const d = depth.get(m.number) ?? 0;
      columns.set(d, [...(columns.get(d) ?? []), m]);
    }
    const tallest = Math.max(...[...columns.values()].map((c) => c.length));
    for (const [d, col] of columns) {
      maxCols = Math.max(maxCols, d + 1);
      col.forEach((adr, i) => nodes.push({ adr, x: PAD + d * (NODE_W + COL_GAP), y: y + i * (NODE_H + ROW_GAP) }));
    }
    y += tallest * (NODE_H + ROW_GAP) - ROW_GAP + COMPONENT_GAP;
  }

  return {
    nodes,
    edges,
    standalone,
    width: PAD * 2 + maxCols * NODE_W + (maxCols - 1) * COL_GAP,
    height: nodes.length === 0 ? 0 : y - COMPONENT_GAP + PAD,
  };
}
