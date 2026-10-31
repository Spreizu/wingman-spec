import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { isTestFile } from '../model/anchors.ts';
import { PROBLEMS_SOURCE, coveredByLive, diagnosticOf, fixesFor, findingId, groupByFile, tagTitleEdit, testCases } from '../model/problems.ts';
import type { FixAction } from '../model/problems.ts';
import type { ProjectModel } from '../model/types.ts';
import type { VerifierFinding } from '../model/verifier.ts';
import { toWorkspaceEdit } from './markerFixes.ts';
import type { TraceCache } from './anchorCode.ts';
import type { VerifierClient } from './verifier.ts';
import type { ProjectStore } from '../store.ts';

const SETTING = 'problemsPanel';
const cfg = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('wingmanSpec');
export const problemsEnabled = (): boolean => cfg().get<boolean>(SETTING, true);
const codeViewOn = (): boolean => cfg().get<boolean>('codeView', true);

const SEVERITY: Record<VerifierFinding['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

const readIf = (f: string): string | undefined => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return undefined;
  }
};

/**
 * Publishes what `wingman-spec problems --json` finds (lint, placement, drift gaps, stale and changed anchors, the Why line) as
 * diagnostics at the right file and line, and offers the mechanical quick fixes. The verifier decides; this only displays and applies edits.
 */
export class ProblemsService implements vscode.CodeActionProvider, vscode.Disposable {
  private readonly diag = vscode.languages.createDiagnosticCollection('wingman-spec-problems');
  private readonly found = new Map<string, VerifierFinding>();
  private readonly roots = new Map<string, ProjectModel>();
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  /** Last result, for the status message and for tests. */
  summary = { error: 0, warning: 0, info: 0, problem: '' as string };
  private readonly store: ProjectStore;
  private readonly cache: TraceCache;
  private readonly client: VerifierClient;
  private readonly onChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onChange.event;

  constructor(store: ProjectStore, cache: TraceCache, client: VerifierClient) {
    this.store = store;
    this.cache = cache;
    this.client = client;
  }

  /** Every finding currently shown (the branch review filters these to its diff). */
  findings(): VerifierFinding[] {
    return [...this.found.values()];
  }

