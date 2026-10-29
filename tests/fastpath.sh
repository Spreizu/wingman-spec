#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2034
# Planning path tests (quality.cjs planPath, verify-task.cjs lint/next/check/finish/app-map): the fast path
# (Size S, Risk none, no sensitive path, no UI) needs no app-map, design or ADR record; anything else does; a fast change
# whose edits leave its scope is upgraded. Usage: tests/fastpath.sh (needs openspec and node on PATH).
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export SPEC_TRACEABILITY=off OPENSPEC_TELEMETRY=0 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PASS=0; FAIL=0; rc=0; out=""
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }
cd "$T" && mkdir p && cd p && git init -q
openspec init --tools none >/dev/null 2>&1 || mkdir -p openspec/changes openspec/specs
"$PKG/install.sh" . >/dev/null || { echo "install failed"; exit 1; }
sed -i.b 's/Test command: <fill in>/Test command: none/' openspec/config.yaml && rm -f openspec/config.yaml.b
git add -A && git commit -qm init
V="node openspec/scripts/verify-task.cjs"; C=openspec/changes/demo

# change <size> <risk> <files> [tasks...]: a valid change with one capability; only proposal, specs and tasks.
change() {
  rm -rf "$C" openspec/.apply-runs; mkdir -p "$C/specs/demo"
  printf 'Size: %s\nRisk: %s\n\n## Why\nDemo change for the planning path tests.\n\n## What Changes\n- Adds a demo capability.\n\n## Edge cases\n- none named\n' "$1" "$2" > "$C/proposal.md"
  printf '## ADDED Requirements\n\n### Requirement: Demo\nThe system SHALL greet.\n\n#### Scenario: greet\n- **WHEN** asked\n- **THEN** it greets\n' > "$C/specs/demo/spec.md"
  printf '## 1. G\n- [ ] 1.1 one\n  - Files: %s\n  - Done when: `true` exits 0\n- [ ] 1.2 two\n  - Files: %s\n  - Done when: `true` exits 0\n' "$3" "$3" > "$C/tasks.md"
}
paths() { $V lint demo 2>&1 | grep -c '"kind": "path-artifacts"'; }

echo "== which changes are fast"
change S none src/greet.js
expect "S + Risk none + plain files: lint reports no missing artifact (no app-map, design.md or adrs/none.md)" '[ "$(paths)" = 0 ]'
$V size demo > "$T/size.json" 2>&1
expect "size reports the fast path" 'grep -q "\"path\": \"fast\"" "$T/size.json"'
change S none src/auth/session.js
expect "a sensitive path (auth/session) makes it full: the three artifacts are required" '[ "$(paths)" = 1 ] && [ "$($V lint demo 2>&1 | grep -c "sensitive path: src/auth/session.js")" -ge 1 ]'
change S none package.json
expect "a dependency manifest in Files: makes it full" '[ "$(paths)" = 1 ]'
change S none src/Greeting.vue
expect "a UI file in Files: makes it full" '[ "$(paths)" = 1 ]'
change S security src/greet.js
expect "any Risk kind makes it full" '[ "$(paths)" = 1 ]'
change M none src/greet.js
expect "Size M is full" '[ "$(paths)" = 1 ]'
mkdir -p "$C/adrs"; echo a > "$C/app-map.md"; echo a > "$C/design.md"; printf -- '---\nstatus: none\n---\nnone\n' > "$C/adrs/none.md"
expect "full path with app-map.md, design.md and adrs/none.md: no missing artifact" '[ "$(paths)" = 0 ]'
change S none src/greet.js; rm -f "$C/proposal.md"; printf 'Why x\n' > "$C/proposal.md"
expect "no Size line: no path error (the size warning already asks for it)" '[ "$(paths)" = 0 ]'

echo "== app-map script"
change S none src/greet.js
$V app-map demo --apply > "$T/am.json" 2>&1; rc=$?
expect "app-map --apply writes the two lines for a Size S change" '[ $rc = 0 ] && [ "$(wc -l < $C/app-map.md)" = 2 ] && grep -q "^This change: demo - " "$C/app-map.md" && grep -q "^Fits: " "$C/app-map.md"'
change M none src/greet.js
rc=0; $V app-map demo --apply > "$T/am.json" 2>&1 || rc=$?
expect "app-map refuses a Size M change (the full map is written by the analyst)" '[ $rc = 2 ] && [ ! -f $C/app-map.md ]'

