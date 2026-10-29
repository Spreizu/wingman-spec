#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# verify-task finds a task's checkbox when `openspec instructions apply --json` omits `line` and `sourcePath` (OpenSpec 1.7.x).
# A shim in front of `openspec` strips both fields from the real output, so the rest is the real CLI. Usage: tests/task-lines.sh
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export SPEC_TRACEABILITY=off OPENSPEC_TELEMETRY=0 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }

REAL="$(command -v openspec)"
mkdir -p "$T/shim"
cat > "$T/shim/openspec" <<SHIM
#!/usr/bin/env bash
# strips line and sourcePath from the apply JSON like OpenSpec 1.7.x; SHIM_MANGLE=1 also rewords every description (the text then matches no checkbox)
out="\$("$REAL" "\$@")"; rc=\$?
if [ "\$1 \$2" = "instructions apply" ]; then
  printf '%s' "\$out" | node -e 'const j=JSON.parse(require("fs").readFileSync(0,"utf8")); for (const t of j.tasks||[]) { delete t.line; delete t.sourcePath; if (process.env.SHIM_MANGLE) t.description += " (renamed)"; } process.stdout.write(JSON.stringify(j,null,2)+"\n")'
else printf '%s\n' "\$out"; fi
exit \$rc
SHIM
chmod +x "$T/shim/openspec"

cd "$T" && mkdir p && cd p && git init -q
openspec init --tools none >/dev/null 2>&1 || mkdir -p openspec/changes openspec/specs
"$PKG/install.sh" . >/dev/null || { echo "install failed"; exit 1; }
sed -i.b 's/Test command: <fill in>/Test command: none/' openspec/config.yaml && rm -f openspec/config.yaml.b
export PATH="$T/shim:$PATH"
V="node openspec/scripts/verify-task.cjs"; C=openspec/changes/demo
reset_change() {
  rm -rf "$C" openspec/.apply-runs; mkdir -p "$C/specs/demo"
  printf '## Why\nDemo change for the task-line tests.\n\n## What Changes\n- Adds a demo capability.\n\n## Edge cases\n- none named\n' > "$C/proposal.md"
  printf '## ADDED Requirements\n\n### Requirement: Demo\nThe system SHALL greet.\n\n#### Scenario: greet\n- **WHEN** asked\n- **THEN** it greets\n' > "$C/specs/demo/spec.md"
  printf '%s\n' "$1" > "$C/tasks.md"
}
stline() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(j.task.line, j.task.details.length)' "$(ls openspec/.apply-runs/demo/*/state.json | head -1)"; }
tick_first() { n=$(grep -nE "^[-*] \[ \]" "$C/tasks.md" | head -1 | cut -d: -f1); sed -i.b "${n}s/\[ \]/[x]/" "$C/tasks.md"; rm -f "$C/tasks.md.b"; }

echo "== the shim removes line and sourcePath like OpenSpec 1.7.x"
reset_change '- [ ] 1.1 one'
expect "apply JSON has neither line nor sourcePath" '! openspec instructions apply --change demo --json | grep -qE "\"(line|sourcePath)\""'

echo "== omitted line: next finds the checkbox, reads its details, check passes"
reset_change '## 1. G

- [ ] 1.1 first task
  - Done when: `true` exits 0
- [ ] 1.2 second task
  - Done when: `true` exits 0'
rc=0; $V next demo >/dev/null 2>&1 || rc=$?
expect "next exits 0" '[ $rc = 0 ]'
expect "the task line is 3 and its Done-when detail was read" '[ "$(stline)" = "3 1" ]'
tick_first; out="$($V check demo 2>&1)"; rc=$?
expect "check passes the tick" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "\"result\": \"passed\""'
rc=0; $V next demo >/dev/null 2>&1 || rc=$?
expect "the second task is next: its line is 5" '[ $rc = 0 ] && [ "$(stline)" = "5 1" ]'

echo "== duplicate descriptions: each task gets its own line"
reset_change '- [ ] Show a hint under the box
  - Done when: `true` exits 0
- [ ] Show a hint under the box
  - Done when: `true` exits 0'
rc=0; $V next demo >/dev/null 2>&1 || rc=$?
expect "the first duplicate is handed out (line 1)" '[ $rc = 0 ] && [ "$(stline)" = "1 1" ]'
tick_first; out="$($V check demo 2>&1)"; rc=$?
expect "ticking it passes" '[ $rc = 0 ]'
rc=0; $V next demo >/dev/null 2>&1 || rc=$?
expect "the second duplicate is next (line 3), not the ticked one again" '[ $rc = 0 ] && [ "$(stline)" = "3 1" ]'
out="$($V check demo 2>&1)"; rc=$?
expect "an untouched second duplicate is verified and ticked at its own line (3), the first one stays as it was" '[ $rc = 0 ] && sed -n 1p "$C/tasks.md" | grep -q "^- \[x\]" && sed -n 3p "$C/tasks.md" | grep -q "^- \[x\]"'

echo "== a description with regex characters"
reset_change '- [ ] 2.1 Match "a.b*" and (x|y) [1+2] $HOME ^start \d+ ?
  - Done when: `true` exits 0'
rc=0; $V next demo >/dev/null 2>&1 || rc=$?
expect "next finds it (line 1)" '[ $rc = 0 ] && [ "$(stline)" = "1 1" ]'
tick_first; out="$($V check demo 2>&1)"; rc=$?
expect "check passes" '[ $rc = 0 ]'

echo "== a task that matches no checkbox is refused, never line 0"
reset_change '- [ ] one
  - Done when: `true` exits 0'
rc=0; out="$(SHIM_MANGLE=1 $V next demo 2>&1)" || rc=$?
expect "next refuses with a clear message (exit 2)" '[ $rc = 2 ] && printf "%s" "$out" | grep -q "cannot find the checkbox of task \"one (renamed)\""'
expect "no state with a line 0 was written" '! ls openspec/.apply-runs/demo/*/state.json >/dev/null 2>&1 || ! grep -q "\"line\": 0" openspec/.apply-runs/demo/*/state.json'

echo "== the helper itself, on the recorded OpenSpec 1.7.0 output"
rc=0; out="$(node "$PKG/tests/fixtures/openspec-1.7.0/unit.cjs" "$PKG/project-template/openspec/scripts/quality.cjs" "$PKG/tests/fixtures/openspec-1.7.0" "$T/two" 2>&1)" || rc=$?
echo "$out" | sed 's/^/    /'
expect "recorded 1.7.0 tasks resolve to lines 3,5,6,10,11 in tasks.md" 'echo "$out" | sed -n 1p | grep -q "^3,5,6,10,11 true$"'
expect "two files: duplicates take the first unused match, in file order" 'echo "$out" | sed -n 2p | grep -q "^a.md:1,a.md:2,b.md:1,b.md:2$"'
expect "sourcePath restricts the search; a given line is trusted" 'echo "$out" | sed -n 3p | grep -q "^b.md:1 a.md:7$"'
expect "whitespace, bare text and the label fallback find the checkbox" 'echo "$out" | sed -n 4p | grep -q "^1 1 1$"'
expect "an unknown task throws a clear error" 'echo "$out" | sed -n 5p | grep -q "^refused: true$"'

echo "task-lines: passed=$PASS failed=$FAIL"; [ "$FAIL" = 0 ]
