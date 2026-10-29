import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { lintAdr, lintSpec, lintTasks, proposalSize } from '../model/lint.ts';
import type { Issue } from '../model/lint.ts';
import type { Capability, Change, ChangeAdr, ProjectModel, RootAdr } from '../model/types.ts';

export type FileContext =
  | { kind: 'tasks'; project: ProjectModel; change: Change }
  | { kind: 'sourceAdr'; project: ProjectModel; change: Change; adr: ChangeAdr }
  | { kind: 'noDecision'; project: ProjectModel; change: Change }
  | { kind: 'rootAdr'; project: ProjectModel; adr: RootAdr }
  | { kind: 'deltaSpec'; project: ProjectModel; change: Change; capability: Capability }
  | { kind: 'baseSpec'; project: ProjectModel; name: string };

const same = (a: string, b: string): boolean => resolve(a) === resolve(b);

/** Works out which OpenSpec artifact a file is, if any. */
export function classify(projects: ProjectModel[], fsPath: string): FileContext | undefined {
  for (const project of projects) {
    for (const change of project.changes) {
      if (same(change.tasksPath, fsPath)) return { kind: 'tasks', project, change };
      const adr = change.adrs.find((a) => same(a.path, fsPath));
      if (adr) return { kind: 'sourceAdr', project, change, adr };
      if (change.noDecisions.some((n) => same(n.path, fsPath))) return { kind: 'noDecision', project, change };
      const capability = change.capabilities.find((c) => same(c.path, fsPath));
      if (capability) return { kind: 'deltaSpec', project, change, capability };
    }
    const root = project.adrs.find((a) => same(a.path, fsPath));
    if (root) return { kind: 'rootAdr', project, adr: root };

    const rel = relative(project.root, resolve(fsPath)).split(sep);
    if (rel.length === 4 && rel[0] === 'openspec' && rel[1] === 'specs' && rel[3] === 'spec.md' && rel[2]) {
      return { kind: 'baseSpec', project, name: rel[2] };
    }
  }
  return undefined;
}

export function lintFor(ctx: FileContext, text: string): Issue[] {
  switch (ctx.kind) {
    case 'tasks': {
      const proposal = join(dirname(ctx.change.tasksPath), 'proposal.md');
      return lintTasks(text, existsSync(proposal) ? proposalSize(readFileSync(proposal, 'utf8')) : '');
    }
    case 'sourceAdr':
      return lintAdr(text, { kind: 'source', knownNumbers: ctx.project.adrs.map((a) => a.number) });
    case 'noDecision':
      return lintAdr(text, { kind: 'source', none: true });
    case 'rootAdr':
      return lintAdr(text, { kind: 'root', knownNumbers: ctx.project.adrs.map((a) => a.number) });
    case 'deltaSpec':
    case 'baseSpec':
      return lintSpec(text);
  }
}

/** Absolute paths of every artifact the extension knows about, except base specs (listed from disk). */
export function knownFiles(projects: ProjectModel[]): string[] {
  const out: string[] = [];
  for (const p of projects) {
    for (const c of p.changes) {
      out.push(c.tasksPath, ...c.adrs.map((a) => a.path), ...c.noDecisions.map((n) => n.path), ...c.capabilities.map((cap) => cap.path));
    }
    out.push(...p.adrs.map((a) => a.path));
  }
  return out;
}
