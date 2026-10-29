#!/usr/bin/env bash
# shellcheck disable=SC2016 # expectations are single-quoted on purpose (run later by eval)
# State steps `click` / `hover` on a control that exists but is hidden at a viewport: skipped with an info note; a missing, covered or (strict form)
# hidden control still fails. Needs openspec and node; Playwright + axe-core (PLAYWRIGHT_NODE_MODULES) for the browser part.
# Usage: tests/visual-steps.sh. Exit 0 when all pass.
set -uo pipefail
PKG="$(cd "$(dirname "$0")/.." && pwd)"
T="$(mktemp -d)"; [ -n "${KEEP:-}" ] || trap 'rm -rf "$T"' EXIT; [ -z "${KEEP:-}" ] || echo "kept: $T"
export OPENSPEC_TELEMETRY=0 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.invalid GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.invalid
PASS=0; FAIL=0; rc=0
ok()  { PASS=$((PASS+1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $*"; [ -z "${DEBUG:-}" ] || head -c 2500 "$T/v.json" "$T/v.err" "$T/l.json" 2>/dev/null; }
expect() { if eval "$2"; then ok "$1"; else bad "$1  (rc=$rc)"; fi; }

cd "$T" && mkdir p && cd p && git init -q && { openspec init --tools none >/dev/null 2>&1 || mkdir -p openspec/changes openspec/specs; }
"$PKG/install.sh" . --harness all >/dev/null || { echo "install failed"; exit 1; }
git add -A >/dev/null 2>&1; git commit -qm init >/dev/null 2>&1
V="node openspec/scripts/verify-task.cjs"
PORT="$(node -e 'const s=require("net").createServer().listen(0,()=>{console.log(s.address().port);s.close()})')"
cp "$PKG/tests/fixtures/steps/app.js" app.js
setcfg() { # setcfg <extra visual lines>
  node -e '
const fs=require("fs"); let t=fs.readFileSync("openspec/config.yaml","utf8");
t=t.replace(/^visual:.*(\n[ \t]+.*)*\n?/m, "visual:\n  command: node app.js "+process.argv[1]+"\n  url: http://127.0.0.1:"+process.argv[1]+"/\n  ready_timeout: 20\n  screenshots: off\n"+process.argv[2]);
t=t.replace(/Test command: <fill in>/,"Test command: none").replace(/Typecheck command: <fill in>/,"Typecheck command: none").replace(/Lint command: <fill in>/,"Lint command: none");
fs.writeFileSync("openspec/config.yaml",t);' "$PORT" "$1"
}
mkchange() { # mkchange <scenario blocks>
  rm -rf openspec/changes/demo openspec/.apply-runs; mkdir -p openspec/changes/demo/specs/gallery
  printf '## Why\nSkipping defects of other teams in the visual check.\n\n## What Changes\n- Adds a gallery page.\n\n## Edge cases\n- none named\n' > openspec/changes/demo/proposal.md
  printf '## ADDED Requirements\n\n### Requirement: Gallery grid\nThe system SHALL show the result grid.\nWhy: The owner wants it to work, so that people can rely on it.\n\n%s\n' "$1" > openspec/changes/demo/specs/gallery/spec.md
  printf '## 1. Gallery\n- [ ] 1.1 Grid\n  - Spec: gallery > Gallery grid\n  - Files: app.js\n  - Visual: all\n  - Done when: `true`\n' > openspec/changes/demo/tasks.md
}
sc() { printf '#### Scenario: %s\n- **WHEN** the page is opened\n- **THEN** the grid is shown\n\n```visual\n%s\n```\n\n' "$1" "$2"; }
REPORT() { node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).report)' "$T/v.json"; }
setcfg ""

echo "== the grammar (no browser)"
parse() { node -e '
const VC=require("./openspec/scripts/visual-check.cjs");
const r=VC.parseBlock(["route: /","key: [a]","state: s",...process.argv[1].split("\n")],1);
console.log(JSON.stringify({s:r.states[0]&&r.states[0].steps,e:r.errors}));' "$1"; }
expect "click! and hover! parse as strict steps" 'parse $'"'"'  do: click! .save\n  do: hover! .menu'"'"' | grep -q "\"op\":\"click\",\"target\":\".save\",\"strict\":true" && parse "  do: hover! .menu" | grep -q "\"strict\":true"'
expect "plain click has no strict flag" '! parse "  do: click .save" | grep -q strict'
expect "fill!, press!, storage!, goto! and wait! are refused: only click and hover can be strict" 'n=0; for op in fill press storage goto wait; do parse "  do: $op! .x = 1" | grep -q "only .*click!.* and .*hover!.* can be strict" && n=$((n+1)); done; [ $n = 5 ]'
expect "a state has no viewports: of its own" 'parse "  viewports: 375" | grep -q "\"e\":\[\"[^]]"'

echo "== in the browser (Playwright)"
PWM="${PLAYWRIGHT_NODE_MODULES:-}"
if [ -z "${PLAYWRIGHT_BROWSERS_PATH:-}" ] && [ -d "$(dirname "$PWM")/ms-playwright" ]; then PLAYWRIGHT_BROWSERS_PATH="$(dirname "$PWM")/ms-playwright"; export PLAYWRIGHT_BROWSERS_PATH; fi
if [ -d "$PWM/playwright" ] && [ -d "$PWM/axe-core" ]; then
  ln -s "$PWM" node_modules; printf 'node_modules\n' >> .gitignore; git add -A >/dev/null 2>&1; git commit -qm cfg >/dev/null 2>&1
  run() { mkchange "$(sc 'Gallery' "$1")"; rc=0; $V visual demo > "$T/v.json" 2> "$T/v.err" || rc=$?; }
  defects() { node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(r.defects.map(d=>d.code+"@"+d.viewport).sort().join(" "))' "$(REPORT)"; }
  notes() { node -e 'const r=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((r.notes||[]).map(d=>d.level+" "+d.viewport+" "+d.message).sort().join("|"))' "$(REPORT)"; }
  M=$'route: /menu\nviewports: 375, 900\nkey: [data-testid="grid"]\nstate: open\n  key: [data-testid="panel"]\n'

  run "$M"$'  do: click .menu-toggle'
  expect "a toggle hidden by a media query: no defect at 375 or 900 (skipped at 900, clicked at 375)" '[ $rc = 0 ] && [ -z "$(defects)" ]'
  expect "the skip is an info note for 900 only, worded with the target and the width" '[ "$(notes)" = "info 900 step skipped: .menu-toggle exists but is hidden at 900px" ]'
  expect "the report lists the skipped step" 'grep -q "steps skipped (1)" "$T/v.err" && grep -q "step skipped: .menu-toggle exists but is hidden at 900px - " "$T/v.err"'
  expect "the JSON output carries it too" 'grep -q "skipped_steps" "$T/v.json"'
  run "$M"$'  do: click .menu-toggle' ; sed -i 's/viewports: 375, 900/viewports: 375/' openspec/changes/demo/specs/gallery/spec.md; rc=0; $V visual demo > "$T/v.json" 2> "$T/v.err" || rc=$?
  expect "at 375 alone it is really clicked (the panel needs it), with no note" '[ $rc = 0 ] && [ -z "$(notes)" ]'
  run $'route: /menu\nviewports: 900\nkey: [data-testid="grid"]\nstate: hovered\n  do: hover .menu-toggle\n  key: [data-testid="panel"]'
  expect "hover is skipped the same way" '[ $rc = 0 ] && [ "$(notes)" = "info 900 step skipped: .menu-toggle exists but is hidden at 900px" ]'
  run "$M"$'  do: click! .menu-toggle'
  expect "the strict form fails at 900 where the control is hidden, and still passes at 375" '[ $rc = 1 ] && [ "$(defects)" = "state:step-failed@900" ] && [ -z "$(notes)" ]'
  run "$M"$'  do: click .no-such-control'
  expect "a target that matches nothing fails at every viewport" '[ $rc = 1 ] && [ "$(defects)" = "state:step-failed@375 state:step-failed@900" ] && [ -z "$(notes)" ]'
  run $'route: /covered\nviewports: 900\nkey: [data-testid="grid"]\nstate: saved\n  do: click .save\n  key: [data-testid="panel"]'
  expect "a visible control that an overlay covers fails (not skipped as hidden)" '[ $rc = 1 ] && [ "$(defects)" = "state:step-failed@900" ] && [ -z "$(notes)" ]'
  run $'route: /menu\nviewports: 900\nkey: [data-testid="grid"]\nstate: typed\n  do: fill .menu-toggle = x\n  key: [data-testid="panel"]'
  expect "fill on a hidden control is never skipped" '[ $rc = 1 ] && [ "$(defects)" = "state:step-failed@900" ]'
else
  echo "  skip: no Playwright+axe-core in $PWM (set PLAYWRIGHT_NODE_MODULES); the browser part of visual-steps is not tested"
fi

echo
echo "visual-steps: passed=$PASS failed=$FAIL"
[ "$FAIL" = 0 ]
