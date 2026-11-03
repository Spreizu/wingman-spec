#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# The Why on each requirement, code anchors, drift, sync-before-archive: contract tests for the wingman-spec CLI
# (internal/trace), including seeded drift. Usage: tests/traceability.sh (needs the wingman-spec binary (tests/lib/ws.sh) and node). Exit 0 when all pass.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/ws.sh
. "$PKG/tests/lib/ws.sh"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
unset WINGMAN_SPEC_TRACEABILITY
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }
J() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));let v=j;for(const k of process.argv[2].split(".").filter(Boolean))v=v==null?v:v[k];console.log(typeof v==="object"?JSON.stringify(v):String(v))' "$1" "$2"; }

cd "$T" && mkdir p && cd p && git init -q
ws_init .
ws_cmd test none && ws_cmd typecheck none && ws_cmd lint none && ws_set visual off
V="$WS"; C=.wingman-spec/changes/todo
git add -A && git commit -qm init

echo "== install"
expect "the config written by init turns traceability on" 'grep -q "^traceability: on" .wingman-spec/wingman-spec.yaml'
"$WS" init --harness all >/dev/null 2>&1
for h in .claude/commands .agents/skills; do
  f="$h/spec-garden.md"; [ "$h" = .agents/skills ] && f=".agents/skills/spec-garden/SKILL.md"
  expect "spec-garden is installed for $h" 'grep -q "drift decide" "$f"'
  f="$h/spec-archive.md"; [ "$h" = .agents/skills ] && f=".agents/skills/spec-archive/SKILL.md"
  expect "spec-archive archives through the CLI, which gates and syncs ($h)" 'grep -q "wingman-spec archive" "$f" && ! grep -q "Always sync first" "$f"'
done

mk() { # mk <spec requirement block(s)>: writes change todo
  rm -rf "$C" .wingman-spec/runs; mkdir -p "$C/specs/todo"
  printf 'Size: S\nRisk: none\n\n## Why\nPeople lose track of what they have to do, so they need a list.\n\n## What Changes\n- Adds a todo list.\n\n## Capabilities\n### New Capabilities\n- `todo`: keep a list\n\n## ADR candidates\nnone\n\n## Impact\nsrc/\n\n## Edge cases\n- none named\n' > "$C/proposal.md"
  printf '## Purpose\nKeeps a list of things to do for one person, in order of entry.\n\n## ADDED\n\n%s\n' "$1" > "$C/specs/todo.md"
  printf '## 1. Todo\n- [x] 1.1 add\n  - Spec: todo/add-a-todo\n  - Test first: x\n  - Files: src/todo.js\n  - Done when: `true` exits 0\n' > "$C/tasks.md"
}
REQ='### Requirement: Add a todo
The system SHALL append a todo with the given text to the list.
Why: A person wants to keep a list of things to do, so that nothing is forgotten.

#### Scenario: Add and see it
- **WHEN** the user adds "buy milk" and lists the todos
- **THEN** the list is ["buy milk"]

#### Scenario: Empty text
- **WHEN** the user adds ""
- **THEN** it is rejected with "text required" and the list is unchanged'
lint() { rc=0; $V lint todo > "$T/lint.json" 2> "$T/lint.err" || rc=$?; }
lintmsg() { grep -q "$1" "$T/lint.json"; }

echo "== why lint"
mk "$REQ"; lint
expect "a requirement with a Why line passes lint" '[ $rc = 0 ] && [ "$(J "$T/lint.json" traceability)" = on ]'
expect "validate accepts Why lines" '$WS validate todo >/dev/null 2>&1'
mk "${REQ/Why: A person wants to keep a list of things to do, so that nothing is forgotten./}"; lint
expect "a requirement without a Why line is an error that shows the format" '[ $rc = 1 ] && lintmsg "Why:" && lintmsg "Add a todo"'
mk "${REQ/so that nothing is forgotten./so that nothing is forgotten.
Verify: tests}"; lint
expect "a Verify: line must name inspection, analysis or demonstration" '[ $rc = 1 ] && lintmsg "verify-method" && lintmsg "inspection, analysis, demonstration"'
mk "${REQ/Why: A person wants to keep a list of things to do, so that nothing is forgotten./Why: a list}"; lint
expect "a Why under 5 words is an error (it names no one and no reason)" '[ $rc = 1 ] && lintmsg "too short"'
mk "${REQ/Why: A person wants to keep a list of things to do, so that nothing is forgotten./Why: }"; lint
expect "an empty Why line (the quick fix placeholder) is still an error" '[ $rc = 1 ] && lintmsg "too short"'
mk "${REQ/Why: A person wants to keep a list of things to do, so that nothing is forgotten./}"; WINGMAN_SPEC_TRACEABILITY=warn lint
expect "traceability warn: the same finding is a warning (exit 0)" '[ $rc = 0 ] && lintmsg "Why:"'
WINGMAN_SPEC_TRACEABILITY=off lint
expect "traceability off: no Why rule at all (exit 0)" '[ $rc = 0 ] && ! lintmsg "no .Why:. line"'
mk "${REQ/Why: A person wants to keep a list of things to do, so that nothing is forgotten./}"; sed -i 's/\[x\]/[ ]/' "$C/tasks.md"
$V next todo >/dev/null 2>&1; rc=$?
expect "next refuses a plan whose requirements have no Why (exit 2)" '[ $rc = 2 ]'

