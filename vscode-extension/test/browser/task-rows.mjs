// Headless Chromium check of the Tasks tab of a change page: the highlighted `next` row, its Done-when lines and the card around them
// are one surface (same left and right edge within 1px), long and struck-through titles stay inside, inline code is real <code>, no literal
// backtick. At 375px and 900px, light and dark, with 0, 1 and many tasks in a group. Needs Playwright (not part of `node --test`):
//   PLAYWRIGHT_NODE_MODULES=<node_modules with playwright> [PLAYWRIGHT_BROWSERS_PATH=...] \
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON test/browser/task-rows.mjs <screenshot-dir> [prefix]
// Screenshots are written for looking at, never committed or compared.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { renderPage } from '../../src/webview/render.ts';
import { makeData, makeFixture } from '../fixture.ts';

const out = process.argv[2] ?? '/tmp/task-shots';
const prefix = process.argv[3] ?? 'after';
mkdirSync(out, { recursive: true });
const nm = process.env.PLAYWRIGHT_NODE_MODULES;
if (!nm) { console.log('skipped: PLAYWRIGHT_NODE_MODULES is not set'); process.exit(0); }
const { chromium } = createRequire(join(nm, 'x.js'))('playwright');

const root = makeFixture();
const put = (rel, text) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
put('changes/rows/tasks.md', [
  '## 1. Persist favourites (risky)', '',
  '- [x] 1.1 Add `FAVOURITE_QUERY` and a `Favourites_store` that saves `(USER_ID, ITEM_ID)` and resolves live stock availability',
  '- [ ] 1.R Request code review for group 1',
  '  - Done when: review findings of Critical/Important severity are fixed and re-verified', '',
  '## 2. One task only', '',
  '- [ ] 2.1 Show a `star` on the item page',
  '  - Spec: auth > Login', '  - Test first: a `star` test', '  - Files: `src/item/star.ts`', '  - Done when: `npm test` passes and the star is shown for a signed-in account', '',
  '## 3. Many tasks', '',
  ...Array.from({ length: 6 }, (_, i) => `- [${i < 3 ? 'x' : ' '}] 3.${i + 1} ${i === 1 ? 'A_very_long_unbroken_title_without_any_space_that_has_to_stay_inside_its_card_even_when_struck_through_at_375px' : `Step ${i + 1} of the list`}`),
  '', '## 4. Empty group', '',
].join('\n'));

