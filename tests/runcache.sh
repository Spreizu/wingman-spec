#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2034
# Result cache (verify-task.cjs runProject): a passing tests/typecheck/lint result is reused between `check` and `finish` while
# the working tree and the command are unchanged; any edit, a failing result and --no-cache run the command again; finish runs
# its commands in parallel. Usage: tests/runcache.sh (needs openspec and node on PATH).
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export SPEC_TRACEABILITY=off OPENSPEC_TELEMETRY=0 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
unset SPEC_NO_CACHE; export SPEC_CHECK_LEVEL=group # the cache of the full suite at check
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*  (rc=$rc)"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
cd "$T" && mkdir p && cd p && git init -q
openspec init --tools none >/dev/null 2>&1 || mkdir -p openspec/changes openspec/specs
"$PKG/install.sh" . >/dev/null || { echo "install failed"; exit 1; }
COUNT="$T/count"; TCOUNT="$T/tcount"
export SPEC_TEST_CMD="echo x >> $COUNT" SPEC_TYPECHECK_CMD="echo t >> $TCOUNT" SPEC_LINT_CMD=""
git add -A && git commit -qm init
V="node openspec/scripts/verify-task.cjs"; C=openspec/changes/demo
lines() { if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }
runs() { lines "$COUNT"; }
unlock() { rm -f openspec/.apply-runs/demo/finish.json; }
plan() {
  rm -rf "$C" openspec/.apply-runs "$COUNT" "$TCOUNT"; mkdir -p "$C/specs/demo" src test
  printf 'Size: S\nRisk: none\n\n## Why\nDemo.\n\n## What Changes\n- Adds a demo capability.\n\n## Edge cases\n- none named\n' > "$C/proposal.md"
  printf '## ADDED Requirements\n\n### Requirement: Demo\nThe system SHALL greet.\n\n#### Scenario: greet\n- **WHEN** asked\n- **THEN** it greets\n' > "$C/specs/demo/spec.md"
  printf '## 1. G\n- [ ] 1.1 one\n  - Spec: demo > Demo (greet)\n  - Test first: greet\n  - Files: src/a.js, test/a.test.js\n  - Done when: `true` exits 0\n' > "$C/tasks.md"
  echo 'module.exports = 1;' > src/a.js; printf '// [demo/greet]\n' > test/a.test.js
  rm -f src/new-file.js
  git add -A; git commit -qm plan >/dev/null 2>&1 || true
}

echo "== reused between check and finish"
plan
$V next demo > /dev/null 2>&1; echo 'module.exports = 2;' > src/a.js
$V check demo --reported done > "$T/c.json" 2>&1; rc=$?
expect "check runs the project tests (1 run)" '[ $rc = 0 ] && [ "$(runs)" = 1 ] && ! grep -q "\"cached\"" "$T/c.json"'
git add -A; git commit -qm task
$V finish demo > "$T/f.json" 2>&1; rc=$?
expect "finish passes without running the tests again; the check says cached" '[ $rc = 0 ] && [ "$(runs)" = 1 ] && grep -A5 "\"check\": \"tests\"" "$T/f.json" | grep -q "\"cached\": true"'
expect "the typecheck is reused too" '[ "$(lines "$TCOUNT")" = 1 ]'

echo "== stale cache negatives"
echo 'module.exports = 3;' > src/a.js
unlock; $V finish demo > /dev/null 2>&1
expect "an edited file: the tests run again" '[ "$(runs)" = 2 ]'
echo 'module.exports = 3;' > src/new-file.js
unlock; $V finish demo > /dev/null 2>&1
expect "a new untracked file: the tests run again" '[ "$(runs)" = 3 ]'
unlock; $V finish demo > /dev/null 2>&1
expect "nothing changed since: reused (still 3 runs)" '[ "$(runs)" = 3 ]'
unlock; $V finish demo --no-cache > /dev/null 2>&1
expect "--no-cache runs them again" '[ "$(runs)" = 4 ]'
export SPEC_TEST_CMD="echo y >> $COUNT"
unlock; $V finish demo > /dev/null 2>&1
expect "another command on the same tree is not served from the cache" '[ "$(runs)" = 5 ]'

echo "== a failing result is never reused"
plan
export SPEC_TEST_CMD="echo x >> $COUNT; false"
$V next demo > /dev/null 2>&1; echo 'module.exports = 2;' > src/a.js
$V check demo --reported done > /dev/null 2>&1; $V check demo --reported done > /dev/null 2>&1
expect "two failing checks on the same tree run the tests twice" '[ "$(runs)" = 2 ]'

echo "== finish runs its commands in parallel"
plan
export SPEC_TEST_CMD="sleep 2" SPEC_TYPECHECK_CMD="sleep 2"
$V next demo > /dev/null 2>&1; echo 'module.exports = 2;' > src/a.js; $V check demo --reported done > /dev/null 2>&1
echo 'module.exports = 4;' > src/a.js
s0=$(date +%s); $V finish demo > /dev/null 2>&1; s1=$(date +%s)
expect "two 2-second commands finish in under 4 seconds" '[ $((s1 - s0)) -lt 4 ]'

