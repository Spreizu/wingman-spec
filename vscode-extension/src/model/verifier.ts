/**
 * The verifier's own findings (`wingman-spec problems`) as the editor reads them: one located list. Parsing is tolerant
 * (a malformed entry is dropped, never thrown) because the JSON comes from a script in the workspace.
 */

export type FindingSeverity = 'error' | 'warning' | 'info';

export interface FindingFix {
  kind: 'replace-key' | 'move-marker' | 'remove-duplicate' | 'remove-marker' | 'add-why' | 'accept' | 'add-test-tag';
  /** replace-key: the key to put instead. */
  to?: string;
  /** add-test-tag: the scenarios of the requirement. */
  scenarios?: { name: string; id: string }[];
}

export interface VerifierFinding {
  source: 'lint' | 'drift' | 'guard' | string;
  code: string;
  severity: FindingSeverity;
  message: string;
  /** Absolute path. */
  file: string;
  /** 1-based. */
  line: number;
  col: number;
  length: number;
  /** drift: the gap key `drift decide` takes. */
  key?: string;
  change?: string;
  hint?: string;
  requirement?: string;
  fix?: FindingFix;
}

export interface ProblemsReport {
  ok: boolean;
  findings: VerifierFinding[];
  notes: string[];
}

const SEVERITIES = new Set(['error', 'warning', 'info']);
const FIXES = new Set(['replace-key', 'move-marker', 'remove-duplicate', 'remove-marker', 'add-why', 'accept', 'add-test-tag']);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;

function fixOf(v: unknown): FindingFix | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (!isStr(o['kind']) || !FIXES.has(o['kind'])) return undefined;
  const scenarios = Array.isArray(o['scenarios'])
    ? o['scenarios'].filter((s): s is { name: string; id: string } => typeof s === 'object' && s !== null && isStr((s as Record<string, unknown>)['name']) && isStr((s as Record<string, unknown>)['id']))
    : undefined;
  return { kind: o['kind'] as FindingFix['kind'], ...(isStr(o['to']) ? { to: o['to'] } : {}), ...(scenarios ? { scenarios } : {}) };
}

export function findingOf(v: unknown): VerifierFinding | undefined {
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (!isStr(o['source']) || !isStr(o['code']) || !isStr(o['severity']) || !SEVERITIES.has(o['severity']) || !isStr(o['message']) || !isStr(o['file']) || !o['file']) return undefined;
  if (!isPosInt(o['line'])) return undefined;
  const fix = fixOf(o['fix']);
  return {
    source: o['source'],
    code: o['code'],
    severity: o['severity'] as FindingSeverity,
    message: o['message'],
    file: o['file'],
    line: o['line'],
    col: isPosInt(o['col']) ? o['col'] : 1,
    length: isPosInt(o['length']) ? o['length'] : 1,
    ...(isStr(o['key']) ? { key: o['key'] } : {}),
    ...(isStr(o['change']) ? { change: o['change'] } : {}),
    ...(isStr(o['hint']) ? { hint: o['hint'] } : {}),
    ...(isStr(o['requirement']) ? { requirement: o['requirement'] } : {}),
    ...(fix ? { fix } : {}),
  };
}

/** Parses the stdout of `problems`; undefined when it is not the expected JSON at all. */
export function parseProblems(stdout: string): ProblemsReport | undefined {
  let j: unknown;
  try {
    j = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof j !== 'object' || j === null || !Array.isArray((j as Record<string, unknown>)['findings'])) return undefined;
  const o = j as Record<string, unknown>;
  const findings = (o['findings'] as unknown[]).map(findingOf).filter((f): f is VerifierFinding => f !== undefined);
  const notes = Array.isArray(o['notes']) ? (o['notes'] as unknown[]).filter(isStr) : [];
  return { ok: o['ok'] === true, findings, notes };
}

/** Maps the findings of `guard <change>` (kind, key, file, line, text) to the common shape. */
export function parseGuard(stdout: string, root: string, change: string): VerifierFinding[] {
  let j: unknown;
  try {
    j = JSON.parse(stdout);
  } catch {
    return [];
  }
  const o = (typeof j === 'object' && j !== null ? j : {}) as Record<string, unknown>;
  const level = o['level'] === 'error' ? 'error' : 'warning';
  if (!Array.isArray(o['findings'])) return [];
  const out: VerifierFinding[] = [];
  for (const x of o['findings']) {
    const f = (typeof x === 'object' && x !== null ? x : {}) as Record<string, unknown>;
    if (!isStr(f['kind']) || !isStr(f['text']) || !isStr(f['file'])) continue;
    out.push({
      source: 'guard',
      code: f['kind'],
      severity: level,
      message: f['text'],
      file: f['file'].startsWith('/') ? f['file'] : `${root}/${f['file']}`,
      line: isPosInt(f['line']) ? f['line'] : 1,
      col: 1,
      length: 1,
      ...(isStr(f['key']) ? { key: f['key'] } : {}),
      change,
    });
  }
  return out;
}

export interface SyncCheckReport {
  ok: boolean;
  problems: string[];
  warnings: string[];
}

/** `sync-check <change>`: { synced, problems: [..], warnings: [..], ... }. */
export function parseSyncCheck(stdout: string): SyncCheckReport | undefined {
  try {
    const o = JSON.parse(stdout) as Record<string, unknown>;
    const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter(isStr) : []);
    return { ok: o['synced'] === true || o['ok'] === true, problems: list(o['problems']), warnings: list(o['warnings']) };
  } catch {
    return undefined;
  }
}
