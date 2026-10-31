/**
 * When did a change get created and archived? The one place the extension answers it, so every list of archived changes,
 * changes and runs is ordered the same way, to the second. Mirrors the CLI (internal/change, internal/timeline).
 *
 * `wingman-spec archive` names a folder `YYYY-MM-DD-HHMM-<name>` and writes `archived.json` into it:
 * `{ "archived_at": "2026-10-28T14:03:22+02:00", "created_at": "..." }`. A folder without that file is read, never rewritten:
 * the commit time that added it to git, else its mtime, else the date and time of its name. Equal times tie-break by name.
 *
 * Created time of a change: the commit that first added its folder, else the folder's birth time, else its mtime.
 * Run ids (`runs/<change>/<id>`) are UTC stamps `YYYYMMDDTHHMMSSZ`.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';

/** `source`: where the time came from (`file` = recorded by the archive step; `git`/`birth`/`mtime`/`name` = fallbacks; `none` = nothing known). */
export interface Stamp {
  at: string;
  ms: number;
  source: 'file' | 'git' | 'birth' | 'mtime' | 'name' | 'none';
}
type GitAdded = Map<string, { at: string; ms: number }>;

const pad = (n: number): string => String(n).padStart(2, '0');
/** `YYYY-MM-DD[-HHMM]-<name>`. */
const NAME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:-(\d{2})(\d{2}))?-(.+)$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const RUN_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const FILE = 'archived.json';

/** `2026-10-28T14:03:22+02:00`: the local time of `d` with its offset, to the second. */
function isoLocal(d = new Date()): string {
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
/** Milliseconds of an ISO timestamp with a time of day (a bare date does not count), else NaN. */
function parseTime(s: unknown): number {
  return typeof s === 'string' && TIME_RE.test(s.trim()) ? Date.parse(s.trim().replace(' ', 'T')) : NaN;
}
/** The change name of an archived folder (without the date and time prefix). */
function nameOf(dirName: string): string {
  return NAME_RE.exec(dirName)?.[6] ?? dirName;
}

const memo = new Map<string, { t: number; v: GitAdded }>();
/** One `git log` for a whole directory, remembered for a few seconds: folder name -> the earliest commit that added a file in it. */
function gitAdded(dir: string): GitAdded {
  const hit = memo.get(dir);
  if (hit && Date.now() - hit.t < 20000) return hit.v;
  const v: GitAdded = new Map();
  try {
    const r = spawnSync('git', ['-c', 'core.quotepath=off', '-C', dir, 'log', '--diff-filter=A', '--no-renames', '--relative', '--format=@%cI', '--name-only', '--', '.'], { encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 26 });
    if (r.status === 0) {
      let at = '';
      let ms = NaN;
      for (const line of r.stdout.split('\n')) {
        if (!line) continue;
        if (line.startsWith('@')) {
          at = line.slice(1);
          ms = Date.parse(at);
          continue;
        }
        const seg = line.split('/')[0] ?? '';
        const old = v.get(seg);
        if (!Number.isNaN(ms) && (!old || ms < old.ms)) v.set(seg, { at, ms });
      }
    }
  } catch {
    // no git: the next fallback
  }
  memo.set(dir, { t: Date.now(), v });
  return v;
}

function fromMtime(dir: string): Stamp | null {
  try {
    const m = statSync(dir).mtimeMs;
    return { at: isoLocal(new Date(m)), ms: m, source: 'mtime' };
  } catch {
    return null;
  }
}
function fromName(name: string): Stamp {
  const m = NAME_RE.exec(name);
  if (!m) return { at: '', ms: 0, source: 'none' };
  return { at: '', ms: new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)).getTime(), source: 'name' };
}
function readArchived(f: string): { archived_at?: unknown } | null {
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as { archived_at?: unknown };
  } catch {
    return null;
  }
}

/** When the archived folder `<archiveDir>/<dirName>` was archived. `git`: the `gitAdded(archiveDir)` map (pass it when stamping many). */
function archiveStamp(archiveDir: string, dirName: string, git?: GitAdded): Stamp {
  const dir = join(archiveDir, dirName);
  const a = readArchived(join(dir, FILE));
  const ms = parseTime(a?.archived_at);
  if (!Number.isNaN(ms)) return { at: String(a?.archived_at), ms, source: 'file' };
  const g = (git ?? gitAdded(archiveDir)).get(dirName);
  if (g) return { at: g.at, ms: g.ms, source: 'git' };
  return fromMtime(dir) ?? fromName(dirName);
}

