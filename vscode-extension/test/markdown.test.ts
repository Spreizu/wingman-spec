import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderMarkdown, splitSections } from '../src/model/markdown.ts';

test('escapes raw HTML and never emits script tags', () => {
  const html = renderMarkdown('<script>alert(1)</script> **bold**');
  assert.ok(!html.includes('<script'));
  assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(html.includes('<strong>bold</strong>'));
});

test('only http(s) links become anchors', () => {
  assert.ok(renderMarkdown('[a](https://x.dev/p?q=1&r=2)').includes('<a href="https://x.dev/p?q=1&amp;r=2">a</a>'));
  assert.ok(!renderMarkdown('[a](javascript:alert(1))').includes('<a '));
});

test('renders headings, code fences, nested lists, task lists and tables', () => {
  const html = renderMarkdown('# T\n\n```\n<b>\n```\n\n- a\n  - b\n- [x] done\n\n| h1 | h2 |\n|----|----|\n| c1 | c2 |\n');
  assert.ok(html.includes('<h1>T</h1>'));
  assert.ok(html.includes('<pre><code>&lt;b&gt;</code></pre>'));
  assert.ok(html.includes('<ul><li>a<ul><li>b</li></ul></li>'));
  assert.ok(html.includes('class="cb on"'));
  assert.ok(html.includes('<th>h1</th>'));
  assert.ok(html.includes('<td>c2</td>'));
});

test('HTML comments are dropped', () => {
  assert.equal(renderMarkdown('<!-- hidden -->\ntext'), '<p>text</p>');
});

test('splitSections ignores headings inside code fences', () => {
  const r = splitSections('intro\n\n## A\n\na body\n\n```\n## not a heading\n```\n\n## B\n\nb body\n');
  assert.equal(r.preamble, 'intro');
  assert.deepEqual(r.sections.map((s) => s.title), ['A', 'B']);
  assert.ok(r.sections[0]?.body.includes('## not a heading'));
});
