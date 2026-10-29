import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, test } from 'node:test';
import { pillRow } from '../src/webview/components.ts';
import { renderPage } from '../src/webview/render.ts';
import type { Route } from '../src/webview/types.ts';
import { makeData, makeFixture } from './fixture.ts';

const root = makeFixture();
after(() => rmSync(root, { recursive: true, force: true }));

const body = (html: string): string => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');
const css = (html: string): string => (html.match(/<style[\s\S]*?<\/style>/) ?? [''])[0];

async function page(route: Route): Promise<string> {
  return renderPage(await makeData(root, route), 'NONCE', 'vscode-resource:');
}

test('pillRow wraps its content in the one shared container', () => {
  assert.equal(pillRow('<span class="badge">x</span>'), '<div class="pills"><span class="badge">x</span></div>');
});

test('the shared pill container has a gap, wraps and sits below the card text', async () => {
  const rule = (css(await page({ page: 'overview' })).match(/\.pills \{([^}]*)\}/) ?? [])[1] ?? '';
  assert.match(rule, /display:\s*flex/);
  assert.match(rule, /flex-wrap:\s*wrap/);
  assert.match(rule, /gap:\s*8px/);
  assert.match(rule, /margin-top:\s*12px/);
});

test('every card on the overview, specs and history pages puts its pills in the shared container', async () => {
  for (const route of [{ page: 'overview' }, { page: 'specs' }, { page: 'history' }] as Route[]) {
    const html = body(await page(route));
    const cards = html.split('<article class="card click').slice(1).map((c) => c.split('</article>')[0] ?? '');
    assert.ok(cards.length > 0, `${route.page}: has cards`);
    for (const card of cards) {
      assert.ok(!/<div class="row"/.test(card) || /adr-card/.test(card), `${route.page}: a card builds its own pill row instead of using pillRow`);
      assert.ok(!/style="margin-top/.test(card), `${route.page}: inline spacing instead of the shared class`);
      if (/class="badge/.test(card) && !/adr-card/.test(card)) {
        assert.ok(/<div class="pills">/.test(card), `${route.page}: pills are not in the shared container`);
        const before = card.slice(0, card.indexOf('<div class="pills">'));
        assert.ok(/<\/(h3|p|div)>\s*$/.test(before.trimEnd()) || before.trimEnd().endsWith('</div>'), `${route.page}: the pill container follows a closed text block`);
      }
    }
  }
});

/** Pills inside one container (a pill row, a card header, an item row): their texts. */
function pillGroups(html: string): string[][] {
  const groups: string[][] = [];
  for (const m of html.matchAll(/<div class="(?:pills|req-head|row|cc-top|spread)"[^>]*>([\s\S]*?)<\/div>/g)) {
    groups.push([...(m[1] ?? '').matchAll(/<(?:span|button) class="badge[^"]*"[^>]*>([\s\S]*?)<\/(?:span|button)>/g)].map((b) => (b[1] ?? '').trim()));
  }
  return groups;
}

test('no card shows an empty pill ("none", "n/a", "0", blank) or two pills with the same text', async () => {
  const routes: Route[] = [
    { page: 'overview' }, { page: 'specs' }, { page: 'history' }, { page: 'adrs' },
    { page: 'change', root, name: 'demo' }, { page: 'change', root, name: 'blocked' },
    { page: 'archived', root, name: '2026-09-30-first-cut' },
  ] as Route[];
  let pills = 0;
  for (const route of routes) {
    const html = body(await page(route));
    for (const g of pillGroups(html)) {
      pills += g.length;
      for (const t of g) assert.ok(!/^(|none|n\/a|0)$/i.test(t), `${route.page}: empty pill "${t}"`);
      const lower = g.map((t) => t.toLowerCase());
      assert.equal(new Set(lower).size, lower.length, `${route.page}: repeated pill in one card: ${g.join(' | ')}`);
    }
  }
  assert.ok(pills > 5, 'the pages do render pills');
});

test('the no-decision record is one muted line on the ADR tab, not a card or a pill', async () => {
  const html = body(await page({ page: 'change', root, name: 'demo' }));
  assert.ok(!html.includes('<h4>No architectural decision'), 'no card for the none record');
  assert.match(html, /<p class="muted no-decision">No architectural decision: Because &lt;b&gt;reasons&lt;\/b&gt;\./);
});

test('a badge with an empty value is not drawn', async () => {
  const { badge } = await import('../src/webview/components.ts');
  for (const t of ['', ' ', 'none', 'None', 'n/a', '0']) assert.equal(badge(t), '', t);
  assert.match(badge('blocked', 'bad'), /class="badge tone-bad"/);
});
