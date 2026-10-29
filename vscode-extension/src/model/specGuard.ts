import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// The hook that ships in the project template is the single source of truth for which prompts are allowed.
import guard from '../../../project-template/hooks/spec-guard.cjs';

export type AgentCommand = 'explore' | 'propose' | 'apply' | 'fix' | 'sync' | 'archive';

export const AGENT_COMMANDS: AgentCommand[] = ['explore', 'propose', 'apply', 'fix', 'sync', 'archive'];

/** Matches the prompts the extension is willing to send: one /spec-* command and its arguments, single line. */
export const AGENT_PROMPT_RE = /^\/spec-(explore|propose|apply|fix|sync|archive)(?: [^\n]*)?$/;

export function buildAgentPrompt(command: AgentCommand, change?: string, flags: string[] = []): string {
  return ['/spec-' + command, change, ...flags].filter(Boolean).join(' ');
}

export type GuardResult = { ok: true } | { ok: false; message: string };

/** Runs a prompt through the same rules as the beforeSubmitPrompt hook. */
export function checkPrompt(prompt: string, roots: string[]): GuardResult {
  if (!AGENT_PROMPT_RE.test(prompt)) return { ok: false, message: 'Only /spec-* commands can be sent to the agent from Wingman Spec.' };
  const result = guard.evaluate(prompt, roots);
  return result.continue ? { ok: true } : { ok: false, message: result.user_message ?? 'Blocked by spec-guard.' };
}

export interface SetupStatus {
  /** A generated `spec-*` entry point (Cursor or Claude command, Codex skill) present for every command. */
  commands: boolean;
  /** A hook config (Cursor, Claude Code or Codex) registers spec-guard. */
  hook: boolean;
  missing: string[];
}

const HOOK_CONFIGS = [['.cursor', 'hooks.json'], ['.claude', 'settings.json'], ['.codex', 'hooks.json']];

export function setupStatus(roots: string[]): SetupStatus {
  const missing = AGENT_COMMANDS.map((c) => `spec-${c}`).filter((name) => !guard.isInstalled(roots, name));
  const hook = roots.some((r) =>
    HOOK_CONFIGS.some((rel) => {
      const file = join(r, ...rel);
      return existsSync(file) && readFileSync(file, 'utf8').includes('spec-guard.cjs');
    }),
  );
  return { commands: missing.length === 0, hook, missing };
}
