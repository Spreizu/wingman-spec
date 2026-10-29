import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import chrono from '../../../project-template/openspec/scripts/chronology.cjs';
import { reviewBranch } from '../model/branchReview.ts';
import type { ChangedFile } from '../model/branchReview.ts';
import { summarizeRun } from '../model/changeDashboard.ts';
import type { DashboardInputs } from '../model/changeDashboard.ts';
import { applyNumstat, chooseBase, parseNameStatus } from '../model/gitDiff.ts';
import type { ProjectModel } from '../model/types.ts';
import type { VerifierFinding } from '../model/verifier.ts';
import type { ProjectStore } from '../store.ts';
import type { BranchState, RoadmapState } from '../webview/types.ts';
import type { TraceCache } from './anchorCode.ts';
import { execRunner } from './verifier.ts';
import type { Runner, VerifierClient } from './verifier.ts';

const cfg = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('wingmanSpec');
const MAX_FILES = 400;
const MAX_BYTES = 512 * 1024;
const TTL_MS = 5000;

const readIf = (f: string): string | undefined => {
  try {
    return statSync(f).size > MAX_BYTES ? undefined : readFileSync(f, 'utf8');
  } catch {
    return undefined;
  }
};

/** The run files `verify-task.cjs` keeps under `openspec/.apply-runs/<change>/` (read-only). */
export function readRunFiles(root: string, change: string): { runId?: string; state?: string; metrics?: string; ledger?: string } {
  const base = join(root, 'openspec', '.apply-runs', change);
  if (!existsSync(base)) return {};
  let id: string | undefined;
  try {
    id = readIf(join(base, 'current'))?.trim();
  } catch {
    id = undefined;
  }
  if (!id || !existsSync(join(base, id))) {
    try {
      id = chrono.latestRun(readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name));
    } catch {
      id = undefined;
    }
  }
  const run = id ? join(base, id) : undefined;
  return { ...(id ? { runId: id } : {}), ...(run && readIf(join(run, 'state.json')) ? { state: readIf(join(run, 'state.json')) } : {}), ...(run && readIf(join(run, 'metrics.jsonl')) ? { metrics: readIf(join(run, 'metrics.jsonl')) } : {}), ...(readIf(join(base, 'verified.json')) ? { ledger: readIf(join(base, 'verified.json')) } : {}) };
}

/**
 * Data the pull request view and the change dashboard need from git and the verifier. Loaded in the background (the page shows
 * a loading state first and is re-rendered when an answer arrives); answers are kept for a few seconds.
 */
export class PanelData {
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private readonly inflight = new Set<string>();
  private readonly store: ProjectStore;
  private readonly trace: TraceCache;
  private readonly client: VerifierClient;
  private readonly git: Runner;
  onReady: () => void = () => {};

  constructor(store: ProjectStore, trace: TraceCache, client: VerifierClient, git: Runner = execRunner) {
    this.store = store;
    this.trace = trace;
    this.client = client;
    this.git = git;
  }

  invalidate(): void {
    this.cache.clear();
  }

  private get<T>(key: string, load: () => Promise<T>): T | undefined {
    const hit = this.cache.get(key);
    const fresh = hit && Date.now() - hit.at < TTL_MS;
    if (!fresh && !this.inflight.has(key)) {
      this.inflight.add(key);
      void load()
        .then((value) => this.cache.set(key, { at: Date.now(), value }))
        .catch(() => this.cache.delete(key))
        .finally(() => {
          this.inflight.delete(key);
          this.onReady();
        });
    }
    return hit?.value as T | undefined;
  }

  branch(root: string | undefined): BranchState {
    const p = this.store.projects.find((x) => !x.error && (root === undefined || x.root === root));
    if (!p) return { status: 'unavailable', reason: 'No OpenSpec project is open.' };
    return this.get(`branch\n${p.root}`, () => this.loadBranch(p)) ?? { status: 'loading' };
  }

  roadmap(root: string | undefined): RoadmapState {
    const p = this.store.projects.find((x) => !x.error && (root === undefined || x.root === root));
    if (!p) return { status: 'unavailable', reason: 'No OpenSpec project is open.' };
    return this.get(`roadmap\n${p.root}`, async (): Promise<RoadmapState> => {
      const r = await this.client.roadmap(p);
      return r.ok ? { status: 'ready', roadmap: r.value } : { status: 'unavailable', reason: r.reason };
    }) ?? { status: 'loading' };
  }

  dashboard(root: string, change: string): DashboardInputs | undefined {
    const p = this.store.projects.find((x) => x.root === root);
    if (!p) return undefined;
    return this.get(`dash\n${root}\n${change}`, () => this.loadDashboard(p, change));
  }

