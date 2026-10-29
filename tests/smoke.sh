#!/usr/bin/env bash
# shellcheck disable=SC2016 # single-quoted snippets are run by `bash -c` with "$0" as their argument
# Smoke test: installs the package into a temp project and exercises schema, installer (all three
# harnesses), the generated entry points and verify-task.cjs (stub subagents; no real agent calls).
set -uo pipefail
# A clean machine may have no git identity, and the workspace checks override HOME (B10).
export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-smoke}" GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-smoke@example.invalid}"
export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-smoke}" GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-smoke@example.invalid}"
export OPENSPEC_TELEMETRY=0

PKG="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ok   $*"; }
bad()  { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
check() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then ok "$d"; else bad "$d"; fi; }
check_not() { local d="$1"; shift; if "$@" >/dev/null 2>&1; then bad "$d"; else ok "$d"; fi; }
trap 'rm -rf "$T"' EXIT

cd "$T" && mkdir proj && cd proj || exit 1
openspec init --tools cursor >/dev/null 2>&1 || mkdir -p openspec/changes openspec/specs

echo "== installer"
"$PKG/install.sh" "$T/proj" >/dev/null || bad "install.sh exit"
check "schema validates"            openspec schema validate wingman-spec
check "config uses schema"          grep -q '^schema: wingman-spec' openspec/config.yaml
check "config.yaml parses: a new change without --schema gets wingman-spec and openspec warns about nothing" bash -c 'out=$(openspec new change cfgprobe 2>&1); rc=1; if ! printf "%s" "$out" | grep -qi "could not parse" && grep -q "^schema: wingman-spec" openspec/changes/cfgprobe/.openspec.yaml; then rc=0; fi; rm -rf openspec/changes/cfgprobe; exit $rc'
check "AGENTS.md has block"         grep -q 'WINGMAN-SPEC:START' AGENTS.md
check "default config from init was replaced" grep -q '^schema: wingman-spec' openspec/config.yaml
check "verifier script executable"  test -x openspec/scripts/verify-task.cjs
check "visual check module installed" test -f openspec/scripts/visual-check.cjs
check "quality module installed"   test -f openspec/scripts/quality.cjs
check "design contract module installed" test -f openspec/scripts/design-contract.cjs
check "placement module installed (marker placement rules)" test -f openspec/scripts/placement.cjs
check "test-path module installed (which files are tests)" test -f openspec/scripts/testpaths.cjs
check "config template has the anchor_placement key" grep -q "^anchor_placement: warn" openspec/config.yaml
check "anchor guard module installed" test -f openspec/scripts/anchorguard.cjs
check "anchor fit module installed" test -f openspec/scripts/anchorfit.cjs
check "chronology module installed" test -f openspec/scripts/chronology.cjs
check "timeline module installed (what happened during a build)" test -f openspec/scripts/timeline.cjs
check "run state module installed" test -f openspec/scripts/runstate.cjs
check "problems module installed" test -f openspec/scripts/problems.cjs
check "config template has the anchor guard keys" bash -c 'grep -q "^anchor_guard: warn" openspec/config.yaml && grep -q "^test_evidence: warn" openspec/config.yaml && grep -q "^anchor_stale: info" openspec/config.yaml'
check "roles module installed (visual roles)" test -f openspec/scripts/roles.cjs
check "installer creates the self-ignoring openspec/.local/ and leaves .gitignore alone" bash -c '[ "$(cat openspec/.local/.gitignore)" = "*" ] && ! grep -q "openspec/.auth\|roles.local" .gitignore 2>/dev/null'
check "config has typecheck and lint command keys" bash -c 'grep -q "^  - Typecheck command:" openspec/config.yaml && grep -q "^  - Lint command:" openspec/config.yaml'
check "proposal template carries Size and Risk" bash -c 'head -1 "$0" | grep -q "^Size: " && sed -n 2p "$0" | grep -q "^Risk: "' "$PKG/schemas/wingman-spec/templates/proposal.md"
check "tasks template has no Size line and no close-out group" bash -c '! grep -q "^Size: " "$0" && ! grep -qi "^## .*close-out" "$0" && grep -q "Request code review of the whole change" "$0"' "$PKG/schemas/wingman-spec/templates/tasks.md"
check "no ralph loop installed"     test ! -e openspec/scripts/ralph.sh -a ! -e openspec/scripts/ralph-prompt.md
check_not "no timing script installed" test -e openspec/scripts/timing.sh
for c in explore propose apply fix sync archive adopt garden; do check "command spec-$c installed" test -f ".cursor/commands/spec-$c.md"; done
for s in grilling test-driven-development ponytail systematic-debugging requesting-code-review ponytail-review verification-before-completion spec-writing; do
  check "skill $s installed" test -f ".cursor/skills/$s/SKILL.md"
done
check "implementer subagent installed" test -f .cursor/agents/spec-implementer.md
check "implementer uses ponytail"   grep -q ponytail .cursor/agents/spec-implementer.md
check "guard hook installed"        test -f .cursor/hooks/spec-guard.cjs
check "guard hook registered"       grep -q spec-guard.cjs .cursor/hooks.json
check "guard blocks /opsx:apply"    bash -c "echo '{\"prompt\":\"/opsx:apply x\"}' | node .cursor/hooks/spec-guard.cjs | grep -q '\"continue\":false'"
check "guard blocks /opsx:archive"  bash -c "echo '{\"prompt\":\"/opsx:archive x\"}' | node .cursor/hooks/spec-guard.cjs | grep -q '\"continue\":false'"
snap1="$(find . -type f -not -path './.git/*' | sort | xargs shasum | shasum)"
"$PKG/install.sh" "$T/proj" >/dev/null
snap2="$(find . -type f -not -path './.git/*' | sort | xargs shasum | shasum)"
check "second install changes nothing" test "$snap1" = "$snap2"
mkdir -p "$T/p2" && printf '# Existing\n\nmy notes\n' > "$T/p2/AGENTS.md"
"$PKG/install.sh" "$T/p2" >/dev/null
check "AGENTS.md existing content kept" grep -q 'my notes' "$T/p2/AGENTS.md"
mkdir -p "$T/p3/openspec" && printf 'schema: spec-driven\ncontext: |\n  my custom context\n' > "$T/p3/openspec/config.yaml"
"$PKG/install.sh" "$T/p3" >/dev/null
check "existing config not clobbered" grep -q 'my custom context' "$T/p3/openspec/config.yaml"
check "suggested config written"      test -f "$T/p3/openspec/config.wingman-spec.suggested.yaml"
mkdir -p "$T/p4" && printf '{ "name": "p4", "scripts": { "test": "true", "typecheck": "true", "lint": "exit 3" } }\n' > "$T/p4/package.json"
p4out="$("$PKG/install.sh" "$T/p4" 2>&1)"
check "detected typecheck that passes is configured" grep -q '^  - Typecheck command: `npm run typecheck`' "$T/p4/openspec/config.yaml"
check "detected lint that fails on the current code is not configured, with the reason" bash -c 'grep -q "^  - Lint command: none" "$1/openspec/config.yaml" && printf "%s" "$2" | grep -q "fails on the current code (exit 3)"' _ "$T/p4" "$p4out"

