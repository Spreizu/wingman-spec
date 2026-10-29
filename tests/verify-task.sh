#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2034 # stub subagents and expectations are single-quoted on purpose (run later by bash -c / eval); SC2034: variables read inside those eval strings
# Orchestrator/verifier contract tests for openspec/scripts/verify-task.cjs, with stub subagents
# (shell snippets that edit the change the way a misbehaving agent would). No agent CLI needed.
# Usage: tests/verify-task.sh   (needs openspec and node on PATH). Exit 0 when every case passes.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export SPEC_TRACEABILITY=off OPENSPEC_TELEMETRY=0 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
export SPEC_CHECK_LEVEL=task # this suite gates the project commands at every check; tests/targeted.sh covers the default
PASS=0; FAIL=0; CAUGHT=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }
fault() { if eval "$2"; then CAUGHT=$((CAUGHT+1)); ok "fault caught: $1"; else bad "fault missed: $1  (rc=$rc)"; fi; }

cd "$T" && mkdir p && cd p && git init -q
openspec init --tools none >/dev/null 2>&1 || mkdir -p openspec/changes openspec/specs
"$PKG/install.sh" . >/dev/null || { echo "install failed"; exit 1; }
echo "== config placeholders"
mkdir -p openspec/changes/demo/specs/demo
printf '## Why\nDemo change for the verifier contract tests.\n\n## What Changes\n- Adds a demo capability.\n\n## Edge cases\n- none named\n' > openspec/changes/demo/proposal.md
printf '## ADDED Requirements\n\n### Requirement: Demo\nThe system SHALL greet.\n\n#### Scenario: greet\n- **WHEN** asked\n- **THEN** it greets\n' > openspec/changes/demo/specs/demo/spec.md
printf -- '- [ ] 1.1 a\n' > openspec/changes/demo/tasks.md
rc=0; node openspec/scripts/verify-task.cjs next demo > "$T/ph.json" 2> "$T/ph.err" || rc=$?
expect "next refuses while Test command is still <fill in> (exit 2)" '[ $rc = 2 ] && grep -q "placeholder" "$T/ph.err"'
rc=0; node openspec/scripts/verify-task.cjs doctor > "$T/doc.json" 2>&1 || rc=$?
expect "doctor reports the placeholder (exit 1)" '[ $rc = 1 ] && grep -q "Test command" "$T/doc.json"'
expect "no UI in the repo: installer wrote visual: off" 'grep -q "^visual: off" openspec/config.yaml'
rm -rf openspec/changes/demo openspec/.apply-runs
sed -i.b 's/Test command: <fill in>/Test command: none/' openspec/config.yaml && rm -f openspec/config.yaml.b
git add -A && git commit -qm init
V="node openspec/scripts/verify-task.cjs"
C=openspec/changes/demo

# A minimal change that passes `openspec validate --strict`.
reset_change() { # reset_change <tasks.md body>
  rm -rf "$C" openspec/.apply-runs; mkdir -p "$C/specs/demo"
  printf '## Why\nDemo change for the verifier contract tests.\n\n## What Changes\n- Adds a demo capability.\n\n## Edge cases\n- none named\n' > "$C/proposal.md"
  printf '## ADDED Requirements\n\n### Requirement: Demo\nThe system SHALL greet.\n\n#### Scenario: greet\n- **WHEN** asked\n- **THEN** it greets\n' > "$C/specs/demo/spec.md"
  printf '%s\n' "$1" > "$C/tasks.md"
}
# Stub subagents: they get $F (tasks.md) and act on the first open task line.
TICK1='n=$(grep -nE "^[-*] \[ \]" "$F" | head -1 | cut -d: -f1); sed -i.b "${n}s/\[ \]/[x]/" "$F"; rm -f "$F.b"'
# orch <stub> [reported] [extra check opts...]: one orchestrator step (next -> subagent -> check). Sets rc, out.
orch() {
  local stub="$1" rep="${2:-done}"; shift 2 2>/dev/null || shift $#
  $V next demo >/dev/null 2>&1 || { rc=$?; out="next exited $rc"; return; }
  F="$C/tasks.md" bash -c "$stub"
  out="$($V check demo --reported "$rep" "$@" 2>&1)"; rc=$?
}

echo "== happy path"
reset_change '## 1. G
- [ ] 1.1 one
  - Done when: `true` exits 0
- [ ] 1.2 two
  - Done when: `test -f '"$C"'/tasks.md`'
$V next demo --format prompt > "$T/prompt.txt"; rc=$?
expect "next exits 0 and prints the task prompt" '[ $rc = 0 ] && grep -q "Task 1.1: one" "$T/prompt.txt" && grep -q "STATUS: done" "$T/prompt.txt"'
F="$C/tasks.md" bash -c "$TICK1"; out="$($V check demo)"; rc=$?
expect "check passes a correct tick" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "\"result\": \"passed\""'
grep -q "^- \[x\] 1.1" "$C/tasks.md" && ok "verifier ticked 1.1 itself when the agent ticked it (no double edit)" || bad "1.1 not ticked"
reset_change '- [ ] 1.1 a
  - Done when: `true`
- [ ] 1.2 b
  - Done when: `true`'
orch ':' "done"
expect "D-8: the agent does not tick: check passes and the verifier ticks the box itself" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "\"result\": \"passed\"" && grep -q "^- \[x\] 1.1 a" "$C/tasks.md" && grep -q "^- \[ \] 1.2 b" "$C/tasks.md"'
orch ':' "done"
expect "D-8: a second task, again unticked by the agent, is ticked at its own line" '[ $rc = 0 ] && grep -q "^- \[x\] 1.2 b" "$C/tasks.md" && ! printf "%s" "$out" | grep -q "not ticked"'
reset_change '- [ ] 1.1 a
  - Done when: `false`'
orch ':' "done"
expect "D-8: a failing Done when with no tick: rejected, box stays open (the verifier ticks only on pass)" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "done_when failed" && grep -q "^- \[ \] 1.1" "$C/tasks.md"'
reset_change '- [ ] 1.1 a
  - Done when: `true`
- [ ] 1.2 b'
orch 'sed -i.b "s/^- \[ \] 1.2/- [x] 1.2/" "$F"; rm -f "$F.b"' "done"
expect "D-8: ticking another task than the target is still rejected, and nothing is ticked" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "edited outside the target checkbox" && grep -q "^- \[ \] 1.1" "$C/tasks.md" && grep -q "^- \[ \] 1.2" "$C/tasks.md"'
reset_change '- [ ] 1.1 a
  - Done when: `true`
- [ ] 1.2 two
  - Done when: `test -f '"$C"'/tasks.md`'
$V next demo >/dev/null 2>&1; F="$C/tasks.md" bash -c "$TICK1"; $V check demo >/dev/null 2>&1
rc=0; out="$($V check demo 2>&1)" || rc=$?
expect "check after a passed task without next fails with a clear message (no TypeError)" '[ $rc = 2 ] && printf "%s" "$out" | grep -q "no task in progress: the last task was already checked and passed; run \`next demo\`" && ! printf "%s" "$out" | grep -q TypeError'
orch "$TICK1" "done"; expect "second task passes" '[ $rc = 0 ]'
$V next demo >/dev/null 2>&1; rc=$?
expect "next exits 10 when all tasks are done" '[ $rc = 10 ]'
expect "run log is git-ignored (git status clean of .apply-runs)" '! git status --porcelain --untracked-files=all | grep -q apply-runs'
expect "metrics.jsonl has dispatch and check lines" '[ "$(cat openspec/.apply-runs/demo/*/metrics.jsonl | grep -c "\"event\":\"check\"")" = 2 ]'

echo "== injected faults"
reset_change '- [ ] 1.1 a
  - Done when: `true`
- [ ] 1.2 b'
cp "$C/tasks.md" "$T/pre.md"
orch 'sed -i.b "/\[ \]/d" "$F"; rm -f "$F.b"' "done"
fault "1 subagent deletes tasks" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "tasks deleted" && cmp -s "$T/pre.md" "$C/tasks.md"'
reset_change '- [ ] 1.1 a
- [ ] 1.2 b'
cp "$C/tasks.md" "$T/pre.md"
orch 'sed -i.b "s/\[ \]/[x]/" "$F"; rm -f "$F.b"' "done"
fault "2 subagent ticks more than one task" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "more than one task ticked" && cmp -s "$T/pre.md" "$C/tasks.md"'
reset_change '- [ ] 1.1 a
  - Done when: `false`'
orch "$TICK1" "done"
fault "3 ticked but the Done when command fails (tick reverted)" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "done_when failed" && grep -q "^- \[ \] 1.1" "$C/tasks.md"'
reset_change '- [ ] 1.1 a
  - Done when: `true`'
orch "$TICK1" "failed"
fault "4 subagent reports failure after ticking (tick reverted)" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "STATUS: failed" && grep -q "^- \[ \] 1.1" "$C/tasks.md"'
reset_change '- [x] 1.1 a
* [ ] 1.2 star bullet'
$V next demo > "$T/n.json" 2>&1; rc=$?
fault "5 a '* [ ]' task is not treated as done" '[ $rc = 0 ] && grep -q "\"label\": \"1.2\"" "$T/n.json"'
reset_change '- [ ] 1.1 a
  - Done when: `sleep 30`'
s=$(date +%s); orch "$TICK1" "done" --timeout 2; elapsed=$(( $(date +%s) - s ))
fault "6 hung check is killed by the per-check timeout" '[ $rc = 1 ] && [ $elapsed -lt 15 ] && printf "%s" "$out" | grep -q "timed out after 2s"'
rc=0; $V next demo --max-attempts abc >/dev/null 2>&1 || rc=$?; r1=$rc
rc=0; $V check demo --timeout 0 >/dev/null 2>&1 || rc=$?
fault "7 non-numeric or zero limits are rejected (exit 2)" '[ $r1 = 2 ] && [ $rc = 2 ]'
echo "  faults caught: $CAUGHT/7"; [ "$CAUGHT" = 7 ] || bad "expected 7 injected faults caught"

echo "== retries, stop conditions, ambiguity"
reset_change '- [ ] 1.1 a
  - Done when: `false`'
orch "$TICK1" "done" --max-attempts 2
$V next demo --format prompt --max-attempts 2 > "$T/retry.txt"; rc=$?
expect "retry prompt carries the previous failure" '[ $rc = 0 ] && grep -q "attempt 2 of 2" "$T/retry.txt" && grep -q "done_when failed" "$T/retry.txt"'
F="$C/tasks.md" bash -c "$TICK1"; out="$($V check demo --max-attempts 2)"; rc=$?
expect "last allowed attempt fails with exit 4" '[ $rc = 4 ]'
$V next demo >/dev/null 2>&1; rc=$?
expect "next keeps refusing after exhaustion (exit 4)" '[ $rc = 4 ]'
$V next demo --new-run >/dev/null 2>&1; rc=$?
expect "--new-run starts a fresh run" '[ $rc = 0 ] && [ "$(ls -d openspec/.apply-runs/demo/*/ | wc -l)" = 2 ]'
reset_change '- [ ] 1.1 a
  - Done when: `true`'
orch 'sed -i.b "s/Done when: .true./Done when: \`echo edited\`/" "$F"; rm -f "$F.b"; '"$TICK1" "done"
expect "editing a detail line (weakening Done when) is rejected" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "edited outside the target checkbox"'
reset_change '- [ ] 1.1 a'
orch 'echo "spec is ambiguous" > "$(dirname "$F")/BLOCKED.md"' blocked
expect "BLOCKED.md stops with exit 3" '[ $rc = 3 ]'
$V next demo >/dev/null 2>&1; rc=$?
expect "next reports BLOCKED.md with exit 3" '[ $rc = 3 ]'
reset_change '- [ ] 1.1 a
```md
- [ ] 9.9 example in a fence
```'
$V next demo > "$T/amb.json" 2>&1; rc=$?
expect "fenced checkbox is refused before dispatch (exit 2)" '[ $rc = 2 ] && grep -q "\"kind\": \"fenced\"" "$T/amb.json"'
reset_change '- [ ] 1.1 a
  - [ ] nested sub-step'
