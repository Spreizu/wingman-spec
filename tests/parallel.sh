#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# Parallel-PR safety: two team members work on their own changes on their own branches and merge. Generated and shared files
# (code-anchor index, Whys, ADRs) must not make different capabilities conflict; same-capability work
# conflicts only in the files both really edit. Real git merges in a scratch repository.
# Usage: tests/parallel.sh (needs the wingman-spec binary, see tests/lib/ws.sh, git and node). Exit 0 when all pass.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=lib/ws.sh
. "$PKG/tests/lib/ws.sh"
T="${KEEP:-$(mktemp -d)}"; [ -n "${KEEP:-}" ] || trap 'rm -rf "$T"' EXIT
unset WINGMAN_SPEC_TRACEABILITY
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }
V="$WS"

cd "$T" && mkdir p && cd p && git init -q -b main
ws_init . && ws_set visual off
ws_cmd test none && ws_cmd typecheck none && ws_cmd lint none
printf 'node_modules/\n' > .gitignore

# mkchange <change> <capability> <adr-slug|none> <requirement name>
# Does what an agent does for one finished change: delta specs, code and test anchors, an ADR,
# and `wingman-spec sync` (merges the delta into the living spec and promotes the ADR with the next number).
mkchange() {
  local ch="$1" cap="$2" adr="$3" req="$4" C=".wingman-spec/changes/$1" slug
  slug="$(echo "$req" | tr 'A-Z ' 'a-z-')"
  mkdir -p "$C/specs" "$C/adrs" "src" "test" ".wingman-spec/specs"
  printf 'Size: S\nRisk: none\n\n## Why\nWe need %s because people ask for it.\n\n## What Changes\n- Adds %s.\n\n## Capabilities\n### New Capabilities\n- `%s`: %s\n\n## ADR candidates\n- none\n\n## Impact\nsrc\n\n## Edge cases\n- none named\n' "$cap" "$cap" "$cap" "$cap" > "$C/proposal.md"
  local reqblock
  reqblock="$(printf '### Requirement: %s\nThe system SHALL do %s.\nWhy: People who need %s want it to work, so that they can rely on it.\n\n#### Scenario: It works\n- **WHEN** the user asks for %s\n- **THEN** they get %s\n\n#### Scenario: Nothing to do\n- **WHEN** the input is empty\n- **THEN** it is rejected with "input required"\n' "$req" "$req" "$req" "$req" "$req")"
  if [ -s ".wingman-spec/specs/$cap.md" ]; then
    printf '## ADDED\n\n%s\n' "$reqblock" > "$C/specs/$cap.md"
  else
    printf '## Purpose\nProvides %s for the people who need it, as an example.\n\n## ADDED\n\n%s\n' "$cap" "$reqblock" > "$C/specs/$cap.md"
  fi
  printf '## 1. Do it\n- [x] 1.1 do %s\n  - Spec: %s > %s (all scenarios)\n  - Test first: x\n  - Files: src/%s.js\n  - Done when: `true` exits 0\n' "$req" "$cap" "$req" "$slug" > "$C/tasks.md"
  printf '// @spec %s/%s\nexports.%s = () => 1;\n' "$cap" "$slug" "${slug//-/_}" > "src/$slug.js"
  printf '// @spec %s/%s\nexports.t = 1;\n' "$cap" "$slug" > "test/$slug.test.js"
  if [ "$adr" = none ]; then printf -- '---\ntitle: None\nstatus: none\ndate: 2026-10-26\nchange: %s\n---\n\n# None\n\nNo decision.\n' "$ch" > "$C/adrs/none.md"
  else printf -- '---\ntitle: %s\nstatus: Proposed\ndate: 2026-10-26\nchange: %s\n---\n\n# %s\n\n## Context\nWhy.\n\n## Decision\nWe do it.\n\n## Consequences\nIt is done.\n' "$adr" "$ch" "$adr" > "$C/adrs/$adr.md"
  fi
  $V sync "$ch" > "$T/sync-$ch.json" 2> "$T/sync-$ch.err"; rc=$?
  git add -A >/dev/null; git commit -qm "$ch" >/dev/null
}
merge() { git merge --no-edit "$1" > "$T/merge.out" 2>&1; rc=$?; }
conflicted() { git diff --name-only --diff-filter=U | tr '\n' ' '; }

# base: one finished change on main
mkchange base-change base base-decision "Base thing"; expect "base change syncs on main" '[ $rc = 0 ]'
git branch -q alice; git branch -q bob

