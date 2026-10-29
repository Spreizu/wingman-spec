import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { anchorProblems } from '../src/model/anchorView.ts';
import { applyEdits } from '../src/model/markerFix.ts';
import { coveredByLive, fixesFor } from '../src/model/problems.ts';
import { buildTrace } from '../src/model/traceability.ts';
import { findingOf } from '../src/model/verifier.ts';

// Anchor fit in the editor (anchorfit.cjs is imported, not copied): the reported case, a login requirement anchored on a string line of
// another feature, is shown on the marker, listed as a gap with the key `drift` uses, and has a quick action that removes just the marker.
const scripts = join(import.meta.dirname, '..', '..', 'project-template', 'openspec', 'scripts');
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const put = (root: string, f: string, text: string): void => {
  mkdirSync(dirname(join(root, f)), { recursive: true });
  writeFileSync(join(root, f), text);
};
const SPEC = (name: string, text: string, scenario: string): string => `## Purpose\nOne capability of the fixture project.\n\n## Requirements\n\n### Requirement: ${name}\n${text}\nWhy: The fixture project needs it, so the tests have one.\n\n#### Scenario: ${scenario}\n- **WHEN** it happens\n- **THEN** it holds\n`;
const EN = "export const messages = {\n  'cart.title': 'Your cart',\n  // @spec auth/user-login\n  'login.error': 'Wrong email or password',\n};\n";
const LOGIN = '/**\n * @spec auth/user-login\n */\nexport function login(email, password) {\n  const user = findUser(email);\n  if (!user || !verify(password, user.hash)) throw new Error("wrong password");\n  return session(user);\n}\n';

function project(withLogin: boolean, config = ''): string {
  const root = mkdtempSync(join(tmpdir(), 'wsx-fit-'));
  dirs.push(root);
  put(root, 'openspec/specs/auth/spec.md', SPEC('User login', 'The system SHALL let a registered user log in with email and password and reject a wrong password.', 'Wrong password'));
  put(root, 'openspec/specs/checkout/spec.md', SPEC('Order summary', 'The system SHALL show the order total with tax before payment.', 'Total shown'));
  put(root, 'openspec/config.yaml', `traceability: on\n${config}`);
  put(root, 'src/checkout/lang/en.js', EN);
  if (withLogin) put(root, 'src/auth/login.js', LOGIN);
  put(root, 'src/checkout/summary.js', '/**\n * @spec checkout/order-summary\n */\nexport function orderSummary(order) {\n  return order.total * 1.2;\n}\n');
  return root;
}

test('the model lists the string-table marker as an over-anchored gap, removable, keyed like drift', () => {
  const m = buildTrace(project(true), project(true));
  const gaps = m.gaps.filter((g) => g.type === 'over-anchored');
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]?.key, 'over-anchored:auth/user-login@src/checkout/lang/en.js:3');
  assert.deepEqual(gaps[0]?.fit, { kind: 'boilerplate-anchor', removable: true });
  assert.equal(gaps[0]?.line, 2);
  assert.equal(m.fit.level, 'warn');
});

test('as the requirement\'s only anchor it is shown but not removable', () => {
  const r = project(false);
  const g = buildTrace(r, r).gaps.find((x) => x.type === 'over-anchored');
  assert.deepEqual(g?.fit, { kind: 'boilerplate-anchor', removable: false });
});

test('anchor_fit: off removes the gaps; anchor_fit: error raises the diagnostic to an error; the good anchors are never listed', () => {
  const off = project(true, 'anchor_fit: off\n');
  assert.equal(buildTrace(off, off).gaps.filter((g) => g.type === 'over-anchored').length, 0);
  const err = project(true, 'anchor_fit: error\n');
  const m = buildTrace(err, err);
  const p = anchorProblems(m, 'src/checkout/lang/en.js', EN).filter((x) => x.code === 'over-anchored');
  assert.equal(p.length, 1);
  assert.equal(p[0]?.severity, 'error');
  assert.deepEqual(anchorProblems(m, 'src/auth/login.js', LOGIN), []);
  assert.deepEqual(anchorProblems(m, 'src/checkout/summary.js', '/**\n * @spec checkout/order-summary\n */\nexport function orderSummary(order) {}\n'), []);
});

