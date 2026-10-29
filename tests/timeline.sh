#!/usr/bin/env bash
# shellcheck disable=SC2016
# The timeline (openspec/scripts/timeline.cjs): a fake run writes one JSON line per event in order (run start, next, check start and
# end, fix round, tick, a decision when the plan changes mid-build with what changed and why, finish, sync, archive); parallel
# appends never lose a line; archive keeps the timeline next to archived.json.
# Usage: tests/timeline.sh (needs openspec, node >= 18 and git on PATH).
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
export SPEC_TRACEABILITY=off OPENSPEC_TELEMETRY=0 SPEC_SESSION=s1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
unset SPEC_NO_CACHE SPEC_CHECK_LEVEL SPEC_TEST_RUN SPEC_TEST_CMD SPEC_TYPECHECK_CMD SPEC_LINT_CMD SPEC_TARGETED_TEST_CMD
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; }
expect() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
cd "$T" && mkdir p && cd p && git init -q -b main
openspec init --tools none >/dev/null 2>&1 || mkdir -p openspec/changes openspec/specs
"$PKG/install.sh" . >/dev/null || { echo "install failed"; exit 1; }
sed -i 's/\(Test\|Typecheck\|Lint\) command: <fill in>/\1 command: none/' openspec/config.yaml
mkdir -p src; for m in cart user; do printf 'module.exports = () => "%s";\n' "$m" > "src/$m.js"; done
C=openspec/changes/demo; mkdir -p "$C/specs/demo" "$C/adrs"
printf 'Size: M\nRisk: none\n\n## Why\nDemo.\n\n## What Changes\n- Adds a demo capability.\n\n## Edge cases\n- none named\n' > "$C/proposal.md"
printf '## ADDED Requirements\n\n### Requirement: Demo\nThe system SHALL greet.\n\n#### Scenario: greet\n- **WHEN** asked\n- **THEN** it shows "hi"\n' > "$C/specs/demo/spec.md"
printf '## 1. Cart\n- [ ] 1.1 Cart total\n  - Files: src/cart.js\n  - Done when: `test -f %s/ok` exits 0\n- [ ] 1.2 Greeting\n  - Files: src/user.js\n  - Done when: `true` exits 0\n' "$T" > "$C/tasks.md"
printf '## Capability inventory\n- demo\n' > "$C/app-map.md"; printf '## Decisions\nOne.\n\n## Implementation guide\nOne function.\n' > "$C/design.md"
printf -- '---\nstatus: none\n---\nNone.\n' > "$C/adrs/none.md"
git add -A; git commit -qm plan
V="node openspec/scripts/verify-task.cjs"; TLF=openspec/.apply-runs/demo/timeline.jsonl
ev() { node -e 'for (const l of require("fs").readFileSync(process.argv[1],"utf8").split("\n").filter(Boolean)) { const e=JSON.parse(l); process.stdout.write(e.event+(e.ok===false?"!":"")+" ") }' "$1"; }

echo "== a fake run, with the plan changed mid-build"
$V next demo --per-task >/dev/null 2>&1; echo '// a' >> src/cart.js
$V check demo --reported done >/dev/null 2>&1           # Done when fails: a fix round
touch "$T/ok"; $V check demo --reported done >/dev/null 2>&1
printf '\n#### Scenario: greet by name\n- **WHEN** a name is given\n- **THEN** it shows "hi <name>"\n' >> "$C/specs/demo/spec.md"
printf -- '- [ ] 1.3 Greet by name\n  - Files: src/user.js\n  - Done when: `true` exits 0\n' >> "$C/tasks.md"
printf '\nDecision: greet by name, asked by the owner on review\n' >> "$C/design.md"
$V next demo --per-task >/dev/null 2>&1; echo '// b' >> src/user.js; $V check demo --reported done >/dev/null 2>&1
$V next demo --per-task >/dev/null 2>&1; echo '// c' >> src/user.js; $V check demo --reported done >/dev/null 2>&1
$V next demo --per-task >/dev/null 2>&1; $V finish demo > "$T/f.json" 2>&1
E=$(ev "$TLF")
expect "events in order (got: $E)" '[ "$E" = "run-start next check-start check! fix-round check-start check tick decision next check-start check tick next check-start check tick next finish-start finish! " ]'
expect "every event has an ISO time with offset and the session" 'node -e "for (const l of require(\"fs\").readFileSync(process.argv[1],\"utf8\").split(\"\\n\").filter(Boolean)) { const e=JSON.parse(l); if (!/^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d[+-]\\d\\d:\\d\\d$/.test(e.at) || e.session!==\"s1\") process.exit(1) }" "$TLF"'
D=$(grep '"event":"decision"' "$TLF")
expect "the decision lists what changed (scenario and task added, design.md changed)" 'echo "$D" | grep -q "scenario added: demo/Demo/greet by name" && echo "$D" | grep -q "task added: 1.3 Greet by name" && echo "$D" | grep -q "design.md changed"'
expect "the decision carries the reason from the Decision: line and the task it was seen at" 'echo "$D" | grep -q "\"reason\":\"greet by name, asked by the owner on review\"" && echo "$D" | grep -q "\"seen_at\":\"next\""'
expect "the failed check carries its failures, collapsed under details" 'grep "\"event\":\"check\",\"task\":\"1.1\",\"ok\":false" "$TLF" | grep -q "\"details\":{\"failures\""'
expect "check end events carry a duration" 'grep "\"event\":\"check\"" "$TLF" | grep -vq "\"seconds\":" && false || true; [ "$(grep -c "\"event\":\"check\",.*\"seconds\":" "$TLF")" = 4 ]'

