import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');
const EMOJI = /\p{Extended_Pictographic}|\uFE0F|\u200D/u;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

test('no emoji in sources, tests, package.json or README (codicons only)', () => {
  const targets = [
    ...files(join(root, 'src')),
    ...files(join(root, 'test')),
    join(root, 'package.json'),
    join(root, 'README.md'),
    join(root, 'DEVELOPING.md'),
  ];
  const offenders = targets.filter((f) => EMOJI.test(readFileSync(f, 'utf8')));
  assert.deepEqual(offenders, []);
});
