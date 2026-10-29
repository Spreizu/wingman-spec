import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { markersIn } from '../src/model/anchors.ts';
import { proposalApproval, whyOf } from '../src/model/requirementLines.ts';
import { lintSpec } from '../src/model/lint.ts';
import { parseSpec } from '../src/model/specParser.ts';

// The editor must agree with the scripts. Where a list or grammar is imported from the scripts (visual blocks, plan rules, size caps,
// file kinds) there is nothing to drift; this file covers what the extension still parses itself, and runs the scripts' own
// `problems --json` against the editor's lint on one fixture that uses every documented field.
const require = createRequire(import.meta.url);
const scripts = join(import.meta.dirname, '..', '..', 'project-template', 'openspec', 'scripts');
const T = require(join(scripts, 'traceability.cjs')) as {
  parseSpec: (t: string) => { reqs: { name: string; op: string; scenarios: { name: string }[]; why: string | null }[]; renames: { from: string; to: string }[] };
  proposalApproval: (t: string) => string | null;
  scanAnchors: (root: string, only?: string[]) => { key: string; file: string; line: number }[];
};

const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'wsx-parity-'));
  dirs.push(d);
  return d;
};
const put = (root: string, f: string, text: string): void => {
  mkdirSync(dirname(join(root, f)), { recursive: true });
  writeFileSync(join(root, f), text);
};

const VISUAL_ALL = `## Purpose
One capability that shows every visual-block field, so the editor and the scripts can be compared on it.

## ADDED Requirements

### Requirement: Gated page
The page SHALL be shown to admins only.

Why: Admins need it, so that other users stay out of the admin area.

#### Scenario: Admin sees it
- **WHEN** an admin opens it
- **THEN** it shows

\`\`\`visual
route: /admin
component: AdminPage
viewports: 375, 1280
reference: design/admin.png @1280
role: admin
key: [data-testid="panel"]
absent: [data-testid="login"]
redirects-to: /admin
overlay: [role="dialog"]
ignore: a11y:
ignore: runtime:console-error
ignore-http: /static/images/
expect: [data-testid="panel"] background-color ~ #fff
state: open
  do: click [data-testid="panel"]
  key: [data-testid="menu"]
  absent: [data-testid="x"]
  expect: [data-testid="menu"] below [data-testid="panel"]
state: typed
  do: fill [data-testid="q"] = abc
  do: press Enter
  do: hover [data-testid="panel"]
  do: wait 100
  do: goto /admin
  do: storage k = v
  do: reload
\`\`\`
`;

function project(spec: string, withRole = true): string {
  const root = tmp();
  cpSync(scripts, join(root, 'openspec', 'scripts'), { recursive: true });
  put(root, 'openspec/config.yaml', `schema: wingman-spec\nvisual:\n  command: npm start\n  url: http://localhost:3000\n${withRole ? '  roles:\n    admin:\n      login: /login\n' : ''}`);
  put(root, 'openspec/changes/c1/proposal.md', '## Why\nx\n');
  put(root, 'openspec/changes/c1/design/admin.png', 'png');
  put(root, 'openspec/changes/c1/specs/cap-a/spec.md', spec);
  return root;
}

function problems(root: string): { code: string; severity: string; message: string; line: number }[] {
  const r = spawnSync(process.execPath, ['openspec/scripts/verify-task.cjs', 'problems', '--json'], { cwd: root, encoding: 'utf8' });
  return (JSON.parse(r.stdout) as { findings: { code: string; severity: string; message: string; line: number }[] }).findings;
}

const editorErrors = (text: string): string[] => lintSpec(text).filter((i) => i.severity === 'error' || /visual|unknown/i.test(i.message)).map((i) => i.message);

test('a visual block with every field (role, absent, redirects-to, state, overlay, expect...): neither the scripts nor the editor report an unknown field', () => {
  const root = project(VISUAL_ALL);
  const script = problems(root).filter((f) => f.code === 'visual');
  assert.deepEqual(script.map((f) => f.message), [], 'scripts: no visual finding');
  const editor = lintSpec(VISUAL_ALL).filter((i) => /visual block|unknown/i.test(i.message));
  assert.deepEqual(editor.map((i) => i.message), [], 'editor: no visual finding');
});

