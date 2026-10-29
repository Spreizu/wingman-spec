#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# `verify-task.cjs problems`: every verifier finding as one located list (file, line, column, severity, repair), the input of the
# editor's Problems panel. Seeded project with one of each finding, exact positions asserted, plus a clean project that must give none.
# Usage: tests/problems.sh (needs openspec, git and node). Exit 0 when all pass.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; [ -n "${KEEP:-}" ] || trap 'rm -rf "$T"' EXIT; [ -z "${KEEP:-}" ] || echo "kept: $T"
unset SPEC_TRACEABILITY SPEC_ANCHOR_GUARD SPEC_ANCHOR_STALE SPEC_ANCHOR_PLACEMENT SPEC_TEST_EVIDENCE
export OPENSPEC_TELEMETRY=0 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
# F <code> <field>: field of the first finding with that code
F() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const f=(j.findings||[]).find(x=>x.code===process.argv[2]);let v=f;for(const k of process.argv[3].split("."))v=v==null?v:v[k];console.log(v===undefined?"":typeof v==="object"?JSON.stringify(v):v)' "$T/p.json" "$1" "$2"; }
N() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((j.findings||[]).length)' "$T/p.json"; }

setup() {
  mkdir -p "$1" && cd "$1" && git init -q
  openspec init --tools none >/dev/null 2>&1 || mkdir -p openspec/changes openspec/specs
  "$PKG/install.sh" . --harness all >/dev/null || { echo "install failed"; exit 1; }
  sed -i 's/Test command: <fill in>/Test command: none/;s/Typecheck command: <fill in>/Typecheck command: none/;s/Lint command: <fill in>/Lint command: none/;s/^visual:.*/visual: off/;/^  command: <fill in>/d;/^  url: <fill in>/d;s/^traceability:.*/traceability: on/' openspec/config.yaml
  mkdir -p openspec/specs/todo src tests
}
V="node openspec/scripts/verify-task.cjs"

echo "== clean project: nothing to report"
setup "$T/clean"
cat > openspec/specs/todo/spec.md <<'SPEC'
## Purpose
Keeps a list of things to do.

## Requirements

### Requirement: Add a todo
The system SHALL append a todo with the given text to the list.
Why: The owner wants it to work, so that people can rely on it.

#### Scenario: Added
- **WHEN** the user adds "buy milk"
- **THEN** the list is ["buy milk"]
SPEC
cat > src/todo.js <<'JS'
/**
 * Adds a todo to the list.
 * @spec todo/add-a-todo
 */
export function addTodo(list, text) {
  return [...list, text.trim()];
}
JS
cat > tests/todo.test.js <<'JS'
it('adds [todo/added]', () => {});
JS
git add -A >/dev/null && git commit -qm init
$V problems > "$T/p.json"; rc=$?
expect "exit 0 and ok:true with no findings" '[ $rc = 0 ] && [ "$(N)" = 0 ] && grep -q "\"ok\": true" "$T/p.json"'

echo "== seeded project: one of each finding, exact positions"
setup "$T/seed"
cat > openspec/specs/todo/spec.md <<'SPEC'
## Purpose
Keeps a list of things to do.

## Requirements

### Requirement: Add a todo
The system SHALL append a todo with the given text to the list.
Why: The owner wants it to work, so that people can rely on it.

#### Scenario: Added
- **WHEN** the user adds "buy milk"
- **THEN** the list is ["buy milk"]

### Requirement: Remove a todo
The system SHALL remove the todo with the given index.
Why: The owner wants it to work, so that people can rely on it.

#### Scenario: Removed
- **WHEN** the user removes index 0
- **THEN** the list is empty

### Requirement: Clear all
The system SHALL clear the list.
Why: The owner wants it to work, so that people can rely on it.

#### Scenario: Cleared
- **WHEN** the user clears
- **THEN** it is empty
SPEC
cat > src/todo.js <<'JS'
/**
 * Adds a todo to the list.
 * @spec todo/add-a-todo
 */
