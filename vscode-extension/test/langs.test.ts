import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { isScannable, isTestFile, isTestPath, markersIn, scanCode, tagsIn } from '../src/model/anchors.ts';
import { anchorProblems } from '../src/model/anchorView.ts';
import { reviewBranch } from '../src/model/branchReview.ts';
import type { ChangedFile } from '../src/model/branchReview.ts';
import { insightOf, lensText, warningsOf } from '../src/model/reqInsight.ts';
import { buildTrace } from '../src/model/traceability.ts';

// The same tables as tests/testpaths.sh: tests/lib/test-path-table.json and tests/lib/lang-fixtures.cjs (a source file with a
// `@spec` anchor and a tagged test under the conventional file name, per language).
const require = createRequire(import.meta.url);
const table = require('../../tests/lib/test-path-table.json') as { test: string[]; notTest: string[]; notTestFile: string[] };
const fx = require('../../tests/lib/lang-fixtures.cjs') as {
  LANGS: { id: string; cap: string; req: string; src: string; test: string; srcText: string; testText: string }[];
  files: () => Record<string, string>;
  spec: (l: unknown) => string;
};

test('test paths: the table of the scripts gives the same answers in the extension', () => {
  for (const f of table.test) assert.ok(isTestPath(f) && isTestFile(f), `${f} is a test`);
  for (const f of table.notTest) assert.ok(!isTestPath(f) && !isTestFile(f), `${f} is not a test`);
  for (const f of table.notTestFile) assert.ok(isTestPath(f) && !isTestFile(f), `${f} is under a test dir but carries no tag`);
});

const project = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'wsx-langs-'));
  const put = (f: string, text: string): void => {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  };
  put('wingman-spec.yaml', 'traceability: on\n');
  for (const l of fx.LANGS) put(`specs/${l.cap}.md`, fx.spec(l));
  for (const [f, t] of Object.entries(fx.files())) put(f, t);
  return dir;
};
const dir = project();
const model = buildTrace(dir, dir);

test('every language: source and test file are scanned, the tags and the anchor are found', () => {
  const scanned = new Map(scanCode(dir).map((s) => [s.file, s]));
  for (const l of fx.LANGS) {
    assert.ok(isScannable(l.src) && isScannable(l.test), l.id);
    assert.ok(isTestFile(l.test) && !isTestPath(l.src), l.id);
    assert.deepEqual(tagsIn(l.testText).map((t) => t.tag).sort(), [`${l.cap}/fails`, `${l.cap}/works`], l.id);
    assert.deepEqual(markersIn(l.srcText).map((m) => m.key), [`${l.cap}/${l.req}`], l.id);
    assert.deepEqual(scanned.get(l.test)?.tags.map((t) => t.tag).sort(), [`${l.cap}/fails`, `${l.cap}/works`], `${l.id} tags in ${l.test}`);
    assert.deepEqual(scanned.get(l.src)?.markers.map((m) => m.key), [`${l.cap}/${l.req}`], `${l.id} anchor in ${l.src}`);
  }
});

test('every language: the requirement shows 2/2 scenarios tested, no warning', () => {
  for (const l of fx.LANGS) {
    const i = insightOf(model, `${l.cap}/${l.req}`);
    assert.ok(i, l.id);
    assert.equal(i.scenarios.length, 2, l.id);
    assert.equal(i.testedCount, 2, `${l.id}: ${lensText(i)}`);
    assert.equal(i.code.length, 1, l.id);
    assert.ok(lensText(i).startsWith('2/2 scenarios tested'), `${l.id}: ${lensText(i)}`);
    assert.deepEqual(warningsOf(i).filter((w) => w.code === 'none-tested'), [], l.id);
    assert.deepEqual(anchorProblems(model, l.test, l.testText).filter((p) => p.code === 'unresolved-tag'), [], l.id);
  }
});

test('branch review: a branch that adds the source and the test of every language counts 2/2 per requirement', () => {
  const files: ChangedFile[] = fx.LANGS.flatMap((l) =>
    [[l.src, l.srcText], [l.test, l.testText]].map(([path = '', text = '']) => ({ path, from: path, status: 'A' as const, added: 3, removed: 0, oldText: undefined, newText: text })),
  );
  const r = reviewBranch({ root: dir, codeRoot: dir, branch: 'feature/x', base: 'origin/main', mergeBase: 'abc', model, findings: [], files });
  assert.equal(r.requirements.length, fx.LANGS.length);
  for (const l of fx.LANGS) {
    const q = r.requirements.find((x) => x.key === `${l.cap}/${l.req}`);
    assert.ok(q, l.id);
    assert.equal(q.scenarios, 2, l.id);
    assert.equal(q.tested, 2, l.id);
    assert.ok(!q.untested, l.id);
    assert.ok(q.via.includes('code') && q.via.includes('test'), `${l.id}: ${q.via.join(',')}`);
  }
});

test('the tag is found inside a PHPUnit docblock, a #[TestDox] argument, a JUnit @DisplayName string and a C# DisplayName', () => {
  const lines: [string, string][] = [
    ['    /** [lang-php/works] says hi */', 'lang-php/works'],
    ["    #[TestDox('[lang-php/fails] rejects')]", 'lang-php/fails'],
    ['  @DisplayName("[lang-java/works] says hi")', 'lang-java/works'],
    ['    [Fact(DisplayName = "[lang-csharp/works] says hi")]', 'lang-csharp/works'],
    ['    fun `[lang-kotlin/works] says hi`() {}', 'lang-kotlin/works'],
  ];
  for (const [line, tag] of lines) assert.deepEqual(tagsIn(line).map((t) => t.tag), [tag], line);
});
