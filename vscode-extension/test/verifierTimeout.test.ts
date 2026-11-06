// Read-only CLI calls use verifierTimeoutSeconds (default 120); Archive and Sync wait at least 300s.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import './support/installStub.mjs';
import { fakeBundle } from './support/bundle.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const stub = await import('./support/vscodeStub.mjs');
const { host } = stub;
const { VerifierClient } = await import('../src/editor/verifier.ts');
import type { Runner } from '../src/editor/verifier.ts';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'ws-to-'));

test('problems uses verifierTimeoutSeconds; archive and sync use at least 300s', async () => {
  host.reset();
  host.trusted = true;
  const calls: { args: string[]; timeoutMs: number }[] = [];
  const run: Runner = async (_cmd, args, opts) => {
    calls.push({ args, timeoutMs: opts.timeoutMs });
    return { code: 0, stdout: '{"ok":true,"findings":[],"notes":[]}', stderr: '', timedOut: false };
  };
  const old = process.env['WINGMAN_SPEC_BIN'];
  delete process.env['WINGMAN_SPEC_BIN'];
  try {
    const client = new VerifierClient(run, fakeBundle());
    const p = { root: tmp(), workspaceFolder: tmp() } as Parameters<InstanceType<typeof VerifierClient>['problems']>[0];
    await client.problems(p, 'demo');
    await client.action(p, 'archive', 'demo');
    await client.action(p, 'sync', 'demo');
    await client.action(p, 'validate', 'demo');
    assert.equal(calls[0]?.timeoutMs, 120_000, 'problems default');
    assert.equal(calls[1]?.timeoutMs, 300_000, 'archive floor');
    assert.equal(calls[2]?.timeoutMs, 300_000, 'sync floor');
    assert.equal(calls[3]?.timeoutMs, 120_000, 'validate stays read-only');

    host.settings['wingmanSpec.verifierTimeoutSeconds'] = 400;
    calls.length = 0;
    await client.problems(p);
    await client.action(p, 'archive', 'demo');
    assert.equal(calls[0]?.timeoutMs, 400_000, 'problems respects a higher setting');
    assert.equal(calls[1]?.timeoutMs, 400_000, 'archive uses max(setting, 300)');
  } finally {
    if (old !== undefined) process.env['WINGMAN_SPEC_BIN'] = old;
    host.reset();
  }
});

test('a timed-out archive names the longer wait, not only the setting', async () => {
  host.reset();
  host.trusted = true;
  const run: Runner = async () => ({ code: null, stdout: '', stderr: '', timedOut: true });
  const old = process.env['WINGMAN_SPEC_BIN'];
  delete process.env['WINGMAN_SPEC_BIN'];
  try {
    const client = new VerifierClient(run, fakeBundle());
    const p = { root: tmp(), workspaceFolder: tmp() } as Parameters<InstanceType<typeof VerifierClient>['action']>[0];
    const archive = await client.action(p, 'archive', 'demo');
    assert.equal(archive.ok, false);
    if (!archive.ok) {
      assert.match(archive.reason, /within 300s/);
      assert.match(archive.reason, /Archive and Sync allow longer/);
    }
    const problems = await client.problems(p);
    assert.equal(problems.ok, false);
    if (!problems.ok) {
      assert.match(problems.reason, /within 120s \(wingmanSpec\.verifierTimeoutSeconds\)/);
    }
  } finally {
    if (old !== undefined) process.env['WINGMAN_SPEC_BIN'] = old;
    host.reset();
  }
});
