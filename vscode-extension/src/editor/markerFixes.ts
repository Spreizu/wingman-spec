import * as vscode from 'vscode';
import { moveMarkerPlan, removeMarkerEdit } from '../model/markerFix.ts';
import type { TextEdit } from '../model/markerFix.ts';
import { unresolvedInfo } from '../model/reqInsight.ts';
import type { TraceCache } from './anchorCode.ts';

export function toWorkspaceEdit(uri: vscode.Uri, edits: TextEdit[]): vscode.WorkspaceEdit {
  const we = new vscode.WorkspaceEdit();
  for (const e of edits) we.replace(uri, new vscode.Range(e.line, e.col, e.endLine, e.endCol), e.text);
  return we;
}

/** Quick fixes on the Wingman Spec marker warnings: "Fix marker to <nearest requirement>" and "Move marker into the doc comment". */
export class MarkerFixes implements vscode.CodeActionProvider {
  private readonly cache: TraceCache;
  constructor(cache: TraceCache) {
    this.cache = cache;
  }

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const f = this.cache.forFile(doc.uri.fsPath);
    if (!f) return [];
    const out: vscode.CodeAction[] = [];
    for (const d of ctx.diagnostics) {
      if (d.source !== 'Wingman Spec') continue;
      if (d.code === 'unresolved-marker') {
        const key = doc.getText(d.range);
        const info = unresolvedInfo(f.model, key);
        if (!info.hint || info.addedBy) continue;
        const a = new vscode.CodeAction(`Fix marker to ${info.hint}`, vscode.CodeActionKind.QuickFix);
        a.diagnostics = [d];
        a.isPreferred = true;
        a.edit = new vscode.WorkspaceEdit();
        a.edit.replace(doc.uri, d.range, info.hint);
        out.push(a);
      } else if (d.code === 'marker-placement' && !String(d.message).startsWith('duplicate-marker')) {
        const plan = moveMarkerPlan(doc.getText(), f.rel, d.range.start.line);
        if (!plan) continue;
        const a = new vscode.CodeAction(plan.title, vscode.CodeActionKind.QuickFix);
        a.diagnostics = [d];
        a.edit = toWorkspaceEdit(doc.uri, plan.edits);
        out.push(a);
      }
    }
    return out;
  }
}
