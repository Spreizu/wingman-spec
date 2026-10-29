/** Pure parsing of git output for the branch review: changed files (with renames) and the choice of the base branch. */

export type FileStatus = 'A' | 'M' | 'D' | 'R';

export interface DiffFile {
  path: string;
  /** The old path of a rename or copy; the same path otherwise. */
  from: string;
  status: FileStatus;
  added: number;
  removed: number;
}

/** `git diff --name-status -M`: `M\tpath`, `A\tpath`, `D\tpath`, `R087\told\tnew`. */
export function parseNameStatus(out: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const line of out.split('\n')) {
    if (!line.trim()) continue;
    const p = line.split('\t');
    const st = p[0]?.[0];
    if ((st === 'R' || st === 'C') && p[1] && p[2]) files.push({ path: p[2], from: p[1], status: st === 'R' ? 'R' : 'A', added: 0, removed: 0 });
    else if ((st === 'A' || st === 'M' || st === 'D') && p[1]) files.push({ path: p[1], from: p[1], status: st, added: 0, removed: 0 });
  }
  return files;
}

/** `git diff --numstat -M`: `12\t3\tpath` or `1\t1\told => new` / `src/{a => b}/x.ts`; binary files show `-`. Fills added/removed. */
export function applyNumstat(files: DiffFile[], out: string): DiffFile[] {
  const byPath = new Map(files.map((f) => [f.path, f]));
  for (const line of out.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    let path = m[3] ?? '';
    const brace = /^(.*)\{(.*) => (.*)\}(.*)$/.exec(path);
    if (brace) path = `${brace[1] ?? ''}${brace[3] ?? ''}${brace[4] ?? ''}`.replace(/\/\//g, '/');
    else if (path.includes(' => ')) path = path.split(' => ')[1] ?? path;
    const f = byPath.get(path);
    if (f) {
      f.added = m[1] === '-' ? 0 : Number(m[1]);
      f.removed = m[2] === '-' ? 0 : Number(m[2]);
    }
  }
  return files;
}

/**
 * The base to compare the branch with: the setting if it names a ref that exists, else `origin/main`, `origin/master`, `main`,
 * `master`, `origin/develop`, `develop`, whichever exists first. Undefined when none exists (no base: nothing to review).
 */
export function chooseBase(setting: string, exists: (ref: string) => boolean): string | undefined {
  const s = setting.trim();
  if (s && exists(s)) return s;
  return ['origin/main', 'origin/master', 'main', 'master', 'origin/develop', 'develop'].find(exists);
}
