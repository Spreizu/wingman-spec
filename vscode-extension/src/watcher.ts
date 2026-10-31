import { relative } from 'node:path';
import * as vscode from 'vscode';
import { isScannable } from './model/anchors.ts';

const DEBOUNCE_MS = 300;

/** Everything in a specs root that a view reads: the config, specs, changes, archive, ADRs, observed behaviour, the greenfield records and each change's timeline. */
export const STORE_PATTERN = '{wingman-spec.yaml,greenfield.yaml,changes/**,specs/**,archive/**,adrs/**,observed/**,roadmap/**,greenfield/**,runs/*/timeline.jsonl}';
/** The layout config of a code folder (a new or changed `specs:` link is picked up). */
export const LAYOUT_PATTERN = '{.wingman-spec/wingman-spec.yaml,wingman-spec.yaml}';
/** Code and test files (the `@spec` markers and `[cap/scenario]` tags are the anchor index); narrowed per event by `isScannable`. */
export const CODE_PATTERN = '**/*';

/**
 * Watches the code folders (layout config and code files that can carry an anchor) and the specs roots (every file a view reads),
 * and calls `onChange` once per burst of file events.
 */
export function watchRoots(codeRoots: string[], specsRoots: string[], onChange: () => void): vscode.Disposable {
  let timer: NodeJS.Timeout | undefined;
  const trigger = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, DEBOUNCE_MS);
  };

  const disposables: vscode.Disposable[] = [];
  const watch = (root: string, pattern: string, accept?: (rel: string) => boolean): void => {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), pattern));
    const on = (uri: vscode.Uri): void => {
      if (!accept || accept(relative(root, uri.fsPath).split('\\').join('/'))) trigger();
    };
    disposables.push(w, w.onDidCreate(on), w.onDidChange(on), w.onDidDelete(on));
  };

  for (const root of new Set(codeRoots)) {
    watch(root, LAYOUT_PATTERN);
    watch(root, CODE_PATTERN, isScannable);
  }
  for (const root of new Set(specsRoots)) watch(root, STORE_PATTERN);

  return new vscode.Disposable(() => {
    if (timer) clearTimeout(timer);
    disposables.forEach((d) => d.dispose());
  });
}