test('regression: a visual block that uses `role:` is not "unknown field"', () => {
  const spec = `## ADDED Requirements\n\n### Requirement: Gated\nIt SHALL gate.\n\n#### Scenario: Admin\n- **WHEN** x\n- **THEN** y\n\n\`\`\`visual\nroute: /admin\nrole: admin\nkey: [data-testid="a"]\n\`\`\`\n`;
  assert.ok(!lintSpec(spec).some((i) => /unknown field/.test(i.message)));
});

test('bad blocks are errors in both: unknown field, indented role, two roles, a bad step, no scenario around the block', () => {
  const block = (lines: string): string => `## ADDED Requirements\n\n### Requirement: R\nIt SHALL.\n\n#### Scenario: S\n- **WHEN** x\n- **THEN** y\n\n\`\`\`visual\nroute: /\nkey: [data-testid="a"]\n${lines}\n\`\`\`\n`;
  const cases: [string, RegExp][] = [
    ['colour: red', /unknown field "colour"/],
    ['state: s\n  role: admin', /role/],
    ['role: admin\nrole: editor', /one role/],
    ['state: s\n  do: dance [x]', /do:|step|dance/],
    ['ignore:', /empty ignore/],
    ['ignore: :', /matches nothing useful/],
    ['ignore: layout:key-missing', /ignore "layout:key-missing" is refused/],
    ['ignore: role:forbidden-visible', /refused/],
    ['ignore: layout:', /refused/],
    ['ignore-http:', /empty ignore-http/],
    ['ignore-http: ab', /ignore-http/],
    ['state: s\n  ignore: a11y:', /belongs to the whole block/],
  ];
  for (const [lines, re] of cases) {
    const root = project(block(lines));
    const script = problems(root).filter((f) => f.code === 'visual' && f.severity === 'error');
    const editor = lintSpec(block(lines)).filter((i) => i.severity === 'error');
    assert.ok(script.some((f) => re.test(f.message)), `scripts report ${lines}`);
    assert.ok(editor.some((i) => re.test(i.message)), `editor reports ${lines}: ${editor.map((i) => i.message).join(' / ')}`);
  }
  const outside = '## ADDED Requirements\n\n### Requirement: R\nIt SHALL.\n\n```visual\nroute: /\n```\n';
  assert.ok(editorErrors(outside).some((m) => /scenario/i.test(m)));
  assert.ok(problems(project(outside)).some((f) => f.code === 'visual' && /scenario/i.test(f.message)));
});

const SPECS: Record<string, string> = {
  fenced: '## Purpose\nlong enough purpose text to pass the fifty character minimum here ok\n\n## ADDED Requirements\n\n### Requirement: A\nThe A SHALL x.\n\nWhy: Users want a, so they can pay.\n\n#### Scenario: One\n- **WHEN** a\n- **THEN** b\n\n```md\n### Requirement: Fake\n#### Scenario: Fake scen\n```\n',
  why: '## ADDED Requirements\n\n### Requirement: A\nThe A SHALL x.\n\n- **Why**: The **owner** wants x, because y.\n\n#### Scenario: One\nWhy: ignored\n',
  living: '## Requirements\n\n### Requirement: B\nB MUST y.\n\n#### Scenario: S\n\n## Notes\n\n### Requirement: C\nC SHALL z\n#### Scenario: T\n',
  removed: '## REMOVED Requirements\n\n### Requirement: Gone\n**Reason**: x\n\n## RENAMED Requirements\n\n- FROM: `### Requirement: Old`\n- TO: `### Requirement: New`\n',
  modified: '## MODIFIED Requirements\n\n### Requirement: M\nM SHALL z.\n\n#### Scenario: One\n#### Scenario: Two\n',
};

