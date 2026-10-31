import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { plain } from '../src/model/markdown.ts';
import { renderPage } from '../src/webview/render.ts';
import type { Route } from '../src/webview/types.ts';
import { makeData, makeFixture } from './fixture.ts';

// Task, requirement, scenario and ADR text is written with markdown backticks. In a page those must become real <code>, never a literal
// backtick (not in text and not in an attribute such as a tooltip); tree labels and hover text drop them as plain text.
const root = makeFixture();
const put = (rel: string, text: string): void => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), text); };
put('changes/ticks/proposal.md', '# Proposal\n\n## Why\n\nReaders need `LIST_QUERY` to stay fast.\n\n## What Changes\n\nAdd a `Cache_layer`.\n');
put('changes/ticks/tasks.md', [
  '## 1. Cache the `LIST_QUERY` result', '',
  '- [x] 1.1 Add a `Cache_layer` for `(USER_ID, ITEM_ID)`', '  - Spec: cache > Reads use the `Cache_layer`', '  - Test first: a `miss` then a `hit`', '  - Done when: `LIST_QUERY` runs once',
  '- [ ] 1.2 Drop the `legacy` path', '  - Files: `src/cache.ts`',
  '- [ ] 1.R Request code review for group 1', '  - Done when: findings fixed and `re-verified`', '',
].join('\n'));
put('changes/ticks/specs/cache.md', [
  '## ADDED Requirements', '', '### Requirement: Reads use the `Cache_layer`', '', 'Reads SHALL go through the `Cache_layer` when `LIST_QUERY` repeats.', '',
  '#### Scenario: Second read', '', '- **WHEN** `LIST_QUERY` runs twice', '- **THEN** the `Cache_layer` answers the second', '',
].join('\n'));
put('changes/ticks/adrs/use-cache.md', '---\ntitle: Use the `Cache_layer`\nstatus: Proposed\ndate: 2026-10-19\nchange: ticks\n---\n\n# Use the `Cache_layer`\n\n## Context\n\nThe `LIST_QUERY` is slow.\n\n## Decision\n\nWe add the `Cache_layer`.\n\n## Consequences\n\n- **Positive**: fast\n');
put('adrs/0004-cache.md', '---\ntitle: Cache the `LIST_QUERY`\nstatus: Accepted\ndate: 2026-10-19\n---\n\n# Cache the `LIST_QUERY`\n\n## Context\n\nSlow `LIST_QUERY`.\n\n## Decision\n\nAdd it.\n\n## Consequences\n\n- **Positive**: fast\n');

const routes: Route[] = [
  { page: 'overview' },
  { page: 'change', root, name: 'ticks' },
  ...['tasks', 'specs', 'adrs', 'proposal'].map((tab): Route => ({ page: 'change', root, name: 'ticks', tab })),
  { page: 'adrs', root },
  { page: 'adr', root, number: '0004' },
  { page: 'specs', root },
  { page: 'history', root },
  { page: 'roadmap', root },
  { page: 'branch', root },
];
const withoutAssets = (html: string): string => html.replace(/<(style|script)[\s\S]*?<\/\1>/g, '');

test('no page shows a literal backtick, in text or in any attribute', async () => {
  for (const route of routes) {
    const html = withoutAssets(await renderPage(await makeData(root, route), 'N', 'vscode-resource:'));
    assert.ok(!html.includes('`'), `${JSON.stringify(route)} shows a backtick: ...${html.slice(Math.max(0, html.indexOf('`') - 60), html.indexOf('`') + 60)}...`);
  }
});

test('the Tasks tab renders task text as <code>: title, Test first, Files, Done when, group title', async () => {
  const html = withoutAssets(await renderPage(await makeData(root, { page: 'change', root, name: 'ticks', tab: 'tasks' }), 'N', 'vscode-resource:'));
  for (const code of ['<code>Cache_layer</code>', '<code>(USER_ID, ITEM_ID)</code>', '<code>LIST_QUERY</code>', '<code>miss</code>', '<code>src/cache.ts</code>', '<code>re-verified</code>', '<code>legacy</code>']) {
    assert.ok(html.includes(code), `Tasks tab lacks ${code}`);
  }
});

test('requirement, scenario and ADR text renders as <code> where it is shown', async () => {
  const change = withoutAssets(await renderPage(await makeData(root, { page: 'change', root, name: 'ticks' }), 'N', 'vscode-resource:'));
  assert.ok(change.includes('<code>Cache_layer</code>'), 'change page shows the requirement, scenario or ADR title as code');
  const adr = withoutAssets(await renderPage(await makeData(root, { page: 'adr', root, number: '0004' }), 'N', 'vscode-resource:'));
  assert.ok(adr.includes('<code>LIST_QUERY</code>'), 'ADR page shows its title as code');
});

test('plain drops backticks and nothing else', () => {
  assert.equal(plain('Reads use the `Cache_layer`'), 'Reads use the Cache_layer');
  assert.equal(plain('a `b` and `(c, d)`'), 'a b and (c, d)');
  assert.equal(plain('no marks'), 'no marks');
});
