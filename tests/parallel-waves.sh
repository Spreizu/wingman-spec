#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# Parallel waves: `next` hands out the tasks of one group with disjoint Files: as one packet each; `check --task` checks
# each as its subagent returns. Seeded faults: an edit outside every task's Files:, a failing lane, a project command
# that breaks a task that passed earlier in the wave, a failure no task can be blamed for, a blocked lane.
# Usage: tests/parallel-waves.sh (needs the wingman-spec binary, see tests/lib/ws.sh, git and jq). Exit 0 when all pass.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/ws.sh
. "$PKG/tests/lib/ws.sh"
T="${KEEP:-$(mktemp -d)}"; [ -n "${KEEP:-}" ] || trap 'rm -rf "$T"' EXIT
export WINGMAN_SPEC_TRACEABILITY=off GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
unset WINGMAN_SPEC_NO_CACHE WINGMAN_SPEC_TEST_RUN WINGMAN_SPEC_PROFILE
export WINGMAN_SPEC_CHECK_LEVEL=group WINGMAN_SPEC_TYPECHECK_CMD="" WINGMAN_SPEC_LINT_CMD=""
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
V="$WS"; C=.wingman-spec/changes/demo
cd "$T" && mkdir p && cd p && git init -q
ws_init .
ws_set parallel 3
# The project test: fails naming every source file that contains BROKEN; NOFILE fails without naming one.
printf 'for f in src/*.js; do grep -q BROKEN "$f" && { echo "error in $f"; exit 1; }; done\ngrep -q NOFILE src/*.js && { echo "something broke"; exit 1; }\nexit 0\n' > t.sh
export WINGMAN_SPEC_TEST_CMD="sh t.sh"
plan() { # plan <tasks.md body>
  rm -rf "$C" .wingman-spec/runs; mkdir -p "$C/specs" "$C/adrs" src
  printf 'Size: M\nRisk: none\n\n## Why\nDemo.\n\n## What Changes\n- Adds a demo capability.\n\n## Edge cases\n- none named\n' > "$C/proposal.md"
  printf '## ADDED\n\n### Requirement: Demo\nThe system SHALL greet.\nWhy: A visitor wants a greeting, so that they feel welcome.\n\n#### Scenario: greet\n- **WHEN** asked\n- **THEN** it greets\n' > "$C/specs/demo.md"
  printf '## Capability inventory\n- demo\n' > "$C/app-map.md"; printf '## Decisions\nOne.\n\n## Implementation guide\nOne.\n' > "$C/design.md"
  printf -- '---\nstatus: none\n---\nnone\n' > "$C/adrs/none.md"
  printf '%s\n' "$1" > "$C/tasks.md"
  for x in a b c d; do echo "module.exports = 1;" > "src/$x.js"; done
  git add -A; git commit -qm plan >/dev/null 2>&1 || true
}
task() { printf -- '- [ ] %s %s\n  - Files: %s\n  - Done when: `true` exits 0\n' "$1" "$2" "$3"; }
THREE="$(printf '## 1. G\n%s\n%s\n%s\n' "$(task 1.1 alpha src/a.js)" "$(task 1.2 beta src/b.js)" "$(task 1.3 gamma src/c.js)")"
chk() { out="$($V check demo "$@" 2>"$T/err")"; rc=$?; }
ticked() { grep -c '^- \[x\]' "$C/tasks.md"; }

