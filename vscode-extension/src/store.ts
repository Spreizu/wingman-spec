import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import * as vscode from 'vscode';
import { listBaseSpecNames } from './model/specFiles.ts';
import { loadProjects } from './model/rootResolver.ts';
import type { ExecFn } from './model/rootResolver.ts';
import type { ProjectModel } from './model/types.ts';

const CLI_TIMEOUT_MS = 10_000;

/** Runs the configured `openspec` CLI. Rejects with the CLI's own message on failure. */
export function cliExec(): ExecFn {
  const bin = vscode.workspace.getConfiguration('wingmanSpec').get<string>('openspecPath', 'openspec') || 'openspec';
  return (args, cwd) =>
    new Promise((resolve, reject) => {
      execFile(
        bin,
        args,
        { cwd, timeout: CLI_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true, shell: process.platform === 'win32' },
        (error, stdout, stderr) => (error ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout)),
      );
    });
}

/** Holds the scanned model of every workspace folder that contains `openspec/config.yaml`. */
export class ProjectStore implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  projects: ProjectModel[] = [];
  /** Promoted capability names (`openspec/specs/<name>/spec.md`), keyed by project root. */
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
    const adrDirectory = vscode.workspace.getConfiguration('wingmanSpec').get<string>('adrDirectory', 'adr');
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const next = await loadProjects(folders, adrDirectory, cliExec());
    const names = new Map<string, string[]>();
    for (const p of next) names.set(p.root, await listBaseSpecNames(p.root));
    this.projects = next;
    this.baseSpecNames = names;
    this.emitter.fire();
  }

  /** Top-level folder nodes are shown when they carry information: several roots, a store, or an error. */
  showFolders(): boolean {
    return this.projects.length > 1 || this.projects.some((p) => p.source !== 'local' || p.error !== undefined);
  }

  /** Short label for the folder node description: the store id, or the error. */
  folderDescription(project: ProjectModel): string | undefined {
    if (project.error) return project.source === 'store' ? 'cannot resolve store' : 'specs repo not found';
    if (project.source === 'store') return `store: ${project.storeId ?? 'unknown'}`;
    return project.source === 'linked' ? `specs repo: ${basename(project.root)}` : undefined;
  }

  folderName(project: ProjectModel): string {
    return basename(project.workspaceFolder);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