/** When the change at `changeDir` was created; `git` as above for the directory that holds it. */
function createdStamp(changeDir: string, git?: GitAdded): Stamp {
  const g = (git ?? gitAdded(dirname(changeDir))).get(basename(changeDir));
  if (g) return { at: g.at, ms: g.ms, source: 'git' };
  try {
    const b = statSync(changeDir).birthtimeMs;
    if (b > 0) return { at: isoLocal(new Date(b)), ms: b, source: 'birth' };
  } catch {
    // gone
  }
  return fromMtime(changeDir) ?? { at: '', ms: 0, source: 'none' };
}

/** `items` sorted by time, `newestFirst` or oldest first; equal times by name, so the order never flips between two reads. */
function sortByTime<T>(items: T[], stampOf: (x: T) => Stamp, nameOfItem: (x: T) => string, newestFirst = false): T[] {
  const keyed = items.map((it) => ({ it, name: nameOfItem(it), stamp: stampOf(it) }));
  keyed.sort((x, y) => x.stamp.ms - y.stamp.ms || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
  if (newestFirst) keyed.reverse();
  return keyed.map((k) => k.it);
}

/** The folders of the archive, oldest first, each with its stamp. */
function archiveOrder(archiveDir: string, newestFirst = false): { name: string; stamp: Stamp }[] {
  let names: string[];
  try {
    names = readdirSync(archiveDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  } catch {
    return [];
  }
  const git: GitAdded = names.some((n) => !existsSync(join(archiveDir, n, FILE))) ? gitAdded(archiveDir) : new Map();
  return sortByTime(names.map((name) => ({ name, stamp: archiveStamp(archiveDir, name, git) })), (x) => x.stamp, (x) => x.name, newestFirst);
}

/** The time of a run id (`20261028T120322Z`) in ms, or NaN. */
function runTime(id: string): number {
  const m = RUN_RE.exec(id);
  return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])) : NaN;
}
const runMs = (id: string): number => (Number.isNaN(runTime(id)) ? 0 : runTime(id));
/** Run ids, oldest first (by the time in the id; an id with no time sorts before them, by name). */
function sortRuns(ids: string[]): string[] {
  return [...ids].sort((a, b) => runMs(a) - runMs(b) || (a < b ? -1 : a > b ? 1 : 0));
}
function latestRun(ids: string[]): string | undefined {
  return sortRuns(ids).at(-1);
}
/** Records `[{ at: ISO, ... }]` oldest first, stable for equal times. */
function sortRecords<T extends { at: string }>(list: T[]): T[] {
  const ms = (s: string): number => (Number.isNaN(Date.parse(s)) ? 0 : Date.parse(s));
  return list.map((r, i) => ({ r, i, ms: ms(r.at) })).sort((a, b) => a.ms - b.ms || a.i - b.i).map((x) => x.r);
}

/** `14:03:22` in the viewer's time zone for an ISO timestamp or ms (empty when it has no time of day). */
function clock(at: string | number): string {
  const ms = typeof at === 'number' ? at : parseTime(at);
  if (Number.isNaN(ms)) return '';
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
/** `2026-10-28 14:03:22` (local zone) for a stamp with a time, else '' . A name-only stamp shows its date and minute. */
function when(stamp: Stamp | undefined): string {
  if (!stamp || stamp.source === 'none') return '';
  const d = new Date(stamp.ms);
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (stamp.source === 'name') return d.getHours() || d.getMinutes() ? `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}` : day;
  return `${day} ${clock(stamp.ms)}`;
}
const SOURCE_TEXT: Record<string, string> = {
  file: 'recorded when it was archived',
  git: 'time of the commit that added it (no record in the folder)',
  birth: 'time the folder was created',
  mtime: 'time the folder was last changed (no record in the folder)',
  name: 'date and time from the folder name only',
  none: '',
};

const chronology = { isoLocal, parseTime, nameOf, gitAdded, archiveStamp, createdStamp, sortByTime, archiveOrder, sortRuns, latestRun, sortRecords, clock, when, SOURCE_TEXT };
export default chronology;
