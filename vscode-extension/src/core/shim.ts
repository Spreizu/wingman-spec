import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type ShimResult = 'current' | 'created' | 'replaced' | 'none';

const real = (p: string): string => {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
};

/**
 * Points `<folder>/.wingman-spec/bin/wingman-spec` at exe, the CLI bundled with the extension: a symlink, or a `.cmd`
 * file on Windows (the same shim `wingman-spec init` writes). A folder without `.wingman-spec/` gets nothing ('none');
 * a shim that already runs exe is left alone. The shim is per clone and gitignored.
 */
export function ensureShim(folder: string, exe: string, platform: string = process.platform): ShimResult {
  if (!statSync(join(folder, '.wingman-spec'), { throwIfNoEntry: false })?.isDirectory()) return 'none';
  const target = real(exe);
  const p = join(folder, '.wingman-spec', 'bin', 'wingman-spec');
  if (platform === 'win32') {
    const text = `@"${target}" %*\r\n`;
    const had = existsSync(p + '.cmd');
    if (had && readFileSync(p + '.cmd', 'utf8') === text) return 'current';
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p + '.cmd', text);
    return had ? 'replaced' : 'created';
  }
  const st = lstatSync(p, { throwIfNoEntry: false });
  if (st?.isSymbolicLink() && existsSync(p) && real(resolve(dirname(p), readlinkSync(p))) === target) return 'current';
  if (st) rmSync(p, { force: true });
  mkdirSync(dirname(p), { recursive: true });
  symlinkSync(target, p);
  return st ? 'replaced' : 'created';
}
