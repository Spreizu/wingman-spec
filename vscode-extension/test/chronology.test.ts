import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import chrono from '../../project-template/openspec/scripts/chronology.cjs';
import { scanProject } from '../src/model/changeScanner.ts';
import { dashboardCard } from '../src/webview/dashboardView.ts';
import { summarizeRun } from '../src/model/changeDashboard.ts';
import { renderPage } from '../src/webview/render.ts';
import type { Dashboard } from '../src/model/changeDashboard.ts';
import { makeData } from './fixture.ts';

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function project(): { root: string; put: (rel: string, text: string) => void } {
  const root = mkdtempSync(join(tmpdir(), 'wingman-chrono-'));
  dirs.push(root);
  const put = (rel: string, text: string): void => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, text);
  };
  put('openspec/config.yaml', 'schema: wingman-spec\n');
  return { root, put };
}
const local = (h: number, m: number, s: number): string => chrono.isoLocal(new Date(2026, 9, 28, h, m, s));
const names = (r: { archive: { dirName: string }[] }): string => r.archive.map((c) => c.dirName.slice(11)).join();

test('three changes archived on one day sort by the time they were archived, newest first, not by name', async () => {
  const { root, put } = project();
  const a = 'openspec/changes/archive';
  put(`${a}/2026-10-28-mango/tasks.md`, '## 1. A\n\n- [x] 1.1 Done\n');
  put(`${a}/2026-10-28-mango/archived.json`, JSON.stringify({ archived_at: local(9, 15, 0) }));
  put(`${a}/2026-10-28-apple/archived.json`, JSON.stringify({ archived_at: local(16, 40, 5) }));
  put(`${a}/2026-10-28-zebra/archived.json`, JSON.stringify({ archived_at: local(8, 0, 30) }));
  const p = await scanProject(root);
  assert.equal(names(p), 'apple,mango,zebra', 'by name (descending) this would be zebra,mango,apple');
  assert.equal(p.archive[0]?.archived?.source, 'file');
});

test('a legacy archive without the file falls back to the commit time, then the mtime, then the date in its name', async () => {
  const { root, put } = project();
  const a = join(root, 'openspec/changes/archive');
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid', GIT_COMMITTER_DATE: process.env['STAMP'] ?? '' } });
  };
  git('init', '-q');
  put('openspec/changes/archive/2026-10-20-bravo/tasks.md', '## 1. A\n\n- [x] 1.1 Done\n');
  put('openspec/changes/archive/2026-10-20-alpha/tasks.md', '## 1. A\n\n- [x] 1.1 Done\n');
  process.env['STAMP'] = '2026-10-20T08:00:00+02:00';
  git('add', 'openspec/changes/archive/2026-10-20-bravo');
  git('commit', '-qm', 'one');
  process.env['STAMP'] = '2026-10-20T09:30:00+02:00';
  git('add', 'openspec/changes/archive/2026-10-20-alpha');
  git('commit', '-qm', 'two');
  delete process.env['STAMP'];
  put('openspec/changes/archive/2026-10-20-charlie/tasks.md', '## 1. A\n\n- [x] 1.1 Done\n'); // untracked: the mtime
  const old = new Date('2026-10-20T07:00:00+02:00');
  utimesSync(join(a, '2026-10-20-charlie'), old, old);
  const p = await scanProject(root);
  const src = Object.fromEntries(p.archive.map((c) => [c.name, c.archived?.source]));
  assert.deepEqual(src, { alpha: 'git', bravo: 'git', charlie: 'mtime' });
  assert.equal(names(p), 'alpha,bravo,charlie', 'newest first: alpha (09:30), bravo (08:00), charlie (07:00); by name descending it would be charlie,bravo,alpha');
  assert.equal(chrono.archiveStamp(a, '2026-10-20-gone').source, 'name', 'nothing else known: the date in the name');
  assert.equal(chrono.when(chrono.archiveStamp(a, '2026-10-20-gone')), '2026-10-20');
});

