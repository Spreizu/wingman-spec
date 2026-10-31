#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# Anchor guard (internal/anchors): is a `@spec` anchor still about its code? Seeded cases for the change-time guard
# (`wingman-spec guard`), the test evidence, and drift's misplaced-marker / stale-anchor gaps, plus the false-positive control
# (benign edits must give no finding). Usage: tests/anchorguard.sh (needs the wingman-spec binary, see tests/lib/ws.sh, git and node). Exit 0 when all pass.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/ws.sh
. "$PKG/tests/lib/ws.sh"
T="$(mktemp -d)"; [ -n "${KEEP:-}" ] || trap 'rm -rf "$T"' EXIT; [ -z "${KEEP:-}" ] || echo "kept: $T"
unset WINGMAN_SPEC_TRACEABILITY WINGMAN_SPEC_ANCHOR_GUARD WINGMAN_SPEC_ANCHOR_STALE WINGMAN_SPEC_ANCHOR_PLACEMENT WINGMAN_SPEC_TEST_EVIDENCE
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; if [ -n "${DEBUG:-}" ]; then head -c 1500 "$T/d.json" 2>/dev/null; echo; fi; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }
kinds() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log([...new Set((j.findings||[]).map(f=>f.kind))].sort().join(","))' "$1"; }
J() { node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));let v=j;for(const k of process.argv[2].split(".").filter(Boolean))v=v==null?v:v[k];console.log(typeof v==="object"?JSON.stringify(v):v)' "$1" "$2"; }

cd "$T" && mkdir p && cd p && git init -q
ws_init .
ws_cmd test none && ws_cmd typecheck none && ws_cmd lint none && ws_set visual off
V="$WS"; C=.wingman-spec/changes/edit
mkdir -p .wingman-spec/specs src tests "$C"
cat > .wingman-spec/specs/todo.md <<'SPEC'
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
SPEC
cat > src/todo.js <<'JS'
/**
 * Adds a todo to the list.
 * @spec todo/add-a-todo
 */
export function addTodo(list, text) {
  // trim first
  const t = text.trim();
  if (!t) throw new Error('text required');
  return [...list, t];
}

/**
 * Removes a todo.
 * @spec todo/remove-a-todo
 */
export function removeTodo(list, i) {
  return list.filter((_, j) => j !== i);
}

export function helper(x) {
  return x + 1;
}
JS
cat > src/util.js <<'JS'
export function unrelated(a) {
  return a * 2;
}
JS
cat > tests/todo.test.js <<'JS'
import { test } from 'node:test';
test('[todo/added] adds a todo', () => {});
test('[todo/removed] removes a todo', () => {});
JS
printf '## 1. Todo\n- [x] 1.1 edit\n  - Spec: todo/add-a-todo\n  - Files: src/todo.js\n  - Done when: `true` exits 0\n' > "$C/tasks.md"
printf '## Why\nx\n' > "$C/proposal.md"
git add -A && git commit -qm init
G() { rc=0; $V guard edit --base HEAD > "$T/g.json" 2> "$T/g.err" || rc=$?; }
reset() { git checkout -q -- . ; git clean -fdq src tests; printf '## 1. Todo\n- [x] 1.1 edit\n  - Spec: todo/remove-a-todo\n  - Files: src/todo.js\n  - Done when: `true` exits 0\n' > "$C/tasks.md"; rm -rf "$C/specs" "$C/progress.md"; }
reset

echo "== control: normal edits give no finding (false-positive check)"
benign=0; quiet=0
try() { benign=$((benign+1)); G; if [ "$(kinds "$T/g.json")" = "" ]; then quiet=$((quiet+1)); else echo "     unexpected: $(kinds "$T/g.json") after: $1"; fi; reset; }
G; expect "no change at all: no finding" '[ "$(kinds "$T/g.json")" = "" ]'
sed -i 's/const t = text.trim();/const t   =  text.trim();\n\n/' src/todo.js; try "whitespace and blank lines inside the anchored function"
sed -i 's#// trim first#// trim the text first (reworded comment)#; s#Adds a todo to the list.#Adds a todo item to the end of the list.#' src/todo.js; try "comment and doc text edits"
sed -i 's#const t = text.trim();#const t = text.trim(); // trimmed#' src/todo.js; try "trailing comment added to a code line"
sed -i 's/return x + 1;/return x + 2;/' src/todo.js; try "another function of the same file edited"
printf 'export const z = 1;\n' > src/new.js; try "an unrelated new file"
sed -i 's/return a \* 2;/return a * 3;/' src/util.js; try "an unrelated file without markers edited"
python3 - <<'PY'
import re
s=open('src/todo.js').read()
a=s.index('/**\n * Removes'); b=s.index('export function helper')
s=s[:a]+s[b:]+'\n'+s[a:b].rstrip()+'\n'   # reorder: the anchored function moves down the file
open('src/todo.js','w').write(s)
PY
try "an anchored function moved within its file (unchanged)"
mkdir -p src/gen; printf '// @generated\n// @spec todo/add-a-todo\nexport function g(a) {\n  return a;\n}\n' > src/gen/out.js; try "a generated file with a marker"
echo "  info: $quiet of $benign benign edits gave no finding"
expect "false positives: 0 findings on all $benign benign edits" '[ "$quiet" = "$benign" ]'

