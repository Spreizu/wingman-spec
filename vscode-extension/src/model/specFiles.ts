import { promises as fs } from 'node:fs';
import { livingSpecsDir } from '../core/paths.ts';

/** Capability names of the living specs (`specs/<capability>.md`). */
export async function listBaseSpecNames(root: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(livingSpecsDir(root), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name.slice(0, -3)).sort();
}

export async function readTextSafe(path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