echo "== code anchors"
mk "$REQ"; mkdir -p src test
rc=0; $V anchors todo > "$T/a.json" || rc=$?
expect "no markers: the requirement lacks a code anchor and a test anchor (exit 1)" '[ $rc = 1 ] && grep -q "no-code-anchor" "$T/a.json" && grep -q "no-test-anchor" "$T/a.json"'
printf '// @spec todo/add-a-todo\nexports.add = () => 0;\n' > src/todo.js
printf "// [todo/add-and-see-it] [todo/empty-text]\n" > test/todo.test.js
rc=0; $V anchors todo --json > "$T/a.json" || rc=$?
expect "a code marker + tagged tests satisfy code and test anchors; the derived index is printed, nothing is written" '[ $rc = 0 ] && [ ! -e .wingman-spec/anchors.json ] && [ "$(J "$T/a.json" index.requirements)" != "{}" ]'
cp "$T/a.json" "$T/anchors1.json"; $V anchors todo --json > "$T/a2.json"
expect "the derived index is deterministic (no timestamps, identical on rerun)" 'cmp -s "$T/a2.json" "$T/anchors1.json" && ! grep -qiE "\"(date|time)" "$T/a.json"'
rc=0; $V anchors todo --write >/dev/null 2>&1 || rc=$?
expect "anchors --write no longer exists (no committed index): unknown option" '[ $rc = 2 ]'
printf '# @spec todo/add-a-todo\n' > src/a.py; printf -- '-- @spec todo/add-a-todo\n' > src/a.sql; printf '<!-- @spec todo/add-a-todo -->\n' > src/a.html; printf '/* @spec todo/add-a-todo */\n' > src/a.c; printf '%% @spec todo/add-a-todo\n' > src/a.erl
$V anchors todo --json > "$T/a.json"
expect "markers work in any comment syntax (#, --, <!-- -->, /* */, %)" 'for f in a.py a.sql a.html a.c a.erl; do grep -q "src/$f" "$T/a.json" || exit 1; done'
rm -f src/a.*
printf 'const s = "@spec todo/ghost"; // not a marker: not after a comment leader\n' > src/str.js
rc=0; $V anchors todo > "$T/a.json" || rc=$?
expect "an @spec inside a string literal is not a marker" '[ $rc = 0 ]'
rm -f src/str.js
printf '// @spec todo/ghost-requirement\n' > src/g.js
rc=0; $V anchors todo > "$T/a.json" || rc=$?
expect "an unresolved marker fails (exit 1) and names file:line" '[ $rc = 1 ] && grep -q "unresolved-marker" "$T/a.json" && grep -q "src/g.js" "$T/a.json"'
printf '// @spec todo/add-a-todos\n' > src/g.js
$V anchors todo > "$T/a.json" || true
expect "a near miss gets a did-you-mean hint" 'grep -q "todo/add-a-todo" "$T/a.json"'
rm -f src/g.js
mkdir -p node_modules/x ignored; printf '// @spec todo/ghost\n' > node_modules/x/i.js; printf '// @spec todo/ghost\n' > ignored/i.js; printf 'ignored/\n' > .gitignore
rc=0; $V anchors todo > "$T/a.json" || rc=$?
expect "node_modules and .gitignore'd files are not scanned" '[ $rc = 0 ]'
printf '// [todo/no-such-scenario]\n' >> test/todo.test.js
rc=0; $V anchors todo > "$T/a.json" || rc=$?
expect "a test tag for a scenario that does not exist is a stale tag (exit 1)" '[ $rc = 1 ] && grep -q "stale-test-tag" "$T/a.json"'
sed -i '$d' test/todo.test.js
printf '// @spec todo/add-a-todo\n' > test/only-marker.test.js; printf '' > test/todo.test.js
rc=0; $V anchors todo > "$T/a.json" || rc=$?
expect "an @spec marker in a test file is a test anchor too" '[ $rc = 0 ]'
rm -f test/only-marker.test.js; printf "// [todo/add-and-see-it] [todo/empty-text]\n" > test/todo.test.js

echo "== finish and check"
git add -A; git commit -qm code
rm -rf .wingman-spec/runs; $V next todo >/dev/null 2>&1; rc=$?
expect "next reports every task done (exit 10)" '[ $rc = 10 ]'
printf '%s\n' '// no marker' > src/todo.js
rc=0; $V finish todo > "$T/f.json" 2>/dev/null || rc=$?
expect "finish fails a requirement without a code anchor (exit 1)" '[ $rc = 1 ] && grep -q "code anchors" "$T/f.json"'
rm -rf .wingman-spec/runs
printf '// @spec todo/add-a-todo\nexports.add = () => 0;\n' > src/todo.js
rc=0; $V finish todo > "$T/f.json" 2>/dev/null || rc=$?
expect "finish passes with anchors and tells the user to run /spec-archive (the gate re-checks, then it syncs), not to sync by hand" '[ $rc = 0 ] && [ "$(J "$T/f.json" result)" = finished ] && grep -q "Run /spec-archive todo; the archive gate checks this finish still holds" "$T/f.json" && ! grep -qi "mandatory" "$T/f.json"'
printf '// @spec todo/ghost\n' > src/g.js; rm -rf .wingman-spec/runs
rc=0; $V finish todo > "$T/f.json" 2>/dev/null || rc=$?
expect "finish fails an unresolved marker" '[ $rc = 1 ]'
rm -f src/g.js; rm -rf .wingman-spec/runs

echo "== the archive gate"
rc=0; $V archive todo > "$T/ar.json" 2> "$T/ar.err" || rc=$?
expect "archive refuses without a passing finish (exit 1), lists each failed condition and writes nothing" '[ $rc = 1 ] && grep -q "finish: finish has not passed" "$T/ar.err" && [ -d "$C" ] && [ ! -e .wingman-spec/specs/todo.md ]'
expect "the refusal is JSON with every gate check" '[ "$(J "$T/ar.json" result)" = refused ] && for k in blocked tasks findings finish lint merge; do grep -q "\"check\": \"$k\"" "$T/ar.json" || exit 1; done'
WINGMAN_SPEC_TRACEABILITY=off $V archive todo >/dev/null 2>"$T/ar.err"; rc=$?
expect "the refusal also holds with traceability off" '[ $rc = 1 ] && [ -d "$C" ]'
mkdir -p "$C/adrs"; printf 'No decision here.\n' > "$C/adrs/none.md"; printf -- '---\ntitle: Skip\nstatus: None\ndate: 2026-10-25\n---\nNothing.\n' > "$C/adrs/skip.md"
printf 'q\n' > ignored/app.log; git add -f ignored/app.log; git commit -qm 'a committed log in an ignored folder'
$V finish todo > "$T/f.json" 2>/dev/null; rc=$?
expect "finish passes again (it records the tree it checked)" '[ $rc = 0 ] && grep -q "\"gate\"" .wingman-spec/runs/todo/finished.json'
printf '// edited after finish\n' >> src/todo.js; printf 'q\n' >> ignored/app.log
rc=0; $V archive todo > "$T/ar.json" 2> "$T/ar.err" || rc=$?
expect "a code edit after finish refuses the archive and names the file; the app's ignored log does not count" '[ $rc = 1 ] && grep -q "changed since finish passed" "$T/ar.err" && grep -q "finish: src/todo.js" "$T/ar.err" && ! grep -q "app.log" "$T/ar.err" && [ -d "$C" ]'
sed -i '$d' src/todo.js
printf -- '---\ntitle: Use a list\nstatus: Accepted\ndate: 2026-10-25\nchange: todo\n---\nWe keep an array.\n' > "$C/adrs/use-a-list.md"
rc=0; $V archive todo > "$T/ar.json" 2> "$T/ar.err" || rc=$?
expect "an ADR added after finish changes the plan: archive refuses until finish runs again" '[ $rc = 1 ] && grep -q "changed since finish passed" "$T/ar.err" && [ ! -d .wingman-spec/adrs ]'
rm "$C/adrs/use-a-list.md"
mkdir -p .wingman-spec/specs; sed 's/^## ADDED/## Requirements/' "$C/specs/todo.md" > .wingman-spec/specs/todo.md
cp .wingman-spec/specs/todo.md "$T/merged.md"
rc=0; $V sync todo --check > "$T/sc.json" || rc=$?
expect "the living spec already says what the delta adds: sync --check reports it synced" '[ $rc = 0 ] && ! grep -q "specs/todo.md" "$T/sc.json"'
expect "sync --check is read-only: it writes no file" 'cmp -s "$T/merged.md" .wingman-spec/specs/todo.md && [ ! -d .wingman-spec/adrs ]'
expect "the merged living specs still validate and keep the Why line" '$WS validate --specs >/dev/null 2>&1 && grep -q "^Why: A person wants" .wingman-spec/specs/todo.md'
rc=0; $V intents todo >/dev/null 2>&1 || rc=$?
expect "there is no intents command any more (exit 2)" '[ $rc = 2 ]'
rc=0; $V archive todo > "$T/ar.json" 2> "$T/ar.err" || rc=$?
expect "archive passes the gate, merges (the spec is unchanged) and archives in one step" '[ $rc = 0 ] && [ "$(J "$T/ar.json" result)" = archived ] && [ ! -d "$C" ] && ls .wingman-spec/archive | grep -q todo && cmp -s "$T/merged.md" .wingman-spec/specs/todo.md'
expect "a none record is never promoted: by file name (none.md) or by status (None)" '[ ! -d .wingman-spec/adrs ] || [ -z "$(ls .wingman-spec/adrs)" ]'
git add -A; git commit -qm synced
rc=0; $V drift > "$T/d.json" || rc=$?
expect "after a proper sync + archive the drift report is clean (exit 0)" '[ $rc = 0 ] && [ "$(J "$T/d.json" ok)" = true ]'