$V lint demo >/dev/null 2>&1; rc=$?
expect "lint flags nested checkboxes" '[ $rc = 1 ]'
reset_change '- [ ] 1.1 a'
orch "$TICK1" "done" --test-cmd 'exit 3'
expect "failing project test command rejects the task" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "tests failed (exit 3)"'
sed -i.b 's/Test command: none/Test command: `exit 5`/' openspec/config.yaml && rm -f openspec/config.yaml.b
reset_change '- [ ] 1.1 a'
orch "$TICK1" "done"
expect "Test command from openspec/config.yaml is used" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "tests failed (exit 5)"'
git checkout -q openspec/config.yaml
reset_change '- [ ] 1.1 a'
rm -rf "$C/specs"
orch "$TICK1" "done"
expect "openspec validate --strict failure rejects the task" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "validate failed"'
out="$($V check demo 2>&1)"; rc=$?
expect "a repeated check after a failed check runs again without next (and fails the same way)" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "opened by this check" && printf "%s" "$out" | grep -q "validate failed"'

echo "== re-ticked tasks are verified, never skipped"
reset_change '- [ ] 1.1 a
  - Done when: `test -f ok.flag`
- [ ] 1.2 b
  - Done when: `true`'
orch "$TICK1" "done"
expect "control: the first attempt fails (Done when) and the tick is reverted" '[ $rc = 1 ] && grep -q "^- \[ \] 1.1" "$C/tasks.md"'
F="$C/tasks.md" bash -c "$TICK1"; rc=0; out="$($V next demo 2>&1)" || rc=$?
fault "re-ticking a failed task and calling next does not skip it to 1.2: next refuses (exit 2) and says to run check" '[ $rc = 2 ] && printf "%s" "$out" | grep -q "task 1.1 is ticked in tasks.md but has no passing check: run .check demo --reported done." && ! printf "%s" "$out" | grep -q "\"label\": \"1.2\""'
touch ok.flag; rc=0; out="$($V check demo 2>&1)" || rc=$?
expect "check right after the refusal verifies the re-ticked task (no untick/next/retick dance)" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "\"result\": \"passed\"" && printf "%s" "$out" | grep -q "attempt 2 of 3 of task 1.1 opened by this check"'
rm -f ok.flag
$V next demo > "$T/n.json" 2>&1; rc=$?
expect "then next hands out 1.2" '[ $rc = 0 ] && grep -q "\"label\": \"1.2\"" "$T/n.json"'
reset_change '- [ ] 1.1 a
  - Done when: `true`
- [ ] 1.2 b
  - Done when: `true`
- [ ] 1.3 c'
orch "$TICK1" "done"
sed -i.b 's/^- \[ \] 1.2 b$/- [x] 1.2 b/' "$C/tasks.md"; rm -f "$C/tasks.md.b"
rc=0; out="$($V next demo 2>&1)" || rc=$?
fault "a task ticked without any check is refused by next (exit 2, untick it), not skipped" '[ $rc = 2 ] && printf "%s" "$out" | grep -q "ticked tasks that no check passed: 1.2 b" && printf "%s" "$out" | grep -q "Untick them"'
sed -i.b 's/^- \[x\] 1.2 b$/- [ ] 1.2 b/' "$C/tasks.md"; rm -f "$C/tasks.md.b"
$V next demo > "$T/n.json" 2>&1; rc=$?
expect "after unticking, next hands out 1.2 (the verified 1.1 stays done)" '[ $rc = 0 ] && grep -q "\"label\": \"1.2\"" "$T/n.json"'

echo "== workspace layout (specs repo linked by openspec/workspace.yaml)"
mkdir -p "$T/specs" "$T/code" && "$PKG/install.sh" "$T/code" --specs "$T/specs" >/dev/null && sed -i.b 's/Test command: <fill in>/Test command: none/' "$T/code/openspec/workspace.yaml"  # nothing detected in this repo: its own file holds the placeholder
( cd "$T/specs" && rm -rf openspec/changes/w && mkdir -p openspec/changes/w/specs/demo && printf '## ADDED Requirements\n\n### Requirement: Demo\nThe system SHALL greet.\n\n#### Scenario: greet\n- **WHEN** asked\n- **THEN** it greets\n' > openspec/changes/w/specs/demo/spec.md && printf '## Why\nWorkspace demo.\n\n## What Changes\n- Demo.\n\n## Edge cases\n- none named\n' > openspec/changes/w/proposal.md && printf -- '- [ ] 1.1 a\n  - Done when: `test "$(basename "$PWD")" = code`\n' > openspec/changes/w/tasks.md )
( cd "$T/code" && node openspec/scripts/verify-task.cjs next w >/dev/null && sed -i.b 's/\[ \]/[x]/' "$T/specs/openspec/changes/w/tasks.md" && rm -f "$T/specs/openspec/changes/w/tasks.md.b" && node openspec/scripts/verify-task.cjs check w >/dev/null ); rc=$?
expect "verifier in the code repo follows the link; Done when runs in the code repo" '[ $rc = 0 ]'

