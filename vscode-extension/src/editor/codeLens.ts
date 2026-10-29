import * as vscode from 'vscode';
import { supersedesNumber, buildAdrLinks } from '../model/adrGraph.ts';
import { parseSpec } from '../model/specParser.ts';
import { parseTasks } from '../model/tasksParser.ts';
import type { ProjectStore } from '../store.ts';
import { ADR_SYNC_LABEL } from '../views/adrLabels.ts';
import { requirementRouteByName } from '../model/reveal.ts';
import type { Route } from '../webview/types.ts';
import { classify } from './context.ts';

function lens(line: number, title: string, command: string, args: unknown[], tooltip?: string): vscode.CodeLens {
  const range = new vscode.Range(line, 0, line, 0);
  return new vscode.CodeLens(range, { title, command, arguments: args, tooltip });
}

const openRoute = (route: Route): [string, unknown[]] => ['wingmanSpec.openRoute', [route]];

export class SpecCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly subscription: vscode.Disposable;
  private readonly store: ProjectStore;

  constructor(store: ProjectStore) {
    this.store = store;
    this.subscription = vscode.Disposable.from(
      store.onDidChange(() => this.emitter.fire()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('wingmanSpec.codeLens')) this.emitter.fire();
      }),
    );
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!vscode.workspace.getConfiguration('wingmanSpec').get<boolean>('codeLens', true)) return [];
    const ctx = classify(this.store.projects, doc.uri.fsPath);
    if (!ctx) return [];
    const text = doc.getText();
    const lenses: vscode.CodeLens[] = [];

    switch (ctx.kind) {
      case 'tasks': {
        const { project, change } = ctx;
        const groups = parseTasks(text);
        const known = new Set([
          ...change.capabilities.map((c) => c.name),
          ...(this.store.baseSpecNames.get(project.root) ?? []),
        ]);
        lenses.push(lens(0, '$(dashboard) Open change dashboard', ...openRoute({ page: 'change', root: project.root, name: change.name })));
        for (const g of groups) {
          const done = g.tasks.filter((t) => t.checked).length;
          lenses.push(lens(g.line, `$(checklist) ${done}/${g.tasks.length} done`, ...openRoute({ page: 'change', root: project.root, name: change.name })));
          for (const t of g.tasks) {
            lenses.push(
              lens(t.line, t.checked ? '$(discard) Reopen' : '$(check) Mark done', 'wingmanSpec.toggleTask', [doc.uri.fsPath, t.line]),
            );
            const cap = t.details.spec?.split('>')[0]?.trim();
            if (cap && known.has(cap)) {
              const req = t.details.spec?.split('>')[1]?.trim();
              lenses.push(lens(t.line, `$(book) ${req ? `${cap} > ${req}` : cap}`, ...openRoute(req ? requirementRouteByName(project.root, cap, req) : { page: 'spec', root: project.root, name: cap })));
            }
          }
        }
        break;
      }
      case 'sourceAdr': {
        const { project, change, adr } = ctx;
        lenses.push(
          lens(0, `$(git-pull-request) ${ADR_SYNC_LABEL[adr.sync.state]}`, ...openRoute({ page: 'change', root: project.root, name: change.name, tab: 'adrs' }), adr.sync.detail),
        );
        if (adr.sync.target) {
          lenses.push(lens(0, `$(link) Promoted as ${adr.sync.target.number}`, ...openRoute({ page: 'adr', root: project.root, number: adr.sync.target.number })));
        }
        break;
      }
      case 'rootAdr': {
        const { project, adr } = ctx;
        const links = buildAdrLinks(project.adrs).get(adr.number);
        const bits = [adr.status || 'no status'];
        if (supersedesNumber(adr)) bits.push(`supersedes ${supersedesNumber(adr)}`);
        for (const s of links?.supersededBy ?? []) bits.push(`superseded by ${s.number}`);
        lenses.push(lens(0, `$(history) ${bits.join(' / ')}`, ...openRoute({ page: 'adr', root: project.root, number: adr.number })));
        break;
      }
      case 'deltaSpec':
      case 'baseSpec': {
        const name = ctx.kind === 'deltaSpec' ? ctx.capability.name : ctx.name;
        for (const r of parseSpec(text).requirements) {
          if (r.section === 'REMOVED') continue;
          lenses.push(
            lens(
              r.line,
              r.scenarios.length > 0 ? `$(beaker) ${r.scenarios.length} scenario${r.scenarios.length === 1 ? '' : 's'}` : '$(warning) no scenarios',
              ...openRoute(requirementRouteByName(ctx.project.root, name, r.name)),
              'Open this requirement in Wingman Spec',
            ),
          );
        }
        break;
      }
    }
    return lenses;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