echo "== seeded drift (every kind must be caught, the clean control must not alarm)"
drift() { rc=0; $V drift > "$T/d.json" 2>/dev/null || rc=$?; }
gap() { grep -q "\"key\": \"$1" "$T/d.json"; }
drift; expect "control: no seeded drift, no alarm" '[ $rc = 0 ]'
rm src/todo.js; drift
expect "seed 1, code deleted: unanchored requirement" '[ $rc = 1 ] && gap unanchored-requirement:todo/add-a-todo'
git checkout -q src/todo.js
git mv src/todo.js src/todos.js; drift
expect "seed 2, file renamed: the marker moved with it, so there is no drift and no index to rewrite" '[ $rc = 0 ]'
git mv src/todos.js src/todo.js
sed -i 's/### Requirement: Add a todo/### Requirement: Append a todo/' .wingman-spec/specs/todo.md; drift
expect "seed 3, requirement renamed: orphan anchor (with a rename hint) + new requirement unanchored" '[ $rc = 1 ] && gap orphan-anchor:todo/add-a-todo@src/todo.js && gap unanchored-requirement:todo/append-a-todo && grep -q "append-a-todo" "$T/d.json"'
git checkout -q .wingman-spec/specs
printf '// @spec todo/ghost-requirement\n' > src/x.js; drift
expect "seed 4, orphan marker: orphan-anchor" '[ $rc = 1 ] && gap orphan-anchor:todo/ghost-requirement@src/x.js'
rm src/x.js
printf '// [todo/no-such-scenario]\n' >> test/todo.test.js; drift
expect "seed 5, stale test tag: stale-test-tag" '[ $rc = 1 ] && gap stale-test-tag:todo/no-such-scenario'
git checkout -q test
printf '' > test/todo.test.js; drift
expect "seed 6, tests lost their tags: untested requirement" '[ $rc = 1 ] && gap untested-requirement:todo/add-a-todo'
sed -i 's/^Why: A person wants to keep a list.*/&\nVerify: inspection of the stored list in a review/' .wingman-spec/specs/todo.md; drift
expect "a Verify: line (inspection, analysis, demonstration) exempts the requirement from untested" '[ $rc = 0 ] && ! gap untested-requirement:todo/add-a-todo'
$V trace --text > "$T/tr.txt" 2>&1
expect "trace counts the scenarios of a Verify: requirement as verified without a test, not untested" 'grep -q "2 verified without a test, 0 untested" "$T/tr.txt"'
git checkout -q .wingman-spec/specs
git checkout -q test
drift; expect "restoring everything gives a clean report again" '[ $rc = 0 ]'

echo "== accept: an Accepted line on the requirement (nothing else is stored)"
rm src/todo.js; drift
$V drift decide unanchored-requirement:todo/add-a-todo --accept > "$T/dd.json" 2> "$T/dd.err"; rc=$?
expect "accepting needs a note (exit 2)" '[ $rc = 2 ]'
$V drift decide unanchored-requirement:todo/add-a-todo --redo --note "x" >/dev/null 2>&1; rc=$?
expect "redo and amend are not recorded: the option is refused (exit 2)" '[ $rc = 2 ]'
$V drift decide orphan-anchor:todo/ghost-requirement@src/x.js --accept --note "x" >/dev/null 2>&1; rc=$?
expect "a gap that lives in code (orphan marker) cannot be accepted: it is fixed (exit 2)" '[ $rc = 2 ]'
cp .wingman-spec/specs/todo.md "$T/spec.before"
$V drift decide unanchored-requirement:todo/add-a-todo --accept --note "kept: the code moved to a service we do not own" > "$T/dd.json"; drift
expect "accept: the gap is no longer open (exit 0) and is listed as accepted with its reason" '[ $rc = 0 ] && [ "$(J "$T/d.json" accepted.0.key)" = unanchored-requirement:todo/add-a-todo ] && grep -q "service we do not own" "$T/d.json"'
expect "accept: exactly one line was added to the living spec, below the SHALL line and above the first scenario, and nothing else" '[ "$(diff "$T/spec.before" .wingman-spec/specs/todo.md | grep -c "^[<>]")" = 1 ] && grep -q "^Accepted: kept: the code moved" .wingman-spec/specs/todo.md && [ "$(grep -n "^Accepted:" .wingman-spec/specs/todo.md | cut -d: -f1)" -lt "$(grep -n "#### Scenario" .wingman-spec/specs/todo.md | head -1 | cut -d: -f1)" ]'
expect "accept writes no other file (only the spec and the code under test differ)" '[ "$(git status --porcelain | grep -vc "src/todo.js")" = 1 ]'
cp .wingman-spec/specs/todo.md "$T/spec.once"; $V drift decide unanchored-requirement:todo/add-a-todo --accept --note "kept: the code moved to a service we do not own" >/dev/null
expect "accepting again with the same reason is a no-op (idempotent)" 'cmp .wingman-spec/specs/todo.md "$T/spec.once"'
$V drift decide unanchored-requirement:todo/add-a-todo --accept --note "new reason" >/dev/null
expect "accepting again with a new reason replaces the one line" '[ "$(grep -c "^Accepted:" .wingman-spec/specs/todo.md)" = 1 ] && grep -q "^Accepted: new reason" .wingman-spec/specs/todo.md'
# the Accepted line is not part of the requirement text (sync compares the text): go test ./internal/trace -run TestAcceptedLineIsNotRequirementText
expect "the living spec still validates with the Accepted line" '$WS validate --specs >/dev/null 2>&1'
$V drift --text > "$T/dt.txt"; expect "drift --text lists it as accepted" 'grep -q "accepted unanchored-requirement:todo/add-a-todo  (new reason)" "$T/dt.txt"'
git checkout -q src/todo.js .wingman-spec/specs
$V drift decide no-such-gap:x --accept --note x >/dev/null 2>&1; rc=$?
expect "accepting a gap that does not exist is refused (exit 2)" '[ $rc = 2 ]'
printf '// @spec todo/ghost-requirement\n' > src/x.js; drift
expect "an orphan marker stays a gap until it is fixed" '[ $rc = 1 ] && gap orphan-anchor:todo/ghost-requirement@src/x.js && grep -q "retarget or remove the marker" "$T/d.json"'
rm src/x.js

