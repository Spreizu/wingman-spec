#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# The deterministic checks: `lint --text` (located plan problems), `trace` (scenarios without a test, tags without a
# scenario), `run-checks` (logs in files, parsed failures, a timeline event) and the archive gate (each condition refuses
# with its own message and writes nothing; `sync --rebase` re-pins a moved living spec). The merge rules are Go tests:
# go test ./internal/spec -run TestMerge.
# Usage: tests/deterministic.sh (needs the wingman-spec binary, see tests/lib/ws.sh, git and node). Exit 0 when all pass.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/ws.sh
. "$PKG/tests/lib/ws.sh"
T="$(mktemp -d)"; [ -n "${KEEP:-}" ] || trap 'rm -rf "$T"' EXIT; [ -z "${KEEP:-}" ] || echo "kept: $T"
unset WINGMAN_SPEC_TRACEABILITY WINGMAN_SPEC_ANCHOR_GUARD WINGMAN_SPEC_TEST_CMD WINGMAN_SPEC_TYPECHECK_CMD WINGMAN_SPEC_LINT_CMD WINGMAN_SPEC_NO_CACHE
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid WINGMAN_SPEC_SESSION=s1
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }
J() { node -e 'let v=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));for(const k of process.argv[2].split("."))v=v==null?v:v[k];process.stdout.write(typeof v=="object"?JSON.stringify(v):String(v))' "$1" "$2"; }
V="$WS"

cd "$T" && mkdir p && cd p && git init -q -b main
ws_init . && ws_set visual off && ws_cmd typecheck none && ws_cmd lint none && ws_cmd test "node --test"
C=.wingman-spec/changes/cart
mkdir -p "$C/specs" src test
printf 'Size: S\nRisk: none\n\n## Why\nPeople want a cart.\n\n## What Changes\n- A cart total.\n\n## Edge cases\n- an empty cart -> cart/empty-total\n' > "$C/proposal.md"
cat > "$C/specs/cart.md" <<'MD'
## ADDED

### Requirement: Total
The system SHALL add up the cart.
Why: A shopper wants to see what they pay, so that checkout holds no surprise.

#### Scenario: Sum
- **WHEN** the cart has 2 and 3
- **THEN** the total is 5

#### Scenario: Empty total
- **WHEN** the cart is empty
- **THEN** the total is 0
MD
printf '## 1. Cart\n\n- [x] 1.1 Total\n  - Files: src/cart.js\n  - Done when: `node --test` exits 0\n- [x] 1.1 Again\n  - Files: src/cart.js\n' > "$C/tasks.md"
printf '/** @spec cart/total */\nexports.total = (xs) => xs.reduce((a, b) => a + b, 0);\n' > src/cart.js
printf 'const { test } = require("node:test");\nconst assert = require("node:assert");\nconst { total } = require("../src/cart.js");\ntest("[cart/sum] sums", () => assert.strictEqual(total([2, 3]), 5));\ntest("[cart/totl] typo", () => {});\n' > test/cart.test.js
git add -A && git commit -qm plan

echo "== lint --text: one located line per problem"
rc=0; $V lint cart --text > "$T/l.txt" 2>&1 || rc=$?
expect "a duplicate task label is an error at its line (file:line: error: text), exit 1" '[ $rc = 1 ] && grep -q "^\.wingman-spec/changes/cart/tasks.md:6: error: task label 1.1 is used twice" "$T/l.txt"'
printf '## 1. Cart\n\n- [x] 1.1 Total\n  - Files: src/cart.js\n  - Done when: `node --test` exits 0\n' > "$C/tasks.md"
rc=0; $V lint cart --text > "$T/l.txt" 2>&1 || rc=$?
expect "the fixed plan lints clean (exit 0)" '[ $rc = 0 ]'

echo "== trace: scenarios and tags"
rc=0; $V trace cart > "$T/t.json" 2>/dev/null || rc=$?
expect "a scenario without a tagged test is listed with its file and line, exit 1" '[ $rc = 1 ] && [ "$(J "$T/t.json" untested.0.id)" = cart/empty-total ] && [ "$(J "$T/t.json" untested.0.line)" = 11 ]'
expect "a tag of a known capability that names no scenario is listed" 'J "$T/t.json" unknown_tags | grep -q "cart/totl"'
rc=0; $V trace cart --text > "$T/t.txt" 2>/dev/null || rc=$?
expect "--text prints file:line lines" 'grep -q "^\.wingman-spec/changes/cart/specs/cart.md:11: untested: \[cart/empty-total\]" "$T/t.txt" && grep -q "^test/cart.test.js:5: unknown tag: \[cart/totl\]" "$T/t.txt"'
mkdir -p checks; printf '// [cart/empty-total]\n' > checks/empty.js
sed -i 's/\[cart\/totl\] typo/[cart\/sum] again/' test/cart.test.js
rc=0; $V trace cart > "$T/t.json" 2>/dev/null || rc=$?
expect "a file outside the built-in test detection does not count" '[ $rc = 1 ]'
ws_set test_files '["checks/**/*.js"]'
rc=0; $V trace cart > "$T/t.json" 2>/dev/null || rc=$?
expect "test_files adds it: every scenario is tagged, exit 0" '[ $rc = 0 ] && [ "$(J "$T/t.json" ok)" = true ]'

