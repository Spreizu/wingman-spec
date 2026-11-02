#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# Review proof: a review task that changes code needs, per fix, a test tagged [review:<slug>] (or named review_<slug>) that
# fails on the code as the review was handed out and passes after, or `untestable: <reason>` (recorded and surfaced).
# The fix's tests are selected by name for the runner, by commands.test_one, per file, or the whole suite; real runs with
# node, and go and pytest when they are installed.
# Usage: tests/review-proof.sh   (needs the wingman-spec binary, see tests/lib/ws.sh, and node). Exit 0 when every case passes.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/ws.sh
. "$PKG/tests/lib/ws.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export WINGMAN_SPEC_TRACEABILITY=off GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; [ -n "${DEBUG:-}" ] && printf '%s\n' "$out"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }

cd "$T" && ws_project p && cd p || exit 1
ws_cmd test "node --test"
V="$WS"; C=.wingman-spec/changes/demo
git add -A && git commit -qm init

# A change whose task 1.1 lands a clamp with a bug at the upper limit, then a review task.
start() {
  git reset -q --hard; git clean -qfdx -e .wingman-spec/runs; rm -rf "$C" .wingman-spec/runs; mkdir -p "$C/specs"
  printf '## Why\nDemo change for the review proof.\n\n## What Changes\n- Adds a clamp.\n\n## Edge cases\n- none named\n' > "$C/proposal.md"
  printf '## ADDED\n\n### Requirement: Clamp\nThe system SHALL clamp.\n\n#### Scenario: clamp\n- **WHEN** asked\n- **THEN** it clamps\n' > "$C/specs/demo.md"
  printf -- '## 1. Clamp\n- [ ] 1.1 clamp\n  - Files: clamp.mjs, clamp.test.mjs\n  - Done when: `node --test clamp.test.mjs`\n- [ ] 1.R Request code review\n' > "$C/tasks.md"
  $V next demo >/dev/null 2>&1
  printf 'export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi - 1 : x);\n' > clamp.mjs
  printf 'import test from "node:test";\nimport assert from "node:assert";\nimport { clamp } from "./clamp.mjs";\ntest("inside", () => assert.equal(clamp(5, 0, 10), 5));\n' > clamp.test.mjs
  rc=0; $V check demo >/dev/null 2>&1 || rc=$?
  [ $rc = 0 ] || { echo "setup: task 1.1 did not pass (rc=$rc)"; exit 1; }
  $V next demo --format prompt > "$T/review.txt" 2>/dev/null
}
fix() { printf 'export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);\n' > clamp.mjs; }
proof_test() { # proof_test <slug> <assertion>
  printf 'test("above the limit [review:%s]", () => %s);\n' "$1" "$2" >> clamp.test.mjs
}
note() { printf '%s\n' "$1" >> "$C/progress.md"; }
review() { out="$($V check demo 2>&1)"; rc=$?; }

echo "== a fix with a test that fails before it"
start
expect "the review prompt went out" 'grep -q "Request code review" "$T/review.txt"'
expect "next kept the review's pre-task tree" 'grep -q "\"pre_tree\": \"[0-9a-f]\{40\}\"" .wingman-spec/runs/demo/*/state.json 2>/dev/null || grep -rq "\"pre_tree\"" .wingman-spec/runs'
fix; proof_test upper-limit 'assert.equal(clamp(15, 0, 10), 10)'; $V progress demo --task 1.R --review-fix upper-limit --note 'clamp returned hi - 1 above the limit' >/dev/null
expect "the progress command wrote the Review fix line" 'grep -qx -- "- Review fix: upper-limit - clamp returned hi - 1 above the limit" "$C/progress.md"'
review
expect "check passes: fails before, passes after" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "\"check\": \"review_proof\"" && printf "%s" "$out" | grep -q "\"upper-limit\": 1"'
expect "the timeline records the proof" 'grep -h "review-proof" .wingman-spec/runs/demo/timeline.jsonl | grep -q "1 review fix(es) with a fail-before/pass-after test, 0 untestable"'
expect "the timeline records the mode: by name for node:test" 'grep -h "review-proof" .wingman-spec/runs/demo/timeline.jsonl | grep -q "\"upper-limit\":\"name:node:test\""'

echo "== a code change with no Review fix line"
start
fix
review
expect "rejected: the review changed code with no Review fix line" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "progress.md has no .Review fix"'

echo "== a tagged test that passes before the fix"
start
fix; proof_test upper-limit 'assert.equal(clamp(-3, 0, 10), 0)'; note 'Review fix: upper-limit - clamp returned hi - 1 above the limit'
review
expect "rejected: the test does not show the fix" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "passes on the code as it was before the review"'

echo "== two fixes: one weak test cannot hide behind a strong one"
start
fix; proof_test upper-limit 'assert.equal(clamp(15, 0, 10), 10)'; proof_test low-side 'assert.equal(clamp(-3, 0, 10), 0)'
note 'Review fix: upper-limit - hi - 1 above the limit'; note 'Review fix: low-side - below the limit'
review
expect "rejected on the weak one alone" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "test of fix low-side passes on the code"'

echo "== a fix line without its test"
start
fix; note 'Review fix: upper-limit - hi - 1 above the limit'
review
expect "rejected: no test is tagged" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "no test is tagged .\[review:upper-limit\]"'

