import { basename, join } from 'node:path';
import { SHIM } from '../core/paths.ts';
import type { Runner } from './verifier.ts';

/** One folder whose generated agent files (commands, skills, subagents, AGENTS.md block) `wingman-spec update` would rewrite. */
export interface AgentUpdate {
  folder: string;
  name: string;
  stale: number;
  running: boolean;
  /** The first line of the last failed update; the button stays. */
  error?: string;
}

/** The generated files `wingman-spec update --check --json` reports as older than the CLI ([] when unreadable). */
export function parseStale(stdout: string): string[] {
  try {
    const v = (JSON.parse(stdout) as { stale?: unknown }).stale;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * What runs `update` in a folder: the project's CLI shim, so it is the CLI the project already uses. On Windows the shim is
 * a `.cmd` file that Node does not start without a shell, so its target, the bundled CLI, runs directly.
 */
export const updateBin = (folder: string, exe: string, platform: string = process.platform): string => (platform === 'win32' ? exe : join(folder, SHIM));

/**
 * Which folders have generated agent files older than the bundled CLI, and running `update` for one. The check is
 * `update --check --json` (nothing written); `update` rewrites only the files Wingman Spec generated. `changed` fires on
 * every state change, so the panel header shows, disables or hides its Update button.
 */
export class AgentFiles {
  private readonly state = new Map<string, AgentUpdate>();
  private readonly run: Runner;
  private readonly changed: () => void;
  private readonly log: (text: string) => void;
  private readonly bin: (folder: string) => string;
  constructor(run: Runner, changed: () => void = () => {}, log: (text: string) => void = () => {}, bin: (folder: string) => string = (folder) => join(folder, SHIM)) {
    this.run = run;
    this.changed = changed;
    this.log = log;
    this.bin = bin;
  }

  list(): AgentUpdate[] {
    return [...this.state.values()].filter((u) => u.stale > 0 || u.running);
  }

  async check(folder: string): Promise<void> {
    const r = await this.run(this.bin(folder), ['update', '--check', '--json'], { cwd: folder, timeoutMs: 30000 });
    const stale = r.code === 0 ? parseStale(r.stdout).length : 0;
    const cur = this.state.get(folder);
    this.state.set(folder, { folder, name: basename(folder), stale, running: cur?.running ?? false, ...(cur?.error ? { error: cur.error } : {}) });
    this.changed();
  }

  /** Runs `update` in a folder with stale files, one at a time per folder, then checks again (the button hides when current). */
  async update(folder: string): Promise<boolean> {
    const cur = this.state.get(folder);
    if (!cur || cur.running || cur.stale === 0) return false;
    const { error: _old, ...rest } = cur;
    this.state.set(folder, { ...rest, running: true });
    this.changed();
    const u = await this.run(this.bin(folder), ['update'], { cwd: folder, timeoutMs: 120000 });
    this.log(`wingman-spec update in ${folder} (exit ${u.code ?? 'none'}):\n${u.stdout}${u.stderr}`);
    const after = this.state.get(folder) ?? cur;
    const error = u.code === 0 ? undefined : (u.stderr || u.stdout || u.spawnError || 'update failed').trim().split('\n')[0];
    this.state.set(folder, { ...after, running: false, ...(error ? { error } : {}) });
    await this.check(folder);
    return u.code === 0;
  }
}
