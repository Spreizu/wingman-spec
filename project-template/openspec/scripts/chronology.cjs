'use strict';
/**
 * When did a change get created and archived? The ONE place that answers it, for the scripts and the editor extension (which imports
 * this file), so every list of archived changes, changes and runs is ordered the same way, to the second.
 *
 * `openspec archive` names a folder `YYYY-MM-DD-<name>`: a day, no time, so three changes archived on one day sort by name. Our
 * `archive` step therefore writes `archived.json` into the archived folder: `{ "archived_at": "2026-10-28T14:03:22+02:00",
 * "created_at": "..." }` (ISO 8601 with offset, to the second; `created_at` only when it is known). Folders archived before that have
 * no such file; they are read, never rewritten: the commit time that added the folder to git, else the folder's mtime, else the date
 * of its name (midnight). Equal times tie-break by name, so the order is stable.
 *
 * Created time of a change: `created_at` (or `created:` with a time) in its `.openspec.yaml`, else the commit that first added the
 * folder, else the folder's birth time, else a date-only `created:`, else the mtime.
 *
 * A stamp is `{ at: ISO string or '', ms: number, source: 'file' | 'git' | 'birth' | 'mtime' | 'name' | 'none' }`.
 * Run ids (`openspec/.apply-runs/<change>/<id>`) are UTC stamps `YYYYMMDDTHHMMSSZ`; `latestRun` and `sortRuns` read them as times.
 */
const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const pad = (n) => String(n).padStart(2, '0');
const NAME_RE = /^(\d{4}-\d{2}-\d{2})-(.+)$/;
const TIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const RUN_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;
const FILE = 'archived.json';

/** `2026-10-28T14:03:22+02:00`: the local time of `d` with its offset, to the second. */
function isoLocal(d = new Date()) {
  const off = -d.getTimezoneOffset(); const a = Math.abs(off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off >= 0 ? '+' : '-'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
/** Milliseconds of an ISO timestamp with a time of day (a bare date does not count), else NaN. */
function parseTime(s) { return typeof s === 'string' && TIME_RE.test(s.trim()) ? Date.parse(s.trim().replace(' ', 'T')) : NaN; }
/** The `YYYY-MM-DD` of an archived folder's name, or ''. */
function nameDate(name) { const m = NAME_RE.exec(name); return m ? m[1] : ''; }
/** The change name without the date prefix. */
function nameOf(dirName) { const m = NAME_RE.exec(dirName); return m ? m[2] : dirName; }

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return null; } }

// one `git log` for a whole directory (every folder in it), remembered for a few seconds: folder name -> the earliest commit that added a file in it
const memo = new Map();
function gitAdded(dir) {
  const hit = memo.get(dir); if (hit && Date.now() - hit.t < 20000) return hit.v;
  const v = new Map();
  try {
    const r = cp.spawnSync('git', ['-c', 'core.quotepath=off', '-C', dir, 'log', '--diff-filter=A', '--no-renames', '--relative', '--format=@%cI', '--name-only', '--', '.'], { encoding: 'utf8', timeout: 20000, maxBuffer: 1 << 26 });
    if (r.status === 0) {
      let at = ''; let ms = NaN;
      for (const line of r.stdout.split('\n')) {
        if (!line) continue;
        if (line[0] === '@') { at = line.slice(1); ms = Date.parse(at); continue; }
        const seg = line.split('/')[0]; const old = v.get(seg);
        if (!Number.isNaN(ms) && (!old || ms < old.ms)) v.set(seg, { at, ms });
      }
    }
  } catch (e) { /* no git: the next fallback */ }
  memo.set(dir, { t: Date.now(), v });
  return v;
}

function fromMtime(dir, ms = null) {
  try { const m = ms === null ? fs.statSync(dir).mtimeMs : ms; return { at: isoLocal(new Date(m)), ms: m, source: 'mtime' }; } catch (e) { return null; }
}
function fromName(name) {
  const d = nameDate(name); if (!d) return { at: '', ms: 0, source: 'none' };
  const [y, mo, da] = d.split('-').map(Number); return { at: '', ms: new Date(y, mo - 1, da).getTime(), source: 'name' };
}

/** When the archived folder `<archiveDir>/<dirName>` was archived. `git`: the `gitAdded(archiveDir)` map (pass it when stamping many). */
function archiveStamp(archiveDir, dirName, git) {
  const dir = path.join(archiveDir, dirName);
  const a = readJson(path.join(dir, FILE)); const ms = parseTime(a && a.archived_at);
  if (!Number.isNaN(ms)) return { at: a.archived_at, ms, source: 'file' };
  const g = (git || gitAdded(archiveDir)).get(dirName);
  if (g) return { at: g.at, ms: g.ms, source: 'git' };
  return fromMtime(dir) || fromName(dirName);
}

