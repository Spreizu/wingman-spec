#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# Retries: the failure fingerprint (the same failure twice ends the approach: the last attempt starts over from the
# pre-task files, or the task stops), the implementer's attempt note in the retry prompt, a reply without a STATUS line.
# Usage: tests/retry-notes.sh   (needs the wingman-spec binary, see tests/lib/ws.sh, and node). Exit 0 when every case passes.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/ws.sh
. "$PKG/tests/lib/ws.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export WINGMAN_SPEC_TRACEABILITY=off GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
export WINGMAN_SPEC_CHECK_LEVEL=task
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; [ -n "${DEBUG:-}" ] && printf "%s\n" "$out"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }

cd "$T" && ws_project p && cd p || exit 1
V="$WS"; C=.wingman-spec/changes/demo
# The Done when test prints a TAP failure with a timing that differs per run: the fingerprint must ignore it.
cat > sum.test.mjs <<'JS'
import { sum } from "./sum.mjs";
const got = sum(1, 2), ms = (Math.random() * 90 + 1).toFixed(2);
if (got === 3) { console.log("ok 1 - sum adds"); process.exit(0); }
console.log(`not ok 1 - sum adds # ${ms}ms`);
console.log(`  AssertionError: expected 3, got ${got}`);
process.exit(1);
JS
printf 'export const sum = (a, b) => 0;\n' > sum.mjs
git add -A && git commit -qm init

reset_change() {
  rm -rf "$C" .wingman-spec/runs; mkdir -p "$C/specs"
  printf '## Why\nDemo change for the retry tests.\n\n## What Changes\n- Adds a sum.\n\n## Edge cases\n- none named\n' > "$C/proposal.md"
  printf '## ADDED\n\n### Requirement: Sum\nThe system SHALL add.\n\n#### Scenario: add\n- **WHEN** asked\n- **THEN** it adds\n' > "$C/specs/demo.md"
  printf -- '- [ ] 1.1 sum\n  - Files: sum.mjs, helper.mjs\n  - Done when: `node sum.test.mjs`\n' > "$C/tasks.md"
  git checkout -q sum.mjs; rm -f helper.mjs
}
MA=3
step() { # step <code for sum.mjs> [reported] [note]: one next -> implementer -> check round
  $V next demo --max-attempts "$MA" --format prompt > "$T/prompt.txt" 2>/dev/null || { rc=$?; out="next exited $rc"; return; }
  printf '%s\n' "$1" > sum.mjs
  [ -n "${3:-}" ] && { mkdir -p "$(dirname "$NOTE")"; printf '%s\n' "$3" > "$NOTE"; }
  out="$($V check demo --max-attempts "$MA" --reported "${2:-done}" 2>&1)"; rc=$?
}

echo "== the same failure twice: the last attempt starts over with a different approach"
reset_change
$V next demo --format prompt > "$T/p1.txt"; rc=$?
NOTE="$(sed -n 's/^Attempt note: overwrite `\(.*\)` before you reply.$/\1/p' "$T/p1.txt")"
expect "the first prompt names the attempt note under the change's run folder" '[ $rc = 0 ] && case "$NOTE" in *.wingman-spec/runs/demo/notes/1.1.md) true;; *) false;; esac'
$V next demo --format json > "$T/p1.json"
expect "the packet carries the note path" 'grep -q "\"attempt_note\": \".*notes/1.1.md\"" "$T/p1.json"'
step 'export const sum = (a, b) => a - b;' done 'Tried a - b. Ruled out nothing yet.'
expect "attempt 1 is rejected and not yet a repeat" '[ $rc = 1 ] && ! printf "%s" "$out" | grep -q "\"repeated\""'
fp1="$(find .wingman-spec/runs -name metrics.jsonl -exec cat {} + | node -e 'let l=require("fs").readFileSync(0,"utf8").trim().split("\n").map(JSON.parse).filter(r=>r.event==="check");console.log(l.at(-1).fingerprint)' )"
expect "the fingerprint is the check, the test id and the first error line" 'printf "%s" "$fp1" | grep -q "sum adds" && printf "%s" "$fp1" | grep -q "AssertionError: expected 3, got -1" && ! printf "%s" "$fp1" | grep -qE "[0-9]ms"'
$V next demo --format prompt > "$T/p2.txt"
expect "attempt 2 prompt: the failure and the previous note, and no Already done list" 'grep -q "attempt 2 of 3" "$T/p2.txt" && grep -q "rejected by the verifier" "$T/p2.txt" && grep -q "Tried a - b" "$T/p2.txt" && ! grep -q "Already done" "$T/p2.txt"'
printf 'export const sum = (a, b) => a - b; // attempt 2\n' > sum.mjs
printf 'export const h = 1;\n' > helper.mjs
printf 'Tried a - b again with a comment.\n' > "$NOTE"
out="$($V check demo --reported done 2>&1)"; rc=$?
expect "attempt 2 fails the same way (another timing): repeated, the next attempt is the last" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "\"repeated\"" && printf "%s" "$out" | grep -q "attempt 3 of 3 is the last"'
expect "the task's files are back as handed out: sum.mjs restored, the created helper.mjs removed" 'grep -q "=> 0;" sum.mjs && [ ! -e helper.mjs ]'
D="$(dirname "$NOTE")/1.1.md.d/attempt-2.diff"
expect "the failed attempt's diff is kept next to the note" 'grep -q "attempt 2" "$D" && grep -q "new file helper.mjs" "$D"'
$V next demo --format prompt > "$T/p3.txt"
expect "the last attempt gets the different-approach prompt with the ruled-out failure, the diff and the note" 'grep -q "attempt 3 of 3, the last one" "$T/p3.txt" && grep -q "approach is ruled out" "$T/p3.txt" && grep -q "take a different one" "$T/p3.txt" && grep -q "attempt-2.diff" "$T/p3.txt" && grep -q "Tried a - b again" "$T/p3.txt"'
printf 'export const sum = (a, b) => a + b;\n' > sum.mjs
out="$($V check demo --reported done 2>&1)"; rc=$?
expect "the different approach passes" '[ $rc = 0 ] && printf "%s" "$out" | grep -q "\"result\": \"passed\""'
expect "the note is discarded when the task passes" '[ ! -e "$NOTE" ] && [ ! -e "$(dirname "$NOTE")/1.1.md.d" ]'

