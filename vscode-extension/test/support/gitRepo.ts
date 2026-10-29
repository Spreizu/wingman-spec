// A real git repository with a billing project on a feature branch (committed, uncommitted and untracked changes).
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { traceProject } from '../trace-fixture.ts';

export const git = (cwd: string, ...args: string[]): string => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
export const put = (dir: string, f: string, text: string): void => {
  mkdirSync(dirname(join(dir, f)), { recursive: true });
  writeFileSync(join(dir, f), text);
};

export function repo(): string {
  const dir = traceProject();
  put(dir, 'openspec/scripts/verify-task.cjs', '// stand-in\n');
  put(dir, 'src/round.py', '# @spec billing/rounding\ndef rnd(x):\n    return x\n');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'checkout', '-q', '-b', 'feature/x');
  put(dir, 'src/round.py', '# @spec billing/rounding\ndef rnd(x):\n    return round(x, 2)\n');
  put(dir, 'tests/add.test.ts', "// @spec billing/add-an-item\nit('refuses [billing/reject-empty]', () => {});\nit('old [billing/gone]', () => {});\nit('other [shipping/x]', () => {});\nit('legacy [legacy/x]', () => {});\nit('removes [billing/remove-it]', () => {});\n");
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'work');
  put(dir, 'src/fresh.ts', '// @spec billing/remove-an-item\nexport function fresh() {\n  return 1;\n}\n');
  return dir;
}

