#!/usr/bin/env bash
# shellcheck disable=SC2016
# `check` runs the task's targeted tests, the full suite runs at `finish`: which test files a check picks (changed since the change
# began, tagged with the task's scenarios, named after its source files), the template from the test command or
# `commands: targeted:`, the note when none is known, `Check level: group | task` as opt-ins, and where injected faults are caught.
# Usage: tests/targeted.sh (needs openspec, node >= 18 and git on PATH).
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/ws.sh
. "$PKG/tests/lib/ws.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export WINGMAN_SPEC_TRACEABILITY=off GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
unset WINGMAN_SPEC_NO_CACHE WINGMAN_SPEC_CHECK_LEVEL WINGMAN_SPEC_TEST_RUN WINGMAN_SPEC_TEST_CMD WINGMAN_SPEC_TYPECHECK_CMD WINGMAN_SPEC_LINT_CMD WINGMAN_SPEC_TARGETED_TEST_CMD
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*  (rc=$rc)"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
cd "$T" && mkdir p && cd p && git init -q -b main
ws_init . && ws_set visual off
ws_cmd test 'npm test' && ws_cmd typecheck none && ws_cmd lint none
export TLOG="$T/ran"   # every test file appends its name when it runs
printf '{ "name": "p", "private": true, "scripts": { "test": "node --test" } }\n' > package.json
mkdir -p src test
for m in cart user other; do printf 'module.exports = () => "%s";\n' "$m" > "src/$m.js"; done
tfile() { printf 'const { test } = require("node:test"); const fs = require("node:fs");\nfs.appendFileSync(process.env.TLOG, "%s\\n");\ntest("%s", () => { if (fs.existsSync("%s")) throw new Error("broken"); });\n' "$1" "${2:-$1}" "${3:-/nonexistent}" > "test/$1.test.js"; }
tfile cart; tfile user; tfile slow; tfile scenario '[demo/greet] greets'
C=.wingman-spec/changes/demo
plan() {
  rm -rf "$C" .wingman-spec/runs "$TLOG"; mkdir -p "$C/specs"; [ -n "${1:-}" ] || set -- src/cart.js
  printf 'Size: M\nRisk: none\n\n## Why\nDemo.\n\n## What Changes\n- Adds a demo capability.\n\n## Edge cases\n- none named\n' > "$C/proposal.md"
  printf '## ADDED\n\n### Requirement: Demo\nThe system SHALL greet.\n\n#### Scenario: greet\n- **WHEN** asked\n- **THEN** it shows "hi"\n' > "$C/specs/demo.md"
  printf '## 1. Cart\n- [ ] 1.1 Cart total\n  - Files: %s\n  - Done when: `true` exits 0\n- [ ] 1.2 Greeting\n  - Spec: demo/greet\n  - Files: src/user.js\n  - Done when: `true` exits 0\n' "$1" > "$C/tasks.md"
  printf '## Capability inventory\n- demo\n' > "$C/app-map.md"; printf '## Decisions\nOne.\n\n## Implementation guide\nOne function.\n' > "$C/design.md"
  mkdir -p "$C/adrs"; printf -- '---\nstatus: none\n---\nNone.\n' > "$C/adrs/none.md"
  git add -A; git commit -qm plan >/dev/null 2>&1 || true
}
V="$WS"
J() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const c=(j.checks||[]).find((x)=>x.check===process.argv[2]);process.stdout.write(c?JSON.stringify(c):"")' "$1" "$2"; }
ran() { if [ -f "$TLOG" ]; then sort "$TLOG" | tr '\n' ' ' | sed 's/ $//'; fi; rm -f "$TLOG"; }
step() { $V next demo --per-task > "$T/n.json" 2>&1; echo "// $1" >> "src/$1.js"; $V check demo --reported done > "$T/c.json" 2> "$T/c.err"; rc=$?; }

echo "== the default: each check runs the task's targeted tests only"
plan; step cart; R=$(ran)
expect "1.1 (src/cart.js) runs test/cart.test.js only (ran: $R)" '[ $rc = 0 ] && [ "$R" = "cart" ]'
expect "the check names the template and why each file was picked" 'J "$T/c.json" targeted_tests | grep -q "\"template\":\"node --test {files}\"" && J "$T/c.json" targeted_tests | grep -q "\"named_after_sources\":1"'
step user; R=$(ran)
expect "1.2 (Spec: demo/greet, src/user.js) runs the tagged test, test/user.test.js and the test of src/cart.js, edited earlier in the change (ran: $R)" '[ $rc = 0 ] && [ "$R" = "cart scenario user" ]'
$V next demo --per-task > /dev/null 2>&1; $V finish demo > "$T/f.json" 2>&1; rc=$?; R=$(ran)
expect "finish runs the full suite once (ran: $R)" '[ $rc = 0 ] && [ "$R" = "cart scenario slow user" ]'

