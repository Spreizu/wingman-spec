/**
 * "Used by": which `@spec`-marked functions reach an unmarked one, walking its incoming calls (any language server's
 * call hierarchy) breadth-first, a bounded number of calls up. Pure: the editor passes the call hierarchy in.
 */
import placement from '../core/placement.ts';
import { commandLink } from './hoverText.ts';

const { ANNOTATION, COMMENT_LINE, keysOf } = placement;

/** Keys of the markers that cover a unit spanning lines start..end (zero-based): its doc comment above, and its body. */
export function unitKeys(lines: readonly string[], start: number, end: number, bodyToo = true): string[] {
  const keys: string[] = [];
  for (let i = start - 1; i >= 0 && (COMMENT_LINE.test(lines[i] ?? '') || ANNOTATION.test(lines[i] ?? '')); i--) keys.push(...keysOf(lines[i] ?? ''));
  if (bodyToo) for (let i = start; i <= end && i < lines.length; i++) keys.push(...keysOf(lines[i] ?? ''));
  return [...new Set(keys)];
}

export interface UsedBy<T> {
  key: string;
  /** The callers from the marked one down to the direct caller of the start. */
  via: T[];
}

export interface Walk<T> {
  /** Callers of an item (its incoming calls). */
  callers(item: T): Promise<T[]>;
  /** Requirement keys of an item's own markers; undefined: do not follow this item (tests, other folders, files). */
  keys(item: T): Promise<string[] | undefined>;
  /** Identity of an item (file and position), to visit each once. */
  id(item: T): string;
}

/** How far the walk goes: levels of callers, and incoming-call requests in total. */
export const USED_BY_DEPTH = 4;
export const USED_BY_CALLS = 30;

/**
 * Requirements whose marked functions call `start`, directly or through unmarked ones, each with the shortest chain.
 * A marked caller ends its branch. `truncated`: the call budget ran out before the depth did, so callers within it were left unvisited.
 */
export async function usedBy<T>(start: T, w: Walk<T>, depth = USED_BY_DEPTH, calls = USED_BY_CALLS): Promise<{ found: UsedBy<T>[]; truncated: boolean }> {
  const found = new Map<string, UsedBy<T>>();
  const seen = new Set([w.id(start)]);
  let frontier: { item: T; via: T[] }[] = [{ item: start, via: [] }];
  let truncated = false;
  for (let level = 0; frontier.length; level++) {
    if (level === depth) break;
    if (calls <= 0) {
      truncated = true;
      break;
    }
    const now = frontier.slice(0, calls);
    if (now.length < frontier.length) truncated = true;
    calls -= now.length;
    const lists = await Promise.all(now.map((f) => w.callers(f.item).catch((): T[] => [])));
    const next: { item: T; via: T[] }[] = [];
    for (const [i, list] of lists.entries()) {
      for (const c of list) {
        const id = w.id(c);
        if (seen.has(id)) continue;
        seen.add(id);
        const via = [c, ...(now[i]?.via ?? [])];
        const keys = await w.keys(c);
        if (!keys) continue;
        if (!keys.length) next.push({ item: c, via });
        for (const key of keys) if (!found.has(key)) found.set(key, { key, via });
      }
    }
    frontier = next;
  }
  return { found: [...found.values()], truncated };
}

/** A caller as the hover shows it: its name and where it is (absolute file, zero-based line). */
export interface Caller {
  name: string;
  file: string;
  line: number;
}

/** Hover markdown: each requirement (linked) with the chain of callers that reaches the hovered function. */
export function usedByHover(found: UsedBy<Caller>[], names: ReadonlyMap<string, string>, root: string, truncated: boolean): string {
  const out = ['**Used by**', ''];
  for (const f of found) {
    const via = f.via.map((c) => commandLink(c.name, 'wingmanSpec.openFile', [c.file, c.line])).join(' → ');
    out.push(`- ${commandLink(names.get(f.key) ?? f.key, 'wingmanSpec.revealRequirement', [root, f.key])} \`${f.key}\` via ${via}`);
  }
  if (truncated) out.push('', 'Some callers were not searched.');
  return out.join('\n');
}
