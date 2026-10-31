import { basename } from 'node:path';
import * as vscode from 'vscode';
import { listBaseSpecNames } from './model/specFiles.ts';
import { loadProjects } from './model/rootResolver.ts';
import type { ProjectModel } from './model/types.ts';

/** Holds the scanned model of every workspace folder with a Wingman Spec layout (core/paths.ts). */
export class ProjectStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  projects: ProjectModel[] = [];
  /** Living spec capability names (`specs/<name>.md`), keyed by specs root. */
  baseSpecNames = new Map<string, string[]>();
  private running: Promise<void> | undefined;
  private queued = false;

  async refresh(): Promise<void> {
    if (this.running) {
      this.queued = true;
      return this.running;
    }
    this.running = this.scan().finally(() => {
      this.running = undefined;
    });
    await this.running;
    if (this.queued) {
      this.queued = false;
      await this.refresh();
    }
  }

  private async scan(): Promise<void> {
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const next = await loadProjects(folders);
    const names = new Map<string, string[]>();
    for (const p of next) names.set(p.root, await listBaseSpecNames(p.root));
    this.projects = next;
    this.baseSpecNames = names;
    this.emitter.fire();
  }

  /** Top-level folder nodes are shown when they carry information: several roots, a linked specs repo, or an error. */
  showFolders(): boolean {
    return this.projects.length > 1 || this.projects.some((p) => p.source !== 'local' || p.error !== undefined);
  }

  /** Short label for the folder node description: the linked specs repo, or the error. */
  folderDescription(project: ProjectModel): string | undefined {
    if (project.error) return 'specs repo not found';
    return project.source === 'linked' ? `specs repo: ${basename(project.root)}` : undefined;
  }

  folderName(project: ProjectModel): string {
    return basename(project.workspaceFolder);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
