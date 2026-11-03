import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { isTestPath } from '../model/anchors.ts';
import type { TraceModel } from '../model/traceability.ts';
import { HOVER_COMMANDS } from '../model/hoverText.ts';
import { unitKeys, usedBy, usedByHover } from '../model/usedBy.ts';
import type { Caller, UsedBy } from '../model/usedBy.ts';
import type { TraceCache } from './anchorCode.ts';

type Item = vscode.CallHierarchyItem;
const NOT_UNITS = new Set([vscode.SymbolKind.File, vscode.SymbolKind.Module, vscode.SymbolKind.Namespace, vscode.SymbolKind.Package]);
const enabled = (): boolean => vscode.workspace.getConfiguration('wingmanSpec').get<boolean>('codeView', true);

/** Files of a model that carry a code marker: only these are read to tell whether a caller is marked. */
const markedFiles = new WeakMap<TraceModel, Set<string>>();
function marked(model: TraceModel): Set<string> {
  let s = markedFiles.get(model);
  if (!s) {
    s = new Set([...model.requirements.values()].flatMap((r) => r.code.map((a) => a.file)));
    markedFiles.set(model, s);
  }
  return s;
}

const linesOf = (uri: vscode.Uri): string[] => {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  try {
    return (open?.getText() ?? readFileSync(uri.fsPath, 'utf8')).split('\n');
  } catch {
    return [];
  }
};

/**
 * Hover on the name of an unmarked function: the requirements whose `@spec` functions call it, found through the
 * language server's call hierarchy. Asked only on hover, kept until a file or the trace model changes.
 */
export function registerUsedBy(cache: TraceCache): vscode.Disposable {
  let results = new Map<string, Promise<{ found: UsedBy<Item>[]; truncated: boolean }>>();
  const clear = (): void => {
    results = new Map();
  };

  const walk = (model: TraceModel) => ({
    callers: async (it: Item): Promise<Item[]> => ((await vscode.commands.executeCommand<vscode.CallHierarchyIncomingCall[]>('vscode.provideIncomingCalls', it)) ?? []).map((c) => c.from),
    keys: async (it: Item): Promise<string[] | undefined> => {
      if (it.uri.scheme !== 'file' || NOT_UNITS.has(it.kind)) return undefined;
      const f = cache.forFile(it.uri.fsPath);
      if (!f || f.model.root !== model.root || isTestPath(f.rel)) return undefined;
      if (!marked(model).has(f.rel)) return [];
      return unitKeys(linesOf(it.uri), it.range.start.line, it.range.end.line, it.kind !== vscode.SymbolKind.Class).filter((k) => model.requirements.has(k));
    },
    id: (it: Item): string => `${it.uri.toString()}#${it.selectionRange.start.line}:${it.selectionRange.start.character}`,
  });

  return vscode.Disposable.from(
    cache.onDidChange(clear),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.scheme === 'file' && e.contentChanges.length) clear();
    }),
    vscode.languages.registerHoverProvider({ scheme: 'file' }, {
      async provideHover(doc, pos) {
        if (!enabled() || !doc.getWordRangeAtPosition(pos)) return undefined;
        const f = cache.forFile(doc.uri.fsPath);
        if (!f || isTestPath(f.rel) || !marked(f.model).size) return undefined;
        const items = await vscode.commands.executeCommand<Item[]>('vscode.prepareCallHierarchy', doc.uri, pos);
        const item = items?.find((i) => i.uri.toString() === doc.uri.toString() && i.selectionRange.contains(pos));
        if (!item || NOT_UNITS.has(item.kind)) return undefined;
        if (unitKeys(doc.getText().split('\n'), item.range.start.line, item.range.end.line, item.kind !== vscode.SymbolKind.Class).length) return undefined;
        const w = walk(f.model);
        const id = w.id(item);
        let job = results.get(id);
        if (!job) {
          job = usedBy(item, w);
          results.set(id, job);
        }
        const { found, truncated } = await job;
        if (!found.length) return undefined;
        const names = new Map([...f.model.requirements.values()].map((r) => [r.key, r.name]));
        const shown = found.map((u) => ({ key: u.key, via: u.via.map((c): Caller => ({ name: c.name, file: c.uri.fsPath, line: c.selectionRange.start.line })) }));
        const text = new vscode.MarkdownString(usedByHover(shown, names, f.model.root, truncated));
        text.isTrusted = { enabledCommands: HOVER_COMMANDS };
        return new vscode.Hover(text, item.selectionRange);
      },
    }),
  );
}