const THEMES = {
  dark: '--vscode-foreground:#cccccc;--vscode-editor-background:#1e1e1e;--vscode-sideBar-background:#252526;--vscode-list-hoverBackground:#2a2d2e;--vscode-panel-border:#3c3c3c',
  light: '--vscode-foreground:#333333;--vscode-editor-background:#ffffff;--vscode-sideBar-background:#f3f3f3;--vscode-list-hoverBackground:#e8e8e8;--vscode-panel-border:#d4d4d4',
};
const html = await renderPage(await makeData(root, { page: 'change', root, name: 'rows' }), 'NONCE', 'vscode-resource:');
const browser = await chromium.launch();
let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL ${m}`); };
const near = (a, b) => Math.abs(a - b) <= 1;
for (const theme of ['dark', 'light']) {
  for (const width of [375, 900]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } });
    await page.setContent(html.replace('</body>', `<style nonce="NONCE">:root{${THEMES[theme]}}body{background:var(--vscode-editor-background)}</style></body>`));
    await page.evaluate(() => document.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('active', p.getAttribute('data-pane') === 'tasks')));
    const rects = async (sel) => page.$$eval(sel, (els) => els.map((el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; }));
    // 1. every task row, its summary and its detail list fill the card content box
    const cards = await page.$$eval('.tgroup', (cs) => cs.map((c) => { const r = c.getBoundingClientRect(); const cs2 = getComputedStyle(c); return { l: r.left + parseFloat(cs2.borderLeftWidth), r: r.right - parseFloat(cs2.borderRightWidth) }; }));
    const rows = await page.$$eval('.tgroup', (cs, ) => cs.map((c) => [...c.querySelectorAll('li.task')].map((li) => {
      const box = (el) => { const r = el.getBoundingClientRect(); return { l: r.left, r: r.right }; };
      const head = li.querySelector('summary, .trow');
      const bg = (el) => getComputedStyle(el).backgroundColor;
      const dl = li.querySelector('dl');
      return { next: li.classList.contains('next'), li: box(li), head: box(head), dl: dl ? box(dl) : null, title: li.querySelector('.ttitle').textContent.slice(0, 30), bgLi: bg(li), bgHead: bg(head), spill: [...li.querySelectorAll('*')].some((n) => n.getBoundingClientRect().right > li.getBoundingClientRect().right + 1) };
    })));
    rows.forEach((group, gi) => group.forEach((row) => {
      const c = cards[gi]; const w = `${theme} ${width}px "${row.title}"`;
      if (!near(row.li.l, c.l) || !near(row.li.r, c.r)) fail(`${w}: the row is not the card's width (${row.li.l}-${row.li.r} vs ${c.l}-${c.r})`);
      if (!near(row.head.l, row.li.l) || !near(row.head.r, row.li.r)) fail(`${w}: the row's summary does not fill the row (${row.head.l}-${row.head.r} vs ${row.li.l}-${row.li.r})`);
      if (row.dl && (!near(row.dl.l, row.li.l) || !near(row.dl.r, row.li.r))) fail(`${w}: the Done-when list does not fill the row (${row.dl.l}-${row.dl.r})`);
      if (row.spill) fail(`${w}: text leaves its row`);
    }));
    // 2. hovering the highlighted row paints the whole row, not an inset box
    const next = await page.$('li.task.next-task summary');
    if (next) {
      await next.hover();
      const hov = await page.$eval('li.task.next-task', (li) => { const s = li.querySelector('summary'); const a = li.getBoundingClientRect(); const b = s.getBoundingClientRect(); return { dl: Math.abs(a.left - b.left), dr: Math.abs(a.right - b.right), bg: getComputedStyle(s).backgroundColor, liBg: getComputedStyle(li).backgroundColor }; });
      if (hov.dl > 1 || hov.dr > 1) fail(`${theme} ${width}px: hovered summary is inset from the row (${hov.dl}px left, ${hov.dr}px right)`);
      await page.mouse.move(0, 0);
    }
    // 3. text: real <code>, no literal backtick, struck-through titles stay inside
    const text = await page.$eval('[data-pane="tasks"]', (el) => el.textContent);
    if (text.includes('`')) fail(`${theme} ${width}px: literal backtick in the task text (${text.match(/.{15}`.{15}/)?.[0]})`);
    const codes = await page.$$eval('[data-pane="tasks"] .ttitle code, [data-pane="tasks"] dd code', (els) => els.length);
    if (codes < 5) fail(`${theme} ${width}px: expected inline code in titles and details, found ${codes}`);
    const wide = await page.evaluate(() => [...document.querySelectorAll('.tgroup')].flatMap((c) => [...c.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > c.getBoundingClientRect().right + 1)).length);
    if (wide) fail(`${theme} ${width}px: ${wide} element(s) leave their task card`);
    const clipped = await page.$$eval('.tgroup .ttitle', (els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
    if (clipped) fail(`${theme} ${width}px: ${clipped} task title(s) are wider than their box (long words must wrap)`);
    // 4. alignment: ids and badges share columns across rows of a group; the Done-when label column is one width
    const cols = await page.$$eval('.tgroup', (cs) => cs.map((c) => ({ tid: [...new Set([...c.querySelectorAll('.tid')].map((e) => Math.round(e.getBoundingClientRect().left)))], dt: [...new Set([...c.querySelectorAll('dd')].map((e) => Math.round(e.getBoundingClientRect().left)))] })));
    cols.forEach((c, i) => { if (c.tid.length > 1) fail(`${theme} ${width}px group ${i + 1}: task ids start at different x (${c.tid})`); if (c.dt.length > 1) fail(`${theme} ${width}px group ${i + 1}: detail values start at different x (${c.dt})`); });
    await (await page.$('[data-pane="tasks"]')).screenshot({ path: join(out, `${prefix}-${theme}-${width}.png`) });
    console.log(`${theme} ${width}px: ${rows.flat().length} rows checked`);
    await page.close();
  }
}
await browser.close();
if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
console.log('task rows ok');