echo "== schema artifact order / gating"
openspec new change demo --schema wingman-spec >/dev/null 2>&1 || bad "openspec new change"
st() { openspec status --change demo --json 2>/dev/null; }
check "specs follow the proposal; tasks need only specs" bash -c "openspec status --change demo --json | python3 -c 'import sys,json; d=json.load(sys.stdin); a={x[\"id\"]:x[\"status\"] for x in d[\"artifacts\"]}; assert a[\"proposal\"]==\"ready\" and a[\"specs\"]==\"blocked\" and a[\"tasks\"]==\"blocked\", a'"
C=openspec/changes/demo
mkdir -p $C/specs/x
echo a > $C/proposal.md; echo a > $C/specs/x/spec.md
check "fast path: tasks are ready with only proposal and specs (no app-map, design or adrs)" bash -c "openspec status --change demo --json | python3 -c 'import sys,json; d=json.load(sys.stdin); a={x[\"id\"]:x[\"status\"] for x in d[\"artifacts\"]}; assert a[\"tasks\"]==\"ready\" and a[\"design\"]==\"ready\", a'"
mkdir -p $C/adrs
echo a > $C/design.md
cat > $C/adrs/use-postgres.md <<'EOF'
---
title: Use PostgreSQL
status: Proposed
date: 2026-10-19
change: demo
supersedes: <!-- optional -->
---

# Use PostgreSQL

## Decision
We will use PostgreSQL.
EOF
check "full path: adrs are ready or done once design exists" bash -c "openspec status --change demo --json | python3 -c 'import sys,json; d=json.load(sys.stdin); a={x[\"id\"]:x[\"status\"] for x in d[\"artifacts\"]}; assert a[\"adrs\"] in (\"ready\", \"done\"), a'"

echo "== spec-sync command (agent-driven; behavior is not executable here, so check it is complete)"
f=.cursor/commands/spec-sync.md
check "command keys on source: identity"    grep -q 'source: <change>/<slug>' "$f"
check "command handles supersedes"          grep -q 'Superseded by' "$f"
check "command skips status none"           grep -q 'status: none' "$f"
check "command supports --check"            grep -q -- '--check' "$f"
check "command supports --adrs-only"        grep -q -- '--adrs-only' "$f"
check "command runs spec sync first"        grep -q 'openspec-sync-specs' "$f"
f=.cursor/commands/spec-adopt.md
check "adopt uses baseline source identity"   grep -q 'source: baseline/<slug>' "$f"
check "adopt never overwrites existing specs" grep -q 'Never overwrite' "$f"
check "adopt supports --check"                grep -q -- '--check' "$f"
check "adopt validates specs"                 grep -q 'openspec validate --specs --strict' "$f"
check "adopt grills before writing"           grep -q grilling "$f"
check "no leftover adr-sync script"           test ! -e scripts/adr-sync.sh
check "scripts are not installed at repo root" test ! -e scripts/verify-task.cjs
check "explore uses grilling"                 grep -q grilling .cursor/commands/spec-explore.md
check "propose covers all artifacts"          bash -c 'for a in app-map proposal specs design adrs tasks; do grep -q "$a" .cursor/commands/spec-propose.md || exit 1; done'
check "apply dispatches the implementer subagent" grep -q 'spec-implementer' .cursor/commands/spec-apply.md
check "apply is gated by verify-task next/check" bash -c 'grep -q "V next <change>" "$0" && grep -q "V check <change>" "$0"' .cursor/commands/spec-apply.md
check "apply defines the sequential fallback"  grep -q 'sequential fallback' .cursor/commands/spec-apply.md
check "partials expanded (no {{> }} left)"     bash -c '! grep -rq "{{> " .cursor/commands .cursor/agents'
check "OpenSpec-root rules in every command"   bash -c 'for f in .cursor/commands/spec-*.md; do grep -q "OpenSpec root.\*\*" "$f" || exit 1; done'
f=.cursor/commands/spec-fix.md
check "fix classifies before writing"         grep -q 'Classify each finding' "$f"
check "fix patches or follows up"             bash -c 'grep -q "Active change" "$0" && grep -q "Archived" "$0"' "$f"
check "fix never writes openspec/specs/"      grep -q 'Never write `openspec/specs/`' "$f"
check "fix uses the verified apply loop"      grep -q 'V check <change>' "$f"
check "fix hands off to spec-sync"            grep -q '/spec-sync' "$f"
f=.cursor/commands/spec-archive.md
check "archive requires skip-specs"           grep -q -- '--skip-specs' "$f"
check "archive always runs spec-sync first"  grep -q "Always sync first" "$f"
check "archive goes through the verifier script" grep -q "verify-task.cjs archive" "$f"
check "archive never writes openspec/specs/"  grep -q 'Never write `openspec/specs/`' "$f"
check "archive blocks stock opsx:archive"     grep -q '/opsx:archive' "$f"
check "explore answers from the repo before it asks" grep -q 'Answer from the repo first' ".cursor/commands/spec-explore.md"
check "propose looks in the repo before it asks" grep -q 'look for the answer in the repo first' ".cursor/commands/spec-propose.md"
for c in explore propose apply fix; do
  check_not "command spec-$c has no timing steps" grep -q 'timing' ".cursor/commands/spec-$c.md"
done

echo "== verify-task contract (tests/verify-task.sh: stub subagents, 15 injected faults, 21 quality faults, 13 visual faults, 3 regressions)"
vt_out="$("$PKG/tests/verify-task.sh" 2>&1)"; vt_rc=$?
printf '%s\n' "$vt_out" | grep -E '^  (ok|FAIL)' | sed 's/^  /    /'
check "verify-task contract passes" test "$vt_rc" = 0
check "all 15 injected faults caught" bash -c "printf '%s' \"\$0\" | grep -q 'faults_caught=15 '" "$vt_out"
check "all 3 out-of-scope regressions caught without baselines" bash -c "printf '%s' \"\$0\" | grep -q 'regressions=3/3'" "$vt_out"
check "all 13 visual faults caught" bash -c "printf '%s' \"\$0\" | grep -q 'visual_faults=13/13'" "$vt_out"
check "all 21 quality faults caught (size tiers, plan size, typecheck/lint, trace, source text, edge cases, Purpose, finish)" bash -c "printf '%s' \"\$0\" | grep -q 'quality_faults=21/21'" "$vt_out"

echo "== design contract (tests/design-contract.sh: design map lint, discovery, token lint, expect: checks in the browser)"
dc_out="$("$PKG/tests/design-contract.sh" 2>&1)"; dc_rc=$?
printf '%s\n' "$dc_out" | grep -E '^  (ok|FAIL)' | sed 's/^  /    /'
check "design contract passes" test "$dc_rc" = 0
check "all design faults caught (map lint, token lint, expect: colour/size/order/alignment/spacing, uncited design rubric, typography and expect coverage of the map)" bash -c "printf '%s' \"\$0\" | grep -q 'design_faults=25/25'" "$dc_out"

echo "== traceability (tests/traceability.sh: the Why, anchors, seeded drift, sync before archive)"
tr_out="$("$PKG/tests/traceability.sh" 2>&1)"; tr_rc=$?
printf '%s\n' "$tr_out" | grep -E '^  (ok|FAIL)' | sed 's/^  /    /'
check "traceability contract passes" test "$tr_rc" = 0

echo "== planning path (tests/fastpath.sh: fast and full path, scope upgrade, generated app map)"
check "fast path and full path contract passes" "$PKG/tests/fastpath.sh"
check "run cache and parallel finish pass" "$PKG/tests/runcache.sh"

