#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2034
# How often the project commands run in a 5-task change (Size M: two task groups), counted for real: the Done when command, the project
# tests, typecheck and lint, per `check` level (targeted | group | task | finish) and per dispatch (one task at a time, or one group at a time),
# plus the visual cache (visual.changed_only) and visual.scope: task. Usage: tests/runfreq.sh (needs openspec, node and git on PATH).
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export SPEC_TRACEABILITY=off OPENSPEC_TELEMETRY=0 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
unset SPEC_NO_CACHE SPEC_CHECK_LEVEL SPEC_TEST_RUN
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*  (rc=$rc)"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
cd "$T" && mkdir p && cd p && git init -q
openspec init --tools none >/dev/null 2>&1 || mkdir -p openspec/changes openspec/specs
"$PKG/install.sh" . >/dev/null || { echo "install failed"; exit 1; }
TC="$T/tests"; YC="$T/types"; LC="$T/lint"; DC="$T/done"
export SPEC_TEST_CMD="echo x >> $TC" SPEC_TYPECHECK_CMD="echo x >> $YC" SPEC_LINT_CMD="echo x >> $LC"
git add -A && git commit -qm init
V="node openspec/scripts/verify-task.cjs"; C=openspec/changes/demo
n() { if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }
counts() { echo "$(n "$TC")/$(n "$YC")/$(n "$LC")/$(n "$DC")"; }
plan5() {
  rm -rf "$C" src openspec/.apply-runs "$TC" "$YC" "$LC" "$DC"; mkdir -p "$C/specs/demo" src
  printf 'Size: M\nRisk: none\n\n## Why\nDemo.\n\n## What Changes\n- Adds a demo capability.\n\n## Edge cases\n- none named\n' > "$C/proposal.md"
  printf '## ADDED Requirements\n\n### Requirement: Demo\nThe system SHALL greet.\n\n#### Scenario: greet\n- **WHEN** asked\n- **THEN** it greets\n' > "$C/specs/demo/spec.md"
  { echo '## 1. First'; for i in 1 2 3; do printf -- '- [ ] 1.%s task %s\n  - Files: src/t%s.js\n  - Done when: `echo %s >> %s` exits 0\n' "$i" "$i" "$i" "$i" "$DC"; done
    echo '## 2. Second'; for i in 1 2; do printf -- '- [ ] 2.%s task %s\n  - Files: src/u%s.js\n  - Done when: `echo %s >> %s` exits 0\n' "$i" "$i" "$i" "$i" "$DC"; done; } > "$C/tasks.md"
  mkdir -p test; printf '// [demo/greet]\n' > test/a.test.js
  printf '## Capability inventory\n- demo\n- extra\n' > "$C/app-map.md"; printf '## Decisions\nOne.\n\n## Implementation guide\nOne function.\n' > "$C/design.md"
  mkdir -p "$C/adrs"; printf -- '---\nstatus: none\n---\nNone.\n' > "$C/adrs/none.md"
  git add -A; git commit -qm plan >/dev/null 2>&1 || true
}
# drive the change to the end: next, edit, check; then finish. Extra flags go to `next` (--per-task).
drive() {
  plan5; : > "$T/disp"; local i=0 r
  while [ $i -lt 9 ]; do
    i=$((i+1)); $V next demo "$@" > "$T/n.json" 2>&1; r=$?; [ $r = 10 ] && break; [ $r = 0 ] || { echo "next rc=$r"; cat "$T/n.json"; return 1; }
    grep -o '"label": "[^"]*"' "$T/n.json" | sed 's/"label": //' | tr -d '"\n' >> "$T/disp"; echo >> "$T/disp"
    echo "module.exports = $i;" > "src/d$i.js"
    $V check demo --reported done > "$T/c.json" 2>&1 || { echo "check failed"; cat "$T/c.json"; return 1; }
    grep -o '"skipped": "[^"]*"' "$T/c.json" | tr '\n' ' ' >> "$T/disp"; echo >> "$T/disp"
  done
  $V finish demo > "$T/f.json" 2>&1 || { echo "finish failed"; cat "$T/f.json"; return 1; }
}

