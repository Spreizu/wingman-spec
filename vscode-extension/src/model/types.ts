export interface TaskDetails {
  spec?: string;
  testFirst?: string;
  files?: string;
  doneWhen?: string;
  /** `Visual:` scenario ids (UI tasks), as written. */
  visual?: string;
}

export interface Task {
  /** Dotted id such as `1.2` or `2.R`; empty when the line has none. */
  id: string;
  title: string;
  checked: boolean;
  /** Zero-based line index in tasks.md. */
  line: number;
  isReview: boolean;
  details: TaskDetails;
}

export interface TaskGroup {
  /** Group number such as `1`; empty for tasks that precede any group heading. */
  number: string;
  title: string;
  line: number;
  isCloseOut: boolean;
  tasks: Task[];
}

export interface FrontMatter {
  fields: Record<string, string>;
  body: string;
  hasFrontMatter: boolean;
}

/** A change-local ADR: changes/<change>/adrs/<slug>.md */
export interface SourceAdr {
  slug: string;
  path: string;
  /** The "no architectural decision" record (quality.isNoneAdr): not an ADR, never counted or promoted. */
  none: boolean;
  fields: Record<string, string>;
  body: string;
}

/** A promoted ADR: adr/NNNN-<slug>.md */
export interface RootAdr {
  number: string;
  slug: string;
  path: string;
  title: string;
  status: string;
  date: string;
  change: string;
  source: string;
  supersedes: string;
  body: string;
  fields: Record<string, string>;
}

export type AdrSyncState =
  | 'not-promoted'
  | 'up-to-date'
  | 'out-of-date'
  | 'unfilled'
  | 'none'
  | 'error';

export interface AdrSyncResult {
  state: AdrSyncState;
  detail: string;
  target?: RootAdr;
}

export interface ChangeAdr {
  slug: string;
  path: string;
  title: string;
  status: string;
  sync: AdrSyncResult;
}

export type ArtifactId = 'app-map' | 'proposal' | 'specs' | 'design' | 'adrs' | 'tasks';
export type ArtifactState = 'done' | 'missing' | 'skipped';

export interface Capability {
  name: string;
  path: string;
  /** `new` when specs/<name>.md does not exist yet, otherwise a delta on an existing capability. */
  kind: 'new' | 'delta';
}

export interface Artifact {
  id: ArtifactId;
  label: string;
  /** File for single-file artifacts, directory for specs and adrs. */
  path: string;
  state: ArtifactState;
}

export type ChangeState = 'planning' | 'in-progress' | 'blocked' | 'complete';

/** A change's `adrs/none.md` record: the change has no architectural decision. Shown as one muted line, never counted. */
export interface NoDecision {
  slug: string;
  path: string;
  reason: string;
}

/** A moment with where it came from (`core/chronology.ts`): `file` = recorded by our archive step, `git`/`birth`/`mtime`/`name` = fallbacks for older folders. */
export interface TimeStamp {
  at: string;
  ms: number;
  source: 'file' | 'git' | 'birth' | 'mtime' | 'name' | 'none';
}

export interface Change {
  name: string;
  dir: string;
  schema: string;
  isWingmanSpec: boolean;
  skipSpecs: boolean;
  state: ChangeState;
  artifacts: Artifact[];
  capabilities: Capability[];
  /** The real ADRs only (never the none record: see `noDecisions`). */
  adrs: ChangeAdr[];
  noDecisions: NoDecision[];
  /** True when no ADR is `not-promoted` or `out-of-date` (matches `/spec-sync --check`). */
  adrsSynced: boolean;
  tasksPath: string;
  groups: TaskGroup[];
  taskTotal: number;
  taskDone: number;
  blockedPath?: string;
  progressPath?: string;
  /** When the change was created (`core/chronology.ts`): the changes list is ordered by it, newest first. Absent in hand-built test data. */
  created?: TimeStamp;
}

/** A change moved to `archive/` of the specs root (`YYYY-MM-DD-HHMM-<name>`). */
export interface ArchivedChange {
  /** Directory name inside archive/, for example `2026-10-19-add-auth`. */
  dirName: string;
  dir: string;
  /** The change name without the date prefix. */
  name: string;
  /** `YYYY-MM-DD`, or empty when the folder has no date prefix. */
  date: string;
  /** When it was archived, to the second (`archived.json`, else the commit time, the folder mtime, the date): see `core/chronology.ts`. Absent in hand-built test data. */
  archived?: TimeStamp;
  taskTotal: number;
  taskDone: number;
  capabilities: string[];
  /** Real ADRs only. */
  adrs: { slug: string; title: string; status: string }[];
  noDecisions: NoDecision[];
  hasProposal: boolean;
  hasDesign: boolean;
}

export interface ProjectModel {
  /** The specs root: the directory with specs/, changes/, archive/ and adrs/ (core/paths.ts). */
  root: string;
  /** The workspace folder that led here: the code root (its `.wingman-spec/bin/wingman-spec` runs the CLI). */
  workspaceFolder: string;
  /**
   * `local`: the specs are in `.wingman-spec/` next to the code. `linked`: a separate specs repo named by `specs:` in
   * `.wingman-spec/wingman-spec.yaml`. `specs-repo`: the folder is a specs repository (no code).
   */
  source: 'local' | 'linked' | 'specs-repo';
  /** Set when the root could not be resolved; `changes` and `adrs` are then empty. */
  error?: string;
  changes: Change[];
  archive: ArchivedChange[];
  adrs: RootAdr[];
  adrDir: string;
}
