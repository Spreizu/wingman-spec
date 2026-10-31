import { join } from 'node:path';
import * as vscode from 'vscode';
import { ensureShim } from '../core/shim.ts';
import { SHIM } from '../core/paths.ts';
import { execRunner } from './verifier.ts';
import type { Runner, VerifierClient } from './verifier.ts';

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
 * Keeps every trusted workspace folder with `.wingman-spec/` running the bundled CLI: its shim is (re)created silently with a
 * line in the output channel (also after an extension update, whose install path differs). Generated agent files older than
 * the bundled CLI get one notification per folder offering `wingman-spec update`, never an automatic rewrite of committed files.
 */
export function registerCliSetup(verifier: VerifierClient, run: Runner = execRunner): vscode.Disposable {
  const out = vscode.window.createOutputChannel('Wingman Spec');
  const checked = new Set<string>();
  const offerUpdate = async (folder: string, exe: string): Promise<void> => {
    const r = await run(exe, ['update', '--check', '--json'], { cwd: folder, timeoutMs: 30000 });
    const stale = parseStale(r.stdout);
    if (stale.length === 0) return;
    const pick = await vscode.window.showInformationMessage(
      `Wingman Spec: ${stale.length} generated agent file(s) in ${folder} are older than the bundled CLI.`,
      'Run update',
    );
    if (pick !== 'Run update') return;
    const u = await run(exe, ['update'], { cwd: folder, timeoutMs: 120000 });
    out.appendLine(`wingman-spec update in ${folder} (exit ${u.code ?? 'none'}):`);
    out.append(u.stdout + u.stderr);
    if (u.code === 0) void vscode.window.showInformationMessage('Wingman Spec: agent files updated. Review and commit them.');
    else out.show(true);
  };
  const sync = (): void => {
    if (!vscode.workspace.isTrusted) return;
    const exe = verifier.bin();
    if (!exe) return;
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      const folder = f.uri.fsPath;
      try {
        const r = ensureShim(folder, exe);
        if (r === 'none') continue;
        if (r !== 'current') out.appendLine(`${r === 'created' ? 'Created' : 'Updated'} ${join(folder, SHIM)} -> ${exe}`);
      } catch (e) {
        out.appendLine(`Could not write ${join(folder, SHIM)}: ${(e as Error).message}`);
        continue;
      }
      if (!checked.has(folder)) {
        checked.add(folder);
        void offerUpdate(folder, exe);
      }
    }
  };
  /** `wingman-spec init --harness all` with the bundled CLI in a chosen folder: how a project gets set up without a separate install. */
  const init = async (): Promise<void> => {
    const exe = verifier.bin();
    if (!exe || !vscode.workspace.isTrusted) return void vscode.window.showWarningMessage('Wingman Spec: needs a trusted workspace and the bundled CLI.');
    const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const folder = folders.length > 1 ? await vscode.window.showQuickPick(folders, { placeHolder: 'Folder to set up' }) : folders[0];
    if (!folder) return;
    const kinds = [
      { label: 'Specs next to the code', args: [] as string[] },
      { label: 'Specs repository', args: ['--layout', 'specs'] },
      { label: 'Code repository linked to a specs repository', args: ['--layout', 'link'] },
    ];
    const kind = await vscode.window.showQuickPick(kinds, { placeHolder: 'Layout' });
    if (!kind) return;
    const args = ['init', '--harness', 'all', ...kind.args];
    if (kind.args.includes('link')) {
      const specs = await vscode.window.showInputBox({ prompt: 'The specs repository, relative to this folder', value: '../specs' });
      if (!specs) return;
      args.push('--specs', specs);
    }
    const r = await run(exe, args, { cwd: folder, timeoutMs: 120000 });
    out.appendLine(`wingman-spec ${args.join(' ')} in ${folder} (exit ${r.code ?? 'none'}):`);
    out.append(r.stdout + r.stderr);
    out.show(true);
    checked.add(folder);
    sync();
  };
  sync();
  return vscode.Disposable.from(
    out,
    vscode.commands.registerCommand('wingmanSpec.init', init),
    vscode.workspace.onDidChangeWorkspaceFolders(sync),
    vscode.workspace.onDidGrantWorkspaceTrust(sync),
  );
}
