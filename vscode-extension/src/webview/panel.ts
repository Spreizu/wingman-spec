import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';
import * as vscode from 'vscode';
import { sendToAgent, workspaceRoots } from '../agent.ts';
import { readTextSafe } from '../model/specFiles.ts';
import { setupStatus } from '../model/specGuard.ts';
import { toggleTaskLine } from '../model/taskEdit.ts';
import type { TraceModel } from '../model/traceability.ts';
import type { ProjectStore } from '../store.ts';
import { baseSpecPath } from './components.ts';
import { renderPage } from './render.ts';
import type { DashboardInputs } from '../model/changeDashboard.ts';
import { timelinePath } from '../model/timeline.ts';
import type { BranchState, RoadmapState, Route, ViewData } from './types.ts';

const PAGES = new Set(['overview', 'change', 'adrs', 'adr', 'specs', 'spec', 'history', 'archived', 'branch', 'roadmap']);

/** Scaffold commands a webview may trigger. Everything else is ignored. */
const WEBVIEW_COMMANDS = new Set(['newChange', 'newAdr', 'promoteAdr', 'promoteChange', 'supersedeAdr', 'refreshView']);

/** What the dashboard may type into a terminal: a read-only verify-task call, nothing else. */
export const TERMINAL_COMMAND = /^node openspec\/scripts\/verify-task\.cjs [A-Za-z0-9 ._:\/=@-]+$/;

/** Data read from git and the verifier in the background (see editor/panelData.ts). */
export interface PanelExtras {
  branch(root: string | undefined): BranchState;
  roadmap(root: string | undefined): RoadmapState;
  dashboard(root: string, change: string): DashboardInputs | undefined;
}

function isRoute(value: unknown): value is Route {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v['page'] !== 'string' || !PAGES.has(v['page'])) return false;
  for (const key of ['root', 'name', 'number', 'tab', 'id', 'focus']) {
    if (key in v && typeof v[key] !== 'string') return false;
  }
  return true;
}

