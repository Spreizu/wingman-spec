// A stand-in for the extension's bundled `bin/` (the CLI the extension runs); the tests' fake runner never starts it.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function fakeBundle(): string {
  const bin = join(mkdtempSync(join(tmpdir(), 'bundle-')), 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, process.platform === 'win32' ? 'wingman-spec.exe' : 'wingman-spec'), '# stand-in\n');
  return bin;
}