echo "== doc drift (B15)"
check "docs match verify-task options and schema skills" "$PKG/tests/drift.sh"

echo "== harnesses (generated from one source)"
H="$T/ph"; mkdir -p "$H" && (cd "$H" && git init -q)
check "install --harness all succeeds"      "$PKG/install.sh" "$H" --harness all
for c in explore propose apply fix sync archive adopt garden; do
  check "spec-$c: cursor, claude, codex entry points" test -f "$H/.cursor/commands/spec-$c.md" -a -f "$H/.claude/commands/spec-$c.md" -a -f "$H/.agents/skills/spec-$c/SKILL.md"
done
check "subagent for each harness"           test -f "$H/.cursor/agents/spec-implementer.md" -a -f "$H/.claude/agents/spec-implementer.md" -a -f "$H/.codex/agents/spec-implementer.toml"
check "visual reviewer subagent for each harness" test -f "$H/.cursor/agents/spec-visual-reviewer.md" -a -f "$H/.claude/agents/spec-visual-reviewer.md" -a -f "$H/.codex/agents/spec-visual-reviewer.toml"
check "visual reviewer is read-only in Cursor and Claude Code, shell-less in Codex" bash -c 'grep -qx "readonly: true" "$0/.cursor/agents/spec-visual-reviewer.md" && grep -qx "tools: Read, Grep, Glob" "$0/.claude/agents/spec-visual-reviewer.md" && grep -qx "shell_tool = false" "$0/.codex/agents/spec-visual-reviewer.toml" && ! grep -q "shell_tool" "$0/.codex/agents/spec-implementer.toml" && ! grep -q "^readonly\|^tools" "$0/.cursor/agents/spec-implementer.md" "$0/.claude/agents/spec-implementer.md"' "$H"
check "codex visual reviewer TOML parses"   python3 -c 'import sys,tomllib; d=tomllib.load(open(sys.argv[1],"rb")); assert d["name"]=="spec-visual-reviewer" and "STATUS: pass" in d["developer_instructions"]' "$H/.codex/agents/spec-visual-reviewer.toml"
check "greenfield commands in every harness (spec-green-start, spec-green-plan, spec-green-next)" bash -c 'for f in spec-green-start spec-green-plan spec-green-next; do test -f "$0/.cursor/commands/$f.md" && test -f "$0/.claude/commands/$f.md" && test -f "$0/.agents/skills/$f/SKILL.md" || exit 1; done' "$H"
check "spec-reviewer subagent in every harness, read-only in Cursor and Claude Code" bash -c 'grep -qx "readonly: true" "$0/.cursor/agents/spec-reviewer.md" && test -f "$0/.claude/agents/spec-reviewer.md" && python3 -c "import sys,tomllib; d=tomllib.load(open(sys.argv[1],\"rb\")); assert d[\"name\"]==\"spec-reviewer\"" "$0/.codex/agents/spec-reviewer.toml"' "$H"
check "greenfield.cjs is installed and /spec-adopt runs the mode guard first" bash -c 'test -f "$0/openspec/scripts/greenfield.cjs" && grep -q "mode --for adopt" "$0/.cursor/commands/spec-adopt.md"' "$H"
for h in .cursor/commands/spec-apply.md .claude/commands/spec-fix.md .agents/skills/spec-apply/SKILL.md; do
  check "visual review only by an independent subagent, --reviewer none without one, exit 5 not chained in $h" bash -c 'grep -q "spec-visual-reviewer" "$0" && grep -q "V review <change> --reviewer none" "$0" && grep -q "do NOT review the images yourself" "$0" && grep -q "Never chain" "$0" && ! grep -q "reviewer self\` (" "$0" && grep -q "\`5\`: the deterministic checks passed" "$0"' "$H/$h"
done
for h in .cursor/commands .claude/commands; do
  check "explore and propose build the design map in $h" bash -c 'grep -q "verify-task.cjs design-system" "$0/spec-explore.md" && grep -q "explore-design/<slug>.md" "$0/spec-explore.md" && grep -q "design-map.md" "$0/spec-propose.md" && grep -q "Questions for the designer" "$0/spec-propose.md"' "$H/$h"
done
check "visual reviewer compares side by side with the design and cites the rubric in every harness" bash -c 'for f in "$0/.cursor/agents/spec-visual-reviewer.md" "$0/.claude/agents/spec-visual-reviewer.md" "$0/.codex/agents/spec-visual-reviewer.toml"; do grep -q "side by side with the design" "$f" && grep -q "RUBRIC: <scenario id> <item>: pass|fail - <citation>" "$f" && grep -q "layout, hierarchy, spacing, colour, typography, components" "$f" || exit 1; done; ! grep -q -- "--reviewer self\` (" "$0/.agents/skills/spec-apply/SKILL.md"' "$H"
check "explore and propose build the design map in codex skills" bash -c 'grep -q "verify-task.cjs design-system" "$0/spec-explore/SKILL.md" && grep -q "design-map.md" "$0/spec-propose/SKILL.md"' "$H/.agents/skills"
check "figma-to-code skill (SKILL.md, references, helper) installed for cursor, claude and codex" bash -c 'for d in .cursor/skills .claude/skills .agents/skills; do for f in SKILL.md references/figma-sources.md references/design-map-recipe.md scripts/figma-fetch.mjs; do test -f "$0/$d/figma-to-code/$f" || exit 1; done; done' "$H"
check "figma-to-code helper runs from the installed copy (parse-url, no token: exit 3 without a request)" bash -c 'cd "$0" && for d in .cursor/skills .claude/skills .agents/skills; do node "$d/figma-to-code/scripts/figma-fetch.mjs" parse-url "https://www.figma.com/design/AbC123/Plans?node-id=12-345" | grep -q "\"nodeId\":\"12:345\"" || exit 1; env -u FIGMA_TOKEN node "$d/figma-to-code/scripts/figma-fetch.mjs" fetch "https://www.figma.com/design/AbC123/Plans?node-id=12-345" >/dev/null 2>&1; [ $? = 3 ] || exit 1; done' "$H"
check "explore and propose point a Figma URL at the figma-to-code skill in every harness" bash -c 'for f in "$0/.cursor/commands/spec-explore.md" "$0/.cursor/commands/spec-propose.md" "$0/.claude/commands/spec-explore.md" "$0/.claude/commands/spec-propose.md" "$0/.agents/skills/spec-explore/SKILL.md" "$0/.agents/skills/spec-propose/SKILL.md"; do grep -q "figma-to-code" "$f" || exit 1; done; grep -q "figma-to-code" "$0/AGENTS.md"' "$H"
check "figma-to-code is first party: not in vendor.lock or VENDORED.md" bash -c '! grep -q figma "$0/skills/vendor.lock" "$0/skills/VENDORED.md"' "$PKG"
check "figma-to-code tests pass (offline, node --test)" env -u FIGMA_TOKEN "$PKG/tests/figma-to-code.sh"
check "propose runs doctor and writes visual blocks" bash -c 'grep -q "verify-task.cjs doctor" "$0" && grep -q "visual \`\`\`\` block" "$0"' "$H/.cursor/commands/spec-propose.md"
check "no screenshot baselines anywhere in the harness" bash -c '! grep -rqi "baseline.*screenshot\|visual-baselines\|--approve\|NO BASELINE" "$0/.cursor" "$0/.claude" "$0/.codex" "$0/.agents/skills"/spec-*' "$H"
for h in .cursor/commands/spec-apply.md .claude/commands/spec-apply.md .agents/skills/spec-apply/SKILL.md; do
  check "apply loop: pre-task capture at next, before/after review in $h" bash -c 'grep -q "records the pre-task DOM" "$0" && grep -q "before/after images" "$0"' "$H/$h"