test('spec grammar: requirements, sections, scenarios, renames and Why read the same as in the scripts', () => {
  for (const [name, text] of Object.entries(SPECS)) {
    const ext = parseSpec(text);
    const scr = T.parseSpec(text);
    assert.deepEqual(
      ext.requirements.map((r) => [r.name, r.scenarios.map((s) => s.name), whyOf(r.raw)]),
      scr.reqs.map((r) => [r.name, r.scenarios.map((s) => s.name), r.why]),
      name,
    );
    assert.deepEqual(
      ext.requirements.map((r) => (r.section === 'BASE' ? 'LIVING' : r.section)),
      scr.reqs.map((r) => r.op),
      `${name}: sections`,
    );
    assert.deepEqual(ext.renames.map((r) => [r.from, r.to]), scr.renames.map((r) => [r.from, r.to]), `${name}: renames`);
  }
});

test('@spec markers are found at the same places as in the scripts', () => {
  const root = tmp();
  const files: Record<string, string> = {
    'src/a.ts': '// @spec cap-a/one\nexport const a = 1;\n',
    'src/b.py': '# @spec cap-a/one, cap-b/two-x\nx = 1\n',
    'src/c.go': '/* @spec cap-a/three */\npackage c\n// not a marker: @spec nothing\n',
    'src/d.sql': '-- @spec cap-d/four\nselect 1;\n',
    'src/e.rb': 'x = 1 # @spec cap-e/five\n',
  };
  for (const [f, t] of Object.entries(files)) put(root, f, t);
  const script = T.scanAnchors(root, Object.keys(files)).map((m) => `${m.file}:${m.line}:${m.key}`).sort();
  const editor = Object.entries(files).flatMap(([f, t]) => markersIn(t).map((m) => `${f}:${m.line + 1}:${m.key}`)).sort();
  assert.deepEqual(editor, script);
});

test('the owner approval line is read the same way by the script and the editor', () => {
  const texts = ['## Why\nx\nOwner approval: Maria, 2026-10-01\n', 'Owner approval:\n', '```\nOwner approval: Fenced, 2026-10-01\n```\n', '<!-- Owner approval: Hidden, 2026-10-01 -->\n', '- **Owner approval**: Jo, 2026-10-02\r\n', 'nothing here\n'];
  for (const t of texts) assert.equal(proposalApproval(t), T.proposalApproval(t), JSON.stringify(t));
});

test('"none" ADR is defined the same way by the scripts and the editor', async () => {
  const quality = require(join(scripts, 'quality.cjs')) as { isNoneAdr: (f: string, t: string) => boolean; sizeFacts: (d: string) => { adrs: string[] } };
  const { parseSourceAdr } = await import('../src/model/adrSync.ts');
  const real = '---\ntitle: T\nstatus: Accepted\ndate: 2026-10-20\n---\n\nbody\n';
  const cases: [string, string][] = [
    ['none.md', ''], ['None.md', real], ['x.md', '---\nstatus: none\n---\n'], ['x.md', '---\nstatus: None\n---\n'], ['x.md', '---\nstatus: "none"\n---\n'],
    ['x.md', real], ['x.md', real + 'status: none\n'], ['x.md', 'status: none\n'], ['none.md', '---\nstatus: Accepted\n---\n'], ['x.md', '---\nstatus: nonexistent\n---\n'],
  ];
  const root = tmp();
  put(root, 'proposal.md', '# P\n');
  for (const [i, [f, t]] of cases.entries()) {
    const slug = f.replace(/\.md$/, '');
    assert.equal(parseSourceAdr(slug, '/x/' + f, t).none, quality.isNoneAdr(f, t), `case ${i}: ${f}`);
    // the same file through the size check, which lists only real ADRs
    const dir = join(root, `c${i}`);
    put(dir, `adrs/${f}`, t);
    assert.equal(quality.sizeFacts(dir).adrs.length === 0, quality.isNoneAdr(f, t), `size case ${i}: ${f}`);
  }
});
