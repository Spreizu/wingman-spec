/**
 * The roadmap of a new product as `verify-task.cjs roadmap --json` prints it: ordered slices, their derived state, and coverage. Parsing is tolerant (the JSON comes from a script in the workspace): a malformed entry is dropped.
 */

export type SliceStatus = 'planned' | 'proposed' | 'applying' | 'done';

export interface RoadmapSlice {
  id: string;
  title: string;
  size: string;
  requiredSize: string;
  milestone: string;
  status: SliceStatus;
  dependsOn: string[];
  /** `capability` (all of it) or `capability/requirement-slug`. */
  capabilities: string[];
  requirements: number;
  skeleton: boolean;
  contractTests: string[];
}

export interface RoadmapNote {
  code: string;
  slice: string | null;
  text: string;
}

export interface RoadmapReport {
  ok: boolean;
  slices: RoadmapSlice[];
  /** Slice ids in build order. */
  order: string[];
  /** Slices whose dependencies are done and that are not started. */
  nextUp: string[];
  counts: Record<SliceStatus, number>;
  coverage: { requirements: number; uncovered: string[] };
  errors: RoadmapNote[];
  warnings: RoadmapNote[];
}

const STATUSES: SliceStatus[] = ['planned', 'proposed', 'applying', 'done'];
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const notes = (v: unknown): RoadmapNote[] =>
  (Array.isArray(v) ? v : []).map(obj).filter((o) => str(o['text'])).map((o) => ({ code: str(o['code']), slice: typeof o['slice'] === 'string' ? o['slice'] : null, text: str(o['text']) }));

/** Parses the stdout of `roadmap --json`; undefined when it is not that JSON at all. */
export function parseRoadmap(stdout: string): RoadmapReport | undefined {
  let top: Record<string, unknown>;
  try {
    top = obj(JSON.parse(stdout));
  } catch {
    return undefined;
  }
  if (!Array.isArray(top['slices'])) return undefined;
  const slices: RoadmapSlice[] = [];
  for (const raw of top['slices']) {
    const s = obj(raw);
    const id = str(s['id']);
    if (!id) continue;
    const status = STATUSES.find((x) => x === s['status']) ?? 'planned';
    slices.push({
      id,
      title: str(s['title']),
      size: str(s['size']),
      requiredSize: str(s['required_size']) || str(s['size']),
      milestone: str(s['milestone']),
      status,
      dependsOn: strs(s['depends_on']),
      capabilities: strs(s['capabilities']),
      requirements: typeof s['requirements'] === 'number' ? s['requirements'] : 0,
      skeleton: s['skeleton'] === true,
      contractTests: strs(s['contract_tests']),
    });
  }
  const counts = obj(top['counts']);
  const cov = obj(top['coverage']);
  const known = new Set(slices.map((s) => s.id));
  const order = strs(top['order']).filter((id) => known.has(id));
  for (const s of slices) if (!order.includes(s.id)) order.push(s.id);
  return {
    ok: top['ok'] === true,
    slices,
    order,
    nextUp: strs(top['next_up']).filter((id) => known.has(id)),
    counts: Object.fromEntries(STATUSES.map((k) => [k, typeof counts[k] === 'number' ? counts[k] : slices.filter((s) => s.status === k).length])) as Record<SliceStatus, number>,
    coverage: { requirements: typeof cov['requirements'] === 'number' ? cov['requirements'] : 0, uncovered: strs(cov['uncovered']) },
    errors: notes(top['errors']),
    warnings: notes(top['warnings']),
  };
}

/** Slices in build order. */
export const orderedSlices = (r: RoadmapReport): RoadmapSlice[] => r.order.map((id) => r.slices.find((s) => s.id === id)).filter((s): s is RoadmapSlice => !!s);

/** Slices the given slice waits for that are not done yet. */
export const blockers = (r: RoadmapReport, s: RoadmapSlice): string[] => s.dependsOn.filter((d) => r.slices.find((x) => x.id === d)?.status !== 'done');