echo "== seeded: the anchored code changes and the change does not mention the requirement"
sed -i "s/if (!t) throw new Error('text required');/if (!t) return list;/" src/todo.js; G
expect "modifying an anchored function without touching the spec: anchor-touched-unlisted (exit 0, a warning)" '[ $rc = 0 ] && [ "$(kinds "$T/g.json")" = "anchor-touched-unlisted" ] && grep -q "todo/add-a-todo" "$T/g.json" && grep -q "Reviewed anchors" "$T/g.json"'
expect "the finding names the file and line" 'grep -q "src/todo.js:" "$T/g.json"'
printf '## 1. Todo\n- [x] 1.1 edit\n  - Spec: todo/add-a-todo\n  - Files: src/todo.js\n' > "$C/tasks.md"; G
expect "listed by a task Spec: line: no finding" '[ "$(kinds "$T/g.json")" = "" ]'
printf '## 1. Todo\n- [x] 1.1 edit\n  - Files: src/todo.js\n' > "$C/tasks.md"; G
expect "without the Spec: line the finding is back" '[ "$(kinds "$T/g.json")" = "anchor-touched-unlisted" ]'
printf '# progress\n- Reviewed anchors: todo/add-a-todo - an empty text now returns the list, the requirement says nothing about it\n' > "$C/progress.md"; G
expect "a Reviewed anchors: line answers it" '[ "$(kinds "$T/g.json")" = "" ]'
rm "$C/progress.md"; mkdir -p "$C/specs/todo"; printf '## MODIFIED\n\n### Requirement: Add a todo\nThe system SHALL append a todo, ignoring empty text.\nWhy: The owner wants it to work, so that people can rely on it.\n\n#### Scenario: Empty\n- **WHEN** the user adds ""\n- **THEN** the list is unchanged\n' > "$C/specs/todo.md"; G
expect "a delta spec that MODIFIES the requirement answers it" '[ "$(kinds "$T/g.json")" = "" ]'
sed -i "s/if (!t) return list;/if (!t) throw new Error('text required');/" src/todo.js; G
expect "modified requirement whose anchored code did not change: requirement-changed-code-untouched" '[ "$(kinds "$T/g.json")" = "requirement-changed-code-untouched" ]'
printf '# progress\nReviewed anchors: todo/add-a-todo - already throws on empty text\n' > "$C/progress.md"; G
expect "...answered by Reviewed anchors:" '[ "$(kinds "$T/g.json")" = "" ]'
reset
sed -i 's/^export function addTodo/export function addItem/' src/todo.js; G
expect "renaming an anchored function counts as touched" '[ "$(kinds "$T/g.json")" = "anchor-touched-unlisted" ]'; reset
sed -i 's/^   \* @spec todo\/add-a-todo//; s/^ \* @spec todo\/add-a-todo$/ * (no marker)/' src/todo.js; G
expect "deleting the marker leaves the requirement without a code anchor: anchor-removed" '[ "$(kinds "$T/g.json")" = "anchor-removed" ]'; reset
echo "== seeded: a moved function"
python3 - <<'PY'
s=open('src/todo.js').read(); a=s.index('/**\n * Adds'); b=s.index('/**\n * Removes')
open('src/todo.js','w').write(s[:a]+s[b:]); open('src/add.js','w').write(s[a:b].rstrip()+'\n')
PY
G
expect "moved to another file, unchanged: anchor-moved (reported, not silent)" '[ "$(kinds "$T/g.json")" = "anchor-moved" ] && grep -q "src/add.js" "$T/g.json"'; reset
python3 - <<'PY'
s=open('src/todo.js').read(); a=s.index('/**\n * Adds'); b=s.index('/**\n * Removes')
open('src/todo.js','w').write(s[:a]+s[b:]); open('src/add.js','w').write(s[a:b].rstrip().replace('throw new Error','throw new TypeError')+'\n')
PY
G
expect "moved and edited: anchor-touched-unlisted" '[ "$(kinds "$T/g.json")" = "anchor-moved,anchor-touched-unlisted" ] || [ "$(kinds "$T/g.json")" = "anchor-touched-unlisted" ]'; reset