done
for h in .cursor/commands/spec-apply.md .claude/commands/spec-apply.md .agents/skills/spec-apply/SKILL.md; do
  check "finish close-out with one fix subagent in $h" bash -c 'grep -q "V finish <change>" "$0" && grep -q "fix_prompt" "$0"' "$H/$h"
done
check "implementer tags tests and avoids source-text tests in every harness" bash -c 'for f in "$0/.cursor/agents/spec-implementer.md" "$0/.claude/agents/spec-implementer.md" "$0/.codex/agents/spec-implementer.toml"; do grep -q "Tests name their scenario" "$f" && grep -q "source-text-ok" "$f" || exit 1; done' "$H"
check "implementer: accessible names from visible text (sr-only with an explicit space), live regions always rendered, in every harness (stated once, not in AGENTS or the apply command)" bash -c 'for f in "$0/.cursor/agents/spec-implementer.md" "$0/.claude/agents/spec-implementer.md" "$0/.codex/agents/spec-implementer.toml"; do grep -q "label-content-name-mismatch" "$f" && grep -q "explicit space" "$f" && grep -q "aria-describedby" "$f" && grep -q "keep the live region, change its text" "$f" || exit 1; done; ! grep -q "explicit space" "$0/.cursor/commands/spec-apply.md" "$0/AGENTS.md"' "$H"
check "reviewer compares before/after area images in every harness" bash -c 'for f in "$0/.cursor/agents/spec-visual-reviewer.md" "$0/.claude/agents/spec-visual-reviewer.md" "$0/.codex/agents/spec-visual-reviewer.toml"; do grep -q "before and after" "$f" || exit 1; done' "$H"
check "bundled skills for each harness"     test -f "$H/.cursor/skills/grilling/SKILL.md" -a -f "$H/.claude/skills/grilling/SKILL.md" -a -f "$H/.agents/skills/grilling/SKILL.md"
check "codex skill name matches its folder" bash -c 'for f in "$0"/.agents/skills/spec-*/SKILL.md; do d=$(basename "$(dirname "$f")"); grep -qx "name: $d" "$f" || exit 1; done' "$H"
check "codex skills say \$spec-*, not /spec-*" bash -c '! grep -h "Run \`/spec-\|after \`/spec-" "$0"/.agents/skills/spec-*/SKILL.md | grep -q .' "$H"
if python3 -c 'import tomllib' 2>/dev/null; then
  check "codex agent TOML parses with name/description/instructions" python3 -c 'import sys,tomllib; d=tomllib.load(open(sys.argv[1],"rb")); assert d["name"]=="spec-implementer" and d["description"] and "the prompt lists" in d["developer_instructions"]' "$H/.codex/agents/spec-implementer.toml"
fi
check "claude command front matter"         bash -c 'head -1 "$0" | grep -qx -- "---" && grep -q "^description: " "$0"' "$H/.claude/commands/spec-apply.md"
check "every generated command/skill/agent file in every harness: line 1 is not the generated-by note and a description exists" bash -c '
  n=0; for f in "$0"/.cursor/commands/spec-*.md "$0"/.claude/commands/spec-*.md "$0"/.agents/skills/spec-*/SKILL.md "$0"/.cursor/agents/spec-*.md "$0"/.claude/agents/spec-*.md "$0"/.codex/agents/spec-*.toml; do
    case "$f" in */skills/spec-writing/SKILL.md) continue ;; esac # a bundled skill, not generated from harness/
    [ -f "$f" ] || { echo "missing $f"; exit 1; }; n=$((n+1))
    head -1 "$f" | grep -q "^<!--\|generated by" && { echo "line 1 is a marker: $f"; exit 1; }
    case "$f" in *.toml) grep -q "^description = \"." "$f" || { echo "no description: $f"; exit 1; } ;;
      *) [ "$(head -1 "$f")" = "---" ] && sed -n "2,6p" "$f" | grep -q "^description: \".\+\"" || { echo "no front matter description: $f"; exit 1; } ;; esac
    grep -q "generated by the wingman-spec install.sh" "$f" || { echo "no generated-by note: $f"; exit 1; }
  done; [ "$n" -ge 30 ] || { echo "only $n files"; exit 1; }' "$H"
check "cursor commands start with front matter and the note comes after it" bash -c 'for f in "$0"/.cursor/commands/spec-*.md; do [ "$(sed -n 1p "$f")" = "---" ] && sed -n 4p "$f" | grep -q "^<!-- generated by" || exit 1; done' "$H"
check "claude hook registered"              grep -q 'spec-guard.cjs.*--format claude' "$H/.claude/settings.json"
check "codex hook registered"               grep -q 'spec-guard.cjs.*--format codex' "$H/.codex/hooks.json"
check "CLAUDE.md imports AGENTS.md"         grep -qx '@AGENTS.md' "$H/CLAUDE.md"
check "claude guard blocks /opsx:apply"     bash -c "cd '$H' && echo '{\"prompt\":\"/opsx:apply x\",\"cwd\":\"$H\"}' | node .claude/hooks/spec-guard.cjs --format claude | grep -q '\"decision\":\"block\"'"
check "codex guard suggests \$spec-apply"   bash -c "cd '$H' && echo '{\"prompt\":\"/prompts:opsx-apply x\",\"cwd\":\"$H\"}' | node .codex/hooks/spec-guard.cjs --format codex | grep -q 'Run [$]spec-apply x'"
check "claude/codex guard silent on allow"  bash -c "cd '$H' && test -z \"\$(echo '{\"prompt\":\"hello\",\"cwd\":\"$H\"}' | node .codex/hooks/spec-guard.cjs --format codex)\""
check "guard maps /opsx:update to /spec-fix" bash -c "cd '$H' && echo '{\"prompt\":\"/opsx:update x\"}' | node .cursor/hooks/spec-guard.cjs | grep -q 'Run /spec-fix x'"
R1="$T/r1"; R2="$T/r2"
for h in cursor claude codex; do "$PKG/scripts/render-harness.sh" "$h" "$R1" >/dev/null; "$PKG/scripts/render-harness.sh" "$h" "$R2" >/dev/null; done
check "render-harness output is deterministic" diff -r "$R1" "$R2"
check "installed files equal the rendered ones" diff -r "$R1/.cursor/commands" "$H/.cursor/commands" -x 'opsx-*'
snapH1="$(find "$H" -type f -not -path '*/.git/*' | sort | xargs shasum | shasum)"
"$PKG/install.sh" "$H" --harness all >/dev/null
snapH2="$(find "$H" -type f -not -path '*/.git/*' | sort | xargs shasum | shasum)"
check "second --harness all install changes nothing" test "$snapH1" = "$snapH2"
printf 'my own apply command\n' > "$H/.claude/commands/spec-apply.md"; echo '# local tweak' >> "$H/.claude/skills/ponytail/SKILL.md"
filesBefore="$(find "$H" -type f -not -path '*/.git/*' | sort)"
"$PKG/install.sh" "$H" --harness claude >/dev/null
check "a reinstall overwrites an edited command with the generated one" grep -q 'generated by the wingman-spec install.sh' "$H/.claude/commands/spec-apply.md"
check "... and an edited installed skill" bash -c '! grep -q "local tweak" "$0"' "$H/.claude/skills/ponytail/SKILL.md"
check "... and leaves no stray file" test "$filesBefore" = "$(find "$H" -type f -not -path '*/.git/*' | sort)"
check "installed skills equal the template byte for byte, except the authoring-only files of systematic-debugging" bash -c 'for s in "$0"/skills/*/; do [ -f "$s/SKILL.md" ] || continue; diff -r -x CREATION-LOG.md -x test-academic.md -x "test-pressure-*.md" "$s" "$1/.claude/skills/$(basename "$s")" >/dev/null || exit 1; done' "$PKG" "$H"
check "systematic-debugging installs without its creation log and pressure-test scenarios, and keeps its references" bash -c 'd="$0/.claude/skills/systematic-debugging"; [ -f "$d/SKILL.md" ] && [ -f "$d/root-cause-tracing.md" ] && [ -f "$d/find-polluter.sh" ] && [ ! -e "$d/CREATION-LOG.md" ] && [ ! -e "$d/test-academic.md" ] && ! ls "$d"/test-pressure-* >/dev/null 2>&1' "$H"
check_not "unknown harness is rejected"     "$PKG/install.sh" "$H" --harness vim
mkdir -p "$T/p5" && printf '# Mine\n<!-- WINGMAN-SPEC:START -->\nold block\nkeep me\n' > "$T/p5/AGENTS.md" && cp "$T/p5/AGENTS.md" "$T/p5.orig"
check_not "unbalanced AGENTS.md markers abort (B7)" "$PKG/install.sh" "$T/p5"
check "and AGENTS.md is untouched"          cmp -s "$T/p5/AGENTS.md" "$T/p5.orig"
mkdir -p "$T/p7/openspec" && printf 'schema: "wingman-spec"\ncontext: |\n  mine\n' > "$T/p7/openspec/config.yaml"
"$PKG/install.sh" "$T/p7" >/dev/null
check "quoted schema value is recognised (B19)" test ! -e "$T/p7/openspec/config.wingman-spec.suggested.yaml"

