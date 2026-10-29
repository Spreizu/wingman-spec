// Offline tests of skills/figma-to-code/scripts/figma-fetch.mjs: URL parser, normaliser, facts/token mapping, diff and the
// CLI against a local stub server (no real network, no real token). Run: tests/figma-to-code.sh
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as F from '../skills/figma-to-code/scripts/figma-fetch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '../skills/figma-to-code/scripts/figma-fetch.mjs');
const fx = (n) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures/figma', n), 'utf8'));
const DS = fx('design-system.sample.json');

// ---------------------------------------------------------------- URL parser
test('parse: design/ URL with node-id 12-34', () => {
  const r = F.parseFigmaUrl('https://www.figma.com/design/AbC123xyz/My-App?node-id=12-34&t=zzz-1&m=dev');
  assert.deepEqual([r.fileKey, r.nodeId, r.kind, r.branch, r.name], ['AbC123xyz', '12:34', 'design', false, 'My-App']);
  assert.deepEqual(r.warnings, []);
});
test('parse: legacy file/ URL, encoded colon, no scheme, angle brackets', () => {
  assert.equal(F.parseFigmaUrl('figma.com/file/KEY1/Name?node-id=1%3A2').nodeId, '1:2');
  assert.equal(F.parseFigmaUrl('<https://figma.com/file/KEY1/Name?type=design&node-id=7-8>').nodeId, '7:8');
});
test('parse: branch URL uses the branch key', () => {
  const r = F.parseFigmaUrl('https://www.figma.com/design/MAINKEY/branch/BRANCHKEY/Name?node-id=3-4');
  assert.deepEqual([r.fileKey, r.mainFileKey, r.branch, r.nodeId], ['BRANCHKEY', 'MAINKEY', true, '3:4']);
});
test('parse: proto/ link warns and reads node-id; board/ is FigJam', () => {
  const p = F.parseFigmaUrl('https://www.figma.com/proto/PKEY/Flow?node-id=5-6&starting-point-node-id=9-9');
  assert.equal(p.kind, 'prototype'); assert.equal(p.nodeId, '5:6'); assert.ok(p.warnings.some((w) => /prototype/.test(w)));
  const b = F.parseFigmaUrl('https://www.figma.com/board/BKEY/Diagram?node-id=0-1');
  assert.equal(b.kind, 'figjam'); assert.ok(b.warnings.some((w) => /FigJam/.test(w)));
});
test('parse: nested instance id and embed link', () => {
  assert.equal(F.parseFigmaUrl('https://www.figma.com/design/K/N?node-id=I5666-180910%3B1-10515').nodeId, 'I5666:180910;1:10515');
  const e = F.parseFigmaUrl('https://www.figma.com/embed?embed_host=share&url=' + encodeURIComponent('https://www.figma.com/design/EK/N?node-id=2-3'));
  assert.deepEqual([e.fileKey, e.nodeId], ['EK', '2:3']);
});
test('parse: no node-id warns to ask for a frame link', () => {
  const r = F.parseFigmaUrl('https://www.figma.com/design/K/N');
  assert.equal(r.nodeId, null); assert.ok(r.warnings.some((w) => /node-id/.test(w)));
});
test('parse: bad input throws a clear error', () => {
  for (const bad of ['', 'https://example.com/design/K/N', 'https://www.figma.com/design/', 'https://www.figma.com/community/file/1', 'not a url at all', 'https://www.figma.com/design/K/N?node-id=abc']) {
    assert.throws(() => F.parseFigmaUrl(bad), (e) => e instanceof F.FigmaError && e.code === F.EXIT.USAGE, bad);
  }
});

