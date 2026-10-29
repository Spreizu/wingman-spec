// The read-only roadmap view of a new product: parsing the verifier's JSON, asking the verifier, and the page.
import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { after, test } from 'node:test';
import './support/installStub.mjs';
import { makeData, makeFixture } from './fixture.ts';

const stub = await import('./support/vscodeStub.mjs');
const { TraceCache } = await import('../src/editor/anchorCode.ts');
const { PanelData } = await import('../src/editor/panelData.ts');
const { VerifierClient } = await import('../src/editor/verifier.ts');
const { parseRoadmap, orderedSlices, blockers } = await import('../src/model/roadmap.ts');
const { renderPage } = await import('../src/webview/render.ts');

const fx = makeFixture();
after(() => rmSync(fx, { recursive: true, force: true }));
const JSON_OUT = readFileSync(new URL('./fixtures/roadmap.json', import.meta.url), 'utf8');
const ok = (stdout: string, code = 0) => async () => ({ code, stdout, stderr: '', timedOut: false });
const proj = () => ({ root: fx, workspaceFolder: fx, adrs: [], changes: [], error: undefined });

test('parseRoadmap reads slices, order, next up, counts, and coverage', () => {
  const r = parseRoadmap(JSON_OUT);
  assert.ok(r);
  assert.equal(r.ok, true);
  assert.deepEqual(r.order, ['skeleton', 'skip-and-pause', 'delivery', 'notices', 'packing']);
  assert.deepEqual(r.nextUp, ['skeleton']);
  assert.equal(r.counts.planned, 5);
  assert.equal(r.slices.find((s) => s.id === 'skeleton')?.skeleton, true);
  assert.deepEqual(r.slices.find((s) => s.id === 'notices')?.dependsOn, ['delivery']);
  assert.deepEqual(blockers(r, r.slices.find((s) => s.id === 'notices')!), ['delivery']);
  assert.equal(orderedSlices(r)[0]?.id, 'skeleton');
});

test('parseRoadmap is tolerant: junk, missing parts and unknown ids never throw', () => {
  assert.equal(parseRoadmap('not json'), undefined);
  assert.equal(parseRoadmap('{"ok":true}'), undefined);
  const r = parseRoadmap('{"slices":[{"id":"a","status":"weird"},{"title":"no id"},7],"order":["a","ghost"],"next_up":["ghost"],"errors":[{"text":"boom"},{"nothing":1}]}');
  assert.ok(r);
  assert.deepEqual(r.slices.map((s) => [s.id, s.status]), [['a', 'planned']]);
  assert.deepEqual(r.order, ['a']);
  assert.deepEqual(r.nextUp, []);
  assert.deepEqual(r.errors.map((e) => e.text), ['boom']);
});

test('the client asks `roadmap --json --root`, reads the JSON of a plan with errors (exit 1) and reports a refusal (exit 6)', async () => {
  const calls: string[][] = [];
  const mk = (stdout: string, code: number) => new VerifierClient(async (_c, args) => (calls.push(args), { code, stdout, stderr: '', timedOut: false }));
  stub.host.reset();
  const script = `${fx}/openspec/scripts/verify-task.cjs`;
  const { mkdirSync, writeFileSync } = await import('node:fs');
  mkdirSync(`${fx}/openspec/scripts`, { recursive: true });
  writeFileSync(script, '// stand-in\n');
  const good = await mk(JSON_OUT.replace('"ok": true', '"ok": false'), 1).roadmap(proj() as never);
  assert.equal(good.ok, true);
  assert.deepEqual(calls[0], [script, 'roadmap', '--json', '--root', fx]);
  const refused = await mk('REFUSED: roadmap (project mode: brownfield). Nothing was written.\n', 6).roadmap(proj() as never);
  assert.deepEqual(refused, { ok: false, reason: 'REFUSED: roadmap (project mode: brownfield). Nothing was written.' });
  const garbage = await mk('boom', 1).roadmap(proj() as never);
  assert.equal(garbage.ok, false);
});

