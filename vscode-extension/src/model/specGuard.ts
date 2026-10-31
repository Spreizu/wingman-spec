import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type AgentCommand = 'explore' | 'propose' | 'apply' | 'fix' | 'sync' | 'archive';

export const AGENT_COMMANDS: AgentCommand[] = ['explore', 'propose', 'apply', 'fix', 'sync', 'archive'];

/** Matches the prompts the extension is willing to send: one /spec-* command and its arguments, single line. */
export const AGENT_PROMPT_RE = /^\/spec-(explore|propose|apply|fix|sync|archive)(?: [^\n]*)?$/;

export function buildAgentPrompt(command: AgentCommand, change?: string, flags: string[] = []): string {
  return ['/spec-' + command, change, ...flags].filter(Boolean).join(' ');
}

export type GuardResult = { ok: true } | { ok: false; message: string };

/** The extension sends only one-line `/spec-*` prompts. */
export function checkPrompt(prompt: string, _roots: string[]): GuardResult {
  return AGENT_PROMPT_RE.test(prompt) ? { ok: true } : { ok: false, message: 'Only /spec-* commands can be sent to the agent from Wingman Spec.' };
}

export interface SetupStatus {
  /** A generated `spec-*` entry point (Cursor or Claude command, Codex skill) present for every command. */
  commands: boolean;
  missing: string[];
}

/** Where `wingman-spec init --harness` writes a command's entry point. */
const ENTRY_POINTS = (r: string, name: string): string[] => [join(r, '.cursor', 'commands', `${name}.md`), join(r, '.claude', 'commands', `${name}.md`), join(r, '.agents', 'skills', name, 'SKILL.md')];

export function setupStatus(roots: string[]): SetupStatus {
  const missing = AGENT_COMMANDS.map((c) => `spec-${c}`).filter((name) => !roots.some((r) => ENTRY_POINTS(r, name).some((f) => existsSync(f))));
  return { commands: missing.length === 0, missing };
}