echo "== the next packet lists earlier tasks (replaces the agent-written progress file)"
change S none src/greet.js
git add -A >/dev/null; git commit -qm change
$V next demo --per-task --format prompt > "$T/p1.txt" 2>&1
expect "first task: no 'Already done' line" '! grep -q "Already done in this change" "$T/p1.txt"'
sed -i.b 's/^- \[ \] 1.1/- [x] 1.1/' "$C/tasks.md"; rm -f "$C/tasks.md.b"
$V check demo --reported done >/dev/null 2>&1
$V next demo --per-task --format prompt > "$T/p2.txt" 2>&1
expect "second task: names 1.1 and its files" 'grep -q "Already done in this change: 1.1 one (src/greet.js)" "$T/p2.txt"'

echo "== scope upgrade of a fast change"
upgrade_case() { # <label> <stub that edits code> <grep for the reason>
  WHY="$3"
  change S none src/greet.js; git add -A >/dev/null; git commit -qm c --allow-empty
  $V next demo --per-task >/dev/null 2>&1
  eval "$2"
  out="$($V check demo --reported done 2>&1)"; rc=$?
  expect "$1: the task still passes, with a warning, and the upgrade is recorded" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "left the fast path" && grep -q "$WHY" openspec/.apply-runs/demo/upgrade.json'
  rc=0; out="$($V next demo --per-task 2>&1)" || rc=$?
  expect "$1: next refuses until the full artifacts exist (path-artifacts)" '[ $rc = 2 ] && printf "%s" "$out" | grep -q "path-artifacts"'
}
upgrade_case "an edit in a sensitive path" 'mkdir -p src/auth; echo "x" > src/auth/token.js; sed -i.b "s/^- \[ \] 1.1/- [x] 1.1/" $C/tasks.md; rm -f $C/tasks.md.b' "sensitive path"
echo a > "$C/app-map.md"; echo a > "$C/design.md"; mkdir -p "$C/adrs"; printf -- '---\nstatus: none\n---\nnone\n' > "$C/adrs/none.md"
rc=0; $V next demo --per-task > "$T/n.json" 2>&1 || rc=$?
expect "after the three artifacts are written next hands out the next task" '[ $rc = 0 ] && grep -q "\"label\": \"1.2\"" "$T/n.json"'
rm -rf src/auth
git checkout -q . 2>/dev/null; git clean -fdq src 2>/dev/null
upgrade_case "a UI file" 'mkdir -p src; echo "<div/>" > src/Card.vue' "UI files"
git clean -fdq src 2>/dev/null
upgrade_case "more than 150 changed lines" 'mkdir -p src; seq 1 200 > src/big.js' "changed lines"
git clean -fdq src 2>/dev/null
change S none src/greet.js; git add -A >/dev/null; git commit -qm c2 --allow-empty
$V next demo --per-task >/dev/null 2>&1; mkdir -p src; seq 1 20 > src/small.js
out="$($V check demo --reported done 2>&1)"; rc=$?
expect "a small edit in a plain file stays on the fast path (no upgrade file)" '[ $rc = 0 ] && [ ! -f openspec/.apply-runs/demo/upgrade.json ] && ! printf "%s" "$out" | grep -q "left the fast path"'

echo "== final review task only where it pays off"
revlint() { $V lint demo 2>&1 | grep -c "\"kind\": \"review\""; }
change S none src/greet.js; printf -- '- [ ] 1.R Request code review of the whole change\n  - Done when: `true` exits 0\n' >> "$C/tasks.md"
expect "a fast change with a final review task: one warning to delete it" '[ "$(revlint)" = 1 ] && $V lint demo 2>&1 | grep -c "no final review on this change" | grep -q 1'
change S none src/greet.js
expect "a fast change without a review task: no review finding" '[ "$(revlint)" = 0 ]'
change M none src/greet.js; mkdir -p "$C/adrs"; echo a > "$C/app-map.md"; echo a > "$C/design.md"; echo a > "$C/adrs/none.md"
expect "Size M without a final review task: warned" '[ "$(revlint)" = 1 ]'
printf -- '- [ ] 1.R Request code review of the whole change\n  - Done when: `true` exits 0\n' >> "$C/tasks.md"
expect "Size M with the final review task: no review finding" '[ "$(revlint)" = 0 ]'
change S none src/Greeting.vue
expect "a UI change without a final review task: warned" '[ "$(revlint)" = 1 ]'
$V size demo > "$T/size.json" 2>&1
expect "size reports review_required for it" 'grep -q "\"review_required\": true" "$T/size.json"'

