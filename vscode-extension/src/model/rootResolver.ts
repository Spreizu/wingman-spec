import { promises as fs } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { scanProject } from './changeScanner.ts';
import { readYamlKey } from './frontMatter.ts';
import type { ProjectModel } from './types.ts';

/** Runs the `openspec` CLI with `args` in `cwd` and resolves with stdout. Injected so tests need no CLI. */
export type ExecFn = (args: string[], cwd: string) => Promise<string>;

export interface ResolvedRoot {
  workspaceFolder: string;
  root: string;
  source: 'local' | 'linked' | 'store';
  storeId?: string;
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

function describeError(error: unknown): string {
  const e = error as { code?: string; message?: string };
  if (e?.code === 'ENOENT') {
    return 'The openspec CLI was not found. Install it or set wingmanSpec.openspecPath.';
  }
  return (e?.message ?? String(error)).split('\n')[0] ?? 'Unknown error';
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Finds the OpenSpec root for one workspace folder. The order matches the `/spec-*` commands and verify-task.cjs:
 * 1. `openspec/` with specs/ or changes/ is a real root (specs next to the code), and wins.
 * 2. `openspec/workspace.yaml` with `specs: <path>` links to a separate specs repository (the usual
 *    workspace layout: code and specs are separate git repos opened as folders of one workspace).
 * 3. A config-only `openspec/config.yaml` with `store: <id>` points at a registered OpenSpec store; the
 *    CLI (`openspec context --json`) is asked for its location, so the registry stays the CLI's business.
 * 4. A config-only `openspec/config.yaml` without a pointer is a fresh local root.
 * Returns undefined when the folder has none of these.
 */
export async function resolveRoot(folder: string, exec: ExecFn): Promise<ResolvedRoot | undefined> {
  const config = await readOptional(join(folder, 'openspec', 'config.yaml'));
  const linkFile = await readOptional(join(folder, 'openspec', 'workspace.yaml'));
  const link = linkFile === undefined ? undefined : readYamlKey(linkFile, 'specs');

  const hasPlanningShape =
    (await isDir(join(folder, 'openspec', 'specs'))) || (await isDir(join(folder, 'openspec', 'changes')));
  if (config !== undefined && hasPlanningShape) return { workspaceFolder: folder, root: folder, source: 'local' };

  if (link) {
    const root = isAbsolute(link) ? link : resolve(folder, link);
    const found = await readOptional(join(root, 'openspec', 'config.yaml'));
    return {
      workspaceFolder: folder,
      root,
      source: 'linked',
      ...(found === undefined
        ? { error: `Specs repository not found at ${root} (from openspec/workspace.yaml). Clone it there or fix 'specs:'.` }
        : {}),
    };
  }

  if (config === undefined) return undefined;
  const pointer = readYamlKey(config, 'store');
  if (!pointer) return { workspaceFolder: folder, root: folder, source: 'local' };

  try {
    const out = await exec(['context', '--json'], folder);
    const root = (JSON.parse(out.slice(out.indexOf('{'))) as { root?: { path?: string; store_id?: string } }).root;
    if (!root?.path) throw new Error('openspec context returned no root path');
    return { workspaceFolder: folder, root: root.path, source: 'store', storeId: root.store_id ?? pointer };
  } catch (error) {
    return {
      workspaceFolder: folder,
      root: folder,
      source: 'store',
      storeId: pointer,
      error: `Cannot resolve store '${pointer}': ${describeError(error)}`,
    };
  }
}

/**
 * Resolves and scans every workspace folder. Folders that resolve to the same OpenSpec root
 * (for example a code repo and its store both open in one multi-root workspace) appear once.
 */
export async function loadProjects(
  folders: string[],
  adrDirectory: string,
  exec: ExecFn,
): Promise<ProjectModel[]> {
  const projects: ProjectModel[] = [];
  const seen = new Map<string, number>();
  for (const folder of folders) {
    const resolved = await resolveRoot(folder, exec);
    if (!resolved) continue;
    const key = await canonical(resolved.root);
    const existing = seen.get(key);
    if (existing !== undefined) {
      // The same root reached twice (a code repo that links to its specs repo, plus the specs repo
      // folder itself): list it once, labelled by the folder that really contains it.
      if (resolved.source === 'local' && projects[existing]?.source !== 'local') {
        const model = await scanProject(resolved.root, adrDirectory);
        projects[existing] = { ...model, workspaceFolder: folder, source: 'local' };
      }
      continue;
    }
    seen.set(key, projects.length);

    if (resolved.error) {
      projects.push({
        root: resolved.root,
        workspaceFolder: folder,
        source: resolved.source,
        storeId: resolved.storeId,
        error: resolved.error,
        changes: [],
        archive: [],
        adrs: [],
        adrDir: '',
      });
      continue;
    }
    const model = await scanProject(resolved.root, adrDirectory);
    projects.push({ ...model, workspaceFolder: folder, source: resolved.source, storeId: resolved.storeId });
  }
  return projects;
}