echo "== brownfield: legacy requirements without anchors"
mkdir -p .wingman-spec/specs; printf '## Purpose\nLegacy behaviour that predates anchors, written by adopt.\n\n## Requirements\n\n### Requirement: Old thing\nThe system SHALL keep doing the old thing.\n\n#### Scenario: Old\n- **WHEN** x\n- **THEN** y\n\n### Requirement: Older thing\nThe system SHALL keep doing the older thing.\n\n#### Scenario: Older\n- **WHEN** x\n- **THEN** y\n' > .wingman-spec/specs/legacy.md
drift; expect "legacy requirements without anchors are listed as unanchored" '[ $rc = 1 ] && gap unanchored-requirement:legacy/old-thing && gap unanchored-requirement:legacy/older-thing'
$V drift decide --all unanchored-requirement --accept --note "legacy, anchored when touched" >/dev/null; $V drift decide --all untested-requirement --accept --note "legacy" >/dev/null; drift
expect "--all accepts every open gap of one type: one line per requirement, the backlog is cleared" '[ $rc = 0 ] && [ "$(grep -c "^Accepted: legacy, anchored when touched" .wingman-spec/specs/legacy.md)" = 2 ] && [ "$(J "$T/d.json" accepted | grep -o "\"key\"" | wc -l)" = 2 ]'
$V drift decide --all orphan-anchor --accept --note x >/dev/null 2>&1; rc=$?
expect "--all refuses a gap type that cannot be accepted (exit 2)" '[ $rc = 2 ]'

echo "== why: owner approval (a rewritten Why, a removed requirement)"
git add -A; git commit -qm legacy
LIVEWHY='Why: A person wants to keep a list of things to do, so that nothing is forgotten.'
mk2() { # mk2 <why line> [proposal extra line] [spec head]: a second change `edit` that modifies the requirement
  rm -rf .wingman-spec/changes/edit; mkdir -p .wingman-spec/changes/edit/specs/todo
  printf 'Size: S\nRisk: none\n\n## Why\nThe user changed their mind about what the list is for.\n%s\n\n## What Changes\n- Changes the add behaviour.\n\n## Capabilities\n### Modified Capabilities\n- `todo`: add\n\n## ADR candidates\nnone\n\n## Impact\nsrc/\n\n## Edge cases\n- none named\n' "${2:-}" > .wingman-spec/changes/edit/proposal.md
  printf '%s### Requirement: %s\nThe system SHALL append a todo with the given text, at most 80 characters, to the list.\n%s\n\n#### Scenario: Add and see it\n- **WHEN** the user adds "buy milk" and lists the todos\n- **THEN** the list is ["buy milk"]\n\n#### Scenario: Too long\n- **WHEN** the user adds 81 characters\n- **THEN** it is rejected with "too long"\n' "${3:-## MODIFIED

}" "${NAME:-Add a todo}" "$1" > .wingman-spec/changes/edit/specs/todo.md
  printf '## 1. Todo\n- [ ] 1.1 add\n  - Spec: todo/add-a-todo\n  - Test first: x\n  - Files: src/todo.js\n  - Done when: `true` exits 0\n' > .wingman-spec/changes/edit/tasks.md
}
elint() { rc=0; $V lint edit > "$T/lint.json" 2> "$T/lint.err" || rc=$?; }
mk2 "Why: The account owner wants a short list, so that the screen stays readable."; elint
expect "rewriting the Why of a living requirement without approval is an error: OWNER APPROVAL" '[ $rc = 1 ] && lintmsg "OWNER APPROVAL" && lintmsg "todo/add-a-todo"'
expect "lint lists the requirement under why_owner_approval" '[ "$(J "$T/lint.json" why_owner_approval)" = "[\"todo/add-a-todo\"]" ]'
mk2 "Why: The account owner wants a short list, so that the screen stays readable." "Owner approval: Maria, 2026-10-25"; elint
expect "with an Owner approval line the change lints clean, and lint still lists the requirement" '[ $rc = 0 ] && [ "$(J "$T/lint.json" why_owner_approval)" = "[\"todo/add-a-todo\"]" ]'
mk2 "$LIVEWHY"; elint
expect "changed SHALL text and scenarios with the same Why needs no approval" '[ $rc = 0 ] && [ "$(J "$T/lint.json" why_owner_approval)" = "[]" ]'
mk2 "Why: A person wants to keep a list of things to do,  so that nothing is   forgotten."; elint
expect "whitespace-only differences in the Why are not a rewrite" '[ $rc = 0 ]'
RN='## RENAMED
- Add a todo -> Append a todo

## MODIFIED