plan2() { # two tasks naming the same Done when command (the project test command)
  plan
  printf '## 1. G\n- [ ] 1.1 one\n  - Spec: demo > Demo (greet)\n  - Test first: greet\n  - Files: src/a.js, test/a.test.js\n  - Done when: `%s`\n- [ ] 1.2 two\n  - Files: src/a.js\n  - Done when: `%s`\n' "$SPEC_TEST_CMD" "$SPEC_TEST_CMD" > "$C/tasks.md"
  git add -A; git commit -qm plan2 >/dev/null 2>&1 || true
}

echo "== a Done when command that is the project test command runs once, is cached, and a batch runs it once"
export SPEC_TEST_CMD="echo x >> $COUNT"; plan2
$V next demo > /dev/null 2>&1; echo 'module.exports = 2;' > src/a.js
$V check demo --reported done > "$T/c.json" 2>&1; rc=$?
expect "two tasks naming the same command: it runs once, the second is reported as the same command" '[ "$(runs)" = 1 ] && grep -q "same command as done_when" "$T/c.json"'
unlock; $V finish demo > "$T/f.json" 2>&1; rc=$?
expect "finish does not run it again: the Done when run is in the cache" '[ $rc = 0 ] && [ "$(runs)" = 1 ] && grep -A5 "\"check\": \"tests\"" "$T/f.json" | grep -q "\"cached\": true"'
echo 'module.exports = 5;' > src/a.js
unlock; $V finish demo > /dev/null 2>&1
expect "stale-cache negative: an edit between check and finish runs it again" '[ "$(runs)" = 2 ]'
printf '\nnote\n' >> "$C/tasks.md"; unlock; $V finish demo > /dev/null 2>&1
expect "an edit of tasks.md alone does not" '[ "$(runs)" = 2 ]'

echo "== Test run: finish keeps the project tests out of every check"
plan; export SPEC_TEST_CMD="echo x >> $COUNT" SPEC_TEST_RUN=finish
$V next demo > /dev/null 2>&1; echo 'module.exports = 2;' > src/a.js
$V check demo --reported done > "$T/c.json" 2>&1; rc=$?
expect "check passes without running the project tests and says so" '[ $rc = 0 ] && [ "$(runs)" = 0 ] && grep -q "Test run: finish" "$T/c.json"'
$V finish demo > /dev/null 2>&1
expect "finish runs them once" '[ "$(runs)" = 1 ]'
unset SPEC_TEST_RUN

echo "== a limit per command, live progress and --timing"
plan; export SPEC_TEST_CMD="sleep 4; echo x >> $COUNT"
$V next demo > /dev/null 2>&1; echo 'module.exports = 2;' > src/a.js
SPEC_TIMEOUT_TESTS=1 $V check demo --reported done > "$T/c.json" 2> "$T/c.err"; rc=$?
expect "SPEC_TIMEOUT_TESTS=1 kills the 4-second tests and says which limit" '[ $rc != 0 ] && grep -q "timed out after 1s" "$T/c.json" && [ "$(runs)" = 0 ]'
$V check demo --reported done --timing > "$T/c.json" 2> "$T/c.err"; rc=$?
expect "a command running for 3 seconds is announced on stderr, with its elapsed time" '[ $rc = 0 ] && grep -q "tests: still running after 3s" "$T/c.err" && grep -q "tests: finished in 4s" "$T/c.err"'
expect "--timing prints the steps, most expensive first, and records them in metrics.jsonl" 'grep -q "verify-task: timing (check): tests 4" "$T/c.err" && grep -q "\"event\":\"profile\"" openspec/.apply-runs/demo/*/metrics.jsonl'

echo "== the blame cache (stale anchors, drift)"
git add -A; git commit -qm before-blame >/dev/null 2>&1 || true
BL() { node -e 'const AG=require(process.argv[1]+"/project-template/openspec/scripts/anchorguard.cjs");const b=AG.blameOf(process.cwd(),"src/a.js");console.log(JSON.stringify(b.perLine.map((s)=>s&&s.slice(0,7))))' "$PKG"; }
rm -rf .git/spec-blame-cache; F1=$(BL); N1=$(ls .git/spec-blame-cache | grep -c json)
expect "the first blame is stored in the git directory, not in the working tree" '[ "$N1" = 1 ] && [ -z "$(git status --porcelain | grep spec-blame)" ]'
F2=$(BL)
expect "the second answer is the same and nothing new is stored" '[ "$F1" = "$F2" ] && [ "$(ls .git/spec-blame-cache | grep -c json)" = 1 ]'
echo 'module.exports = 6;' >> src/a.js; F3=$(BL)
expect "stale-cache negative: an uncommitted edit is blamed fresh (a line of no commit), not served from the cache" '[ "$F3" != "$F1" ] && echo "$F3" | grep -q "0000000"'
git add -A; git commit -qm edit >/dev/null 2>&1; F4=$(BL)
expect "stale-cache negative: after a commit the cache is emptied and the new commit is in the answer" '[ "$(cat .git/spec-blame-cache/HEAD)" = "$(git rev-parse HEAD)" ] && [ "$(ls .git/spec-blame-cache | grep -c json)" = 1 ] && echo "$F4" | grep -q "$(git rev-parse --short=7 HEAD)"'

echo "runcache: passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