echo "== forming a wave"
plan "$THREE"
$V next demo > "$T/n.json" 2>/dev/null; rc=$?
expect "three tasks with disjoint Files: are one wave of three packets" '[ $rc = 0 ] && [ "$(jq -r .result "$T/n.json")" = wave ] && [ "$(jq -c .tasks "$T/n.json")" = "[\"1.1\",\"1.2\",\"1.3\"]" ] && [ "$(jq ".packets|length" "$T/n.json")" = 3 ]'
expect "each packet names its own files and its check command" '[ "$(jq -r ".packets[1].files[0]" "$T/n.json")" = src/b.js ] && jq -r ".packets[1].check" "$T/n.json" | grep -q -- "--task 1.2"'
$V next demo --format prompt > "$T/n.txt" 2>/dev/null
expect "the prompt format is one header and one prompt per task, each limited to its files" 'head -1 "$T/n.txt" | grep -q "^WAVE 1: 3 tasks" && [ "$(grep -c "^=== packet " "$T/n.txt")" = 3 ] && grep -q "Edit only the files of this task: src/c.js" "$T/n.txt"'
plan "$THREE"; $V next demo --parallel 1 > "$T/n1.json" 2>/dev/null
expect "--parallel 1 turns waves off (one dispatch)" '[ "$(jq -r .result "$T/n1.json")" = task ]'
plan "$(printf '## 1. G\n%s\n%s\n%s\n' "$(task 1.1 alpha src/a.js)" "$(task 1.2 beta "src/a.js, src/b.js")" "$(task 1.3 gamma src/c.js)")"
$V next demo > "$T/n.json" 2>/dev/null
expect "a task sharing a file with an earlier one waits for a later wave" '[ "$(jq -c .tasks "$T/n.json")" = "[\"1.1\",\"1.3\"]" ]'
plan "$(printf '## 1. G\n%s\n%s\n  - After: 1.1\n%s\n' "$(task 1.1 alpha src/a.js)" "$(task 1.2 beta src/b.js)" "$(task 1.3 gamma src/c.js)")"
$V next demo > "$T/n.json" 2>/dev/null
expect "After: an open task keeps a task out of the wave" '[ "$(jq -c .tasks "$T/n.json")" = "[\"1.1\",\"1.3\"]" ]'
plan "$(printf '## 1. G\n%s\n%s\n%s\n' "$(task 1.1 alpha src/a.js)" "$(task 1.2 deps package.json)" "$(task 1.3 gamma src/c.js)")"
$V next demo > "$T/n.json" 2>/dev/null
expect "a task touching a shared manifest ends the wave (no wave of one: the group is one dispatch)" '[ "$(jq -r .result "$T/n.json")" = task ]'
plan "$(printf '## 1. G\n%s\n%s\n\n## 2. H\n%s\n' "$(task 1.1 alpha src/a.js)" "$(task 1.2 beta src/b.js)" "$(task 2.1 gamma src/c.js)")"
$V next demo > "$T/n.json" 2>/dev/null
expect "a wave never crosses its group" '[ "$(jq -c .tasks "$T/n.json")" = "[\"1.1\",\"1.2\"]" ]'
ws_set parallel 2; plan "$THREE"; $V next demo > "$T/n.json" 2>/dev/null; ws_set parallel 3
expect "parallel: 2 in the config caps the wave at two tasks" '[ "$(jq -c .tasks "$T/n.json")" = "[\"1.1\",\"1.2\"]" ]'

echo "== checking the lanes"
plan "$THREE"; $V next demo >/dev/null 2>&1
echo "module.exports = 2;" > src/a.js; echo "module.exports = 2;" > src/b.js
chk
expect "check without --task in an open wave is refused and names the tasks" '[ $rc = 2 ] && grep -q "pass --task" "$T/err" && grep -q "1.1, 1.2, 1.3" "$T/err"'
chk --task 1.1
expect "a lane passes on its own while the others are still working; only its box is ticked" '[ $rc = 0 ] && [ "$(ticked)" = 1 ] && grep -q "^- \[x\] 1.1" "$C/tasks.md" && [ "$(printf "%s" "$out" | jq -c .wave.open)" = "[\"1.2\",\"1.3\"]" ]'
expect "the project tests wait for the last check of the wave" 'printf "%s" "$out" | jq -r ".checks[]|select(.check==\"tests\")|.skipped" | grep -q "parallel wave"'
chk --task 1.1
expect "a lane that already passed is not checked again" '[ $rc = 2 ] && grep -q "already passed" "$T/err"'
echo "module.exports = 2;" > src/d.js
chk --task 1.2
expect "FAULT: an edit to a file no task of the wave names fails the lane and names the file" '[ $rc = 1 ] && printf "%s" "$out" | jq -r ".failures[]" | grep -q "src/d.js changed during the parallel wave" && [ "$(ticked)" = 1 ]'
git checkout -q src/d.js
chk --task 1.2
expect "after the stray edit is reverted the lane passes (attempt 2)" '[ $rc = 0 ] && [ "$(ticked)" = 2 ]'
echo "module.exports = 'BROKEN';" > src/a.js; echo "module.exports = 2;" > src/c.js
chk --task 1.3
expect "FAULT: the last check's tests break a file of a lane that passed: that lane is reopened, this one passes" '[ $rc = 0 ] && grep -q "^- \[x\] 1.3" "$C/tasks.md" && grep -q "^- \[ \] 1.1" "$C/tasks.md" && printf "%s" "$out" | jq -r ".warnings[]" | grep -q "tasks 1.1, which passed earlier"'
$V next demo > "$T/n.json" 2>/dev/null; rc=$?
expect "next hands out only the reopened task, with the failure in its packet" '[ $rc = 0 ] && [ "$(jq -c .tasks "$T/n.json")" = "[\"1.1\"]" ] && jq -r ".packets[0].last_failure" "$T/n.json" | grep -q "error in src/a.js"'
echo "module.exports = 3;" > src/a.js
chk --task 1.1
expect "the fixed task passes; the wave is over and the full tests ran" '[ $rc = 0 ] && [ "$(ticked)" = 3 ] && [ "$(printf "%s" "$out" | jq -r .wave.done)" = true ] && printf "%s" "$out" | jq -e ".checks[]|select(.check==\"tests\" and .ok==true and (.skipped==null))" >/dev/null'
$V next demo >/dev/null 2>&1; rc=$?
expect "every task is done: next says complete" '[ $rc = 10 ]'