'
NAME="Append a todo" mk2 "$LIVEWHY" "" "$RN"; elint
expect "renaming a requirement and keeping its Why needs no approval" '[ $rc = 0 ] && [ "$(J "$T/lint.json" why_owner_approval)" = "[]" ]'
NAME="Append a todo" mk2 "Why: The account owner wants a short list, so that the screen stays readable." "" "$RN"; elint
expect "renaming a requirement and rewriting its Why in the same change still needs approval" '[ $rc = 1 ] && lintmsg "OWNER APPROVAL"'
mk2 "$LIVEWHY"; printf '## REMOVED\n\n### Requirement: Add a todo\n**Reason**: the list is replaced\n**Migration**: none\n' > .wingman-spec/changes/edit/specs/todo.md; elint
expect "removing a living requirement without approval is an error" '[ $rc = 1 ] && lintmsg "OWNER APPROVAL" && lintmsg "removes todo/add-a-todo"'
mk2 "$LIVEWHY" "Owner approval: Maria, 2026-10-25"; printf '## REMOVED\n\n### Requirement: Add a todo\n**Reason**: the list is replaced\n**Migration**: none\n' > .wingman-spec/changes/edit/specs/todo.md; elint
expect "removing a living requirement with approval: no approval finding (the size rule for a breaking change is a separate finding)" '! lintmsg "OWNER APPROVAL" && [ "$(J "$T/lint.json" why_owner_approval)" = "[\"todo/add-a-todo\"]" ]'
mk2 "$LIVEWHY"; printf '## REMOVED\n\n### Requirement: Never existed\n**Reason**: x\n**Migration**: none\n' > .wingman-spec/changes/edit/specs/todo.md; elint
expect "removing a requirement that is not in the living specs needs no approval" '! lintmsg "OWNER APPROVAL" && [ "$(J "$T/lint.json" why_owner_approval)" = "[]" ]'
mk2 "Why: The account owner wants a short list, so that the screen stays readable." "Owner approval: Maria, 2026-10-25"
# merge the delta by hand like /spec-sync would, then check the sync
node -e '
const fs=require("fs");const d=fs.readFileSync(".wingman-spec/changes/edit/specs/todo.md","utf8");const l=fs.readFileSync(".wingman-spec/specs/todo.md","utf8");
const blk=d.split("### Requirement: Add a todo")[1];const head=l.split("### Requirement: Append a todo")[0].split("### Requirement: Add a todo")[0];
fs.writeFileSync(".wingman-spec/specs/todo.md",head+"### Requirement: Add a todo"+blk);'
printf '// [todo/add-and-see-it] [todo/too-long]\n' > test/todo.test.js   # the replaced scenarios: the old tags would be stale
rc=0; $V sync edit --check > "$T/s.json" || rc=$?; [ $rc = 0 ] || cat "$T/s.json"
expect "after the merge sync reports synced" '[ $rc = 0 ] && [ "$(J "$T/s.json" synced)" = true ]'
elint
expect "after the merge lint has nothing to compare: the approval check works only before sync (/spec-sync lints first)" '[ "$(J "$T/lint.json" why_owner_approval)" = "[]" ]'

echo "== a requirement retired by the change being synced is not an unsynced archive"
cd "$T" && rm -rf q && mkdir q && cd q && git init -q
ws_init .; ws_cmd test none && ws_cmd typecheck none && ws_cmd lint none && ws_set visual off
mkdir -p .wingman-spec/archive/2026-01-01-a/specs/cap .wingman-spec/changes/b/specs/cap .wingman-spec/specs
printf '## Purpose\nA capability used to test removals.\n\n## ADDED\n\n### Requirement: Foo\nThe system SHALL foo.\nWhy: The owner wants foo to keep working.\n\n#### Scenario: Foo works\n- **WHEN** foo\n- **THEN** foo\n' > .wingman-spec/archive/2026-01-01-a/specs/cap.md
printf '## REMOVED\n\n### Requirement: Foo\n**Reason**: retired\n**Migration**: none\n' > .wingman-spec/changes/b/specs/cap.md
printf '# cap Specification\n\n## Purpose\nA capability used to test removals.\n\n## Requirements\n' > .wingman-spec/specs/cap.md
printf '## 1. x\n- [x] 1.1 x\n' > .wingman-spec/changes/b/tasks.md; printf 'Size: S\nRisk: none\n\n## Why\nx\n\n## What Changes\n- x\n' > .wingman-spec/changes/b/proposal.md
rc=0; $V sync b --check > "$T/q.json" 2>&1 || rc=$?
expect "sync --check of the removing change does not report the removed requirement as unsynced-archive" '! grep -q "unsynced-archive" "$T/q.json"'
rc=0; $V drift > "$T/q2.json" 2>&1 || rc=$?
expect "while the removal is still pending (not archived), plain drift still reports it" 'grep -q "unsynced-archive" "$T/q2.json"'

echo "== marker placement (warn by default; anchor_placement: error | off)"
mk "$REQ"; rm -f src/a.* ; mkdir -p src
printf 'function a() {\n  x(); // @spec todo/add-a-todo\n}\nfunction b() {}\n' > src/p.js
mkdir -p test; printf "// @spec todo/add-a-todo\ntest(\"a\", () => {});\n" > test/todo.test.js
rc=0; $V anchors todo > "$T/a.json" || rc=$?
expect "a trailing marker is a placement warning with file:line, not a failure" '[ $rc = 0 ] && grep -q "marker-placement" "$T/a.json" && grep -q "src/p.js:2: trailing-marker" "$T/a.json" && [ "$(J "$T/a.json" ok)" = true ]'
ws_set anchor_placement error
rc=0; $V anchors todo > "$T/a.json" || rc=$?
expect "anchor_placement: error makes the same finding fail" '[ $rc = 1 ] && grep -q "trailing-marker" "$T/a.json"'
ws_set anchor_placement off
rc=0; $V anchors todo > "$T/a.json" || rc=$?
expect "anchor_placement: off reports nothing" '[ $rc = 0 ] && ! grep -q "marker-placement" "$T/a.json"'
ws_set anchor_placement warn
printf 'function a() {\n  // @spec todo/add-a-todo\n  x();\n}\n' > src/p.js
rc=0; $V anchors todo > "$T/a.json" || rc=$?
expect "a marker directly above the lines it covers is clean" '[ $rc = 0 ] && ! grep -q "marker-placement" "$T/a.json"'
rm -f src/p.js

echo "== output above 64 KB survives a pipe (the commands end with process.exit)"
rm -rf .wingman-spec/changes/b .wingman-spec/specs/cap .wingman-spec/runs src/todo.js; mkdir -p .wingman-spec/specs
{ printf '## Purpose\nMany requirements, so the reports are larger than a pipe buffer.\n\n## Requirements\n\n'; for i in $(seq 1 400); do printf '### Requirement: Requirement number %s with a reasonably long name\nThe system SHALL do thing %s.\n\n#### Scenario: Thing %s\n- **WHEN** it happens\n- **THEN** it is done\n\n' "$i" "$i" "$i"; done; } > .wingman-spec/specs/bulk.md
$V drift --json | cat > "$T/pipe.drift.json"; $V drift --json > "$T/file.drift.json"
expect "drift --json through a pipe is complete: more than 64 KB, byte-identical to the file output, parses" '[ "$(wc -c < "$T/pipe.drift.json")" -gt 70000 ] && cmp -s "$T/pipe.drift.json" "$T/file.drift.json" && [ "$(J "$T/pipe.drift.json" counts.unanchored-requirement)" -ge 400 ]'
$V problems --json | cat > "$T/pipe.problems.json"
expect "problems --json through a pipe parses and lists every gap" '[ "$(wc -c < "$T/pipe.problems.json")" -gt 70000 ] && node -e "JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\"))" "$T/pipe.problems.json"'
$V drift --text | cat > "$T/pipe.drift.txt"; $V drift --text > "$T/file.drift.txt"
expect "drift --text through a pipe is complete (same bytes as the file output)" '[ "$(wc -c < "$T/pipe.drift.txt")" -gt 70000 ] && cmp -s "$T/pipe.drift.txt" "$T/file.drift.txt"'
rm -rf .wingman-spec/specs/bulk

