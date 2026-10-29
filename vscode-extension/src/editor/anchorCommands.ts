import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { moveMarkerPlan, replaceKeyEdit } from '../model/markerFix.ts';
import { filteredTestCommand, planTest, scenarioMenu, testStub } from '../model/reqInsight.ts';
import type { MenuItem, ReqInsight } from '../model/reqInsight.ts';
import { revealRoute } from '../model/reveal.ts';
import type { TraceModel } from '../model/traceability.ts';
import type { Route } from '../webview/types.ts';
import type { TraceCache } from './anchorCode.ts';
import { toWorkspaceEdit } from './markerFixes.ts';

/** What the reveal commands need from the Wingman Spec UI. */
export interface RevealPanel {
  show(route: Route): void;
}

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

interface Pick extends vscode.QuickPickItem {
  item?: MenuItem;
  file?: string;
  line?: number;
}

/** Commands behind the marker CodeLens, hover links, quick fixes and the tree: reveal in the UI, pick a scenario, tests, code, run tests. */
export function registerAnchorCommands(cache: TraceCache, panel: RevealPanel): vscode.Disposable {
  const open = (file: string, line?: number): Thenable<unknown> => vscode.commands.executeCommand('wingmanSpec.openFile', file, line);
  const target = (root: unknown, key: unknown): { model: TraceModel; ins: ReqInsight } | undefined => {
    if (!isStr(root) || !isStr(key)) return undefined;
    const model = cache.byRoot(root);
    const ins = model && cache.insight(model, key);
    return model && ins ? { model, ins } : undefined;
  };

  async function createTest(model: TraceModel, ins: ReqInsight, scenario: string, rel: string): Promise<void> {
    const uri = vscode.Uri.file(join(model.codeRoot, rel));
    const stub = testStub(ins, scenario, rel);
    const we = new vscode.WorkspaceEdit();
    let line = 0;
    if (existsSync(uri.fsPath)) {
      const doc = await vscode.workspace.openTextDocument(uri);
      line = doc.lineCount;
      we.insert(uri, new vscode.Position(doc.lineCount, 0), `${doc.lineCount > 0 && doc.lineAt(doc.lineCount - 1).text !== '' ? '\n\n' : '\n'}${stub}`);
      line += 1;
    } else {
      we.createFile(uri, { ignoreIfExists: true });
      we.insert(uri, new vscode.Position(0, 0), stub);
    }
    await vscode.workspace.applyEdit(we);
    await open(uri.fsPath, line);
  }

  async function chooseAndGo(model: TraceModel, ins: ReqInsight, rows: MenuItem[], title: string): Promise<void> {
    const picks: Pick[] = rows.map((r) => ({ label: r.label, ...(r.description ? { description: r.description } : {}), ...(r.detail ? { detail: r.detail } : {}), item: r }));
    const chosen = await vscode.window.showQuickPick(picks, { title, placeHolder: ins.key, matchOnDescription: true });
    const it = chosen?.item;
    if (!it) return;
    if (it.create) await createTest(model, ins, it.create.scenario, it.create.file);
    else if (it.file) await open(it.file, it.line);
    else if (it.reveal) panel.show(revealRoute(model, it.reveal));
  }

  const menu = (model: TraceModel, ins: ReqInsight): MenuItem[] =>
    scenarioMenu(ins, model.codeRoot, planTest(ins, (rel) => existsSync(join(model.codeRoot, rel))), join);

  return vscode.Disposable.from(
    vscode.commands.registerCommand('wingmanSpec.revealRequirement', (root: unknown, key: unknown) => {
      if (isStr(root) && isStr(key)) panel.show(revealRoute({ root }, { type: 'requirement', key }));
    }),
    vscode.commands.registerCommand('wingmanSpec.revealScenario', (root: unknown, key: unknown, scenario: unknown) => {
      if (isStr(root) && isStr(key) && isStr(scenario)) panel.show(revealRoute({ root }, { type: 'scenario', key, scenario }));
    }),
    vscode.commands.registerCommand('wingmanSpec.pickScenario', async (root: unknown, key: unknown) => {
      const t = target(root, key);
      if (t) await chooseAndGo(t.model, t.ins, menu(t.model, t.ins), `${t.ins.name}: scenarios and their tests`);
    }),
    vscode.commands.registerCommand('wingmanSpec.showTests', async (root: unknown, key: unknown) => {
      const t = target(root, key);
      if (!t) return;
      const seen = new Set<string>();
      const tests: MenuItem[] = t.ins.tests
        .filter((a) => !seen.has(`${a.file}:${a.line}`) && seen.add(`${a.file}:${a.line}`))
        .map((a) => ({ id: `t:${a.file}:${a.line}`, label: `$(beaker) ${a.file}:${a.line + 1}`, description: a.kind === 'tag' ? `test tag [${t.ins.cap}/${a.scenario ?? ''}]` : 'test', file: join(t.model.codeRoot, a.file), line: a.line }));
      const missing = menu(t.model, t.ins).filter((r) => r.create);
      await chooseAndGo(t.model, t.ins, [...tests, ...missing], `Tests of ${t.ins.name}`);
    }),
    vscode.commands.registerCommand('wingmanSpec.showAnchors', async (root: unknown, key: unknown, kind?: unknown, fromFile?: unknown, fromLine?: unknown) => {
      const t = target(root, key);
      if (!t) {
        if (isStr(root) && isStr(key)) void vscode.window.showInformationMessage(`${key}: nothing to show. Add \`@spec ${key}\` in a comment next to the code.`);
        return;
      }
      const only = kind === 'code' || kind === 'tests' ? kind : undefined;
      const same = (a: { file: string; line: number }): boolean => a.file === fromFile && a.line === fromLine;
      const rows: MenuItem[] = [
        ...(only === 'tests' ? [] : t.ins.code.filter((a) => !same(a)).map((a) => ({ id: `c:${a.file}:${a.line}`, label: `$(symbol-method) ${a.file}:${a.line + 1}`, description: 'code', file: join(t.model.codeRoot, a.file), line: a.line }))),
        ...(only === 'code' ? [] : t.ins.tests.map((a) => ({ id: `t:${a.file}:${a.line}`, label: `$(beaker) ${a.file}:${a.line + 1}`, description: a.kind === 'tag' ? 'test tag' : 'test', file: join(t.model.codeRoot, a.file), line: a.line }))),
      ];
      if (!rows.length) {
        void vscode.window.showInformationMessage(`${t.ins.key}: no code or test anchors yet. Add \`@spec ${t.ins.key}\` in a comment next to the code.`);
        return;
      }
      await chooseAndGo(t.model, t.ins, rows, `Anchors of ${t.ins.name}`);
    }),
    vscode.commands.registerCommand('wingmanSpec.runTests', (root: unknown, key: unknown) => {
      const t = target(root, key);
      if (!t) return;
      const cfg = cache.testCommand(t.model);
      if (!cfg || !vscode.workspace.isTrusted) {
        void vscode.window.showInformationMessage('No project test command is set (the "Test command:" line in the OpenSpec config), or the workspace is not trusted.');
        return;
      }
      const { command, filtered } = filteredTestCommand(cfg.command, t.ins.scenarios.map((s) => `${t.ins.cap}/${s.slug}`), cfg.script);
      const terminal = vscode.window.createTerminal({ name: `Wingman Spec: ${t.ins.name}`, cwd: t.model.codeRoot });
      terminal.show();
      terminal.sendText(command);
      if (!filtered) void vscode.window.showInformationMessage('The test runner was not recognised, so the whole test command ran. Put {tags} where the test-name filter belongs in the "Test command:" line to narrow it.');
    }),
    vscode.commands.registerCommand('wingmanSpec.fixMarker', async (uri: unknown, line: unknown, col: unknown, length: unknown, newKey: unknown) => {
      if (!isStr(uri) || !isNum(line) || !isNum(col) || !isNum(length) || !isStr(newKey)) return;
      const u = vscode.Uri.parse(uri);
      await vscode.workspace.applyEdit(toWorkspaceEdit(u, [replaceKeyEdit({ line, col, length }, newKey)]));
    }),
    vscode.commands.registerCommand('wingmanSpec.moveMarker', async (uri: unknown, line: unknown) => {
      if (!isStr(uri) || !isNum(line)) return;
      const u = vscode.Uri.parse(uri);
      const doc = await vscode.workspace.openTextDocument(u);
      const hit = cache.forFile(doc.uri.fsPath);
      const plan = hit && moveMarkerPlan(doc.getText(), hit.rel, line);
      if (!plan) {
        void vscode.window.showInformationMessage('No function found to move this marker into. Put it in the doc comment of the function that implements the requirement.');
        return;
      }
      await vscode.workspace.applyEdit(toWorkspaceEdit(u, plan.edits));
    }),
  );
}