export function addTodo(list, text) {
  return [...list, text.trim()];
}

export function removeTodo(list, i) {
  return list.filter((_, j) => j !== i); // @spec todo/remove-a-todo
}

// @spec todo/add-todo
export function other() { return 1; }
JS
cat > tests/todo.test.js <<'JS'
// @spec todo/add-a-todo
it('adds [todo/added]', () => {});
it('stale [todo/nothing-here]', () => {});
JS
git add -A >/dev/null && git commit -qm init
sed -i 's/\[\.\.\.list, text.trim()\]/[...list, String(text).trim()]/' src/todo.js && git commit -qam "addTodo coerces text"
mkdir -p openspec/changes/edit/specs/todo
printf 'Size: S\nRisk: none\n\n## Why\nx\n\n## What Changes\n- x\n' > openspec/changes/edit/proposal.md
printf '## ADDED Requirements\n\n### Requirement: Edit a todo\nThe system SHALL edit a todo.\n\n#### Scenario: Edited\n- **WHEN** a\n- **THEN** b\n' > openspec/changes/edit/specs/todo/spec.md
printf '## 1. Work\n- [ ] 1.1 Do it\n  Done when: `true`\n' > openspec/changes/edit/tasks.md
$V problems > "$T/p.json"; rc=$?
expect "exit 0 even with errors (it reports, the gates decide)" '[ $rc = 0 ] && grep -q "\"ok\": false" "$T/p.json"'
expect "unanchored requirement -> its heading in the living spec (Clear all, line 22)" '[ "$(F unanchored-requirement file)" = "$T/seed/openspec/specs/todo/spec.md" ] && [ "$(F unanchored-requirement line)" = 22 ] && [ "$(F unanchored-requirement severity)" = error ]'
expect "untested requirement -> its heading (Remove a todo, line 14) with the scenario ids to tag" '[ "$(F untested-requirement line)" = 14 ] && [ "$(F untested-requirement fix.kind)" = add-test-tag ] && [ "$(F untested-requirement fix.scenarios)" = "[{\"name\":\"Removed\",\"id\":\"todo/removed\"}]" ]'
expect "orphan anchor -> the key inside the marker (line 13, column 10), with the nearest requirement as a repair" '[ "$(F orphan-anchor file)" = "$T/seed/src/todo.js" ] && [ "$(F orphan-anchor line)" = 13 ] && [ "$(F orphan-anchor col)" = 10 ] && [ "$(F orphan-anchor length)" = 13 ] && [ "$(F orphan-anchor fix.to)" = todo/add-a-todo ]'
expect "stale test tag -> the tag in the test (line 3), column after the bracket" '[ "$(F stale-test-tag file)" = "$T/seed/tests/todo.test.js" ] && [ "$(F stale-test-tag line)" = 3 ] && [ "$(F stale-test-tag col)" = 12 ] && [ "$(F stale-test-tag length)" = 17 ]'
expect "misplaced marker -> its line (10), a warning with the move-marker repair" '[ "$(F misplaced-marker line)" = 10 ] && [ "$(F misplaced-marker severity)" = warning ] && [ "$(F misplaced-marker fix.kind)" = move-marker ]'
expect "stale anchor (code changed after the requirement) -> the marker line, info, with the accept repair" '[ "$(F stale-anchor file)" = "$T/seed/src/todo.js" ] && [ "$(F stale-anchor severity)" = info ] && [ "$(F stale-anchor fix.kind)" = accept ] && [ "$(F stale-anchor line)" = 3 ]'
expect "change lint: a requirement without a Why -> its heading in the delta, with the add-why repair" '[ "$(F missing-why file)" = "$T/seed/openspec/changes/edit/specs/todo/spec.md" ] && [ "$(F missing-why line)" = 3 ] && [ "$(F missing-why fix.kind)" = add-why ] && [ "$(F missing-why change)" = edit ]'
expect "every finding has a source, code, severity, absolute file, line >= 1, column >= 1" 'node -e '"'"'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(j.findings.every(f=>f.source&&f.code&&["error","warning","info"].includes(f.severity)&&require("path").isAbsolute(f.file)&&f.line>=1&&f.col>=1&&f.length>=1)?0:1)'"'"' "$T/p.json"'
expect "counts add up to the findings" 'node -e '"'"'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.exit(j.counts.error+j.counts.warning+j.counts.info===j.findings.length?0:1)'"'"' "$T/p.json"'
expect "a change name limits the lint to that change, drift still reported" '$V problems edit > "$T/p2.json" && grep -q "\"change\": \"edit\"" "$T/p2.json" && grep -q unanchored-requirement "$T/p2.json"'
expect "unknown change -> usage error (exit 2)" '$V problems nope >/dev/null 2>&1; [ $? = 2 ]'