echo "== recorded test results: passed, failed, skipped, not run, stale (spec or code changed)"
mkdir -p "$T/cov" && cd "$T/cov" && ws_project . && V="$WS"
mkdir -p .wingman-spec/specs src test .wingman-spec/changes/clear/specs
cat > .wingman-spec/specs/todo.md <<'SPEC'
## Purpose
Keeps a list of things to do.

## Requirements

### Requirement: Add a todo
The system SHALL append a todo with the given text to the list.
Why: A person wants to keep a list of things to do, so that nothing is forgotten.

#### Scenario: Added
- **WHEN** the user adds "buy milk"
- **THEN** the list is ["buy milk"]

### Requirement: Remove a todo
The system SHALL remove the todo with the given index.
Why: A person wants to drop what is done, so that the list stays short.

#### Scenario: Removed
- **WHEN** the user removes index 0
- **THEN** the list is empty

### Requirement: Count the todos
The system SHALL return the number of todos.
Why: A person wants to see how much is left, so that they can plan the day.

#### Scenario: Counted
- **WHEN** the list has two todos
- **THEN** the count is 2
SPEC
printf '## ADDED\n\n### Requirement: Clear the list\nThe system SHALL remove every todo.\nWhy: A person wants a fresh start, so that old todos do not pile up.\n\n#### Scenario: Cleared\n- **WHEN** the user clears the list\n- **THEN** the list is empty\n' > .wingman-spec/changes/clear/specs/todo.md
printf 'Size: S\nRisk: none\n\n## Why\nA fresh start.\n\n## What Changes\n- Clears the list.\n' > .wingman-spec/changes/clear/proposal.md
printf '## 1. Clear\n- [x] 1.1 clear\n  - Spec: todo/clear-the-list\n  - Files: src/todo.js\n  - Done when: `true` exits 0\n' > .wingman-spec/changes/clear/tasks.md
printf '/**\n * @spec todo/add-a-todo\n */\nexport function add(l, t) {\n  return [...l, t];\n}\n\n/**\n * @spec todo/remove-a-todo\n */\nexport function remove(l, i) {\n  return l.filter((_, j) => j !== i);\n}\n\n/**\n * @spec todo/count-the-todos\n */\nexport function count(l) {\n  return l.length;\n}\n\n/**\n * @spec todo/clear-the-list\n */\nexport function clear() {\n  return [];\n}\n' > src/todo.js
printf "// [todo/added] [todo/removed] [todo/counted] [todo/cleared]\n" > test/todo.test.js
printf 'cat test/out.tap 2>/dev/null; exit 0\n' > run-tests.sh
printf 'ok 1 - [todo/added] adds\nnot ok 2 - [todo/removed] removes\nok 3 - [todo/cleared] clears # SKIP later\n' > test/out.tap
ws_cmd test "sh run-tests.sh"
git add -A && git commit -qm init
R=.wingman-spec/cache/test-results.json
rc=0; $V finish clear > "$T/f.json" 2>/dev/null || rc=$?
expect "finish fails on the failing and the skipped test, and records every result it saw" '[ $rc = 1 ] && [ -f "$R" ] && [ "$(J "$R" requirements.todo/add-a-todo.scenarios.todo/added)" = passed ] && [ "$(J "$R" requirements.todo/remove-a-todo.scenarios.todo/removed)" = failed ] && [ "$(J "$R" requirements.todo/clear-the-list.scenarios.todo/cleared)" = skipped ]'
expect "the record carries the commit and the tree, and a scenario the output does not name is not recorded" '[ -n "$(J "$R" requirements.todo/add-a-todo.commit)" ] && [ -n "$(J "$R" requirements.todo/add-a-todo.tree)" ] && [ "$(J "$R" requirements.todo/count-the-todos)" = undefined ]'
expect "the results are derived data: git ignores them" 'git check-ignore -q "$R"'
rc=0; $V anchors clear --json > "$T/a.json" || true
expect "anchors --json shows each requirement's state (the change's own requirement: skipped)" '[ "$(J "$T/a.json" requirements.todo/clear-the-list.coverage.state)" = skipped ] && [ "$(J "$T/a.json" coverage.results)" = "$R" ]'
$V anchors --json > "$T/a.json" 2>/dev/null || true
expect "...living ones: passed, failed, not run" '[ "$(J "$T/a.json" requirements.todo/add-a-todo.coverage.state)" = passed ] && [ "$(J "$T/a.json" requirements.todo/remove-a-todo.coverage.state)" = failed ] && [ "$(J "$T/a.json" "requirements.todo/count-the-todos.coverage.state")" = "not run" ]'
rc=0; $V drift > "$T/d.json" 2>/dev/null || rc=$?
expect "drift lists the failing test as an advisory failing-test gap (drift does not fail on it)" '[ "$(J "$T/d.json" advisory.0.key)" = failing-test:todo/remove-a-todo ] && ! J "$T/d.json" open | grep -q failing-test && grep -q "\[todo/removed\]" "$T/d.json" && [ "$(J "$T/d.json" coverage.counts.failed)" = 1 ]'
$V drift --text > "$T/d.txt" 2>/dev/null || true
expect "drift --text counts the states" 'grep -q "tests: 1 passed, 1 failed, 1 not run" "$T/d.txt"'
sed -i 's#  return \[...l, t\];#  // keep the order\n  return [...l, t];#' src/todo.js; $V drift > "$T/d.json" 2>/dev/null || true
expect "a comment added to the anchored code: the result stays current" '! grep -q "stale-test-result" "$T/d.json"'
sed -i 's#  return \[...l, t\];#  return l.concat([t]);#' src/todo.js; $V drift > "$T/d.json" 2>/dev/null || true
expect "the anchored code changed: stale (code changed), advisory info" 'grep -q "stale-test-result:todo/add-a-todo" "$T/d.json" && grep -q "the code changed since" "$T/d.json" && [ "$(J "$T/d.json" "coverage.counts.stale: code changed")" = 1 ]'
sed -i 's/SHALL remove the todo with the given index./SHALL remove the todo at the given index./' .wingman-spec/specs/todo.md; $V drift > "$T/d.json" 2>/dev/null || true
expect "the requirement text changed: stale (spec changed)" 'grep -q "stale-test-result:todo/remove-a-todo" "$T/d.json" && grep -q "the spec changed since" "$T/d.json"'
$V problems --json > "$T/p.json" 2>/dev/null || true
expect "problems --json carries the recorded states for the editor, and the failing-test finding sits on the requirement" '[ "$(J "$T/p.json" coverage.todo/add-a-todo.reason)" = "code changed" ] && [ "$(J "$T/p.json" "coverage.todo/count-the-todos")" = undefined ]'
printf 'ok 1 - [todo/added] adds\nok 2 - [todo/removed] removes\nok 3 - [todo/cleared] clears\nok 4 - [todo/counted] counts\n' > test/out.tap
rm -rf .wingman-spec/runs; rc=0; WINGMAN_SPEC_TRACEABILITY=off $V finish clear > "$T/f.json" 2>/dev/null || rc=$?
expect "with traceability off finish still records the results: all passed now, nothing stale" '[ "$(J "$R" requirements.todo/count-the-todos.scenarios.todo/counted)" = passed ] && { $V drift > "$T/d.json" 2>/dev/null; true; } && ! grep -q "stale-test-result\|failing-test" "$T/d.json" && [ "$(J "$T/d.json" coverage.counts.passed)" = 3 ]'
: > test/out.tap
printf '<testsuites><testsuite name="todo"><testcase classname="todo" name="[todo/counted] counts"><failure message="x"/></testcase></testsuite></testsuites>\n' > report.xml
ws_cmd junit report.xml; printf 'touch report.xml; exit 0\n' >> run-tests.sh
rm -rf .wingman-spec/runs; WINGMAN_SPEC_TRACEABILITY=off $V finish clear > "$T/f.json" 2>/dev/null || true
expect "a JUnit report (commands.junit) is read too: a failing testcase is recorded as failed" '[ "$(J "$R" requirements.todo/count-the-todos.scenarios.todo/counted)" = failed ] && [ "$(J "$R" requirements.todo/add-a-todo.scenarios.todo/added)" = passed ]'