echo "== run-checks: logs in files, parsed failures"
printf 'test("[cart/empty-total] empty", () => assert.strictEqual(total([]), 1));\n' >> test/cart.test.js
rc=0; $V run-checks cart > "$T/r.json" 2>/dev/null || rc=$?
# shellcheck disable=SC2034 # read by the expect below
LOG=$(J "$T/r.json" checks.2.log)
expect "a failing test fails run-checks (exit 1) and names it" '[ $rc = 1 ] && [ "$(J "$T/r.json" failed)" = "[\"test\"]" ]'
expect "the full output is in a log file under runs/<change>/checks/" 'case "$LOG" in *.wingman-spec/runs/cart/checks/*) [ -s "$LOG" ];; *) false;; esac'
expect "the summary is parsed (TAP): the test, its file and line" '[ "$(J "$T/r.json" checks.2.summary.failures.0.file)" = test/cart.test.js ] && [ "$(J "$T/r.json" checks.2.summary.failures.0.line)" = 6 ] && J "$T/r.json" checks.2.summary.failures.0.name | grep -q "cart/empty-total"'
expect "run-checks writes a checks event to the timeline" 'tail -1 .wingman-spec/runs/cart/timeline.jsonl | grep -q "\"event\":\"checks\",.*\"ok\":false"'
rc=0; $V run-checks cart --text > "$T/r.txt" 2>/dev/null || rc=$?
expect "--text: one line per check, the failures, the log path" '[ $rc = 1 ] && grep -q "^test: FAILED (exit 1).*log: .wingman-spec/runs/cart/checks/test.log" "$T/r.txt" && grep -q "^  test/cart.test.js:6: " "$T/r.txt"'
rc=0; $V run-checks cart --only lint,nope > /dev/null 2>&1 || rc=$?
expect "--only with an unknown check is a usage error (exit 2)" '[ $rc = 2 ]'
rc=0; $V run-checks --only visual > /dev/null 2>&1 || rc=$?
expect "visual without a change is a usage error (exit 2)" '[ $rc = 2 ]'
sed -i 's/total(\[\]), 1)/total([]), 0)/' test/cart.test.js
rc=0; $V run-checks > "$T/r.json" 2>/dev/null || rc=$?
expect "without a change: passes, logs go to runs/checks/" '[ $rc = 0 ] && ls .wingman-spec/runs/checks/ | grep -q test'

