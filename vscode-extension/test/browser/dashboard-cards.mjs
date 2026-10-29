// Headless Chromium check of the four summary cards on a change page, in the empty state (no tasks, no run) and with tasks:
// equal heights, no text leaving its card, no coloured border on an empty card, no literal backtick. At 375px and 900px.
// Needs Playwright (not part of `node --test`):
//   PLAYWRIGHT_NODE_MODULES=<node_modules with playwright> [PLAYWRIGHT_BROWSERS_PATH=...] \
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON test/browser/dashboard-cards.mjs <screenshot-dir> [prefix]
// Screenshots are written for looking at, never committed or compared.
import assert from 'node:assert/strict';
import { mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { buildDashboard } from '../../src/model/changeDashboard.ts';
import { dashboardCard } from '../../src/webview/dashboardView.ts';
import { renderPage } from '../../src/webview/render.ts';
import { makeData, makeFixture } from '../fixture.ts';

const out = process.argv[2] ?? '/tmp/dashboard-shots';
const prefix = process.argv[3] ?? 'after';
mkdirSync(out, { recursive: true });
const nm = process.env.PLAYWRIGHT_NODE_MODULES;
if (!nm) { console.log('skipped: PLAYWRIGHT_NODE_MODULES is not set'); process.exit(0); }
const { chromium } = createRequire(join(nm, 'x.js'))('playwright');

const root = makeFixture();
// the page chrome and stylesheet come from a real render; only the dashboard card is swapped for the state under test
const shell = await renderPage(await makeData(root, { page: 'overview' }), 'NONCE', 'vscode-resource:');
const task = (id, title, checked) => ({ id, title, checked, line: 1, isReview: false, details: {} });
const changeOf = (tasks) => ({ name: 'add-search', dir: '/p/openspec/changes/add-search', schema: 'wingman-spec', isWingmanSpec: true, state: 'in-progress', artifacts: [], capabilities: [], adrs: [], noDecisions: [], adrsSynced: true,
  groups: tasks.length ? [{ number: '1', title: 'Core', tasks, isCloseOut: false }] : [], taskTotal: tasks.length, taskDone: tasks.filter((t) => t.checked).length });
const states = {
  empty: changeOf([]),
  tasks: changeOf([task('1.1', 'Add a search box', true), task('1.2', 'Show the results', false)]),
};
const cmd = (a) => `node openspec/scripts/verify-task.cjs ${a}`;

const browser = await chromium.launch();
let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL ${m}`); };
for (const [name, change] of Object.entries(states)) {
  const card = dashboardCard(buildDashboard({ change, inputs: {}, proposalText: name === 'tasks' ? 'Size: S\nRisk: money\n' : undefined, cmd }), false);
  const html = shell.replace('<main', `<main data-x`).replace(/<body([^>]*)>/, `<body$1><div id="probe" style="padding:16px">${card}</div>`);
  for (const width of [375, 900]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.setContent(html);
    const info = await page.$$eval('#probe .tile', (els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      const spill = [...el.querySelectorAll('*')].some((n) => n.getBoundingClientRect().right > r.right + 1 || n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflow === 'visible' && n.children.length === 0 && n.getBoundingClientRect().width > r.width);
      const cs = getComputedStyle(el);
      return { l: r.left, t: Math.round(r.top), h: Math.round(r.height), spill, empty: el.classList.contains('empty'), border: cs.borderLeftColor, line: cs.borderTopColor, text: el.textContent.replace(/\s+/g, ' ').trim() };
    }));
    assert.equal(info.length, 4, 'four cards');
    const rows = new Map();
    for (const i of info) rows.set(i.t, [...(rows.get(i.t) ?? []), i]);
    for (const [, row] of rows) if (new Set(row.map((i) => i.h)).size > 1) fail(`${name} ${width}px: cards in one row differ in height (${row.map((i) => i.h).join(', ')})`);
    for (const i of info) {
      if (i.spill) fail(`${name} ${width}px: text leaves its card (${i.text})`);
      if (i.empty && i.border !== i.line) fail(`${name} ${width}px: an empty card has a coloured left border (${i.text})`);
    }
    if ((await page.textContent('#probe')).includes('`')) fail(`${name} ${width}px: literal backtick`);
    await (await page.$('#probe')).screenshot({ path: join(out, `${prefix}-${name}-${width}.png`) });
    console.log(`${name} ${width}px: ${info.length} cards, heights ${info.map((i) => i.h).join('/')}`);
    await page.close();
  }
}
await browser.close();
rmSync(root, { recursive: true, force: true });
if (failures) { console.log(`${failures} failure(s)`); process.exit(1); }