echo "== finish --affected: only the tests of the requirements the change touches"
mkdir -p "$T/aff" && cd "$T/aff" && ws_project . && V="$WS"
mkdir -p src test && cp -r "$T/cov/.wingman-spec/specs" "$T/cov/.wingman-spec/changes" .wingman-spec/ && cp "$T/cov/src/todo.js" src/
for t in added:add removed:remove counted:count cleared:clear; do printf '// [todo/%s]\n' "${t%%:*}" > "test/${t#*:}.test.js"; done
printf '[ $# -gt 0 ] || set -- test/*.test.js\nfor f in "$@"; do echo "ok - $(cat "$f")"; echo "$f" >> ran.txt; done\n' > run-tests.sh
ws_cmd test "sh run-tests.sh"; ws_cmd targeted "sh run-tests.sh {files}"
git add -A && git commit -qm init
sed -i 's#  return l.filter((_, j) => j !== i);#  return l.slice(0, i).concat(l.slice(i + 1));#' src/todo.js
rm -f ran.txt; rc=0; $V finish clear --affected > "$T/f.json" 2>/dev/null || rc=$?
expect "finish --affected runs the tests of the change's own requirement and of the one whose anchored code changed, nothing else" '[ $rc = 0 ] && [ "$(sort ran.txt | tr "\n" " ")" = "test/clear.test.js test/remove.test.js " ]'
expect "...names the files and the requirements in the tests check, and warns that unmarked code is not followed" 'grep -q "\"requirements\": \[" "$T/f.json" && grep -q "todo/remove-a-todo" "$T/f.json" && grep -q "a test of changed code that carries no marker" "$T/f.json"'
expect "...and records only what ran" '[ "$(J .wingman-spec/cache/test-results.json requirements.todo/remove-a-todo.scenarios.todo/removed)" = passed ] && [ "$(J .wingman-spec/cache/test-results.json requirements.todo/add-a-todo)" = undefined ]'
rm -f ran.txt .wingman-spec/runs -r; $V finish clear > /dev/null 2>&1 || true
expect "plain finish still runs the full suite" '[ "$(wc -l < ran.txt)" = 4 ]'

echo "== a RENAMED entry rewrites the @spec markers (next)"
mkdir -p "$T/ren" && cd "$T/ren" && ws_project . && V="$WS"
mkdir -p src test .wingman-spec/changes/rename/specs && cp -r "$T/cov/.wingman-spec/specs" .wingman-spec/ && cp "$T/cov/src/todo.js" src/
printf '/** @spec todo/remove-a-todo */\nit("[todo/removed] removes", () => {});\n// @spec todo/remove-a-todo-twice is another key\n' > test/remove.test.js
printf '## RENAMED\n\n- Remove a todo -> Delete a todo\n' > .wingman-spec/changes/rename/specs/todo.md
printf 'Size: S\nRisk: none\n\n## Why\nA clearer name.\n\n## What Changes\n- Renames a requirement.\n' > .wingman-spec/changes/rename/proposal.md
printf '## 1. Rename\n- [ ] 1.1 rename\n  - Spec: todo/delete-a-todo\n  - Files: src/todo.js\n  - Done when: `true` exits 0\n' > .wingman-spec/changes/rename/tasks.md
ws_cmd test "true"; git add -A && git commit -qm init
rc=0; $V next rename > "$T/n.json" 2>"$T/n.err" || rc=$?
expect "next rewrites the old key in code and test markers and lists each rewrite" 'grep -q "@spec todo/delete-a-todo" src/todo.js && ! grep -q "todo/remove-a-todo$" src/todo.js && grep -q "^/\*\* @spec todo/delete-a-todo \*/" test/remove.test.js && [ "$(J "$T/n.json" renamed_markers.length)" = 2 ] && grep -q "renamed: src/todo.js" "$T/n.err"'
expect "...leaves a longer key and the scenario tags alone" 'grep -q "todo/remove-a-todo-twice" test/remove.test.js && grep -q "\[todo/removed\]" test/remove.test.js'
$V next rename > "$T/n.json" 2>/dev/null || true
expect "...and is idempotent: a second next rewrites nothing" '[ "$(J "$T/n.json" renamed_markers)" = undefined ]'

