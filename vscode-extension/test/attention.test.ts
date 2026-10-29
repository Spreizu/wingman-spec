import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, test } from 'node:test';
import { attMain } from '../src/webview/components.ts';
import { renderPage } from '../src/webview/render.ts';
import type { Route } from '../src/webview/types.ts';
import { makeData, makeFixture } from './fixture.ts';

const root = makeFixture();
after(() => rmSync(root, { recursive: true, force: true }));

const LONG = `Blocked: task 1.1 visual scenarios cannot pass on this page. ${'Language strings, @spec anchors, data-testid markers, and the visual tests are in place. Run the test command again. '.repeat(6)}`;

async function html(route: Route): Promise<string> {
  const d = await makeData(root, route);
  const texts = { ...d.texts };
  for (const k of Object.keys(texts)) if (k.endsWith('BLOCKED.md')) texts[k] = LONG;
  return renderPage({ ...d, texts }, 'NONCE', 'vscode-resource:');
}
const rule = (page: string, sel: string): string => (page.match(new RegExp(`${sel.replace(/[.>:()*]/g, '\\$&')} \\{([^}]*)\\}`)) ?? [])[1] ?? '';

test('attention rows (needs a product decision, ADRs need syncing, ADRs waiting): the label and the text are separate boxes, never positioned over each other', async () => {
  const page = await html({ page: 'overview' });
  const rows = [...page.matchAll(/<div class="att [^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1] ?? '');
  assert.ok(rows.length > 0, 'the page shows attention rows');
  for (const r of rows) {
    assert.match(r, /<span class="att-main"><span class="att-title"[^>]*>[^<]+<\/span><span class="att-text muted"/, 'title and text inside one column box');
    assert.ok(!/class="grow"/.test(r), 'no zero-basis flex sibling that the long text can squeeze to nothing');
  }
  const decision = rows.find((r) => r.includes('Blocked: task 1.1'));
  assert.ok(decision, 'the blocked change shows its excerpt');
});

test('attention row CSS: a column with min-width 0, a one-line title with ellipsis, a clamped text, no absolute positioning', async () => {
  const page = await html({ page: 'overview' });
  const css = (page.match(/<style[\s\S]*?<\/style>/) ?? [''])[0];
  const main = rule(css, '.att-main');
  assert.match(main, /min-width:\s*0/);
  assert.match(main, /flex-direction:\s*column/);
  assert.match(main, /flex:\s*1/);
  const title = rule(css, '.att-title');
  assert.match(title, /overflow:\s*hidden/);
  assert.match(title, /text-overflow:\s*ellipsis/);
  assert.match(title, /white-space:\s*nowrap/);
  const text = rule(css, '.att-text');
  assert.match(text, /overflow:\s*hidden/);
  assert.match(text, /-webkit-line-clamp:\s*2/);
  assert.match(text, /overflow-wrap:\s*anywhere/);
  assert.match(rule(css, '.att > :not(.att-main)'), /flex:\s*none/, 'icons and buttons keep their size');
  for (const sel of ['.att', '.att-main', '.att-title', '.att-text']) assert.ok(!/position:\s*absolute/.test(rule(css, sel)), `${sel}: no absolute position`);
});

test('every flex row that holds a growing text column lets it shrink (min-width: 0)', async () => {
  const css = ((await html({ page: 'overview' })).match(/<style[\s\S]*?<\/style>/) ?? [''])[0];
  for (const m of css.matchAll(/([^{}]*\.(?:grow|t|ttitle|att-main))\s*\{([^}]*)\}/g)) {
    if (/flex:\s*1/.test(m[2] ?? '')) assert.match(m[2] ?? '', /min-width:\s*0/, `${(m[1] ?? '').trim()} can shrink`);
  }
});

test('attMain escapes both texts and keeps them in the tooltip', () => {
  const h = attMain('<b>x</b>', 'a & b');
  assert.ok(!h.includes('<b>'));
  assert.ok(h.includes('title="a &amp; b"'));
});
