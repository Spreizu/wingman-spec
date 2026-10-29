import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { scanArchive } from './archiveScanner.ts';
import { computeAdrSync, isSynced, noDecisionReason, parseRootAdr, parseSourceAdr } from './adrSync.ts';
import { readYamlKey } from './frontMatter.ts';
import { countTasks, parseTasks } from './tasksParser.ts';
import chrono from '../../../project-template/openspec/scripts/chronology.cjs';
import quality from '../../../project-template/openspec/scripts/quality.cjs';
import type {
  Artifact,
  ArtifactId,
  Capability,
  Change,
  ChangeAdr,
  ChangeState,
  NoDecision,
  ProjectModel,
  RootAdr,
  SourceAdr,
} from './types.ts';

export const WINGMAN_SCHEMA = 'wingman-spec';

const ARTIFACTS: { id: ArtifactId; label: string; file: string }[] = [
  { id: 'app-map', label: 'app-map', file: 'app-map.md' },
  { id: 'proposal', label: 'proposal', file: 'proposal.md' },
  { id: 'specs', label: 'specs', file: 'specs' },
  { id: 'design', label: 'design', file: 'design.md' },
  { id: 'adrs', label: 'adrs', file: 'adrs' },
  { id: 'tasks', label: 'tasks', file: 'tasks.md' },
];

async function exists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

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

export async function hasOpenSpecProject(root: string): Promise<boolean> {
  return exists(join(root, 'openspec', 'config.yaml'));
}

async function readCapabilities(root: string, changeDir: string): Promise<Capability[]> {
  const specsDir = join(changeDir, 'specs');
  const out: Capability[] = [];
  for (const entry of await listDir(specsDir)) {
    if (!entry.isDirectory()) continue;
    const specPath = join(specsDir, entry.name, 'spec.md');
    if (!(await exists(specPath))) continue;
    const isExisting = await exists(join(root, 'openspec', 'specs', entry.name));
    out.push({ name: entry.name, path: specPath, kind: isExisting ? 'delta' : 'new' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

async function readSourceAdrs(adrsDir: string): Promise<SourceAdr[]> {
  const out: SourceAdr[] = [];
  for (const entry of await listDir(adrsDir)) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const path = join(adrsDir, entry.name);
    const text = await readText(path);
    if (text !== undefined) out.push(parseSourceAdr(entry.name.slice(0, -3), path, text));
  }
  return out.sort((a, b) => a.slug.localeCompare(b.slug));
}

export async function readRootAdrs(adrDir: string): Promise<RootAdr[]> {
  const out: RootAdr[] = [];
  for (const entry of await listDir(adrDir)) {
    if (!entry.isFile()) continue;
    const path = join(adrDir, entry.name);
    const text = await readText(path);
    const adr = text === undefined ? undefined : parseRootAdr(entry.name, path, text);
    if (adr) out.push(adr);
  }
  return out.sort((a, b) => a.number.localeCompare(b.number));
}

function deriveState(blocked: boolean, total: number, done: number): ChangeState {
  if (blocked) return 'blocked';
  if (total > 0 && done === total) return 'complete';
  if (total > 0) return 'in-progress';
  return 'planning';
}

async function scanChange(
  root: string,
  name: string,
  dir: string,
  defaultSchema: string,
  roots: RootAdr[],
): Promise<Change> {
  const meta = (await readText(join(dir, '.openspec.yaml'))) ?? '';
  const schema = readYamlKey(meta, 'schema') ?? defaultSchema;
  const isWingmanSpec = schema === WINGMAN_SCHEMA;
  const skipSpecs = readYamlKey(meta, 'skip_specs') === 'true';

  const tasksPath = join(dir, 'tasks.md');
  const tasksText = await readText(tasksPath);
  const groups = tasksText === undefined ? [] : parseTasks(tasksText);
  const { total, done } = countTasks(groups);

  const blockedPath = (await exists(join(dir, 'BLOCKED.md'))) ? join(dir, 'BLOCKED.md') : undefined;
  const progressPath = (await exists(join(dir, 'progress.md'))) ? join(dir, 'progress.md') : undefined;

  let artifacts: Artifact[] = [];
  let capabilities: Capability[] = [];
  let adrs: ChangeAdr[] = [];
  let noDecisions: NoDecision[] = [];

  if (isWingmanSpec) {
    capabilities = await readCapabilities(root, dir);
    const sources = await readSourceAdrs(join(dir, 'adrs'));
    noDecisions = sources.filter((s) => s.none).map((s) => ({ slug: s.slug, path: s.path, reason: noDecisionReason(s) }));
    adrs = sources.filter((s) => !s.none).map((s) => ({
      slug: s.slug,
      path: s.path,
      title: s.fields['title'] ?? s.slug,
      status: s.fields['status'] ?? '',
      sync: computeAdrSync(name, s, roots),
    }));
    const declared = quality.proposalSize((await readText(join(dir, 'proposal.md'))) ?? '');
    const fast = declared.size === 'S' && declared.risk !== null && declared.risk.length === 0;
    artifacts = await Promise.all(
      ARTIFACTS.map(async (a): Promise<Artifact> => {
        const path = join(dir, a.file);
        let state: Artifact['state'];
        if (a.id === 'specs') state = capabilities.length > 0 ? 'done' : skipSpecs ? 'skipped' : 'missing';
        else if (a.id === 'adrs') state = adrs.length > 0 || noDecisions.length > 0 ? 'done' : 'missing';
        else state = (await exists(path)) ? 'done' : 'missing';
        if (state === 'missing' && fast && (a.id === 'app-map' || a.id === 'design' || a.id === 'adrs')) state = 'skipped';
        return { id: a.id, label: a.label, path, state };
      }),
    );
  }

  return {
    name,
    dir,
    schema,
    isWingmanSpec,
    skipSpecs,
    state: deriveState(blockedPath !== undefined, total, done),
    artifacts,
    capabilities,
    adrs,
    noDecisions,
    adrsSynced: isSynced(adrs.map((a) => a.sync)),
    tasksPath,
    groups,
    taskTotal: total,
    taskDone: done,
    blockedPath,
    progressPath,
  };
}

/** Scans one project root. `adrDirectory` is relative to the root (default `adr`). */
export async function scanProject(root: string, adrDirectory = 'adr'): Promise<ProjectModel> {
  const adrDir = join(root, ...adrDirectory.split(/[\\/]/).filter(Boolean));
  const adrs = await readRootAdrs(adrDir);

  const config = (await readText(join(root, 'openspec', 'config.yaml'))) ?? '';
  const defaultSchema = readYamlKey(config, 'schema') ?? 'spec-driven';

  const changesDir = join(root, 'openspec', 'changes');
  const entries = await listDir(changesDir);
  const changes = await Promise.all(
    entries
      .filter((e) => e.isDirectory() && e.name !== 'archive' && !e.name.startsWith('.'))
      .map((e) => scanChange(root, e.name, join(changesDir, e.name), defaultSchema, adrs)),
  );
  const git = chrono.gitAdded(changesDir);
  for (const c of changes) c.created = chrono.createdStamp(c.dir, git);
  const ordered = chrono.sortByTime(changes, (c) => c.created ?? { at: '', ms: 0, source: 'none' }, (c) => c.name, true);
  changes.splice(0, changes.length, ...ordered);
  const archive = await scanArchive(root);
  return { root, workspaceFolder: root, source: 'local', changes, archive, adrs, adrDir };
}

