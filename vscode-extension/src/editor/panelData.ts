import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runsDir } from '../core/paths.ts';
import * as vscode from 'vscode';
import chrono from '../core/chronology.ts';
import { summarizeRun } from '../model/changeDashboard.ts';
import type { DashboardInputs } from '../model/changeDashboard.ts';
import type { ActionResult, CliAction } from '../model/cliActions.ts';
import type { ProjectModel } from '../model/types.ts';
import type { ProjectStore } from '../store.ts';
import type { RoadmapState } from '../webview/types.ts';
import type { VerifierClient } from './verifier.ts';

const cfg = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('wingmanSpec');
const MAX_BYTES = 512 * 1024;
const TTL_MS = 5000;

const readIf = (f: string): string | undefined => {
  try {
    return statSync(f).size > MAX_BYTES ? undefined : readFileSync(f, 'utf8');
  } catch {
    return undefined;
  }
};

/** The run files the CLI keeps under `runs/<change>/` of the specs root (read-only). */
export function readRunFiles(root: string, change: string): { runId?: string; state?: string; metrics?: string; ledger?: string } {
  const base = runsDir(root, change);
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
 * Data the change dashboard and the roadmap need from the verifier. Loaded in the background (the page shows
 * a loading state first and is re-rendered when an answer arrives); answers are kept for a few seconds.
 */
export class PanelData {
  private readonly cache = new Map<string, { at: number; value: unknown }>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly store: ProjectStore;
  private readonly client: VerifierClient;
  onReady: () => void = () => {};

  constructor(store: ProjectStore, client: VerifierClient) {
    this.store = store;
    this.client = client;
  }

  invalidate(): void {
    this.cache.clear();
  }

  private get<T>(key: string, load: () => Promise<T>): T | undefined {
    const hit = this.cache.get(key);
    const fresh = hit && Date.now() - hit.at < TTL_MS;
    if (!fresh && !this.inflight.has(key)) {
      const loading = load()
        .then((value) => void this.cache.set(key, { at: Date.now(), value }))
        .catch(() => void this.cache.delete(key))
        .finally(() => {
          this.inflight.delete(key);
          this.onReady();
        });
      this.inflight.set(key, loading);
    }
    return hit?.value as T | undefined;
  }

  /** Waits for the loads in flight, at most `ms`: the first render of a change page then has its sync state, so the
   * next step (Sync or Archive) shows without a "Checking..." flash. */
  async settled(ms: number): Promise<void> {
    await Promise.race([Promise.allSettled([...this.inflight.values()]), new Promise((r) => setTimeout(r, ms).unref?.())]);
  }

  roadmap(root: string | undefined): RoadmapState {
    const p = this.store.projects.find((x) => !x.error && (root === undefined || x.root === root));
    if (!p) return { status: 'unavailable', reason: 'No Wingman Spec project is open.' };
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

  /** Runs a CLI action; the cached verifier answers are dropped, since sync and archive change them. */
  async runAction(root: string, action: CliAction, change?: string): Promise<ActionResult> {
    const p = this.store.projects.find((x) => x.root === root);
    const r = p ? await this.client.action(p, action, change) : { ok: false as const, reason: 'the project is not open' };
    this.invalidate();
    return r.ok ? r.value : { action, ...(change ? { change } : {}), ok: false, summary: `Not run: ${r.reason}.`, lines: [] };
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
}
