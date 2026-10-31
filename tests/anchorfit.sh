#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# Anchor fit (openspec/scripts/anchorfit.cjs): too many anchors, anchors on boilerplate (the reported case: a login requirement anchored on a
# string line of another feature), crowded units, foreign files, no lexical overlap; the `over-anchored` drift gap, the problems finding with its
# `remove-marker` fix, `anchors prune`, anchor_fit / anchor_max levels, and the guard accepting a removed extra anchor.
# Usage: tests/anchorfit.sh (needs the wingman-spec binary, see tests/lib/ws.sh, git and node). Exit 0 when all pass.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/ws.sh
. "$PKG/tests/lib/ws.sh"
T="$(mktemp -d)"; [ -n "${KEEP:-}" ] || trap 'rm -rf "$T"' EXIT; [ -z "${KEEP:-}" ] || echo "kept: $T"
unset WINGMAN_SPEC_TRACEABILITY WINGMAN_SPEC_ANCHOR_GUARD WINGMAN_SPEC_ANCHOR_STALE WINGMAN_SPEC_ANCHOR_PLACEMENT WINGMAN_SPEC_TEST_EVIDENCE
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; if [ -n "${DEBUG:-}" ]; then head -c 1500 "$T/d.json" 2>/dev/null; echo; fi; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }
kinds() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log([...new Set((j.findings||[]).map(f=>f.kind))].sort().join(","))' "$1"; }
J() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));let v=j;for(const k of process.argv[2].split(".").filter(Boolean))v=v==null?v:v[k];console.log(typeof v==="object"?JSON.stringify(v):v)' "$1" "$2"; }
# gkinds <out>: the anchor guard's finding kinds against HEAD, sorted (a scratch change that lists no requirement)
gkinds() { mkdir -p .wingman-spec/changes/probe && printf '## Why\nProbe for the anchor guard.\n' > .wingman-spec/changes/probe/proposal.md
  $V guard probe --base HEAD --json 2>/dev/null | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log((j.findings||[]).map(f=>f.kind).sort().join(","))' > "$1"
  rm -rf .wingman-spec/changes/probe; }

# the fit rules on seeded code (the login / i18n regression, boilerplate per language, counts, crowded units, translation
# files, stacked markers, marker removal): go test ./internal/anchors -run "TestFit|TestRemoveMarkers"

cd "$T" && mkdir p && cd p && git init -q
ws_init .; cp .wingman-spec/wingman-spec.yaml "$T/init.yaml"
ws_cmd test none && ws_cmd typecheck none && ws_cmd lint none && ws_set visual off
V="$WS"
mkdir -p .wingman-spec/specs .wingman-spec/specs/checkout src/auth src/checkout/lang tests
cat > .wingman-spec/specs/auth.md <<'SPEC'
## Purpose
Lets people sign in to their account.

## Requirements

### Requirement: User login
The system SHALL let a registered user log in with email and password and reject a wrong password.
Why: The owner wants it to work, so that people can rely on it.

#### Scenario: Wrong password
- **WHEN** the user logs in with a wrong password
- **THEN** the login is rejected
SPEC
cat > .wingman-spec/specs/checkout.md <<'SPEC'
## Purpose
Takes the order and shows what it costs.

## Requirements

### Requirement: Order summary
The system SHALL show the order total with tax before payment.
Why: The owner wants it to work, so that people can rely on it.

#### Scenario: Total shown
- **WHEN** the user opens the summary
- **THEN** the total includes tax
SPEC
cat > src/auth/login.js <<'JS'
/**
 * Logs a user in.
 * @spec auth/user-login
 */
export function login(email, password) {
  const user = findUser(email);
  if (!user || !verify(password, user.hash)) throw new Error('wrong password');
  return session(user);
}
JS
cat > src/checkout/summary.js <<'JS'
/**
 * Shows the order total with tax.
 * @spec checkout/order-summary
 */
export function orderSummary(order) {
  return order.lines.reduce((s, l) => s + l.price, 0) * 1.2;
}
JS
cat > src/checkout/lang/en.js <<'JS'
export const messages = {
  'cart.title': 'Your cart',
  // @spec auth/user-login
  'login.error': 'Wrong email or password',
  'cart.total': 'Total',
};
JS
cat > tests/auth.test.js <<'JS'
import { test } from 'node:test';
test('[auth/wrong-password] rejects it', () => {});
JS
cat > tests/checkout.test.js <<'JS'
import { test } from 'node:test';
test('[checkout/total-shown] shows the total', () => {});
JS
git add -A && git commit -qm init
drift() { rc=0; $V drift > "$T/d.json" 2>/dev/null || rc=$?; }
gaps() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log([...(j.open||[]),...(j.advisory||[])].filter(g=>g.type==="over-anchored").map(g=>g.fit+"@"+g.files[0]+":"+g.line+(g.removable?"+":"-")).join(" "))' "$T/d.json"; }