echo "== workspace layout (shared OpenSpec store; code repo points at it)"
if openspec store --help >/dev/null 2>&1; then
  W="$T/ws"; mkdir -p "$W/home" "$W/code"
  wenv() { HOME="$W/home" XDG_DATA_HOME="$W/data" XDG_CONFIG_HOME="$W/cfg" OPENSPEC_TELEMETRY=0 "$@"; }
  wenv openspec store setup acme --path "$W/store" >/dev/null 2>&1 || bad "openspec store setup"
  check "install --store succeeds"           wenv "$PKG/install.sh" "$W/code" --store acme
  check "schema installed in the store"      test -f "$W/store/openspec/schemas/wingman-spec/schema.yaml"
  check "schema not copied into code repo"   test ! -e "$W/code/openspec/schemas"
  check "store config uses the schema"       grep -q '^schema: wingman-spec' "$W/store/openspec/config.yaml"
  check "code repo has the store pointer"    grep -q '^store: acme' "$W/code/openspec/config.yaml"
  check "code repo stays config-only"        bash -c "test ! -e '$W/code/openspec/specs' && test ! -e '$W/code/openspec/changes'"
  check "scripts under code openspec/"       test -x "$W/code/openspec/scripts/verify-task.cjs"
  check "commands and AGENTS.md in code repo" bash -c "test -f '$W/code/.cursor/commands/spec-sync.md' && grep -q WINGMAN-SPEC:START '$W/code/AGENTS.md'"
  check "openspec resolves the store"        bash -c "cd '$W/code' && HOME='$W/home' XDG_DATA_HOME='$W/data' XDG_CONFIG_HOME='$W/cfg' OPENSPEC_TELEMETRY=0 openspec context --json 2>/dev/null | grep -q '\"store_id\": \"acme\"'"
  (cd "$W/code" && wenv openspec new change wsdemo >/dev/null 2>&1) || bad "openspec new change via pointer"
  check "change is created in the store"     test -d "$W/store/openspec/changes/wsdemo"
  check "no change dir in code repo"         test ! -e "$W/code/openspec/changes"
  printf '## 1. G\n- [ ] 1.1 one\n- [ ] 1.2 two\n' > "$W/store/openspec/changes/wsdemo/tasks.md"
  check "nothing detected: the repo's own pointer file holds the placeholder" grep -q '^  - Test command: <fill in>' "$W/code/openspec/config.yaml"
  sed -i 's/- Test command: <fill in>/- Test command: none/' "$W/code/openspec/config.yaml"  # the verifier refuses a placeholder
  check "verifier in code repo finds the store's task" bash -c "cd '$W/code' && HOME='$W/home' XDG_DATA_HOME='$W/data' XDG_CONFIG_HOME='$W/cfg' node openspec/scripts/verify-task.cjs next wsdemo | grep -q '\"change_dir\": \"$W/store/openspec/changes/wsdemo\"'"
  check "verifier --store works without pointer" bash -c "mkdir -p '$W/code2/openspec/scripts' && cp '$W/code/openspec/scripts/'* '$W/code2/openspec/scripts/' && cd '$W/code2' && HOME='$W/home' XDG_DATA_HOME='$W/data' XDG_CONFIG_HOME='$W/cfg' node openspec/scripts/verify-task.cjs status wsdemo --store acme | grep -q '\"remaining\": 2'"
  rm -rf "$W/store/openspec/.apply-runs"
  snapA="$(find "$W/code" "$W/store/openspec/schemas" -type f | sort | xargs shasum | shasum)"
  wenv "$PKG/install.sh" "$W/code" --store acme >/dev/null
  snapB="$(find "$W/code" "$W/store/openspec/schemas" -type f | sort | xargs shasum | shasum)"
  check "second --store install changes nothing" test "$snapA" = "$snapB"
  check_not "unknown store id is rejected"   wenv "$PKG/install.sh" "$W/code" --store nope
  mkdir -p "$W/local/openspec/changes"
  check_not "--store refuses a real local root" wenv "$PKG/install.sh" "$W/local" --store acme
else
  echo "  skip workspace layout (this openspec CLI has no 'store' command)"
fi