echo "== seeded: sprawl"
mkdir -p "$C/specs/todo"; printf '## MODIFIED\n\n### Requirement: Add a todo\nThe system SHALL append a todo.\nWhy: The owner wants it to work, so that people can rely on it.\n\n#### Scenario: Added\n- **WHEN** x\n- **THEN** y\n' > "$C/specs/todo.md"
printf 'Reviewed anchors: todo/add-a-todo - control\n' > "$C/progress.md"
for i in 1 2 3 4 5 6; do mkdir -p "src/f$i"; for j in 1 2; do printf '// @spec todo/add-a-todo\nexport function a%s%s(x) {\n  return x;\n}\n' "$i" "$j" > "src/f$i/m$j.js"; done; done
G
expect "12 anchors in 6 files for one requirement: anchor-sprawl" 'grep -q "anchor-sprawl" "$T/g.json" && grep -q "entry point" "$T/g.json"'
sed -i 's/^The system SHALL append a todo\.$/&\nAnchors: many/' "$C/specs/todo.md"; G
expect "the same 12 anchors with \`Anchors: many\` in the requirement: no sprawl" '! grep -q "anchor-sprawl" "$T/g.json"'
sed -i '/^Anchors: many$/d' "$C/specs/todo.md"; G
expect "(control) without the line the sprawl is back" 'grep -q "anchor-sprawl" "$T/g.json"'
rm -rf src/f*; G
expect "a few anchors: no sprawl" '! grep -q "anchor-sprawl" "$T/g.json"'; reset

echo "== anchor_guard levels"
sed -i "s/if (!t) throw new Error('text required');/if (!t) return list;/" src/todo.js
printf '## 1. Todo\n- [x] 1.1 edit\n  - Files: src/todo.js\n' > "$C/tasks.md"
ws_set anchor_guard error; G
expect "anchor_guard: error makes the guard command exit 1" '[ $rc = 1 ] && [ "$(kinds "$T/g.json")" = "anchor-touched-unlisted" ]'
ws_set anchor_guard off; G
expect "anchor_guard: off reports nothing" '[ $rc = 0 ] && [ "$(J "$T/g.json" level)" = off ]'
ws_set anchor_guard warn; reset

echo "== anchor outside the task's Files: list"
# a marker added in a file outside the task's Files: warns; inside a listed directory it does not:
# go test ./internal/anchors -run TestGuardOutsideTaskFiles

# test evidence from real runner output (TAP, spec, dot: passed, failed, skipped, unlisted):
# go test ./internal/anchors -run TestEvidenceFromRunnerOutput

echo "== drift: misplaced markers"
git checkout -q -- . 2>/dev/null; git clean -fdq src
drift() { rc=0; $V drift > "$T/d.json" 2>/dev/null || rc=$?; }
printf 'export function bad(a) {\n  return a; // @spec todo/add-a-todo\n}\n' > src/bad.js  # left uncommitted: no history yet, so no stale-anchor noise
drift
expect "a trailing marker is listed as a misplaced-marker gap, advisory by default (exit 0)" '[ "$rc" = 0 ] && grep -q "misplaced-marker" "$T/d.json" && grep -q "trailing-marker" "$T/d.json" && [ "$(J "$T/d.json" advisory.0.type)" = misplaced-marker ]'
ws_set anchor_placement error; drift
expect "anchor_placement: error makes drift fail on it" '[ "$rc" = 1 ] && [ "$(J "$T/d.json" open.0.type)" = misplaced-marker ]'
ws_set anchor_placement off; drift
expect "anchor_placement: off hides it" '! grep -q "misplaced-marker" "$T/d.json"'
ws_set anchor_placement warn
acc=0; $V drift decide 'misplaced-marker:trailing-marker@src/bad.js#todo/add-a-todo' --accept --note "kept for the test" > "$T/dd.json" 2>&1 || acc=$?; drift
expect "a misplaced marker cannot be accepted (exit 2): it is moved; the gap stays" '[ "$acc" = 2 ] && [ "$(J "$T/d.json" advisory.0.type)" = misplaced-marker ]'
rm -rf src/bad.js