test('the time of day is shown next to the date: History card, overview card, archived page, tooltip', async () => {
  const { root, put } = project();
  put('openspec/changes/archive/2026-10-28-shown/tasks.md', '## 1. A\n\n- [x] 1.1 Done\n');
  put('openspec/changes/archive/2026-10-28-shown/archived.json', JSON.stringify({ archived_at: local(14, 3, 22) }));
  put('openspec/changes/archive/2026-10-28-dated/tasks.md', '## 1. A\n\n- [x] 1.1 Done\n');
  utimesSync(join(root, 'openspec/changes/archive/2026-10-28-dated'), new Date(2026, 9, 28, 6, 5, 4), new Date(2026, 9, 28, 6, 5, 4));
  const html = async (route: Parameters<typeof makeData>[1]): Promise<string> => renderPage(await makeData(root, route), 'NONCE', 'vscode-resource:');
  const history = await html({ page: 'history' });
  assert.match(history, /2026-10-28 14:03:22/);
  assert.match(history, /2026-10-28 06:05:04/, 'a legacy folder shows the time it was found at, with a tooltip that says where it came from');
  assert.match(history, /title="Archived: 2026-10-28 14:03:22 \(recorded when it was archived\)"/);
  assert.match(history, /no record in the folder/);
  assert.ok(history.indexOf('14:03:22') < history.indexOf('06:05:04'), 'newest first');
  assert.match(await html({ page: 'overview' }), /2026-10-28 14:03:22/);
  assert.match(await html({ page: 'archived', root, name: '2026-10-28-shown' }), /2026-10-28 14:03:22/);
});

test('an archive with no time at all shows only the date', async () => {
  const { root, put } = project();
  put('openspec/changes/archive/2026-10-28-bare/tasks.md', '## 1. A\n\n- [x] 1.1 Done\n');
  const p = await scanProject(root);
  assert.ok(p.archive[0]);
  p.archive[0].archived = { at: '', ms: new Date(2026, 9, 28).getTime(), source: 'name' };
  const html = renderPage({ ...(await makeData(root, { page: 'history' })), projects: [p] }, 'NONCE', 'vscode-resource:');
  assert.ok(html.includes('2026-10-28 &middot;') || html.includes('2026-10-28 ·'), 'the date alone');
  assert.ok(!/2026-10-28 \d\d:\d\d:\d\d/.test(html));
});

test('the changes list is ordered by the time each change was created, newest first', async () => {
  const { root, put } = project();
  put('openspec/changes/old-one/.openspec.yaml', `schema: wingman-spec\ncreated_at: ${local(8, 0, 0)}\n`);
  put('openspec/changes/middle/.openspec.yaml', `schema: wingman-spec\ncreated_at: ${local(12, 30, 15)}\n`);
  put('openspec/changes/zz-newest/.openspec.yaml', `schema: wingman-spec\ncreated_at: ${local(18, 45, 59)}\n`);
  const p = await scanProject(root);
  assert.equal(p.changes.map((c) => c.name).join(), 'zz-newest,middle,old-one');
  assert.equal(p.changes[0]?.created?.source, 'file');
  const html = renderPage(await makeData(root, { page: 'overview' }), 'NONCE', 'vscode-resource:');
  assert.match(html, /2026-10-28 18:45:59/);
});

test('verifier records are shown in time order with their time of day, whatever order they were written in', () => {
  const rec = (at: string, event: string, task: string): string => JSON.stringify({ at, event, task, ok: true, attempt: 1 });
  const metrics = [rec('2026-10-28T12:00:00Z', 'check', '1.2'), rec('2026-10-28T10:00:00Z', 'check', '1.1'), rec('2026-10-28T11:00:00Z', 'finish', '1.1')].join('\n');
  const run = summarizeRun({ runId: '20261028T100000Z', metrics, state: '{}' });
  assert.ok(run);
  assert.deepEqual(run.recent.map((e) => e.task + e.event), ['1.1check', '1.1finish', '1.2check']);
  const dash = { tasks: { total: 0, done: 0, verified: 0, rows: [] }, checks: { known: true, passed: 3, failed: 0, exhausted: false, lintErrors: 0, guardFindings: 0, attempts: 1 }, review: { reviewTasksDone: 0, reviewTasksTotal: 0, visual: 'none' }, size: { planned: 0, over: false }, approvals: [], activity: run.recent, blocking: [], notes: [] } as Dashboard;
  const html = dashboardCard(dash, false);
  assert.match(html, /Recent verifier activity/);
  const clocks = [...html.matchAll(/>(\d\d:\d\d:\d\d)</g)].map((m) => m[1]);
  assert.equal(clocks.length, 3);
  assert.equal(clocks.join(), [10, 11, 12].map((h) => chrono.clock(Date.UTC(2026, 9, 28, h, 0, 0))).join());
  assert.equal(chrono.latestRun(['20261028T100000Z', '20261028T090000Z', '20261027T235959Z']), '20261028T100000Z');
});