echo "== multi-repo workspace (one store, three code repos: each repo keeps its own commands)"
if openspec store --help >/dev/null 2>&1; then
  M="$T/trio"; mkdir -p "$M/home" "$M/web" "$M/api" "$M/mobile/tests"
  menv() { HOME="$M/home" XDG_DATA_HOME="$M/data" XDG_CONFIG_HOME="$M/cfg" SPEC_INSTALL_PROBE=0 OPENSPEC_TELEMETRY=0 "$@"; }
  menv openspec store setup trio --path "$M/store" >/dev/null 2>&1 || bad "openspec store setup trio"
  printf '{"scripts":{"test":"vitest run","build":"vite build","preview":"vite preview"},"devDependencies":{"vite":"6"}}\n' > "$M/web/package.json"
  printf 'module api\n\ngo 1.22\n' > "$M/api/go.mod"
  : > "$M/mobile/tests/test_app.py"
  check "web installs into the store" menv "$PKG/install.sh" "$M/web" --store trio
  rootA="$(shasum "$M/store/openspec/config.yaml")"
  check "api installs into the same store" menv "$PKG/install.sh" "$M/api" --store trio
  check "mobile installs into the same store" menv "$PKG/install.sh" "$M/mobile" --store trio
  check "later installs leave the shared store config alone" test "$rootA" = "$(shasum "$M/store/openspec/config.yaml")"
  check "store config only holds the first repo's detection as defaults" bash -c "grep -q '^  - Test command: \`vitest\|^  - Test command: \`npm test' '$M/store/openspec/config.yaml' && ! grep -q 'go test\|unittest' '$M/store/openspec/config.yaml'"
  check "web: pointer plus its own npm test and visual command" bash -c "grep -q '^store: trio' '$M/web/openspec/config.yaml' && grep -q '^verify: |' '$M/web/openspec/config.yaml' && grep -q '^  - Test command: \`npm test\`' '$M/web/openspec/config.yaml' && grep -q 'npm run build && npm run preview' '$M/web/openspec/config.yaml'"
  check "api: pointer plus go test, visual off" bash -c "grep -q '^store: trio' '$M/api/openspec/config.yaml' && grep -q '^  - Test command: \`go test ./...\`' '$M/api/openspec/config.yaml' && grep -q '^visual: off' '$M/api/openspec/config.yaml'"
  check "mobile: pointer plus unittest, visual off" bash -c "grep -q '^store: trio' '$M/mobile/openspec/config.yaml' && grep -q '^  - Test command: \`python3 -m unittest discover' '$M/mobile/openspec/config.yaml' && grep -q '^visual: off' '$M/mobile/openspec/config.yaml'"
  check "no repo gets another repo's command" bash -c "! grep -q 'go test\|unittest' '$M/web/openspec/config.yaml' && ! grep -q 'npm test\|unittest' '$M/api/openspec/config.yaml' && ! grep -q 'npm test\|go test' '$M/mobile/openspec/config.yaml'"
  check "openspec still resolves the store from every code repo (extra keys are accepted)" bash -c "for r in web api mobile; do (cd '$M'/\$r && HOME='$M/home' XDG_DATA_HOME='$M/data' XDG_CONFIG_HOME='$M/cfg' OPENSPEC_TELEMETRY=0 openspec context --json 2>/dev/null | grep -q '\"store_id\": \"trio\"') || exit 1; done"
  check "openspec doctor is clean in a repo with the extra keys" bash -c "cd '$M/api' && HOME='$M/home' XDG_DATA_HOME='$M/data' XDG_CONFIG_HOME='$M/cfg' OPENSPEC_TELEMETRY=0 openspec doctor 2>&1 | grep -q 'Store: trio (metadata ok)'"
  check "verifier doctor names the source file of each command" bash -c "cd '$M/api' && HOME='$M/home' XDG_DATA_HOME='$M/data' XDG_CONFIG_HOME='$M/cfg' node openspec/scripts/verify-task.cjs doctor 2>/dev/null | grep -q '\"source\": \"$M/api/openspec/config.yaml\"'"
  # re-install: never overwrites what the user edited, adds only what is missing
  sed -i.b 's/`go test .\/...`/`go test -race .\/...`/; /Lint command/d' "$M/api/openspec/config.yaml"; rm -f "$M/api/openspec/config.yaml.b"
  menv "$PKG/install.sh" "$M/api" --store trio >/dev/null 2>&1
  check "re-install keeps the edited test command" grep -q '^  - Test command: `go test -race ./...`' "$M/api/openspec/config.yaml"
  check "re-install adds the missing lint line back, once" bash -c "[ \$(grep -c 'Lint command' '$M/api/openspec/config.yaml') = 1 ]"
  check "re-install keeps a single verify: block and the pointer" bash -c "[ \$(grep -c '^verify:' '$M/api/openspec/config.yaml') = 1 ] && [ \$(grep -c '^store:' '$M/api/openspec/config.yaml') = 1 ]"
  snapA="$(find "$M" -path "$M/store/.git" -prune -o -type f -print | sort | xargs shasum | shasum)"
  menv "$PKG/install.sh" "$M/web" --store trio >/dev/null 2>&1; menv "$PKG/install.sh" "$M/api" --store trio >/dev/null 2>&1; menv "$PKG/install.sh" "$M/mobile" --store trio >/dev/null 2>&1
  snapB="$(find "$M" -path "$M/store/.git" -prune -o -type f -print | sort | xargs shasum | shasum)"
  check "second round of installs changes nothing" test "$snapA" = "$snapB"
  # a pointer file with commands the user wrote by hand (anywhere in the file) is respected
  mkdir -p "$M/hand/openspec"; printf 'store: trio\ncontext: |\n  - Test command: `make check`\n' > "$M/hand/openspec/config.yaml"; : > "$M/hand/Makefile"
  menv "$PKG/install.sh" "$M/hand" --store trio >/dev/null 2>&1
  menv "$PKG/install.sh" "$M/web" --store trio --workspace-file "$M/trio.code-workspace" >/dev/null 2>&1
  menv "$PKG/install.sh" "$M/api" --store trio --workspace-file "$M/trio.code-workspace" >/dev/null 2>&1
  menv "$PKG/install.sh" "$M/mobile" --store trio --workspace-file "$M/trio.code-workspace" >/dev/null 2>&1
  check "one --workspace-file for all repos lists web, api, mobile and the store once" bash -c "w='$M/trio.code-workspace'; for p in web api mobile store; do [ \$(grep -c \"\\\"path\\\": \\\"\$p\\\"\" \$w) = 1 ] || exit 1; done"
  printf '{\n // mine\n "folders": []\n}\n' > "$M/commented.code-workspace"; commented="$(shasum "$M/commented.code-workspace")"
  menv "$PKG/install.sh" "$M/web" --store trio --workspace-file "$M/commented.code-workspace" >/dev/null 2>&1
  check "a .code-workspace with comments is left untouched" test "$commented" = "$(shasum "$M/commented.code-workspace")"
  check "hand-written Test command is not duplicated or replaced" bash -c "[ \$(grep -c 'Test command' '$M/hand/openspec/config.yaml') = 1 ] && grep -q 'make check' '$M/hand/openspec/config.yaml'"
else
  echo "  skip multi-repo workspace (this openspec CLI has no 'store' command)"
fi

