import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { parseRoadmap } from '../model/roadmap.ts';
import type { RoadmapReport } from '../model/roadmap.ts';
import { parseGuard, parseProblems, parseSyncCheck } from '../model/verifier.ts';
import type { ProblemsReport, SyncCheckReport, VerifierFinding } from '../model/verifier.ts';
import type { ProjectModel } from '../model/types.ts';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The process could not be started (for example `node` is not on the PATH). */
  spawnError?: string;
}

export type Runner = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<RunResult>;

export const execRunner: Runner = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
      if (!e) return resolve({ code: 0, stdout, stderr, timedOut: false });
      if (e.killed) return resolve({ code: null, stdout, stderr, timedOut: true });
      if (typeof e.code === 'string') return resolve({ code: null, stdout, stderr, timedOut: false, spawnError: e.message });
      resolve({ code: typeof e.code === 'number' ? e.code : 1, stdout, stderr, timedOut: false });
    });
  });

const cfg = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('wingmanSpec');

export type Outcome<T> = { ok: true; value: T } | { ok: false; reason: string };

/**
 * Runs the project's own `openspec/scripts/verify-task.cjs` (read-only subcommands, a timeout, an untrusted workspace never runs
 * it). The verifier stays the one place the rules live; this only asks it and reads its JSON.
 */
export class VerifierClient {
  private readonly run: Runner;
  constructor(run: Runner = execRunner) {
    this.run = run;
  }

  script(p: Pick<ProjectModel, 'root' | 'workspaceFolder'>): string | undefined {
    return [join(p.workspaceFolder, 'openspec', 'scripts', 'verify-task.cjs'), join(p.root, 'openspec', 'scripts', 'verify-task.cjs')].find((f) => existsSync(f));
  }

  /** The command a person would paste into a terminal for the same call (used by the dashboard). */
  command(p: Pick<ProjectModel, 'root' | 'workspaceFolder'>, args: string[]): string {
    void p;
    return `node openspec/scripts/verify-task.cjs ${args.join(' ')}`.trim();
  }

  private async call(p: ProjectModel, args: string[]): Promise<Outcome<RunResult>> {
    if (!vscode.workspace.isTrusted) return { ok: false, reason: 'the workspace is not trusted, so the verifier script is not run' };
    const script = this.script(p);
    if (!script) return { ok: false, reason: 'openspec/scripts/verify-task.cjs is not installed in this project (run the Wingman Spec installer)' };
    const timeoutMs = Math.max(1, cfg().get<number>('verifierTimeoutSeconds', 30)) * 1000;
    const node = cfg().get<string>('verifierNode', 'node') || 'node';
    const r = await this.run(node, [script, ...args, '--root', p.root], { cwd: p.workspaceFolder, timeoutMs });
    if (r.spawnError) return { ok: false, reason: `could not start \`${node}\` (${r.spawnError}); set wingmanSpec.verifierNode` };
    if (r.timedOut) return { ok: false, reason: `the verifier did not answer within ${timeoutMs / 1000}s (wingmanSpec.verifierTimeoutSeconds)` };
    return { ok: true, value: r };
  }

  async problems(p: ProjectModel, change?: string): Promise<Outcome<ProblemsReport>> {
    const r = await this.call(p, ['problems', ...(change ? [change] : []), '--json']);
    if (!r.ok) return r;
    const report = parseProblems(r.value.stdout);
    return report ? { ok: true, value: report } : { ok: false, reason: `the verifier's \`problems\` output was not understood${r.value.stderr ? `: ${r.value.stderr.trim().split('\n')[0]}` : ''} (is the installed verifier older than this extension? re-run the installer)` };
  }

  /**
   * `roadmap --json` of a new product. The command exits 1 for a plan with errors (the JSON is still printed) and 6 when the
   * project is not a new product (the refusal text is the reason).
   */
  async roadmap(p: ProjectModel): Promise<Outcome<RoadmapReport>> {
    const r = await this.call(p, ['roadmap', '--json']);
    if (!r.ok) return r;
    if (r.value.code === 6) return { ok: false, reason: (r.value.stdout || r.value.stderr).trim().split('\n')[0] ?? 'this project is not a new product' };
    const report = parseRoadmap(r.value.stdout);
    return report ? { ok: true, value: report } : { ok: false, reason: `the verifier's \`roadmap\` output was not understood${r.value.stderr ? `: ${r.value.stderr.trim().split('\n')[0]}` : ''} (is the installed verifier older than this extension? re-run the installer)` };
  }

  async guard(p: ProjectModel, change: string, base: string): Promise<Outcome<VerifierFinding[]>> {
    const r = await this.call(p, ['guard', change, '--base', base]);
    return r.ok ? { ok: true, value: parseGuard(r.value.stdout, p.workspaceFolder, change) } : r;
  }

  async syncCheck(p: ProjectModel, change: string): Promise<Outcome<SyncCheckReport>> {
    const r = await this.call(p, ['sync-check', change]);
    if (!r.ok) return r;
    const rep = parseSyncCheck(r.value.stdout);
    return rep ? { ok: true, value: rep } : { ok: false, reason: 'the verifier\'s `sync-check` output was not understood' };
  }

  /** `drift decide <gap-key> --accept --note ...`: the only call that writes (one `Accepted:` line in a spec, which the user asked for). */
  async accept(p: ProjectModel, key: string, note: string): Promise<Outcome<string>> {
    const r = await this.call(p, ['drift', 'decide', key, '--accept', '--note', note]);
    if (!r.ok) return r;
    return r.value.code === 0 ? { ok: true, value: r.value.stdout.trim() } : { ok: false, reason: (r.value.stderr || r.value.stdout).trim().split('\n')[0] ?? 'the acceptance was refused' };
  }
}