  private async loadDashboard(p: ProjectModel, change: string): Promise<DashboardInputs> {
    const run = summarizeRun(readRunFiles(p.root, change));
    if (!cfg().get<boolean>('dashboardChecks', true)) return { ...(run ? { run } : {}), unavailable: 'the dashboard checks are switched off (setting wingmanSpec.dashboardChecks)' };
    const [problems, sync] = await Promise.all([this.client.problems(p, change), this.client.syncCheck(p, change)]);
    return {
      ...(run ? { run } : {}),
      ...(problems.ok ? { findings: problems.value.findings } : {}),
      ...(sync.ok ? { sync: sync.value } : {}),
      ...(!problems.ok ? { unavailable: problems.reason } : !sync.ok ? { unavailable: sync.reason } : {}),
    };
  }

  private async g(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
    const r = await this.git('git', args, { cwd, timeoutMs: Math.max(1, cfg().get<number>('verifierTimeoutSeconds', 30)) * 1000 });
    return { ok: r.code === 0 && !r.spawnError && !r.timedOut, out: r.stdout };
  }

  private async loadBranch(p: ProjectModel): Promise<BranchState> {
    if (!cfg().get<boolean>('branchReviewGit', true)) return { status: 'unavailable', reason: 'Reading git is switched off (setting wingmanSpec.branchReviewGit).' };
    if (!vscode.workspace.isTrusted) return { status: 'unavailable', reason: 'The workspace is not trusted, so git is not run.' };
    const cwd = p.workspaceFolder;
    const top = await this.g(cwd, ['rev-parse', '--show-toplevel']);
    if (!top.ok) return { status: 'unavailable', reason: 'This folder is not a git repository (or git is not installed), so there is no branch to compare.' };
    const head = (await this.g(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim() || 'HEAD';
    const wanted = cfg().get<string>('branchReviewBase', '').trim();
    const existing = new Set<string>();
    for (const ref of [wanted, 'origin/main', 'origin/master', 'main', 'master', 'origin/develop', 'develop']) {
      if (ref && !existing.has(ref) && (await this.g(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).ok) existing.add(ref);
    }
    const base = chooseBase(wanted, (r) => existing.has(r));
    if (!base) return { status: 'unavailable', reason: 'No base branch found (looked for origin/main, origin/master, main, master, develop). Set wingmanSpec.branchReviewBase.' };
    const mb = await this.g(cwd, ['merge-base', base, 'HEAD']);
    if (!mb.ok || !mb.out.trim()) return { status: 'unavailable', reason: `No common ancestor of HEAD and ${base} (shallow clone?).` };
    const mergeBase = mb.out.trim();

    const ns = await this.g(cwd, ['diff', '--name-status', '-M', mergeBase, '--']);
    const num = await this.g(cwd, ['diff', '--numstat', '-M', mergeBase, '--']);
    if (!ns.ok) return { status: 'unavailable', reason: 'git diff failed.' };
    const files = applyNumstat(parseNameStatus(ns.out), num.out);
    const untracked = (await this.g(cwd, ['ls-files', '--others', '--exclude-standard'])).out.split('\n').filter(Boolean);
    for (const f of untracked) if (!files.some((x) => x.path === f)) files.push({ path: f, from: f, status: 'A', added: 0, removed: 0 });
    const notes: string[] = [];
    const used = files.slice(0, MAX_FILES);
    if (files.length > used.length) notes.push(`Only the first ${MAX_FILES} of ${files.length} changed files were analysed.`);
    const withText: ChangedFile[] = [];
    for (let i = 0; i < used.length; i += 16) {
      withText.push(
        ...(await Promise.all(
          used.slice(i, i + 16).map(async (f): Promise<ChangedFile> => {
            const oldText = f.status === 'A' ? undefined : (await this.g(cwd, ['show', `${mergeBase}:${f.from}`])).out;
            const newText = f.status === 'D' ? undefined : readIf(join(cwd, f.path));
            return { ...f, ...(oldText !== undefined && oldText.length <= MAX_BYTES ? { oldText } : {}), ...(newText !== undefined ? { newText } : {}) };
          }),
        )),
      );
    }

    const model = this.trace.byRoot(p.root);
    if (!model) return { status: 'unavailable', reason: 'The traceability model of this project is not ready.' };
    let findings: VerifierFinding[] = [];
    const pr = await this.client.problems(p);
    if (pr.ok) findings = pr.value.findings;
    else notes.push(`Verifier findings are missing: ${pr.reason}.`);
    const changes = [...new Set(withText.map((f) => /^openspec\/changes\/(?!archive\/)([^/]+)\//.exec(f.path)?.[1]).filter((x): x is string => !!x))].slice(0, 5);
    for (const c of changes) {
      const g = await this.client.guard(p, c, mergeBase);
      if (g.ok) findings.push(...g.value);
    }
    return { status: 'ready', review: reviewBranch({ root: p.root, codeRoot: cwd, branch: head, base, mergeBase, files: withText, model, findings, notes }) };
  }
}