echo "== teammate machine: the pointer names a store that is not registered or cloned (actionable error, nothing cloned)"
if openspec store --help >/dev/null 2>&1; then
  O="$T/tm"; mkdir -p "$O/own/home" "$O/mate/home" "$O/web"
  oenv() { HOME="$O/own/home" XDG_DATA_HOME="$O/own/data" XDG_CONFIG_HOME="$O/own/cfg" SPEC_INSTALL_PROBE=0 OPENSPEC_TELEMETRY=0 "$@"; }
  tenv() { HOME="$O/mate/home" XDG_DATA_HOME="$O/mate/data" XDG_CONFIG_HOME="$O/mate/cfg" OPENSPEC_TELEMETRY=0 "$@"; }
  printf '{"scripts":{"test":"echo ok"}}\n' > "$O/web/package.json"
  oenv openspec store setup hint --path "$O/hint" --remote 'https://bob:s3cret@example.com/acme/specs.git' >/dev/null 2>&1 || bad "store setup hint (remote)"
  oenv openspec store setup plain --path "$O/plain" >/dev/null 2>&1 || bad "store setup plain (no remote)"
  check "installer records the store's remote in the pointer, without credentials" bash -c "HOME='$O/own/home' XDG_DATA_HOME='$O/own/data' XDG_CONFIG_HOME='$O/own/cfg' SPEC_INSTALL_PROBE=0 '$PKG/install.sh' '$O/web' --store hint >/dev/null 2>&1 && grep -q '^store_remote: https://example.com/acme/specs.git\$' '$O/web/openspec/config.yaml' && ! grep -rq 's3cret\|bob' '$O/web/openspec/config.yaml'"
  check "openspec still resolves the store with store_remote: in the pointer" bash -c "cd '$O/web' && HOME='$O/own/home' XDG_DATA_HOME='$O/own/data' XDG_CONFIG_HOME='$O/own/cfg' OPENSPEC_TELEMETRY=0 openspec context --json | grep -q '\"store_id\": \"hint\"'"
  check "re-install does not duplicate or change store_remote:" bash -c "HOME='$O/own/home' XDG_DATA_HOME='$O/own/data' XDG_CONFIG_HOME='$O/own/cfg' SPEC_INSTALL_PROBE=0 '$PKG/install.sh' '$O/web' --store hint >/dev/null 2>&1 && [ \$(grep -c '^store_remote:' '$O/web/openspec/config.yaml') = 1 ]"
  git -C "$O/plain" remote add origin 'https://tok@git.example.com/p/specs.git' 2>/dev/null
  mkdir -p "$O/web2"; printf '{"scripts":{"test":"echo ok"}}\n' > "$O/web2/package.json"
  check "no store.yaml remote: the store folder's git origin is used (credentials stripped)" bash -c "HOME='$O/own/home' XDG_DATA_HOME='$O/own/data' XDG_CONFIG_HOME='$O/own/cfg' SPEC_INSTALL_PROBE=0 '$PKG/install.sh' '$O/web2' --store plain >/dev/null 2>&1 && grep -q '^store_remote: https://git.example.com/p/specs.git\$' '$O/web2/openspec/config.yaml'"
  mkdir -p "$O/web3"; printf '{"scripts":{"test":"echo ok"}}\n' > "$O/web3/package.json"; rm -rf "$O/plain/.git"
  check "no remote anywhere: no store_remote: line" bash -c "HOME='$O/own/home' XDG_DATA_HOME='$O/own/data' XDG_CONFIG_HOME='$O/own/cfg' SPEC_INSTALL_PROBE=0 '$PKG/install.sh' '$O/web3' --store plain >/dev/null 2>&1 && ! grep -q '^store_remote:' '$O/web3/openspec/config.yaml'"
  vt() { (cd "$1" && shift && tenv node openspec/scripts/verify-task.cjs "$@" 2>&1); }
  vtrc() { (cd "$1" && shift && tenv node openspec/scripts/verify-task.cjs "$@" >/dev/null 2>&1; echo $?); }
  msg="$(vt "$O/web" doctor)"
  check "unregistered store with remote hint: exit 2" test "$(vtrc "$O/web" doctor)" = 2
  check "unregistered: names the store id and says it is a pointer, not a URL" bash -c "echo \"\$1\" | grep -q \"store 'hint' is not registered\" && echo \"\$1\" | grep -q 'pointer to a folder registered on this machine, not a URL'" _ "$msg"
  check "unregistered: gives git clone <hint url> and openspec store register" bash -c "echo \"\$1\" | grep -q 'git clone https://example.com/acme/specs.git <dir>' && echo \"\$1\" | grep -q 'openspec store register <dir>'" _ "$msg"
  check "unregistered: mentions --root and --store alternatives, never prints credentials" bash -c "echo \"\$1\" | grep -q -- '--root <dir>' && echo \"\$1\" | grep -q -- '--store' && ! echo \"\$1\" | grep -q 's3cret'" _ "$msg"
  for c in "next x" "check x" "status x" "lint x"; do
    check "unregistered: '$c' fails the same way (exit 2, store named)" bash -c "cd '$O/web'; out=\$(HOME='$O/mate/home' XDG_DATA_HOME='$O/mate/data' XDG_CONFIG_HOME='$O/mate/cfg' node openspec/scripts/verify-task.cjs $c 2>&1); rc=\$?; [ \$rc = 2 ] && echo \"\$out\" | grep -q \"store 'hint' is not registered\""
  done
  check "the teammate machine got nothing cloned or registered" bash -c "[ \"\$(HOME='$O/mate/home' XDG_DATA_HOME='$O/mate/data' XDG_CONFIG_HOME='$O/mate/cfg' openspec store list --json | grep -c '\"id\"')\" = 0 ] && [ ! -e '$O/mate/home/specs' ]"
  # no hint: web3 points at 'plain' (no remote recorded)
  msg2="$(vt "$O/web3" doctor)"
  check "unregistered, no remote hint: exit 2 and a <store repo url> placeholder" bash -c "[ \"\$(cd '$O/web3'; HOME='$O/mate/home' XDG_DATA_HOME='$O/mate/data' XDG_CONFIG_HOME='$O/mate/cfg' node openspec/scripts/verify-task.cjs doctor >/dev/null 2>&1; echo \$?)\" = 2 ] && echo \"\$1\" | grep -q 'git clone <store repo url> <dir>' && echo \"\$1\" | grep -q \"store 'plain' is not registered\"" _ "$msg2"
  check "a credential typed into store_remote: by hand is still not printed" bash -c "cd '$O/web3' && echo 'store_remote: https://u:tok123@h.example/a/b.git' >> openspec/config.yaml && out=\$(HOME='$O/mate/home' XDG_DATA_HOME='$O/mate/data' XDG_CONFIG_HOME='$O/mate/cfg' node openspec/scripts/verify-task.cjs doctor 2>&1); echo \"\$out\" | grep -q 'git clone https://h.example/a/b.git' && ! echo \"\$out\" | grep -q tok123"
  check "without the openspec CLI the same steps are printed plus an install hint" bash -c "mkdir -p '$O/nobin' && ln -sf \"\$(command -v node)\" '$O/nobin/node' && cd '$O/web' && out=\$(HOME='$O/mate/home' PATH='$O/nobin' node openspec/scripts/verify-task.cjs doctor 2>&1); echo \"\$out\" | grep -q 'not installed or not on PATH' && echo \"\$out\" | grep -q 'openspec store register <dir>'"
  # after the teammate follows the steps it works
  git clone -q "$O/hint" "$O/mate/specs" 2>/dev/null || cp -R "$O/hint" "$O/mate/specs"
  check "after clone + openspec store register the same command works" bash -c "tenv() { HOME='$O/mate/home' XDG_DATA_HOME='$O/mate/data' XDG_CONFIG_HOME='$O/mate/cfg' OPENSPEC_TELEMETRY=0 \"\$@\"; }; tenv openspec store register '$O/mate/specs' >/dev/null 2>&1 && cd '$O/web' && tenv node openspec/scripts/verify-task.cjs doctor 2>/dev/null | grep -q '\"root\": \"$O/mate/specs\"'"
  # registered, but the folder is gone
  mv "$O/mate/specs" "$O/mate/specs.moved"
  msg3="$(vt "$O/web" status x)"
  check "registered but folder missing: exit 2, says so and suggests openspec store doctor <id>" bash -c "[ \"\$(cd '$O/web'; HOME='$O/mate/home' XDG_DATA_HOME='$O/mate/data' XDG_CONFIG_HOME='$O/mate/cfg' node openspec/scripts/verify-task.cjs status x >/dev/null 2>&1; echo \$?)\" = 2 ] && echo \"\$1\" | grep -q \"store 'hint' is registered on this machine\" && echo \"\$1\" | grep -q 'missing or is not a usable' && echo \"\$1\" | grep -q 'openspec store doctor hint'" _ "$msg3"
  mv "$O/mate/specs.moved" "$O/mate/specs"
  # --specs layout: path missing
  mkdir -p "$O/sweb/openspec"; printf 'specs: ../nowhere/specs\nspecs_remote: git@example.com:acme/specs.git\n' > "$O/sweb/openspec/workspace.yaml"
  cp -R "$O/web/openspec/scripts" "$O/sweb/openspec/scripts"
  msg4="$(vt "$O/sweb" doctor)"
  check "--specs path missing: exit 2, 'clone the specs repo to <path> (relative to this repo)' with the hint url" bash -c "[ \"\$(cd '$O/sweb'; node openspec/scripts/verify-task.cjs doctor >/dev/null 2>&1; echo \$?)\" = 2 ] && echo \"\$1\" | grep -q 'Clone the specs repo to $O/nowhere/specs (relative to this repo: ../nowhere/specs)' && echo \"\$1\" | grep -q 'git clone git@example.com:acme/specs.git'" _ "$msg4"
  check "--specs path missing without hint: <specs repo url> placeholder" bash -c "cd '$O/sweb' && sed -i.b '/^specs_remote/d' openspec/workspace.yaml && node openspec/scripts/verify-task.cjs lint x 2>&1 | grep -q 'git clone <specs repo url>'"
  check "installer records specs_remote: for --specs when the specs folder has an origin" bash -c "mkdir -p '$O/sp' '$O/sweb2' && git -C '$O/sp' init -q && git -C '$O/sp' remote add origin 'https://u:p@example.com/acme/sp.git' && printf '{\"scripts\":{\"test\":\"echo ok\"}}\n' > '$O/sweb2/package.json' && SPEC_INSTALL_PROBE=0 '$PKG/install.sh' '$O/sweb2' --specs '$O/sp' >/dev/null 2>&1 && grep -q '^specs_remote: https://example.com/acme/sp.git\$' '$O/sweb2/openspec/workspace.yaml'"
  check "--root still bypasses the pointer check" bash -c "cd '$O/web' && HOME='$O/mate/home' XDG_DATA_HOME='$O/mate/data' XDG_CONFIG_HOME='$O/mate/cfg' node openspec/scripts/verify-task.cjs doctor --root '$O/hint' 2>/dev/null | grep -q '\"root\": \"$O/hint\"'"
