import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { loadProjects, resolveRoot } from '../src/model/rootResolver.ts';

const tmp = mkdtempSync(join(tmpdir(), 'wingman-root-'));
after(() => rmSync(tmp, { recursive: true, force: true }));

function put(rel: string, text = 'x'): void {
  const path = join(tmp, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

test('a folder without a wingman-spec.yaml is not a project', async () => {
  mkdirSync(join(tmp, 'empty'), { recursive: true });
  assert.equal(await resolveRoot(join(tmp, 'empty')), undefined);
});

test('next to the code: .wingman-spec/ is the specs root', async () => {
  put('local/.wingman-spec/wingman-spec.yaml', 'test_command: npm test\n');
  assert.deepEqual(await resolveRoot(join(tmp, 'local')), { workspaceFolder: join(tmp, 'local'), root: join(tmp, 'local', '.wingman-spec'), source: 'local' });
});

test('a specs repository: wingman-spec.yaml at the folder root', async () => {
  put('specs-only/wingman-spec.yaml', '');
  assert.deepEqual(await resolveRoot(join(tmp, 'specs-only')), { workspaceFolder: join(tmp, 'specs-only'), root: join(tmp, 'specs-only'), source: 'specs-repo' });
});

test('linked: `specs:` resolves a relative path; an absolute path and quotes are accepted', async () => {
  put('ws/specs/wingman-spec.yaml', '');
  put('ws/code/.wingman-spec/wingman-spec.yaml', 'specs: ../specs\n');
  assert.deepEqual(await resolveRoot(join(tmp, 'ws', 'code')), { workspaceFolder: join(tmp, 'ws', 'code'), root: join(tmp, 'ws', 'specs'), source: 'linked' });
  put('abs/.wingman-spec/wingman-spec.yaml', `specs: "${join(tmp, 'ws', 'specs')}"\n`);
  assert.equal((await resolveRoot(join(tmp, 'abs')))?.root, join(tmp, 'ws', 'specs'));
});

test('linked: a missing specs repo is an actionable error', async () => {
  put('lost/.wingman-spec/wingman-spec.yaml', 'specs: ../nowhere\n');
  const r = await resolveRoot(join(tmp, 'lost'));
  assert.equal(r?.source, 'linked');
  assert.match(r?.error ?? '', /Specs repository not found .*Clone it there/);
});

test('linked: loadProjects reads changes and ADRs from the specs repo', async () => {
  put('pair/specs/wingman-spec.yaml', '');
  put('pair/specs/changes/add-x/proposal.md', '# x\n');
  put('pair/specs/adrs/0001-use-x.md', '---\ntitle: Use X\nstatus: accepted\n---\n');
  put('pair/code/.wingman-spec/wingman-spec.yaml', 'specs: ../specs\n');
  const [p] = await loadProjects([join(tmp, 'pair', 'code')]);
  assert.equal(p?.root, join(tmp, 'pair', 'specs'));
  assert.deepEqual(p?.changes.map((c) => c.name), ['add-x']);
  assert.deepEqual(p?.adrs.map((a) => a.number), ['0001']);
});

test('code and specs folders open together list the specs once, labelled by the code folder', async () => {
  const both = await loadProjects([join(tmp, 'pair', 'specs'), join(tmp, 'pair', 'code')]);
  assert.equal(both.length, 1);
  assert.equal(both[0]?.workspaceFolder, join(tmp, 'pair', 'code'));
  assert.equal(both[0]?.source, 'linked');
});

test('loadProjects keeps an unresolved link as an error entry and skips plain folders', async () => {
  mkdirSync(join(tmp, 'plain'), { recursive: true });
  const ps = await loadProjects([join(tmp, 'local'), join(tmp, 'lost'), join(tmp, 'plain')]);
  assert.deepEqual(ps.map((p) => [p.source, p.error !== undefined]), [['local', false], ['linked', true]]);
});