echo "== lint warns when two active changes change the same requirement"
mkdir -p .wingman-spec/changes/tidy/specs
printf '## MODIFIED\n\n### Requirement: Remove a todo\nThe system SHALL remove the todo at the given index and keep the order.\nWhy: A person wants to drop what is done, so that the list stays short.\n\n#### Scenario: Removed\n- **WHEN** the user removes index 0\n- **THEN** the list is empty\n' > .wingman-spec/changes/tidy/specs/todo.md
printf 'Size: S\nRisk: none\n\n## Why\nKeep the order.\n\n## What Changes\n- Keeps the order.\n' > .wingman-spec/changes/tidy/proposal.md
cp .wingman-spec/changes/rename/tasks.md .wingman-spec/changes/tidy/tasks.md
rc=0; $V lint tidy > "$T/l.json" 2>/dev/null || rc=$?
expect "lint of one change warns (not fails) on the requirement the other active change renames" 'grep -q "MODIFIED todo/remove-a-todo, which the active change \\\\\"rename\\\\\" also changes (RENAMED)" "$T/l.json" && grep -q "\"kind\": \"overlap\"" "$T/l.json" && ! grep -B3 "\"kind\": \"overlap\"" "$T/l.json" | grep -q "\"severity\": \"error\""'
$V lint rename > "$T/l.json" 2>/dev/null || true
expect "...and the other one, at its RENAMED line" 'grep -q "specs/todo.md:3: RENAMED todo/remove-a-todo" "$T/l.json"'
rm -rf .wingman-spec/changes/tidy

echo "== stable requirement IDs: assigned by lint --fix, kept, never reused; markers may name them"
mkdir -p "$T/ids" && cd "$T/ids" && ws_project . && V="$WS"
mkdir -p src .wingman-spec/changes/more/specs .wingman-spec/archive/2026-01-01-0000-old/specs && cp -r "$T/cov/.wingman-spec/specs" .wingman-spec/
sed -i 's/^The system SHALL remove the todo at the given index.$/&\nID: TODO-AB2C/' .wingman-spec/specs/todo.md
printf '## REMOVED\n\n### Requirement: Old thing\nID: TODO-ZZZ9\n**Reason**: gone\n' > .wingman-spec/archive/2026-01-01-0000-old/specs/todo.md
printf '## ADDED\n\n### Requirement: Clear the list\nThe system SHALL remove every todo.\nWhy: A person wants a fresh start, so that old todos do not pile up.\n\n#### Scenario: Cleared\n- **WHEN** the user clears the list\n- **THEN** the list is empty\n\n## MODIFIED\n\n### Requirement: Remove a todo\nThe system SHALL remove the todo at the given index and keep the order.\nWhy: A person wants to drop what is done, so that the list stays short.\n\n#### Scenario: Removed\n- **WHEN** the user removes index 0\n- **THEN** the list is empty\n' > .wingman-spec/changes/more/specs/todo.md
printf 'Size: S\nRisk: none\n\n## Why\nMore.\n\n## What Changes\n- More.\n\n## Edge cases\n- none named\n' > .wingman-spec/changes/more/proposal.md
printf '## 1. More\n- [ ] 1.1 more\n  - Spec: todo/clear-the-list\n  - Files: src/todo.js\n  - Done when: `true` exits 0\n' > .wingman-spec/changes/more/tasks.md
D=.wingman-spec/changes/more/specs/todo.md
$V lint more --text > "$T/l.txt" 2>&1 || true
expect "a MODIFIED requirement must keep its living ID" 'grep -q "its living ID is TODO-AB2C and an ID never changes: keep the line .ID: TODO-AB2C." "$T/l.txt"'
$V lint more --fix --text > "$T/l.txt" 2>&1 || true
expect "lint --fix gives the ADDED requirement a new random ID (capability prefix, no 0/O/1/I) and the MODIFIED one its living ID" 'grep -Eq "^ID: TODO-[A-HJ-NP-Z2-9]{4}$" "$D" && [ "$(grep -c "^ID: " "$D")" = 2 ] && grep -q "^ID: TODO-AB2C$" "$D" && ! grep -q "requirement-id\|living ID" "$T/l.txt"'
NEW=$(grep -Eo "TODO-[A-Z2-9]{4}" "$D" | grep -v AB2C)
expect "...placed under the Why line, before the first scenario, outside the requirement text" 'grep -A1 "^Why: A person wants a fresh start" "$D" | grep -q "^ID: $NEW" && $V lint more --fix > /dev/null 2>&1; [ "$(grep -c "^ID: " "$D")" = 2 ]'
sed -i "s/^ID: $NEW$/ID: todo-zzz9/" "$D"; $V lint more --text > "$T/l.txt" 2>&1 || true
expect "lint prints the canonical form of a lower-case ID" 'grep -q "write the ID as TODO-ZZZ9" "$T/l.txt"'
sed -i "s/^ID: todo-zzz9$/ID: TODO-ZZZ9/" "$D"; $V lint more --text > "$T/l.txt" 2>&1 || true
expect "a retired ID (an archived REMOVED entry recorded it) is never reused" 'grep -q "ID TODO-ZZZ9 is retired" "$T/l.txt"'
sed -i "s/^ID: TODO-ZZZ9$/ID: TODO-AB2C/" "$D"; $V lint more --text > "$T/l.txt" 2>&1 || true
expect "...nor one a living requirement holds" 'grep -q "ID TODO-AB2C is already todo/remove-a-todo.s" "$T/l.txt"'
sed -i "0,/^ID: TODO-AB2C$/s//ID: LIST-ABCD/" "$D"; $V lint more --text > "$T/l.txt" 2>&1 || true
expect "a new ID starts with the capability folder name" 'grep -q "a new ID starts with TODO-" "$T/l.txt"'
sed -i "s/^ID: LIST-ABCD$/ID: $NEW/" "$D"
printf '// @spec todo-ab2c\nexport function remove() {}\n// @spec TODO-WXYZ\nexport function gone() {}\n' > src/ids.js
$V anchors --json > "$T/a.json" 2>/dev/null || true
expect "a marker may name the requirement by its ID, in any case; an unknown ID is an orphan marker" 'J "$T/a.json" requirements.todo/remove-a-todo | grep -q "src/ids.js" && grep -q "TODO-WXYZ" "$T/a.json" && ! J "$T/a.json" requirements.todo/remove-a-todo | grep -q "TODO-WXYZ"'
printf '## RENAMED\n\n- Remove a todo -> Delete a todo\n' > .wingman-spec/changes/more/specs/todo.md
$V anchors more --json > "$T/a.json" 2>/dev/null || true
expect "...and follows a rename: no rewrite needed" 'J "$T/a.json" index.requirements.todo/delete-a-todo | grep -q "src/ids.js"'
rm -rf .wingman-spec/changes/more
sed -i 's/^The system SHALL return the number of todos.$/&\nID: TODO-AB2C/' .wingman-spec/specs/todo.md
$V drift > "$T/d.json" 2>/dev/null || true
expect "two living requirements with one ID: a duplicate-id drift gap" 'grep -q "duplicate-id:TODO-AB2C" "$T/d.json" && grep -q "todo/count-the-todos, todo/remove-a-todo\|todo/remove-a-todo, todo/count-the-todos" "$T/d.json"'
cd "$T/p" || exit 1

echo
echo "traceability: passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
