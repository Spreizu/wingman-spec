import { relative } from 'node:path';
import * as vscode from 'vscode';
import { isScannable } from './model/anchors.ts';

const DEBOUNCE_MS = 300;

/** Everything in a specs root that a view reads: the config, specs, changes, archive, ADRs, observed behaviour, the greenfield records and each change's timeline. */
export const STORE_PATTERN = '{wingman-spec.yaml,greenfield.yaml,changes/**,specs/**,archive/**,adrs/**,observed/**,roadmap/**,greenfield/**,runs/*/timeline.jsonl}';
/** The layout config of a code folder (a new or changed `specs:` link is picked up). */
export const LAYOUT_PATTERN = '{.wingman-spec/wingman-spec.yaml,wingman-spec.yaml}';
/** Code and test files (the `@spec` markers and `[cap/scenario]` tags are the anchor index); narrowed per event by `isScannable`. */
export const CODE_PATTERN = '**/*.{go,ts,tsx,js,jsx,mjs,cjs,py,rb,rs,java,kt,cs,php,swift,m,mm,c,cc,cpp,h,hpp,vue,svelte,astro}';

export type WatchKind = 'specs' | 'code' | 'layout';

/**
 * Watches the code folders (layout config and code files that can carry an anchor) and the specs roots (every file a view reads),
 * and calls `onChange` once per burst of file events with the kind and the paths in that burst.
 */
export function watchRoots(codeRoots: string[], specsRoots: string[], onChange: (kind: WatchKind, paths: string[]) => void): vscode.Disposable {
  let timer: NodeJS.Timeout | undefined;
  let pending: WatchKind = 'specs';
  const paths = new Set<string>();
  const trigger = (kind: WatchKind, uri: vscode.Uri): void => {
    if (kind === 'code' && pending === 'code') paths.add(uri.fsPath);
    else if (kind === 'code' && pending !== 'code') {
      pending = 'code';
      paths.clear();
      paths.add(uri.fsPath);
    } else {
      pending = kind;
      paths.clear();
    }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const batch = [...paths];
      paths.clear();
      const k = pending;
      pending = 'specs';
      onChange(k, batch);
    }, DEBOUNCE_MS);
  };

  const disposables: vscode.Disposable[] = [];
  const watch = (root: string, pattern: string, kind: WatchKind, accept?: (rel: string) => boolean): void => {
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(root), pattern));
    const on = (uri: vscode.Uri): void => {
      if (!accept || accept(relative(root, uri.fsPath).split('\\').join('/'))) trigger(kind, uri);
    };
    disposables.push(w, w.onDidCreate(on), w.onDidChange(on), w.onDidDelete(on));
  };

  for (const root of new Set(codeRoots)) {
    watch(root, LAYOUT_PATTERN, 'layout');
    watch(root, CODE_PATTERN, 'code', isScannable);
  }
  for (const root of new Set(specsRoots)) watch(root, STORE_PATTERN, 'specs');

  return new vscode.Disposable(() => {
    if (timer) clearTimeout(timer);
    disposables.forEach((d) => d.dispose());
  });
}