echo "== a test file the change adds or edits is targeted"
plan; tfile basket; step cart; R=$(ran)
expect "a new test file runs at the next check (ran: $R)" '[ $rc = 0 ] && [ "$R" = "basket cart" ]'
rm -f test/basket.test.js; git add -A; git commit -qm "drop basket" >/dev/null

echo "== injected faults: a targeted test fails at the check; any other test at finish"
plan; $V next demo --per-task > /dev/null 2>&1; tfile cart cart "$T/break-cart"; touch "$T/break-cart"; echo '// x' >> src/cart.js
$V check demo --reported done > "$T/c.json" 2>&1; rc=$?
expect "a broken test of the task's own file fails the check (exit 1)" '[ $rc = 1 ] && grep -q "tests failed" "$T/c.json"'
rm -f "$T/break-cart"; tfile cart; git add test/cart.test.js; git commit -qm cart >/dev/null
plan; tfile slow slow "$T/break-slow"; git add -A; git commit -qm "slow can break" >/dev/null; touch "$T/break-slow"
step cart; r1=$rc; step user; r2=$rc; rc="$r1/$r2"
expect "a break in a test no task targets passes both checks" '[ "$rc" = 0/0 ]'
$V next demo --per-task > /dev/null 2>&1; $V finish demo > "$T/f.json" 2>&1; rc=$?
expect "and finish catches it (exit 1)" '[ $rc = 1 ] && grep -q "tests failed" "$T/f.json"'
rm -f "$T/break-slow"

echo "== nothing targeted, an unknown runner, none"
plan src/other.js; $V next demo --per-task > /dev/null 2>&1; echo '// x' >> src/other.js
$V check demo --reported done > "$T/c.json" 2> "$T/c.err"; rc=$?; R=$(ran)
expect "no test targets the task: tests skipped with a note, Done when still runs (ran: $R)" '[ $rc = 0 ] && [ -z "$R" ] && grep -q "note: tests not run at this check: no test file targets" "$T/c.err" && J "$T/c.json" done_when | grep -q "\"ok\":true"'
git checkout -q -- src
plan; export WINGMAN_SPEC_TEST_CMD="make test"; step cart; R=$(ran)
expect "an unknown runner: tests skipped with a note naming the setting" '[ $rc = 0 ] && [ -z "$R" ] && grep -q "commands: targeted:" "$T/c.err"'
unset WINGMAN_SPEC_TEST_CMD
plan; export WINGMAN_SPEC_TARGETED_TEST_CMD='node --test --test-reporter=dot {files}'; step cart; R=$(ran)
expect "WINGMAN_SPEC_TARGETED_TEST_CMD sets the template (ran: $R)" '[ $rc = 0 ] && [ "$R" = cart ] && J "$T/c.json" targeted_tests | grep -q "test-reporter=dot"'
unset WINGMAN_SPEC_TARGETED_TEST_CMD
ws_cmd targeted none
plan; step cart; R=$(ran)
expect "commands.targeted: none skips them" '[ $rc = 0 ] && [ -z "$R" ] && grep -q "commands.targeted: none" "$T/c.err"'
sed -i '/^  targeted: none/d' .wingman-spec/wingman-spec.yaml; git add -A; git commit -qm cfg >/dev/null

echo "== the opt-ins run the full suite at check"
plan; export WINGMAN_SPEC_CHECK_LEVEL=group; step cart; R1=$(ran); step user; R2=$(ran)
expect "Check level: group: none at 1.1, the full suite at 1.2 (ran: '$R1' then '$R2')" '[ -z "$R1" ] && [ "$R2" = "cart scenario slow user" ]'
plan; export WINGMAN_SPEC_CHECK_LEVEL=task; step cart; R1=$(ran)
expect "Check level: task: the full suite at every check (ran: $R1)" '[ "$R1" = "cart scenario slow user" ]'
unset WINGMAN_SPEC_CHECK_LEVEL
echo "targeted: $PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
