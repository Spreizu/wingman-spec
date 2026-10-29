import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildTrace } from '../src/model/traceability.ts';
import { anchorRows, insightBlock } from '../src/webview/insightView.ts';
import { renderPage } from '../src/webview/render.ts';
import type { Route } from '../src/webview/types.ts';
import { makeData } from './fixture.ts';
import { traceProject } from './trace-fixture.ts';

const dir = traceProject();
const model = buildTrace(dir, dir);

async function page(route: Route, tick = 1): Promise<string> {
  const d = await makeData(dir, route);
  return renderPage({ ...d, trace: [model], revealTick: tick }, 'NONCE', 'vscode-resource:');
}
const markup = (html: string): string => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
const focused = (html: string): string[] => [...markup(html).matchAll(/class="[^"]*\bfocused\b[^"]*"[^>]*?id="([^"]+)"|id="([^"]+)"[^>]*class="[^"]*\bfocused\b/g)].map((m) => m[1] ?? m[2] ?? '');

test('a requirement route highlights exactly that requirement card and asks the page to scroll to it', async () => {
  const html = await page({ page: 'spec', root: model.root, name: 'billing', focus: 'req:add-an-item' });
  assert.deepEqual(focused(html), ['req-add-an-item']);
  assert.match(html, /data-reveal="1"/);
});

test('a scenario route highlights that scenario only', async () => {
  const html = await page({ page: 'spec', root: model.root, name: 'billing', focus: 'scn:add-an-item/reject-empty' });
  assert.deepEqual(focused(html), ['scn-add-an-item-reject-empty']);
});

test('without a focus nothing is highlighted and no reveal is requested', async () => {
  const html = await page({ page: 'spec', root: model.root, name: 'billing' }, 0);
  assert.deepEqual(focused(html), []);
  assert.match(html, /data-reveal="0"/);
});

test('the requirement card shows tested status, anchors and the Why line', async () => {
  const html = markup(await page({ page: 'spec', root: model.root, name: 'billing', focus: 'req:add-an-item' }));
  assert.match(html, /1\/2 scenarios tested/);
  assert.match(html, /1 code anchor/);
  assert.match(html, /<p class="why-line"><span class="muted">Why<\/span> Users see what they owe, so they trust the app\./);
  assert.match(html, /no test yet/);
  assert.match(html, /src\/add\.ts:\d+/);
});

test('an unknown capability gives an empty state, not an exception', async () => {
  assert.ok((await page({ page: 'spec', root: model.root, name: 'nothing', focus: 'req:x' })).includes('default-src'));
});

test('a pending-change requirement can be revealed too', async () => {
  const html = await page({ page: 'spec', root: model.root, name: 'billing', focus: 'req:refund-an-item' });
  assert.ok(html.includes('default-src'));
});

test('the requirement detail has no aggregate Tests row while its scenario rows carry the test links', async () => {
  const html = markup(await page({ page: 'spec', root: model.root, name: 'billing' }, 0));
  const withLinks = html.split('<div class="scn').slice(1).filter((s) => /<span class="scn-status"><button class="link"/.test(s));
  assert.ok(withLinks.length > 0, 'a scenario row carries its test link');
  assert.ok(!/<div class="anchor-row"><span class="muted">Tests<\/span>/.test(html), 'an aggregate Tests row repeats the scenario links');
  assert.match(html, /<div class="anchor-row"><span class="muted">Code<\/span>/);
});

test('without a tested scenario the requirement keeps the Tests row (nothing else lists the test references)', () => {
  const html = anchorRows([{ file: 'src/a.ts', line: 1 }], [{ file: 'tests/a.test.ts', line: 3 }], '/code');
  assert.match(html, /<span class="muted">Tests<\/span>/);
  const none = markup(insightBlock({ key: 'x/y', name: 'Y', statement: '', why: 'w', file: '', line: 0, code: [], tests: [{ file: 'tests/a.test.ts', line: 3 }], scenarios: [{ name: 's', slug: 's', line: 1, steps: [], tested: false, tests: [] }], testedCount: 0, adrs: [], pending: [], warnings: [] } as never, '/r', '/code'));
  assert.match(none, /<span class="muted">Tests<\/span>/);
  const tested = markup(insightBlock({ key: 'x/y', name: 'Y', statement: '', why: 'w', file: '', line: 0, code: [], tests: [{ file: 'tests/a.test.ts', line: 3 }], scenarios: [{ name: 's', slug: 's', line: 1, steps: [], tested: true, tests: [{ file: 'tests/a.test.ts', line: 3 }] }], testedCount: 1, adrs: [], pending: [], warnings: [] } as never, '/r', '/code'));
  assert.doesNotMatch(tested, /<span class="muted">Tests<\/span>/);
});