echo "== dispatch scope: Size S one batch, Size M/L one group, review alone, --per-task"
gtasks() { printf '## 1. A\n- [ ] 1.1 one\n  - Files: src/a.js\n  - Done when: `true` exits 0\n- [ ] 1.2 two\n  - Files: src/b.js\n  - Done when: `test -f src/marker` exits 0\n## 2. B\n- [ ] 2.1 three\n  - Files: src/c.js\n  - Done when: `true` exits 0\n- [ ] 2.R Request code review of the whole change\n  - Done when: `true` exits 0\n' > "$C/tasks.md"; }
change S none src/a.js; gtasks; git add -A >/dev/null; git commit -qm g --allow-empty; mkdir -p src
$V next demo --format prompt > "$T/b1.txt" 2>&1; rc=$?
expect "Size S: next hands out every implementation task, not the review (3 tasks, one prompt)" '[ $rc = 0 ] && grep -q "Implement these 3 tasks, in order" "$T/b1.txt" && grep -q "^Task 1.1: one" "$T/b1.txt" && grep -q "^Task 2.1: three" "$T/b1.txt" && ! grep -q "^Task 2.R" "$T/b1.txt"'
out="$($V check demo --reported done 2>&1)"; rc=$?
expect "the batch is rejected as a whole when one Done when fails; nothing is ticked" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "done_when failed" && ! grep -q "\[x\]" "$C/tasks.md"'
$V next demo --format prompt > "$T/b2.txt" 2>&1
expect "the retry prompt carries the failure and the same three tasks" 'grep -q "Implement these 3 tasks" "$T/b2.txt" && grep -q "done_when failed" "$T/b2.txt"'
touch src/marker; out="$($V check demo --reported done 2>&1)"; rc=$?
expect "one check passes the batch, the verifier ticks all three boxes and the progress it reports counts them" '[ $rc = 0 ] && [ "$(grep -c "^- \[x\]" "$C/tasks.md")" = 3 ] && printf "%s" "$out" | tr -d " \n" | grep -q "\"complete\":3"'
$V next demo --format prompt > "$T/b3.txt" 2>&1
expect "the review task is its own dispatch" 'grep -q "ONE task" "$T/b3.txt" && grep -q "^Task 2.R" "$T/b3.txt"'
out="$($V check demo --reported done 2>&1)"; rc=$?; $V next demo >/dev/null 2>&1; rc2=$?
expect "after the review all tasks are done (exit 10)" '[ $rc = 0 ] && [ $rc2 = 10 ]'
rm -f src/marker
change M none src/a.js; mkdir -p "$C/adrs"; printf '## Capability inventory\n- demo\n' > "$C/app-map.md"; printf '## Decisions\nOne.\n\n## Implementation guide\nOne.\n' > "$C/design.md"; echo a > "$C/adrs/none.md"; gtasks; git add -A >/dev/null; git commit -qm m --allow-empty
$V next demo --format prompt > "$T/b4.txt" 2>&1
expect "Size M: next hands out group 1 only (1.1 and 1.2)" 'grep -q "Implement these 2 tasks" "$T/b4.txt" && grep -q "^Task 1.2: two" "$T/b4.txt" && ! grep -q "^Task 2.1" "$T/b4.txt"'
change S none src/a.js; gtasks; git add -A >/dev/null; git commit -qm p --allow-empty
$V next demo --format prompt --per-task > "$T/b5.txt" 2>&1
expect "--per-task: one task per dispatch even on Size S" 'grep -q "ONE task" "$T/b5.txt" && grep -q "^Task 1.1: one" "$T/b5.txt" && ! grep -q "^Task 1.2" "$T/b5.txt"'

echo "fastpath: passed=$PASS failed=$FAIL"; [ "$FAIL" = 0 ]
