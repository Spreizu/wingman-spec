import { relative } from 'node:path';
import * as vscode from 'vscode';
import { isScannable } from './model/anchors.ts';

const DEBOUNCE_MS = 300;

/** Everything under `openspec/` that a view reads: the stock files, observed behaviour, the roadmap, the greenfield records and each change's timeline. */
export const STORE_PATTERN = 'openspec/{config.yaml,workspace.yaml,changes/**,specs/**,observed/**,roadmap/**,greenfield/**,.apply-runs/*/timeline.jsonl}';
/** Code and test files (the `@spec` markers and `[cap/scenario]` tags are the anchor index); narrowed per event by `isScannable`. */
export const CODE_PATTERN = '**/*';

/**
 * Watches the OpenSpec files under each given directory (a workspace folder, or an OpenSpec
 * store that lives outside the workspace) and calls `onChange` once per burst of file events.
 * `openspec/config.yaml` and `workspace.yaml` are watched so a changed `store:` pointer or `specs:` link is picked up;
 * edits of code files that can carry an anchor refresh the views too.
 */
export function watchRoots(roots: string[], onChange: () => void): vscode.Disposable {
  let timer: NodeJS.Timeout | undefined;
  const trigger = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, DEBOUNCE_MS);
  };

  const adrDirectory = vscode.workspace
    .getConfiguration('wingmanSpec')
    .get<string>('adrDirectory', 'adr')
    .replace(/^[\\/]+|[\\/]+$/g, '');

  const disposables: vscode.Disposable[] = [];
  const watch = (root: string, pattern: string, accept?: (rel: string) => boolean): void => {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), pattern));
    const on = (uri: vscode.Uri): void => {
      if (!accept || accept(relative(root, uri.fsPath).split('\\').join('/'))) trigger();
    };
    disposables.push(w, w.onDidCreate(on), w.onDidChange(on), w.onDidDelete(on));
  };

  for (const root of new Set(roots)) {
    watch(root, STORE_PATTERN);
    watch(root, `${adrDirectory}/**`);
    watch(root, CODE_PATTERN, isScannable);
  }

  return new vscode.Disposable(() => {
    if (timer) clearTimeout(timer);
    disposables.forEach((d) => d.dispose());
  });
}
