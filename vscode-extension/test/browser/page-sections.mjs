// Headless Chromium check of the vertical rhythm of every webview page: consecutive top-level boxes (the children of the
// page's <main>) never overlap and are at least the shared section gap apart (--section-gap). Also, on the change page:
// the four summary cards have the same left border width, and the "before archive" list is quiet while tasks are open.
// Needs Playwright (not part of `node --test`):
//   PLAYWRIGHT_NODE_MODULES=<node_modules with playwright> [PLAYWRIGHT_BROWSERS_PATH=...] \
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON test/browser/page-sections.mjs <screenshot-dir> [prefix]
// Screenshots are written for looking at, never committed or compared.
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { renderPage } from '../../src/webview/render.ts';
import { makeData, makeFixture } from '../fixture.ts';

const out = process.argv[2] ?? '/tmp/section-shots';
const prefix = process.argv[3] ?? 'after';
mkdirSync(out, { recursive: true });
const nm = process.env.PLAYWRIGHT_NODE_MODULES;
if (!nm) { console.log('skipped: PLAYWRIGHT_NODE_MODULES is not set'); process.exit(0); }
const { chromium } = createRequire(join(nm, 'x.js'))('playwright');

const root = makeFixture();
const drift = { source: 'drift', severity: 'error', code: 'unanchored', message: 'auth/login has no code anchor', change: 'shipped' };
const pages = {
  overview: { page: 'overview' },
  'change-open-tasks': { page: 'change', root, name: 'demo' },
  'change-done-blocked': { page: 'change', root, name: 'shipped', dashboard: { run: { runId: 'r1', attempts: 1, reviewPending: false, checksPassed: 1, checksFailed: 0, exhausted: false, recent: [], verified: ['1.1 Done'] }, findings: [drift] } },
  specs: { page: 'specs', root },
  spec: { page: 'spec', root, name: 'auth' },
  adrs: { page: 'adrs', root },
  history: { page: 'history', root },
  archived: { page: 'archived', root, name: '2026-09-30-first-cut' },
};
const browser = await chromium.launch();
let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL ${m}`); };
for (const [name, r] of Object.entries(pages)) {
  const { dashboard, ...route } = r;
  const data = await makeData(root, route);
  if (dashboard) data.dashboard = dashboard;
  const html = (await renderPage(data, 'NONCE', 'vscode-resource:')).replace(/<script[\s\S]*?<\/script>/g, '');
  for (const width of [375, 900]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.setContent(html);
    const MIN_GAP = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--section-gap')));
    if (!(MIN_GAP >= 12)) fail(`${name} ${width}px: --section-gap is ${MIN_GAP}, expected at least 12px`);
    const boxes = await page.$$eval('main.main > *', (els) => els.map((el) => {
      const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
      return { tag: `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}`, top: r.top, bottom: r.bottom, h: r.height, shown: cs.display !== 'none' && cs.visibility !== 'hidden' && r.height > 0 };
    }).filter((b) => b.shown));
    for (let i = 1; i < boxes.length; i++) {
      const a = boxes[i - 1], b = boxes[i]; const gap = Math.round((b.top - a.bottom) * 10) / 10;
      if (gap < 0) fail(`${name} ${width}px: ${b.tag} overlaps ${a.tag} by ${-gap}px`);
      else if (gap < MIN_GAP) fail(`${name} ${width}px: ${a.tag} -> ${b.tag} gap ${gap}px (< ${MIN_GAP})`);
    }
    if (name.startsWith('change')) {
      const tiles = await page.$$eval('.tile', (els) => els.map((el) => getComputedStyle(el).borderLeftWidth));
      if (new Set(tiles).size > 1) fail(`${name} ${width}px: summary cards have different left borders (${tiles.join(', ')})`);
      const pre = await page.$$eval('.pre-archive, .block-item, .dash-h', (els) => els.map((el) => ({ cls: el.className, open: el.tagName === 'DETAILS' ? el.open : null, text: el.textContent.replace(/\s+/g, ' ').trim().slice(0, 60) })));
      console.log(`  ${name} ${width}px archive section: ${JSON.stringify(pre)}`);
      if (name === 'change-open-tasks' && (pre.some((p) => p.cls === 'block-item' || p.open === true) || !pre.some((p) => p.cls === 'pre-archive')))
        fail(`${name} ${width}px: with open tasks the archive list must be one collapsed line`);
      if (name === 'change-done-blocked' && !pre.some((p) => p.cls === 'block-item')) fail(`${name} ${width}px: all tasks done and a blocker: the blocker must be shown`);
      const dup = await page.evaluate(() => {
        const head = new Set([...document.querySelectorAll('.page-head [data-agent], .page-head [data-text]')].map((b) => b.getAttribute('data-agent') ?? b.getAttribute('data-text')));
        return [...document.querySelectorAll('.dash [data-agent], .dash [data-text]')].map((b) => b.getAttribute('data-agent') ?? b.getAttribute('data-text')).filter((x) => head.has(x));
      });
      if (dup.length) fail(`${name} ${width}px: the overview repeats the header's action ${dup.join(', ')}`);
    }
    await page.screenshot({ path: join(out, `${prefix}-${name}-${width}.png`), fullPage: true });
    console.log(`${name} ${width}px: ${boxes.length} sections, gaps ${boxes.slice(1).map((b, i) => Math.round(b.top - boxes[i].bottom)).join('/')}`);
    await page.close();
  }
}
await browser.close();
rmSync(root, { recursive: true, force: true });
if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