// ---------------------------------------------------------------- normaliser
test('toHex: opaque, translucent, rounding', () => {
  assert.equal(F.toHex({ r: 1, g: 1, b: 1, a: 1 }), '#ffffff');
  assert.equal(F.toHex({ r: 0.2314, g: 0.3569, b: 0.8588, a: 1 }), '#3b5bdb');
  assert.equal(F.toHex({ r: 0, g: 0, b: 0, a: 0.5 }), '#00000080');
  assert.equal(F.toHex({ r: 1, g: 0, b: 0, a: 1 }, 0.5), '#ff000080');
});
const OVERVIEW = () => F.normalise(fx('account-overview.nodes.json'), { variables: fx('variables.local.json'), nodeId: '2:10', fileKey: 'FK' });
const find = (n, id) => (n.id === id ? n : (n.children || []).map((c) => find(c, id)).find(Boolean));
test('normalise: auto layout becomes flex/gap/padding', () => {
  const n = OVERVIEW(); const card = n.root;
  assert.deepEqual(card.layout, { display: 'flex', direction: 'row', padding: { t: 28, r: 28, b: 28, l: 28 }, justify: 'space-between', align: 'center' });
  assert.equal(card.fill, '#ffffff'); assert.equal(card.radius, 14); assert.deepEqual(card.stroke, { color: '#dde1e8', align: 'inside', weight: 1 });
  assert.equal(card.shadow.length, 2);
  const col = find(card, '2:11'); assert.deepEqual(col.layout, { display: 'flex', direction: 'column', gap: 8 });
  assert.equal(n.source.fileKey, 'FK');
});
test('normalise: text style, colour, named style, line height', () => {
  const t = find(OVERVIEW().root, '2:12');
  assert.equal(t.role, 'text'); assert.equal(t.color, '#3b5bdb');
  assert.deepEqual([t.text.size, t.text.weight, t.text.lineHeight, t.text.family, t.text.chars], [28, 700, 35, 'Inter', 'Northwind Studio']);
  assert.deepEqual(t.styles, { text: 'Heading/Title' });
});
test('normalise: instances carry component, variant and properties (without #id suffix)', () => {
  const b = find(OVERVIEW().root, '2:16');
  assert.deepEqual(b.component, { id: '10:2', name: 'Variant=secondary', set: 'Button', variant: { Variant: 'secondary' }, props: { Label: 'Manage account', Variant: 'secondary' } });
});
test('normalise: variables resolve to names and values; bound ids kept', () => {
  const n = OVERVIEW();
  assert.equal(n.variables['VariableID:1:1'].name, 'color/primary');
  assert.equal(n.variables['VariableID:1:1'].values.Light, '#3b5bdb'); assert.equal(n.variables['VariableID:1:1'].values.Dark, '#7c93f5');
  assert.equal(n.variables['VariableID:1:1'].web, 'var(--color-primary)');
  assert.equal(find(n.root, '2:12').bound.color, 'VariableID:1:1');
});
test('normalise: without variables it warns that names are missing', () => {
  const n = F.normalise(fx('account-overview.nodes.json'), {});
  assert.equal(n.variables, null); assert.ok(n.warnings.some((w) => /bound to Figma variables/.test(w)));
});
test('normalise: hidden layers dropped, no-auto-layout/rotation/mixed text/remote instance warned, positions kept', () => {
  const n = F.normalise(fx('awkward-hero.nodes.json'), {});
  assert.equal(n.stats.hidden, 1);
  assert.ok(!find(n.root, '9:5'));
  const w = n.warnings.join('\n');
  assert.match(w, /Hero.*no auto layout/); assert.match(w, /mixes styles/); assert.match(w, /rotated/); assert.match(w, /Remote widget.*not in the response/);
  assert.equal(n.root.layout.display, 'none');
  assert.deepEqual(find(n.root, '9:2').pos, { x: 40, y: 40 });
  assert.deepEqual(find(n.root, '9:3').constraints, { h: 'LEFT_RIGHT', v: 'BOTTOM' });
  assert.equal(find(n.root, '9:7').role, 'image'); assert.equal(find(n.root, '9:7').image, 'abc123imageref');
  assert.equal(find(n.root, '9:4').fills[0].gradient, 'linear');
});
test('normalise: collapse-instances keeps only the texts; max-depth truncates', () => {
  const n = F.normalise(fx('account-overview.nodes.json'), { collapseInstances: true });
  const b = find(n.root, '2:16'); assert.deepEqual(b.texts, ['Manage account']); assert.equal(b.children, undefined);
  const d = F.normalise(fx('account-overview.nodes.json'), { maxDepth: 1 });
  assert.equal(find(d.root, '2:11').truncated, 2);
});
test('normalise: rejects things that are not a REST response', () => {
  assert.throws(() => F.normalise({ foo: 1 }), /not a Figma REST response/);
});
test('normalise: icon and vector roles for export', () => {
  const n = F.normalise(fx('pricing-section.nodes.json'), {});
  const icon = find(n.root, '3:10901'); assert.equal(icon.role, 'icon');
});

