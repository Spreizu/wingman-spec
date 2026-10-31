// The extension always runs its bundled CLI and keeps each project's shim pointing at it: missing, stale, Windows .cmd,
// multi-root, and the one update offer when generated agent files are older than the CLI.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import './support/installStub.mjs';

const { host, workspace, Uri } = await import('./support/vscodeStub.mjs');
const { findCli, VerifierClient } = await import('../src/editor/verifier.ts');
const { ensureShim } = await import('../src/core/shim.ts');
const { registerCliSetup, parseStale } = await import('../src/editor/cliSetup.ts');
type Runner = import('../src/editor/verifier.ts').Runner;

const tmp = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'findcli-')));
const bundle = (win = false): string => {
  const bin = join(tmp(), 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, win ? 'wingman-spec.exe' : 'wingman-spec'), '');
  return bin;
};
const project = (): string => {
  const d = tmp();
  mkdirSync(join(d, '.wingman-spec'));
  return d;
};
const shim = (d: string): string => join(d, '.wingman-spec', 'bin', 'wingman-spec');
const posix = { skip: process.platform === 'win32' };

test('only the bundled binary runs (WINGMAN_SPEC_BIN overrides it for development); nothing is looked up on the PATH', () => {
  const bin = bundle();
  assert.equal(findCli({ bundledDir: bin, platform: 'linux' }), join(bin, 'wingman-spec'));
  assert.equal(findCli({ env: '/env/ws', bundledDir: bin, platform: 'linux' }), '/env/ws');
  assert.equal(findCli({ bundledDir: join(tmp(), 'bin'), platform: 'linux' }), undefined);
  assert.equal(findCli({ bundledDir: bundle(true), platform: 'win32' })?.endsWith('wingman-spec.exe'), true);
});

test('a bundled binary without the executable bit is made executable', posix, () => {
  const bin = bundle();
  chmodSync(join(bin, 'wingman-spec'), 0o644);
  findCli({ bundledDir: bin, platform: 'linux' });
  assert.equal(statSync(join(bin, 'wingman-spec')).mode & 0o111, 0o111);
});

test('the shim is created when missing, replaced when it points at another or a missing binary, else left alone', posix, () => {
  const exe = join(bundle(), 'wingman-spec');
  const d = project();
  assert.equal(ensureShim(d, exe, 'linux'), 'created');
  assert.equal(readlinkSync(shim(d)), exe);
  assert.equal(ensureShim(d, exe, 'linux'), 'current');
  const old = join(bundle(), 'wingman-spec'); // the previous extension version's install path
  assert.equal(ensureShim(d, old, 'linux'), 'replaced');
  assert.equal(readlinkSync(shim(d)), old);
  const gone = project();
  mkdirSync(join(gone, '.wingman-spec', 'bin'));
  symlinkSync('/nonexistent/wingman-spec', shim(gone));
  assert.equal(ensureShim(gone, exe, 'linux'), 'replaced');
  assert.equal(readlinkSync(shim(gone)), exe);
  const plain = tmp(); // not a Wingman Spec folder
  assert.equal(ensureShim(plain, exe, 'linux'), 'none');
  assert.equal(existsSync(join(plain, '.wingman-spec')), false);
});

test('on Windows the shim is a .cmd file naming the bundled .exe', () => {
  const exe = join(bundle(true), 'wingman-spec.exe');
  const d = project();
  assert.equal(ensureShim(d, exe, 'win32'), 'created');
  assert.equal(readFileSync(shim(d) + '.cmd', 'utf8'), `@"${exe}" %*\r\n`);
  assert.equal(ensureShim(d, exe, 'win32'), 'current');
  writeFileSync(shim(d) + '.cmd', '@"C:\\gone\\wingman-spec.exe" %*\r\n');
  assert.equal(ensureShim(d, exe, 'win32'), 'replaced');
  assert.equal(readFileSync(shim(d) + '.cmd', 'utf8'), `@"${exe}" %*\r\n`);
});

