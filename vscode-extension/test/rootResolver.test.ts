import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { loadProjects, resolveRoot } from '../src/model/rootResolver.ts';
import type { ExecFn } from '../src/model/rootResolver.ts';

const tmp = mkdtempSync(join(tmpdir(), 'wingman-root-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function put(rel: string, text = 'x'): void {
  const path = join(tmp, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function contextOutput(root: string, storeId = 'acme'): string {
  return JSON.stringify({ root: { path: root, source: 'declared', store_id: storeId, role: 'openspec_root' }, members: [] });
}

function fakeExec(output: string | Error): { exec: ExecFn; calls: string[][] } {
  const calls: string[][] = [];
  const exec: ExecFn = async (args) => {
    calls.push(args);
    if (output instanceof Error) throw output;
    return output;
  };
  return { exec, calls };
}

test('no openspec/config.yaml means not a project', async () => {
  const { exec } = fakeExec('');
  assert.equal(await resolveRoot(join(tmp, 'empty'), exec), undefined);
});

test('next to code: a real root wins and the CLI is not called', async () => {
  put('local/openspec/config.yaml', 'schema: wingman-spec\n');
  put('local/openspec/changes/a/proposal.md');
  const { exec, calls } = fakeExec('');
  const r = await resolveRoot(join(tmp, 'local'), exec);
  assert.deepEqual(r, { workspaceFolder: join(tmp, 'local'), root: join(tmp, 'local'), source: 'local' });
  assert.equal(calls.length, 0);
});

test('a store pointer is ignored when the folder is itself a real root', async () => {
  put('both/openspec/config.yaml', 'store: acme\n');
  put('both/openspec/specs/x/spec.md');
  const { exec, calls } = fakeExec(contextOutput('/elsewhere'));
  assert.equal((await resolveRoot(join(tmp, 'both'), exec))?.source, 'local');
  assert.equal(calls.length, 0);
});

test('config-only folder without a pointer is a fresh local root', async () => {
  put('fresh/openspec/config.yaml', 'schema: wingman-spec\n');
  const { exec, calls } = fakeExec('');
  assert.equal((await resolveRoot(join(tmp, 'fresh'), exec))?.source, 'local');
  assert.equal(calls.length, 0);
});

test('workspace: a config-only pointer asks the CLI for the store root', async () => {
  put('code/openspec/config.yaml', '# pointer\nstore: acme\n');
  const { exec, calls } = fakeExec('Note: usage stats\n' + contextOutput('/stores/acme'));
  const r = await resolveRoot(join(tmp, 'code'), exec);
  assert.equal(r?.source, 'store');
  assert.equal(r?.root, '/stores/acme');
  assert.equal(r?.storeId, 'acme');
  assert.equal(r?.error, undefined);
  assert.deepEqual(calls, [['context', '--json']]);
});

test('missing CLI is reported as an actionable error, not a crash', async () => {
  const err = Object.assign(new Error('spawn openspec ENOENT'), { code: 'ENOENT' });
  const r = await resolveRoot(join(tmp, 'code'), fakeExec(err).exec);
  assert.equal(r?.source, 'store');
  assert.match(r?.error ?? '', /openspec CLI was not found/);
  assert.match(r?.error ?? '', /wingmanSpec\.openspecPath/);
});

test('unreadable CLI output is an error', async () => {
  const r = await resolveRoot(join(tmp, 'code'), fakeExec('not json').exec);
  assert.ok(r?.error);
});

test('loadProjects scans the store for a pointer folder', async () => {
  const store = join(tmp, 'store-a');
  put('store-a/openspec/config.yaml', 'schema: wingman-spec\n');
  put('store-a/openspec/changes/demo/tasks.md', '## 1. G\n- [ ] 1.1 a\n');
  put('store-a/adr/0001-x.md', '---\ntitle: X\nstatus: Accepted\n---\nbody\n');
  const projects = await loadProjects([join(tmp, 'code')], 'adr', fakeExec(contextOutput(store)).exec);
  assert.equal(projects.length, 1);
  const p = projects[0];
  assert.equal(p?.source, 'store');
  assert.equal(p?.storeId, 'acme');
  assert.equal(p?.workspaceFolder, join(tmp, 'code'));
  assert.equal(p?.root, store);
  assert.deepEqual(p?.changes.map((c) => c.name), ['demo']);
  assert.equal(p?.adrs.length, 1);
});

test('loadProjects lists a root once when the code repo and its store are both open', async () => {
  const store = join(tmp, 'store-a');
  const projects = await loadProjects(
    [join(tmp, 'code'), store],
    'adr',
    fakeExec(contextOutput(store)).exec,
  );
  assert.equal(projects.length, 1);
  // Listed once, labelled by the folder that really contains the root (the store folder).
  assert.equal(projects[0]?.source, 'local');
  assert.equal(projects[0]?.workspaceFolder, store);
});

test('loadProjects handles a mix: local project, store project, unresolved pointer', async () => {
  put('broken/openspec/config.yaml', 'store: ghost\n');
  const store = join(tmp, 'store-a');
  const exec: ExecFn = async (_args, cwd) => {
    if (cwd === join(tmp, 'broken')) throw new Error('Unknown store ghost');
    return contextOutput(store);
  };
  const projects = await loadProjects([join(tmp, 'local'), join(tmp, 'code'), join(tmp, 'broken')], 'adr', exec);
  assert.deepEqual(projects.map((p) => p.source), ['local', 'store', 'store']);
  assert.equal(projects[2]?.changes.length, 0);
  assert.match(projects[2]?.error ?? '', /ghost/);
});

// --- workspace layout: code and specs are separate git repos linked by openspec/workspace.yaml ---

function setupLinked(): { code: string; specs: string } {
  put('ws/specs-repo/openspec/config.yaml', 'schema: wingman-spec\n');
  put('ws/specs-repo/openspec/changes/demo/tasks.md', '## 1. G\n- [ ] 1.1 a\n');
  put('ws/specs-repo/adr/0001-x.md', '---\ntitle: X\nstatus: Accepted\n---\nbody\n');
  put('ws/code-repo/openspec/workspace.yaml', '# link\nspecs: ../specs-repo\n');
  return { code: join(tmp, 'ws/code-repo'), specs: join(tmp, 'ws/specs-repo') };
}

test('linked: workspace.yaml resolves a relative specs path without calling the CLI', async () => {
  const { code, specs } = setupLinked();
  const { exec, calls } = fakeExec('');
  const r = await resolveRoot(code, exec);
  assert.equal(r?.source, 'linked');
  assert.equal(r?.root, specs);
  assert.equal(r?.error, undefined);
  assert.equal(calls.length, 0);
});

test('linked: an absolute specs path and quotes are accepted', async () => {
  const { code, specs } = setupLinked();
  put('ws/code-abs/openspec/workspace.yaml', `specs: "${specs}"  # absolute\n`);
  const r = await resolveRoot(join(tmp, 'ws/code-abs'), fakeExec('').exec);
  assert.equal(r?.root, specs);
  assert.ok(code);
});

test('linked: a missing specs repo is an actionable error', async () => {
  put('ws/code-missing/openspec/workspace.yaml', 'specs: ../not-cloned-yet\n');
  const r = await resolveRoot(join(tmp, 'ws/code-missing'), fakeExec('').exec);
  assert.equal(r?.source, 'linked');
  assert.match(r?.error ?? '', /Specs repository not found/);
});

test('linked: specs next to the code win over a link', async () => {
  setupLinked();
  put('ws/code-both/openspec/config.yaml', 'schema: wingman-spec\n');
  put('ws/code-both/openspec/changes/a/proposal.md');
  put('ws/code-both/openspec/workspace.yaml', 'specs: ../specs-repo\n');
  assert.equal((await resolveRoot(join(tmp, 'ws/code-both'), fakeExec('').exec))?.source, 'local');
});

test('linked: loadProjects reads changes and ADRs from the specs repo', async () => {
  const { code, specs } = setupLinked();
  const [p, ...rest] = await loadProjects([code], 'adr', fakeExec('').exec);
  assert.equal(rest.length, 0);
  assert.equal(p?.source, 'linked');
  assert.equal(p?.workspaceFolder, code);
  assert.equal(p?.root, specs);
  assert.deepEqual(p?.changes.map((c) => c.name), ['demo']);
  assert.equal(p?.adrs.length, 1);
});

test('linked: code and specs folders open together list the specs once, labelled by the specs folder', async () => {
  const { code, specs } = setupLinked();
  for (const order of [[code, specs], [specs, code]]) {
    const projects = await loadProjects(order, 'adr', fakeExec('').exec);
    assert.equal(projects.length, 1, order.join(' + '));
    assert.equal(projects[0]?.source, 'local');
    assert.equal(projects[0]?.workspaceFolder, specs);
  }
});

test('linked: a plain code folder with no openspec files is ignored', async () => {
  const { specs } = setupLinked();
  put('ws/plain-code/src/index.ts');
  const projects = await loadProjects([join(tmp, 'ws/plain-code'), specs], 'adr', fakeExec('').exec);
  assert.equal(projects.length, 1);
  assert.equal(projects[0]?.workspaceFolder, specs);
});