echo "== two members, two capabilities"
git checkout -q alice; mkchange alice-change alpha alpha-store "Alpha thing"; expect "alice: sync ok" '[ $rc = 0 ]'
git checkout -q bob;   mkchange bob-change beta beta-store "Beta thing"; expect "bob: sync ok" '[ $rc = 0 ]'
git checkout -q main; merge alice; expect "merge alice into main" '[ $rc = 0 ]'
merge bob; expect "merge bob: NO conflict (conflicted: $(conflicted))" '[ $rc = 0 ]'
if [ $rc != 0 ]; then git merge --abort >/dev/null 2>&1; fi
$V sync --check bob-change > "$T/sc.json" 2>&1; rc=$?
expect "merged tree: the two ADRs that both took the next number are reported, not silent" '[ $rc = 1 ] && grep -q "share number" "$T/sc.json"'
expect "adrs lists the duplicate and exits 1" '! $V adrs >/dev/null 2>&1'
expect "adrs --fix renumbers the later file" '$V adrs --fix >/dev/null 2>&1; $V adrs >/dev/null 2>&1 && [ -z "$(ls .wingman-spec/adrs | grep -E "^[0-9]{4}-" | sed "s/-.*//" | sort | uniq -d)" ]'
expect "after the fix both changes report synced again" '$V sync --check alice-change >/dev/null 2>&1 && $V sync --check bob-change >/dev/null 2>&1'
expect "merged tree: drift is clean" '$V drift > "$T/drift.json" 2>/dev/null; [ "$(node -e "const j=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\"));console.log((j.open||[]).length)" "$T/drift.json")" = 0 ]'
expect "no generated index file is committed (the markers are the index)" '[ ! -e .wingman-spec/anchors.json ]'
expect "each requirement keeps its Why in the living spec of its own capability" 'grep -q "^Why: " .wingman-spec/specs/alpha.md && grep -q "^Why: " .wingman-spec/specs/beta.md && grep -q "^Why: " .wingman-spec/specs/base.md'
git reset -q --hard HEAD >/dev/null 2>&1

echo "== two members add a requirement to the SAME capability"
git checkout -q -B main "$(git merge-base alice bob)" >/dev/null 2>&1
git checkout -q -b carol; mkchange carol-change base carol-store "Carol thing"
git checkout -q main; git checkout -q -b dave; mkchange dave-change base dave-store "Dave thing"
git checkout -q main; merge carol; merge dave
c="$(conflicted)"
expect "same capability: only the living spec both really edit can conflict (conflicted: ${c:-none})" '[ -z "$(git diff --name-only --diff-filter=U | grep -v "^.wingman-spec/specs/base.md$")" ]'
git merge --abort >/dev/null 2>&1; git reset -q --hard HEAD >/dev/null 2>&1

echo "== two members accept different requirements of the SAME capability (the Accepted line lives in the requirement)"
git checkout -q -B main "$(git merge-base alice bob)" >/dev/null 2>&1; git reset -q --hard >/dev/null 2>&1
mkdir -p .wingman-spec/specs/legacy
{ printf '# legacy Specification\n\n## Purpose\nBehaviour that predates anchors.\n\n## Requirements\n'
  for r in One Two Three; do printf '\n### Requirement: Old %s\nThe system SHALL keep doing old %s.\n\n#### Scenario: Old %s\n- **WHEN** x\n- **THEN** y\n' "$r" "$r" "$r"; done; } > .wingman-spec/specs/legacy.md
git add -A; git commit -qm "legacy spec"
git checkout -q -b erin;  $V drift decide unanchored-requirement:legacy/old-one --accept --note "erin: old, no code to mark" >/dev/null; git commit -qam "erin accepts One"
git checkout -q main; git checkout -q -b frank; $V drift decide unanchored-requirement:legacy/old-two --accept --note "frank: old, no code to mark" >/dev/null; git commit -qam "frank accepts Two"
git checkout -q main; git checkout -q -b gina;  $V drift decide --all unanchored-requirement --accept --note "gina: all legacy" >/dev/null 2>&1; git commit -qam "gina accepts the rest"
git checkout -q main; merge erin; merge frank
expect "two branches each accepting a different (adjacent) requirement merge without a conflict (conflicted: $(conflicted))" '[ $rc = 0 ] && grep -q "^Accepted: erin" .wingman-spec/specs/legacy.md && grep -q "^Accepted: frank" .wingman-spec/specs/legacy.md'
expect "after the merge both requirements are accepted, the third is still an open gap" '$V drift > "$T/dr.json" 2>/dev/null; [ "$(node -e "const j=JSON.parse(require(\"fs\").readFileSync(process.argv[1],\"utf8\"));console.log(j.accepted.length+\"/\"+j.open.filter((g)=>g.key.includes(\"legacy/\")).length)" "$T/dr.json")" = 2/1 ]'
git reset -q --hard HEAD >/dev/null 2>&1
git checkout -q -B main erin >/dev/null 2>&1; merge gina
expect "a bulk accept on one branch and a single accept of the same requirement on another conflict only in that requirement's own spec file (conflicted: $(conflicted))" '[ -z "$(git diff --name-only --diff-filter=U | grep -v "^.wingman-spec/specs/legacy.md$")" ]'
git merge --abort >/dev/null 2>&1; git reset -q --hard HEAD >/dev/null 2>&1

echo; echo "parallel: passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
