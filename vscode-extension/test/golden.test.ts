// The editor re-implements a few CLI rules to show findings while typing. These cases are what the Go CLI returns for the
// same inputs (written by the Go tests: WINGMAN_UPDATE_GOLDEN=1 go test ./internal/anchors/ ./internal/testpaths/).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { analyze } from '../src/core/anchorDiff.ts';
import { placementFindings } from '../src/core/placement.ts';
import { isTestFile, isTestPath, isUiFile } from '../src/core/testpaths.ts';

const golden = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./golden/${name}`, import.meta.url), 'utf8')) as T;

interface AnchorCase {
  name: string;
  text: string;
  is_test: boolean;
  placement: { line: number; kind: string; keys: string[]; text: string }[];
  units: { key: string; line: number; start: number; end: number; whole: boolean; header: string; body: string }[];
}

test('marker placement matches the CLI on every golden case', () => {
  for (const c of golden<AnchorCase[]>('anchors.json')) {
    assert.deepEqual(placementFindings(c.text, c.is_test).map(({ line, kind, keys, text }) => ({ line, kind, keys, text })), c.placement, c.name);
  }
});

test('anchored units match the CLI on every golden case', () => {
  for (const c of golden<AnchorCase[]>('anchors.json')) {
    assert.deepEqual(analyze(c.text).map(({ key, line, start, end, whole, header, body }) => ({ key, line, start, end, whole, header, body })), c.units, c.name);
  }
});

test('test and UI file kinds match the CLI', () => {
  for (const p of golden<{ path: string; is_test_path: boolean; is_test_file: boolean; is_ui_file: boolean }[]>('testpaths.json')) {
    assert.deepEqual({ path: p.path, t: isTestPath(p.path), f: isTestFile(p.path), u: isUiFile(p.path) }, { path: p.path, t: p.is_test_path, f: p.is_test_file, u: p.is_ui_file });
  }
});

interface Grammar {
  specs: { name: string; text: string; reqs: { name: string; op: string; why: string | null; scenarios: string[] }[]; renames: [string, string][] }[];
  markers: { file: string; text: string; markers: { key: string; line: number }[] }[];
  approvals: { text: string; approval: string }[];
  adrs: { file: string; text: string; none: boolean }[];
}

test('spec grammar: requirements, sections, scenarios, renames and Why read the same as the CLI', async () => {
  const { parseSpec } = await import('../src/model/specParser.ts');
  const { whyOf } = await import('../src/model/requirementLines.ts');
  for (const c of golden<Grammar>('grammar.json').specs) {
    const ext = parseSpec(c.text);
    assert.deepEqual(
      ext.requirements.map((r) => ({ name: r.name, op: r.section === 'BASE' ? 'LIVING' : r.section, why: whyOf(r.raw), scenarios: r.scenarios.map((s) => s.name) })),
      c.reqs,
      c.name,
    );
    assert.deepEqual(ext.renames.map((r) => [r.from, r.to]), c.renames, `${c.name}: renames`);
  }
});

test('@spec markers are found at the same places as the CLI finds them', async () => {
  const { markersIn } = await import('../src/model/anchors.ts');
  for (const c of golden<Grammar>('grammar.json').markers) {
    assert.deepEqual(markersIn(c.text).map((m) => ({ key: m.key, line: m.line + 1 })), c.markers, c.file);
  }
});

test('the owner approval line and the "none" ADR are read the same way as the CLI', async () => {
  const { proposalApproval } = await import('../src/model/requirementLines.ts');
  const { parseSourceAdr } = await import('../src/model/adrSync.ts');
  const g = golden<Grammar>('grammar.json');
  for (const c of g.approvals) assert.equal(proposalApproval(c.text) ?? '', c.approval, JSON.stringify(c.text));
  for (const [i, c] of g.adrs.entries()) assert.equal(parseSourceAdr(c.file.replace(/\.md$/, ''), '/x/' + c.file, c.text).none, c.none, `case ${i}: ${c.file}`);
});
