import { isPlaceholder } from './frontMatter.ts';
import type { RootAdr } from './types.ts';

export type AdrCategory = 'accepted' | 'proposed' | 'superseded' | 'deprecated' | 'other';

export function adrCategory(status: string): AdrCategory {
  const s = status.trim().toLowerCase();
  if (s.startsWith('accepted')) return 'accepted';
  if (s.startsWith('proposed')) return 'proposed';
  if (s.startsWith('superseded')) return 'superseded';
  if (s.startsWith('deprecated')) return 'deprecated';
  return 'other';
}

export function statusCounts(adrs: RootAdr[]): Record<AdrCategory, number> {
  const counts: Record<AdrCategory, number> = { accepted: 0, proposed: 0, superseded: 0, deprecated: 0, other: 0 };
  for (const a of adrs) counts[adrCategory(a.status)] += 1;
  return counts;
}

export interface AdrLinks {
  adr: RootAdr;
  /** The ADR this one replaces, when it exists. */
  supersedes?: RootAdr;
  /** ADRs that replace this one. */
  supersededBy: RootAdr[];
}

export function supersedesNumber(adr: RootAdr): string {
  return isPlaceholder(adr.supersedes) ? '' : adr.supersedes.trim();
}

export function buildAdrLinks(adrs: RootAdr[]): Map<string, AdrLinks> {
  const links = new Map<string, AdrLinks>();
  for (const adr of adrs) links.set(adr.number, { adr, supersededBy: [] });
  for (const adr of adrs) {
    const target = supersedesNumber(adr);
    if (!target) continue;
    const old = links.get(target);
    const self = links.get(adr.number);
    if (old && self) {
      self.supersedes = old.adr;
      old.supersededBy.push(adr);
    }
  }
  return links;
}

/** The chain of decisions this ADR belongs to, oldest first. Cycles are cut. */
export function lineageOf(number: string, links: Map<string, AdrLinks>): RootAdr[] {
  const seen = new Set<string>();
  let head = links.get(number);
  while (head?.supersedes && !seen.has(head.adr.number)) {
    seen.add(head.adr.number);
    head = links.get(head.supersedes.number);
  }
  const chain: RootAdr[] = [];
  const visited = new Set<string>();
  let cur = head;
  while (cur && !visited.has(cur.adr.number)) {
    visited.add(cur.adr.number);
    chain.push(cur.adr);
    const nextAdr: RootAdr | undefined = cur.supersededBy[0];
    cur = nextAdr ? links.get(nextAdr.number) : undefined;
  }
  return chain;
}