test('page: slices in order with their state, next up; read-only (only Refresh runs a command)', async () => {
  const roadmap = parseRoadmap(JSON_OUT)!;
  const view = { ...(await makeData(fx, { page: 'roadmap' })), roadmap: { status: 'ready' as const, roadmap }, greenfield: true };
  const html = renderPage(view, 'NONCE', 'vscode-resource:');
  assert.match(html, /Slices in build order/);
  assert.ok(html.indexOf('skeleton') < html.indexOf('skip-and-pause') && html.indexOf('skip-and-pause') < html.indexOf('packing'));
  assert.match(html, /walking skeleton/);
  assert.match(html, /next up/);
  assert.match(html, /waits for delivery/);
  assert.match(html, /contract test: billing/);
  assert.match(html, /0 of 5 slices done/);
  assert.doesNotMatch(html, /requirements covered|plan is valid/, 'a healthy plan shows no pill');
  assert.doesNotMatch(html, /intent/i, 'no intents on the page');
  assert.deepEqual([...new Set([...html.matchAll(/data-cmd="([^"]*)"/g)].map((m) => m[1]))], ['refreshView']);
  assert.ok(!/data-agent=/.test(html), 'the view never sends anything to the agent');
  assert.match(html, /Roadmap<\/span>|>Roadmap</, 'the nav link shows for a new product');
});

test('page: errors, a too-small size and uncovered requirements are shown; text is escaped', async () => {
  const roadmap = parseRoadmap(JSON_OUT)!;
  roadmap.ok = false;
  roadmap.errors = [{ code: 'cycle', slice: null, text: 'cycle: a -> b -> a <script>x</script>' }];
  roadmap.coverage.uncovered = ['billing/refund'];
  roadmap.slices[1]!.size = 'S';
  const view = { ...(await makeData(fx, { page: 'roadmap' })), roadmap: { status: 'ready' as const, roadmap }, greenfield: true };
  const html = renderPage(view, 'NONCE', 'vscode-resource:');
  assert.match(html, /1 plan error/);
  assert.match(html, /size S, needs L/);
  assert.match(html, /billing\/refund/);
  assert.ok(!html.includes('<script>x</script>'));
});

test('page: loading, unavailable and empty states; no roadmap link outside a new product', async () => {
  const base = await makeData(fx, { page: 'roadmap' });
  assert.match(renderPage({ ...base, greenfield: true }, 'N', 'v:'), /Asking the verifier/);
  assert.match(renderPage({ ...base, greenfield: true, roadmap: { status: 'unavailable', reason: 'REFUSED: roadmap (project mode: brownfield).' } }, 'N', 'v:'), /No roadmap to show[\s\S]*brownfield/);
  assert.match(renderPage({ ...base, greenfield: true, roadmap: { status: 'ready', roadmap: parseRoadmap('{"slices":[]}')! } }, 'N', 'v:'), /no slices yet/);
  const overview = renderPage(await makeData(fx, { page: 'overview' }), 'N', 'v:');
  assert.ok(!overview.includes('"page":"roadmap"') && !/>Roadmap</.test(overview));
});

test('PanelData.roadmap loads in the background and re-renders when the verifier answered', async () => {
  const store = { projects: [proj()], onDidChange: () => new stub.Disposable() };
  const data = new PanelData(store as never, new TraceCache(store as never), new VerifierClient(ok(JSON_OUT)));
  const ready = new Promise<void>((r) => (data.onReady = r));
  assert.deepEqual(data.roadmap(fx), { status: 'loading' });
  await ready;
  const st = data.roadmap(fx);
  assert.equal(st.status, 'ready');
  assert.deepEqual(data.roadmap('/nowhere'), { status: 'unavailable', reason: 'No OpenSpec project is open.' });
});