echo "== the archive gate: each condition refuses on its own"
arch() { rc=0; $V archive cart > "$T/a.json" 2> "$T/a.err" || rc=$?; }
nothing() { [ -d "$C" ] && [ ! -e .wingman-spec/specs/cart.md ]; }
$V finish cart > /dev/null 2>&1
git add -A && git commit -qm built
printf 'Stuck.\n' > "$C/BLOCKED.md"; arch
expect "BLOCKED.md: refused (exit 3) with its own line, nothing written" '[ $rc = 3 ] && grep -q "blocked: BLOCKED.md exists" "$T/a.err" && nothing'
rm "$C/BLOCKED.md"
sed -i 's/- \[x\] 1.1/- [ ] 1.1/' "$C/tasks.md"; arch
expect "an open task: refused with the task named" '[ $rc = 1 ] && grep -q "tasks: 1 task(s) are not done" "$T/a.err" && grep -q "tasks: 1.1 Total" "$T/a.err" && nothing'
sed -i 's/- \[ \] 1.1/- [x] 1.1/' "$C/tasks.md"
mkdir -p .wingman-spec/specs; printf '# cart\n\n## Purpose\nThe cart of the shop, where a shopper collects items.\n\n## Requirements\n\n### Requirement: Total\nThe system SHALL show a total.\nWhy: A shopper wants a total.\n\n#### Scenario: Shown\n- **WHEN** x\n- **THEN** y\n' > .wingman-spec/specs/cart.md
cp .wingman-spec/specs/cart.md "$T/living.md"; arch
expect "a capability another change created after the plan: refused (merge and lint), the living spec untouched" '[ $rc = 1 ] && grep -q "merge: .*cart.md:1: another change created this capability after this change was planned" "$T/a.err" && cmp -s "$T/living.md" .wingman-spec/specs/cart.md && [ -d "$C" ]'
expect "the refusal names nothing else: finish still holds (the living specs are not part of the tree)" '! grep -q "finish:" "$T/a.err"'
rc=0; $V sync cart --rebase > "$T/rb.json" 2>/dev/null || rc=$?
expect "sync --rebase pins the new living spec" '[ $rc = 0 ] && grep -q "\"cart\"" "$T/rb.json"'
arch
expect "then the ADDED requirement it already has is a conflict, with file and line" '[ $rc = 1 ] && grep -q "merge: .*cart.md:3: ADDED: requirement \"Total\" already exists" "$T/a.err" && cmp -s "$T/living.md" .wingman-spec/specs/cart.md'
rm .wingman-spec/specs/cart.md; arch
expect "a living spec deleted after the plan: refused" '[ $rc = 1 ] && grep -q "merge: .*the living spec was deleted after this change was planned" "$T/a.err" && [ -d "$C" ]'
$V sync cart --rebase > /dev/null 2>&1
printf '\n// later\n' >> src/cart.js; arch
expect "an edit after finish: refused until finish runs again" '[ $rc = 1 ] && grep -q "finish: the code or the plan changed since finish passed" "$T/a.err" && nothing'
sed -i '$d' src/cart.js; sed -i '$d' src/cart.js
arch
expect "every condition holds: archived, the living spec merged" '[ $rc = 0 ] && [ "$(J "$T/a.json" result)" = archived ] && [ ! -d "$C" ] && grep -q "### Requirement: Total" .wingman-spec/specs/cart.md'
cp .wingman-spec/specs/cart.md "$T/merged.md"
rc=0; $V sync cart --check > /dev/null 2>&1 || rc=$?
expect "the archived change is gone: sync of it is an error, nothing changes" '[ $rc != 0 ] && cmp -s "$T/merged.md" .wingman-spec/specs/cart.md'

echo "== a living spec that moved after the plan: base changed, then sync --rebase"
git add -A && git commit -qm archived
C=.wingman-spec/changes/round
mkdir -p "$C/specs"
printf 'Size: S\nRisk: none\nKind: spec-only\n\n## Why\nRound totals.\n\n## What Changes\n- Round.\n\n## Edge cases\n- none named\n' > "$C/proposal.md"
printf '## MODIFIED\n\n### Requirement: Total\nThe system SHALL add up the cart and round to cents.\nWhy: A shopper wants to see what they pay, so that checkout holds no surprise.\n\n#### Scenario: Sum\n- **WHEN** the cart has 2 and 3\n- **THEN** the total is 5\n' > "$C/specs/cart.md"
printf '## 1. Spec\n\n- [x] 1.1 Write the spec\n  - Files: .wingman-spec/changes/round/specs/cart.md\n' > "$C/tasks.md"
$V lint round > /dev/null 2>&1
expect "lint pins the base: spec-base.json records the requirement" '[ -f "$C/spec-base.json" ] && grep -q "total" "$C/spec-base.json"'
sed -i 's/The system SHALL add up the cart\.$/The system SHALL add up the cart in euros./' .wingman-spec/specs/cart.md
cp .wingman-spec/specs/cart.md "$T/moved.md"
rc=0; $V archive round > "$T/a.json" 2> "$T/a.err" || rc=$?
expect "another edit of the living requirement since the pin: refused (base changed), nothing written" '[ $rc = 1 ] && grep -q "base changed: requirement \"Total\"" "$T/a.err" && cmp -s "$T/moved.md" .wingman-spec/specs/cart.md && [ -d "$C" ]'
rc=0; $V sync round --rebase > "$T/rb.json" 2>/dev/null || rc=$?
expect "sync --rebase re-pins the moved requirement and says which" '[ $rc = 0 ] && grep -q "total" "$T/rb.json" && tail -1 .wingman-spec/runs/round/timeline.jsonl | grep -q "\"event\":\"rebase\""'
rc=0; $V archive round > "$T/a.json" 2> "$T/a.err" || rc=$?
expect "after the rebase the spec-only change archives (no finish needed) and the MODIFIED text wins" '[ $rc = 0 ] && grep -q "round to cents" .wingman-spec/specs/cart.md && ! grep -q "in euros" .wingman-spec/specs/cart.md'

echo
echo "deterministic: passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
