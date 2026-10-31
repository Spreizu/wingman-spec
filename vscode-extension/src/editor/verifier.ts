import { execFile } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync } from 'node:fs';
import { join } from 'node:path';
import { cli } from '../core/paths.ts';
import * as vscode from 'vscode';
import { parseRoadmap } from '../model/roadmap.ts';
import type { RoadmapReport } from '../model/roadmap.ts';
import { parseGuard, parseProblems, parseSyncCheck } from '../model/verifier.ts';
import type { ProblemsReport, SyncCheckReport, VerifierFinding } from '../model/verifier.ts';
import { actionArgs, readAction } from '../model/cliActions.ts';
import type { ActionResult, CliAction } from '../model/cliActions.ts';
import type { ProjectModel } from '../model/types.ts';

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** The process could not be started (for example `node` is not on the PATH). */
  spawnError?: string;
}

export type Runner = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number; env?: Record<string, string> }) => Promise<RunResult>;

export const execRunner: Runner = (cmd, args, opts) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd: opts.cwd, ...(opts.env ? { env: { ...process.env, ...opts.env } } : {}), timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
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
 * The CLI the extension runs: the copy bundled in its `bin/`, never one installed elsewhere. `WINGMAN_SPEC_BIN` overrides it
 * for development builds. Undefined when neither exists.
 */
export function findCli(opts: { env?: string; bundledDir?: string; platform?: string }): string | undefined {
  if (opts.env) return opts.env;
  const win = (opts.platform ?? process.platform) === 'win32';
  const bundled = opts.bundledDir ? join(opts.bundledDir, win ? 'wingman-spec.exe' : 'wingman-spec') : undefined;
  return bundled && existsSync(bundled) ? (win ? bundled : executable(bundled)) : undefined;
}

/** The vsix may unpack without the executable bit: set it once so the bundled binary starts. */
function executable(p: string): string {
  try {
    accessSync(p, constants.X_OK);
  } catch {
    try {
      chmodSync(p, 0o755);
    } catch {
      // read-only install folder: the spawn error names the path
    }
  }
  return p;
}

/**
 * Runs the `wingman-spec` CLI (read-only subcommands, a timeout, an untrusted workspace never runs it). The CLI stays the one
 * place the rules live; this only asks it and reads its JSON.
 */
export class VerifierClient {
  private readonly run: Runner;
  private readonly bundledDir: string | undefined;
  constructor(run: Runner = execRunner, bundledDir?: string) {
    this.run = run;
    this.bundledDir = bundledDir;
  }

  /** The bundled CLI (see findCli); the shim in each project points at it. */
  bin(): string | undefined {
    return findCli({ env: process.env['WINGMAN_SPEC_BIN'], bundledDir: this.bundledDir });
  }

  /** The command a person would paste into a terminal for the same call (used by the dashboard). */
  command(p: Pick<ProjectModel, 'root' | 'workspaceFolder'>, args: string[]): string {
    void p;
    return cli(args.join(' '));
  }

  private async call(p: ProjectModel, args: string[]): Promise<Outcome<RunResult>> {
    if (!vscode.workspace.isTrusted) return { ok: false, reason: 'the workspace is not trusted, so the wingman-spec CLI is not run' };
    const timeoutMs = Math.max(1, cfg().get<number>('verifierTimeoutSeconds', 30)) * 1000;
    const bin = this.bin();
    if (!bin) return { ok: false, reason: 'this build of the extension has no bundled wingman-spec CLI; install the build for your platform' };
    const r = await this.run(bin, [...args, '--root', p.root], { cwd: p.workspaceFolder, timeoutMs, env: { WINGMAN_SPEC_SOURCE: 'editor' } });
    if (r.spawnError) return { ok: false, reason: `could not start \`${bin}\` (${r.spawnError}); reinstall the extension` };
    if (r.timedOut) return { ok: false, reason: `the CLI did not answer within ${timeoutMs / 1000}s (wingmanSpec.verifierTimeoutSeconds)` };
    return { ok: true, value: r };
  }

  async problems(p: ProjectModel, change?: string): Promise<Outcome<ProblemsReport>> {
    const r = await this.call(p, ['problems', ...(change ? [change] : []), '--json']);
    if (!r.ok) return r;
    const report = parseProblems(r.value.stdout);
    return report ? { ok: true, value: report } : { ok: false, reason: `the verifier's \`problems\` output was not understood${r.value.stderr ? `: ${r.value.stderr.trim().split('\n')[0]}` : ''} (is the CLI older than this extension? run wingman-spec update)` };
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
    return report ? { ok: true, value: report } : { ok: false, reason: `the verifier's \`roadmap\` output was not understood${r.value.stderr ? `: ${r.value.stderr.trim().split('\n')[0]}` : ''} (is the CLI older than this extension? run wingman-spec update)` };
  }

  async guard(p: ProjectModel, change: string, base: string): Promise<Outcome<VerifierFinding[]>> {
    const r = await this.call(p, ['guard', change, '--base', base, '--json']);
    return r.ok ? { ok: true, value: parseGuard(r.value.stdout, p.workspaceFolder, change) } : r;
  }

  async syncCheck(p: ProjectModel, change: string): Promise<Outcome<SyncCheckReport>> {
    const r = await this.call(p, ['sync', change, '--check', '--json']);
    if (!r.ok) return r;
    const rep = parseSyncCheck(r.value.stdout);
    return rep ? { ok: true, value: rep } : { ok: false, reason: 'the CLI\'s `sync --check` output was not understood' };
  }

  /** `new <change>`: creates the change folder (the user asked for it). */
  async newChange(p: ProjectModel, name: string): Promise<Outcome<string>> {
    const r = await this.call(p, ['new', name]);
    if (!r.ok) return r;
    return r.value.code === 0 ? { ok: true, value: r.value.stdout.trim() } : { ok: false, reason: (r.value.stderr || r.value.stdout).trim().split('\n')[0] ?? 'the change was not created' };
  }

  /** `drift decide <gap-key> --accept --note ...`: the only call that writes (one `Accepted:` line in a spec, which the user asked for). */
  async accept(p: ProjectModel, key: string, note: string): Promise<Outcome<string>> {
    const r = await this.call(p, ['drift', 'decide', key, '--accept', '--note', note]);
    if (!r.ok) return r;
    return r.value.code === 0 ? { ok: true, value: r.value.stdout.trim() } : { ok: false, reason: (r.value.stderr || r.value.stdout).trim().split('\n')[0] ?? 'the acceptance was refused' };
  }

  /** A deterministic action the panel runs directly (`<action> [change] --json`); a refusal with JSON is a result, not an error. */
  async action(p: ProjectModel, action: CliAction, change?: string): Promise<Outcome<ActionResult>> {
    const r = await this.call(p, actionArgs(action, change));
    return r.ok ? { ok: true, value: readAction(action, change, r.value, p.workspaceFolder) } : r;
  }
}