echo "== a repeat on the last attempt stops with a report"
reset_change
step 'export const sum = (a, b) => a - b;' done 'Tried a - b.'
step 'export const sum = (a, b) => a * b;' done 'Tried a * b.'
expect "two different failures are not a repeat" '[ $rc = 1 ] && ! printf "%s" "$out" | grep -q "\"repeated\""'
step 'export const sum = (a, b) => a * b; // again' done 'Tried a * b again.'
expect "the third attempt repeats the second: exhausted with the stop report" '[ $rc = 4 ] && printf "%s" "$out" | grep -q "\"result\": \"exhausted\"" && printf "%s" "$out" | grep -q "\"stopped\": \"attempts 2 and 3 failed the same way" && printf "%s" "$out" | grep -q "notes/1.1.md"'

echo "== more attempts: the repeat skips to the last one"
reset_change
MA=5
step 'export const sum = (a, b) => a - b;' done
step 'export const sum = (a, b) => a - b;' done
expect "with 5 attempts a repeat at attempt 2 makes attempt 5 the last" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "attempt 5 of 5 is the last"'
MA=3

echo "== no STATUS line"
reset_change
step 'export const sum = (a, b) => a - b;' none 'Tried a - b; ran out of turns before the test.'
expect "--reported none is a failed attempt without running the checks" '[ $rc = 1 ] && printf "%s" "$out" | grep -q "ended without a STATUS line"'
$V next demo --format prompt > "$T/p4.txt"
expect "the next attempt is told the previous one ended without a status, with its note" 'grep -q "ended without a STATUS line" "$T/p4.txt" && grep -q "ran out of turns before the test" "$T/p4.txt"'
step 'export const sum = (a, b) => a - b;' none
step 'export const sum = (a, b) => a - b;' none
expect "replies without a status are never a repeat (nothing was checked)" '[ $rc = 4 ] && ! printf "%s" "$out" | grep -q "\"repeated\""'
reset_change
step 'export const sum = (a, b) => a - b;' none
$V next demo --format prompt > "$T/p5.txt"
expect "no status and no note: the prompt says so" 'grep -q "It left no attempt note" "$T/p5.txt"'
rc=0; $V check demo --reported maybe > /dev/null 2>&1 || rc=$?
expect "an unknown --reported value is a usage error" '[ $rc = 2 ]'

echo "== Read first names the spec file, not the specs directory"
reset_change
printf '## ADDED\n\n### Requirement: Other\nThe system SHALL stay listed apart.\n\n#### Scenario: other\n- **WHEN** x\n- **THEN** y\n' > "$C/specs/other.md"
mkdir -p "$C/adrs"
printf -- '---\nstatus: none\n---\nNone.\n' > "$C/adrs/none.md"
printf -- '- [ ] 1.1 sum\n  - Spec: demo > Sum (add)\n  - Files: sum.mjs\n  - Done when: `true`\n' > "$C/tasks.md"
$V next demo --format prompt > "$T/spec.txt"; rc=$?
rf() { grep "^Read first:" "$1"; }
expect "Read first names specs/demo.md, not the other delta, the specs directory or adrs" '[ $rc = 0 ] && rf "$T/spec.txt" | grep -q "specs/demo.md" && ! rf "$T/spec.txt" | grep -q "other.md" && ! rf "$T/spec.txt" | grep -Eq "specs(,|\\.|$)" && ! rf "$T/spec.txt" | grep -q "adrs"'
printf -- '- [ ] 1.1 sum\n  - Spec: demo > Sum (add)\n  - Files: sum.mjs\n  - Done when: `true`\n  - Note: read the decision record\n' > "$C/tasks.md"
rm -rf .wingman-spec/runs
$V next demo --format prompt > "$T/dec.txt"; rc=$?
expect "a task that mentions a decision lists adrs in Read first" '[ $rc = 0 ] && rf "$T/dec.txt" | grep -q "adrs"'

echo; echo "passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
