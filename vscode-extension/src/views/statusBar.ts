import * as vscode from 'vscode';
import { STATUS_BAR_TEXT, summarize } from '../model/summary.ts';
import type { ProjectStore } from '../store.ts';

/** Left-aligned `Wingman Spec` item. Click opens the dashboard; the tooltip summarises state. */
export function createStatusBar(store: ProjectStore): vscode.Disposable {
  const item = vscode.window.createStatusBarItem('wingmanSpec.status', vscode.StatusBarAlignment.Left, 0);
  item.name = STATUS_BAR_TEXT;
  item.text = STATUS_BAR_TEXT;
  item.command = 'wingmanSpec.openDashboard';

  const update = (): void => {
    if (store.projects.length === 0) {
      item.hide();
      return;
    }
    const changes = store.projects.flatMap((p) => p.changes);
    item.tooltip = new vscode.MarkdownString(summarize(changes).markdown);
    item.show();
  };

  const sub = store.onDidChange(update);
  update();
  return vscode.Disposable.from(item, sub);
}