echo "== a failure no task can be blamed for"
plan "$THREE"; $V next demo >/dev/null 2>&1
echo "module.exports = 2;" > src/a.js; chk --task 1.1; echo "module.exports = 2;" > src/b.js; chk --task 1.2
echo "module.exports = 'NOFILE';" > src/c.js; chk --task 1.3
expect "FAULT: a failure that names no task's file reopens the whole wave and fails the last task" '[ $rc = 1 ] && [ "$(ticked)" = 0 ] && printf "%s" "$out" | jq -r ".warnings[]" | grep -q "whole wave is reopened"'
$V next demo > "$T/n.json" 2>/dev/null
expect "next hands the whole wave out again" '[ "$(jq -c .tasks "$T/n.json")" = "[\"1.1\",\"1.2\",\"1.3\"]" ]'

echo "== a typecheck break"
printf 'for f in src/*.js; do grep -q TYPEERR "$f" && { echo "$f:1:1 - error TS2322: type mismatch"; exit 1; }; done\nexit 0\n' > tc.sh
plan "$THREE"; $V next demo >/dev/null 2>&1
echo "module.exports = 2;" > src/a.js; chk --task 1.1; echo "module.exports = 2;" > src/b.js; chk --task 1.2
echo "module.exports = 'TYPEERR';" > src/c.js; WINGMAN_SPEC_TYPECHECK_CMD="sh tc.sh" chk --task 1.3
expect "FAULT: the typecheck at the last check names the last task's own file: only that task fails" '[ $rc = 1 ] && [ "$(ticked)" = 2 ] && printf "%s" "$out" | jq -r ".failures[]" | grep -q "src/c.js:1:1"'
echo "module.exports = 2;" > src/c.js; WINGMAN_SPEC_TYPECHECK_CMD="sh tc.sh" chk --task 1.3
expect "the fixed task passes and the wave is over" '[ $rc = 0 ] && [ "$(ticked)" = 3 ]'

echo "== a blocked lane"
plan "$THREE"; $V next demo >/dev/null 2>&1
echo "the API is missing" > "$C/BLOCKED.md"; chk --task 1.2 --reported blocked
expect "FAULT: a blocked lane stops only itself (exit 3) and says to check the others" '[ $rc = 3 ] && printf "%s" "$out" | jq -r .next | grep -q "1.1, 1.3"'
echo "module.exports = 2;" > src/a.js; chk --task 1.1
expect "another lane still passes while BLOCKED.md exists, with a warning" '[ $rc = 0 ] && printf "%s" "$out" | jq -r ".warnings[]" | grep -q "another task of this wave is blocked"'
$V next demo >/dev/null 2>&1; rc=$?
expect "next reports the change blocked" '[ $rc = 3 ]'

echo "== timeline and status"
expect "timeline events of a wave carry wave and lane" 'grep "\"summary\":\"picked " .wingman-spec/runs/demo/timeline.jsonl | tail -3 | jq -s -e "map(.wave==1) == [true,true,true] and (map(.lane)==[1,2,3])" >/dev/null && grep "\"event\":\"check\"" .wingman-spec/runs/demo/timeline.jsonl | tail -1 | jq -e ".lane==1" >/dev/null'

echo
echo "parallel-waves: passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
