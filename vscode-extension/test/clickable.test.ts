import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { after, test } from 'node:test';
import { buildTrace } from '../src/model/traceability.ts';
import { renderPage } from '../src/webview/render.ts';
import type { Route } from '../src/webview/types.ts';
import { makeData, makeFixture } from './fixture.ts';
import { traceProject } from './trace-fixture.ts';

const root = makeFixture();
const tdir = traceProject();
const trace = buildTrace(tdir, tdir);
after(() => { rmSync(root, { recursive: true, force: true }); rmSync(tdir, { recursive: true, force: true }); });

const css = (html: string): string => (html.match(/<style[\s\S]*?<\/style>/) ?? [''])[0];
const markup = (html: string): string => html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '');

/** Class lists of the CSS rules that set `cursor: pointer` (the last compound selector of each, e.g. `.card.click`, `.badge.link`). */
function pointerRules(style: string): string[][] {
  const out: string[][] = [];
  for (const m of style.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/cursor:\s*pointer/.test(m[2] ?? '')) continue;
    for (const sel of (m[1] ?? '').split(',')) {
      const classes = [...(sel.trim().split(/\s+/).pop() ?? '').matchAll(/\.([\w-]+)/g)].map((x) => x[1] ?? '');
      if (classes.length) out.push(classes);
    }
  }
  return out;
}

async function pages(): Promise<{ route: string; html: string }[]> {
  const list: { route: string; data: Route; dir: string }[] = [
    ...(['overview', 'specs', 'history', 'adrs'] as const).map((p) => ({ route: p, data: { page: p } as Route, dir: root })),
    { route: 'change demo', data: { page: 'change', root, name: 'demo' }, dir: root },
    { route: 'adr', data: { page: 'adr', root, number: '0002' }, dir: root },
    { route: 'spec auth', data: { page: 'spec', root, name: 'auth' }, dir: root },
    { route: 'archived', data: { page: 'archived', root, name: '2026-09-30-first-cut' }, dir: root },
    { route: 'spec billing (traced)', data: { page: 'spec', root: tdir, name: 'billing' }, dir: tdir },
  ];
  const out: { route: string; html: string }[] = [];
  for (const p of list) {
    const d = await makeData(p.dir, p.data);
    out.push({ route: p.route, html: await renderPage(p.dir === tdir ? { ...d, trace: [trace] } : d, 'NONCE', 'vscode-resource:') });
  }
  return out;
}

test('every clickable element is a button or a link, or has the pointer cursor from the shared CSS', async () => {
  const all = await pages();
  const rules = pointerRules(css(all[0]?.html ?? ''));
  assert.ok(rules.some((r) => r.join() === 'link'), 'the shared .link class sets cursor: pointer');
  let seen = 0;
  for (const { route, html } of all) {
    for (const m of markup(html).matchAll(/<(\w+)([^>]*?\sdata-(?:open|route|cmd)=[^>]*)>/g)) {
      seen++;
      const tag = m[1] ?? '';
      const classes = ((m[2] ?? '').match(/class="([^"]*)"/)?.[1] ?? '').split(/\s+/);
      const real = tag === 'button' || tag === 'a';
      const pointer = rules.some((r) => r.every((c) => classes.includes(c)));
      assert.ok(real || pointer, `${route}: <${tag} class="${classes.join(' ')}"> looks clickable but shows the default cursor`);
      // a label styled as a link must be a real link: a button, or (a pill) keyboard-focusable with the link role
      if (classes.includes('link') && !real) assert.ok(/role="link"/.test(m[2] ?? '') && /tabindex="0"/.test(m[2] ?? ''), `${route}: <${tag} class="link"> is not a button and has no link role and tab stop: ${m[0].slice(0, 160)}`);
    }
  }
  assert.ok(seen > 20, `looked at ${seen} clickable elements`);
});

test('a scenario name is a real link to its test when it has one, and plain text when it has none', async () => {
  const html = markup((await pages()).find((p) => p.route.startsWith('spec billing'))?.html ?? '');
  const names = [...html.matchAll(/<div class="scn-name">[\s\S]*?<\/div>/g)].map((m) => m[0]);
  assert.ok(names.length >= 2);
  const linked = names.filter((n) => /<button class="link scn-link" data-open=/.test(n));
  const plain = names.filter((n) => !/scn-link/.test(n));
  assert.ok(linked.length > 0, 'a tested scenario has a link button');
  assert.ok(plain.length > 0 && plain.every((n) => !/data-open/.test(n.replace(/<span class="scn-status">[\s\S]*<\/span>/, ''))), 'an untested scenario is plain text');
  for (const n of linked) {
    const [a, b] = [...n.matchAll(/data-open="([^"]*)" data-line="(\d+)"/g)].map((m) => `${m[1]}:${m[2]}`);
    assert.equal(a, b, 'the name opens the same place as the right-hand link');
  }
  const style = css((await pages())[0]?.html ?? '');
  assert.match(style, /\.link \{[^}]*cursor:\s*pointer/);
  assert.match(style, /\.link:hover \{[^}]*underline/);
  assert.match(style, /\.link:focus-visible/);
});