// ---------------------------------------------------------------- facts / token mapping
const FACTS = (extra = {}) => F.buildFacts(OVERVIEW(), { designSystem: DS, ...extra });
const fact = (facts, testid, prop) => facts.entries.find((e) => e.testid === testid).facts.find((x) => x.prop === prop);
test('facts: token first (colour, spacing, radius, size), then framework, arbitrary last', () => {
  const f = FACTS();
  assert.deepEqual([fact(f, 'account-overview', 'padding').via, fact(f, 'account-overview', 'padding').ref, fact(f, 'account-overview', 'padding').expect], ['token', 'spacing-card', 'token:spacing-card']);
  assert.equal(fact(f, 'account-overview', 'border-radius').class, 'rounded-card');
  assert.equal(fact(f, 'account-name', 'color').class, 'text-primary');
  assert.equal(fact(f, 'account-name', 'font-size').class, 'text-title');
  assert.equal(fact(f, 'account-overview', 'box-shadow').ref, 'shadow-card');
  assert.deepEqual([fact(f, 'account-text', 'gap').via, fact(f, 'account-text', 'gap').class], ['framework', 'gap-2']);
  assert.deepEqual([fact(f, 'plan-label', 'font-size').via, fact(f, 'plan-label', 'font-size').class], ['framework', 'text-sm']);
  assert.equal(fact(f, 'account-name', 'font-weight').class, 'font-bold');
});
test('facts: line height comes with the text-size token', () => {
  const lh = fact(FACTS(), 'account-name', 'line-height');
  assert.equal(lh.via, 'token'); assert.equal(lh.ref, 'text-title--line-height'); assert.equal(lh.expect, '35px');
});
test('facts: an off-scale value is arbitrary and says so', () => {
  const n = F.normalise(fx('account-overview.nodes.json'), {});
  n.root.children[0].layout.gap = 13;
  const f = F.buildFacts(n, { designSystem: DS });
  const g = fact(f, 'account-text', 'gap'); assert.deepEqual([g.via, g.class], ['arbitrary', 'gap-[13px]']);
});
test('facts: a variable that names a token but has another value is reported as drift', () => {
  const n = OVERVIEW(); const t = find(n.root, '2:12'); t.color = '#3a5bdb'; t.color = '#4c6ef0'; // brand colour changed in Figma only
  const c = fact(F.buildFacts(n, { designSystem: DS }), 'account-name', 'color');
  assert.equal(c.via, 'token'); assert.match(c.drift, /color-primary/); assert.equal(c.expect, '#4c6ef0');
});
test('facts: no design system -> stock/arbitrary only; --at appends the viewport', () => {
  const f = F.buildFacts(OVERVIEW(), { at: '1280' });
  assert.equal(fact(f, 'plan-label', 'font-size').via, 'framework'); assert.equal(fact(f, 'account-name', 'font-size').via, 'arbitrary'); // 28px is off the stock scale
  assert.equal(F.expectLine('[data-testid="account-name"]', fact(f, 'account-name', 'font-weight')), '[data-testid="account-name"] font-weight = 700 @1280');
});
test('facts: Tailwind 3 vs 4 radius and spacing scales', () => {
  const n = OVERVIEW(); n.root.radius = 4; n.root.layout.padding = { t: 5, r: 5, b: 5, l: 5 };
  const v3 = F.buildFacts(n, { tailwind: 3 }), v4 = F.buildFacts(n, { tailwind: 4 });
  assert.equal(fact(v3, 'account-overview', 'border-radius').class, 'rounded'); assert.equal(fact(v4, 'account-overview', 'border-radius').class, 'rounded-sm');
  assert.equal(fact(v3, 'account-overview', 'padding').via, 'arbitrary'); assert.equal(fact(v4, 'account-overview', 'padding').via, 'arbitrary');
});
test('canonShadow understands rgb(r g b / a) and hex', () => {
  const a = F.canonShadow('0 1px 2px rgb(16 24 40 / 0.06), 0 4px 12px rgb(16 24 40 / 0.06)'), b = F.canonShadow('0px 1px 2px 0px #1018280f, 0px 4px 12px 0px #1018280f');
  assert.equal(a.length, 2); assert.deepEqual(a[1].n, b[1].n);
});