test('the marker diagnostic sits on the marker line and is dropped when the line moved since the last save', () => {
  const r = project(true);
  const m = buildTrace(r, r);
  const p = anchorProblems(m, 'src/checkout/lang/en.js', EN).find((x) => x.code === 'over-anchored');
  assert.equal(p?.line, 2);
  assert.equal(p?.removable, true);
  assert.match(p?.message ?? '', /string-table entry/);
  assert.deepEqual(anchorProblems(m, 'src/checkout/lang/en.js', `// new first line\n${EN.replace('// @spec auth/user-login\n', '')}`).filter((x) => x.code === 'over-anchored'), []);
});

test('the quick fix removes the marker line and nothing else; the verifier finding with fix remove-marker is accepted', () => {
  const f = findingOf({ source: 'drift', code: 'over-anchored', severity: 'warning', message: 'm', file: '/p/en.js', line: 3, col: 3, length: 20, fix: { kind: 'remove-marker', key: 'auth/user-login' } });
  assert.equal(f?.fix?.kind, 'remove-marker');
  assert.ok(f);
  const fixes = fixesFor(f, { text: EN, rel: 'src/checkout/lang/en.js' });
  assert.equal(fixes.length, 1);
  assert.equal(applyEdits(EN, fixes[0]!.edits!), EN.replace('  // @spec auth/user-login\n', ''));
  const multi = '// @spec auth/user-login, checkout/order-summary\nconst a = 1;\n';
  const g = fixesFor({ ...f, line: 1 }, { text: multi, rel: 'a.js' });
  assert.ok(g[0]?.edits, 'a marker line with several keys still offers an edit');
});

test('the code view already shows over-anchored: the problems panel does not list it twice', () => {
  const f = findingOf({ source: 'drift', code: 'over-anchored', severity: 'warning', message: 'm', file: '/p/en.js', line: 3 });
  assert.ok(f);
  assert.equal(coveredByLive(f, true), true);
  assert.equal(coveredByLive(f, false), false);
});

test('the script and the editor agree: same over-anchored gaps (kind, file, line, key) on the same project', () => {
  const r = project(true);
  put(r, 'openspec/config.yaml', 'traceability: on\nanchor_max: 4\n');
  // a second anchor of login far from its code, a crowd of anchors, and a foreign one: everything the lint knows
  put(r, 'src/auth/step1.js', '/**\n * @spec auth/user-login\n */\nexport function loginStep1(email, password) {\n  return verify(email, password, 1);\n}\n');
  put(r, 'src/auth/step2.js', '/**\n * @spec auth/user-login\n */\nexport function loginStep2(email, password) {\n  return verify(email, password, 2);\n}\n');
  put(r, 'src/auth/step3.js', '/**\n * @spec auth/user-login\n */\nexport function loginStep3(email, password) {\n  // @spec auth/user-login\n  return verify(email, password, 3);\n}\n');
  put(r, 'src/checkout/pay.js', '/**\n * @spec auth/user-login\n */\nexport function pay(order) {\n  return charge(order);\n}\n');
  // a task whose Files line owns a neutral path for the login capability: the task Files rule must agree in both
  put(r, 'openspec/changes/edit/proposal.md', '## Why\nx\n');
  put(r, 'openspec/changes/edit/tasks.md', 'Size: S\n\n## 1. Login\n\n- [ ] 1.1 Wrong password is rejected\n  - Spec: auth/user-login\n  - Test first: tests/login.test.js\n  - Files: src/lib/shared.js\n  - Done when: login rejects a wrong password\n');
  put(r, 'src/lib/shared.js', '/**\n * @spec checkout/order-summary\n */\nexport function orderTotal(order) {\n  return order.total * 1.2;\n}\n');
  cpSync(scripts, join(r, 'openspec', 'scripts'), { recursive: true });
  const run = spawnSync('node', ['openspec/scripts/verify-task.cjs', 'drift'], { cwd: r, encoding: 'utf8' });
  const j = JSON.parse(run.stdout) as { open?: { type: string; key: string; fit?: string }[]; advisory?: { type: string; key: string; fit?: string }[] };
  const fromScript = [...(j.open ?? []), ...(j.advisory ?? [])].filter((g) => g.type === 'over-anchored').map((g) => `${g.key}|${g.fit}`).sort();
  const fromModel = buildTrace(r, r).gaps.filter((g) => g.type === 'over-anchored').map((g) => `${g.key}|${g.fit?.kind}`).sort();
  assert.equal(fromScript.length, 4, `expected the string line, two foreign files and the repeated marker (the count is above anchor_max 4 and one anchor is weak), got ${fromScript.join(', ')}`);
  assert.deepEqual(fromModel, fromScript);
});
