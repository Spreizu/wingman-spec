import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { archiveDir } from '../core/paths.ts';
import { countTasks, parseTasks } from './tasksParser.ts';
import { noDecisionReason, parseSourceAdr } from './adrSync.ts';
import chrono from '../core/chronology.ts';
import type { ArchivedChange, NoDecision } from './types.ts';

/** `YYYY-MM-DD-HHMM-<name>` (the CLI's archive name); `YYYY-MM-DD-<name>` from an import is read too. */
const DATED_RE = /^(\d{4}-\d{2}-\d{2})(?:-\d{4})?-(.+)$/;

async function readText(path: string): Promise<string | undefined> {
  try {
    return await fs.readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function listDir(path: string): Promise<import('node:fs').Dirent[]> {
  try {
    return await fs.readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function parseArchiveName(dirName: string): { date: string; name: string } {
  const m = DATED_RE.exec(dirName);
  return m?.[1] && m[2] ? { date: m[1], name: m[2] } : { date: '', name: dirName };
}

async function scanOne(dir: string, dirName: string, archived: ArchivedChange['archived']): Promise<ArchivedChange> {
  const { date, name } = parseArchiveName(dirName);
  const tasks = await readText(join(dir, 'tasks.md'));
  const { total, done } = countTasks(tasks === undefined ? [] : parseTasks(tasks));

  const capabilities = (await listDir(join(dir, 'specs'))).filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name.slice(0, -3)).sort();

  const adrs: ArchivedChange['adrs'] = [];
  const noDecisions: NoDecision[] = [];
  for (const entry of await listDir(join(dir, 'adrs'))) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const text = await readText(join(dir, 'adrs', entry.name));
    if (text === undefined) continue;
    const slug = entry.name.slice(0, -3);
    const source = parseSourceAdr(slug, join(dir, 'adrs', entry.name), text);
    if (source.none) {
      noDecisions.push({ slug, path: source.path, reason: noDecisionReason(source) });
      continue;
    }
    const f = source.fields;
    adrs.push({ slug: entry.name.slice(0, -3), title: f['title'] ?? entry.name.slice(0, -3), status: f['status'] ?? '' });
  }
  adrs.sort((a, b) => a.slug.localeCompare(b.slug));

  return {
    dirName,
    dir,
    name,
    date,
    ...(archived ? { archived } : {}),
    taskTotal: total,
    taskDone: done,
    capabilities,
    adrs,
    noDecisions,
    hasProposal: (await readText(join(dir, 'proposal.md'))) !== undefined,
    hasDesign: (await readText(join(dir, 'design.md'))) !== undefined,
  };
}

/** Reads `archive/*` of the specs root, newest first by the time it was archived (core/chronology.ts), not by folder name. */
export async function scanArchive(root: string): Promise<ArchivedChange[]> {
  const base = archiveDir(root);
  const entries = (await listDir(base)).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
  const git = chrono.gitAdded(base);
  const all = await Promise.all(entries.map((e) => scanOne(join(base, e.name), e.name, chrono.archiveStamp(base, e.name, git))));
  return chrono.sortByTime(all, (c) => c.archived ?? { at: '', ms: 0, source: 'none' }, (c) => c.dirName, true);
}