// ---------------------------------------------------------------- diff
test('diff: same / close / changed / unknown, and only changed rows are tasks', () => {
  const facts = FACTS();
  const d = F.diffFacts(facts, { 'account-text': { gap: '4px' }, 'account-name': { 'font-weight': '600', color: 'rgb(27, 31, 42)', 'font-size': '1.75rem', 'line-height': '35.5px' } });
  const st = (t, p) => d.rows.find((r) => r.testid === t && r.prop === p).status;
  assert.equal(st('account-text', 'gap'), 'changed'); assert.equal(st('account-name', 'font-weight'), 'changed'); assert.equal(st('account-name', 'color'), 'changed');
  assert.equal(st('account-name', 'font-size'), 'same'); assert.equal(st('account-name', 'line-height'), 'same');
  assert.equal(st('account-overview', 'padding'), 'unknown');
  assert.equal(d.summary.changed, 3);
  assert.match(F.diffMarkdown(d), /\| gap \| 8px \| 4px \| changed \| gap-2 \|/);
});

// ---------------------------------------------------------------- CLI against a stub server (no real network)
function stub(handler) {
  const hits = [];
  const server = http.createServer((req, res) => { hits.push({ url: req.url, token: req.headers['x-figma-token'], auth: req.headers.authorization }); handler(req, res, hits); });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, hits, base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((x) => server.close(x)) })));
}
const run = (args, env = {}) => new Promise((resolve) => {
  const clean = { ...process.env }; delete clean.FIGMA_TOKEN; delete clean.FIGMA_API_BASE;
  execFile(process.execPath, [CLI, ...args], { env: { ...clean, ...env }, timeout: 30000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
});
const json = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(typeof body === 'string' ? body : JSON.stringify(body)); };
const URL1 = 'https://www.figma.com/design/FILEKEY1/Acme?node-id=2-10';
const SECRET = 'figd_TESTSECRET0123456789abcdefghij';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'figma-test-'));