echo "== accepted gaps: an accepted requirement gap disappears, a gap in code cannot be accepted"
$V drift decide stale-test-tag:todo/nothing-here --accept --note "kept on purpose" >/dev/null 2>&1; rc=$?
expect "a stale test tag cannot be accepted (exit 2)" '[ $rc = 2 ]'
$V problems > "$T/p.json"
expect "  and stays a problem" '[ -n "$(F stale-test-tag line)" ]'
$V drift decide unanchored-requirement:todo/clear-all --accept --note "built later" >/dev/null
$V problems > "$T/p.json"
expect "an accepted requirement gap is no longer a problem" '[ -z "$(F unanchored-requirement line)" ]'
expect "  and the repair offered for the gap is accept (the editor writes the Accepted line)" 'git checkout -q openspec/specs && $V problems > "$T/p.json" && [ "$(F unanchored-requirement fix.kind)" = accept ]'

echo "== a change in progress: markers and tags for what it adds are not orphans, a typo still is"
setup "$T/pend"
printf '## Purpose\nKeeps a list of things to do.\n\n## Requirements\n\n### Requirement: Add a todo\nThe system SHALL append a todo with the given text to the list.\nWhy: The owner wants it to work, so that people can rely on it.\n\n#### Scenario: Added\n- **WHEN** x\n- **THEN** y\n' > openspec/specs/todo/spec.md
mkdir -p openspec/changes/clear-all/specs/todo
printf '## ADDED Requirements\n\n### Requirement: Clear all\nThe system SHALL empty the list.\nWhy: The owner wants it to work, so that people can rely on it.\n\n#### Scenario: Cleared\n- **WHEN** x\n- **THEN** y\n' > openspec/changes/clear-all/specs/todo/spec.md
printf '/**\n * Empties.\n * @spec todo/clear-all\n */\nexport function clearAll() {\n  return [];\n}\n' > src/clear.js
printf "// @spec todo/clear-all\nit('empties [todo/cleared]', () => {});\n" > tests/clear.test.js
git add -A; git commit -qm seed
$V problems > "$T/p.json"
expect "pending requirement: no orphan-anchor, no stale-test-tag" '[ -z "$(F orphan-anchor line)" ] && [ -z "$(F stale-test-tag line)" ]'
printf '/**\n * Typo.\n * @spec todo/clear-al\n */\nexport function typo() {\n  return 1;\n}\n' > src/typo.js
$V problems > "$T/p.json"
expect "a marker that matches neither the specs nor a pending change is still an orphan" '[ "$(F orphan-anchor file)" = "$T/pend/src/typo.js" ]'
cd "$T/seed" || exit 1

echo "== traceability off: only lint of the changes, no drift"
sed -i 's/^traceability:.*/traceability: off/' openspec/config.yaml
$V problems > "$T/p.json"
expect "no drift findings when traceability is off" '[ -z "$(F orphan-anchor line)" ] && [ -z "$(F untested-requirement line)" ]'

echo; echo "problems: passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
