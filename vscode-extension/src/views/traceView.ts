import * as vscode from 'vscode';
import type { TraceCache } from '../editor/anchorCode.ts';
import type { ProblemsService } from '../editor/problems.ts';
import { buildTraceNodes } from '../model/traceTree.ts';
import type { TraceNode } from '../model/traceTree.ts';
import type { ProjectStore } from '../store.ts';

class Item extends vscode.TreeItem {
  readonly node: TraceNode;
  constructor(node: TraceNode, collapsed: boolean) {
    super(node.label, node.children.length ? (collapsed ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.Expanded) : vscode.TreeItemCollapsibleState.None);
    this.node = node;
    this.id = node.id;
    this.description = node.description;
    this.tooltip = node.tooltip;
    this.iconPath = new vscode.ThemeIcon(node.icon);
    if (node.route) {
      this.command = { command: 'wingmanSpec.openRoute', title: 'Open in Wingman Spec', arguments: [node.route] };
      if (node.file) this.contextValue = 'wingmanSpec.revealable';
    } else if (node.file) this.command = { command: 'wingmanSpec.openFile', title: 'Open', arguments: [node.file, node.line] };
  }
}

/** An Explorer view: capabilities -> requirements (with their Why) -> anchors, plus flags and drift. Read-only. */
class TraceProvider implements vscode.TreeDataProvider<TraceNode> {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly cache: TraceCache;
  private readonly store: ProjectStore;
  private readonly problems: ProblemsService;
  constructor(store: ProjectStore, cache: TraceCache, problems: ProblemsService) {
    this.store = store;
    this.cache = cache;
    this.problems = problems;
  }
  fire(): void {
    this.emitter.fire();
  }
  getTreeItem(node: TraceNode): vscode.TreeItem {
    return new Item(node, node.id !== 'requirements');
  }
  getChildren(node?: TraceNode): TraceNode[] | Promise<TraceNode[]> {
    if (node) return node.children;
    return this.cache.ready().then(() => this.roots());
  }
  private roots(): TraceNode[] {
    const models = this.cache.all();
    const cov = this.problems.coverage;
    if (models.length === 1 && models[0]) return buildTraceNodes(models[0], cov.get(models[0].root));
    return models.map((m) => ({
      id: `project/${m.root}`,
      label: this.store.projects.find((p) => p.root === m.root)?.workspaceFolder.split(/[\\/]/).pop() ?? m.root,
      icon: 'root-folder',
      children: buildTraceNodes(m, cov.get(m.root)),
    }));
  }
}

export function registerTraceView(store: ProjectStore, cache: TraceCache, problems: ProblemsService): vscode.Disposable {
  const provider = new TraceProvider(store, cache, problems);
  const setContext = (): void => void vscode.commands.executeCommand('setContext', 'wingmanSpec.hasProject', store.projects.some((p) => !p.error));
  setContext();
  return vscode.Disposable.from(
    vscode.window.registerTreeDataProvider('wingmanSpec.traceability', provider),
    cache.onDidChange(() => provider.fire()),
    problems.onDidChange(() => provider.fire()),
    vscode.commands.registerCommand('wingmanSpec.openNodeFile', (node?: TraceNode) => {
      if (node?.file) return vscode.commands.executeCommand('wingmanSpec.openFile', node.file, node.line);
      return undefined;
    }),
    store.onDidChange(setContext),
  );
}
