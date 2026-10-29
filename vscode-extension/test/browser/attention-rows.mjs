// Headless Chromium check of the attention rows on the Overview ("Needs a product decision", "ADRs need syncing"):
// the label and the long text must not overlap, at 375px and 900px. Needs Playwright (not part of `node --test`):
//   PLAYWRIGHT_NODE_MODULES=<node_modules with playwright> [PLAYWRIGHT_BROWSERS_PATH=...] \
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON test/browser/attention-rows.mjs <screenshot-dir> [prefix]
// Screenshots are written for looking at, never committed or compared.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { renderPage } from '../../src/webview/render.ts';
import { makeData, makeFixture } from '../fixture.ts';

const out = process.argv[2] ?? '/tmp/attention-shots';
const prefix = process.argv[3] ?? 'after';
mkdirSync(out, { recursive: true });
const nm = process.env.PLAYWRIGHT_NODE_MODULES;
if (!nm) { console.log('skipped: PLAYWRIGHT_NODE_MODULES is not set'); process.exit(0); }
const { chromium } = createRequire(join(nm, 'x.js'))('playwright');

const root = makeFixture();
const LONG = `Blocked: task 1.1 visual scenarios cannot pass on this page. ${'Language strings, @spec anchors, data-testid markers, and the visual tests are in place. Run the test command again. '.repeat(4)}`;
const d = await makeData(root, { page: 'overview' });
const texts = { ...d.texts };
for (const k of Object.keys(texts)) if (k.endsWith('BLOCKED.md')) texts[k] = LONG;
const html = renderPage({ ...d, texts }, 'NONCE', 'vscode-resource:');

const browser = await chromium.launch();
let failures = 0;
for (const width of [375, 900]) {
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.setContent(html);
  const rows = await page.$$eval('.att', (els) => els.map((el) => {
    const nodes = [...el.querySelectorAll('.att-title, .att-text, :scope > .grow, :scope > .muted')];
    const spill = nodes.filter((n) => getComputedStyle(n).overflow === 'visible' && n.scrollWidth > n.clientWidth + 1).length;
    const boxes = nodes.map((n) => n.getBoundingClientRect());
    const row = el.getBoundingClientRect();
    return { row: { l: row.left, r: row.right }, boxes: boxes.map((b) => ({ l: b.left, r: b.right, t: b.top, b: b.bottom })), spill, text: el.textContent.trim().slice(0, 40) };
  }));
  assert.ok(rows.length > 0, 'attention rows are shown');
  for (const r of rows) {
    if (r.spill) { failures++; console.log(`FAIL ${width}px: text spills out of a box that is too narrow for it (${r.text})`); }
    // Layout boxes only intersect when text is drawn over text; a wrapped text overflowing its zero-width box shows as an overlap or an overflow.
    for (let i = 0; i < r.boxes.length; i++) {
      const a = r.boxes[i];
      if (a.r > r.row.r + 1) { failures++; console.log(`FAIL ${width}px: a text box leaves its row (${r.text})`); }
      for (let j = i + 1; j < r.boxes.length; j++) {
        const c = r.boxes[j];
        const overlap = a.l < c.r - 1 && c.l < a.r - 1 && a.t < c.b - 1 && c.t < a.b - 1;
        if (overlap) { failures++; console.log(`FAIL ${width}px: label and text overlap (${r.text})`); }
      }
    }
  }
  const section = await page.$('.attention');
  await section.screenshot({ path: join(out, `${prefix}-${width}.png`) });
  console.log(`${width}px: ${rows.length} rows checked, screenshot ${prefix}-${width}.png`);
  await page.close();
}
await browser.close();
rmSync(root, { recursive: true, force: true });
if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('ok');
