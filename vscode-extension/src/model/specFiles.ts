import { promises as fs } from 'node:fs';
import { join } from 'node:path';

/** Names of the capability folders under `openspec/specs/` that contain a `spec.md`. */
export async function listBaseSpecNames(root: string): Promise<string[]> {
  const dir = join(root, 'openspec', 'specs');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      await fs.access(join(dir, e.name, 'spec.md'));
      names.push(e.name);
    } catch {
      // folder without spec.md is ignored
    }
  }
  return names.sort();
}

export async function readTextSafe(path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