test('cli: parse-url prints JSON; unknown command prints usage with exit 2', async () => {
  const r = await run(['parse-url', URL1]); assert.equal(r.code, 0); assert.equal(JSON.parse(r.stdout).nodeId, '2:10');
  const u = await run(['frobnicate']); assert.equal(u.code, 2); assert.match(u.stderr, /usage: figma-fetch/);
  const bad = await run(['parse-url', 'https://example.com/x']); assert.equal(bad.code, 2); assert.match(bad.stderr, /not a figma.com URL/);
});
test('cli: missing token explains how to get one, makes no request, exit 3', async () => {
  const s = await stub((q, r) => json(r, 200, {}));
  const r = await run(['fetch', URL1, '--out', tmp()], { FIGMA_API_BASE: s.base });
  await s.close();
  assert.equal(r.code, 3); assert.match(r.stderr, /FIGMA_TOKEN is not set/); assert.match(r.stderr, /MCP/); assert.equal(s.hits.length, 0);
});
test('cli: no node-id -> asks for a frame link (exit 2, no request)', async () => {
  const s = await stub((q, r) => json(r, 200, {}));
  const r = await run(['fetch', 'https://www.figma.com/design/FILEKEY1/Acme'], { FIGMA_TOKEN: SECRET, FIGMA_API_BASE: s.base });
  await s.close(); assert.equal(r.code, 2); assert.match(r.stderr, /no node-id/); assert.equal(s.hits.length, 0);
});
for (const [status, code, re] of [[403, 4, /403 \(forbidden\).*invalid or expired.*scope/s], [404, 4, /404 \(not found\).*file key "FILEKEY1"/s], [429, 5, /rate limit reached \(429: retry after 120s, plan tier student, limit type low.*Not retrying/s]]) {
  test(`cli: ${status} gives a plain message, never echoes the token, writes nothing secret`, async () => {
    const s = await stub((q, r) => json(r, status, { status, err: `bad token ${SECRET} (echoed by a hostile server)` }, status === 429 ? { 'retry-after': '120', 'x-figma-plan-tier': 'student', 'x-figma-rate-limit-type': 'low' } : {}));
    const out = tmp();
    const r = await run(['fetch', URL1, '--out', out], { FIGMA_TOKEN: SECRET, FIGMA_API_BASE: s.base });
    await s.close();
    assert.equal(r.code, code, r.stderr); assert.match(r.stderr, re);
    assert.ok(!(r.stdout + r.stderr).includes(SECRET), 'token leaked to output');
    for (const f of fs.readdirSync(out)) assert.ok(!fs.readFileSync(path.join(out, f), 'utf8').includes(SECRET));
    assert.equal(s.hits.length, 1, 'no automatic retries');
  });
}
test('cli: network failure message does not contain the token', async () => {
  const r = await run(['fetch', URL1, '--out', tmp()], { FIGMA_TOKEN: SECRET, FIGMA_API_BASE: 'http://127.0.0.1:9' });
  assert.equal(r.code, 4); assert.match(r.stderr, /could not reach 127.0.0.1:9/); assert.ok(!r.stderr.includes(SECRET));
});
test('cli: fetch writes node.json + facts.json, sends X-Figma-Token only, handles variables 403, caches, exports assets', async () => {
  const s = await stub((q, r, hits) => {
    if (q.url.startsWith('/v1/files/FILEKEY1/nodes?')) return json(r, 200, fx('pricing-section.nodes.json'));
    if (q.url.startsWith('/v1/files/FILEKEY1/variables/local')) return json(r, 403, { status: 403, error: true, meta: { message: 'Limited by Figma plan' } });
    if (q.url.startsWith('/v1/images/FILEKEY1?')) { const ids = new URL(q.url, 'http://x').searchParams.get('ids').split(','); return json(r, 200, { err: null, images: Object.fromEntries(ids.map((i) => [i, i.startsWith('3:109') ? null : `http://127.0.0.1:${s.server.address().port}/export/${i.replace(':', '_')}.bin`])) }); }
    if (q.url.startsWith('/export/')) { r.writeHead(200); return r.end('<svg/>'); }
    r.writeHead(500); r.end();
  });
  const out = tmp();
  const url = 'https://www.figma.com/design/FILEKEY1/Acme?node-id=3-1';
  const r = await run(['fetch', url, '--out', out, '--assets', '--screenshot'], { FIGMA_TOKEN: SECRET, FIGMA_API_BASE: s.base });
  assert.equal(r.code, 0, r.stderr);
  const sum = JSON.parse(r.stdout);
  assert.match(sum.variables, /^unavailable: Figma answered 403/); assert.match(sum.variables, /Enterprise/);
  assert.ok(fs.existsSync(path.join(out, 'node.json')) && fs.existsSync(path.join(out, 'facts.json')) && fs.existsSync(path.join(out, 'raw-nodes.json')));
  assert.ok(sum.files.assets.length >= 3, JSON.stringify(sum.files.assets));
  assert.ok(sum.files.assets.some((a) => a.startsWith('assets/screenshot-')));
  assert.ok(s.hits.every((h) => h.url.startsWith('/export/') ? h.token === undefined : h.token === SECRET && h.auth === undefined), 'token only in X-Figma-Token to the API, never to export URLs');
  assert.ok(!(r.stdout + r.stderr).includes(SECRET));
  for (const f of ['node.json', 'facts.json', 'raw-nodes.json']) assert.ok(!fs.readFileSync(path.join(out, f), 'utf8').includes(SECRET));
  const before = s.hits.length;
  const again = await run(['fetch', url, '--out', out], { FIGMA_TOKEN: SECRET, FIGMA_API_BASE: s.base });
  assert.equal(again.code, 0); assert.equal(JSON.parse(again.stdout).cached, true); assert.equal(s.hits.length, before, 'cache hit made no request');
  await s.close();
});
test('cli: normalise | facts | diff round trip on the fixtures', async () => {
  const d = tmp(); const n = path.join(d, 'n.json'), f = path.join(d, 'f.json'), c = path.join(d, 'c.json');
  const a = await run(['normalise', path.join(here, 'fixtures/figma/account-overview.nodes.json'), '--variables', path.join(here, 'fixtures/figma/variables.local.json')]); assert.equal(a.code, 0); fs.writeFileSync(n, a.stdout);
  const b = await run(['facts', n, '--design-system', path.join(here, 'fixtures/figma/design-system.sample.json'), '--at', '1280']); assert.equal(b.code, 0); fs.writeFileSync(f, b.stdout);
  fs.writeFileSync(c, JSON.stringify({ 'account-text': { gap: '4px' } }));
  const e = await run(['diff', f, c, '--md']); assert.equal(e.code, 0); assert.match(e.stdout, /\| gap \| 8px \| 4px \| changed/);
  assert.ok(JSON.parse(b.stdout.replace(/\n/g, '')).entries.length > 5);
});

test('facts: entries inside a component instance are marked internal', () => {
  const by = (id) => FACTS().entries.find((e) => e.testid === id);
  assert.equal(by('badge').internal, true);
  assert.equal(by('label').internal, true); // text inside the Badge instance
  assert.equal(by('account-name').internal, undefined);
  assert.equal(by('plan-label').internal, undefined);
});

test('diff: facts inside component instances are skipped unless code values are supplied', () => {
  const d = F.diffFacts(FACTS({ at: 1280 }), { 'account-name': { 'font-weight': '600' } });
  assert.ok(d.summary.internal > 0);
  assert.ok(!d.rows.some((r) => r.testid === 'badge' || r.testid === 'label'));
  assert.equal(d.rows.find((r) => r.testid === 'account-name' && r.prop === 'font-weight').status, 'changed');
  const d2 = F.diffFacts(FACTS(), { badge: { 'border-radius': '9999px' } });
  assert.equal(d2.rows.find((r) => r.testid === 'badge' && r.prop === 'border-radius').status, 'same');
});

test('facts: a Card-like instance keeps its layers (page content), a Button-like one is internal; icons have no child facts', () => {
  const n = F.normalise(fx('pricing-section.nodes.json'), { nodeId: '3:1', variables: fx('variables.local.json') });
  const f = F.buildFacts(n, { designSystem: DS });
  const by = (id) => f.entries.find((e) => e.id === id);
  assert.equal(by('3:10').internal, undefined);      // Card instance: padding/radius facts stay
  assert.equal(by('3:102').internal, undefined);     // plan name inside the Card: page content
  assert.equal(by('3:10c').internal, true);          // Button instance
  assert.equal(by('3:10c1').internal, true);         // its label
  assert.ok(by('3:10901'), 'the icon itself is listed');
  assert.equal(by('3:10901a'), undefined);           // vector inside the icon is not
});

test('facts: fixed icon sizes map to the spacing scale (w-4), odd sizes stay arbitrary', () => {
  const n = F.normalise(fx('pricing-section.nodes.json'), { nodeId: '3:1' });
  const f = F.buildFacts(n, { designSystem: DS });
  const icon = f.entries.find((e) => e.id === '3:10901');
  assert.equal(icon.facts.find((x) => x.prop === 'width').class, 'w-4');
  assert.equal(icon.facts.find((x) => x.prop === 'width').via, 'framework');
});
