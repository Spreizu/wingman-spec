import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import * as vscode from 'vscode';
import { anchorProblems, resolve, reverseTitle } from '../model/anchorView.ts';
import { isScannable, isTestFile, isTestPath, itemAt, markersIn } from '../model/anchors.ts';
import { HOVER_COMMANDS, hoverInsight, hoverUnresolved } from '../model/hoverText.ts';
import { insightOf, lensText, lensTooltip, readTestCommand, unresolvedInfo, unresolvedLensText } from '../model/reqInsight.ts';
import type { ReqInsight } from '../model/reqInsight.ts';
import { buildTrace } from '../model/traceability.ts';
import type { TraceModel } from '../model/traceability.ts';
import type { ProjectStore } from '../store.ts';
import { registerAnchorCommands } from './anchorCommands.ts';
import { MarkerFixes } from './markerFixes.ts';
import type { RevealPanel } from './anchorCommands.ts';

const SETTING = 'codeView';
const enabled = (): boolean => vscode.workspace.getConfiguration('wingmanSpec').get<boolean>(SETTING, true);
const inside = (root: string, file: string): boolean => {
  const r = relative(root, file);
  return r !== '' && !r.startsWith('..') && !isAbsolute(r);
};

/** The traceability model of each project, built lazily and rebuilt (debounced) when files or the store change. */
export class TraceCache implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private models = new Map<string, TraceModel>();
  private timer: NodeJS.Timeout | undefined;
  private readonly subs: vscode.Disposable[];
  private readonly store: ProjectStore;

  constructor(store: ProjectStore) {
    this.store = store;
    this.subs = [
      store.onDidChange(() => this.invalidate(0)),
      vscode.workspace.onDidSaveTextDocument(() => this.invalidate(500)),
      vscode.workspace.onDidCreateFiles(() => this.invalidate(500)),
      vscode.workspace.onDidDeleteFiles(() => this.invalidate(500)),
      vscode.workspace.onDidRenameFiles(() => this.invalidate(500)),
    ];
  }

  private insights = new Map<string, ReqInsight | undefined>();
  private testCommands = new Map<string, { command: string; script?: string } | null>();

  /** The insight of a requirement of this model (anchors, tested scenarios, the Why, pending changes, ADRs), memoised until the next rebuild. */
  insight(model: TraceModel, key: string): ReqInsight | undefined {
    const k = `${model.root}\n${key}`;
    if (!this.insights.has(k)) this.insights.set(k, insightOf(model, key, this.store.projects.find((p) => p.root === model.root)?.adrs ?? []));
    return this.insights.get(k);
  }

  /** The project's test command from the OpenSpec config (and `scripts.test` of package.json for `npm test`), or undefined. */
  testCommand(model: TraceModel): { command: string; script?: string } | undefined {
    const k = model.root;
    if (!this.testCommands.has(k)) {
      let found: { command: string; script?: string } | null = null;
      for (const f of [join(model.codeRoot, 'openspec', 'config.yaml'), join(model.root, 'openspec', 'config.yaml')]) {
        try {
          const c = readTestCommand(readFileSync(f, 'utf8'));
          if (c) {
            let script: string | undefined;
            try {
              script = (JSON.parse(readFileSync(join(model.codeRoot, 'package.json'), 'utf8')) as { scripts?: { test?: string } }).scripts?.test;
            } catch {
              script = undefined;
            }
            found = { command: c, ...(script ? { script } : {}) };
            break;
          }
        } catch {
          // no config here
        }
      }
      this.testCommands.set(k, found);
    }
    return this.testCommands.get(k) ?? undefined;
  }

  /** The model for an OpenSpec root. */
  byRoot(root: string): TraceModel | undefined {
    return this.all().find((m) => m.root === root);
  }

  invalidate(delay: number): void {
    clearTimeout(this.timer);
    const run = (): void => {
      this.models.clear();
      this.insights.clear();
      this.testCommands.clear();
      this.emitter.fire();
    };
    if (delay === 0) run();
    else this.timer = setTimeout(run, delay);
  }

  /** Models of all projects (one per OpenSpec root). */
  all(): TraceModel[] {
    return this.store.projects.filter((p) => !p.error).map((p) => this.of(p.root, p.workspaceFolder));
  }

  private of(root: string, codeRoot: string): TraceModel {
    const k = `${root}\n${codeRoot}`;
    let m = this.models.get(k);
    if (!m) {
      m = buildTrace(root, codeRoot);
      this.models.set(k, m);
    }
    return m;
  }

  /** The model whose code root contains the file, and the path relative to it. */
  forFile(fsPath: string): { model: TraceModel; rel: string } | undefined {
    for (const p of this.store.projects) {
      if (p.error || !inside(p.workspaceFolder, fsPath)) continue;
      return { model: this.of(p.root, p.workspaceFolder), rel: relative(p.workspaceFolder, fsPath).split(sep).join('/') };
    }
    return undefined;
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.emitter.dispose();
    for (const s of this.subs) s.dispose();
  }
}

