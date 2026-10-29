#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# The Why on each requirement, code anchors, drift, sync-before-archive: contract tests for openspec/scripts/verify-task.cjs
# (traceability.cjs), including seeded drift. Usage: tests/traceability.sh (needs openspec and node). Exit 0 when all pass.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
unset SPEC_TRACEABILITY
export OPENSPEC_TELEMETRY=0 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }
J() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));let v=j;for(const k of process.argv[2].split(".").filter(Boolean))v=v==null?v:v[k];console.log(typeof v==="object"?JSON.stringify(v):String(v))' "$1" "$2"; }

cd "$T" && mkdir p && cd p && git init -q
openspec init --tools none >/dev/null 2>&1 || mkdir -p openspec/changes openspec/specs
"$PKG/install.sh" . --harness all >/dev/null || { echo "install failed"; exit 1; }
sed -i 's/Test command: <fill in>/Test command: none/;s/Typecheck command: <fill in>/Typecheck command: none/;s/Lint command: <fill in>/Lint command: none/;s/^visual:.*/visual: off/;/^  command: <fill in>/d;/^  url: <fill in>/d' openspec/config.yaml
V="node openspec/scripts/verify-task.cjs"; C=openspec/changes/todo
git add -A && git commit -qm init

echo "== install"
expect "traceability.cjs is installed and the template config turns traceability on" '[ -f openspec/scripts/traceability.cjs ] && grep -q "^traceability: on" openspec/config.yaml'
expect "config.yaml (rules are plain strings) still parses: openspec instructions works" 'openspec instructions proposal --change nope >/dev/null 2>&1; true'
for h in .cursor/commands .claude/commands .agents/skills; do
  f="$h/spec-garden.md"; [ "$h" = .agents/skills ] && f=".agents/skills/spec-garden/SKILL.md"
  expect "spec-garden is installed for $h" 'grep -q "drift decide" "$f"'
  f="$h/spec-archive.md"; [ "$h" = .agents/skills ] && f=".agents/skills/spec-archive/SKILL.md"
  expect "spec-archive runs /spec-sync first and archives through the script ($h)" 'grep -q "Always sync first" "$f" && grep -q "verify-task.cjs archive" "$f"'
done