else
  echo "  skip teammate machine (this openspec CLI has no 'store' command)"
fi

echo "== workspace layout (separate specs repo linked by openspec/workspace.yaml; no registry)"
S="$T/ws2"; mkdir -p "$S/specs-repo" "$S/code-repo"
sp() { OPENSPEC_TELEMETRY=0 "$@"; }
check "install --specs succeeds"           sp "$PKG/install.sh" "$S/code-repo" --specs "$S/specs-repo" --workspace-file "$S/proj.code-workspace"
check "schema installed in the specs repo" test -f "$S/specs-repo/openspec/schemas/wingman-spec/schema.yaml"
check "specs repo is a real root"          bash -c "test -d '$S/specs-repo/openspec/specs' && test -d '$S/specs-repo/openspec/changes'"
check "specs repo config uses the schema"  grep -q '^schema: wingman-spec' "$S/specs-repo/openspec/config.yaml"
check "code repo links with a relative path" grep -q '^specs: \.\./specs-repo$' "$S/code-repo/openspec/workspace.yaml"
check "workspace.yaml also holds this repo's own commands (verify: |)" bash -c "grep -q '^verify: |' '$S/code-repo/openspec/workspace.yaml' && grep -q 'Test command' '$S/code-repo/openspec/workspace.yaml'"
check "code repo stays free of specs/changes/schema" bash -c "test ! -e '$S/code-repo/openspec/specs' && test ! -e '$S/code-repo/openspec/changes' && test ! -e '$S/code-repo/openspec/schemas'"
check "scripts, commands, AGENTS in code repo" bash -c "test -x '$S/code-repo/openspec/scripts/verify-task.cjs' && test -f '$S/code-repo/.cursor/commands/spec-propose.md' && grep -q WINGMAN-SPEC:START '$S/code-repo/AGENTS.md'"
check "workspace file lists both folders"  bash -c "grep -q '\"path\": \"code-repo\"' '$S/proj.code-workspace' && grep -q '\"path\": \"specs-repo\"' '$S/proj.code-workspace'"
(cd "$S/specs-repo" && sp openspec new change wsdemo >/dev/null 2>&1) || bad "openspec new change in the specs repo"
check "change lives in the specs repo"     test -d "$S/specs-repo/openspec/changes/wsdemo"
printf '## 1. G\n- [ ] 1.1 one\n- [ ] 1.2 two\n' > "$S/specs-repo/openspec/changes/wsdemo/tasks.md"
check "verifier in code repo follows the link" bash -c "cd '$S/code-repo' && node openspec/scripts/verify-task.cjs status wsdemo | grep -q '\"remaining\": 2'"
check "verifier --root overrides the link"     bash -c "mkdir -p '$S/code-nolink/openspec' && cp -R '$S/code-repo/openspec/scripts' '$S/code-nolink/openspec/' && cd '$S/code-nolink' && node openspec/scripts/verify-task.cjs status wsdemo --root '$S/specs-repo' | grep -q remaining"
check_not "verifier without any link fails clearly" bash -c "cd '$S/code-nolink' && node openspec/scripts/verify-task.cjs status wsdemo"
rm -rf "$S/specs-repo/openspec/.apply-runs"
snapA="$(find "$S/code-repo" "$S/specs-repo/openspec/schemas" -type f | sort | xargs shasum | shasum)"
sp "$PKG/install.sh" "$S/code-repo" --specs "$S/specs-repo" --workspace-file "$S/proj.code-workspace" >/dev/null
snapB="$(find "$S/code-repo" "$S/specs-repo/openspec/schemas" -type f | sort | xargs shasum | shasum)"
check "second --specs install changes nothing" test "$snapA" = "$snapB"
check_not "--specs and --store together are rejected" "$PKG/install.sh" "$S/code-repo" --specs "$S/specs-repo" --store x
check_not "--specs needs an existing directory"      "$PKG/install.sh" "$S/code-repo" --specs "$S/nope"
check_not "--workspace-file needs --specs or --store" "$PKG/install.sh" "$S/code-repo" --workspace-file "$S/x.code-workspace"
mkdir -p "$S/local/openspec/changes"
check_not "--specs refuses a repo with local specs"  "$PKG/install.sh" "$S/local" --specs "$S/specs-repo"

echo "== vendored skills"
if [ "${SMOKE_NETWORK:-0}" = 1 ]; then
  check "skills byte-match upstream pins" "$PKG/scripts/vendor-skills.sh" --verify
else
  echo "  skip upstream verify (network; set SMOKE_NETWORK=1 to run)"
  check "vendored skills present locally" test -f "$PKG/skills/grilling/SKILL.md" -a -f "$PKG/skills/test-driven-development/SKILL.md" -a -f "$PKG/skills/ponytail/SKILL.md" -a -f "$PKG/skills/ponytail-review/SKILL.md"
fi

echo; echo "passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
