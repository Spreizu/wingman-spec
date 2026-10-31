import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import * as vscode from 'vscode';
import { sendToAgent } from '../agent.ts';
import { planPromote } from '../model/adrPromote.ts';
import { parseSourceAdr } from '../model/adrSync.ts';
import { adrTemplate, slugify, today, validateAdrSlug, validateChangeName } from '../model/scaffold.ts';
import type { Change, ProjectModel } from '../model/types.ts';
import type { VerifierClient } from '../editor/verifier.ts';
import type { ProjectStore } from '../store.ts';
import type { SpecPanel } from '../webview/panel.ts';

async function pickProject(store: ProjectStore, root?: string): Promise<ProjectModel | undefined> {
  const usable = store.projects.filter((p) => p.error === undefined);
  const named = usable.find((p) => p.root === root);
  if (named) return named;
  if (usable.length <= 1) {
    if (usable.length === 0) void vscode.window.showWarningMessage('No Wingman Spec project found in this workspace.');
    return usable[0];
  }
  const pick = await vscode.window.showQuickPick(
    usable.map((p) => ({ label: p.workspaceFolder.split(/[\\/]/).pop() ?? p.root, description: p.root, project: p })),
    { title: 'Which Wingman Spec project?' },
  );
  return pick?.project;
}

async function pickChange(project: ProjectModel, name?: string, why = 'Which change?'): Promise<Change | undefined> {
  const candidates = project.changes.filter((c) => c.isWingmanSpec);
  const named = candidates.find((c) => c.name === name);
  if (named) return named;
  if (candidates.length === 0) {
    void vscode.window.showWarningMessage('There is no active wingman-spec change. Create one first with "Wingman Spec: New Change".');
    return undefined;
  }
  if (candidates.length === 1) return candidates[0];
  const pick = await vscode.window.showQuickPick(
    candidates.map((c) => ({ label: c.name, description: `${c.taskDone}/${c.taskTotal} tasks`, change: c })),
    { title: why },
  );
  return pick?.change;
}

