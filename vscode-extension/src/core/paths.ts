/**
 * Where things are in a Wingman Spec project. `root` is the specs root (the CLI's `root --json` `specs`): `<repo>/.wingman-spec`
 * next to the code, the root of a specs repository, or the folder a linked code repo names with `specs: <path>`.
 * The code root is the workspace folder (its `.wingman-spec/bin/wingman-spec` is the CLI shim).
 */
import { join } from 'node:path';

/** The code root's folder and the config file name, as in the CLI (internal/layout). */
export const DIR = '.wingman-spec';
export const CONFIG = 'wingman-spec.yaml';

export const livingSpecsDir = (root: string): string => join(root, 'specs');
/** The living spec of a capability: `specs/<capability>.md`. */
export const livingSpec = (root: string, cap: string): string => join(root, 'specs', `${cap}.md`);
export const changesDir = (root: string): string => join(root, 'changes');
/** A change's delta spec of a capability: `changes/<change>/specs/<capability>.md`. */
export const deltaSpec = (changeDir: string, cap: string): string => join(changeDir, 'specs', `${cap}.md`);
export const archiveDir = (root: string): string => join(root, 'archive');
export const adrsDir = (root: string): string => join(root, 'adrs');
export const observedDir = (root: string): string => join(root, 'observed');
/** Run state of a change (`runs/<change>/`: current, <run id>/state.json, verified.json, timeline.jsonl). */
export const runsDir = (root: string, change: string): string => join(root, 'runs', change);
export const greenfieldFile = (root: string): string => join(root, 'greenfield.yaml');
export const roadmapDir = (root: string): string => join(root, 'roadmap');

/** Config files, highest priority first: the code repo's `.wingman-spec/wingman-spec.yaml`, then the specs root's (deduplicated). */
export const configFiles = (codeRoot: string, root: string): string[] => [...new Set([join(codeRoot, DIR, CONFIG), join(root, CONFIG)])];

/** The CLI shim `wingman-spec init` writes into the code root (what terminal commands and agents run). */
export const SHIM = `${DIR}/bin/wingman-spec`;
/** A terminal command line for the CLI. */
export const cli = (args: string): string => `${SHIM} ${args}`.trim();

/** `changes/<n>/specs/<cap>.md` (or the living `specs/<cap>.md`) relative to a specs root: the capability, else undefined. */
export function capabilityOf(rel: string[]): string | undefined {
  const name = (s: string | undefined): string | undefined => (s && s.endsWith('.md') ? s.slice(0, -3) : undefined);
  if (rel.length === 2 && rel[0] === 'specs') return name(rel[1]);
  if (rel.length === 4 && rel[0] === 'changes' && rel[2] === 'specs') return name(rel[3]);
  return undefined;
}