const SETTING_RUN = 'runTestsLens';
const runEnabled = (): boolean => vscode.workspace.isTrusted && vscode.workspace.getConfiguration('wingmanSpec').get<boolean>(SETTING_RUN, true);

/** Lenses above each `@spec` marker: the summary, then the places it can take you. */
class AnchorCodeLens implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly cache: TraceCache;
  constructor(cache: TraceCache) {
    this.cache = cache;
  }
  fire(): void {
    this.emitter.fire();
  }
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!enabled() || doc.uri.scheme !== 'file') return [];
    const hit = this.cache.forFile(doc.uri.fsPath);
    if (!hit || !isScannable(hit.rel)) return [];
    const text = doc.getText();
    if (!text.includes('@spec')) return [];
    const { model } = hit;
    const placed = new Map<number, string>();
    for (const p of anchorProblems(model, hit.rel, text)) if (p.code === 'marker-placement' || p.code === 'over-anchored') placed.set(p.line, p.message);
    const seen = new Set<number>();
    const lenses: vscode.CodeLens[] = [];
    const test = isTestPath(hit.rel);
    for (const m of markersIn(text)) {
      const range = new vscode.Range(m.line, 0, m.line, 0);
      if (seen.has(m.line)) continue;
      seen.add(m.line);
      const ins = this.cache.insight(model, m.key);
      if (!ins) {
        const info = unresolvedInfo(model, m.key);
        lenses.push(new vscode.CodeLens(range, { title: unresolvedLensText(m.key, info), tooltip: info.text, command: info.hint && !info.addedBy ? 'wingmanSpec.fixMarker' : 'wingmanSpec.showAnchors', arguments: info.hint && !info.addedBy ? [doc.uri.toString(), m.line, m.col, m.length, info.hint] : [model.root, m.key] }));
        continue;
      }
      const mine = (a: { file: string; line: number }): boolean => a.file === hit.rel && a.line === m.line;
      lenses.push(new vscode.CodeLens(range, { title: `$(book) ${lensText(ins)}`, tooltip: lensTooltip(ins), command: 'wingmanSpec.pickScenario', arguments: [model.root, m.key] }));
      lenses.push(new vscode.CodeLens(range, { title: 'Spec', tooltip: 'Open this requirement in Wingman Spec', command: 'wingmanSpec.revealRequirement', arguments: [model.root, m.key] }));
      lenses.push(new vscode.CodeLens(range, { title: ins.tests.length ? `Tests (${new Set(ins.tests.map((t) => `${t.file}:${t.line}`)).size})` : 'Add test', tooltip: ins.tests.length ? 'Jump to the tests of this requirement' : 'No test yet: create or open the likely test file', command: 'wingmanSpec.showTests', arguments: [model.root, m.key] }));
      const others = ins.code.filter((a) => !mine(a));
      if (!test && others.length) lenses.push(new vscode.CodeLens(range, { title: `Code (${others.length})`, tooltip: 'Other code that implements this requirement', command: 'wingmanSpec.showAnchors', arguments: [model.root, m.key, 'code', hit.rel, m.line] }));
      if (runEnabled() && this.cache.testCommand(model)) lenses.push(new vscode.CodeLens(range, { title: '$(play) Run tests', tooltip: 'Run the project tests tagged with this requirement\'s scenarios in a terminal', command: 'wingmanSpec.runTests', arguments: [model.root, m.key] }));
      const bad = placed.get(m.line);
      if (bad) lenses.push(new vscode.CodeLens(range, { title: '$(warning) Move marker into the doc comment', tooltip: bad, command: 'wingmanSpec.moveMarker', arguments: [doc.uri.toString(), m.line] }));
    }
    return lenses;
  }
}

/** On a base spec's requirement headings: how many anchors it has; click lists them. */
class ReverseLens implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly cache: TraceCache;
  constructor(cache: TraceCache) {
    this.cache = cache;
  }
  fire(): void {
    this.emitter.fire();
  }
  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!enabled()) return [];
    for (const model of this.cache.all()) {
      const reqs = [...model.requirements.values()].filter((r) => resolvePath(r.file) === resolvePath(doc.uri.fsPath));
      if (!reqs.length) continue;
      return reqs.map((r) => new vscode.CodeLens(new vscode.Range(r.line, 0, r.line, 0), {
        title: `$(references) ${reverseTitle(r)}`,
        command: 'wingmanSpec.showAnchors',
        arguments: [model.root, r.key],
        tooltip: 'Jump to the code and tests that carry this requirement',
      }));
    }
    return [];
  }
}