/** The single dashboard panel: overview, change detail, ADR hub and spec browser. */
export class SpecPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private route: Route = { page: 'overview' };
  private readonly history: Route[] = [];
  private readonly disposables: vscode.Disposable[] = [];
  private rendering = false;
  private dirty = false;
  private readonly store: ProjectStore;
  private readonly traces: () => TraceModel[];
  private readonly extras: PanelExtras | undefined;
  private revealTick = 0;

  constructor(store: ProjectStore, traces: () => TraceModel[] = () => [], extras?: PanelExtras) {
    this.store = store;
    this.traces = traces;
    this.extras = extras;
    this.disposables.push(store.onDidChange(() => void this.render()));
  }

  /** Re-renders (data from git and the verifier arrived). */
  refresh(): void {
    void this.render();
  }

  /** Opens the panel on a route. A route with a focus scrolls to and highlights that item, again on every call. */
  show(route?: Route): void {
    if (route) this.navigate(route, true);
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Active);
    } else {
      this.panel = vscode.window.createWebviewPanel('wingmanSpec.dashboard', 'Wingman Spec', vscode.ViewColumn.Active, {
        enableScripts: true,
        localResourceRoots: [],
      });
      this.panel.webview.onDidReceiveMessage((m: unknown) => void this.onMessage(m), undefined, this.disposables);
      this.panel.onDidDispose(() => (this.panel = undefined), undefined, this.disposables);
    }
    void this.render();
  }

  private navigate(route: Route, reset = false): void {
    if (route.page === 'spec' && route.focus) this.revealTick++;
    if (!reset && JSON.stringify(route) !== JSON.stringify(this.route)) this.history.push(this.route);
    if (reset) this.history.length = 0;
    this.route = route;
  }

  private async loadData(): Promise<ViewData> {
    const projects = this.store.projects;
    const baseSpecs: Record<string, string[]> = {};
    for (const p of projects) baseSpecs[p.root] = this.store.baseSpecNames.get(p.root) ?? [];

    const paths = new Set<string>();
    const route = this.route;
    const project = 'root' in route ? projects.find((p) => p.root === route.root) : undefined;

    if (route.page === 'change' || route.page === 'specs' || route.page === 'spec') {
      for (const p of project ? [project] : projects.slice(0, 1)) {
        for (const name of baseSpecs[p.root] ?? []) paths.add(baseSpecPath(p.root, name));
        for (const c of p.changes) for (const cap of c.capabilities) paths.add(cap.path);
      }
    }
    if (route.page === 'archived') {
      const archived = project?.archive.find((a) => a.dirName === route.name);
      if (archived) {
        for (const f of ['proposal.md', 'design.md', 'tasks.md', 'timeline.jsonl']) paths.add(join(archived.dir, f));
        for (const cap of archived.capabilities) paths.add(join(archived.dir, 'specs', cap, 'spec.md'));
        for (const a of archived.adrs) paths.add(join(archived.dir, 'adrs', `${a.slug}.md`));
      }
    }
    if (route.page === 'change') {
      const change = project?.changes.find((c) => c.name === route.name);
      if (change) {
        for (const f of ['proposal.md', 'design.md', 'app-map.md']) paths.add(join(change.dir, f));
        if (change.blockedPath) paths.add(change.blockedPath);
        if (change.progressPath) paths.add(change.progressPath);
        for (const a of change.adrs) paths.add(a.path);
        if (project) paths.add(timelinePath(project.root, change.name));
      }
    }
    if (route.page === 'overview') {
      for (const p of projects) {
        for (const c of p.changes) {
          paths.add(join(c.dir, 'proposal.md'));
          if (c.blockedPath) paths.add(c.blockedPath);
        }
        for (const a of p.archive.slice(0, 8)) paths.add(join(a.dir, 'proposal.md'));
      }
    }

    const texts: Record<string, string> = {};
    await Promise.all(
      [...paths].map(async (p) => {
        const text = await readTextSafe(p);
        if (text !== undefined) texts[p] = text;
      }),
    );
    const branch = route.page === 'branch' ? this.extras?.branch(route.root) : undefined;
    const roadmap = route.page === 'roadmap' ? this.extras?.roadmap(route.root) : undefined;
    const greenfield = projects.some((p) => existsSync(join(p.root, 'openspec', 'greenfield.yaml')));
    const dashboard = route.page === 'change' && this.extras ? this.extras.dashboard(route.root, route.name) : undefined;
    return { projects, route, texts, baseSpecs, setup: setupStatus(workspaceRoots(this.store)), trace: this.traces(), revealTick: this.revealTick, ...(branch ? { branch } : {}), ...(roadmap ? { roadmap } : {}), ...(greenfield ? { greenfield } : {}), ...(dashboard ? { dashboard } : {}) };
  }

  async render(): Promise<void> {
    if (!this.panel) return;
    if (this.rendering) {
      this.dirty = true;
      return;
    }
    this.rendering = true;
    try {
      do {
        this.dirty = false;
        const data = await this.loadData();
        const panel = this.panel;
        if (!panel) return;
        const nonce = randomBytes(16).toString('base64');
        panel.title = data.route.page === 'change' ? `${data.route.name} - Wingman Spec` : 'Wingman Spec';
        panel.webview.html = renderPage(data, nonce, panel.webview.cspSource);
      } while (this.dirty);
    } finally {
      this.rendering = false;
    }
  }

  private isInsideProject(path: string): boolean {
    const target = resolve(path);
    const roots = [...this.store.projects.map((p) => p.root), ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)];
    return roots.some((root) => {
      const rel = relative(resolve(root), target);
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
    });
  }

  private async onMessage(message: unknown): Promise<void> {
    if (typeof message !== 'object' || message === null) return;
    const m = message as Record<string, unknown>;
    switch (m['type']) {
      case 'navigate':
        if (isRoute(m['route'])) {
          this.navigate(m['route']);
          await this.render();
        }
        break;
      case 'back': {
        const prev = this.history.pop();
        if (prev) {
          this.route = prev;
          await this.render();
        }
        break;
      }
      case 'open':
        if (typeof m['path'] === 'string' && this.isInsideProject(m['path'])) {
          await vscode.commands.executeCommand(
            'wingmanSpec.openFile',
            m['path'],
            typeof m['line'] === 'number' ? m['line'] : undefined,
          );
        }
        break;
      case 'toggle':
        if (typeof m['path'] === 'string' && typeof m['line'] === 'number' && this.isInsideProject(m['path'])) {
          await toggleTask(m['path'], m['line']);
          await this.store.refresh();
        }
        break;
      case 'agent':
        if (typeof m['prompt'] === 'string') await sendToAgent(this.store, m['prompt']);
        break;
      case 'command':
        if (typeof m['id'] === 'string' && WEBVIEW_COMMANDS.has(m['id']) && Array.isArray(m['args']) && m['args'].every((a) => typeof a === 'string')) {
          await vscode.commands.executeCommand(`wingmanSpec.${m['id']}`, ...(m['args'] as string[]));
        }
        break;
      case 'terminal': {
        const text = m['text'];
        const project = this.store.projects.find((p) => 'root' in this.route && p.root === this.route.root) ?? this.store.projects[0];
        if (typeof text === 'string' && TERMINAL_COMMAND.test(text) && project && vscode.workspace.isTrusted) {
          const t = vscode.window.createTerminal({ name: 'Wingman Spec', cwd: project.workspaceFolder });
          t.show();
          t.sendText(text, false);
        }
        break;
      }
      case 'copy':
        if (typeof m['text'] === 'string') {
          await vscode.env.clipboard.writeText(m['text']);
          void vscode.window.setStatusBarMessage(`Copied ${m['text']}`, 2500);
        }
        break;
      case 'external':
        if (typeof m['url'] === 'string' && /^https?:\/\//.test(m['url'])) {
          await vscode.env.openExternal(vscode.Uri.parse(m['url']));
        }
        break;
    }
  }

  dispose(): void {
    this.panel?.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}

/** Flips a task checkbox through a workspace edit so undo works. Saves only if the file was clean. */
export async function toggleTask(path: string, line: number): Promise<boolean> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
  if (line < 0 || line >= doc.lineCount) return false;
  const current = doc.lineAt(line);
  const updated = toggleTaskLine(current.text);
  if (updated === undefined) {
    void vscode.window.showWarningMessage('That task moved. The view has been refreshed.');
    return false;
  }
  const wasDirty = doc.isDirty;
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, current.range, updated);
  const ok = await vscode.workspace.applyEdit(edit);
  if (ok && !wasDirty) await doc.save();
  return ok;
}