test('every folder of a multi-root workspace with .wingman-spec/ gets the shim; stale agent files get one update offer', posix, async () => {
  host.reset();
  const bin = bundle();
  const exe = join(bin, 'wingman-spec');
  const [code, specs, other] = [project(), project(), tmp()];
  const calls: string[] = [];
  const run: Runner = async (cmd, args, opts) => {
    calls.push(`${opts.cwd}: ${[cmd, ...args].join(' ')}`);
    const stale = opts.cwd === code ? ['.cursor/commands/spec-apply.md'] : [];
    return { code: 0, stdout: args.includes('--check') ? JSON.stringify({ stale }) : 'updated\n', stderr: '', timedOut: false };
  };
  (workspace as { workspaceFolders: unknown[] }).workspaceFolders = [code, specs, other].map((f) => ({ uri: Uri.file(f) }));
  host.infoAnswer = 'Run update';
  const old = process.env['WINGMAN_SPEC_BIN'];
  delete process.env['WINGMAN_SPEC_BIN'];
  try {
    const d = registerCliSetup(new VerifierClient(run, bin), run);
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(readlinkSync(shim(code)), exe);
    assert.equal(lstatSync(shim(specs)).isSymbolicLink(), true);
    assert.equal(existsSync(join(other, '.wingman-spec')), false);
    assert.equal(host.output.filter((l: string) => l.startsWith('Created')).length, 2);
    assert.equal(host.messages.filter((m: string) => m.includes('older than the bundled CLI')).length, 1);
    assert.deepEqual(calls.filter((c) => c.endsWith(' update')), [`${code}: ${exe} update`]);
    d.dispose();
  } finally {
    if (old !== undefined) process.env['WINGMAN_SPEC_BIN'] = old;
    (workspace as { workspaceFolders: unknown[] }).workspaceFolders = [];
  }
});

test('the update check output is read defensively', () => {
  assert.deepEqual(parseStale('{"stale":["a.md",3]}'), ['a.md']);
  assert.deepEqual(parseStale('not json'), []);
});

test('Set Up This Folder runs init with the bundled CLI, then the new project gets its shim', posix, async () => {
  host.reset();
  const bin = bundle();
  const d = tmp();
  const calls: string[][] = [];
  const run: Runner = async (_cmd, args, opts) => {
    calls.push(args);
    if (args[0] === 'init') mkdirSync(join(opts.cwd, '.wingman-spec'));
    return { code: 0, stdout: args.includes('--check') ? '{"stale":[]}' : 'Wrote: ...\n', stderr: '', timedOut: false };
  };
  (workspace as { workspaceFolders: unknown[] }).workspaceFolders = [{ uri: Uri.file(d) }];
  host.quickPickAnswer = (items: unknown[]) => items[1]; // a specs repository
  const old = process.env['WINGMAN_SPEC_BIN'];
  delete process.env['WINGMAN_SPEC_BIN'];
  try {
    const disp = registerCliSetup(new VerifierClient(run, bin), run);
    await host.commands.get('wingmanSpec.init')();
    assert.deepEqual(calls[0], ['init', '--harness', 'all', '--layout', 'specs']);
    assert.equal(readlinkSync(shim(d)), join(bin, 'wingman-spec'));
    disp.dispose();
  } finally {
    if (old !== undefined) process.env['WINGMAN_SPEC_BIN'] = old;
    (workspace as { workspaceFolders: unknown[] }).workspaceFolders = [];
  }
});

test('every CLI call from the editor carries WINGMAN_SPEC_SOURCE=editor, so the timeline shows the buttons', async () => {
  host.reset();
  host.trusted = true;
  const seen: (Record<string, string> | undefined)[] = [];
  const run: Runner = async (_cmd, _args, opts) => {
    seen.push(opts.env);
    return { code: 0, stdout: '{"valid":true,"items":[]}', stderr: '', timedOut: false };
  };
  const old = process.env['WINGMAN_SPEC_BIN'];
  delete process.env['WINGMAN_SPEC_BIN'];
  try {
    const p = { root: tmp(), workspaceFolder: tmp() } as Parameters<InstanceType<typeof VerifierClient>['action']>[0];
    await new VerifierClient(run, bundle()).action(p, 'validate', 'shop');
    assert.deepEqual(seen, [{ WINGMAN_SPEC_SOURCE: 'editor' }]);
  } finally {
    if (old !== undefined) process.env['WINGMAN_SPEC_BIN'] = old;
  }
});