mk() { # mk <spec requirement block(s)>: writes change todo
  rm -rf "$C" openspec/.apply-runs; mkdir -p "$C/specs/todo"
  printf 'Size: S\nRisk: none\n\n## Why\nPeople lose track of what they have to do, so they need a list.\n\n## What Changes\n- Adds a todo list.\n\n## Capabilities\n### New Capabilities\n- `todo`: keep a list\n\n## ADR candidates\nnone\n\n## Impact\nsrc/\n\n## Edge cases\n- none named\n' > "$C/proposal.md"
  printf '## Purpose\nKeeps a list of things to do for one person, in order of entry.\n\n## ADDED Requirements\n\n%s\n' "$1" > "$C/specs/todo/spec.md"
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
expect "openspec validate --strict accepts Why lines" 'openspec validate todo --strict >/dev/null 2>&1'
mk "${REQ/Why: A person wants to keep a list of things to do, so that nothing is forgotten./}"; lint
expect "a requirement without a Why line is an error that shows the format" '[ $rc = 1 ] && lintmsg "Why:" && lintmsg "Add a todo"'
mk "${REQ/Why: A person wants to keep a list of things to do, so that nothing is forgotten./Why: a list}"; lint
expect "a Why under 5 words is an error (it names no one and no reason)" '[ $rc = 1 ] && lintmsg "too short"'
mk "${REQ/Why: A person wants to keep a list of things to do, so that nothing is forgotten./Why: }"; lint
expect "an empty Why line (the quick fix placeholder) is still an error" '[ $rc = 1 ] && lintmsg "too short"'
mk "${REQ/Why: A person wants to keep a list of things to do, so that nothing is forgotten./}"; SPEC_TRACEABILITY=warn lint
expect "traceability warn: the same finding is a warning (exit 0)" '[ $rc = 0 ] && lintmsg "Why:"'
SPEC_TRACEABILITY=off lint
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
expect "a code marker + tagged tests satisfy code and test anchors; the derived index is printed, nothing is written" '[ $rc = 0 ] && [ ! -e openspec/anchors.json ] && [ "$(J "$T/a.json" index.requirements)" != "{}" ]'
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
rm -rf openspec/.apply-runs; $V next todo >/dev/null 2>&1; rc=$?
expect "next reports every task done (exit 10)" '[ $rc = 10 ]'
printf '%s\n' '// no marker' > src/todo.js
rc=0; $V finish todo > "$T/f.json" 2>/dev/null || rc=$?
expect "finish fails a requirement without a code anchor (exit 1)" '[ $rc = 1 ] && grep -q "code anchors" "$T/f.json"'
rm -rf openspec/.apply-runs
printf '// @spec todo/add-a-todo\nexports.add = () => 0;\n' > src/todo.js
rc=0; $V finish todo > "$T/f.json" 2>/dev/null || rc=$?
expect "finish passes with anchors and tells the user to run /spec-archive (it syncs first), not to sync by hand" '[ $rc = 0 ] && [ "$(J "$T/f.json" result)" = finished ] && grep -q "Run /spec-archive todo; it syncs first" "$T/f.json" && ! grep -qi "mandatory" "$T/f.json"'
printf '// @spec todo/ghost\n' > src/g.js; rm -rf openspec/.apply-runs
rc=0; $V finish todo > "$T/f.json" 2>/dev/null || rc=$?
expect "finish fails an unresolved marker" '[ $rc = 1 ]'
rm -f src/g.js; rm -rf openspec/.apply-runs

echo "== sync before archive"
rc=0; $V archive todo > "$T/ar.json" 2> "$T/ar.err" || rc=$?
expect "archive refuses an unsynced change (exit 1, NOT SYNCED) and leaves it in place" '[ $rc = 1 ] && grep -q "NOT SYNCED" "$T/ar.err" && [ -d "$C" ]'
SPEC_TRACEABILITY=off $V archive todo >/dev/null 2>"$T/ar.err"; rc=$?
expect "the refusal also holds with traceability off (specs are not merged)" '[ $rc = 1 ] && [ -d "$C" ]'
mkdir -p openspec/specs/todo; sed 's/^## ADDED Requirements/## Requirements/' "$C/specs/todo/spec.md" > openspec/specs/todo/spec.md
rc=0; $V sync-check todo > "$T/sc.json" || rc=$?
expect "specs merged and nothing else to do: sync-check says synced" '[ $rc = 0 ]'
rc=0; $V sync todo > "$T/s.json" || rc=$?
expect "sync is the same read-only check: synced, and it writes no intents folder or index" '[ $rc = 0 ] && [ "$(J "$T/s.json" synced)" = true ] && [ ! -e openspec/intents ] && [ ! -e openspec/anchors.json ]'
expect "the merged living specs still validate and keep the Why line" 'openspec validate --specs --strict >/dev/null 2>&1 && grep -q "^Why: A person wants" openspec/specs/todo/spec.md'
rc=0; $V intents todo >/dev/null 2>&1 || rc=$?
expect "there is no intents command any more (exit 2)" '[ $rc = 2 ]'
mkdir -p "$C/adrs"; printf -- '---\ntitle: Use a list\nstatus: Accepted\ndate: 2026-10-25\nchange: todo\n---\nWe keep an array.\n' > "$C/adrs/use-a-list.md"
printf 'No decision here.\n' > "$C/adrs/none.md"; printf -- '---\ntitle: Skip\nstatus: None\ndate: 2026-10-25\n---\nNothing.\n' > "$C/adrs/skip.md"
rc=0; $V archive todo > "$T/ar.json" 2> "$T/ar.err" || rc=$?
expect "archive refuses while an ADR is not promoted" '[ $rc = 1 ] && grep -q "NOT PROMOTED" "$T/ar.err" && [ -d "$C" ]'
expect "a none record is never counted: by file name (none.md) or by status (None), only the real ADR is named" '[ $(grep -c "NOT PROMOTED" "$T/ar.err") = 1 ] && grep -q "use-a-list.md: NOT PROMOTED" "$T/ar.err" && ! grep -q "none.md\|skip.md" "$T/ar.err"'
mkdir -p adr; printf -- '---\ntitle: Use a list\nstatus: Accepted\ndate: 2026-10-25\nchange: todo\nsource: todo/use-a-list\n---\nWe keep an array.\n' > adr/0001-use-a-list.md
rc=0; $V archive todo > "$T/ar.json" 2> "$T/ar.err" || rc=$?
expect "archive succeeds once synced, through the script" '[ $rc = 0 ] && [ "$(J "$T/ar.json" result)" = archived ] && [ ! -d "$C" ] && ls openspec/changes/archive | grep -q todo'
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
sed -i 's/### Requirement: Add a todo/### Requirement: Append a todo/' openspec/specs/todo/spec.md; drift
expect "seed 3, requirement renamed: orphan anchor (with a rename hint) + new requirement unanchored" '[ $rc = 1 ] && gap orphan-anchor:todo/add-a-todo@src/todo.js && gap unanchored-requirement:todo/append-a-todo && grep -q "append-a-todo" "$T/d.json"'
git checkout -q openspec/specs
printf '// @spec todo/ghost-requirement\n' > src/x.js; drift
expect "seed 4, orphan marker: orphan-anchor" '[ $rc = 1 ] && gap orphan-anchor:todo/ghost-requirement@src/x.js'
rm src/x.js
printf '// [todo/no-such-scenario]\n' >> test/todo.test.js; drift
expect "seed 5, stale test tag: stale-test-tag" '[ $rc = 1 ] && gap stale-test-tag:todo/no-such-scenario'
git checkout -q test
printf '' > test/todo.test.js; drift
expect "seed 6, tests lost their tags: untested requirement" '[ $rc = 1 ] && gap untested-requirement:todo/add-a-todo'
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
cp openspec/specs/todo/spec.md "$T/spec.before"
$V drift decide unanchored-requirement:todo/add-a-todo --accept --note "kept: the code moved to a service we do not own" > "$T/dd.json"; drift
expect "accept: the gap is no longer open (exit 0) and is listed as accepted with its reason" '[ $rc = 0 ] && [ "$(J "$T/d.json" accepted.0.key)" = unanchored-requirement:todo/add-a-todo ] && grep -q "service we do not own" "$T/d.json"'
expect "accept: exactly one line was added to the living spec, below the SHALL line and above the first scenario, and nothing else" '[ "$(diff "$T/spec.before" openspec/specs/todo/spec.md | grep -c "^[<>]")" = 1 ] && grep -q "^Accepted: kept: the code moved" openspec/specs/todo/spec.md && [ "$(grep -n "^Accepted:" openspec/specs/todo/spec.md | cut -d: -f1)" -lt "$(grep -n "#### Scenario" openspec/specs/todo/spec.md | head -1 | cut -d: -f1)" ]'
expect "accept writes no other file (only the spec and the code under test differ)" '[ "$(git status --porcelain | grep -vc "src/todo.js")" = 1 ]'
cp openspec/specs/todo/spec.md "$T/spec.once"; $V drift decide unanchored-requirement:todo/add-a-todo --accept --note "kept: the code moved to a service we do not own" >/dev/null
expect "accepting again with the same reason is a no-op (idempotent)" 'cmp openspec/specs/todo/spec.md "$T/spec.once"'
$V drift decide unanchored-requirement:todo/add-a-todo --accept --note "new reason" >/dev/null
expect "accepting again with a new reason replaces the one line" '[ "$(grep -c "^Accepted:" openspec/specs/todo/spec.md)" = 1 ] && grep -q "^Accepted: new reason" openspec/specs/todo/spec.md'
expect "the Accepted line is not part of the requirement text (sync compares the text)" 'node -e "const T=require(\"./openspec/scripts/traceability.cjs\");const r=T.livingRequirements(process.cwd()).get(\"todo/add-a-todo\");process.exit(r.accepted===\"new reason\"&&!/Accepted/.test(r.block)?0:1)"'
expect "the living spec still validates with the Accepted line" 'openspec validate --specs --strict >/dev/null 2>&1'
$V drift --text > "$T/dt.txt"; expect "drift --text lists it as accepted" 'grep -q "accepted unanchored-requirement:todo/add-a-todo  (new reason)" "$T/dt.txt"'
git checkout -q src/todo.js openspec/specs
$V drift decide no-such-gap:x --accept --note x >/dev/null 2>&1; rc=$?
expect "accepting a gap that does not exist is refused (exit 2)" '[ $rc = 2 ]'
printf '// @spec todo/ghost-requirement\n' > src/x.js; drift
expect "an orphan marker stays a gap until it is fixed" '[ $rc = 1 ] && gap orphan-anchor:todo/ghost-requirement@src/x.js && grep -q "retarget or remove the marker" "$T/d.json"'
rm src/x.js

echo "== brownfield: legacy requirements without anchors"
mkdir -p openspec/specs/legacy; printf '## Purpose\nLegacy behaviour that predates anchors, written by adopt.\n\n## Requirements\n\n### Requirement: Old thing\nThe system SHALL keep doing the old thing.\n\n#### Scenario: Old\n- **WHEN** x\n- **THEN** y\n\n### Requirement: Older thing\nThe system SHALL keep doing the older thing.\n\n#### Scenario: Older\n- **WHEN** x\n- **THEN** y\n' > openspec/specs/legacy/spec.md
drift; expect "legacy requirements without anchors are listed as unanchored" '[ $rc = 1 ] && gap unanchored-requirement:legacy/old-thing && gap unanchored-requirement:legacy/older-thing'
$V drift decide --all unanchored-requirement --accept --note "legacy, anchored when touched" >/dev/null; $V drift decide --all untested-requirement --accept --note "legacy" >/dev/null; drift
expect "--all accepts every open gap of one type: one line per requirement, the backlog is cleared" '[ $rc = 0 ] && [ "$(grep -c "^Accepted: legacy, anchored when touched" openspec/specs/legacy/spec.md)" = 2 ] && [ "$(J "$T/d.json" accepted | grep -o "\"key\"" | wc -l)" = 2 ]'
$V drift decide --all orphan-anchor --accept --note x >/dev/null 2>&1; rc=$?
expect "--all refuses a gap type that cannot be accepted (exit 2)" '[ $rc = 2 ]'

echo "== why: owner approval (a rewritten Why, a removed requirement)"
git add -A; git commit -qm legacy
LIVEWHY='Why: A person wants to keep a list of things to do, so that nothing is forgotten.'
mk2() { # mk2 <why line> [proposal extra line] [spec head]: a second change `edit` that modifies the requirement
  rm -rf openspec/changes/edit; mkdir -p openspec/changes/edit/specs/todo
  printf 'Size: S\nRisk: none\n\n## Why\nThe user changed their mind about what the list is for.\n%s\n\n## What Changes\n- Changes the add behaviour.\n\n## Capabilities\n### Modified Capabilities\n- `todo`: add\n\n## ADR candidates\nnone\n\n## Impact\nsrc/\n\n## Edge cases\n- none named\n' "${2:-}" > openspec/changes/edit/proposal.md
  printf '%s### Requirement: %s\nThe system SHALL append a todo with the given text, at most 80 characters, to the list.\n%s\n\n#### Scenario: Add and see it\n- **WHEN** the user adds "buy milk" and lists the todos\n- **THEN** the list is ["buy milk"]\n\n#### Scenario: Too long\n- **WHEN** the user adds 81 characters\n- **THEN** it is rejected with "too long"\n' "${3:-## MODIFIED Requirements

}" "${NAME:-Add a todo}" "$1" > openspec/changes/edit/specs/todo/spec.md
  printf '## 1. Todo\n- [ ] 1.1 add\n  - Spec: todo/add-a-todo\n  - Test first: x\n  - Files: src/todo.js\n  - Done when: `true` exits 0\n' > openspec/changes/edit/tasks.md
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
RN='## RENAMED Requirements
- FROM: `### Requirement: Add a todo`
- TO: `### Requirement: Append a todo`

## MODIFIED Requirements

'
NAME="Append a todo" mk2 "$LIVEWHY" "" "$RN"; elint
expect "renaming a requirement and keeping its Why needs no approval" '[ $rc = 0 ] && [ "$(J "$T/lint.json" why_owner_approval)" = "[]" ]'
NAME="Append a todo" mk2 "Why: The account owner wants a short list, so that the screen stays readable." "" "$RN"; elint
expect "renaming a requirement and rewriting its Why in the same change still needs approval" '[ $rc = 1 ] && lintmsg "OWNER APPROVAL"'
mk2 "$LIVEWHY"; printf '## REMOVED Requirements\n\n### Requirement: Add a todo\n**Reason**: the list is replaced\n**Migration**: none\n' > openspec/changes/edit/specs/todo/spec.md; elint
expect "removing a living requirement without approval is an error" '[ $rc = 1 ] && lintmsg "OWNER APPROVAL" && lintmsg "removes todo/add-a-todo"'
mk2 "$LIVEWHY" "Owner approval: Maria, 2026-10-25"; printf '## REMOVED Requirements\n\n### Requirement: Add a todo\n**Reason**: the list is replaced\n**Migration**: none\n' > openspec/changes/edit/specs/todo/spec.md; elint
expect "removing a living requirement with approval: no approval finding (the size rule for a breaking change is a separate finding)" '! lintmsg "OWNER APPROVAL" && [ "$(J "$T/lint.json" why_owner_approval)" = "[\"todo/add-a-todo\"]" ]'
mk2 "$LIVEWHY"; printf '## REMOVED Requirements\n\n### Requirement: Never existed\n**Reason**: x\n**Migration**: none\n' > openspec/changes/edit/specs/todo/spec.md; elint
expect "removing a requirement that is not in the living specs needs no approval" '! lintmsg "OWNER APPROVAL" && [ "$(J "$T/lint.json" why_owner_approval)" = "[]" ]'
mk2 "Why: The account owner wants a short list, so that the screen stays readable." "Owner approval: Maria, 2026-10-25"
# merge the delta by hand like /spec-sync would, then check the sync
node -e '
const fs=require("fs");const d=fs.readFileSync("openspec/changes/edit/specs/todo/spec.md","utf8");const l=fs.readFileSync("openspec/specs/todo/spec.md","utf8");
const blk=d.split("### Requirement: Add a todo")[1];const head=l.split("### Requirement: Append a todo")[0].split("### Requirement: Add a todo")[0];
fs.writeFileSync("openspec/specs/todo/spec.md",head+"### Requirement: Add a todo"+blk);'
printf '// [todo/add-and-see-it] [todo/too-long]\n' > test/todo.test.js   # the replaced scenarios: the old tags would be stale
rc=0; $V sync edit > "$T/s.json" || rc=$?; [ $rc = 0 ] || cat "$T/s.json"
expect "after the merge sync reports synced" '[ $rc = 0 ] && [ "$(J "$T/s.json" synced)" = true ]'
elint
expect "after the merge lint has nothing to compare: the approval check works only before sync (/spec-sync lints first)" '[ "$(J "$T/lint.json" why_owner_approval)" = "[]" ]'

echo "== a requirement retired by the change being synced is not an unsynced archive"
cd "$T" && rm -rf q && mkdir q && cd q && git init -q
mkdir -p openspec/changes/archive/2026-01-01-a/specs/cap openspec/changes/b/specs/cap openspec/specs/cap
"$PKG/install.sh" . --harness cursor >/dev/null
printf '## Purpose\nA capability used to test removals.\n\n## ADDED Requirements\n\n### Requirement: Foo\nThe system SHALL foo.\nWhy: The owner wants foo to keep working.\n\n#### Scenario: Foo works\n- **WHEN** foo\n- **THEN** foo\n' > openspec/changes/archive/2026-01-01-a/specs/cap/spec.md
printf '## REMOVED Requirements\n\n### Requirement: Foo\n**Reason**: retired\n**Migration**: none\n' > openspec/changes/b/specs/cap/spec.md
printf '# cap Specification\n\n## Purpose\nA capability used to test removals.\n\n## Requirements\n' > openspec/specs/cap/spec.md
printf '## 1. x\n- [x] 1.1 x\n' > openspec/changes/b/tasks.md; printf 'Size: S\nRisk: none\n\n## Why\nx\n\n## What Changes\n- x\n' > openspec/changes/b/proposal.md
rc=0; $V sync-check b > "$T/q.json" 2>&1 || rc=$?
expect "sync-check of the removing change does not report the removed requirement as unsynced-archive" '! grep -q "unsynced-archive" "$T/q.json"'
rc=0; $V drift > "$T/q2.json" 2>&1 || rc=$?
expect "while the removal is still pending (not archived), plain drift still reports it" 'grep -q "unsynced-archive" "$T/q2.json"'

echo "== marker placement (warn by default; anchor_placement: error | off)"
mk "$REQ"; rm -f src/a.* ; mkdir -p src
printf 'function a() {\n  x(); // @spec todo/add-a-todo\n}\nfunction b() {}\n' > src/p.js
mkdir -p test; printf "// @spec todo/add-a-todo\ntest(\"a\", () => {});\n" > test/todo.test.js
rc=0; $V anchors todo > "$T/a.json" || rc=$?
expect "a trailing marker is a placement warning with file:line, not a failure" '[ $rc = 0 ] && grep -q "marker-placement" "$T/a.json" && grep -q "src/p.js:2: trailing-marker" "$T/a.json" && [ "$(J "$T/a.json" ok)" = true ]'
sed -i "s/^anchor_placement:.*/anchor_placement: error/" openspec/config.yaml
rc=0; $V anchors todo > "$T/a.json" || rc=$?
expect "anchor_placement: error makes the same finding fail" '[ $rc = 1 ] && grep -q "trailing-marker" "$T/a.json"'
sed -i "s/^anchor_placement:.*/anchor_placement: off/" openspec/config.yaml
rc=0; $V anchors todo > "$T/a.json" || rc=$?
expect "anchor_placement: off reports nothing" '[ $rc = 0 ] && ! grep -q "marker-placement" "$T/a.json"'
sed -i "s/^anchor_placement:.*/anchor_placement: warn/" openspec/config.yaml
printf 'function a() {\n  // @spec todo/add-a-todo\n  x();\n}\n' > src/p.js
rc=0; $V anchors todo > "$T/a.json" || rc=$?
expect "a marker directly above the lines it covers is clean" '[ $rc = 0 ] && ! grep -q "marker-placement" "$T/a.json"'
rm -f src/p.js

echo "== output above 64 KB survives a pipe (the commands end with process.exit)"
rm -rf openspec/changes/b openspec/specs/cap openspec/.apply-runs src/todo.js; mkdir -p openspec/specs/bulk
{ printf '## Purpose\nMany requirements, so the reports are larger than a pipe buffer.\n\n## Requirements\n\n'; for i in $(seq 1 400); do printf '### Requirement: Requirement number %s with a reasonably long name\nThe system SHALL do thing %s.\n\n#### Scenario: Thing %s\n- **WHEN** it happens\n- **THEN** it is done\n\n' "$i" "$i" "$i"; done; } > openspec/specs/bulk/spec.md
$V drift --json | cat > "$T/pipe.drift.json"; $V drift --json > "$T/file.drift.json"
expect "drift --json through a pipe is complete: more than 64 KB, byte-identical to the file output, parses" '[ "$(wc -c < "$T/pipe.drift.json")" -gt 70000 ] && cmp -s "$T/pipe.drift.json" "$T/file.drift.json" && [ "$(J "$T/pipe.drift.json" counts.unanchored-requirement)" -ge 400 ]'
$V problems --json | cat > "$T/pipe.problems.json"
expect "problems --json through a pipe parses and lists every gap" '[ "$(wc -c < "$T/pipe.problems.json")" -gt 70000 ] && node -e "JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\"))" "$T/pipe.problems.json"'
$V drift --text | cat > "$T/pipe.drift.txt"; $V drift --text > "$T/file.drift.txt"
expect "drift --text through a pipe is complete (same bytes as the file output)" '[ "$(wc -c < "$T/pipe.drift.txt")" -gt 70000 ] && cmp -s "$T/pipe.drift.txt" "$T/file.drift.txt"'
rm -rf openspec/specs/bulk

echo
echo "traceability: passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