  schedule(delay = 800): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), delay);
  }

  /** Re-runs the verifier for every project and replaces the diagnostics. Concurrent calls are merged into one follow-up run. */
  refresh(manual = false): Promise<void> {
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = this.run(manual).finally(() => {
      this.running = undefined;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.running;
  }

  private async run(manual: boolean): Promise<void> {
    if (!problemsEnabled()) {
      this.clear();
      if (manual) void vscode.window.showInformationMessage('Wingman Spec: the Problems panel is switched off (setting wingmanSpec.problemsPanel).');
      return;
    }
    const all: VerifierFinding[] = [];
    const reasons: string[] = [];
    this.roots.clear();
    for (const p of this.store.projects) {
      if (p.error) continue;
      const r = await this.client.problems(p);
      if (!r.ok) {
        reasons.push(r.reason);
        continue;
      }
      this.roots.set(p.root, p);
      all.push(...r.value.findings);
    }
    const live = codeViewOn();
    const shown = all.filter((f) => !coveredByLive(f, live));
    this.diag.clear();
    this.found.clear();
    for (const [file, list] of groupByFile(shown)) {
      this.diag.set(
        vscode.Uri.file(file),
        list.map((f) => {
          const s = diagnosticOf(f);
          const d = new vscode.Diagnostic(new vscode.Range(s.line, s.col, s.line, s.endCol), s.message, SEVERITY[f.severity]);
          d.source = PROBLEMS_SOURCE;
          d.code = f.code;
          this.found.set(findingId(f), f);
          return d;
        }),
      );
    }
    this.summary = { error: shown.filter((f) => f.severity === 'error').length, warning: shown.filter((f) => f.severity === 'warning').length, info: shown.filter((f) => f.severity === 'info').length, problem: reasons[0] ?? '' };
    this.onChange.fire();
    if (manual) {
      const s = this.summary;
      void (reasons.length && !shown.length
        ? vscode.window.showWarningMessage(`Wingman Spec: the verifier could not be run: ${reasons[0]}`)
        : vscode.window.showInformationMessage(`Wingman Spec: ${s.error} error(s), ${s.warning} warning(s), ${s.info} info in the Problems panel.${reasons.length ? ` Not checked: ${reasons[0]}` : ''}`));
    }
  }

  clear(): void {
    this.diag.clear();
    this.found.clear();
    this.summary = { error: 0, warning: 0, info: 0, problem: '' };
    this.onChange.fire();
  }

  private projectOf(file: string): ProjectModel | undefined {
    return this.store.projects.find((p) => !p.error && (file.startsWith(p.root + sep) || file.startsWith(p.workspaceFolder + sep)));
  }

  provideCodeActions(doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const out: vscode.CodeAction[] = [];
    for (const d of ctx.diagnostics) {
      if (d.source !== PROBLEMS_SOURCE) continue;
      const f = this.found.get(findingId({ file: doc.uri.fsPath, line: d.range.start.line + 1, col: d.range.start.character + 1, code: String(d.code) }));
      if (!f) continue;
      const p = this.projectOf(f.file);
      const rel = p ? relative(p.workspaceFolder, f.file).split(sep).join('/') : f.file;
      for (const act of fixesFor(f, { text: doc.getText(), rel })) out.push(this.toAction(doc.uri, act, d));
    }
    return out;
  }

  private toAction(uri: vscode.Uri, act: FixAction, d: vscode.Diagnostic): vscode.CodeAction {
    const a = new vscode.CodeAction(act.title, vscode.CodeActionKind.QuickFix);
    a.diagnostics = [d];
    if (act.preferred) a.isPreferred = true;
    if (act.edits) a.edit = toWorkspaceEdit(uri, act.edits);
    if (act.command) a.command = { title: act.title, command: act.command.id, arguments: act.command.args };
    return a;
  }

  /** `wingmanSpec.acceptGap`: accept a gap (the verifier writes an `Accepted:` line on the requirement); the note is required and asked for. */
  async accept(file: string, key: string): Promise<void> {
    const p = this.projectOf(file);
    if (!p) return;
    const note = await vscode.window.showInputBox({ prompt: `Why is "${key}" acceptable as it is? The note is written to the requirement as its Accepted line.`, placeHolder: 'e.g. covered by an end-to-end test', ignoreFocusOut: true });
    if (!note?.trim()) return;
    const r = await this.client.accept(p, key, note.trim());
    if (!r.ok) {
      void vscode.window.showErrorMessage(`Wingman Spec: the gap was not accepted: ${r.reason}`);
      return;
    }
    void vscode.window.showInformationMessage(`Wingman Spec: accepted ${key} (see the Accepted line in its spec).`);
    await this.refresh();
    this.cache.invalidate(0);
  }

  /** `wingmanSpec.tagTest`: add `[cap/scenario]` to the title of an existing test case. */
  async tagTest(_file: string, reqKey: string, scenarios: { name: string; id: string }[]): Promise<void> {
    if (!scenarios.length) return;
    const scn =
      scenarios.length === 1
        ? scenarios[0]
        : await vscode.window.showQuickPick(
            scenarios.map((s) => ({ label: s.name, description: s.id, id: s.id })),
            { placeHolder: 'Which scenario does the test prove?' },
          ).then((x) => x && scenarios.find((s) => s.id === x.id));
    if (!scn) return;
    const hit = this.cache.forFile(_file);
    const known = [...new Set((hit?.model.requirements.get(reqKey)?.tests ?? []).map((t) => t.file))];
    const active = vscode.window.activeTextEditor?.document.uri.fsPath;
    const files = known.map((r) => join(hit?.model.codeRoot ?? '', r));
    if (active && isTestFile(relative(hit?.model.codeRoot ?? '', active).split(sep).join('/')) && !files.includes(active)) files.push(active);
    if (!files.length) {
      void vscode.window.showInformationMessage(`Wingman Spec: open the test file that proves "${scn.id}" and run this fix again (no test file carries ${reqKey} yet).`);
      return;
    }
    const file =
      files.length === 1
        ? files[0]
        : await vscode.window.showQuickPick(files.map((f) => ({ label: relative(hit?.model.codeRoot ?? '', f), f }))).then((x) => x?.f);
    if (!file) return;
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const cases = testCases(doc.getText());
    if (!cases.length) {
      void vscode.window.showInformationMessage('Wingman Spec: no it(...) / test(...) titles found in that file; add the tag to the test name yourself.');
      return;
    }
    const pick = await vscode.window.showQuickPick(cases.map((c) => ({ label: c.title || '(untitled)', description: `line ${c.line + 1}`, line: c.line })), { placeHolder: `Tag which test with [${scn.id}]?` });
    if (!pick) return;
    const edit = tagTitleEdit(doc.getText(), pick.line, scn.id);
    if (!edit) {
      void vscode.window.showInformationMessage(`Wingman Spec: that test is already tagged [${scn.id}].`);
      return;
    }
    await vscode.workspace.applyEdit(toWorkspaceEdit(doc.uri, [edit]));
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.diag.dispose();
    this.onChange.dispose();
  }
}

export function registerProblems(store: ProjectStore, cache: TraceCache, client: VerifierClient): { service: ProblemsService; disposable: vscode.Disposable } {
  const service = new ProblemsService(store, cache, client);
  const under = (p: string): boolean => store.projects.some((x) => p.startsWith(x.root + sep) || p.startsWith(x.workspaceFolder + sep));
  const disposable = vscode.Disposable.from(
    service,
    vscode.languages.registerCodeActionsProvider({ scheme: 'file' }, service, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    vscode.commands.registerCommand('wingmanSpec.refreshProblems', () => service.refresh(true)),
    vscode.commands.registerCommand('wingmanSpec.acceptGap', (file: string, key: string) => service.accept(file, key)),
    vscode.commands.registerCommand('wingmanSpec.tagTest', (file: string, req: string, scenarios: { name: string; id: string }[]) => service.tagTest(file, req, scenarios)),
    vscode.workspace.onDidSaveTextDocument((d) => {
      if (problemsEnabled() && under(d.uri.fsPath)) service.schedule();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`wingmanSpec.${SETTING}`) || e.affectsConfiguration('wingmanSpec.codeView')) void service.refresh();
    }),
  );
  return { service, disposable };
}
