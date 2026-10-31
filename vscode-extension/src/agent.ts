import * as vscode from 'vscode';
import { checkPrompt } from './model/specGuard.ts';
import type { ProjectStore } from './store.ts';

export function workspaceRoots(store: ProjectStore): string[] {
  return [...new Set([...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath), ...store.projects.map((p) => p.root)])];
}

/**
 * Hands a /spec-* prompt to the agent chat. The prompt is first checked (one line, a /spec-* command). It is
 * always copied to the clipboard; opening the chat with the text prefilled depends on the host, so the fallback
 * is to focus the chat and ask the user to paste.
 */
export async function sendToAgent(store: ProjectStore, prompt: string): Promise<void> {
  const verdict = checkPrompt(prompt, workspaceRoots(store));
  if (!verdict.ok) {
    void vscode.window.showWarningMessage(verdict.message);
    return;
  }
  await vscode.env.clipboard.writeText(prompt);

  const attempts: [string, unknown[]][] = [
    ['workbench.action.chat.open', [{ query: prompt, isPartialQuery: true }]],
    ['composer.focusComposer', []],
  ];
  for (const [command, args] of attempts) {
    try {
      await vscode.commands.executeCommand(command, ...args);
      void vscode.window.showInformationMessage(`${prompt} is on your clipboard. Paste it into the agent chat and send.`);
      return;
    } catch {
      // The command does not exist in this host; try the next one.
    }
  }
  void vscode.window.showInformationMessage(`Copied ${prompt}. Open the agent chat and paste it.`);
}