expect "the failed finish (untagged scenarios) names why under details" 'grep "\"event\":\"finish\"" "$TLF" | grep -q "no tagged test"'

echo "== a Why change with --reason records the owner approval"
sed -i 's/^Demo\.$/Demo, for the team./' "$C/proposal.md"
sed -i 's/^The system SHALL greet\.$/The system SHALL greet.\nWhy: greeting brings people back/' "$C/specs/demo/spec.md"
$V finish demo --reason "owner asked to state the Why" >/dev/null 2>&1
D=$(grep '"event":"decision"' "$TLF" | tail -1)
expect "the Why change, the given reason and the owner approval state are recorded" 'echo "$D" | grep -q "Why changed: demo/Demo" && echo "$D" | grep -q "owner asked to state the Why" && echo "$D" | grep -q "\"owner_approval\":\"missing\""'
expect "an unchanged plan records no new decision" '$V finish demo >/dev/null 2>&1; [ "$(grep -c "\"event\":\"decision\"" "$TLF")" = 2 ]'

echo "== parallel appends"
node -e 'const TL=require(process.argv[1]); const cp=require("child_process"); const ps=[]; for (let i=0;i<8;i++) ps.push(cp.spawn(process.execPath,["-e",`const TL=require(${JSON.stringify(process.argv[1])}); for (let j=0;j<200;j++) TL.append(${JSON.stringify(process.argv[2])}, { event: "p", summary: "x".repeat(300) })`])); let n=ps.length; ps.forEach((p)=>p.on("exit",()=>{ if(--n===0) process.exit(0) }))' "$PWD/openspec/scripts/timeline.cjs" "$T/par"
expect "8 writers x 200 events: 1600 whole lines" '[ "$(node -e "console.log(require(process.argv[1]).readEvents(process.argv[2]).length)" "$PWD/openspec/scripts/timeline.cjs" "$T/par/timeline.jsonl")" = 1600 ] && [ "$(wc -l < "$T/par/timeline.jsonl")" = 1600 ]'

echo "== archive keeps the timeline"
mkdir -p openspec/specs/demo; sed "s/^## ADDED Requirements/## Requirements/" "$C/specs/demo/spec.md" > openspec/specs/demo/spec.md
$V sync demo >/dev/null 2>&1
expect "sync is recorded" 'tail -1 "$TLF" | grep -q "\"event\":\"sync\",.*\"ok\":true"'
git add -A >/dev/null; git commit -qm built >/dev/null
$V archive demo > "$T/a.json" 2>&1
AD=$(ls -d openspec/changes/archive/*-demo 2>/dev/null | head -1)
expect "archived" '[ -n "$AD" ] && [ -f "$AD/archived.json" ]'
expect "the archived folder has the timeline, ending with the archive event" '[ -f "$AD/timeline.jsonl" ] && tail -1 "$AD/timeline.jsonl" | grep -q "\"event\":\"archive\",.*\"ok\":true"'

echo "timeline: passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
