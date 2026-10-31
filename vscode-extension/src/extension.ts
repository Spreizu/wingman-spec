import { statSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { registerScaffoldCommands } from './commands/scaffold.ts';
import { TraceCache, registerAnchorCode } from './editor/anchorCode.ts';
import { PanelData } from './editor/panelData.ts';
import { registerProblems } from './editor/problems.ts';
import { VerifierClient, execRunner } from './editor/verifier.ts';
import { registerCliSetup } from './editor/cliSetup.ts';
import { SpecCodeLensProvider } from './editor/codeLens.ts';
import { registerDiagnostics } from './editor/diagnostics.ts';
import { SpecHoverProvider } from './editor/hover.ts';
import { ProjectStore } from './store.ts';
import { createStatusBar } from './views/statusBar.ts';
import { registerTraceView } from './views/traceView.ts';
import { watchRoots } from './watcher.ts';
import { SpecPanel, toggleTask } from './webview/panel.ts';
import type { Route } from './webview/types.ts';

async function openFile(path: string, line?: number): Promise<void> {
  if (statSync(path, { throwIfNoEntry: false })?.isDirectory()) {
    await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(path));
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path));
  const options: vscode.TextDocumentShowOptions = { preview: true };
  if (typeof line === 'number') {
    const pos = new vscode.Position(line, 0);
    options.selection = new vscode.Range(pos, pos);
  }
  await vscode.window.showTextDocument(doc, options);
}

export function activate(context: vscode.ExtensionContext): void {
  const store = new ProjectStore();
  const traceCache = new TraceCache(store);
  const verifier = new VerifierClient(execRunner, join(context.extensionPath, 'bin'));
  const data = new PanelData(store, traceCache, verifier);
  const panel = new SpecPanel(store, () => traceCache.all(), data, vscode.Uri.joinPath(context.extensionUri, 'images', 'icon.png'));
  data.onReady = () => panel.refresh();
  const problems = registerProblems(store, traceCache, verifier);
  const codeLens = new SpecCodeLensProvider(store);
  const markdownFiles: vscode.DocumentSelector = { language: 'markdown', scheme: 'file' };
  const refresh = (): Promise<void> => store.refresh();

  // Watch every workspace folder plus every resolved specs root (a shared store can live outside
  // the workspace). The watcher is rebuilt when that set changes, or when the ADR setting changes.
  let watcher: vscode.Disposable | undefined;
  let watched = '';
  const rewatch = (force = false): void => {
    const codeRoots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const specsRoots = store.projects.map((p) => p.root);
    const signature = `${[...new Set(codeRoots)].sort().join('\n')}\n--\n${[...new Set(specsRoots)].sort().join('\n')}`;
    if (!force && signature === watched) return;
    watched = signature;
    watcher?.dispose();
    watcher = watchRoots(codeRoots, specsRoots, () => void refresh());
  };
  rewatch(true);

  const show = (route: Route) => () => panel.show(route);

  context.subscriptions.push(
    store,
    store.onDidChange(() => rewatch()),
    createStatusBar(store),
    panel,
    codeLens,
    registerDiagnostics(store),
    traceCache,
    registerAnchorCode(traceCache, panel),
    registerTraceView(store, traceCache),
    registerScaffoldCommands(store, panel, verifier),
    problems.disposable,
    vscode.languages.registerCodeLensProvider(markdownFiles, codeLens),
    vscode.languages.registerHoverProvider(markdownFiles, new SpecHoverProvider(store)),
    new vscode.Disposable(() => watcher?.dispose()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      rewatch(true);
      void refresh();
    }),
    registerCliSetup(verifier),
    vscode.commands.registerCommand('wingmanSpec.refresh', refresh),
    vscode.commands.registerCommand('wingmanSpec.openFile', openFile),
    vscode.commands.registerCommand('wingmanSpec.openDashboard', show({ page: 'overview' })),
    vscode.commands.registerCommand('wingmanSpec.openAdrHub', show({ page: 'adrs' })),
    vscode.commands.registerCommand('wingmanSpec.openSpecs', show({ page: 'specs' })),
    vscode.commands.registerCommand('wingmanSpec.openHistory', show({ page: 'history' })),
    vscode.commands.registerCommand('wingmanSpec.openBranchReview', show({ page: 'branch' })),
    vscode.commands.registerCommand('wingmanSpec.openRoadmap', show({ page: 'roadmap' })),
    vscode.commands.registerCommand('wingmanSpec.refreshView', () => {
      data.invalidate();
      panel.refresh();
    }),
    vscode.commands.registerCommand('wingmanSpec.openRoute', (route: Route) => panel.show(route)),
    vscode.commands.registerCommand('wingmanSpec.toggleTask', async (path: string, line: number) => {
      if (await toggleTask(path, line)) await store.refresh();
    }),
  );

  void refresh();
  if (vscode.workspace.getConfiguration('wingmanSpec').get<boolean>('problemsPanel', true)) problems.service.schedule(2500);
}

export function deactivate(): void {}