function readOrUndefined(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

async function createAdr(store: ProjectStore, panel: SpecPanel, project: ProjectModel, change: Change, title: string, supersedes?: string): Promise<void> {
  const slug = slugify(title);
  const path = join(change.dir, 'adrs', `${slug}.md`);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, adrTemplate({ title, change: change.name, date: today(), supersedes }), { flag: 'wx' });
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not create ${relative(project.root, path)}: ${(error as Error).message}`);
    return;
  }
  await store.refresh();
  await vscode.commands.executeCommand('wingmanSpec.openFile', path, 0);
  panel.show({ page: 'change', root: project.root, name: change.name, tab: 'adrs' });
}

async function askAdrTitle(change: Change, initial = ''): Promise<string | undefined> {
  const existing = [...change.adrs, ...change.noDecisions].map((a) => a.slug);
  return vscode.window.showInputBox({
    title: `New ADR in ${change.name}`,
    prompt: 'Short decision title, for example "Use PostgreSQL for persistence"',
    value: initial,
    validateInput: (v) => (v.trim() === '' ? 'Enter a title.' : validateAdrSlug(slugify(v), existing)),
  });
}

async function promote(store: ProjectStore, panel: SpecPanel, rootArg: string | undefined, changeName: string | undefined, slug?: string): Promise<void> {
  const project = await pickProject(store, rootArg || undefined);
  const change = project ? await pickChange(project, changeName, 'Promote ADRs from which change?') : undefined;
  if (!project || !change) return;

  const selected = slug ? change.adrs.filter((a) => a.slug === slug) : change.adrs;
  const sources = selected.flatMap((a) => {
    const text = readOrUndefined(a.path);
    return text === undefined ? [] : [parseSourceAdr(a.slug, a.path, text)];
  });
  if (sources.length === 0) {
    void vscode.window.showWarningMessage('This change has no ADRs to promote.');
    return;
  }

  const plan = planPromote({ change: change.name, sources, roots: project.adrs, adrDir: project.adrDir, read: (p) => readOrUndefined(p) });
  const rel = (p: string): string => relative(project.root, p).split('\\').join('/');
  const lines = [
    ...plan.writes.map((w) => `${w.kind === 'create' ? 'Create' : 'Update'} ${rel(w.path)}`),
    ...plan.notes.filter((n) => n.startsWith('marked')),
    ...plan.errors.map((e) => `Cannot promote ${e}`),
  ];

  if (plan.writes.length === 0) {
    void vscode.window.showInformationMessage(plan.errors.length > 0 ? `Nothing promoted. ${plan.errors.join(' ')}` : 'ADRs are already synced; nothing to change.');
    return;
  }
  const answer = await vscode.window.showInformationMessage(`Promote ADRs from "${change.name}"?`, { modal: true, detail: lines.join('\n') }, 'Promote');
  if (answer !== 'Promote') return;

  try {
    for (const w of plan.writes) {
      mkdirSync(dirname(w.path), { recursive: true });
      writeFileSync(w.path, w.content);
    }
  } catch (error) {
    void vscode.window.showErrorMessage(`Promotion failed: ${(error as Error).message}`);
    return;
  }
  await store.refresh();
  void vscode.window.showInformationMessage(`Promoted ${plan.writes.filter((w) => !w.path.endsWith('README.md')).length} ADR file(s) from ${change.name}.`);
  panel.show({ page: 'change', root: project.root, name: change.name, tab: 'adrs' });
}

export function registerScaffoldCommands(store: ProjectStore, panel: SpecPanel, verifier: VerifierClient): vscode.Disposable {
  return vscode.Disposable.from(
    vscode.commands.registerCommand('wingmanSpec.newChange', async (root?: string) => {
      const project = await pickProject(store, root || undefined);
      if (!project) return;
      const name = await vscode.window.showInputBox({
        title: 'New change',
        prompt: 'Change name in kebab-case, for example add-two-factor-auth',
        validateInput: (v) => validateChangeName(v.trim(), project.changes.map((c) => c.name)),
      });
      if (!name) return;
      const made = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Creating change ${name}` }, () => verifier.newChange(project, name.trim()));
      if (!made.ok) {
        void vscode.window.showErrorMessage(`wingman-spec could not create the change: ${made.reason}`);
        return;
      }
      await store.refresh();
      panel.show({ page: 'change', root: project.root, name: name.trim() });
      const next = await vscode.window.showInformationMessage(`Created change ${name.trim()}.`, 'Plan with agent');
      if (next) await sendToAgent(store, `/spec-propose ${name.trim()}`);
    }),

    vscode.commands.registerCommand('wingmanSpec.newAdr', async (root?: string, changeName?: string) => {
      const project = await pickProject(store, root || undefined);
      const change = project ? await pickChange(project, changeName, 'Add the ADR to which change?') : undefined;
      if (!project || !change) return;
      const title = await askAdrTitle(change);
      if (title) await createAdr(store, panel, project, change, title.trim());
    }),

    vscode.commands.registerCommand('wingmanSpec.supersedeAdr', async (root?: string, number?: string) => {
      const project = await pickProject(store, root || undefined);
      if (!project) return;
      const target =
        project.adrs.find((a) => a.number === number) ??
        (await vscode.window.showQuickPick(project.adrs.map((a) => ({ label: `${a.number} ${a.title}`, description: a.status, adr: a })), { title: 'Which ADR does the new decision replace?' }))?.adr;
      if (!target) return;
      const change = await pickChange(project, undefined, 'Draft the replacement in which change?');
      if (!change) return;
      const title = await askAdrTitle(change, `Replace ${target.title}`);
      if (title) await createAdr(store, panel, project, change, title.trim(), target.number);
    }),

    vscode.commands.registerCommand('wingmanSpec.promoteAdr', (root?: string, change?: string, slug?: string) => promote(store, panel, root, change, slug)),
    vscode.commands.registerCommand('wingmanSpec.promoteChange', (root?: string, change?: string) => promote(store, panel, root, change)),
  );
}