/** When the change at `changeDir` was created; `git` as above for the directory that holds it. */
function createdStamp(changeDir, git) {
  const name = path.basename(changeDir);
  let yaml = ''; try { yaml = fs.readFileSync(path.join(changeDir, '.openspec.yaml'), 'utf8'); } catch (e) { /* none */ }
  const y = (yaml.match(/^created(?:_at)?:\s*['"]?([^'"\n]+?)['"]?\s*$/m) || [])[1];
  const ym = parseTime(y); if (!Number.isNaN(ym)) return { at: y.trim(), ms: ym, source: 'file' };
  const g = (git || gitAdded(path.dirname(changeDir))).get(name); if (g) return { at: g.at, ms: g.ms, source: 'git' };
  try { const b = fs.statSync(changeDir).birthtimeMs; if (b > 0) return { at: isoLocal(new Date(b)), ms: b, source: 'birth' }; } catch (e) { /* gone */ }
  const day = y && /^\d{4}-\d{2}-\d{2}$/.test(y.trim()) ? fromName(`${y.trim()}-x`) : null; if (day) return day;
  return fromMtime(changeDir) || fromName(name);
}

/** Oldest first; equal times by name, so the order never flips between two reads. `x` is `{ name, stamp }`. */
function compare(x, y) { return (x.stamp.ms - y.stamp.ms) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0); }
/** `items` sorted by time, `newestFirst` or oldest first. `stampOf(item)` and `nameOf(item)` read the item. */
function sortByTime(items, stampOf, nameOfItem, newestFirst = false) {
  const keyed = items.map((it) => ({ it, name: nameOfItem(it), stamp: stampOf(it) })).sort(compare);
  if (newestFirst) keyed.reverse();
  return keyed.map((k) => k.it);
}

/** The folders of `<changes>/archive`, oldest first, each with its stamp: `[{ name, stamp }]`. */
function archiveOrder(archiveDir, newestFirst = false) {
  let names = []; try { names = fs.readdirSync(archiveDir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name); } catch (e) { return []; }
  const git = names.some((n) => !fs.existsSync(path.join(archiveDir, n, FILE))) ? gitAdded(archiveDir) : new Map();
  return sortByTime(names.map((name) => ({ name, stamp: archiveStamp(archiveDir, name, git) })), (x) => x.stamp, (x) => x.name, newestFirst);
}

/** Writes `archived.json` into the archived folder; `created` is the change's `createdStamp` (kept only when it is a known time). */
function writeArchived(dir, created) {
  const rec = { archived_at: isoLocal() };
  if (created && created.at && created.source !== 'mtime' && created.source !== 'name' && created.source !== 'none') rec.created_at = created.at;
  fs.writeFileSync(path.join(dir, FILE), `${JSON.stringify(rec, null, 2)}\n`);
  return rec;
}
/** The archived folder `openspec archive` just made for `change` (newest if several), or null. */
function archivedDirOf(archiveDir, change) {
  let names = []; try { names = fs.readdirSync(archiveDir); } catch (e) { return null; }
  const mine = names.filter((n) => { const m = NAME_RE.exec(n); return m && m[2] === change; }).sort();
  return mine.length ? path.join(archiveDir, mine[mine.length - 1]) : null;
}

/** The time of a run id (`20261028T120322Z`) in ms, or NaN. */
function runTime(id) { const m = RUN_RE.exec(id); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : NaN; }
/** Run ids, oldest first (by the time in the id; an id with no time sorts before them, by name). */
function sortRuns(ids) { return [...ids].sort((a, b) => ((Number.isNaN(runTime(a)) ? 0 : runTime(a)) - (Number.isNaN(runTime(b)) ? 0 : runTime(b))) || (a < b ? -1 : a > b ? 1 : 0)); }
function latestRun(ids) { const s = sortRuns(ids); return s.length ? s[s.length - 1] : undefined; }
/** Records `[{ at: ISO, ... }]` oldest first, stable for equal times. */
function sortRecords(list) { return list.map((r, i) => ({ r, i, ms: Date.parse(r.at) })).sort((a, b) => ((Number.isNaN(a.ms) ? 0 : a.ms) - (Number.isNaN(b.ms) ? 0 : b.ms)) || a.i - b.i).map((x) => x.r); }

/** `14:03:22` in the viewer's time zone for an ISO timestamp or ms (empty when it has no time of day). */
function clock(at) { const ms = typeof at === 'number' ? at : parseTime(at); if (Number.isNaN(ms)) return ''; const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
/** `2026-10-28 14:03:22` (local zone) for a stamp with a time, else its date, else ''. */
function when(stamp) {
  if (!stamp || stamp.source === 'none') return '';
  if (stamp.source === 'name') { const d = new Date(stamp.ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  const d = new Date(stamp.ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(stamp.ms)}`;
}
const SOURCE_TEXT = { file: 'recorded when it was archived', git: 'time of the commit that added it (no record in the folder)', birth: 'time the folder was created', mtime: 'time the folder was last changed (no record in the folder)', name: 'date from the folder name only', none: '' };

module.exports = { isoLocal, parseTime, gitAdded, archiveStamp, createdStamp, sortByTime, archiveOrder, writeArchived, archivedDirOf, sortRuns, latestRun, sortRecords, clock, when, SOURCE_TEXT };