echo "== multi-repo workspace: one store, three code repos, each runs its own commands"
M="$T/multi"; mkdir -p "$M/home" "$M/web" "$M/api/tests" "$M/mobile"
menv() { HOME="$M/home" XDG_DATA_HOME="$M/data" XDG_CONFIG_HOME="$M/cfg" GOCACHE="$M/gocache" GOPATH="$M/gopath" SPEC_INSTALL_PROBE=0 OPENSPEC_TELEMETRY=0 "$@"; }
if menv openspec store setup trio --path "$M/store" >/dev/null 2>&1; then
  printf '{"name":"web","scripts":{"test":"node -e \\"require(\x27fs\x27).writeFileSync(\x27ran.txt\x27,\x27web\x27)\\""}}\n' > "$M/web/package.json"
  : > "$M/api/tests/__init__.py"
  printf 'import unittest\nclass T(unittest.TestCase):\n    def test_x(self):\n        open("ran.txt", "w").write("api")\n' > "$M/api/tests/test_ran.py"
  printf 'module mobile\n\ngo 1.18\n' > "$M/mobile/go.mod"
  printf 'package mobile\n\nimport (\n\t"os"\n\t"testing"\n)\n\nfunc TestX(t *testing.T) { os.WriteFile("ran.txt", []byte("mobile"), 0644) }\n' > "$M/mobile/ran_test.go"
  for r in web api mobile; do menv "$PKG/install.sh" "$M/$r" --store trio >/dev/null 2>&1 || bad "install $r into store trio"; done
  dget() { (cd "$M/$1" && menv node openspec/scripts/verify-task.cjs doctor "${@:3}" 2>/dev/null) | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(String(eval("j."+process.argv[1])))' "$2"; }
  expect "web gets npm test from its own file" '[ "$(dget web test_command.cmd)" = "npm test" ] && [ "$(dget web test_command.source)" = "$M/web/openspec/config.yaml" ]'
  expect "api gets unittest from its own file (not the npm test of web)" '[ "$(dget api test_command.cmd)" = "python3 -m unittest discover -s tests -t ." ] && [ "$(dget api test_command.source)" = "$M/api/openspec/config.yaml" ]'
  expect "mobile gets go test from its own file" '[ "$(dget mobile test_command.cmd)" = "go test ./..." ] && [ "$(dget mobile test_command.source)" = "$M/mobile/openspec/config.yaml" ]'
  expect "the shared store config only carries the first repo detection as a default" 'grep -q "^  - Test command: \`npm test\`" "$M/store/openspec/config.yaml" && ! grep -q "unittest\|go test" "$M/store/openspec/config.yaml"'
  for r in web api mobile; do
    c="c-$r"; mkdir -p "$M/store/openspec/changes/$c/specs/demo"
    printf '## ADDED Requirements\n\n### Requirement: Demo\nThe system SHALL greet.\n\n#### Scenario: greet\n- **WHEN** asked\n- **THEN** it greets\n' > "$M/store/openspec/changes/$c/specs/demo/spec.md"
    printf '## Why\nMulti-repo demo.\n\n## What Changes\n- Demo.\n\n## Edge cases\n- none named\n' > "$M/store/openspec/changes/$c/proposal.md"
    printf -- '- [ ] 1.1 a\n' > "$M/store/openspec/changes/$c/tasks.md"
  done
  for r in web api mobile; do
    [ "$r" = mobile ] && ! command -v go >/dev/null 2>&1 && { echo "  skip mobile run (go is not installed)"; continue; }
    rc=0; ( cd "$M/$r" && menv node openspec/scripts/verify-task.cjs next "c-$r" >/dev/null && sed -i.b 's/\[ \]/[x]/' "$M/store/openspec/changes/c-$r/tasks.md" && rm -f "$M/store/openspec/changes/c-$r/tasks.md.b" && menv node openspec/scripts/verify-task.cjs check "c-$r" > "$M/$r.check.json" 2>&1 ) || rc=$?
    expect "$r: check passes and ran ITS test command (marker file in its own repo)" '[ $rc = 0 ] && [ "$(cat "$M/$r/ran.txt" 2>/dev/null)" = "$r" ]'
  done
  # precedence: CLI flag / env var > the repo's own file > the shared store config
  sed -i.b 's/^  - Typecheck command:.*$/  - Typecheck command: `echo root-tc`/' "$M/store/openspec/config.yaml"; rm -f "$M/store/openspec/config.yaml.b"
  sed -i.b '/^  - Typecheck command:/d' "$M/api/openspec/config.yaml"; rm -f "$M/api/openspec/config.yaml.b"
  expect "a key the repo does not set falls back to the store config (api typecheck)" '[ "$(dget api typecheck_command.cmd)" = "echo root-tc" ] && [ "$(dget api typecheck_command.source)" = "$M/store/openspec/config.yaml" ]'
  expect "the repo's own value beats the store config (web typecheck none)" '[ "$(dget web typecheck_command.state)" = none ] && [ "$(dget web typecheck_command.source)" = "$M/web/openspec/config.yaml" ]'
  expect "env var beats the repo file" '[ "$(SPEC_TYPECHECK_CMD="echo env-tc" dget web typecheck_command.cmd)" = "echo env-tc" ] && [ "$(SPEC_TYPECHECK_CMD="echo env-tc" dget web typecheck_command.source)" = SPEC_TYPECHECK_CMD ]'
  expect "--test-cmd beats the repo file and the env var" '[ "$(SPEC_TEST_CMD="echo env" dget api test_command.source --test-cmd "echo flag")" = "--test-cmd" ] && [ "$(SPEC_TEST_CMD="echo env" dget api test_command.source)" = SPEC_TEST_CMD ]'
  sed -i.b 's/^  - Test command:.*$/  - Test command: <fill in>/' "$M/mobile/openspec/config.yaml"; rm -f "$M/mobile/openspec/config.yaml.b"
  expect "a <fill in> in the repo's file stops the lookup (mobile never runs the store's npm test)" '[ "$(dget mobile test_command.state)" = placeholder ] && [ -z "$(dget mobile test_command.cmd | grep -x "npm test")" ]'
  # visual: merged per key
  node -e '
    const fs = require("fs"), f = process.argv[1]; let s = fs.readFileSync(f, "utf8");
    s = s.replace(/^visual:.*(\n[ \t]+.*)*\n?/m, "visual:\n  command: \"echo root-app\"\n  url: http://127.0.0.1:4701/\n  review: subagent\n");
    fs.writeFileSync(f, s);' "$M/store/openspec/config.yaml"
  sed -i.b '/^visual:/d' "$M/web/openspec/config.yaml"; rm -f "$M/web/openspec/config.yaml.b"
  printf 'visual:\n  command: "echo mobile-app"\n  url: http://127.0.0.1:4702/\n' >> "$M/mobile/openspec/config.yaml"; sed -i.b 's/^visual: off.*$//' "$M/mobile/openspec/config.yaml"; rm -f "$M/mobile/openspec/config.yaml.b"
  expect "no visual: in the repo file: the store's visual block applies (web)" '[ "$(dget web visual.command)" = "echo root-app" ] && [ "$(dget web visual.source)" = "$M/store/openspec/config.yaml" ]'
  expect "repo visual: command/url win, other keys come from the store (mobile review: subagent)" '[ "$(dget mobile visual.command)" = "echo mobile-app" ] && [ "$(dget mobile visual.url)" = "http://127.0.0.1:4702/" ] && [ "$(dget mobile visual.review)" = subagent ] && [ "$(dget mobile visual.source)" = "$M/mobile/openspec/config.yaml" ]'
  expect "visual: off in the repo file turns it off for that repo only (api)" '[ "$(dget api visual.off)" = true ] && [ "$(dget web visual.off)" = false ]'
  expect "single-repo layout: the root config is the source" '[ "$(cd "$T/p" && node openspec/scripts/verify-task.cjs doctor 2>/dev/null | node -e "console.log(JSON.parse(require(\"fs\").readFileSync(0,\"utf8\")).test_command.source)")" = "$T/p/openspec/config.yaml" ]'
else
  echo "  skip multi-repo workspace (this openspec CLI has no 'store' command)"
fi

echo "== teammate machine: store pointer not registered (every command exits 2 with the fix, no silent clone)"
if [ -d "$M/web/openspec" ]; then
  TM="$T/teammate"; mkdir -p "$TM/home"
  tm() { (cd "$M/web" && HOME="$TM/home" XDG_DATA_HOME="$TM/data" XDG_CONFIG_HOME="$TM/cfg" OPENSPEC_TELEMETRY=0 node openspec/scripts/verify-task.cjs "$@" 2>&1); }
  tmok() { local out; out="$(tm "$@")"; rc=$?; [ "$rc" = 2 ] && grep -q "store 'trio' is not registered" <<<"$out" && grep -q 'git clone <store repo url> <dir>' <<<"$out" && grep -q 'openspec store register <dir>' <<<"$out"; }
  for c in "doctor" "next c-web" "check c-web" "status c-web" "lint c-web" "size c-web"; do
    expect "unregistered 'trio': '$c' exits 2 and prints the clone/register steps" 'tmok $c'
  done
  expect "the same repo still works on the machine where the store is registered" '[ "$(dget web test_command.cmd)" = "npm test" ]'
  expect "nothing was registered by the failed runs" '[ "$(HOME="$TM/home" XDG_DATA_HOME="$TM/data" XDG_CONFIG_HOME="$TM/cfg" openspec store list --json | grep -c "\"id\"")" = 0 ]'
fi

echo "== installer detects the test command and the visual app"
d="$T/det"; mkdir -p "$d/node" "$d/web" "$d/py/tests" "$d/none"
printf '{"scripts":{"test":"node --test"}}\n' > "$d/node/package.json"
printf '{"scripts":{"build":"vite build","preview":"vite preview","test":"vitest run"},"devDependencies":{"vite":"6"}}\n' > "$d/web/package.json"
: > "$d/py/tests/test_x.py"
for x in node web py none; do "$PKG/install.sh" "$d/$x" > "$d/$x.log" 2>&1; done
expect "node: Test command npm test, visual off" 'grep -q "Test command: \`npm test\`" "$d/node/openspec/config.yaml" && grep -q "^visual: off" "$d/node/openspec/config.yaml"'
expect "vite: visual command and url filled in" 'grep -q "command: \"npm run build && npm run preview -- --port 4173" "$d/web/openspec/config.yaml" && grep -q "url: http://127.0.0.1:4173/" "$d/web/openspec/config.yaml"'
expect "vite without playwright: installer warns the check will be skipped" 'grep -q "SKIPPED" "$d/web.log"'
expect "python tests/: unittest discover" 'grep -q "Test command: \`python3 -m unittest discover -s tests -t .\`" "$d/py/openspec/config.yaml"'
expect "nothing detected: placeholder kept and the installer says so" 'grep -q "Test command: <fill in>" "$d/none/openspec/config.yaml" && grep -q "NOT detected" "$d/none.log"'
expect "generated config still passes openspec schema" '(cd "$d/web" && openspec schema validate wingman-spec >/dev/null 2>&1)'

echo "== visual spec lint"
# visual config for a static site served by python (the check starts and stops it itself)
PORT=$(( 20000 + $$ % 20000 ))
node -e '
  const fs = require("fs"), [f, port] = process.argv.slice(1);
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(/^visual: off.*$/m, `visual:\n  command: python3 -m http.server ${port} --bind 127.0.0.1 --directory site\n  url: http://127.0.0.1:${port}/\n  review: subagent\n  ready_timeout: 20`));' openspec/config.yaml "$PORT"
mkdir -p site && git add -A && git commit -qm visual-config
good_page() { cat > site/index.html <<'HTML'
<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>App</title>
<style>body{font-family:sans-serif;margin:0}header{display:flex;justify-content:space-between;padding:12px;background:#222;color:#fff}main{padding:12px}input{width:100%;box-sizing:border-box}</style></head>
<body><header><h1 data-testid="brand">App</h1><button data-testid="menu" style="background:#fff;color:#000">Menu</button></header>
<main><label for="q">Search results</label><input id="q" data-testid="search"><p data-testid="count">3 results</p>
<div id="empty" data-testid="empty" hidden>No results</div></main>
<script>document.getElementById('q').addEventListener('input',e=>{const none=e.target.value==='zzz';document.getElementById('empty').hidden=!none;document.querySelector('[data-testid=count]').textContent=none?'0 results':'3 results'})</script></body></html>
HTML
}
VSPEC='## ADDED Requirements

### Requirement: Search page
The system SHALL show the brand, a search box and a result count.

#### Scenario: Search page
- **WHEN** the home page is opened at 375, 768 and 1280 px
- **THEN** brand, menu button, search box and count are visible and nothing scrolls sideways

```visual
route: /
key: [data-testid="brand"]
key: [data-testid="menu"]
key: [data-testid="search"]
key: [data-testid="count"]
state: default
state: no-results
  do: fill [data-testid="search"] = zzz
  key: [data-testid="empty"]
```'
reset_visual() { # reset_visual <tasks.md body> [spec body]
  rm -rf "$C" openspec/.apply-runs; mkdir -p "$C/specs/app"
  printf '## Why\nVisual loop contract tests for the verifier.\n\n## What Changes\n- Adds a search page.\n\n## Edge cases\n- none named\n' > "$C/proposal.md"
  printf '%s\n' "${2:-$VSPEC}" > "$C/specs/app/spec.md"; printf '%s\n' "$1" > "$C/tasks.md"; good_page
}
VT='- [ ] 1.1 Search page
  - Spec: app > Search page
  - Files: site/index.html
  - Visual: app/search-page
  - Done when: `true`'
reset_visual "$VT" "${VSPEC/route: \//route: page}"
rc=0; $V next demo > "$T/vl.json" 2>&1 || rc=$?
expect "broken visual block (route without /) is refused before dispatch (exit 2)" '[ $rc = 2 ] && grep -q "route must start with" "$T/vl.json"'
reset_visual "${VT/app\/search-page/app\/nope}"
rc=0; $V next demo > "$T/vl.json" 2>&1 || rc=$?
expect "Visual: naming an unknown scenario is refused (exit 2)" '[ $rc = 2 ] && grep -q "not a visual scenario of this change" "$T/vl.json"'
reset_visual "${VT/  - Visual: app\/search-page
/}"
rc=0; $V lint demo > "$T/vl.json" 2>&1 || rc=$?
expect "lint flags a visual scenario no task names (exit 1)" '[ $rc = 1 ] && grep -q "visual-coverage" "$T/vl.json"'
reset_visual "${VT/Visual: app\/search-page/Visual: Search page}"
rc=0; $V lint demo > "$T/vl.json" 2>&1 || rc=$?
expect "Visual: may name the scenario by its title" '[ $rc = 0 ]'
reset_visual "$VT" "${VSPEC/  key: \[data-testid=\"empty\"\]/  key: [data-testid=\"empty\"]
  overlay: [data-testid=\"toast\"]}"
rc=0; $V lint demo > "$T/vl.json" 2>&1 || rc=$?
expect "an overlay indented under a state says where it belongs (block level, above the first state)" '[ $rc != 0 ] && grep -q "belongs to the whole block, not to state" "$T/vl.json" && grep -q "an overlay listed once covers every state" "$T/vl.json"'
reset_visual '- [ ] 1.1 Search page shell
  - Spec: app > Search page
  - Files: site/index.html
  - Visual: app/search-page
  - Done when: `true`
- [ ] 1.2 Empty state
  - Files: site/index.html
  - Notes: add the empty message [data-testid="empty"] shown when nothing matches
  - Done when: `true`'
rc=0; $V lint demo > "$T/vl.json" 2>&1 || rc=$?
fault "a task names a visual scenario whose key element only a later task builds: lint error" '[ $rc = 1 ] && grep -q "visual-order" "$T/vl.json" && grep -q "only the later task 1.2 mentions it" "$T/vl.json"'
reset_visual "$VT"; sed -i.b 's/^- none named$/- Nothing matches the search (empty result list) -> app\/search-page/' "$C/proposal.md"; rm -f "$C/proposal.md.b"
rc=0; $V lint demo > "$T/vl.json" 2>&1 || rc=$?
expect "a UI edge case pointing at a visual scenario with a matching state passes" '[ $rc = 0 ]'
reset_visual "$VT"; sed -i.b 's/^- none named$/- A very long display name at 375 -> app\/search-page/' "$C/proposal.md"; rm -f "$C/proposal.md.b"
rc=0; $V lint demo > "$T/vl.json" 2>&1 || rc=$?
fault "a UI edge case (long text) whose visual scenario has no state showing it fails lint" '[ $rc = 1 ] && grep -q "needs a visual scenario with a state that shows it" "$T/vl.json"'
reset_visual "$VT"
sed -i.b 's/^state: default$/expect: main > p:nth-child(2) above [data-testid="list"]\nexpect: [data-testid="search"] above [data-testid="count"]\nstate: default/' "$C/specs/app/spec.md"; rm -f "$C/specs/app/spec.md.b"
rc=0; $V lint demo > "$T/vl.json" 2>&1 || rc=$?
expect "lint notes (info, exit 0) a block-level expect that an empty/no-results state probably removes, and says to repeat it under the state" '[ $rc = 0 ] && grep -q "visual-expect-scope" "$T/vl.json" && grep -q "checked on the loaded page only, not in state no-results" "$T/vl.json" && grep -q "repeat it indented under that .state:" "$T/vl.json"'
expect "... but not one about block-level keys (they hold in every state)" '[ "$(grep -c "visual-expect-scope" "$T/vl.json")" = 1 ]'

echo "== quality batch: plan size, typecheck/lint, trace tags, source-text rule, finish"
QC=0
qfault() { if eval "$2"; then QC=$((QC+1)); ok "quality fault caught: $1"; else bad "quality fault missed: $1  (rc=$rc)"; fi; }
reset_change 'Size: S

## 1. G
- [ ] 1.1 a
  - Files: src/a.js
- [ ] 1.2 b
  - Files: src/a.js
- [ ] 1.3 c
- [ ] 1.4 d
- [ ] 1.R Request code review of the whole change'
rc=0; $V lint demo > "$T/pl.json" 2>&1 || rc=$?
qfault "plan over its Size cap (S allows 3, plan has 4): lint fails" '[ $rc = 1 ] && grep -q "\"kind\": \"size-cap\"" "$T/pl.json"'
rc=0; $V next demo > "$T/pn.json" 2>&1 || rc=$?
expect "next refuses a plan over its cap (exit 2)" '[ $rc = 2 ] && grep -q "\"result\": \"plan\"" "$T/pn.json"'
expect "lint names consecutive tasks on the same file as merge candidates" 'grep -q "1.1 and 1.2 both change src/a.js" "$T/pl.json"'
sed -i.b 's/^Size: S/Size: M/' "$C/tasks.md" && rm -f "$C/tasks.md.b"
rc=0; $V lint demo > "$T/pl.json" 2>&1 || rc=$?
expect "the same plan as Size: M passes lint (warnings only)" '[ $rc = 0 ] && ! grep -q "\"kind\": \"size-cap\"" "$T/pl.json"'
reset_change 'Size: M

## 1. G
- [ ] 1.1 a
- [ ] 1.R Request code review for group 1

## 2. Close-out
- [ ] 2.1 Full test suite passes and every spec scenario is covered by a test
- [ ] 2.2 Request final code review of the whole change'
rc=0; $V lint demo > "$T/pl.json" 2>&1 || rc=$?
expect "lint warns about a group review on an M change and about agent close-out tasks" '[ $rc = 0 ] && grep -q "\"kind\": \"review\"" "$T/pl.json" && grep -q "\"kind\": \"closeout\"" "$T/pl.json"'
sed -i.b 's/^## 1. G$/## 1. G (risky)/' "$C/tasks.md" && rm -f "$C/tasks.md.b"
rc=0; $V lint demo > "$T/pl.json" 2>&1 || rc=$?
expect "a group marked (risky) keeps its review" '! grep -q "\"kind\": \"review\"" "$T/pl.json"'

echo "== size tiers: Size in proposal.md, checked against the specs"
# reset_size <proposal head (Size/Risk lines)> <tasks.md body> [extra capability names...]
reset_size() { local head="$1" body="$2"; shift 2; reset_change "$body"
  printf '%s\n\n## Why\nDemo change for the verifier contract tests.\n\n## What Changes\n- Adds a demo capability.\n\n## Edge cases\n- none named\n' "$head" > "$C/proposal.md"
  for cap in "$@"; do mkdir -p "$C/specs/$cap"; printf '## ADDED Requirements\n\n### Requirement: %s\nThe system SHALL show %s.\n\n#### Scenario: shown\n- **WHEN** asked\n- **THEN** it shows\n' "$cap" "$cap" > "$C/specs/$cap/spec.md"; done; }
STASKS='## 1. G
- [ ] 1.1 a
- [ ] 1.R Request code review of the whole change'
reset_size 'Size: S
Risk: none' "$STASKS"
printf 'This change: demo - greets.\nFits: new, standalone.\n' > "$C/app-map.md"
printf '## Implementation guide\nOne function.\n\n## Pitfalls\nNone.\n' > "$C/design.md"
mkdir -p "$C/adrs"; printf -- '---\nstatus: none\n---\nNo significant decision.\n' > "$C/adrs/none.md"
rc=0; $V lint demo > "$T/sz.json" 2>&1 || rc=$?
expect "Size: S with S-light artifacts (two-line app map, short design, adrs/none.md) passes lint" '[ $rc = 0 ] && grep -q "\"declared\": \"S\"" "$T/sz.json" && ! grep -q "\"kind\": \"size" "$T/sz.json"'
rc=0; openspec validate demo --strict >/dev/null 2>&1 || rc=$?
expect "the S-light change still passes openspec validate --strict" '[ $rc = 0 ]'
rc=0; $V size demo > "$T/sz.json" 2>&1 || rc=$?
expect "size reports declared S = required S (exit 0)" '[ $rc = 0 ] && grep -q "\"required\": \"S\"" "$T/sz.json" && grep -q "\"task_cap\": 3" "$T/sz.json"'
reset_size 'Size: S
Risk: none' "$STASKS" extra
rc=0; $V size demo > "$T/sz.json" 2>&1 || rc=$?
qfault "Size: S with two capabilities: size fails and asks for Size: M and the full artifacts" '[ $rc = 1 ] && grep -q "\"kind\": \"size-under\"" "$T/sz.json" && grep -q "needs Size: M" "$T/sz.json" && grep -q "write the full artifacts" "$T/sz.json"'
rc=0; $V next demo > "$T/sz.json" 2>&1 || rc=$?
expect "next refuses an under-declared size (exit 2)" '[ $rc = 2 ] && grep -q "size-under" "$T/sz.json"'
reset_size 'Size: M
Risk: none' "$STASKS" extra more
rc=0; $V lint demo > "$T/sz.json" 2>&1 || rc=$?
expect "three capabilities need Size: L" '[ $rc = 1 ] && grep -q "needs Size: L" "$T/sz.json" && grep -q "3 capabilities" "$T/sz.json"'
reset_size 'Size: S
Risk: none' "$STASKS"
printf '## ADDED Requirements\n\n### Requirement: A\nThe system SHALL a.\n\n#### Scenario: a\n- **WHEN** a\n- **THEN** a\n\n### Requirement: B\nThe system SHALL b.\n\n#### Scenario: b\n- **WHEN** b\n- **THEN** b\n\n### Requirement: C\nThe system SHALL c.\n\n#### Scenario: c\n- **WHEN** c\n- **THEN** c\n\n### Requirement: D\nThe system SHALL d.\n\n#### Scenario: d\n- **WHEN** d\n- **THEN** d\n' > "$C/specs/demo/spec.md"
rc=0; $V size demo > "$T/sz.json" 2>&1 || rc=$?
expect "Size: S with 4 requirements needs Size: M" '[ $rc = 1 ] && grep -q "4 requirements" "$T/sz.json"'
reset_size 'Size: S
Risk: money' "$STASKS"
rc=0; $V size demo > "$T/sz.json" 2>&1 || rc=$?
qfault "Size: S with Risk: money: size fails, needs Size: L" '[ $rc = 1 ] && grep -q "needs Size: L" "$T/sz.json" && grep -q "money" "$T/sz.json"'
reset_size 'Size: S
Risk: none' "$STASKS"
sed -i.b 's/^- Adds a demo capability./- **BREAKING** renames the demo endpoint./' "$C/proposal.md"; rm -f "$C/proposal.md.b"
rc=0; $V size demo > "$T/sz.json" 2>&1 || rc=$?
expect "a BREAKING change needs Size: L" '[ $rc = 1 ] && grep -q "needs Size: L" "$T/sz.json" && grep -qi "breaking" "$T/sz.json"'
reset_size 'Size: S
Risk: none' "$STASKS"
mkdir -p "$C/adrs"; printf -- '---\nstatus: proposed\n---\n# Use a cache\n' > "$C/adrs/use-cache.md"
rc=0; $V size demo > "$T/sz.json" 2>&1 || rc=$?
expect "an ADR needs Size: M" '[ $rc = 1 ] && grep -q "needs Size: M" "$T/sz.json"'
reset_size 'Size: L
Risk: none' "$STASKS" extra
printf '## Decisions\nOne.\n\n## Implementation guide\nOne function.\n' > "$C/design.md"; printf '## Capability inventory\n- demo\n- extra\n' > "$C/app-map.md"; mkdir -p "$C/adrs"; printf -- '---\nstatus: none\n---\nNone.\n' > "$C/adrs/none.md"
rc=0; $V size demo > "$T/sz.json" 2>&1 || rc=$?
expect "declaring a bigger size than needed is allowed" '[ $rc = 0 ] && grep -q "\"required\": \"M\"" "$T/sz.json"'
reset_size 'Size: S
Risk: none' "$STASKS"
sed -i.b 's/^Demo change for the verifier contract tests./Customers enter a discount code at checkout./' "$C/proposal.md"; rm -f "$C/proposal.md.b"
rc=0; $V lint demo > "$T/sz.json" 2>&1 || rc=$?
expect "Risk: none while the proposal talks about discounts only warns (exit 0)" '[ $rc = 0 ] && grep -q "\"kind\": \"risk\"" "$T/sz.json" && grep -q "mentions discount" "$T/sz.json"'
reset_size 'Size: S' "$STASKS"
printf '## Implementation guide\nOne function.\n\n## Pitfalls\nNone.\n' > "$C/design.md"; printf 'This change: demo - greets.\nFits: new.\n' > "$C/app-map.md"; mkdir -p "$C/adrs"; printf -- '---\nstatus: none\n---\nNone.\n' > "$C/adrs/none.md"
rc=0; $V lint demo > "$T/sz.json" 2>&1 || rc=$?
expect "a missing Risk: line warns" '[ $rc = 0 ] && grep -q "no \\\\\"Risk:\\\\\" line" "$T/sz.json"'
reset_size '' "$STASKS"
rc=0; $V lint demo > "$T/sz.json" 2>&1 || rc=$?
expect "a proposal without a Size line warns and names the size the specs need" '[ $rc = 0 ] && grep -q "\"kind\": \"size\"" "$T/sz.json" && grep -q "this change is Size: S" "$T/sz.json"'
reset_size 'Size: M
Risk: none' "$STASKS" extra
printf '## Implementation guide\nOne function.\n\n## Pitfalls\nNone.\n' > "$C/design.md"
printf 'This change: demo.\nFits: new.\n' > "$C/app-map.md"
rc=0; $V lint demo > "$T/sz.json" 2>&1 || rc=$?
qfault "Size: M with the S-light design and app map: lint fails (write the full artifacts)" '[ $rc = 1 ] && grep -q "\"kind\": \"size-artifacts\"" "$T/sz.json" && grep -q "Decisions" "$T/sz.json" && grep -q "Capability inventory" "$T/sz.json"'
printf '## Decisions\nOne.\n\n## Implementation guide\nOne function.\n' > "$C/design.md"; printf '## Capability inventory\n- demo\n- extra\n' > "$C/app-map.md"; mkdir -p "$C/adrs"; printf -- '---\nstatus: none\n---\nNone.\n' > "$C/adrs/none.md"
rc=0; $V lint demo > "$T/sz.json" 2>&1 || rc=$?
expect "the full design and app map satisfy Size: M" '[ $rc = 0 ] && ! grep -q "size-artifacts" "$T/sz.json"'
reset_size 'Size: S
Risk: none' 'Size: M

## 1. G
- [ ] 1.1 a
- [ ] 1.R Request code review of the whole change'
rc=0; $V lint demo > "$T/sz.json" 2>&1 || rc=$?
qfault "tasks.md Size: M disagrees with proposal.md Size: S: size-drift error" '[ $rc = 1 ] && grep -q "\"kind\": \"size-drift\"" "$T/sz.json"'
reset_size 'Size: S
Risk: none' '## 1. G
- [ ] 1.1 a
- [ ] 1.2 b
- [ ] 1.3 c
- [ ] 1.4 d
- [ ] 1.R Request code review of the whole change'
rc=0; $V lint demo > "$T/sz.json" 2>&1 || rc=$?
expect "the cap comes from proposal.md when tasks.md has no Size line (S allows 3, plan has 4)" '[ $rc = 1 ] && grep -q "\"kind\": \"size-cap\"" "$T/sz.json"'

echo "== invariant scenarios"
reset_size 'Size: S
Risk: none' "$STASKS"
printf '## ADDED Requirements\n\n### Requirement: Order total\nThe system SHALL calculate the order total from the lines.\n\n#### Scenario: two lines\n- **WHEN** lines cost 2 and 3\n- **THEN** the total is 5\n\n### Requirement: Greeting\nThe system SHALL show a greeting.\n\n#### Scenario: greet\n- **WHEN** opened\n- **THEN** it greets\n' > "$C/specs/demo/spec.md"
rc=0; $V lint demo > "$T/iv.json" 2>&1 || rc=$?
expect "a data-transforming requirement without an invariant scenario warns (exit 0); a display one does not" '[ $rc = 0 ] && grep -q "\"kind\": \"invariant\"" "$T/iv.json" && grep -q "Order total" "$T/iv.json" && ! grep -q "requirement \\\\\"Greeting" "$T/iv.json"'
printf '## ADDED Requirements\n\n### Requirement: Discount line\nThe summary SHALL show `Discount (<CODE>): -<amount>` before "Total: 5" for discounted invoices and the `total-row` badge; unknown codes give `DISCOUNT_UNKNOWN` via `discountCode` from localStorage.\n\n#### Scenario: line\n- **WHEN** shown\n- **THEN** it reads\n\n### Requirement: Search\nThe grid SHALL filter products by the search text.\n\n#### Scenario: search\n- **WHEN** typed\n- **THEN** filtered\n' > "$C/specs/demo/spec2.tmp"
cp "$C/specs/demo/spec.md" "$T/spec.keep"; mv "$C/specs/demo/spec2.tmp" "$C/specs/demo/spec.md"
rc=0; $V lint demo > "$T/iv2.json" 2>&1 || rc=$?
expect "invariant lint matches whole prose words only: code spans, identifiers, quoted UI text and display-only requirements are not flagged; a filtering one is" '[ $rc = 0 ] && ! grep -q "requirement \\\\\"Discount line" "$T/iv2.json" && grep -q "requirement \\\\\"Search\\\\\" says \\\\\"filter\\\\\"" "$T/iv2.json"'
cp "$T/spec.keep" "$C/specs/demo/spec.md"
sed -i.b 's/^### Requirement: Greeting/#### Scenario: Invariant: the lines are unchanged and share no objects with the result\n- **WHEN** the total is computed and a line of the result is edited\n- **THEN** the input lines are unchanged\n\n### Requirement: Greeting/' "$C/specs/demo/spec.md"; rm -f "$C/specs/demo/spec.md.b"
rc=0; $V lint demo > "$T/iv.json" 2>&1 || rc=$?
expect "an \"Invariant: ...\" scenario satisfies it" '[ $rc = 0 ] && ! grep -q "\"kind\": \"invariant\"" "$T/iv.json"'
rc=0; openspec validate demo --strict >/dev/null 2>&1 || rc=$?
expect "a spec with an Invariant: scenario passes openspec validate --strict" '[ $rc = 0 ]'

echo "== edge cases named by the user, Purpose"
reset_size 'Size: S
Risk: none' "$STASKS"
printf '## ADDED Requirements\n\n### Requirement: Greeting\nThe system SHALL greet.\n\n#### Scenario: greet\n- **WHEN** asked\n- **THEN** it greets\n\n#### Scenario: very long name\n- **WHEN** the name has 80 characters\n- **THEN** it greets with the whole name\n' > "$C/specs/demo/spec.md"
sed -i.b '/^## Edge cases$/,$d' "$C/proposal.md"; rm -f "$C/proposal.md.b"
rc=0; $V lint demo > "$T/ec.json" 2>&1 || rc=$?
qfault "a proposal without an Edge cases section fails lint" '[ $rc = 1 ] && grep -q "has no \\\\\"## Edge cases\\\\\" section" "$T/ec.json"'
printf '## Edge cases\n- A very long name (80 characters)\n' >> "$C/proposal.md"
rc=0; $V lint demo > "$T/ec.json" 2>&1 || rc=$?
qfault "an edge case without its scenario fails lint (Size never removes one)" '[ $rc = 1 ] && grep -q "names no scenario" "$T/ec.json"'
sed -i.b 's/^- A very long name (80 characters)$/- A very long name (80 characters) -> demo\/long-name/' "$C/proposal.md"; rm -f "$C/proposal.md.b"
rc=0; $V lint demo > "$T/ec.json" 2>&1 || rc=$?
qfault "an edge case pointing at an unknown scenario fails lint" '[ $rc = 1 ] && grep -q "demo/long-name, which is not a scenario of this change" "$T/ec.json"'
sed -i.b 's/-> demo\/long-name/-> demo\/very-long-name/' "$C/proposal.md"; rm -f "$C/proposal.md.b"
rc=0; $V lint demo > "$T/ec.json" 2>&1 || rc=$?
expect "every edge case mapped to a scenario passes, and lint lists them" '[ $rc = 0 ] && grep -q "\"scenarios\": \[" "$T/ec.json" && grep -q "demo/very-long-name" "$T/ec.json"'
printf -- '- none named\n' > "$T/none"; sed -i.b '/^## Edge cases$/,$d' "$C/proposal.md"; rm -f "$C/proposal.md.b"; printf '## Edge cases\n- none named\n' >> "$C/proposal.md"
printf '## Implementation guide\nTruncate a long name with an ellipsis; show an error when empty.\n\n## Pitfalls\nNone.\n' > "$C/design.md"
rc=0; $V lint demo > "$T/ec.json" 2>&1 || rc=$?
expect "the plan mentions edge words neither the Edge cases list nor a scenario does: a warning (exit 0)" '[ $rc = 0 ] && grep -q "the plan mentions .*truncate.*error.*empty" "$T/ec.json"'
expect "... a word a scenario already covers (very long name) is not reported" '! grep -q "the plan mentions [^.]*\\\\\"long\\\\\"" "$T/ec.json"'
# Regression fixtures from real runs (T03, T07, T08): heuristic noise must stay quiet, real catches must still fire.
edge_fixture() { # edge_fixture <name> <proposal extra> <design.md> <spec scenarios> [edge list]; prints the warning or "none"
  local d="$T/edge-$1"; rm -rf "$d"; mkdir -p "$d/specs/app"
  printf '## Why\nApp change.\n\n## What Changes\n- A change.\n%s\n\n## Edge cases\n%s\n' "$2" "${5:-- none named}" > "$d/proposal.md"
  printf '%s\n' "$3" > "$d/design.md"
  printf '## ADDED Requirements\n\n### Requirement: App\nThe system SHALL work.\n\n%s\n' "$4" > "$d/specs/app/spec.md"
  node -e 'const Q=require(process.argv[1]); const r=Q.edgeLint(process.argv[2]); const w=r.problems.filter(p=>p.severity!=="error"); console.log(w.length?w.map(p=>p.text).join("\n"):"none"); for (const p of r.problems.filter(p=>p.severity==="error")) console.log("ERROR "+p.text)' "$PWD/openspec/scripts/quality.cjs" "$d"
}
SC='#### Scenario: Search
- **WHEN** the query is typed
- **THEN** the grid filters'
r="$(edge_fixture t07css '' '## Context
Vue 3 SFCs with scoped CSS; `main` is max 1200px with 16px padding.

## Implementation guide
- The container is max 1200px wide, the grid uses min(3, n) columns and minmax(0, 1fr); max-width: 1200px.' "$SC")"
expect "edge noise T07: CSS values (max 1200px, min(3, n), minmax) are not edge cases" '[ "$r" = none ]'
r="$(edge_fixture t07empty '- A result count and an empty state with "Clear search".' '## Goals / Non-Goals
**Goals:** responsive grid; live search with count and empty state.' "$SC
#### Scenario: Empty query shows everything
- **WHEN** the query is empty
- **THEN** every result is listed")"
expect "edge noise T07: a word the scenarios already cover (the query is empty) is not reported" '[ "$r" = none ]'
r="$(edge_fixture t08deferred '' '## Goals / Non-Goals
**Goals:** a settings drawer.
**Non-Goals:** checkout, stock limits, cross-tab sync, animations.

## Deferred
- maximum quantity per line, duplicate lines

## Implementation guide
- Out of scope: offline carts.' "$SC")"
expect "edge noise T08: Non-Goals, Deferred and Out of scope text (stock limits) is not reported" '[ "$r" = none ]'
r="$(edge_fixture t03 '' '## Context
`src/invoice.ts` throws `InvoiceError(code, message)`; `formatCents` prints negative amounts with a minus sign.

## Implementation guide
2. Look up the table; missing -> `DISCOUNT_UNKNOWN`.

## Risks / Trade-offs
- [Money: wrong rounding] -> explicit boundary scenarios (805, 804).' "#### Scenario: Unknown code is rejected
- **WHEN** the code is NOPE
- **THEN** it fails with error code \`DISCOUNT_UNKNOWN\`")"
expect "edge noise T03: current state (Context), risks, and a case whose error code a scenario asserts are not reported" '[ "$r" = none ]'
r="$(edge_fixture catch '- Many results in a long list.' '## Goals / Non-Goals
**Goals:** handle an empty list.

## Implementation guide
- Long result names wrap; show an error when offline. Longitude and errorless are not edge words.' "$SC")"
qfault "edge lint still catches real cases: goals and implementation text (many, long, empty, wrap, error, offline)" 'printf "%s" "$r" | grep -q "\"many\"" && printf "%s" "$r" | grep -q "\"long\"" && printf "%s" "$r" | grep -q "\"empty\"" && printf "%s" "$r" | grep -q "\"wrap" && printf "%s" "$r" | grep -q "\"error\"" && printf "%s" "$r" | grep -q "\"offline\"" && ! printf "%s" "$r" | grep -qi "longitude\|errorless"'
r="$(edge_fixture whole '' '## Implementation guide
- Show the boundaries clearly; longer names wrap.' "$SC" '- Column boundary at 600px -> app/search
- A longest name wraps onto two lines -> app/search')"
expect "edge words compare as whole words of one family (boundaries ~ boundary, longer ~ longest, wrap ~ wraps)" '[ "$r" = none ]'
r="$(edge_fixture uitok '' '' "$SC" '- The badge with 1 item is not truncated at 375 -> app/search' >/dev/null; node -e 'const Q=require(process.argv[1]); const vis=new Map([["app/search",{states:[{name:"default",steps:[],keys:[]},{name:process.argv[3],steps:[{op:"storage",target:"items",value:"[{\"id\":7}]"}],keys:["[data-testid=\"badge\"]"]}]}]]); console.log(Q.edgeLint(process.argv[2],{visual:vis}).problems.filter(p=>p.severity==="error").length)' "$PWD/openspec/scripts/quality.cjs" "$T/edge-uitok" one-item)"
expect "a UI edge case \"1 item\" matches state one-item (numbers and 3-letter words count as tokens)" '[ "$r" = 0 ]'
r="$(node -e 'const Q=require(process.argv[1]); const vis=new Map([["app/search",{states:[{name:"default",steps:[],keys:[]},{name:"many-items",steps:[{op:"storage",target:"items",value:"x"}],keys:[]}]}]]); console.log(Q.edgeLint(process.argv[2],{visual:vis}).problems.filter(p=>p.severity==="error").length)' "$PWD/openspec/scripts/quality.cjs" "$T/edge-uitok")"
qfault "... but not a state that shows another case (many-items)" '[ "$r" = 1 ]'
rm -f "$C/design.md"
printf '## Purpose\nGreets.\n\n' | cat - "$C/specs/demo/spec.md" > "$T/sp" && mv "$T/sp" "$C/specs/demo/spec.md"
rc=0; $V lint demo > "$T/ec.json" 2>&1 || rc=$?
qfault "a new capability with a Purpose under 50 characters fails lint (validate --strict would fail after sync)" '[ $rc = 1 ] && grep -q "\"kind\": \"purpose\"" "$T/ec.json" && grep -q "needs 50+" "$T/ec.json"'
sed -i.b 's/^Greets\.$/The demo capability greets the person who opens the app by name./' "$C/specs/demo/spec.md"; rm -f "$C/specs/demo/spec.md.b"
rc=0; $V lint demo > "$T/ec.json" 2>&1 || rc=$?
expect "a full Purpose passes" '[ $rc = 0 ] && ! grep -q "\"kind\": \"purpose\"" "$T/ec.json"'

echo "== UX checklist (warning only; UI-facing changes only)"
UXALL='- loading: Not applicable: the list is static data
- empty: scenario demo/greet
- error: Not applicable: nothing is loaded or saved
- disabled: scenario demo/greet
- validation: Not applicable: the page has no input
- recovery: Not applicable: no error can occur
- keyboard: scenario demo/greet
- narrow: scenario demo/greet
- long-text: scenario demo/greet'
ux_change() { # ux_change <Files: value> [checklist lines]
  reset_change "- [ ] 1.1 a
  - Files: $1
  - Done when: \`true\`"
  if [ -n "${2:-}" ]; then printf '\n## UX checklist\n%s\n' "$2" >> "$C/proposal.md"; fi
  rc=0; $V lint demo > "$T/ux.json" 2>&1 || rc=$?
}
ux_kinds() { grep -c '"kind": "ux-checklist"' "$T/ux.json" || true; }
ux_change 'src/util.mjs, test/util.test.mjs'
expect "a change with no UI (script files only) is not asked for a checklist" '[ $rc = 0 ] && [ "$(ux_kinds)" = 0 ]'
ux_change 'src/Card.test.tsx, test/card.test.ts'
expect "test files named Files: do not make a change UI-facing" '[ "$(ux_kinds)" = 0 ]'
ux_change 'src/util.mjs' "$UXALL"
expect "a non-UI change that carries a checklist is not checked either" '[ "$(ux_kinds)" = 0 ]'
ux_change 'src/List.vue, test/list.test.ts'
expect "UI files in Files: without the section: one warning, lint still exits 0" '[ $rc = 0 ] && [ "$(ux_kinds)" = 1 ] && grep -q "has no \\\\\"## UX checklist\\\\\" section" "$T/ux.json" && grep -q "UI files src/List.vue" "$T/ux.json" && grep -q "\"severity\": \"warning\"" "$T/ux.json"'
ux_change 'src/List.vue' "$UXALL"
expect "a full checklist (scenarios and reasoned Not applicable) passes without a finding, and its item names (error, long-text, empty) are not read as edge words of the plan" '[ $rc = 0 ] && [ "$(ux_kinds)" = 0 ] && ! grep -q "the plan mentions" "$T/ux.json"'
ux_change 'src/List.vue' "$(printf '%s\n' "$UXALL" | grep -v '^- keyboard\|^- narrow')"
expect "a missing item is named (keyboard, narrow) in one warning" '[ $rc = 0 ] && [ "$(ux_kinds)" = 1 ] && grep -q "has no answer for keyboard, narrow" "$T/ux.json"'
ux_change 'src/List.vue' "$(printf '%s\n' "$UXALL" | sed 's/^- empty: scenario demo\/greet/- empty: scenario demo\/nope/')"
expect "a checklist line naming a scenario the change lacks is flagged with the id" '[ "$(ux_kinds)" = 1 ] && grep -q "names demo/nope, which is not a scenario of this change" "$T/ux.json"'
ux_change 'src/List.vue' "$(printf '%s\n' "$UXALL" | sed 's/^- loading: .*/- loading: Not applicable: n\/a/')"
expect "Not applicable without a real reason (under 3 words) is flagged" '[ "$(ux_kinds)" = 1 ] && grep -q "needs the reason this screen has none" "$T/ux.json"'
ux_change 'src/List.vue' "$(printf '%s\n' "$UXALL" | sed 's/^- disabled: .*/- disabled: later/')"
expect "an answer that is neither scenario nor Not applicable is flagged" '[ "$(ux_kinds)" = 1 ] && grep -q "write .scenario <capability>/<slug>. or .Not applicable: <reason>." "$T/ux.json"'
reset_change '- [ ] 1.1 a
  - Done when: `true`'
printf '\n```visual\nroute: /\nkey: [data-testid="x"]\n```\n' >> "$C/specs/demo/spec.md"
rc=0; $V lint demo > "$T/ux.json" 2>&1 || true
expect "a visual scenario in the specs makes the change UI-facing (names the scenario)" '[ "$(ux_kinds)" = 1 ] && grep -q "visual scenarios demo/greet" "$T/ux.json"'
expect "the proposal template and the schema ask for the section; the partial is wired into explore, propose and green-start, and the reviewer checks it" '[ "$(grep -c "UX checklist" "$PKG/schemas/wingman-spec/templates/proposal.md")" -ge 1 ] && grep -q "UX checklist" "$PKG/schemas/wingman-spec/schema.yaml" && for c in spec-explore spec-propose spec-green-start; do grep -q "{{> ux-completeness}}" "$PKG/project-template/harness/commands/$c.md" || exit 1; done && grep -q "UX checklist" "$PKG/project-template/harness/agents/spec-reviewer.md"'

reset_change '- [ ] 1.1 a
  - Done when: `echo tc && true`'
export SPEC_TYPECHECK_CMD="echo tc" SPEC_LINT_CMD="false"
orch "$TICK1" "done"
qfault "lint command fails: the task is rejected" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "lint failed (exit 1): false"'
expect "a command the Done when already ran is not run again" 'printf "%s" "$out" | grep -A2 "\"check\": \"typecheck\"" | grep -q "already run by Done when"'
export SPEC_LINT_CMD="true"; orch "$TICK1" "done"
expect "typecheck and lint commands run in check and pass" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "\"check\": \"lint\""'
export SPEC_TYPECHECK_CMD="false"; reset_change '- [ ] 1.1 a'
orch "$TICK1" "done"
qfault "typecheck fails: the task is rejected" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "typecheck failed"'
unset SPEC_TYPECHECK_CMD SPEC_LINT_CMD

TSPEC='## ADDED Requirements

### Requirement: Demo
The system SHALL greet.

#### Scenario: greet
- **WHEN** asked
- **THEN** it greets

#### Scenario: Wave back
- **WHEN** waved at
- **THEN** it waves'
reset_trace() { reset_change "$1"; printf '%s\n' "$TSPEC" > "$C/specs/demo/spec.md"; rm -rf test; git add -A >/dev/null; git commit -qm "trace fixture" >/dev/null 2>&1 || true; }
reset_trace '- [ ] 1.1 greet
  - Spec: demo > Demo (greet)
  - Done when: `true`'
$V next demo --format prompt > "$T/tp.txt" 2>/dev/null
expect "the task prompt asks for the scenario tag" 'grep -q "\[demo/greet\]" "$T/tp.txt" && grep -q "never source text" "$T/tp.txt"'
F="$C/tasks.md" bash -c "mkdir -p test; echo \"test('greets', () => {})\" > test/demo.test.js; $TICK1"
out="$($V check demo 2>&1)"; rc=$?
qfault "scenario named in Spec: has no tagged test: rejected" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "no test is tagged for 1 scenario" && printf "%s" "$out" | grep -q "\[demo/greet\]"'
orch "echo \"test('[demo/greet] greets', () => {})\" > test/demo.test.js; $TICK1" "done"
expect "a test titled [demo/greet] satisfies the trace check" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "\"check\": \"trace\""'
reset_trace '- [ ] 1.1 greet
  - Spec: demo > Demo (scenarios: greet)
  - Done when: `true`'
$V next demo > /dev/null 2>&1
F="$C/tasks.md" bash -c "mkdir -p test; echo \"test('greets', () => {})\" > test/demo.test.js; $TICK1"
out="$($V check demo 2>&1)"; rc=$?
expect "the '(scenarios: A, B)' Spec form names its scenarios (untagged: rejected)" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "no test is tagged for 1 scenario"'
reset_trace '- [ ] 1.1 greet
  - Spec: demo > Demo
  - Done when: `true`'
orch "mkdir -p test; echo \"test('greets', () => {})\" > test/demo.test.js; $TICK1" "done"
expect "a requirement-level Spec: only warns about untested scenarios" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "finish fails if they stay untested"'

reset_trace '- [ ] 1.1 greet
  - Done when: `true`'
orch "mkdir -p test src; echo \"import css from '../src/App.vue?raw'; test('[demo/greet] grid', () => expect(css).toMatch(/grid/))\" > test/layout.test.js; $TICK1" "done"
qfault "test imports a .vue file ?raw: rejected" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "reads source code as text"'
orch "mkdir -p test; printf '%s\n' \"const fs = require('fs');\" \"test('[demo/greet] css', () => { const s = fs.readFileSync('src/style.css', 'utf8'); })\" > test/layout.test.js; $TICK1" "done"
qfault "test reads src/style.css with readFileSync: rejected" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "reads src/style.css as text"'
orch "printf '%s\n' '// source-text-ok: the generated CSS file is the product of this module' \"const fs = require('fs');\" \"test('[demo/greet] css', () => { const s = fs.readFileSync('src/style.css', 'utf8'); })\" > test/layout.test.js; $TICK1" "done"
expect "the documented source-text-ok opt-out is allowed (and reported)" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "allowed source-text test"'
# the detector follows a path through a variable or path.join, and does not flag data fixtures (.json is not .js)
mkdir -p "$T/st"
printf '%s\n' "import { readFileSync } from 'node:fs';" "const file = 'src/lib/discount.ts';" "test('[demo/greet] x', () => {" "  const t = readFileSync(file, 'utf8');" "});" > "$T/st/a.test.ts"
printf '%s\n' "import { readFileSync } from 'node:fs';" "test('[demo/greet] x', () => {" "  const d = JSON.parse(readFileSync('./fixtures/data.json', 'utf8'));" "});" > "$T/st/b.test.ts"
printf '%s\n' "import fs from 'node:fs/promises'; import path from 'node:path';" "test('[demo/greet] x', async () => {" "  const t = await fs.readFile(path.join(__dirname, '..', 'src', 'components', 'List.vue'), 'utf8');" "});" > "$T/st/c.test.ts"
st() { node -e 'const Q=require(process.cwd()+"/openspec/scripts/quality.cjs");const r=Q.sourceTextFindings(process.argv[1],"t");console.log(JSON.stringify(r.findings))' "$1"; }
qfault "test reads a source path held in a variable (const file = 'src/...'; readFileSync(file)): flagged" 'st "$T/st/a.test.ts" | grep -q "reads src/lib/discount.ts"'
expect "reading a JSON fixture is not a source read (.json is not .js)" '[ "$(st "$T/st/b.test.ts")" = "[]" ]'
qfault "fs/promises readFile of path.join(..., \"src\", ..., \"List.vue\"): flagged with the file name" 'st "$T/st/c.test.ts" | grep -q "reads List.vue"'

reset_trace '- [ ] 1.1 greet
  - Done when: `true`'
rc=0; $V finish demo > "$T/f.json" 2>&1 || rc=$?
expect "finish refuses while tasks are open (exit 2)" '[ $rc = 2 ] && grep -q "tasks-open" "$T/f.json"'
orch "$TICK1" "done"; git add -A >/dev/null; git commit -qm "task 1.1" >/dev/null
rc=0; $V finish demo --max-attempts 2 > "$T/f.json" 2>&1 || rc=$?
fp="$(sed -n -E 's/^ *"fix_prompt": "(.*)",?$/\1/p' "$T/f.json")"
qfault "finish: untested scenarios fail the change and write a fix prompt for one implementer" '[ $rc = 1 ] && grep -q "2 of 2 scenarios have no tagged test" "$T/f.json" && [ -f "$fp" ] && grep -q "\[demo/wave-back\]" "$fp" && grep -q "STATUS: done" "$fp"'
rc=0; $V finish demo --max-attempts 2 > "$T/f.json" 2>&1 || rc=$?
expect "finish stops after its attempt limit (exit 4)" '[ $rc = 4 ]'
rm -f openspec/.apply-runs/demo/finish.json
mkdir -p test; printf '%s\n' "test('[demo/greet] greets', () => {})" "test('[demo/wave-back] waves', () => {})" > test/demo.test.js
rc=0; $V finish demo > "$T/f.json" 2>&1 || rc=$?
expect "finish passes when every scenario has a tagged test (no agent close-out tasks)" '[ $rc = 0 ] && grep -q "\"result\": \"finished\"" "$T/f.json" && grep -q "\"event\":\"finish\",\"ok\":true" openspec/.apply-runs/demo/*/metrics.jsonl'
git add -A >/dev/null; git commit -qm "tests" >/dev/null
printf '%s\n' "import src from '../src/App.vue?raw';" "test('[demo/greet] markup', () => {})" > test/markup.test.js; git add -A >/dev/null; git commit -qm "raw test" >/dev/null
rc=0; $V finish demo > "$T/f.json" 2>&1 || rc=$?
qfault "finish: a source-text test committed during the change fails it" '[ $rc = 1 ] && grep -q "tests read source files as text" "$T/f.json"'
rm -f test/markup.test.js openspec/.apply-runs/demo/finish.json; export SPEC_TYPECHECK_CMD="false"
rc=0; $V finish demo > "$T/f.json" 2>&1 || rc=$?
qfault "finish: a failing typecheck fails the change" '[ $rc = 1 ] && grep -q "typecheck failed" "$T/f.json"'
unset SPEC_TYPECHECK_CMD; rm -rf test; git add -A >/dev/null; git commit -qm "cleanup" >/dev/null 2>&1 || true
echo "  quality faults caught: $QC/21"; [ "$QC" = 21 ] || bad "expected 21 quality faults caught"

echo "== visual loop (Playwright)"
PWM="${PLAYWRIGHT_NODE_MODULES:-}"
if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && [ -d "$(dirname "$PWM")/ms-playwright" ]; then PLAYWRIGHT_BROWSERS_PATH="$(dirname "$PWM")/ms-playwright"; export PLAYWRIGHT_BROWSERS_PATH; fi
VCAUGHT=0; VTOTAL=0
if [ -d "$PWM/playwright" ] && [ -d "$PWM/axe-core" ] && command -v python3 >/dev/null; then
  ln -s "$PWM" node_modules; printf 'node_modules\n' >> .gitignore; git add -A; git commit -qm nm
  reset_visual "$VT"; git add -A; git commit -qm "clean page" >/dev/null
  orch "$TICK1" "done"
  expect "clean UI task: deterministic checks pass, review pending (exit 5)" '[ $rc = 5 ] && printf "%s" "$out" | grep -q "review-pending"'
  rp="$(printf "%s" "$out" | sed -n -E 's/^ *"review_prompt": "(.*)",?$/\1/p')"
  rd="$(dirname "$rp")"; bd="$(dirname "$rd")/1.1/before"
  expect "next captured the pre-task state: ARIA snapshots and 6 area clips (2 states x 3 viewports)" '[ -f "$bd/report.json" ] && grep -q "textbox" "$bd/report.json" && [ "$(find "$bd/areas" -name "*.png" | wc -l)" = 6 ]'
  expect "review prompt lists 6 before -> after pairs of area clips, no full-page screenshots" '[ "$(grep -c " before .*\.png -> after .*\.png" "$rp")" = 6 ] && [ "$(find "$rd/areas" -name "*.png" | wc -l)" = 6 ] && ! find openspec/.apply-runs -path "*screens*" | grep -q .'
  expect "area clips are cropped to the key elements (shorter than the 900px viewport)" 'node -e "const fs=require(\"fs\");for(const f of process.argv.slice(1)){const b=fs.readFileSync(f);if(b.readUInt32BE(20)>=900)process.exit(1)}" $(find "$rd/areas" -name "*.png")'
  expect "nothing visual is written to the repository (run dir is git-ignored)" '[ -z "$(git status --porcelain --untracked-files=all | grep -v "openspec/changes/" )" ] && [ ! -e openspec/visual-baselines ]'
  rc=0; $V next demo >/dev/null 2>&1 || rc=$?
  expect "next refuses while the review is pending (exit 2)" '[ $rc = 2 ]'
  echo "looks fine" > "$T/rev.txt"; rc=0; $V review demo --reply "$T/rev.txt" >/dev/null 2>&1 || rc=$?
  expect "a reply without STATUS is not recorded (exit 2)" '[ $rc = 2 ] && grep -q "^- \[x\] 1.1" "$C/tasks.md"'
  echo "STATUS: fail" > "$T/rev.txt"; rc=0; $V review demo --reply "$T/rev.txt" >/dev/null 2>&1 || rc=$?
  expect "STATUS: fail without a DEFECT line is not recorded (exit 2)" '[ $rc = 2 ]'
  echo "STATUS: error cannot open images" > "$T/rev.txt"; rc=0; $V review demo --reply "$T/rev.txt" > "$T/rev.out" 2>&1 || rc=$?
  expect "STATUS: error points to asking again or --reviewer none, never a self-review (exit 2)" '[ $rc = 2 ] && grep -q "reviewer none" "$T/rev.out"'
  printf 'DEFECT: app/search-page [default @ 375px]: the menu button touches the right edge -> 12px margin\nSTATUS: fail\n' > "$T/rev.txt"
  rc=0; $V review demo --reply "$T/rev.txt" > "$T/rev.out" 2>&1 || rc=$?
  fault "reviewer defects reject the task like a failing test (tick reverted)" '[ $rc = 1 ] && grep -q "^- \[ \] 1.1" "$C/tasks.md" && grep -q "touches the right edge" "$T/rev.out"'
  $V next demo --format prompt > "$T/retry.txt" 2>/dev/null
  expect "retry prompt carries the reviewer defect and the visual self-check" 'grep -q "touches the right edge" "$T/retry.txt" && grep -q "verify-task.cjs visual demo" "$T/retry.txt" && grep -q "attempt 2 of 3" "$T/retry.txt"'
  out="$($V visual demo 2>/dev/null)"; rc=$?
  expect "self-check (visual) reuses the before capture and lists before/after area images" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "pre-task tree" && printf "%s" "$out" | grep -q "\"before\": \"/"'
  F="$C/tasks.md" bash -c "$TICK1"; out="$($V check demo 2>/dev/null)"; rc=$?
  echo "STATUS: pass" > "$T/rev.txt"; rc2=0; $V review demo --reply "$T/rev.txt" --reviewer self > "$T/rev.out" 2>&1 || rc2=$?
  expect "--reviewer self is refused: the implementer never reviews its own screenshots (exit 2)" '[ $rc = 5 ] && [ $rc2 = 2 ] && grep -q "independent spec-visual-reviewer" "$T/rev.out"'
  rc2=0; $V review demo --reviewer none > "$T/rev.out" 2>&1 || rc2=$?
  expect "--reviewer none (no subagent available) records the review as skipped and passes the task (exit 0)" '[ $rc2 = 0 ] && grep -q "\"reviewer\":\"none\",\"skipped\":true" openspec/.apply-runs/demo/*/metrics.jsonl'
  sed -i.b 's/^  ready_timeout: 20$/  ready_timeout: 20\n  screenshots: off/' openspec/config.yaml && rm -f openspec/config.yaml.b
  reset_visual "$VT"; orch "$TICK1" "done"
  expect "visual.screenshots: off: DOM and ARIA checks only, no images, no review (exit 0)" '[ $rc = 0 ] && ! find openspec/.apply-runs -name "*.png" | grep -q .'
  git checkout -q openspec/config.yaml
  sed -i.b '/^  review: subagent$/d' openspec/config.yaml && rm -f openspec/config.yaml.b
  reset_visual "$VT"; orch "$TICK1" "done"
  expect "default (no visual.review line = off): deterministic checks only, no review step, no images (exit 0)" '[ $rc = 0 ] && ! find openspec/.apply-runs -name "*.png" | grep -q .'
  git checkout -q openspec/config.yaml
  if [ -d "$(dirname "$(readlink -f "$PWM")")/ms-playwright" ]; then
    rc=0; env -u PLAYWRIGHT_BROWSERS_PATH HOME="$T/nohome" XDG_CACHE_HOME="$T/nohome" node openspec/scripts/verify-task.cjs doctor > "$T/doc2.json" 2>&1 || rc=$?
    expect "doctor finds Chromium next to the Playwright install without PLAYWRIGHT_BROWSERS_PATH" 'grep -q "\"chromium\": \"ok\"" "$T/doc2.json" && grep -q "Chromium found in" "$T/doc2.json"'
    rc=0; env -u PLAYWRIGHT_BROWSERS_PATH HOME="$T/nohome" XDG_CACHE_HOME="$T/nohome" node openspec/scripts/verify-task.cjs visual demo > "$T/vis2.json" 2>&1 || rc=$?
    expect "visual check launches that Chromium itself (not skipped)" '! grep -q "VISUAL CHECK SKIPPED" "$T/vis2.json" && grep -q "\"ran\": true\|\"defects\"" "$T/vis2.json"'
  fi

  # injected careless-UI faults (made by the stub implementer, after next): each must be caught before review
  vfault() { # vfault <name> <expected defect code> <page edit (sed on site/index.html)> [spec override]
    VTOTAL=$((VTOTAL+1)); reset_visual "$VT" "${4:-$VSPEC}"
    orch "sed -i.b '$3' site/index.html; rm -f site/index.html.b; $TICK1" "done"
    if [ $rc = 1 ] && printf "%s" "$out" | grep -q "\[$2\]" && grep -q "^- \[ \] 1.1" "$C/tasks.md"; then VCAUGHT=$((VCAUGHT+1)); ok "visual fault caught: $1 ($2)"; else bad "visual fault missed: $1 ($2) rc=$rc"; printf "%s\n" "$out" | head -20; fi
  }
  vfault "fixed-width input"          layout:horizontal-overflow 's/input{width:100%;box-sizing:border-box}/input{width:900px}/'
  vfault "key element hidden"         layout:key-hidden          's/<p data-testid="count">/<p data-testid="count" style="display:none">/'
  vfault "key element missing"        layout:key-missing         's/data-testid="menu"/data-testid="panel"/'
  vfault "drawer pushed off-screen"   layout:key-offscreen       's/<button data-testid="menu" style="/<button data-testid="menu" style="position:fixed;right:-60px;width:120px;/'
  vfault "badge over the brand"       layout:overlap             's/<button data-testid="menu" style="/<button data-testid="menu" style="position:absolute;left:4px;top:40px;/'
  vfault "unlabelled search box"      a11y:label                 's/<label for="q">Search results<\/label>//'
  vfault "name hides the visible label" a11y:label-content-name-mismatch 's/<button data-testid="menu" style="/<button data-testid="menu" aria-label="Open panel" style="/'
  vfault "low-contrast button"        a11y:color-contrast        's/style="background:#fff;color:#000"/style="background:#fff;color:#ddd"/'
  vfault "console error"              runtime:console-error      's/<\/body>/<script>console.error("menu failed")<\/script><\/body>/'
  vfault "uncaught exception"         runtime:page-error         's/<\/body>/<script>JSON.parse("{bad")<\/script><\/body>/'
  vfault "missing script (404)"       runtime:http-error         's/<\/head>/<script src="\/app.js"><\/script><\/head>/'
  vfault "broken image"               content:broken-image       's/<\/main>/<img src="\/logo.png" alt="logo"><\/main>/'
  vfault "state cannot be reached"    state:step-failed          's/data-testid="search"/data-testid="query"/' "${VSPEC/key: [data-testid=\"search\"]
/}"
  echo "  visual faults caught: $VCAUGHT/$VTOTAL"

  echo "== https dev server with a self-signed certificate (visual.ignore_https_errors, default on)"
  if command -v openssl >/dev/null && openssl req -x509 -newkey rsa:2048 -nodes -keyout "$T/key.pem" -out "$T/cert.pem" -days 2 -subj "/CN=127.0.0.1" >/dev/null 2>&1; then
    SPORT=$((PORT + 1))
    cat > "$T/https-serve.js" <<'JS'
const https = require('https'), fs = require('fs'), path = require('path');
const [port, dir, key, cert] = process.argv.slice(2);
https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
  const f = path.join(dir, req.url === '/' ? 'index.html' : req.url.split('?')[0]);
  fs.readFile(f, (e, b) => { if (e) { res.writeHead(404); res.end(); } else { res.writeHead(200, { 'content-type': /\.html$/.test(f) ? 'text/html' : 'text/plain' }); res.end(b); } });
}).listen(+port, '127.0.0.1');
JS
    cp "$T/https-serve.js" https-serve.js
    sed -i.b "s#^  command: .*#  command: node https-serve.js $SPORT site $T/key.pem $T/cert.pem#; s#^  url: .*#  url: https://127.0.0.1:$SPORT/#" openspec/config.yaml && rm -f openspec/config.yaml.b
    expect "doctor reports visual.ignore_https_errors on by default" 'node openspec/scripts/verify-task.cjs doctor 2>/dev/null | grep -q "\"ignore_https_errors\": true"'
    reset_visual "$VT"; orch "$TICK1" "done"
    expect "self-signed https app: readiness probe and browser accept the certificate (check not a server/cert failure)" '[ $rc = 5 ] || [ $rc = 0 ]; [ -z "$(printf "%s" "$out" | grep -E "server:not-ready|ERR_CERT|runtime:http-error")" ]'
    sed -i.b 's#^  url: .*#&\n  ignore_https_errors: false#' openspec/config.yaml && rm -f openspec/config.yaml.b
    reset_visual "$VT"; orch "$TICK1" "done"
    expect "visual.ignore_https_errors: false is strict: the self-signed app is never ready (exit 1, server:not-ready)" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "server:not-ready"'
    git checkout -q openspec/config.yaml; rm -f https-serve.js
  else
    echo "  skipped: openssl not available"
  fi

  echo "== regressions outside the task's scope (no baselines: compared with the pre-task capture)"
  reset_visual "$VT" "${VSPEC/route: \//route: \/
component: index}"; orch "$TICK1" "done"; echo "STATUS: pass" > "$T/rev.txt"; $V review demo --reply "$T/rev.txt" >/dev/null 2>&1
  (openspec archive demo --yes >/dev/null 2>&1) && git add -A && git commit -qm "archive demo" >/dev/null
  expect "archived search-page scenario is now a declared main-spec scenario" 'grep -q "^component: index" openspec/specs/app/spec.md'
  C2=openspec/changes/other
  ASPEC='## ADDED Requirements

### Requirement: About page
The system SHALL show an about page.

#### Scenario: About page
- **WHEN** /about.html is opened
- **THEN** the about text is visible

```visual
route: /about.html
component: about
key: [data-testid="about"]
```'
  ABOUT='<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>About</title><link rel="stylesheet" href="theme.css"></head><body><main><h1 data-testid="about">About us</h1></main></body></html>'
  reset_other() { rm -rf "$C2" openspec/.apply-runs; mkdir -p "$C2/specs/about"; printf '## Why\nA later change: an about page sharing the theme.\n\n## What Changes\n- Adds an about page.\n\n## Edge cases\n- none named\n' > "$C2/proposal.md"
    printf '%s\n' "$ASPEC" > "$C2/specs/about/spec.md"; printf -- '- [ ] 1.1 About page\n  - Files: site/about.html, site/theme.css\n  - Visual: about/about-page\n  - Done when: `true`\n' > "$C2/tasks.md"
    git checkout -q site/ 2>/dev/null; rm -f site/about.html site/theme.css; sed -i.b 's#</head>#<link rel="stylesheet" href="theme.css"></head>#' site/index.html; rm -f site/index.html.b; : > site/theme.css; git add -A; git commit -qm "other change" >/dev/null; }
  orch2() { $V next other >/dev/null 2>&1 || { rc=$?; out="next exited $rc"; return; }; F="$C2/tasks.md" bash -c "printf '%s\n' '$ABOUT' > site/about.html; $1; $TICK1"; out="$($V check other 2>&1)"; rc=$?; }
  reset_other; orch2 "printf 'h1{letter-spacing:.01em}\n' >> site/theme.css"
  expect "control: new page plus a harmless shared-CSS edit passes the guard (review pending, exit 5)" '[ $rc = 5 ]'
  # rfault <name> <expected defect code> <edit made by the careless implementer> <where: check|finish>
  # With the default visual.scope (task) a task's check opens only its own scenarios, so a regression in another spec's
  # scenario is caught by `finish`, which opens every declared scenario. With visual.scope: all the check catches it.
  rfault() {
    reset_other; orch2 "$3"; local at=missed
    if [ $rc = 1 ] && printf "%s" "$out" | grep -q "$2" && printf "%s" "$out" | grep -q "app/search-page"; then at=check
    elif [ $rc = 5 ] || [ $rc = 0 ]; then
      [ $rc = 0 ] || { echo "STATUS: pass" > "$T/rev.txt"; $V review other --reply "$T/rev.txt" >/dev/null 2>&1; }
      out="$($V finish other 2>&1)"; rc=$?
      if [ $rc = 1 ] && printf "%s" "$out" | grep -q "$2" && printf "%s" "$out" | grep -rq "app/search-page" - openspec/.apply-runs/other/*/visual/finish-*/report.json; then at=finish; fi
    fi
    if [ "$at" = "$4" ]; then CAUGHT=$((CAUGHT+1)); RCAUGHT=$((RCAUGHT+1)); ok "regression caught at $at: $1 ($2)"; else bad "regression caught at $at, expected $4: $1 ($2) rc=$rc"; printf "%s\n" "$out" | head -20; fi
  }
  scope_all() { sed -i.b 's/^  ready_timeout: 20$/  ready_timeout: 20\n  scope: all/' openspec/config.yaml && rm -f openspec/config.yaml.b; git commit -qm scope-all openspec/config.yaml >/dev/null; }
  scope_default() { sed -i.b '/^  scope: all$/d' openspec/config.yaml && rm -f openspec/config.yaml.b; git commit -qm scope-default openspec/config.yaml >/dev/null; }
  RCAUGHT=0
  rfault "shared CSS hides the search page's result count" regression:aria-changed "printf '[data-testid=count]{display:none}\n' >> site/theme.css" finish
  rfault "shared CSS widens every input (search page scrolls sideways)" layout:horizontal-overflow "printf 'input{width:900px!important}\n' >> site/theme.css" finish
  rfault "unrelated markup edit: brand heading demoted to a div" regression:aria-changed "sed -i.b 's#<h1 data-testid=\"brand\">App</h1>#<div data-testid=\"brand\">App</div>#' site/index.html" finish
  echo "  regressions caught at finish (default scope): $RCAUGHT/3"; RFIN=$RCAUGHT; RCAUGHT=0
  scope_all
  rfault "visual.scope: all: shared CSS hides the search page's result count" regression:aria-changed "printf '[data-testid=count]{display:none}\n' >> site/theme.css" check
  rfault "visual.scope: all: shared CSS widens every input" layout:horizontal-overflow "printf 'input{width:900px!important}\n' >> site/theme.css" check
  rfault "visual.scope: all: brand heading demoted to a div" regression:aria-changed "sed -i.b 's#<h1 data-testid=\"brand\">App</h1>#<div data-testid=\"brand\">App</div>#' site/index.html" check
  echo "  regressions caught at check (visual.scope: all): $RCAUGHT/3"; CAUGHT=$((CAUGHT-RCAUGHT)); RCAUGHT=$RFIN
  reset_other; sed -i.b 's#  - Files: site/about.html, site/theme.css#  - Files: site/about.html, site/theme.css, site/index.html#' "$C2/tasks.md"; rm -f "$C2/tasks.md.b"; git add -A; git commit -qm scope >/dev/null
  orch2 "sed -i.b 's#<h1 data-testid=\"brand\">App</h1>#<div data-testid=\"brand\">App</div>#' site/index.html"
  expect "the same edit is allowed when the scenario's component is in the task's Files: (in scope, shown to the reviewer)" '[ $rc = 5 ] && grep -q "In-scope changes to other declared scenarios" "$(printf "%s" "$out" | sed -n -E "s/^ *\"review_prompt\": \"(.*)\",?$/\1/p")"'
  reset_other; $V next other >/dev/null 2>&1
  node -e 'const fs=require("fs");const f=require("child_process").execSync("ls -d openspec/.apply-runs/other/*/state.json").toString().trim();const s=JSON.parse(fs.readFileSync(f));s.visual_before=null;fs.writeFileSync(f,JSON.stringify(s))'
  F="$C2/tasks.md" bash -c "printf '%s\n' '$ABOUT' > site/about.html; printf '[data-testid=count]{display:none}\n' >> site/theme.css; $TICK1"; out="$($V check other 2>&1)"; rc=$?
  expect "no capture from next: before is taken from a temporary git worktree of HEAD, and the regression is still caught" '[ $rc = 1 ] && grep -q "worktree of HEAD" openspec/.apply-runs/other/*/visual/1.1-a1/report.json && printf "%s" "$out" | grep -q "regression:aria-changed" && [ "$(git worktree list | wc -l)" = 1 ]'
  echo "== review tasks may edit any file named in the change's Files: lines"
  reset_review() { # reset_review <Files: of task 1.1>
    reset_other; printf '%s\n' "$ABOUT" > site/about.html
    printf -- '- [x] 1.1 About page\n  - Files: %s\n  - Visual: about/about-page\n  - Done when: `true`\n- [ ] 1.R Request code review of the whole change\n  - Done when: `true`\n' "$1" > "$C2/tasks.md"; git add -A; git commit -qm "review fixture" >/dev/null; }
  DEMOTE="sed -i.b 's#<h1 data-testid=\"brand\">App</h1>#<div data-testid=\"brand\">App</div>#' site/index.html; rm -f site/index.html.b"
  reset_review "site/about.html, site/theme.css"
  $V next other >/dev/null 2>&1; F="$C2/tasks.md" bash -c "$DEMOTE; $TICK1"; out="$($V check other 2>&1)"; rc=$?
  expect "a review task editing a file no task of the change names is still caught" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "regression:aria-changed"'
  reset_review "site/about.html, site/theme.css, site/index.html"
  $V next other >/dev/null 2>&1; F="$C2/tasks.md" bash -c "$DEMOTE; $TICK1"; out="$($V check other 2>&1)"; rc=$?
  expect "a review task may change a file another task of the change names in Files: (no Files: of its own)" '[ $rc = 0 ] || [ $rc = 5 ]'
  echo "  regressions caught: $RCAUGHT/3"
  git checkout -q site/; rm -f site/about.html; rm -rf "$C2"; git add -A; git commit -qm "drop other" >/dev/null; scope_default

  echo "== no Playwright"
  reset_visual "$VT"; git add -A; git commit -qm r >/dev/null
  SPEC_VISUAL_PLAYWRIGHT=none orch "$TICK1" "done"
  expect "missing Playwright: skipped with a loud warning, not a silent pass" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "VISUAL CHECK SKIPPED"'
  sed -i.b 's/^  ready_timeout: 20$/  ready_timeout: 20\n  require_playwright: true/' openspec/config.yaml && rm -f openspec/config.yaml.b
  reset_visual "$VT"; SPEC_VISUAL_PLAYWRIGHT=none orch "$TICK1" "done"
  expect "visual.require_playwright: true turns the skip into a failure" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "require_playwright"'
  git checkout -q openspec/config.yaml
  sed -i.b 's#^  command: .*#  command: <fill in>#' openspec/config.yaml && rm -f openspec/config.yaml.b
  reset_visual "$VT"; rc=0; $V next demo > "$T/vc.json" 2> "$T/vc.err" || rc=$?
  expect "a task with Visual: refuses while visual.command is a placeholder (exit 2)" '[ $rc = 2 ] && grep -q "visual.command" "$T/vc.err"'
  git checkout -q openspec/config.yaml
else
  echo "  skip: no Playwright+axe-core in $PWM (set PLAYWRIGHT_NODE_MODULES) or no python3; visual loop not tested"
fi

echo; echo "passed=$PASS failed=$FAIL faults_caught=$CAUGHT quality_faults=${QC:-0}/21 visual_faults=$VCAUGHT/$VTOTAL regressions=${RCAUGHT:-0}/3"
[ "$FAIL" = 0 ]
