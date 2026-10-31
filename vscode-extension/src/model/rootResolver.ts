import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { CONFIG, DIR } from '../core/paths.ts';
import { scanProject } from './changeScanner.ts';
import { readYamlKey } from './frontMatter.ts';
import type { ProjectModel } from './types.ts';

export interface ResolvedRoot {
  workspaceFolder: string;
  /** The specs root. */
  root: string;
  source: ProjectModel['source'];
  error?: string;
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await fs.stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function canonical(path: string): Promise<string> {
  try {
    return await fs.realpath(path);
  } catch {
    return path;
  }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Finds the specs root of one workspace folder, in the CLI's order (internal/layout):
 * 1. `.wingman-spec/wingman-spec.yaml` without `specs:`: the specs live next to the code, in `.wingman-spec/`.
 * 2. `.wingman-spec/wingman-spec.yaml` with `specs: <path>`: a code repo linked to a separate specs repository.
 * 3. `wingman-spec.yaml` at the folder root: the folder is a specs repository.
 * Returns undefined when the folder has none of these.
 */
export async function resolveRoot(folder: string): Promise<ResolvedRoot | undefined> {
  const inner = await readOptional(join(folder, DIR, CONFIG));
  if (inner !== undefined) {
    const link = readYamlKey(inner, 'specs');
    if (!link) return { workspaceFolder: folder, root: join(folder, DIR), source: 'local' };
    const root = isAbsolute(link) ? link : resolve(folder, link);
    return {
      workspaceFolder: folder,
      root,
      source: 'linked',
      ...((await isDir(root)) ? {} : { error: `Specs repository not found at ${root} (from ${DIR}/${CONFIG}). Clone it there or fix 'specs:'.` }),
    };
  }
  if ((await readOptional(join(folder, CONFIG))) !== undefined) return { workspaceFolder: folder, root: folder, source: 'specs-repo' };
  return undefined;
}

/**
 * Resolves and scans every workspace folder. Folders that resolve to the same specs root (a code repo that links to its specs
 * repo, plus the specs repo folder itself) appear once, labelled by the code folder.
 */
export async function loadProjects(folders: string[]): Promise<ProjectModel[]> {
  const projects: ProjectModel[] = [];
  const seen = new Map<string, number>();
  for (const folder of folders) {
    const resolved = await resolveRoot(folder);
    if (!resolved) continue;
    const key = await canonical(resolved.root);
    const existing = seen.get(key);
    if (existing !== undefined) {
      // A code folder that links here wins over the specs repo folder: its CLI shim runs the commands.
      if (resolved.source === 'linked' && projects[existing]?.source === 'specs-repo') {
        const model = await scanProject(resolved.root);
        projects[existing] = { ...model, workspaceFolder: folder, source: 'linked' };
      }
      continue;
    }
    seen.set(key, projects.length);
    if (resolved.error) {
      projects.push({ root: resolved.root, workspaceFolder: folder, source: resolved.source, error: resolved.error, changes: [], archive: [], adrs: [], adrDir: '' });
      continue;
    }
    const model = await scanProject(resolved.root);
    projects.push({ ...model, workspaceFolder: folder, source: resolved.source });
  }
  return projects;
}