echo "== drift and problems: the reported case"
drift
expect "drift lists the login marker on the string table as over-anchored (boilerplate-anchor), advisory (exit 0)" '[ "$rc" = 0 ] && [ "$(gaps)" = "boilerplate-anchor@src/checkout/lang/en.js:3+" ]'
expect "the gap says the marker is removable and names the prune command" 'grep -q "anchors prune" "$T/d.json"'
$V problems --json > "$T/p.json" 2>/dev/null
expect "problems: one over-anchored finding at the marker line with fix remove-marker for the right requirement" '[ "$(J "$T/p.json" findings.0.code)" = over-anchored ] && [ "$(J "$T/p.json" findings.0.line)" = 3 ] && [ "$(J "$T/p.json" findings.0.file | sed "s#.*/src#src#")" = src/checkout/lang/en.js ] && [ "$(J "$T/p.json" findings.0.fix.kind)" = remove-marker ] && [ "$(J "$T/p.json" findings.0.fix.key)" = auth/user-login ] && [ "$(J "$T/p.json" findings.0.severity)" = warning ]'
expect "the good anchors (login function, order summary) are not reported" '[ "$(J "$T/p.json" findings)" != "" ] && [ "$(node -e "console.log(JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\")).findings.filter(f=>f.code===\"over-anchored\").length)" "$T/p.json")" = 1 ]'

echo "== anchor_fit levels"
ws_set anchor_fit error; drift
expect "anchor_fit: error makes drift fail on it" '[ "$rc" = 1 ] && [ "$(J "$T/d.json" open.0.type)" = over-anchored ]'
ws_set anchor_fit off; drift
expect "anchor_fit: off hides it" '! grep -q "over-anchored" "$T/d.json"'
ws_set anchor_fit warn
WINGMAN_SPEC_ANCHOR_FIT=off drift
expect "WINGMAN_SPEC_ANCHOR_FIT=off beats the config file" '! grep -q "over-anchored" "$T/d.json"'
git checkout -q .wingman-spec/wingman-spec.yaml
expect "the config written by init documents anchor_fit and anchor_max" 'grep -q "^# anchor_fit: warn" "$T/init.yaml" && grep -q "^# anchor_max: 6" "$T/init.yaml"'
acc=0; $V drift decide "over-anchored:auth/user-login@src/checkout/lang/en.js:3" --accept --note "no" >/dev/null 2>&1 || acc=$?
expect "an over-anchored gap cannot be accepted (exit 2): the marker is removed or moved" '[ "$acc" = 2 ]'

echo "== anchors prune: removes marker lines only, never the last anchor"
$V anchors prune > "$T/pr.json"
expect "without --apply nothing changes and the removable marker is listed" '[ -z "$(git status --porcelain)" ] && [ "$(J "$T/pr.json" removable.0.file)" = src/checkout/lang/en.js ] && [ "$(J "$T/pr.json" removable.0.line)" = 3 ] && [ "$(J "$T/pr.json" applied)" = false ]'
git diff --quiet; cp src/checkout/lang/en.js "$T/en.before"
$V anchors prune --apply > "$T/pr.json"
expect "--apply removes the marker line, nothing else in the file" '[ "$(J "$T/pr.json" removed)" = 1 ] && [ "$(git diff --numstat | tr "\t" " ")" = "0 1 src/checkout/lang/en.js" ] && git diff | grep "^-[^-]" | grep -q "@spec auth/user-login" && ! grep -q "@spec" src/checkout/lang/en.js && grep -q "login.error" src/checkout/lang/en.js'
expect "the requirement is still anchored in the login function" 'grep -q "@spec auth/user-login" src/auth/login.js'
drift
expect "drift is clean of over-anchored gaps afterwards" '! grep -q "over-anchored" "$T/d.json"'
echo "-- the anchor guard accepts the removal (code unchanged, requirement still anchored)"
gkinds "$T/g.json"
expect "no guard finding for the pruned marker" '[ -z "$(cat "$T/g.json")" ]'
echo "-- control: an anchored unit that really left (code removed) is still reported"
cp src/auth/login.js "$T/login.keep"; git add -A; git commit -qm pruned
printf '// moved away\n' > src/auth/login.js; sed -i 's#^// moved away#// @spec auth/user-login\nexport function other() {\n  return 1;\n}#' src/auth/login.js
gkinds "$T/g2.json"
expect "replacing the anchored function is still reported (the unit was edited, not just unmarked)" 'grep -q "anchor-touched-unlisted" "$T/g2.json"'
cp "$T/login.keep" src/auth/login.js; git checkout -q -- . 