echo "== drift: stale anchors (git history only)"
drift
expect "control: units and spec committed together: no stale-anchor" '! grep -q "\"type\": \"stale-anchor\"" "$T/d.json"'
sed -i 's/const t = text.trim();/const t   =  text.trim();/' src/todo.js; git commit -qam "whitespace only"; drift
expect "whitespace-only commit: not stale" '! grep -q "\"type\": \"stale-anchor\"" "$T/d.json"'
sed -i 's#// trim first#// trim first, politely#' src/todo.js; git commit -qam "comment only"; drift
expect "comment-only commit: not stale" '! grep -q "\"type\": \"stale-anchor\"" "$T/d.json"'
sed -i 's/return x + 1;/return x + 5;/' src/todo.js; git commit -qam "other function"; drift
expect "edit of another function in the same file: not stale" '! grep -q "\"type\": \"stale-anchor\"" "$T/d.json"'
python3 - <<'PY'
s=open('src/todo.js').read(); a=s.index('/**\n * Removes'); b=s.index('export function helper')
open('src/todo.js','w').write(s[:a]+s[b:]); open('src/remove.js','w').write(s[a:b].rstrip()+'\n')
PY
git add -A; git commit -qm "move removeTodo to its own file"; drift
expect "function moved to a new file in a later commit: not stale (blame follows the move)" '! grep -q "\"type\": \"stale-anchor\"" "$T/d.json"'
sed -i "s/if (!t) throw new Error('text required');/if (!t) return list;/" src/todo.js; git commit -qam "empty text now returns the list"; drift
expect "real edit of the anchored function after the spec: stale-anchor (advisory: exit 0)" '[ "$rc" = 0 ] && [ "$(J "$T/d.json" advisory.0.type)" = stale-anchor ] && grep -q "todo/add-a-todo@src/todo.js" "$T/d.json" && grep -q "empty text now returns the list" "$T/d.json"'
expect "the gap names the commit and carries the hint" '[ -n "$(J "$T/d.json" advisory.0.commit)" ] && grep -q "drift decide" "$T/d.json"'
ws_set anchor_stale error; drift
expect "anchor_stale: error makes it fail drift" '[ "$rc" = 1 ] && [ "$(J "$T/d.json" open.0.type)" = stale-anchor ]'
ws_set anchor_stale off; drift
expect "anchor_stale: off hides it" '! grep -q "\"type\": \"stale-anchor\"" "$T/d.json"'
ws_set anchor_stale info
$V drift decide 'stale-anchor:todo/add-a-todo@src/todo.js' --accept --note "still holds: the requirement never said empty text throws" > "$T/dd.json" 2>&1; drift
expect "accepted but not committed yet: the spec text is uncommitted, no stale-anchor is reported" '! grep -q "\"type\": \"stale-anchor\"" "$T/d.json" && grep -q "^Accepted: still holds" .wingman-spec/specs/todo.md'
git add -A; git commit -qm "accept"; drift
expect "'still holds' is an Accepted line on the requirement: once committed the requirement is newer than the code, no longer open" '! grep -q "\"advisory\"" "$T/d.json"'
sed -i "s/return \[...list, t\];/return list.concat([t]);/" src/todo.js; git commit -qam "concat"; drift
expect "a later change of the same unit reopens it" '[ "$(J "$T/d.json" advisory.0.type)" = stale-anchor ]'
sed -i 's/The system SHALL append a todo with the given text to the list./The system SHALL append a todo with the given text to the end of the list./' .wingman-spec/specs/todo.md; git commit -qam "spec reworded"; drift
expect "the spec edited after the code: not stale" '! grep -q "\"type\": \"stale-anchor\"" "$T/d.json"'
sed -i "s/return list.concat(\[t\]);/return [...list, t];/" src/todo.js; sed -i 's/The system SHALL remove the todo with the given index./The system SHALL remove the todo with the given index (from 0)./' .wingman-spec/specs/todo.md; git commit -qam "code and spec together"; drift
expect "a commit that changes the code and the spec together: not stale" '! grep -q "\"type\": \"stale-anchor\"" "$T/d.json"'