echo "== runs per 5-task change (tests/typecheck/lint/done-when)"
export SPEC_CHECK_LEVEL=task
drive --per-task; rc=$?; echo "      measured tests/typecheck/lint/done-when: $(counts)"; expect "one task per dispatch, Check level: task (opt-in): 5/5/5/5, finish served from the cache" '[ $rc = 0 ] && [ "$(counts)" = "5/5/5/5" ]'
unset SPEC_CHECK_LEVEL
drive --per-task; rc=$?; echo "      measured tests/typecheck/lint/done-when: $(counts)"; expect "one task per dispatch, the default (targeted; no targeted command for this test command): the full suite once at finish, typecheck and lint at the group ends: 1/2/2/5" '[ $rc = 0 ] && [ "$(counts)" = "1/2/2/5" ]'
drive; rc=$?; echo "      measured tests/typecheck/lint/done-when: $(counts); dispatches: $(tr "\n" "|" < "$T/disp")"; expect "one group per dispatch (Size M), the default: 1/2/2/5" '[ $rc = 0 ] && [ "$(counts)" = "1/2/2/5" ]'
export SPEC_CHECK_LEVEL=group
drive --per-task; rc=$?; echo "      measured tests/typecheck/lint/done-when: $(counts)"; expect "one task per dispatch, Check level: group: 2/2/2/5 (the tasks that end a group)" '[ $rc = 0 ] && [ "$(counts)" = "2/2/2/5" ]'
grep -q 'Check level: group' "$T/c.json" || true
export SPEC_CHECK_LEVEL=finish
drive --per-task; rc=$?; echo "      measured tests/typecheck/lint/done-when: $(counts)"; expect "one task per dispatch, Check level: finish: 1/1/1/5 (everything once, at finish)" '[ $rc = 0 ] && [ "$(counts)" = "1/1/1/5" ]'
expect "finish still runs and reports the tests, typecheck and lint" 'grep -A3 "\"check\": \"tests\"" "$T/f.json" | grep -q "\"ok\": true" && grep -q "\"check\": \"lint\"" "$T/f.json"'
unset SPEC_CHECK_LEVEL
printf '%s\n' '- Check level: finish' >> openspec/config.yaml 2>/dev/null; grep -q "Check level" openspec/config.yaml 2>/dev/null || printf 'context: |\n  - Check level: finish\n' >> openspec/config.yaml
drive --per-task; rc=$?; echo "      measured tests/typecheck/lint/done-when: $(counts)"; expect "the same level set in openspec/config.yaml: 1/1/1/5" '[ $rc = 0 ] && [ "$(counts)" = "1/1/1/5" ]'
sed -i '/Check level/d' openspec/config.yaml

echo "== a fault at an early task: the level moves where it is caught, never whether"
export SPEC_CHECK_LEVEL=finish
plan5; export SPEC_TEST_CMD="test ! -f src/broken.js"
$V next demo --per-task > /dev/null 2>&1; echo 'x' > src/broken.js; $V check demo --reported done > "$T/c.json" 2>&1; rc=$?
expect "Check level: finish: the task passes its own Done when" '[ $rc = 0 ]'
for i in 2 3 4 5; do $V next demo --per-task > /dev/null 2>&1; echo "$i" > "src/d$i.js"; $V check demo --reported done > /dev/null 2>&1; done
$V next demo --per-task > /dev/null 2>&1; rc=$?
$V finish demo > "$T/f.json" 2>&1; rc=$?
expect "finish fails on the broken tests (exit 1)" '[ $rc = 1 ] && grep -q "tests failed" "$T/f.json"'
export SPEC_CHECK_LEVEL=task
plan5; $V next demo --per-task > /dev/null 2>&1; echo 'x' > src/broken.js; $V check demo --reported done > "$T/c.json" 2>&1; rc=$?
expect "Check level: task: the same fault is caught at the first check (exit 1)" '[ $rc = 1 ] && grep -q "tests failed" "$T/c.json"'
export SPEC_CHECK_LEVEL=group; rm -f src/broken.js
plan5; $V next demo --per-task > /dev/null 2>&1; echo 'x' > src/broken.js; $V check demo --reported done > "$T/c.json" 2>&1; rc=$?
expect "Check level: group: the first task of a group passes its own Done when" '[ $rc = 0 ] && grep -q "Check level: group" "$T/c.json"'
$V next demo --per-task > /dev/null 2>&1; echo 2 > src/d2.js; $V check demo --reported done > /dev/null 2>&1
$V next demo --per-task > /dev/null 2>&1; echo 3 > src/d3.js; $V check demo --reported done > "$T/c.json" 2>&1; rc=$?
expect "Check level: group: the check that ends the group (task 1.3) catches the fault (exit 1)" '[ $rc = 1 ] && grep -q "tests failed" "$T/c.json"'
unset SPEC_CHECK_LEVEL; rm -f src/broken.js; export SPEC_TEST_CMD="echo x >> $TC"

echo "== a review task always runs the project commands"
export SPEC_CHECK_LEVEL=finish SPEC_TEST_CMD="echo x >> $TC"
plan5; printf '## 3. Review\n- [ ] 3.R Review the whole change\n  - Done when: `echo r >> %s` exits 0\n' "$DC" >> "$C/tasks.md"; git add -A; git commit -qm r >/dev/null 2>&1
for i in 1 2 3 4 5; do $V next demo --per-task > /dev/null 2>&1; echo "$i" > "src/e$i.js"; $V check demo --reported done > /dev/null 2>&1; done
expect "five tasks at Check level: finish ran no project command" '[ "$(counts)" = "0/0/0/5" ]'
$V next demo --per-task > /dev/null 2>&1; printf '## Review\n- Reviewed: no findings.\n' >> "$C/progress.md"; echo r > src/review.js; $V check demo --reported done > "$T/c.json" 2>&1; rc=$?
expect "the review task ran the tests, typecheck and lint once (1/1/1/6)" '[ "$(counts)" = "1/1/1/6" ]'
unset SPEC_CHECK_LEVEL
echo; echo "runfreq: $PASS passed, $FAIL failed"; [ "$FAIL" = 0 ]
