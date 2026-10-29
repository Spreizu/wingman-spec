import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { parseArchiveName, scanArchive } from '../src/model/archiveScanner.ts';
import { layoutAdrGraph, NODE_H } from '../src/model/adrLayout.ts';
import { buildAgentPrompt, checkPrompt, setupStatus } from '../src/model/specGuard.ts';
import type { RootAdr } from '../src/model/types.ts';

function adr(number: string, supersedes = ''): RootAdr {
  return { number, slug: `s${number}`, path: `/adr/${number}.md`, title: `T${number}`, status: 'Accepted', date: '', change: '', source: '', supersedes, body: '', fields: {} };
}

test('graph: chains go left to right, branches stack, unlinked ADRs are standalone', () => {
  const g = layoutAdrGraph([adr('0001'), adr('0002', '0001'), adr('0003', '0002'), adr('0004', '0002'), adr('0005')]);
  const at = (n: string) => g.nodes.find((x) => x.adr.number === n);
  assert.deepEqual(g.standalone.map((a) => a.number), ['0005']);
  assert.ok((at('0002')?.x ?? 0) > (at('0001')?.x ?? 99));
  assert.ok((at('0003')?.x ?? 0) > (at('0002')?.x ?? 99));
  assert.equal(at('0003')?.x, at('0004')?.x);
  assert.ok(Math.abs((at('0003')?.y ?? 0) - (at('0004')?.y ?? 0)) >= NODE_H);
  assert.equal(g.edges.length, 3);
  assert.ok(g.width > 0 && g.height > 0);
});

test('graph: separate chains do not overlap and cycles terminate', () => {
  const g = layoutAdrGraph([adr('0001'), adr('0002', '0001'), adr('0003'), adr('0004', '0003')]);
  const ys = g.nodes.map((n) => `${n.x},${n.y}`);
  assert.equal(new Set(ys).size, ys.length);
  const cyc = layoutAdrGraph([adr('0001', '0002'), adr('0002', '0001')]);
  assert.equal(cyc.nodes.length, 2);
});

const tmp = mkdtempSync(join(tmpdir(), 'wingman-arch-'));
after(() => rmSync(tmp, { recursive: true, force: true }));
function put(rel: string, text: string): void {
  const p = join(tmp, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}

test('archive scanner reads dated folders newest first with counts, specs and ADRs', async () => {
  put('openspec/changes/archive/2026-09-01-old/tasks.md', '## 1. G\n\n- [x] 1.1 a\n- [x] 1.2 b\n');
  put('openspec/changes/archive/2026-10-02-add-auth/proposal.md', '# P');
  put('openspec/changes/archive/2026-10-02-add-auth/specs/auth/spec.md', 'x');
  put('openspec/changes/archive/2026-10-02-add-auth/adrs/use-jwt.md', '---\ntitle: Use JWT\nstatus: Accepted\n---\nbody');
  put('openspec/changes/archive/undated/tasks.md', '- [ ] 1.1 a\n');
  const list = await scanArchive(tmp);
  assert.deepEqual(list.map((c) => c.dirName), ['undated', '2026-10-02-add-auth', '2026-09-01-old']);
  const auth = list.find((c) => c.name === 'add-auth');
  assert.equal(auth?.date, '2026-10-02');
  assert.deepEqual(auth?.capabilities, ['auth']);
  assert.equal(auth?.adrs[0]?.title, 'Use JWT');
  assert.equal(auth?.hasProposal, true);
  assert.equal(list.find((c) => c.name === 'old')?.taskDone, 2);
  assert.deepEqual(parseArchiveName('undated'), { date: '', name: 'undated' });
  assert.deepEqual(await scanArchive(join(tmp, 'nope')), []);
});

test('spec-guard reuse: prompts run through the hook rules', () => {
  const root = join(tmp, 'ws');
  put('ws/.cursor/commands/spec-apply.md', 'x');
  assert.deepEqual(checkPrompt('/spec-apply demo', [root]), { ok: true });
  assert.equal(buildAgentPrompt('sync', 'demo', ['--check']), '/spec-sync demo --check');
  assert.equal(checkPrompt('/opsx:apply demo', [root]).ok, false);
  assert.equal(checkPrompt('/spec-apply demo\nrm -rf /', [root]).ok, false);
  assert.equal(checkPrompt('hello', [root]).ok, false);
});

test('spec-guard reuse: the hook file itself exports the rules the extension uses', () => {
  const hook = readFileSync(resolve(import.meta.dirname, '../../project-template/hooks/spec-guard.cjs'), 'utf8');
  assert.ok(hook.includes('require.main === module'));
  put('ws2/.cursor/commands/spec-apply.md', 'x');
  put('ws2/.cursor/hooks.json', '{"hooks":{"beforeSubmitPrompt":[{"command":"node .cursor/hooks/spec-guard.cjs"}]}}');
  const status = setupStatus([join(tmp, 'ws2')]);
  assert.equal(status.hook, true);
  assert.equal(status.commands, false);
  assert.deepEqual(status.missing, ['spec-explore', 'spec-propose', 'spec-fix', 'spec-sync', 'spec-archive']);
});