const range = (line: number, col: number, length: number): vscode.Range => new vscode.Range(line, col, line, col + length);

/** CodeLens, hover, go-to-definition and diagnostics for `@spec` markers and test tags, in every file. */
export function registerAnchorCode(cache: TraceCache, panel: RevealPanel): vscode.Disposable {
  const lens = new AnchorCodeLens(cache);
  const reverse = new ReverseLens(cache);
  const diag = vscode.languages.createDiagnosticCollection('wingman-spec-anchors');
  const selector: vscode.DocumentSelector = { scheme: 'file' };

  const check = (doc: vscode.TextDocument): void => {
    if (doc.uri.scheme !== 'file') return;
    const hit = enabled() ? cache.forFile(doc.uri.fsPath) : undefined;
    if (!hit) {
      diag.delete(doc.uri);
      return;
    }
    const problems = anchorProblems(hit.model, hit.rel, doc.getText());
    diag.set(doc.uri, problems.map((p) => {
      const d = new vscode.Diagnostic(range(p.line, p.col, p.length), p.message, p.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      d.source = 'Wingman Spec';
      d.code = p.code;
      return d;
    }));
  };
  const checkAll = (): void => {
    diag.clear();
    for (const d of vscode.workspace.textDocuments) check(d);
  };
  const onChange = new Map<string, NodeJS.Timeout>();

  return vscode.Disposable.from(
    diag,
    cache.onDidChange(() => {
      lens.fire();
      reverse.fire();
      checkAll();
    }),
    vscode.languages.registerCodeLensProvider(selector, lens),
    vscode.languages.registerCodeLensProvider({ scheme: 'file', pattern: '**/openspec/specs/*/spec.md' }, reverse),
    vscode.languages.registerHoverProvider(selector, {
      provideHover(doc, pos) {
        if (!enabled()) return undefined;
        const f = cache.forFile(doc.uri.fsPath);
        if (!f) return undefined;
        const it = itemAt(doc.getText(), pos.line, pos.character, isTestFile(f.rel));
        if (!it) return undefined;
        const res = resolve(f.model, it.kind, it.key);
        const text = new vscode.MarkdownString(undefined, false);
        text.isTrusted = { enabledCommands: HOVER_COMMANDS };
        if (!res) {
          if (it.kind !== 'marker') return undefined;
          text.appendMarkdown(hoverUnresolved(it.key, unresolvedInfo(f.model, it.key), { root: f.model.root, uri: doc.uri.toString(), line: pos.line, col: it.col, length: it.length }));
          return new vscode.Hover(text, range(pos.line, it.col, it.length));
        }
        const ins = cache.insight(f.model, res.requirement.key);
        if (!ins) return undefined;
        text.appendMarkdown(hoverInsight(ins, { root: f.model.root, codeRoot: f.model.codeRoot, canRun: runEnabled() && cache.testCommand(f.model) !== undefined, ...(res.kind === 'tag' ? { scenario: it.key.split('/')[1] ?? '' } : {}) }));
        return new vscode.Hover(text, range(pos.line, it.col, it.length));
      },
    }),
    vscode.languages.registerDefinitionProvider(selector, {
      provideDefinition(doc, pos) {
        if (!enabled()) return undefined;
        const f = cache.forFile(doc.uri.fsPath);
        if (!f) return undefined;
        const it = itemAt(doc.getText(), pos.line, pos.character, isTestFile(f.rel));
        const res = it && resolve(f.model, it.kind, it.key);
        if (!it || !res) return undefined;
        const line = res.kind === 'tag' ? res.scenario.line : res.requirement.line;
        const target = new vscode.Position(line, 0);
        return [{ originSelectionRange: range(pos.line, it.col, it.length), targetUri: vscode.Uri.file(res.requirement.file), targetRange: new vscode.Range(target, target), targetSelectionRange: new vscode.Range(target, target) }];
      },
    }),
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidCloseTextDocument((d) => diag.delete(d.uri)),
    vscode.workspace.onDidChangeTextDocument((e) => {
      const k = e.document.uri.toString();
      clearTimeout(onChange.get(k));
      onChange.set(k, setTimeout(() => check(e.document), 300));
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`wingmanSpec.${SETTING}`) || e.affectsConfiguration(`wingmanSpec.${SETTING_RUN}`)) {
        lens.fire();
        reverse.fire();
        checkAll();
      }
    }),
    registerAnchorCommands(cache, panel),
    vscode.languages.registerCodeActionsProvider(selector, new MarkerFixes(cache), { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
    new vscode.Disposable(() => onChange.forEach((t) => clearTimeout(t))),
  );
}
