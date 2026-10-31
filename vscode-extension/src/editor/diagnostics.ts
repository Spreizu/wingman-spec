import { join } from 'node:path';
import { livingSpec } from '../core/paths.ts';
import * as vscode from 'vscode';
import { listBaseSpecNames, readTextSafe } from '../model/specFiles.ts';
import type { Issue } from '../model/lint.ts';
import type { ProjectStore } from '../store.ts';
import { classify, knownFiles, lintFor } from './context.ts';

const SEVERITY: Record<Issue['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

function enabled(): boolean {
  return vscode.workspace.getConfiguration('wingmanSpec').get<boolean>('diagnostics', true);
}

function toDiagnostics(doc: vscode.TextDocument | undefined, text: string, issues: Issue[]): vscode.Diagnostic[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  return issues.map((i) => {
    const lineText = doc ? doc.lineAt(Math.min(i.line, doc.lineCount - 1)).text : (lines[i.line] ?? '');
    const start = lineText.length - lineText.trimStart().length;
    const range = new vscode.Range(i.line, start, i.line, Math.max(lineText.length, start + 1));
    const d = new vscode.Diagnostic(range, i.message, SEVERITY[i.severity]);
    d.source = 'Wingman Spec';
    return d;
  });
}

/** Lints specs, tasks and ADRs against what the schema and `wingman-spec validate` expect. */
export function registerDiagnostics(store: ProjectStore): vscode.Disposable {
  const collection = vscode.languages.createDiagnosticCollection('wingman-spec');
  let known = new Set<string>();
  const timers = new Map<string, NodeJS.Timeout>();

  const lintDocument = (doc: vscode.TextDocument): void => {
    if (doc.uri.scheme !== 'file') return;
    const ctx = classify(store.projects, doc.uri.fsPath);
    if (!ctx || !enabled()) {
      if (!ctx) collection.delete(doc.uri);
      return;
    }
    const text = doc.getText();
    collection.set(doc.uri, toDiagnostics(doc, text, lintFor(ctx, text)));
  };

  const lintAll = async (): Promise<void> => {
    if (!enabled()) {
      collection.clear();
      known = new Set();
      return;
    }
    const paths = new Set(knownFiles(store.projects));
    for (const p of store.projects) {
      for (const name of await listBaseSpecNames(p.root)) paths.add(livingSpec(p.root, name));
    }
    for (const stale of known) if (!paths.has(stale)) collection.delete(vscode.Uri.file(stale));
    known = paths;

    for (const path of paths) {
      const ctx = classify(store.projects, path);
      if (!ctx) continue;
      const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === path);
      const text = open?.getText() ?? (await readTextSafe(path));
      if (text === undefined) continue;
      collection.set(vscode.Uri.file(path), toDiagnostics(open, text, lintFor(ctx, text)));
    }
  };

  const schedule = (doc: vscode.TextDocument): void => {
    const key = doc.uri.toString();
    const existing = timers.get(key);
    if (existing) clearTimeout(existing);
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key);
        lintDocument(doc);
      }, 350),
    );
  };

  void lintAll();
  return vscode.Disposable.from(
    collection,
    store.onDidChange(() => void lintAll()),
    vscode.workspace.onDidOpenTextDocument(lintDocument),
    vscode.workspace.onDidChangeTextDocument((e) => schedule(e.document)),
    vscode.workspace.onDidCloseTextDocument((doc) => {
      if (!known.has(doc.uri.fsPath)) collection.delete(doc.uri);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('wingmanSpec.diagnostics')) void lintAll();
    }),
    new vscode.Disposable(() => timers.forEach((t) => clearTimeout(t))),
  );
}
