// Headless Chromium check of the Timeline tab on the change page and the archived change page: entries in time order, one line
// each, details collapsed until clicked, the decision entry, the idle marker; then a live refresh (the file grows, the page
// is rendered again). Needs Playwright (not part of `node --test`):
//   PLAYWRIGHT_NODE_MODULES=<node_modules with playwright> [PLAYWRIGHT_BROWSERS_PATH=...] \
//   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON test/browser/timeline.mjs <screenshot-dir> [prefix]
// Screenshots are written for looking at, never committed or compared.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { renderPage } from '../../src/webview/render.ts';
import { makeData, makeFixture } from '../fixture.ts';

const out = process.argv[2] ?? '/tmp/timeline-shots';
const prefix = process.argv[3] ?? 'timeline';
mkdirSync(out, { recursive: true });
const nm = process.env.PLAYWRIGHT_NODE_MODULES;
if (!nm) { console.log('skipped: PLAYWRIGHT_NODE_MODULES is not set'); process.exit(0); }
const { chromium } = createRequire(join(nm, 'x.js'))('playwright');

const at = (h, m, s) => `2026-10-29T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}+02:00`;
const L = (o) => JSON.stringify({ session: 'agent-1', ...o }) + '\n';
const RUN = [
  L({ at: at(9, 0, 0), event: 'run-start', summary: 'run started (next)' }),
  L({ at: at(9, 0, 1), event: 'next', task: '1.1', ok: true, seconds: 0.4, summary: 'picked 1.1 Sign-in form', details: { files: ['src/auth/form.ts'] } }),
  L({ at: at(9, 6, 40), event: 'check-start', task: '1.1', summary: 'checking 1.1' }),
  L({ at: at(9, 6, 43), event: 'check', task: '1.1', ok: false, seconds: 2.6, summary: 'failed: 1 targeted test failed', details: { failures: ['tests failed (exit 1): `auth/form.test.ts` expects an error under the password field'], output_tail: 'x shows an error under the password field\n  AssertionError: expected "" to equal "Required"' } }),
  L({ at: at(9, 6, 43), event: 'fix-round', task: '1.1', summary: 'fix round 2 of 3' }),
  L({ at: at(9, 9, 2), event: 'check-start', task: '1.1', summary: 'checking 1.1' }),
  L({ at: at(9, 9, 4), event: 'check', task: '1.1', ok: true, seconds: 1.9, summary: 'all checks passed' }),
  L({ at: at(9, 9, 4), event: 'tick', task: '1.1', ok: true, summary: 'ticked 1.1' }),
  L({ at: at(9, 41, 10), event: 'decision', ok: true, summary: 'plan changed: 3 changes (lock the account after 5 failed attempts)', details: { changes: ['scenario added: auth/Sign in/locked after 5 failed attempts', 'task added: 1.3 Lock the account', 'design.md changed'], reason: 'lock the account after 5 failed attempts, asked by the owner on review', seen_at: 'next' } }),
  L({ at: at(9, 41, 11), event: 'next', task: '1.2', ok: true, seconds: 0.3, summary: 'picked 1.2 Session cookie' }),
];
const LIVE = L({ at: at(9, 47, 30), event: 'check-start', task: '1.2', summary: 'checking 1.2' });

const root = makeFixture();
const runs = join(root, 'openspec', '.apply-runs', 'demo'); mkdirSync(runs, { recursive: true });
writeFileSync(join(runs, 'timeline.jsonl'), RUN.join(''));
writeFileSync(join(root, 'openspec', 'changes', 'archive', '2026-09-30-first-cut', 'timeline.jsonl'), RUN.join('') + L({ at: at(10, 2, 0), event: 'finish', ok: true, seconds: 61.2, summary: 'change verified' }) + L({ at: at(10, 3, 5), event: 'archive', ok: true, seconds: 0.8, summary: 'archived' }));

const browser = await chromium.launch();
let failures = 0;
const fail = (m) => { failures++; console.log(`FAIL ${m}`); };
async function show(route, name, width, expand, idles = 1) {
  const html = (await renderPage(await makeData(root, route), 'NONCE', 'vscode-resource:')).replace(/<script[\s\S]*?<\/script>/g, '');
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  await page.setContent(html);
  await page.evaluate(() => document.querySelectorAll('[data-pane]').forEach((p) => p.classList.toggle('active', p.getAttribute('data-pane') === 'timeline')));
  const rows = await page.$$eval('[data-pane="timeline"] .tl-entry', (els) => els.map((e) => ({ time: e.querySelector('.tl-time')?.textContent, step: e.querySelector('.tl-step')?.textContent, open: e.querySelector('details')?.open ?? null, decision: e.classList.contains('tl-decision'), h: Math.round(e.querySelector('.tl-line').getBoundingClientRect().height) })));
  const times = rows.map((r) => r.time);
  if (times.join() !== [...times].sort().join()) fail(`${name} ${width}px: not in time order (${times.join(', ')})`);
  if (rows.some((r) => r.open)) fail(`${name} ${width}px: a detail is open before a click`);
  if (rows.filter((r) => r.decision).length !== 1) fail(`${name} ${width}px: expected one decision entry`);
  if (width >= 900 && rows.some((r) => r.h > 30)) fail(`${name} ${width}px: an entry is more than one line (${rows.map((r) => r.h).join(',')})`);
  const idle = await page.$$eval('[data-pane="timeline"] .tl-idle', (els) => els.map((e) => e.textContent));
  if (idle.length !== idles) fail(`${name} ${width}px: expected ${idles} idle marker(s), got ${JSON.stringify(idle)}`);
  if (expand) {
    for (const i of expand) await page.locator('[data-pane="timeline"] .tl-entry').nth(i).locator('summary').click();
    const open = await page.$$eval('[data-pane="timeline"] .tl-entry details', (els) => els.filter((d) => d.open).length);
    if (open !== expand.length) fail(`${name} ${width}px: a click did not expand the details (${open} open)`);
  }
  await page.screenshot({ path: join(out, `${prefix}-${name}-${width}.png`), fullPage: true });
  console.log(`  ${name} ${width}px: ${rows.length} entries, idle ${JSON.stringify(idle)}`);
  await page.close();
  return rows.length;
}
await show({ page: 'change', root, name: 'demo' }, 'change', 900);
await show({ page: 'change', root, name: 'demo' }, 'change-expanded', 900, [3, 8]);
await show({ page: 'change', root, name: 'demo' }, 'change', 375);
const archived = await show({ page: 'archived', root, name: '2026-09-30-first-cut' }, 'archived', 900, undefined, 2);
if (archived !== RUN.length + 2) fail(`archived: expected ${RUN.length + 2} entries, got ${archived}`);
appendFileSync(join(runs, 'timeline.jsonl'), LIVE); // what the watcher reports: the page renders again from the file
const after = await show({ page: 'change', root, name: 'demo' }, 'change-live', 900);
if (after !== RUN.length + 1) fail(`live refresh: expected ${RUN.length + 1} entries, got ${after}`);
await browser.close();
console.log(failures ? `timeline: ${failures} failure(s)` : 'timeline: passed');
process.exit(failures ? 1 : 0);