echo "== anchors prune: the last anchor stays, --select, anchor_max"
cat > src/checkout/lang/en.js <<'JS'
export const messages = {
  // @spec auth/user-login
  'login.error': 'Wrong email or password',
};
JS
rm src/auth/login.js; git add -A; git commit -qm "only the string marker"
$V anchors prune --apply > "$T/pr.json"
expect "a requirement's only code anchor is never removed, even on a string table" '[ "$(J "$T/pr.json" removed)" = 0 ] && grep -q "@spec auth/user-login" src/checkout/lang/en.js'
drift
expect "it is still reported (move it), as not removable" '[ "$(gaps)" = "boilerplate-anchor@src/checkout/lang/en.js:2-" ]'
cp "$T/login.keep" src/auth/login.js; cp "$T/en.before" src/checkout/lang/en.js; git add -A; git commit -qm back
mkdir -p src/auth; for i in 1 2 3; do printf '/**\n * @spec auth/user-login\n */\nexport function checkLoginStep%s(email, password) {\n  return verify(email, password, %s);\n}\n' $i $i > src/auth/step$i.js; done
git add -A; git commit -qm steps
drift
expect "5 code anchors (login, 3 steps, the string line): only the boilerplate one is listed (the count is below anchor_max and the others fit)" '[ "$(gaps)" = "boilerplate-anchor@src/checkout/lang/en.js:3+" ]'
expect "the function in login.js is never the one listed" '! gaps | grep -q "src/auth/login.js"'
$V anchors prune --select src/auth/step3.js:2,src/auth/login.js:2,src/nope.js:9 > "$T/pr.json"
expect "--select refuses what is not a finding (anchors that fit are never removed)" '[ "$(J "$T/pr.json" removable.length)" = 0 ] && [ "$(J "$T/pr.json" refused.length)" = 3 ]'
$V anchors prune --select src/checkout/lang/en.js:3 --apply >/dev/null
expect "--select --apply removes just that marker" '! grep -q "@spec" src/checkout/lang/en.js && grep -q "@spec" src/auth/step3.js && grep -q "@spec" src/auth/step2.js && grep -q "@spec" src/auth/login.js'
ws_set anchor_max 1; drift
expect "anchor_max: 1 with 4 good anchors in 4 functions: no finding (a count never flags anchors that fit)" '[ -z "$(gaps)" ]'
$V anchors prune --apply > "$T/pr.json"
expect "prune removes nothing, every good anchor stays" '[ "$(J "$T/pr.json" removed)" = 0 ] && [ "$(grep -rl "@spec auth/user-login" src | wc -l)" = 4 ]'
printf '// @spec auth/user-login\nexport function checkLoginStep2(email, password) {\n  // @spec auth/user-login\n  return verify(email, password, 2);\n}\n' > src/auth/step2.js
ws_set anchor_max 4; git add -A; git commit -qm "second marker in one function"; drift
expect "5 anchors (> anchor_max 4), 2 in one function: the second marker of that function is listed once, removable; nothing else" '[ "$(gaps)" = "over-anchored@src/auth/step2.js:3+" ]'
ws_set anchor_max 4; ws_set anchor_many '[auth/user-login]'; drift
expect "anchor_many: [auth/user-login] in the config silences the count" '[ -z "$(gaps)" ]'
sed -i '/^anchor_many:/d' .wingman-spec/wingman-spec.yaml; drift
expect "(control) without it the finding is back" '[ "$(gaps)" = "over-anchored@src/auth/step2.js:3+" ]'
$V anchors prune --apply > "$T/pr.json"
expect "prune removes that extra marker only: the function keeps one, the other three anchors stay" '[ "$(J "$T/pr.json" removed)" = 1 ] && [ "$(grep -c "@spec" src/auth/step2.js)" = 1 ] && [ "$(grep -rl "@spec auth/user-login" src | wc -l)" = 4 ]'
ws_set anchor_max 6
git checkout -q . ; git clean -fdq src

echo "== check: findings for a change's requirements are warnings (anchor_fit: warn)"
git checkout -q . ; git clean -fdq src
cat > src/checkout/lang/en.js <<'JS'
export const messages = {
  // @spec auth/user-login
  'login.error': 'Wrong email or password',
};
JS
git add -A; git commit -qm "string marker plus the function"
mkdir -p .wingman-spec/changes/edit; printf '## Why\nx\n' > .wingman-spec/changes/edit/proposal.md
$V anchors > "$T/an.json" 2>/dev/null; rc=$?
expect "anchors check lists the finding as a warning and passes" '[ $rc = 0 ] && grep -q "boilerplate-anchor" "$T/an.json" && ! grep -q "\"severity\": \"error\"" "$T/an.json"'
echo "== a task's Files line names the capability of a shared file"
cat > .wingman-spec/changes/edit/tasks.md <<'MD'
Size: S

## 1. Login

- [ ] 1.1 Wrong password is rejected
  - Spec: auth/user-login
  - Test first: tests/login.test.js
  - Files: src/lib/shared.js
  - Done when: login rejects a wrong password
MD
mkdir -p src/lib
cat > src/lib/shared.js <<'JS'
/** @spec checkout/order-summary */
export function orderTotal(order) {
  return order.total * 1.2;
}
JS
$V anchors prune > "$T/pr.json" 2>"$T/pr.err"; rc=$?
expect "prune runs with a plan present (tasks.md is parsed)" '[ $rc = 0 ] && ! grep -q "not a function" "$T/pr.err"'
$V drift > "$T/d.json" 2>/dev/null
expect "a marker for another capability in a file that the login task owns is a foreign-anchor gap" 'node -e "const j=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\"));process.exit([...(j.open||[]),...(j.advisory||[])].some(g=>g.type===\"over-anchored\"&&/shared.js/.test(g.key)&&g.fit===\"foreign-anchor\")?0:1)" "$T/d.json"'
echo
echo "anchorfit: passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