echo "== untestable"
start
fix; $V progress demo --task 1.R --review-fix upper-limit --untestable 'only shows under a 32-bit runtime' --note 'hi - 1 above the limit' >/dev/null
review
expect "passes, with the reason in the warnings and the check" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "review fix upper-limit has no test (untestable: only shows under a 32-bit runtime)" && printf "%s" "$out" | grep -q "\"upper-limit: only shows under a 32-bit runtime\""'
expect "the timeline counts it as untestable" 'grep -h "review-proof" .wingman-spec/runs/demo/timeline.jsonl | grep -q "0 review fix(es) with a fail-before/pass-after test, 1 untestable"'

echo "== a review that changes no code"
start
note 'Reviewed: no Critical or Important findings.'
review
expect "passes with the proof skipped" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "the review changed no code"'

echo "== commands.test_one overrides the runner's name filter"
start
ws_cmd test_one "node --test --test-name-pattern={name} {file}"
fix; proof_test upper-limit 'assert.equal(clamp(15, 0, 10), 10)'; note 'Review fix: upper-limit - hi - 1 above the limit'
review
expect "passes in override mode" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "\"upper-limit\": \"override\""'
start; ws_cmd test_one "node --test --test-name-pattern=nomatch {file}"
fix; proof_test upper-limit 'assert.equal(clamp(15, 0, 10), 10)'; note 'Review fix: upper-limit - hi - 1 above the limit'
review
expect "an override that selects no test fails" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "test of fix upper-limit passes on the code as it was before"'

echo "== an unknown runner: per file, then the whole suite"
unknown() { printf '#!/bin/sh\nexec node --test "$@"\n' > t.sh; chmod +x t.sh; ws_cmd test ./t.sh; }
start; unknown; ws_cmd targeted "./t.sh {files}"
fix; proof_test upper-limit 'assert.equal(clamp(15, 0, 10), 10)'; note 'Review fix: upper-limit - hi - 1 above the limit'
review
expect "per file" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "\"upper-limit\": \"file\""'
start; unknown
fix; proof_test upper-limit 'assert.equal(clamp(15, 0, 10), 10)'; note 'Review fix: upper-limit - hi - 1 above the limit'
review
expect "whole suite" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "\"upper-limit\": \"suite\""'

# lang_case <dir> <test cmd> <src> <src body> <test file> <test head> <proof test> <mode>: one fix, a real run.
lang_case() {
  rm -rf "${T:?}/$1"; mkdir -p "$T/$1"; cd "$T/$1" && ws_project . && ws_cmd test "$2" || return
  printf '__pycache__/\n.pytest_cache/\n' > .gitignore; [ "$1" = go ] && printf 'module clamp\n\ngo 1.21\n' > go.mod
  git add -A && git commit -qm init
  mkdir -p "$C/specs"; cp "$P/$C/proposal.md" "$C/"; cp "$P/$C/specs/demo.md" "$C/specs/"
  printf -- '## 1. Clamp\n- [ ] 1.1 clamp\n  - Files: %s, %s\n  - Done when: `%s`\n- [ ] 1.R Request code review\n' "$3" "$5" "$2" > "$C/tasks.md"
  $V next demo >/dev/null 2>&1; printf '%b' "$4" > "$3"; printf '%b' "$6" > "$5"
  rc=0; $V check demo >/dev/null 2>&1 || rc=$?; [ $rc = 0 ] || echo "setup failed in $1 (rc=$rc)"
  $V next demo --format prompt >/dev/null 2>&1
  sed -i.b 's/hi - 1/hi/' "$3" && rm -f "$3.b"; printf '%b' "$7" >> "$5"; printf 'Review fix: upper-limit - hi - 1 above the limit\n' >> "$C/progress.md"
  out="$($V check demo 2>&1)"; rc=$?
  # shellcheck disable=SC2034 # read by the eval in expect
  want="$8"
  expect "$1: fails before, passes after, by name" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "\"upper-limit\": \"$want\""'; cd "$P" || exit 1
}
P="$T/p"
if command -v go >/dev/null; then
  echo "== go: TestReview_upper_limit, go test -run"
  lang_case go "go test ./..." clamp.go 'package clamp\n\nfunc Clamp(x, lo, hi int) int {\n\tif x < lo {\n\t\treturn lo\n\t}\n\tif x > hi {\n\t\treturn hi - 1\n\t}\n\treturn x\n}\n' \
    clamp_test.go 'package clamp\n\nimport "testing"\n\nfunc TestInside(t *testing.T) {\n\tif Clamp(5, 0, 10) != 5 {\n\t\tt.Fatal("inside")\n\t}\n}\n' \
    '\nfunc TestReview_upper_limit(t *testing.T) {\n\tif Clamp(15, 0, 10) != 10 {\n\t\tt.Fatal("above")\n\t}\n}\n' name:go
else echo "  skip go (not installed)"; fi
if python3 -m pytest --version >/dev/null 2>&1; then
  echo "== python: test_review_upper_limit, pytest -k"
  PYTHONDONTWRITEBYTECODE=1 lang_case py "python3 -m pytest -q -p no:cacheprovider" clamp.py 'def clamp(x, lo, hi):\n    return lo if x < lo else hi - 1 if x > hi else x\n' \
    test_clamp.py 'from clamp import clamp\n\n\ndef test_inside():\n    assert clamp(5, 0, 10) == 5\n' \
    '\n\ndef test_review_upper_limit():\n    assert clamp(15, 0, 10) == 10\n' name:pytest
else echo "  skip pytest (not installed)"; fi

echo; echo "passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