echo "== drift: the normal flow (spec proposed, code written, spec synced) is not stale"
mkdir -p .wingman-spec/changes/flow-change/specs/flow src
printf '## ADDED\n\n### Requirement: Do it\nThe system SHALL do it.\nWhy: The owner wants it to work, so that people can rely on it.\n\n#### Scenario: Done\n- **WHEN** x\n- **THEN** y\n' > .wingman-spec/changes/flow-change/specs/flow.md
git add -A; git commit -qm "propose flow-change"
printf '/**\n * Does it.\n * @spec flow/do-it\n */\nexport function doIt(x) {\n  return x + 1;\n}\n' > src/flow.js; git add -A; git commit -qm "implement flow-change"
sed -i 's/return x + 1;/return x + 2;/' src/flow.js; git commit -qam "implement flow-change, second try"
mkdir -p .wingman-spec/specs; printf '## Purpose\nDoes things for the flow test.\n\n## Requirements\n\n### Requirement: Do it\nThe system SHALL do it.\nWhy: The owner wants it to work, so that people can rely on it.\n\n#### Scenario: Done\n- **WHEN** x\n- **THEN** y\n' > .wingman-spec/specs/flow.md
git add -A; git commit -qm "sync flow-change (the delta text is copied into the living spec)"; drift
expect "code implemented between propose and sync: not stale (the living text is as new as the sync)" '! grep -q "stale-anchor:flow/do-it" "$T/d.json"'
sed -i 's/return x + 2;/return x + 3;/' src/flow.js; git commit -qam "tweak after sync"; drift
expect "the same unit edited after the sync: stale-anchor" 'grep -q "stale-anchor:flow/do-it@src/flow.js" "$T/d.json"'
git revert --no-edit HEAD -q >/dev/null 2>&1 || git reset -q --hard HEAD~1

echo "== drift: shallow clone and no git"
sed -i "s/return \[...list, t\];/return list.concat(t);/" src/todo.js; git commit -qam "later edit"
git clone -q --depth 1 "file://$T/p" "$T/shallow" 2>/dev/null
(cd "$T/shallow" && $WS drift > "$T/ds.json" 2>/dev/null; true)
expect "shallow clone: stale-anchor is skipped with a note, no false gap" '! grep -q "\"type\": \"stale-anchor\"" "$T/ds.json" && grep -q "shallow" "$T/ds.json"'
cp -r "$T/p" "$T/nogit" && rm -rf "$T/nogit/.git"
(cd "$T/nogit" && $WS drift > "$T/dn.json" 2>/dev/null; true)
expect "no git: stale-anchor is skipped with a note" '! grep -q "\"type\": \"stale-anchor\"" "$T/dn.json" && grep -q "no git history" "$T/dn.json"'

echo "== drift: one commit touching two capabilities (the per-commit file list is read once and reused)"
mkdir -p "$T/two" && cd "$T/two" && git init -q
ws_init .
ws_cmd test none && ws_cmd typecheck none && ws_cmd lint none && ws_set visual off
mkdir -p .wingman-spec/specs .wingman-spec/specs/beta src
for c in alpha beta; do printf '## Purpose\nCapability %s.\n\n## Requirements\n\n### Requirement: Do the %s thing\nThe system SHALL do the %s thing.\nWhy: The owner wants it to work, so that people can rely on it.\n\n#### Scenario: Done\n- **WHEN** asked\n- **THEN** done\n' "$c" "$c" "$c" > ".wingman-spec/specs/$c.md"; printf '// @spec %s/do-the-%s-thing\nexport function %s(x) {\n  return x + 1;\n}\n' "$c" "$c" "$c" > "src/$c.js"; done
git add -A; git commit -qm "specs and code"
sed -i 's/SHALL do the alpha thing\./SHALL do the alpha thing twice./' .wingman-spec/specs/alpha.md
sed -i 's/return x + 1;/return x + 2;/' src/alpha.js src/beta.js
git commit -qam "one commit: alpha spec and code, beta code only"
rc=0; $V drift > "$T/d2.json" 2>/dev/null || rc=$?
expect "the shared commit counts for alpha (spec changed with the code) but not for beta (code only): only beta is stale" '[ "$(J "$T/d2.json" advisory.0.key)" = "stale-anchor:beta/do-the-beta-thing@src/beta.js" ] && [ "$(J "$T/d2.json" advisory.1)" = undefined ]'
$V drift > "$T/d2b.json" 2>/dev/null; $V problems --json > /dev/null 2>&1
expect "the drift output is deterministic across runs" 'cmp -s "$T/d2.json" "$T/d2b.json"'
cd "$T/p" || exit 1

echo; echo "anchor guard: passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
